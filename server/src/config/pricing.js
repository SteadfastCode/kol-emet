/**
 * Token pricing, in micro-dollars (millionths) per token.
 *
 * Integers throughout: budgets are compared and decremented on every AI call,
 * and floating-point cents drift.
 *
 * Self-hosted models cost nothing and are priced at zero — usage on the
 * steadfast-ai box never touches a user's budget, which is the point of having
 * it. Anything not listed falls back to a DELIBERATELY CONSERVATIVE rate:
 * over-charging a budget is recoverable, silently under-metering an unknown
 * model is not.
 */

const MICROS = 1_000_000;

/**
 * Prices are $/million tokens. Stored as-is and converted at call time so the
 * table stays readable against published pricing pages.
 */
export const MODEL_PRICES = {
  // Anthropic first-party rates (also what OpenRouter charges, plus a margin).
  'claude-opus-5':              { in: 5,  out: 25 },
  'claude-opus-4-8':            { in: 5,  out: 25 },
  'claude-sonnet-5':            { in: 3,  out: 15 },
  'claude-sonnet-4-6':          { in: 3,  out: 15 },
  'claude-haiku-4-5':           { in: 1,  out: 5  },
  'anthropic/claude-opus-4.7':  { in: 5,  out: 25 },
  'anthropic/claude-sonnet-4.6': { in: 3, out: 15 },
};

/**
 * Applied when a model is not in the table. Set at Opus tier on purpose: an
 * unpriced model should cost a user MORE budget than it really does, never
 * less, so an unmetered provider can never quietly drain real money.
 */
export const FALLBACK_PRICE = { in: 5, out: 25 };

/**
 * Self-hosted inference on the steadfast-ai box. Not free — it burns
 * electricity — but roughly 85x cheaper on input and 19x on output than Sonnet.
 *
 * Derived from a measured run rather than picked: 1,997 in + 898 out took 54.8s
 * on the GTX 1080 Ti. Prompt processing runs ~400 tok/s and generation ~18
 * tok/s, so ~5s of that was prompt and ~50s was generation — which is why
 * output is priced ~22x input here, a far steeper ratio than a cloud provider's.
 * At ~300W for the whole box (250W GPU limit plus the rest) and $0.17/kWh, the
 * run cost about $0.0008.
 *
 * Both assumptions are worth revisiting: STEADFAST_WATTS if the box's real draw
 * differs, STEADFAST_KWH_RATE for the actual tariff. Changing either only
 * affects how fast a self-hosted run draws down an allowance.
 */
const WATTS = Number(process.env.STEADFAST_WATTS ?? 300);
const KWH_RATE = Number(process.env.STEADFAST_KWH_RATE ?? 0.17);
const BASELINE = { watts: 300, kwhRate: 0.17, in: 0.035, out: 0.786 };
const scale = (WATTS / BASELINE.watts) * (KWH_RATE / BASELINE.kwhRate);

export const SELF_HOSTED_PRICE = {
  in:  BASELINE.in * scale,
  out: BASELINE.out * scale,
};

/** Providers whose inference we host ourselves. Cheap, but not free. */
export const SELF_HOSTED_PROVIDERS = new Set(['steadfast']);

/**
 * Providers that cost nothing at all. Empty by design — self-hosted moved to
 * its own rate once electricity was accounted for. Kept as a concept because
 * a genuinely free tier (a sponsored model, say) would slot in here.
 */
export const FREE_PROVIDERS = new Set();

/**
 * @returns {number} cost in micro-dollars (1_000_000 = $1.00)
 */
export function priceFor(provider, model) {
  if (FREE_PROVIDERS.has(provider)) return { in: 0, out: 0 };
  if (SELF_HOSTED_PROVIDERS.has(provider)) return SELF_HOSTED_PRICE;
  return MODEL_PRICES[model] ?? FALLBACK_PRICE;
}

export function costMicros({ provider, model, promptTokens = 0, completionTokens = 0 }) {
  const price = priceFor(provider, model);
  const dollars = (promptTokens / MICROS) * price.in + (completionTokens / MICROS) * price.out;
  // Rounded up, so a sub-micro-dollar call still registers as spend rather than
  // being free by virtue of being small.
  return Math.ceil(dollars * MICROS);
}

/** True when this model's price is a guess rather than a listed rate. */
export function isEstimatedPrice(provider, model) {
  if (FREE_PROVIDERS.has(provider) || SELF_HOSTED_PROVIDERS.has(provider)) return false;
  return !MODEL_PRICES[model];
}

export const formatMicros = (micros) => `$${(micros / MICROS).toFixed(4)}`;
