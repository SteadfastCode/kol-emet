/**
 * Shared AI provider registry and client factory.
 * Used by both the chat route and the conversations route.
 */

import OpenAI from 'openai';

export const PROVIDERS = {
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
