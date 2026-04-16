import { Router } from 'express';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import Entity, { BLOCK_TYPES } from '../models/Entity.js';
import RelationshipGroup from '../models/RelationshipGroup.js';
import OpenQuestion from '../models/OpenQuestion.js';
import User from '../models/User.js';
import { getMcpUser } from '../lib/mcpUserStore.js';
import { logCreate, logUpdate } from '../lib/changeLogger.js';

const router = Router();

// ─── Actor resolution ─────────────────────────────────────────────────────────

async function resolveMcpActor() {
  const userId = await getMcpUser();
  if (!userId) return null;
  const user = await User.findById(userId).select('email').lean();
  if (!user) return null;
  return { type: 'mcp', userId, label: `${user.email} via AI` };
}

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
    'search_entities',
    'Search wiki entities by keyword, tag, or category. Returns id, title, category, summary, and tags.',
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
      const entities = await Entity.find(filter)
        .sort({ title: 1 })
        .populate('open_questions', 'question status');
      return { content: [{ type: 'text', text: JSON.stringify(entities, null, 2) }] };
    }
  );

  server.tool(
    'get_entity',
    'Retrieve a single wiki entity by its id, including all blocks.',
    { id: z.string().describe('MongoDB ObjectId of the entity') },
    async ({ id }) => {
      const entity = await Entity.findById(id).populate('open_questions', 'question status').lean();
      if (!entity) throw new Error(`Entity not found: ${id}`);
      const relationships = await RelationshipGroup.find({ 'members.entityId': id })
        .populate({ path: 'members.entityId', select: 'title' });
      return { content: [{ type: 'text', text: JSON.stringify({ ...entity, relationships }, null, 2) }] };
    }
  );

  server.tool(
    'create_entity',
    'Add a new wiki entity. Use blocks for structured content.',
    {
      title: z.string(),
      category: z.enum(CATEGORIES),
      summary: z.string().optional().describe('One-line description'),
      tags: z.array(z.string()).optional(),
      blocks: z.array(BlockInput).optional().describe(
        'Content blocks. Types: text ({markdown}), attribute ({label, value}), ' +
        'quote ({text, attribution?}), timeline_event ({date, description, sortKey?, era?, linkedEntryId?}). ' +
        'If omitted, a single empty text block is created. ' +
        'IMPORTANT: Relationships between entities are NOT created via blocks — use add_relationship instead.'
      ),
    },
    async (data) => {
      if (data.blocks) {
        data.blocks = [...data.blocks]
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .map((b, i) => ({ ...b, order: i }));
      }
      const entity = await Entity.create(data);
      const actor = await resolveMcpActor();
      if (actor) {
        logCreate(entity.toObject(), actor).catch(err => console.error('[changelog] logCreate failed:', err));
      }
      return { content: [{ type: 'text', text: JSON.stringify(entity, null, 2) }] };
    }
  );

  server.tool(
    'update_entity',
    'Edit an existing wiki entity. Only provided fields are updated. To update blocks, pass the full blocks array — unlisted blocks are removed.',
    {
      id: z.string().describe('MongoDB ObjectId of the entity'),
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
      const before = await Entity.findById(id).lean();
      if (!before) throw new Error(`Entity not found: ${id}`);
      const after = await Entity.findByIdAndUpdate(id, data, { new: true, runValidators: true })
        .populate('open_questions', 'question status');
      if (!after) throw new Error(`Entity not found: ${id}`);
      const actor = await resolveMcpActor();
      if (actor) {
        logUpdate(before, after.toObject(), actor).catch(err => console.error('[changelog] logUpdate failed:', err));
      }
      return { content: [{ type: 'text', text: JSON.stringify(after, null, 2) }] };
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
        await Entity.updateMany(
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

  // ─── Relationships ───────────────────────────────────────────────────────────

  server.tool(
    'add_relationship',
    'Create a bidirectional relationship between two entities. This is the ONLY way to link entities — do NOT use blocks for this. ' +
    'Labels are optional at every level. Use myLabel/theirLabel for asymmetric roles (e.g. "father"/"son"). ' +
    'Use the same label on both sides for symmetric roles (e.g. both "sibling"). ' +
    'groupLabel names the relationship group itself (e.g. "parentage", "siblings"). ' +
    'Returns the created relationship group.',
    {
      myEntityId:    z.string().describe('MongoDB ObjectId of the first entity'),
      theirEntityId: z.string().describe('MongoDB ObjectId of the second entity'),
      myLabel:       z.string().optional().describe('Label for the first entity, e.g. "father"'),
      theirLabel:    z.string().optional().describe('Label for the second entity, e.g. "son"'),
      groupLabel:    z.string().optional().describe('Label for the group itself, e.g. "parentage"'),
      notes:         z.string().optional().describe("Notes on the first entity's membership"),
    },
    async ({ myEntityId, theirEntityId, myLabel, theirLabel, groupLabel, notes }) => {
      const group = await RelationshipGroup.create({
        label: groupLabel ?? null,
        members: [
          { entityId: myEntityId,    label: myLabel    ?? null, notes: notes ?? null },
          { entityId: theirEntityId, label: theirLabel ?? null },
        ],
      });
      await Entity.updateMany(
        { _id: { $in: [myEntityId, theirEntityId] } },
        { $addToSet: { relationships: group._id } }
      );
      const populated = await RelationshipGroup.findById(group._id)
        .populate({ path: 'members.entityId', select: 'title' });
      return { content: [{ type: 'text', text: JSON.stringify(populated, null, 2) }] };
    }
  );

  server.tool(
    'add_member_to_relationship',
    'Add a new entity to an existing relationship group. Use this to extend a group beyond its initial two members ' +
    '(e.g. adding a third sibling to a sibling group). The entity must not already be in the group.',
    {
      groupId:  z.string().describe('MongoDB ObjectId of the relationship group'),
      entityId: z.string().describe('MongoDB ObjectId of the entity to add'),
      label:    z.string().optional().describe('Label for this entity in the group, e.g. "sibling"'),
      notes:    z.string().optional().describe('Notes on this membership'),
    },
    async ({ groupId, entityId, label, notes }) => {
      const group = await RelationshipGroup.findById(groupId);
      if (!group) throw new Error(`Relationship group not found: ${groupId}`);
      const alreadyMember = group.members.some(m => String(m.entityId) === String(entityId));
      if (alreadyMember) throw new Error(`Entity ${entityId} is already a member of this group`);
      group.members.push({ entityId, label: label ?? null, notes: notes ?? null });
      await group.save();
      await Entity.findByIdAndUpdate(entityId, { $addToSet: { relationships: group._id } });
      const populated = await RelationshipGroup.findById(group._id)
        .populate({ path: 'members.entityId', select: 'title' });
      return { content: [{ type: 'text', text: JSON.stringify(populated, null, 2) }] };
    }
  );

  server.tool(
    'update_group_label',
    'Update or clear the label of a relationship group (e.g. rename "parentage" to "family", or null to remove it).',
    {
      groupId: z.string().describe('MongoDB ObjectId of the relationship group'),
      label:   z.string().nullable().describe('New group label, or null to clear it'),
    },
    async ({ groupId, label }) => {
      const group = await RelationshipGroup.findByIdAndUpdate(
        groupId, { label: label ?? null }, { new: true, runValidators: true }
      ).populate({ path: 'members.entityId', select: 'title' });
      if (!group) throw new Error(`Relationship group not found: ${groupId}`);
      return { content: [{ type: 'text', text: JSON.stringify(group, null, 2) }] };
    }
  );

  server.tool(
    'remove_relationship',
    "Remove an entity's membership from a relationship group. If fewer than 2 members remain, the group is deleted.",
    {
      groupId:  z.string().describe('MongoDB ObjectId of the relationship group'),
      entityId: z.string().describe('MongoDB ObjectId of the entity to remove'),
    },
    async ({ groupId, entityId }) => {
      const group = await RelationshipGroup.findById(groupId);
      if (!group) throw new Error(`Relationship group not found: ${groupId}`);
      group.members = group.members.filter(m => String(m.entityId) !== String(entityId));
      await Entity.updateOne({ _id: entityId }, { $pull: { relationships: group._id } });
      if (group.members.length < 2) {
        for (const m of group.members) {
          await Entity.updateOne({ _id: m.entityId }, { $pull: { relationships: group._id } });
        }
        await group.deleteOne();
        return { content: [{ type: 'text', text: 'Relationship removed and orphaned group deleted.' }] };
      }
      await group.save();
      return { content: [{ type: 'text', text: 'Relationship removed.' }] };
    }
  );

  server.tool(
    'update_relationship_label',
    "Update a member's label or notes within a relationship group.",
    {
      groupId:  z.string().describe('MongoDB ObjectId of the relationship group'),
      entityId: z.string().describe('MongoDB ObjectId of the entity to update'),
      label:    z.string().nullable().optional().describe('New label, or null to clear it'),
      notes:    z.string().nullable().optional().describe('New notes, or null to clear them'),
    },
    async ({ groupId, entityId, label, notes }) => {
      const group = await RelationshipGroup.findById(groupId);
      if (!group) throw new Error(`Relationship group not found: ${groupId}`);
      const member = group.members.find(m => String(m.entityId) === String(entityId));
      if (!member) throw new Error(`Member ${entityId} not found in group ${groupId}`);
      if (label !== undefined) member.label = label;
      if (notes !== undefined) member.notes = notes;
      await group.save();
      const populated = await RelationshipGroup.findById(group._id)
        .populate({ path: 'members.entityId', select: 'title' });
      return { content: [{ type: 'text', text: JSON.stringify(populated, null, 2) }] };
    }
  );

  server.tool(
    'add_subgroup_to_relationship',
    'Link an existing relationship group as a sub-group of another group. Members of the sub-group will inherit their labels from the most specific (deepest) shared group when viewed from any entity in that group.',
    {
      parentGroupId: z.string().describe('MongoDB ObjectId of the parent relationship group'),
      subGroupId:    z.string().describe('MongoDB ObjectId of the group to nest as a sub-group'),
    },
    async ({ parentGroupId, subGroupId }) => {
      const parent = await RelationshipGroup.findById(parentGroupId);
      if (!parent) throw new Error(`Parent group not found: ${parentGroupId}`);
      const child = await RelationshipGroup.findById(subGroupId);
      if (!child) throw new Error(`Sub-group not found: ${subGroupId}`);
      if (String(parent._id) === String(child._id)) throw new Error('A group cannot be its own sub-group');
      const alreadyLinked = parent.relationships.some(r => String(r.groupId) === String(subGroupId));
      if (alreadyLinked) throw new Error('Group is already a sub-group of this parent');
      parent.relationships.push({ groupId: subGroupId });
      await parent.save();
      const populated = await RelationshipGroup.findById(parent._id)
        .populate({ path: 'members.entityId', select: 'title' });
      return { content: [{ type: 'text', text: JSON.stringify(populated, null, 2) }] };
    }
  );

  server.tool(
    'remove_subgroup_from_relationship',
    'Unlink a sub-group from its parent relationship group. Any members of the sub-group who are not already direct members of the parent will be re-added to the parent automatically.',
    {
      parentGroupId: z.string().describe('MongoDB ObjectId of the parent relationship group'),
      subGroupId:    z.string().describe('MongoDB ObjectId of the sub-group to unlink'),
    },
    async ({ parentGroupId, subGroupId }) => {
      const parent = await RelationshipGroup.findById(parentGroupId);
      if (!parent) throw new Error(`Parent group not found: ${parentGroupId}`);
      const linked = parent.relationships.some(r => String(r.groupId) === String(subGroupId));
      if (!linked) throw new Error(`Group ${subGroupId} is not a sub-group of ${parentGroupId}`);
      parent.relationships = parent.relationships.filter(r => String(r.groupId) !== String(subGroupId));
      const subGroup = await RelationshipGroup.findById(subGroupId);
      const reAdded = [];
      if (subGroup) {
        for (const subMember of subGroup.members) {
          const alreadyInParent = parent.members.some(
            m => String(m.entityId) === String(subMember.entityId)
          );
          if (!alreadyInParent) {
            parent.members.push({ entityId: subMember.entityId, label: subMember.label, notes: subMember.notes });
            await Entity.updateOne({ _id: subMember.entityId }, { $addToSet: { relationships: parent._id } });
            reAdded.push(String(subMember.entityId));
          }
        }
      }
      await parent.save();
      const msg = reAdded.length
        ? `Sub-group unlinked. Re-added ${reAdded.length} member(s) to parent: ${reAdded.join(', ')}`
        : 'Sub-group unlinked. No members needed to be re-added.';
      return { content: [{ type: 'text', text: msg }] };
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
