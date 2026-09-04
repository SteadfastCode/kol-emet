/**
 * System-level cheapest-model cache.
 * Fetches OpenRouter pricing once per week and returns the cheapest model
 * from a curated candidate list. Used by the memory extractor so extraction
 * always runs on the lowest-cost available model.
 *
 * Falls back to a hardcoded default if the fetch fails or OpenRouter is not configured.
 */

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const FALLBACK_MODEL = 'openai/gpt-5.4-nano';

// Ordered candidate list — models considered for extraction (cheap, capable enough for JSON extraction)
const EXTRACTION_CANDIDATES = [
  'openai/gpt-5.4-nano',
  'google/gemini-3.1-flash-lite-preview',
  'openai/gpt-5.4-mini',
  'google/gemini-3-flash-preview',
  'anthropic/claude-sonnet-4.6',
];

let cache = { modelId: null, fetchedAt: null };

export async function getCheapestExtractionModel() {
  const now = Date.now();
  if (cache.modelId && cache.fetchedAt && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.modelId;
  }

  if (!process.env.OPENROUTER_API_KEY) return FALLBACK_MODEL;

  try {
    const res  = await fetch(OPENROUTER_MODELS_URL);
    const json = await res.json();
    const models = json?.data ?? [];

    let cheapest     = null;
    let cheapestPrice = Infinity;

    for (const m of models) {
      if (!EXTRACTION_CANDIDATES.includes(m.id)) continue;
      const price = parseFloat(m.pricing?.prompt ?? Infinity);
      if (price < cheapestPrice) {
        cheapestPrice = price;
        cheapest = m.id;
      }
    }

    const modelId = cheapest ?? FALLBACK_MODEL;
    cache = { modelId, fetchedAt: now };
    console.log(`[cheapModelFinder] extraction model set to ${modelId} ($${cheapestPrice}/token prompt)`);
    return modelId;
  } catch (err) {
    console.error('[cheapModelFinder] pricing fetch failed, using fallback:', err.message);
    return FALLBACK_MODEL;
  }
}
