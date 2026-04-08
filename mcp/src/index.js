import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_BASE = process.env.API_BASE ?? 'http://localhost:3001';
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

const server = new McpServer({ name: 'kol-emet', version: '0.1.0' });

server.tool(
  'search_entries',
  'Search wiki entries by keyword, tag, or category',
  {
    q: z.string().optional().describe('Keyword to search title, summary, and body'),
    tag: z.string().optional().describe('Filter by tag'),
    category: z.string().optional().describe('Filter by category'),
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

server.tool(
  'get_entry',
  'Retrieve a single wiki entry by its MongoDB id',
  { id: z.string().describe('MongoDB ObjectId of the entry') },
  async ({ id }) => {
    const entry = await apiFetch(`/entries/${id}`);
    return { content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }] };
  }
);

server.tool(
  'create_entry',
  'Add a new wiki entry',
  {
    title: z.string(),
    category: z.enum(['Characters', 'Worlds', 'Organizations', 'Lore & Mechanics', 'Timeline', 'Open Questions']),
    summary: z.string(),
    body: z.string().optional(),
    tags: z.array(z.string()).optional(),
    open_question: z.string().optional(),
  },
  async (data) => {
    const entry = await apiFetch('/entries', { method: 'POST', body: JSON.stringify(data) });
    return { content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }] };
  }
);

server.tool(
  'update_entry',
  'Edit an existing wiki entry',
  {
    id: z.string().describe('MongoDB ObjectId of the entry'),
    title: z.string().optional(),
    category: z.enum(['Characters', 'Worlds', 'Organizations', 'Lore & Mechanics', 'Timeline', 'Open Questions']).optional(),
    summary: z.string().optional(),
    body: z.string().optional(),
    tags: z.array(z.string()).optional(),
    open_question: z.string().optional(),
  },
  async ({ id, ...data }) => {
    const entry = await apiFetch(`/entries/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    return { content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }] };
  }
);

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

const transport = new StdioServerTransport();
await server.connect(transport);
