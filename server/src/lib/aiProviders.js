/**
 * Shared AI provider registry and client factory.
 * Used by both the chat route and the conversations route.
 *
 * Provider tiers:
 *   OpenRouter  — primary SaaS path. One API key, all models, per-request cost data.
 *   Native      — power-user / self-hosted fallback. Individual provider keys.
 *                 xAI and OpenAI native providers also support the Responses API + MCP path.
 */

import OpenAI from 'openai';

export const PROVIDERS = {
  // ── Primary: OpenRouter ───────────────────────────────────────────────────
  openrouter: {
    name: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    baseURL: 'https://openrouter.ai/api/v1',
    // Curated model list — verify against https://openrouter.ai/api/v1/models
    models: [
      'anthropic/claude-opus-4.7',
      'anthropic/claude-sonnet-4.6',
      'openai/gpt-5.4',
      'openai/gpt-5.4-mini',
      'openai/gpt-5.4-nano',
      'google/gemini-3.1-pro-preview',
      'google/gemini-3-flash-preview',
      'google/gemini-3.1-flash-lite-preview',
      'x-ai/grok-4.20',
    ],
    defaultModel: 'anthropic/claude-sonnet-4.6',
    responsesApi: false,
  },

  // ── Native fallback providers (power users / self-hosted) ─────────────────
  claude: {
    name: 'Claude (Anthropic)',
    envKey: 'ANTHROPIC_API_KEY',
    baseURL: 'https://api.anthropic.com/v1',
    models: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    defaultModel: 'claude-sonnet-4-6',
    responsesApi: false,
  },
  xai: {
    name: 'xAI (Grok)',
    envKey: 'XAI_API_KEY',
    baseURL: 'https://api.x.ai/v1',
    models: ['grok-4-1-fast-reasoning', 'grok-4.20-0309-reasoning'],
    defaultModel: 'grok-4-1-fast-reasoning',
    responsesApi: true,
  },
  openai: {
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    baseURL: null,
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
    defaultModel: 'gpt-4o',
    responsesApi: true,
  },
  gemini: {
    name: 'Google Gemini',
    envKey: 'GEMINI_API_KEY',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    models: ['gemini-2.0-flash', 'gemini-2.0-flash-thinking-exp', 'gemini-1.5-pro'],
    defaultModel: 'gemini-2.0-flash',
    responsesApi: false,
  },
};

export function makeClient(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error(`Unknown provider: ${providerId}`);
  const apiKey = process.env[p.envKey];
  if (!apiKey) throw new Error(`${p.envKey} is not configured on the server`);
  const opts = { apiKey };
  if (p.baseURL) opts.baseURL = p.baseURL;
  return new OpenAI(opts);
}
