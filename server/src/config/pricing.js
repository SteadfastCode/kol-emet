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

/** Providers whose inference we host ourselves — free at the point of use. */
export const FREE_PROVIDERS = new Set(['steadfast']);

/**
 * @returns {number} cost in micro-dollars (1_000_000 = $1.00)
 */
export function costMicros({ provider, model, promptTokens = 0, completionTokens = 0 }) {
  if (FREE_PROVIDERS.has(provider)) return 0;

  const price = MODEL_PRICES[model] ?? FALLBACK_PRICE;
  const dollars = (promptTokens / MICROS) * price.in + (completionTokens / MICROS) * price.out;
  return Math.ceil(dollars * MICROS);
}

/** True when this model's price is a guess rather than a listed rate. */
export function isEstimatedPrice(provider, model) {
  return !FREE_PROVIDERS.has(provider) && !MODEL_PRICES[model];
}

export const formatMicros = (micros) => `$${(micros / MICROS).toFixed(4)}`;
