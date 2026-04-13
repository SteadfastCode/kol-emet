import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_BASE = process.env.API_BASE ?? 'http://localhost:3004';
const BEARER_TOKEN = process.env.BEARER_TOKEN ?? '';

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${BEARER_TOKEN}`,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

// Block data schemas for MCP tool inputs
const TextBlockData = z.object({ markdown: z.string() });
const AttributeBlockData = z.object({ label: z.string(), value: z.string() });
const QuoteBlockData = z.object({ text: z.string(), attribution: z.string().optional() });
const TimelineEventBlockData = z.object({
  date: z.string(),
  sortKey: z.number().optional(),
  era: z.string().optional(),
  description: z.string(),
  linkedEntryId: z.string().nullable().optional(),
});
const RelationshipBlockData = z.object({
  relationshipType: z.string(),
  targetId: z.string().nullable().optional(),
  targetTitle: z.string().optional(),
  notes: z.string().optional(),
});

const BlockInput = z.object({
  type: z.enum(['text', 'relationship', 'timeline_event', 'attribute', 'quote', 'gallery']),
  order: z.number().optional(),
  data: z.union([
    TextBlockData,
    AttributeBlockData,
    QuoteBlockData,
    TimelineEventBlockData,
    RelationshipBlockData,
    z.record(z.unknown()),
  ]),
});

const server = new McpServer({ name: 'kol-emet', version: '0.1.0' });

// ─── Search ──────────────────────────────────────────────────────────────────

server.tool(
  'search_entries',
  'Search wiki entries by keyword, tag, or category. Returns id, title, category, summary, and tags.',
  {
    q: z.string().optional().describe('Keyword to search title, summary, and block content'),
    tag: z.string().optional().describe('Filter by tag'),
    category: z.enum(['Characters', 'Worlds', 'Organizations', 'Lore & Mechanics', 'Timeline', 'Open Questions']).optional(),
  },
  async ({ q, tag, category }) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (tag) params.set('tag', tag);
    if (category) params.set('category', category);
    const entries = await apiFetch(`/entries?${params}`);
    return { content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }] };
  }
);

// ─── Get single entry ────────────────────────────────────────────────────────

server.tool(
  'get_entry',
  'Retrieve a single wiki entry by its id, including all blocks.',
  { id: z.string().describe('MongoDB ObjectId of the entry') },
  async ({ id }) => {
    const entry = await apiFetch(`/entries/${id}`);
    return { content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }] };
  }
);

// ─── Create entry ────────────────────────────────────────────────────────────

server.tool(
  'create_entry',
  'Add a new wiki entry. Provide at least title and category. Use blocks for structured content.',
  {
    title: z.string(),
    category: z.enum(['Characters', 'Worlds', 'Organizations', 'Lore & Mechanics', 'Timeline', 'Open Questions']),
    summary: z.string().optional().describe('One-line description'),
    tags: z.array(z.string()).optional(),
    open_question: z.string().optional().describe('An unresolved question to attach'),
    blocks: z.array(BlockInput).optional().describe(
      'Content blocks. Each block has a type (text, attribute, quote, timeline_event, relationship, gallery) and a data object. ' +
      'Text blocks: { markdown }. Attribute blocks: { label, value }. ' +
      'Timeline event blocks: { date, sortKey, era, description, linkedEntryId }. ' +
      'Relationship blocks: { relationshipType, targetId, notes }. ' +
      'If omitted, a single empty text block is created automatically.'
    ),
  },
  async (data) => {
    const entry = await apiFetch('/entries', { method: 'POST', body: JSON.stringify(data) });
    return { content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }] };
  }
);

// ─── Update entry ────────────────────────────────────────────────────────────

server.tool(
  'update_entry',
  'Edit an existing wiki entry. Only provided fields are updated. To update block content, pass the full blocks array.',
  {
    id: z.string().describe('MongoDB ObjectId of the entry'),
    title: z.string().optional(),
    category: z.enum(['Characters', 'Worlds', 'Organizations', 'Lore & Mechanics', 'Timeline', 'Open Questions']).optional(),
    summary: z.string().optional(),
    tags: z.array(z.string()).optional(),
    open_question: z.string().optional(),
    blocks: z.array(BlockInput).optional().describe(
      'Full replacement blocks array. Must include all blocks you want to keep — any blocks not included will be removed.'
    ),
  },
  async ({ id, ...data }) => {
    const entry = await apiFetch(`/entries/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    return { content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }] };
  }
);

// ─── Open questions ──────────────────────────────────────────────────────────

server.tool(
  'add_open_question',
  'Attach or update an open question on an existing entry',
  {
    id: z.string().describe('MongoDB ObjectId of the entry'),
    open_question: z.string().describe('The unresolved question to attach'),
  },
  async ({ id, open_question }) => {
    const entry = await apiFetch(`/entries/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ open_question }),
    });
    return { content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }] };
  }
);

server.tool(
  'list_open_questions',
  'Return all entries that have an unresolved open question',
  {},
  async () => {
    const entries = await apiFetch('/open-questions');
    return { content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }] };
  }
);

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
