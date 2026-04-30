import { Router } from 'express';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import Entity, { BLOCK_TYPES } from '../models/Entity.js';
import RelationshipGroup from '../models/RelationshipGroup.js';
import { resolveGroupLabels } from '../lib/relationshipResolver.js';
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
    'Retrieve a single wiki entity by its id, including all blocks and resolved relationship labels. ' +
    'Relationship labels in the response are already resolved using the sub-group label resolution system — ' +
    'use resolvedLabel on each member for the correct contextual label.',
    { id: z.string().describe('MongoDB ObjectId of the entity') },
    async ({ id }) => {
      const entity = await Entity.findById(id).populate('open_questions', 'question status').lean();
      if (!entity) throw new Error(`Entity not found: ${id}`);
      const rawGroups = await RelationshipGroup.find({
        members: { $elemMatch: { refId: id, refModel: 'Entity' } },
      }).lean();
      const relationships = await resolveGroupLabels(rawGroups, id);
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
    'Create a new open question and link it to one or more entities.',
    {
      question: z.string().describe('The unresolved question'),
      entry_ids: z.array(z.string()).describe('MongoDB ObjectIds of entities to link this question to'),
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
  //
  // RELATIONSHIP DATA MODEL
  // ─────────────────────────────────────────────────────────────────────────
  // Relationships are stored as RelationshipGroups — named groups of 2+ entities
  // where each member has a label (their role in the group) and optional notes.
  //
  // Groups can be nested: a sub-group is a more specific slice of a parent group.
  // When displaying co-members, the label from the MOST SPECIFIC shared group wins.
  // "Most specific" = deepest in the tree; tie-break = smallest group.
  // CRITICAL: both the viewer AND the co-member must be in a sub-group for that
  // sub-group's label to apply. Add every person to every group they belong to —
  // this feels redundant but is required for correct label resolution.
  //
  // BUILDING TIERED RELATIONSHIPS — the Elias family as a worked example:
  //
  // Target tree:
  //   Elias Family                          ← top-level group (all family members)
  //   ├── Eldan-Ruth Marriage               ← sub-group (only Eldan + Ruth)
  //   └── Elias Parentage                   ← sub-group (parents + all children)
  //       └── Elias Siblings                ← sub-group (children only)
  //           └── Elias Twins               ← sub-group (only the twin pair)
  //
  // Step 1 — Create every group in one add_relationship call each.
  //          Pass all members upfront; use add_member_to_relationship only
  //          if you discover additional members later.
  //
  //   add_relationship(groupLabel:"Elias Family", members:[
  //     {entityId:Eldan, label:"father"}, {entityId:Ruth,  label:"mother"},
  //     {entityId:Ethan, label:"son"},    {entityId:Naomi, label:"daughter"},
  //     {entityId:TwinA, label:"son"},    {entityId:TwinB, label:"son"} ])
  //
  //   add_relationship(groupLabel:"Eldan-Ruth Marriage", members:[
  //     {entityId:Eldan, label:"husband"}, {entityId:Ruth, label:"wife"} ])
  //
  //   add_relationship(groupLabel:"Elias Parentage", members:[
  //     {entityId:Eldan, label:"father"}, {entityId:Ruth,  label:"mother"},
  //     {entityId:Ethan, label:"son"},    {entityId:Naomi, label:"daughter"},
  //     {entityId:TwinA, label:"son"},    {entityId:TwinB, label:"son"} ])
  //
  //   add_relationship(groupLabel:"Elias Siblings", members:[
  //     {entityId:Ethan, label:"brother"}, {entityId:Naomi, label:"sister"},
  //     {entityId:TwinA, label:"brother"}, {entityId:TwinB, label:"brother"} ])
  //
  //   add_relationship(groupLabel:"Elias Twins", members:[
  //     {entityId:TwinA, label:"twin brother"}, {entityId:TwinB, label:"twin brother"} ])
  //
  // Step 2 — Link sub-groups (build bottom-up so each link is already valid):
  //   add_subgroup_to_relationship(siblingsGroupId, twinsGroupId)      // twins ⊂ siblings
  //   add_subgroup_to_relationship(parentageGroupId, siblingsGroupId)  // siblings ⊂ parentage
  //   add_subgroup_to_relationship(familyGroupId, parentageGroupId)    // parentage ⊂ family
  //   add_subgroup_to_relationship(familyGroupId, marriageGroupId)     // marriage ⊂ family
  //
  // How label resolution plays out when any member views "Elias Family":
  //   • Ethan viewing Naomi  → siblings (depth 2 via parentage) → "sister" ✓
  //   • Ethan viewing TwinA  → twins (depth 3) → "twin brother" ✓
  //   • Ethan viewing Eldan  → marriage doesn't apply (Ethan isn't in it);
  //                            parentage (depth 1) → "father" ✓
  //   • Eldan viewing Ruth   → both in marriage (depth 1, 2 members) AND parentage
  //                            (depth 1, larger); marriage wins the tie by being
  //                            smaller → "wife" ✓
  //   • Eldan viewing Ethan  → siblings doesn't apply (Eldan isn't in it);
  //                            parentage (depth 1) → "son" ✓
  // ─────────────────────────────────────────────────────────────────────────

  server.tool(
    'add_relationship',
    'Create a relationship group with all its members in one call. This is the ONLY way to link entities — never use blocks for this. ' +
    'Pass every member upfront in the members array (minimum 2). Each member needs an entityId and a role label. ' +
    'Be specific with labels: use "brother"/"sister" not "sibling", "twin brother" not "twin". ' +
    'groupLabel names the group itself (e.g. "Elias Family"). ' +
    'For tiered families (where siblings should show as "brother"/"sister" rather than "son"/"daughter"), follow the BUILDING TIERED RELATIONSHIPS guide in the relationship tools section. ' +
    'Returns the created group with its _id — save it for add_member_to_relationship and add_subgroup_to_relationship calls.',
    {
      groupLabel: z.string().optional().describe('Name for the relationship group, e.g. "Elias Family"'),
      members: z.array(z.object({
        entityId: z.string().describe('MongoDB ObjectId of the entity'),
        label:    z.string().optional().describe('Role label, e.g. "father", "sister", "twin brother"'),
        notes:    z.string().optional().describe('Optional notes on this membership'),
      })).min(2).describe('All members of the group. Minimum 2.'),
    },
    async ({ groupLabel, members }) => {
      const group = await RelationshipGroup.create({
        label: groupLabel ?? null,
        members: members.map(m => ({ refId: m.entityId, refModel: 'Entity', label: m.label ?? null, notes: m.notes ?? null })),
      });
      await Entity.updateMany(
        { _id: { $in: members.map(m => m.entityId) } },
        { $addToSet: { relationships: group._id } }
      );
      return { content: [{ type: 'text', text: JSON.stringify(group, null, 2) }] };
    }
  );

  server.tool(
    'add_member_to_relationship',
    'Add one or more members to an existing relationship group in a single call. ' +
    'Use this when you have additional members to add after the group was created, or when adding the same person to multiple groups as part of building a tiered structure. ' +
    'Labels must be specific to each person\'s gender and role (e.g. "brother" or "sister", not "sibling"; "twin brother" not "twin"). ' +
    'When building tiered relationships, add the same person to BOTH the broad group and the narrow sub-group — each with the label appropriate to that group\'s level of specificity.',
    {
      groupId: z.string().describe('MongoDB ObjectId of the relationship group'),
      members: z.array(z.object({
        entityId: z.string().describe('MongoDB ObjectId of the entity to add'),
        label:    z.string().optional().describe('Role label for this entity, e.g. "daughter", "brother"'),
        notes:    z.string().optional().describe('Optional notes on this membership'),
      })).min(1).describe('One or more members to add. All must be new to this group.'),
    },
    async ({ groupId, members }) => {
      const group = await RelationshipGroup.findById(groupId);
      if (!group) throw new Error(`Relationship group not found: ${groupId}`);
      const existingIds = new Set(
        group.members.filter(m => m.refModel === 'Entity').map(m => String(m.refId))
      );
      const duplicates = members.filter(m => existingIds.has(String(m.entityId)));
      if (duplicates.length) {
        throw new Error(`Already a member of this group: ${duplicates.map(m => m.entityId).join(', ')}`);
      }
      for (const m of members) {
        group.members.push({ refId: m.entityId, refModel: 'Entity', label: m.label ?? null, notes: m.notes ?? null });
      }
      await group.save();
      await Entity.updateMany(
        { _id: { $in: members.map(m => m.entityId) } },
        { $addToSet: { relationships: group._id } }
      );
      return { content: [{ type: 'text', text: JSON.stringify(group, null, 2) }] };
    }
  );

  server.tool(
    'update_group_label',
    'Rename or clear the label of a relationship group (e.g. rename "parentage" to "Elias Family", or pass null to remove the label).',
    {
      groupId: z.string().describe('MongoDB ObjectId of the relationship group'),
      label:   z.string().nullable().describe('New group label, or null to clear it'),
    },
    async ({ groupId, label }) => {
      const group = await RelationshipGroup.findByIdAndUpdate(
        groupId, { label: label ?? null }, { new: true, runValidators: true }
      );
      if (!group) throw new Error(`Relationship group not found: ${groupId}`);
      return { content: [{ type: 'text', text: JSON.stringify(group, null, 2) }] };
    }
  );

  server.tool(
    'remove_relationship',
    "Remove an entity's membership from a relationship group. If the group drops below 2 members it is automatically deleted. " +
    "Does NOT remove the entity from any sub-groups — use remove_subgroup_from_relationship first if you are dismantling a tiered structure.",
    {
      groupId:  z.string().describe('MongoDB ObjectId of the relationship group'),
      entityId: z.string().describe('MongoDB ObjectId of the entity to remove'),
    },
    async ({ groupId, entityId }) => {
      const group = await RelationshipGroup.findById(groupId);
      if (!group) throw new Error(`Relationship group not found: ${groupId}`);
      group.members = group.members.filter(
        m => !(m.refModel === 'Entity' && String(m.refId) === String(entityId))
      );
      await Entity.updateOne({ _id: entityId }, { $pull: { relationships: group._id } });
      const entityMembers = group.members.filter(m => m.refModel === 'Entity');
      if (entityMembers.length < 2) {
        for (const m of entityMembers) {
          await Entity.updateOne({ _id: m.refId }, { $pull: { relationships: group._id } });
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
    "Update a specific member's label or notes within a relationship group. " +
    "Use this to correct a label after creation (e.g. change 'son' to 'adopted son'). " +
    "Remember: when sub-groups are in play, the displayed label uses the most specific shared group — " +
    "updating a label in the parent group may have no visible effect if a sub-group label takes precedence.",
    {
      groupId:  z.string().describe('MongoDB ObjectId of the relationship group'),
      entityId: z.string().describe('MongoDB ObjectId of the entity whose label to update'),
      label:    z.string().nullable().optional().describe('New label, or null to clear it'),
      notes:    z.string().nullable().optional().describe('New notes, or null to clear them'),
    },
    async ({ groupId, entityId, label, notes }) => {
      const group = await RelationshipGroup.findById(groupId);
      if (!group) throw new Error(`Relationship group not found: ${groupId}`);
      const member = group.members.find(
        m => m.refModel === 'Entity' && String(m.refId) === String(entityId)
      );
      if (!member) throw new Error(`Member ${entityId} not found in group ${groupId}`);
      if (label !== undefined) member.label = label;
      if (notes !== undefined) member.notes = notes;
      await group.save();
      return { content: [{ type: 'text', text: JSON.stringify(group, null, 2) }] };
    }
  );

  server.tool(
    'add_subgroup_to_relationship',
    'Link an existing relationship group as a sub-group of a broader group, enabling context-correct label display. ' +
    'When viewing a co-member, the label comes from the most specific (deepest) group that contains BOTH the viewer and that co-member. ' +
    'Sub-groups are more specific than their parent, so their labels take precedence. ' +
    '\n\nOptional linkLabel: if provided, the sub-group is shown as a collapsed reference row in the parent ' +
    '(e.g. linkLabel "Inhabitant" on an "Elias Family" sub-group shows "Inhabitant: Elias Family" in the parent view, ' +
    'and individual family members are NOT shown as direct co-members of the parent). ' +
    'If omitted, the sub-group is hidden from the top-level view and its members merge into the parent for display.' +
    '\n\nEXAMPLE — the Elias family tree (build all groups first, then link bottom-up):\n' +
    '  add_subgroup_to_relationship(siblingsGroupId, twinsGroupId)      // twins ⊂ siblings\n' +
    '  add_subgroup_to_relationship(parentageGroupId, siblingsGroupId)  // siblings ⊂ parentage\n' +
    '  add_subgroup_to_relationship(familyGroupId, parentageGroupId)    // parentage ⊂ family\n' +
    '  add_subgroup_to_relationship(familyGroupId, marriageGroupId)     // marriage ⊂ family\n' +
    '  → Ethan viewing Naomi in the family group shows "sister" (from siblings, depth 2)\n' +
    '    not "daughter" (from family/parentage, depth 0-1). TwinA viewing TwinB shows\n' +
    '    "twin brother" (from twins, depth 3).\n' +
    '\nKEY REQUIREMENT: members must be in BOTH the parent group and the sub-group. ' +
    'If a member is only in the sub-group they will not appear in the parent group view at all.',
    {
      parentGroupId: z.string().describe('MongoDB ObjectId of the broader/parent group'),
      subGroupId:    z.string().describe('MongoDB ObjectId of the narrower group to nest inside the parent'),
      linkLabel:     z.string().optional().describe(
        'Optional label for this sub-group link (e.g. "Inhabitant"). ' +
        'If set, the sub-group appears as a collapsed reference row in the parent view and its members are excluded from the parent\'s direct member list. ' +
        'If omitted, the sub-group is hidden from top-level and its members merge into the parent display.'
      ),
    },
    async ({ parentGroupId, subGroupId, linkLabel }) => {
      const parent = await RelationshipGroup.findById(parentGroupId);
      if (!parent) throw new Error(`Parent group not found: ${parentGroupId}`);
      const child = await RelationshipGroup.findById(subGroupId);
      if (!child) throw new Error(`Sub-group not found: ${subGroupId}`);
      if (String(parent._id) === String(child._id)) throw new Error('A group cannot be its own sub-group');
      const alreadyLinked = parent.members.some(
        m => m.refModel === 'RelationshipGroup' && String(m.refId) === String(subGroupId)
      );
      if (alreadyLinked) throw new Error('Group is already a sub-group of this parent');
      parent.members.push({ refId: subGroupId, refModel: 'RelationshipGroup', label: linkLabel ?? null, notes: null });
      await parent.save();
      return { content: [{ type: 'text', text: JSON.stringify(parent, null, 2) }] };
    }
  );

  server.tool(
    'remove_subgroup_from_relationship',
    'Unlink a sub-group from its parent relationship group. ' +
    'Any members of the sub-group who are not already direct members of the parent group will be automatically re-added to the parent (using the label they had in the sub-group) so no one disappears from the parent view.',
    {
      parentGroupId: z.string().describe('MongoDB ObjectId of the parent relationship group'),
      subGroupId:    z.string().describe('MongoDB ObjectId of the sub-group to unlink'),
    },
    async ({ parentGroupId, subGroupId }) => {
      const parent = await RelationshipGroup.findById(parentGroupId);
      if (!parent) throw new Error(`Parent group not found: ${parentGroupId}`);
      const linked = parent.members.some(
        m => m.refModel === 'RelationshipGroup' && String(m.refId) === String(subGroupId)
      );
      if (!linked) throw new Error(`Group ${subGroupId} is not a sub-group of ${parentGroupId}`);
      parent.members = parent.members.filter(
        m => !(m.refModel === 'RelationshipGroup' && String(m.refId) === String(subGroupId))
      );
      const subGroup = await RelationshipGroup.findById(subGroupId);
      const reAdded = [];
      if (subGroup) {
        const existingEntityIds = new Set(
          parent.members.filter(m => m.refModel === 'Entity').map(m => String(m.refId))
        );
        for (const subMember of subGroup.members.filter(m => m.refModel === 'Entity')) {
          if (!existingEntityIds.has(String(subMember.refId))) {
            parent.members.push({ refId: subMember.refId, refModel: 'Entity', label: subMember.label, notes: subMember.notes });
            await Entity.updateOne({ _id: subMember.refId }, { $addToSet: { relationships: parent._id } });
            reAdded.push(String(subMember.refId));
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
