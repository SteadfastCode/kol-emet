import { Router } from 'express';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import Entry, { BLOCK_TYPES } from '../models/Entry.js';
import OpenQuestion from '../models/OpenQuestion.js';

const router = Router();

// ─── Auth ────────────────────────────────────────────────────────────────────

const MCP_TOKEN = process.env.MCP_BEARER_TOKEN;

router.use((req, res, next) => {
  console.log(`[mcp] ${req.method} ${req.path} — session: ${req.headers['mcp-session-id'] ?? 'none'} — auth: ${req.headers['authorization'] ? 'present' : 'missing'}`);
  if (!MCP_TOKEN) return next(); // dev mode: no token required
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${MCP_TOKEN}`) {
    console.log('[mcp] auth failed — got:', auth);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ─── Tool definitions ─────────────────────────────────────────────────────────

const CATEGORIES = ['Characters', 'Worlds', 'Organizations', 'Lore & Mechanics', 'Timeline', 'Open Questions'];

const BlockInput = z.object({
  type: z.enum(BLOCK_TYPES),
  order: z.number().optional(),
  data: z.record(z.unknown()),
});

function createMcpServer() {
  const server = new McpServer({ name: 'kol-emet', version: '0.1.0' });

  server.tool(
    'search_entries',
    'Search wiki entries by keyword, tag, or category. Returns id, title, category, summary, and tags.',
    {
      q: z.string().optional().describe('Keyword to search title, summary, and block content'),
      tag: z.string().optional().describe('Filter by tag'),
      category: z.enum(CATEGORIES).optional(),
    },
    async ({ q, tag, category }) => {
      const filter = {};
      if (category) filter.category = category;
      if (tag) filter.tags = tag;
      if (q) {
        const re = new RegExp(q, 'i');
        filter.$or = [
          { title: re },
          { summary: re },
          { body: re },
          { blocks: { $elemMatch: { 'data.markdown': re } } },
        ];
      }
      const entries = await Entry.find(filter)
        .sort({ title: 1 })
        .populate('open_questions', 'question status');
      return { content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }] };
    }
  );

  server.tool(
    'get_entry',
    'Retrieve a single wiki entry by its id, including all blocks.',
    { id: z.string().describe('MongoDB ObjectId of the entry') },
    async ({ id }) => {
      const entry = await Entry.findById(id).populate('open_questions', 'question status');
      if (!entry) throw new Error(`Entry not found: ${id}`);
      return { content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }] };
    }
  );

  server.tool(
    'create_entry',
    'Add a new wiki entry. Use blocks for structured content.',
    {
      title: z.string(),
      category: z.enum(CATEGORIES),
      summary: z.string().optional().describe('One-line description'),
      tags: z.array(z.string()).optional(),
      blocks: z.array(BlockInput).optional().describe(
        'Content blocks. Types: text ({markdown}), attribute ({label, value}), ' +
        'quote ({text, attribution?}), timeline_event ({date, description, sortKey?, era?, linkedEntryId?}), ' +
        'relationship ({relationshipType, targetId?, targetTitle?, notes?}). ' +
        'If omitted, a single empty text block is created.'
      ),
    },
    async (data) => {
      if (data.blocks) {
        data.blocks = [...data.blocks]
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .map((b, i) => ({ ...b, order: i }));
      }
      const entry = await Entry.create(data);
      return { content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }] };
    }
  );

  server.tool(
    'update_entry',
    'Edit an existing wiki entry. Only provided fields are updated. To update blocks, pass the full blocks array — unlisted blocks are removed.',
    {
      id: z.string().describe('MongoDB ObjectId of the entry'),
      title: z.string().optional(),
      category: z.enum(CATEGORIES).optional(),
      summary: z.string().optional(),
      tags: z.array(z.string()).optional(),
      blocks: z.array(BlockInput).optional(),
    },
    async ({ id, ...data }) => {
      if (data.blocks) {
        data.blocks = [...data.blocks]
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .map((b, i) => ({ ...b, order: i }));
      }
      const entry = await Entry.findByIdAndUpdate(id, data, { new: true, runValidators: true })
        .populate('open_questions', 'question status');
      if (!entry) throw new Error(`Entry not found: ${id}`);
      return { content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }] };
    }
  );

  server.tool(
    'add_open_question',
    'Create a new open question and link it to one or more entries',
    {
      question: z.string().describe('The unresolved question'),
      entry_ids: z.array(z.string()).describe('MongoDB ObjectIds of entries to link this question to'),
    },
    async ({ question, entry_ids }) => {
      const oq = await OpenQuestion.create({ question, entry_ids });
      if (entry_ids.length) {
        await Entry.updateMany(
          { _id: { $in: entry_ids } },
          { $addToSet: { open_questions: oq._id } }
        );
      }
      return { content: [{ type: 'text', text: JSON.stringify(oq, null, 2) }] };
    }
  );

  server.tool(
    'list_open_questions',
    'Return all open questions, optionally filtered by status',
    {
      status: z.enum(['open', 'resolved']).optional(),
    },
    async ({ status }) => {
      const filter = status ? { status } : {};
      const questions = await OpenQuestion.find(filter)
        .sort({ createdAt: -1 })
        .populate('entry_ids', 'title category');
      return { content: [{ type: 'text', text: JSON.stringify(questions, null, 2) }] };
    }
  );

  return server;
}

// ─── Session management ───────────────────────────────────────────────────────

const sessions = new Map(); // sessionId -> StreamableHTTPServerTransport

router.post('/', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  console.log('[mcp] POST body:', JSON.stringify(req.body)?.slice(0, 200));

  if (sessionId && sessions.has(sessionId)) {
    console.log('[mcp] existing session:', sessionId);
    const transport = sessions.get(sessionId);

    // Intercept response to log what we're actually sending back
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    let responseBody = '';
    res.write = (chunk, ...args) => { responseBody += chunk; return origWrite(chunk, ...args); };
    res.end = (chunk, ...args) => {
      if (chunk) responseBody += chunk;
      console.log(`[mcp] response for ${req.body?.method}: status=${res.statusCode} body=${responseBody.slice(0, 500)}`);
      return origEnd(chunk, ...args);
    };

    await transport.handleRequest(req, res, req.body);
    return;
  }

  if (!sessionId && isInitializeRequest(req.body)) {
    console.log('[mcp] new session — creating McpServer');
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        console.log('[mcp] session initialized:', id);
        sessions.set(id, transport);
      },
    });
    transport.onclose = () => {
      console.log('[mcp] session closed');
      for (const [k, v] of sessions) { if (v === transport) sessions.delete(k); }
    };

    let server;
    try {
      server = createMcpServer();
      const toolNames = Object.keys(server._registeredTools ?? {});
      console.log('[mcp] registered tools:', toolNames.length ? toolNames : '(none)');
    } catch (err) {
      console.error('[mcp] createMcpServer() threw:', err.message);
      return res.status(500).json({ error: 'mcp_init_failed' });
    }
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  console.log('[mcp] rejected — no session and not an initialize request');
  res.status(400).json({ error: 'Bad request: missing or invalid session ID' });
});

// JSON response mode does not use a persistent GET SSE stream
router.get('/', (req, res) => {
  res.status(405).set('Allow', 'POST').send('Method Not Allowed');
});

router.delete('/', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  console.log('[mcp] DELETE session:', sessionId);
  if (sessionId && sessions.has(sessionId)) {
    await sessions.get(sessionId).close();
    sessions.delete(sessionId);
  }
  res.status(204).send();
});

export default router;
