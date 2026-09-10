/**
 * Unit tests for the token pricing table in src/config/pricing.js.
 *
 * This module decides how fast a user's AI allowance drains. It is pure
 * arithmetic over a lookup table, and every value it produces is an integer
 * count of micro-dollars that gets decremented from a budget — so the failures
 * worth defending against are not crashes but quiet wrong answers:
 *
 *   Under-metering is the expensive direction. A model that is not in the
 *   table must fall back to the *most* expensive listed rate, never to zero and
 *   never to something cheap. The comment in the source calls this
 *   "deliberately conservative"; the test below turns that from a comment into
 *   a checked invariant, so adding a pricier model to the table without raising
 *   the fallback fails here rather than showing up on a bill.
 *
 *   Rounding must go up. `costMicros` works in micro-dollars, and a single
 *   token on a cheap model costs a fraction of one. Round to nearest (or
 *   truncate) and a caller can make unlimited one-token requests for free —
 *   the classic way a metered system leaks. Every priced call with at least one
 *   token has to register at least 1 micro of spend.
 *
 *   Self-hosted is cheap but NOT free, and it is priced by *provider*, not by
 *   model name. A request routed to the steadfast box must be billed at the
 *   electricity-derived rate even when the model it names also appears in the
 *   cloud table, or running Sonnet locally would be charged at Anthropic's
 *   rate. `isEstimatedPrice` must likewise report `false` for it: the rate is
 *   derived from a measured run, so the UI should not label it a guess.
 *
 * `SELF_HOSTED_PRICE` is derived at module load from `STEADFAST_WATTS` and
 * `STEADFAST_KWH_RATE`. Tests that only care about *which* rate was selected
 * compare against the exported constant rather than hard-coded numbers, so
 * retariffing the box does not break them. The one group that pins the
 * derivation itself re-imports the module with those variables set, using a
 * query string to defeat the ESM module cache.
 *
 * Falsification checks for this suite, all run red against a deliberately
 * broken pricing module:
 *   - Change `Math.ceil` to `Math.round` or `Math.floor` in `costMicros` and
 *     the rounding group fails.
 *   - Return `{ in: 0, out: 0 }` instead of `FALLBACK_PRICE` for an unlisted
 *     model and the unknown-model group fails.
 *   - Reorder `priceFor` so the `MODEL_PRICES` lookup runs before the
 *     `SELF_HOSTED_PROVIDERS` check and the "provider beats model" test fails.
 *   - Add `SELF_HOSTED_PROVIDERS` to the `isEstimatedPrice` truthy path and the
 *     estimation group fails.
 *   - Lower `FALLBACK_PRICE` below any listed rate and the conservatism
 *     invariant fails.
 *   - Change `formatMicros` to `toFixed(2)` and the formatting group fails.
 *
 * Deliberately not covered: `src/lib/usageMeter.js`, which persists and
 * decrements these numbers against a real collection — out of scope for this
 * item, and a database test rather than a unit one.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MODEL_PRICES,
  FALLBACK_PRICE,
  SELF_HOSTED_PRICE,
  SELF_HOSTED_PROVIDERS,
  FREE_PROVIDERS,
  priceFor,
  costMicros,
  isEstimatedPrice,
  formatMicros,
} from '../../src/config/pricing.js';

const MICROS = 1_000_000;

/** A model name that must never end up in MODEL_PRICES for these tests to mean anything. */
const UNLISTED_MODEL = 'some-vendor/model-that-does-not-exist-v9';

describe('the price table itself', () => {
  test('the unlisted fixture really is unlisted', () => {
    assert.equal(MODEL_PRICES[UNLISTED_MODEL], undefined);
  });

  test('the fallback is at least as expensive as every listed model', () => {
    // The documented promise is that an unpriced model over-charges rather
    // than under-charges. Adding a costlier model to the table without raising
    // the fallback would silently break that, so it is asserted against the
    // table rather than against a copied constant.
    for (const [model, price] of Object.entries(MODEL_PRICES)) {
      assert.ok(price.in <= FALLBACK_PRICE.in, `${model} input rate ${price.in} exceeds the fallback ${FALLBACK_PRICE.in}`);
      assert.ok(price.out <= FALLBACK_PRICE.out, `${model} output rate ${price.out} exceeds the fallback ${FALLBACK_PRICE.out}`);
    }
  });

  test('no provider is free, and self-hosted is not among the free ones', () => {
    // FREE_PROVIDERS is empty by design — self-hosted moved to its own rate
    // once electricity was accounted for. If something is ever added here it
    // should be a deliberate act, not a drive-by.
    assert.equal(FREE_PROVIDERS.size, 0);
    assert.ok(!FREE_PROVIDERS.has('steadfast'));
    assert.ok(SELF_HOSTED_PROVIDERS.has('steadfast'));
  });

  test('the self-hosted rate is above zero but well below the cheapest cloud model', () => {
    const cheapestListedIn = Math.min(...Object.values(MODEL_PRICES).map((p) => p.in));
    assert.ok(SELF_HOSTED_PRICE.in > 0, 'self-hosted input is free, but the box burns electricity');
    assert.ok(SELF_HOSTED_PRICE.out > 0, 'self-hosted output is free, but the box burns electricity');
    assert.ok(SELF_HOSTED_PRICE.in < cheapestListedIn, 'self-hosted should be cheaper than any cloud model');
  });
});

describe('priceFor', () => {
  test('returns the listed rate for a known model', () => {
    assert.deepEqual(priceFor('anthropic', 'claude-opus-5'), { in: 5, out: 25 });
    assert.deepEqual(priceFor('anthropic', 'claude-haiku-4-5'), { in: 1, out: 5 });
  });

  test('falls back to FALLBACK_PRICE for an unknown model', () => {
    assert.deepEqual(priceFor('anthropic', UNLISTED_MODEL), FALLBACK_PRICE);
    assert.deepEqual(priceFor('openrouter', UNLISTED_MODEL), FALLBACK_PRICE);
    assert.deepEqual(priceFor('some-new-provider', undefined), FALLBACK_PRICE);
  });

  test('the steadfast provider gets the self-hosted rate', () => {
    assert.deepEqual(priceFor('steadfast', 'qwen2.5-coder'), SELF_HOSTED_PRICE);
  });

  test('provider beats model: steadfast wins even for a model in the cloud table', () => {
    // The case that actually happens — a local build named after a cloud
    // model. Look the model up first and a locally-served run is billed at
    // Anthropic's rate.
    assert.deepEqual(priceFor('steadfast', 'claude-opus-5'), SELF_HOSTED_PRICE);
    assert.notDeepEqual(priceFor('steadfast', 'claude-opus-5'), MODEL_PRICES['claude-opus-5']);
  });
});

describe('costMicros rounding', () => {
  test('one token always costs at least one micro-dollar', () => {
    // Swept across every priced path, because the leak this prevents lives in
    // whichever row is cheapest — today that is the self-hosted input rate at
    // $0.035/M, i.e. 0.035 micros for a single token.
    const cases = [
      ...Object.keys(MODEL_PRICES).map((model) => ({ provider: 'anthropic', model })),
      { provider: 'anthropic', model: UNLISTED_MODEL },
      { provider: 'steadfast', model: 'qwen2.5-coder' },
    ];

    for (const c of cases) {
      const prompt = costMicros({ ...c, promptTokens: 1 });
      const completion = costMicros({ ...c, completionTokens: 1 });
      assert.ok(prompt >= 1, `1 prompt token on ${c.provider}/${c.model} cost ${prompt} micros`);
      assert.ok(completion >= 1, `1 completion token on ${c.provider}/${c.model} cost ${completion} micros`);
    }
  });

  test('a sub-micro cost rounds up rather than down', () => {
    // 1 self-hosted input token is 0.035 micros. Truncating or rounding to
    // nearest would make it free.
    assert.equal(costMicros({ provider: 'steadfast', model: 'qwen2.5-coder', promptTokens: 1 }), 1);
  });

  test('a call with no tokens costs nothing', () => {
    // The other half of the rounding contract: rounding up must not invent
    // spend where there was none, or every no-op call would bill a micro.
    assert.equal(costMicros({ provider: 'anthropic', model: 'claude-opus-5' }), 0);
    assert.equal(costMicros({ provider: 'anthropic', model: 'claude-opus-5', promptTokens: 0, completionTokens: 0 }), 0);
    assert.equal(costMicros({ provider: 'steadfast', model: 'qwen2.5-coder' }), 0);
  });

  test('returns whole micro-dollars', () => {
    const cost = costMicros({ provider: 'steadfast', model: 'qwen2.5-coder', promptTokens: 1997, completionTokens: 898 });
    assert.ok(Number.isInteger(cost), `expected an integer number of micros, got ${cost}`);
  });

  test('prices a round million tokens at the table rate', () => {
    // $/million is the unit the table is written in, so a million tokens is
    // the one case where the expected answer can be read straight off it.
    assert.equal(costMicros({ provider: 'anthropic', model: 'claude-opus-5', promptTokens: MICROS }), 5 * MICROS);
    assert.equal(costMicros({ provider: 'anthropic', model: 'claude-opus-5', completionTokens: MICROS }), 25 * MICROS);
    assert.equal(
      costMicros({ provider: 'anthropic', model: 'claude-sonnet-5', promptTokens: MICROS, completionTokens: MICROS }),
      18 * MICROS,
    );
  });

  test('charges an unknown model exactly the fallback rate', () => {
    const unknown = costMicros({ provider: 'anthropic', model: UNLISTED_MODEL, promptTokens: MICROS, completionTokens: MICROS });
    assert.equal(unknown, (FALLBACK_PRICE.in + FALLBACK_PRICE.out) * MICROS);
    // And that it is not quietly cheaper than the priciest thing on the menu.
    assert.ok(unknown >= costMicros({ provider: 'anthropic', model: 'claude-opus-5', promptTokens: MICROS, completionTokens: MICROS }));
  });

  test('self-hosted draws down an allowance rather than being free', () => {
    const cost = costMicros({ provider: 'steadfast', model: 'qwen2.5-coder', promptTokens: 1997, completionTokens: 898 });
    assert.ok(cost > 0, 'a self-hosted run must still cost something');
    // The measured run the rate was derived from: ~$0.0008, i.e. ~800 micros.
    assert.ok(cost < 2_000, `a self-hosted run cost ${cost} micros, which is cloud-priced territory`);
  });
});

describe('isEstimatedPrice', () => {
  test('is false for self-hosted, whatever the model is called', () => {
    // The self-hosted rate is derived from a measured run, not guessed, so the
    // UI must not caveat it — including for the local model names that will
    // never appear in the cloud table.
    assert.equal(isEstimatedPrice('steadfast', 'qwen2.5-coder'), false);
    assert.equal(isEstimatedPrice('steadfast', UNLISTED_MODEL), false);
    assert.equal(isEstimatedPrice('steadfast', 'claude-opus-5'), false);
  });

  test('is false for a model with a listed rate', () => {
    assert.equal(isEstimatedPrice('anthropic', 'claude-opus-5'), false);
    assert.equal(isEstimatedPrice('openrouter', 'anthropic/claude-sonnet-4.6'), false);
  });

  test('is true for an unlisted cloud model', () => {
    assert.equal(isEstimatedPrice('anthropic', UNLISTED_MODEL), true);
    assert.equal(isEstimatedPrice('openrouter', UNLISTED_MODEL), true);
  });

  test('agrees with priceFor about which rows are guesses', () => {
    for (const model of Object.keys(MODEL_PRICES)) {
      assert.equal(isEstimatedPrice('anthropic', model), false, `${model} is listed but reported as an estimate`);
    }
  });
});

describe('formatMicros', () => {
  test('renders micro-dollars as a four-decimal dollar amount', () => {
    assert.equal(formatMicros(3_500_000), '$3.5000');
    assert.equal(formatMicros(0), '$0.0000');
    assert.equal(formatMicros(1_000_000), '$1.0000');
    assert.equal(formatMicros(12_345), '$0.0123');
  });

  test('displays sub-hundredth-of-a-cent spend as $0.0000', () => {
    // Documents the display floor rather than endorsing it: four decimals is
    // a tenth of a cent, so a single-micro call reads as zero even though it
    // was metered as 1. Accounting is unaffected — the integer is what gets
    // decremented — but a "you have spent $0.0000" line in the UI is expected,
    // not a bug.
    assert.equal(formatMicros(1), '$0.0000');
    assert.equal(formatMicros(49), '$0.0000');
  });

  test('rounds to four decimals rather than truncating the string', () => {
    assert.equal(formatMicros(3_499_960), '$3.5000');
  });
});

describe('SELF_HOSTED_PRICE derivation from the environment', () => {
  /**
   * The rate is computed once at module load from `STEADFAST_WATTS` and
   * `STEADFAST_KWH_RATE`, so it cannot be re-derived by mutating `process.env`
   * after the import at the top of this file. Each case sets the variables and
   * re-imports with a distinct query string, which ESM treats as a different
   * module URL and therefore loads afresh.
   */
  async function priceWith({ watts, kwhRate }, tag) {
    const saved = { watts: process.env.STEADFAST_WATTS, rate: process.env.STEADFAST_KWH_RATE };
    process.env.STEADFAST_WATTS = String(watts);
    process.env.STEADFAST_KWH_RATE = String(kwhRate);
    try {
      const mod = await import(`../../src/config/pricing.js?case=${tag}`);
      return mod.SELF_HOSTED_PRICE;
    } finally {
      if (saved.watts === undefined) delete process.env.STEADFAST_WATTS;
      else process.env.STEADFAST_WATTS = saved.watts;
      if (saved.rate === undefined) delete process.env.STEADFAST_KWH_RATE;
      else process.env.STEADFAST_KWH_RATE = saved.rate;
    }
  }

  test('the documented baseline reproduces the measured rate', async () => {
    const price = await priceWith({ watts: 300, kwhRate: 0.17 }, 'baseline');
    assert.equal(price.in, 0.035);
    assert.equal(price.out, 0.786);
  });

  test('doubling the tariff doubles the rate', async () => {
    const price = await priceWith({ watts: 300, kwhRate: 0.34 }, 'double-rate');
    assert.equal(price.in, 0.07);
    assert.equal(price.out, 1.572);
  });

  test('halving the draw halves the rate', async () => {
    const price = await priceWith({ watts: 150, kwhRate: 0.17 }, 'half-watts');
    assert.equal(price.in, 0.0175);
    assert.equal(price.out, 0.393);
  });
});
