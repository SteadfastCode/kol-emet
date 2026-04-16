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
    models: ['grok-3', 'grok-3-mini', 'grok-3-fast', 'grok-4.1-fast', 'grok-4.20-reasoning'],
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

// System prompt when the MCP tool is wired in — AI has real search access
const WIKI_SYSTEM_PROMPT_WITH_TOOLS =
  'You are an AI assistant integrated into Kol Emet, a world-building wiki. ' +
  'You have access to wiki search and edit tools. ' +
  'CRITICAL: ALWAYS call search_entities or get_entity BEFORE answering any question about wiki content. ' +
  'NEVER answer from memory or make up entity names, relationships, places, or lore. ' +
  'If the search returns no results, say so explicitly — do not fill the gap with invented content. ' +
  'Be concise. Cite entity names when referencing wiki content.';

// System prompt when no MCP URL is configured — AI has no tools
const WIKI_SYSTEM_PROMPT_NO_TOOLS =
  'You are an AI assistant integrated into Kol Emet, a world-building wiki. ' +
  'You do NOT currently have access to wiki search tools (the MCP server URL is not configured). ' +
  'Do NOT invent or guess any wiki content. ' +
  'If the user asks about wiki content, tell them the wiki tools are not connected and they need to set MCP_SERVER_URL on the server.';

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

  // Inject remote MCP tool if provider supports it and we have a URL
  const mcpUrl = process.env.MCP_SERVER_URL;
  const mcpToken = process.env.MCP_BEARER_TOKEN;
  const tools = [];
  const toolsAvailable = providerCfg.remoteMcp && !!mcpUrl;
  if (toolsAvailable) {
    const mcpTool = {
      type: 'mcp',
      server_url: mcpUrl,
      server_label: 'kol_emet_wiki',
    };
    if (mcpToken) mcpTool.headers = { Authorization: `Bearer ${mcpToken}` };
    tools.push(mcpTool);
  }

  // Pick system prompt based on whether tools are actually wired up
  const defaultSystem = toolsAvailable ? WIKI_SYSTEM_PROMPT_WITH_TOOLS : WIKI_SYSTEM_PROMPT_NO_TOOLS;
  const effectiveSystem = systemPrompt || defaultSystem;

  // Build message list with system prompt
  const allMessages = [
    { role: 'system', content: effectiveSystem },
    ...messages,
  ];

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
