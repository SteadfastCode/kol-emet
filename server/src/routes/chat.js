/**
 * Multi-provider AI chat endpoint.
 *
 * Supported providers (all use the OpenAI-compatible SDK):
 *   xai     — xAI Grok models (native remote MCP support)
 *   openai  — OpenAI GPT models (native remote MCP support)
 *   gemini  — Google Gemini via OpenAI-compat layer (no remote MCP)
 *
 * Responses are streamed as SSE: `data: <JSON>\n\n`
 * Event shapes:
 *   { type: 'delta',  content: string }  — text chunk
 *   { type: 'done' }                     — stream complete
 *   { type: 'error',  message: string }  — error
 */

import { Router } from 'express';
import OpenAI from 'openai';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ─── Provider registry ────────────────────────────────────────────────────────

const PROVIDERS = {
  xai: {
    name: 'xAI (Grok)',
    envKey: 'XAI_API_KEY',
    baseURL: 'https://api.x.ai/v1',
    models: ['grok-3', 'grok-3-mini', 'grok-3-fast'],
    defaultModel: 'grok-3',
    remoteMcp: true,
  },
  openai: {
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    baseURL: null,
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
    defaultModel: 'gpt-4o',
    remoteMcp: true,
  },
  gemini: {
    name: 'Google Gemini',
    envKey: 'GEMINI_API_KEY',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    models: ['gemini-2.0-flash', 'gemini-2.0-flash-thinking-exp', 'gemini-1.5-pro'],
    defaultModel: 'gemini-2.0-flash',
    remoteMcp: false,
  },
};

function makeClient(providerId) {
  const p = PROVIDERS[providerId];
  const apiKey = process.env[p.envKey];
  if (!apiKey) throw new Error(`${p.envKey} is not configured on the server`);
  const opts = { apiKey };
  if (p.baseURL) opts.baseURL = p.baseURL;
  return new OpenAI(opts);
}

const WIKI_SYSTEM_PROMPT =
  'You are an AI assistant integrated into Kol Emet, a world-building wiki. ' +
  'You have access to wiki tools — use them to look up entities, check relationships, ' +
  'and make edits when asked. Be concise. When referencing wiki content always cite entity names. ' +
  'Never invent wiki facts; if you are unsure, search first.';

// ─── GET /chat/providers ──────────────────────────────────────────────────────

router.get('/providers', requireAuth, (req, res) => {
  const available = Object.entries(PROVIDERS)
    .filter(([, p]) => !!process.env[p.envKey])
    .map(([id, p]) => ({
      id,
      name: p.name,
      models: p.models,
      defaultModel: p.defaultModel,
      remoteMcp: p.remoteMcp,
    }));
  res.json(available);
});

// ─── POST /chat ───────────────────────────────────────────────────────────────

router.post('/', requireAuth, async (req, res) => {
  const { provider = 'xai', model, messages = [], systemPrompt } = req.body;

  const providerCfg = PROVIDERS[provider];
  if (!providerCfg) return res.status(400).json({ error: `Unknown provider: ${provider}` });

  const apiKey = process.env[providerCfg.envKey];
  if (!apiKey) return res.status(503).json({ error: `${providerCfg.name} API key is not configured` });

  const effectiveModel = model || providerCfg.defaultModel;
  const effectiveSystem = systemPrompt || WIKI_SYSTEM_PROMPT;

  // Build message list with system prompt
  const allMessages = [
    { role: 'system', content: effectiveSystem },
    ...messages,
  ];

  // Inject remote MCP tool if provider supports it and we have a URL
  const mcpUrl = process.env.MCP_SERVER_URL;
  const mcpToken = process.env.MCP_BEARER_TOKEN;
  const tools = [];
  if (providerCfg.remoteMcp && mcpUrl) {
    const mcpTool = {
      type: 'mcp',
      server_url: mcpUrl,
      server_label: 'kol_emet_wiki',
    };
    if (mcpToken) mcpTool.headers = { Authorization: `Bearer ${mcpToken}` };
    tools.push(mcpTool);
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const client = makeClient(provider);
    const stream = await client.chat.completions.create({
      model: effectiveModel,
      messages: allMessages,
      stream: true,
      ...(tools.length ? { tools } : {}),
    });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        send({ type: 'delta', content: delta.content });
      }
    }

    send({ type: 'done' });
    res.end();
  } catch (err) {
    send({ type: 'error', message: err.message });
    res.end();
  }
});

export default router;
