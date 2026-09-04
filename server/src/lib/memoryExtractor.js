/**
 * Fire-and-forget memory extraction.
 * After each exchange, runs the newest user+assistant pair through a cheap
 * AI call to pull out facts worth remembering. Only the latest pair is sent
 * to avoid re-processing older messages and generating duplicates.
 */

import { makeClient, PROVIDERS } from './aiProviders.js';
import { getCheapestExtractionModel } from './cheapModelFinder.js';
import UserMemory from '../models/UserMemory.js';

const EXTRACTION_SYSTEM =
  'You extract memorable facts from a single conversation exchange for a personal wiki assistant. ' +
  'Identify facts worth remembering across future sessions: user preferences, opinions, ' +
  'explicitly stated requests to remember something, important project context, ' +
  'or personal details relevant to future assistance. ' +
  'Be selective — only extract genuinely notable facts, not summaries of routine exchanges. ' +
  'Return a JSON array of concise, self-contained fact strings. ' +
  'Return [] if nothing is worth remembering. Return ONLY the JSON array, no other text.';

// Native-provider fallbacks when OpenRouter is not configured
const NATIVE_CHEAP_MODELS = {
  claude: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
  xai:    'grok-4-1-fast-reasoning',
};

export async function extractAndSaveMemories(userId, conversationId, lastUserMsg, lastAssistantMsg, provider) {
  try {
    // Prefer OpenRouter for extraction (cheapest model, one key)
    let extractionProvider = provider;
    let model;

    if (process.env.OPENROUTER_API_KEY) {
      extractionProvider = 'openrouter';
      model = await getCheapestExtractionModel();
    } else {
      model = NATIVE_CHEAP_MODELS[provider] ?? PROVIDERS[provider]?.defaultModel;
    }

    const client = makeClient(extractionProvider);

    const exchangeText =
      `User: ${lastUserMsg}\n\nAssistant: ${lastAssistantMsg}`;

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM },
        { role: 'user',   content: exchangeText },
      ],
    });

    const raw = response.choices?.[0]?.message?.content?.trim() ?? '[]';
    let facts;
    try {
      facts = JSON.parse(raw);
    } catch {
      const match = raw.match(/\[[\s\S]*\]/);
      facts = match ? JSON.parse(match[0]) : [];
    }

    if (!Array.isArray(facts) || facts.length === 0) return;

    const docs = facts
      .filter(f => typeof f === 'string' && f.trim())
      .map(f => ({ userId, fact: f.trim(), sourceId: conversationId }));

    if (docs.length > 0) await UserMemory.insertMany(docs);
  } catch (err) {
    console.error('[memoryExtractor] failed:', err.message);
  }
}

export async function loadMemories(userId) {
  const records = await UserMemory.find({ userId })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  return records.map(r => r.fact);
}
