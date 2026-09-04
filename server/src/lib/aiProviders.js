/**
 * Shared AI provider registry and client factory.
 * Used by both the chat route and the conversations route.
 *
 * Provider tiers:
 *   OpenRouter  — primary SaaS path. One API key, all models, per-request cost data.
 *   Native      — power-user / self-hosted fallback. Individual provider keys.
 *                 xAI and OpenAI native providers also support the Responses API + MCP path.
 *   Steadfast   — self-hosted models on the steadfast-ai box, behind an
 *                 OpenAI-compatible gateway. Free at the point of use, but only
 *                 reachable over the tailnet, so it is a local-dev / self-hosted
 *                 deployment option rather than a production default.
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

  // ── Self-hosted: the steadfast-ai box ─────────────────────────────────────
  steadfast: {
    name: 'Steadfast AI (self-hosted)',
    envKey: 'STEADFAST_AI_API_KEY',
    // Tailnet address of the gateway; override per-environment.
    baseURL: 'http://100.88.32.7:3011/v1',
    baseUrlEnvKey: 'STEADFAST_AI_BASE_URL',
    models: ['qwen2.5-coder:14b', 'gemma4:12b', 'llama3.2:3b', 'qwen2.5:3b', 'granite3.3:2b'],
    defaultModel: 'qwen2.5-coder:14b',
    responsesApi: false,
  },
};

/** True when a provider has the credentials it needs to be used. */
export function isConfigured(providerId) {
  const p = PROVIDERS[providerId];
  return Boolean(p && process.env[p.envKey]);
}

export function makeClient(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error(`Unknown provider: ${providerId}`);
  const apiKey = process.env[p.envKey];
  if (!apiKey) throw new Error(`${p.envKey} is not configured on the server`);
  const opts = { apiKey };
  // Resolved at call time, not module load, so dotenv ordering can't bite.
  const baseURL = (p.baseUrlEnvKey && process.env[p.baseUrlEnvKey]) || p.baseURL;
  if (baseURL) opts.baseURL = baseURL;
  return new OpenAI(opts);
}
