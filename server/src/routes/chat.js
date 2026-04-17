/**
 * Multi-provider AI chat endpoint with wiki tool calling.
 *
 * Two tool-calling strategies are supported transparently:
 *
 *   Responses API  — providers with responsesApi:true AND MCP_SERVER_URL configured.
 *                    Uses client.responses.create with type:'mcp'; the provider
 *                    calls the MCP server directly on our behalf.
 *
 *   Completions API — universal fallback. Uses client.chat.completions.create with
 *                    type:'function' tools executed server-side against the database.
 *
 * Both paths emit identical SSE events to the client:
 *   { type: 'delta',   content: string }  — text chunk
 *   { type: 'done' }                      — stream complete
 *   { type: 'error',   message: string }  — fatal error
 *
 * When conversationId is provided the new user message and assistant response
 * are appended to the stored Conversation document after streaming completes.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { PROVIDERS, makeClient } from '../lib/aiProviders.js';
import Conversation from '../models/Conversation.js';
import Entity from '../models/Entity.js';
import RelationshipGroup from '../models/RelationshipGroup.js';
import { resolveGroupLabels } from '../lib/relationshipResolver.js';

const router = Router();

// ─── System prompt ────────────────────────────────────────────────────────────

const WIKI_SYSTEM_PROMPT =
  'You are an AI assistant integrated into Kol Emet, a world-building wiki. ' +
  'You have access to wiki search tools — use them. ' +
  'ALWAYS call search_entities before answering questions about wiki content. ' +
  'Use get_entity when you need full details on a specific entity. ' +
  'NEVER invent entity names, relationships, places, or lore. ' +
  'If search returns nothing, say so — do not fill the gap with invented content. ' +
  'Be concise. Cite entity names when referencing wiki content.';

// ─── Responses API path (MCP tools) ──────────────────────────────────────────

function mcpToolDef() {
  return {
    type: 'mcp',
    server_label: 'kol-emet',
    server_url: process.env.MCP_SERVER_URL,
    headers: { Authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` },
    require_approval: 'never',
  };
}

/**
 * Stream via Responses API (MCP tools). Returns the full assistant text.
 */
async function streamViaResponsesApi(client, model, systemPrompt, messages, send) {
  const input = messages.filter((m) => m.role !== 'system');

  const stream = await client.responses.create({
    model,
    instructions: systemPrompt,
    input,
    tools: [mcpToolDef()],
    stream: true,
  });

  let assistantText = '';
  for await (const event of stream) {
    if (event.type === 'response.output_text.delta') {
      assistantText += event.delta;
      send({ type: 'delta', content: event.delta });
    }
  }
  return assistantText;
}

// ─── Completions API path (function tools, local execution) ──────────────────

const CATEGORIES = ['Characters', 'Worlds', 'Organizations', 'Lore & Mechanics', 'Timeline', 'Open Questions'];

const WIKI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_entities',
      description:
        'Search wiki entities by keyword, tag, or category. ' +
        'Call this before answering any question about wiki content. ' +
        'Returns id, title, category, and summary for each match.',
      parameters: {
        type: 'object',
        properties: {
          q:        { type: 'string', description: 'Keyword to search titles, summaries, and content' },
          category: { type: 'string', enum: CATEGORIES, description: 'Filter to a specific category' },
          tag:      { type: 'string', description: 'Filter by tag' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_entity',
      description:
        'Get the full details of a single wiki entity by its ID, ' +
        'including all content blocks and resolved relationship labels. ' +
        'Use after search_entities to get the full picture on a specific result.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'MongoDB ObjectId of the entity (from search_entities results)' },
        },
        required: ['id'],
      },
    },
  },
];

async function executeTool(name, args) {
  if (name === 'search_entities') {
    const filter = {};
    if (args.category) filter.category = args.category;
    if (args.tag)      filter.tags = args.tag;
    if (args.q) {
      const re = new RegExp(args.q, 'i');
      filter.$or = [
        { title: re },
        { summary: re },
        { 'blocks.data.markdown': re },
      ];
    }
    const results = await Entity.find(filter)
      .sort({ title: 1 })
      .select('_id title category summary tags')
      .lean();
    return results.length ? results : { message: 'No entities matched that search.' };
  }

  if (name === 'get_entity') {
    const entity = await Entity.findById(args.id).lean();
    if (!entity) return { error: `Entity not found: ${args.id}` };
    const rawGroups = await RelationshipGroup.find({
      members: { $elemMatch: { refId: args.id, refModel: 'Entity' } },
    }).lean();
    const relationships = await resolveGroupLabels(rawGroups, args.id);
    return { ...entity, relationships };
  }

  return { error: `Unknown tool: ${name}` };
}

/**
 * Stream via Chat Completions API (function calling, local execution).
 * Returns the full assistant text (from whichever phase produced it).
 */
async function streamViaCompletions(client, model, systemPrompt, messages, send) {
  let currentMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  // Phase 1: stream with tools available
  const firstStream = await client.chat.completions.create({
    model,
    messages:    currentMessages,
    tools:       WIKI_TOOLS,
    tool_choice: 'auto',
    stream:      true,
  });

  let assistantContent = '';
  const pendingToolCalls = {};

  for await (const chunk of firstStream) {
    const choice = chunk.choices?.[0];
    const delta  = choice?.delta;

    if (delta?.content) {
      assistantContent += delta.content;
      send({ type: 'delta', content: delta.content });
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (!pendingToolCalls[tc.index]) {
          pendingToolCalls[tc.index] = {
            id:       tc.id ?? '',
            type:     'function',
            function: { name: tc.function?.name ?? '', arguments: '' },
          };
        }
        const slot = pendingToolCalls[tc.index];
        if (tc.id)                  slot.id = tc.id;
        if (tc.function?.name)      slot.function.name      += tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
    }
  }

  const toolCallsList = Object.values(pendingToolCalls);
  if (toolCallsList.length === 0) return assistantContent;

  // Phase 2: execute tools and stream the final answer
  currentMessages = [
    ...currentMessages,
    { role: 'assistant', content: assistantContent || null, tool_calls: toolCallsList },
  ];

  for (const tc of toolCallsList) {
    let result;
    try {
      const args = JSON.parse(tc.function.arguments);
      result = await executeTool(tc.function.name, args);
    } catch (err) {
      result = { error: `Tool execution failed: ${err.message}` };
    }
    currentMessages.push({
      role:         'tool',
      tool_call_id: tc.id,
      content:      JSON.stringify(result),
    });
  }

  const finalStream = await client.chat.completions.create({
    model,
    messages: currentMessages,
    stream:   true,
  });

  let finalContent = '';
  for await (const chunk of finalStream) {
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) {
      finalContent += delta.content;
      send({ type: 'delta', content: delta.content });
    }
  }
  return finalContent || assistantContent;
}

// ─── GET /chat/providers ──────────────────────────────────────────────────────

router.get('/providers', requireAuth, (req, res) => {
  const available = Object.entries(PROVIDERS)
    .filter(([, p]) => !!process.env[p.envKey])
    .map(([id, p]) => ({
      id,
      name: p.name,
      models: p.models,
      defaultModel: p.defaultModel,
    }));
  res.json(available);
});

// ─── POST /chat ───────────────────────────────────────────────────────────────

router.post('/', requireAuth, async (req, res) => {
  const { provider = 'xai', model, messages = [], systemPrompt, conversationId } = req.body;

  const providerCfg = PROVIDERS[provider];
  if (!providerCfg) return res.status(400).json({ error: `Unknown provider: ${provider}` });

  const apiKey = process.env[providerCfg.envKey];
  if (!apiKey) return res.status(503).json({ error: `${providerCfg.name} API key is not configured` });

  const effectiveModel  = model || providerCfg.defaultModel;
  const effectiveSystem = systemPrompt || WIKI_SYSTEM_PROMPT;

  // Validate conversation ownership if provided
  const userId = req.session?.userId;
  let conversation = null;
  if (conversationId && userId) {
    conversation = await Conversation.findOne({ _id: conversationId, userId });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const client = makeClient(provider);

    const useResponsesApi =
      providerCfg.responsesApi === true && !!process.env.MCP_SERVER_URL;

    const assistantText = useResponsesApi
      ? await streamViaResponsesApi(client, effectiveModel, effectiveSystem, messages, send)
      : await streamViaCompletions(client, effectiveModel, effectiveSystem, messages, send);

    // Persist the new exchange to the conversation
    if (conversation && assistantText) {
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
      if (lastUserMsg) {
        conversation.messages.push(
          { role: 'user',      content: lastUserMsg.content },
          { role: 'assistant', content: assistantText },
        );
        await conversation.save();
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
