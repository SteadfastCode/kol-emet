import RelationshipGroup from '../models/RelationshipGroup.js';
import { broadcast } from './broadcaster.js';

/**
 * The live-sync frames for `RelationshipGroup` writes (KOL-149).
 *
 * Entity writes get their frames for free: every one of them goes through
 * `lib/changeLogger.js`, which writes the audit row *and* broadcasts
 * `entity:created` / `entity:updated` / `entity:deleted` from the same call.
 * This collection has no ChangeLog either, so — exactly as KOL-116 found for
 * `/open-questions` — there was nothing to inherit and `/relationship-groups`
 * broadcast nothing at all from any of its nine write routes, while the browser
 * has echoed `X-SSE-Client-Id` on every one of them since KOL-104
 * (`client/src/api/relationshipGroups.js`): the header was inert because no
 * frame ever carried an exclusion.
 *
 * What the other viewer saw: `RelationshipsSection.vue` refetches only the tab
 * that wrote, and `GraphView.vue` built its nodes and edges once on mount, so a
 * group created, relabelled, reordered or deleted elsewhere left every other tab
 * drawing edges that no longer exist — the one view whose entire content is
 * relationships was the one view that never updated.
 *
 * So this module is `lib/questionEvents.js` one collection over: the
 * changeLogger's equivalent minus the audit row (a `ChangeLog` trail and a
 * rollback for relationship writes needs a `changeType` vocabulary the model
 * does not have and is its own item). Three frames mirroring the entity
 * vocabulary:
 *
 *   `group:created`  `{ group, entityIds }`
 *   `group:updated`  `{ group, entityIds }`
 *   `group:deleted`  `{ groupId, group, entityIds }`
 *
 * `group` is the row as a panel renders it (`_id`, `label`, and `members` with
 * each member's populated `ref`), and `entityIds` is **always plain string
 * ids** — the flattened set of entity members reachable through the group,
 * nested subgroups included. Those ids are the whole point of the payload: they
 * are what lets a listening tab decide whether the entity it is showing is
 * affected without a refetch, and they are flat strings for the reason KOL-116
 * gives for `entry_ids` — a listener that had to branch on which of the nine
 * writes a frame came from would be reading the server's internals.
 *
 * **One `group:updated` for every write that changes a group's own row** —
 * membership, order, a member's label, the group's label, a subgroup link — so
 * there is one vocabulary and not nine. A listener cannot patch a relationship
 * graph from a diff anyway: an edge is a pair drawn from the whole member set,
 * and a subgroup moves edges between entities the frame never names.
 *
 * Every emit is workspace-scoped through `broadcast`, which delivers to nobody
 * rather than everybody when a caller forgets (`lib/broadcaster.js`), and
 * excludes the writing client by the id it echoed back.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * RELATIONSHIP_SSE_LOG_LEVEL = off | light | normal | verbose (default light)
 * A frame that is never sent and a frame sent to nobody are indistinguishable
 * from the other tab, which just goes on showing a stale edge — so the light
 * tier's job is that the server can always say which write asked for which
 * frame and which client was left out of it. (`SSE_LOG_LEVEL` covers the
 * fan-out itself: how many sockets it reached. This covers the decision to
 * send.)
 *   off     — nothing
 *   light   — every frame: its name, the group id, the workspace, the client id
 *             excluded from it, and the write that asked for it; plus every
 *             frame that could not be built, and every subgroup walk that
 *             stopped at the depth bound
 *   normal  — light, plus the `entityIds` the frame carried, which is what
 *             decides whether a listening tab refreshes
 *   verbose — normal, plus the row as it goes on the wire
 */

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.RELATIONSHIP_SSE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[relationshipGroups/sse:${level}] ${msg}`);
}

/**
 * How deep the subgroup walk goes before it gives up and says so.
 *
 * Nesting is unbounded in the model and the walk already refuses to visit a
 * group twice, so this is not the cycle guard — it is the bound on how much
 * work one write may put on the single event loop every tenant shares. A
 * relationship tree deeper than this is a product question, not a frame's.
 */
export const MAX_SUBGROUP_DEPTH = 10;

/** `refId`, whichever shape the caller holds: an ObjectId, or a populated row. */
const refIdOf = (member) => String(member?.refId?._id ?? member?.refId);

/** The ids of one group's members of a given `refModel`, as plain strings. */
function memberIds(group, refModel) {
  return (group?.members ?? [])
    .filter((m) => m.refModel === refModel)
    .map(refIdOf);
}

/**
 * The row a frame carries: the fields a panel and the graph render, with every
 * id a plain string.
 *
 * `ref` is passed through when the caller populated it (`populateMembers` in
 * `routes/relationshipGroups.js`, which is what the route's own responses carry)
 * and omitted when it did not, rather than invented here — a member with a
 * `ref` of `undefined` would read as a deleted entity.
 */
export function groupRow(group) {
  return {
    _id: String(group._id),
    label: group.label ?? null,
    members: (group.members ?? []).map((m) => {
      const member = {
        refId: refIdOf(m),
        refModel: m.refModel,
        label: m.label ?? null,
        notes: m.notes ?? null,
      };
      if (m.ref) {
        member.ref = m.refModel === 'Entity'
          ? { _id: String(m.ref._id), title: m.ref.title ?? null }
          : { _id: String(m.ref._id), label: m.ref.label ?? null };
      }
      return member;
    }),
  };
}

/**
 * Every entity reachable through `group`, as plain string ids: its own entity
 * members, plus the entity members of every group nested under it.
 *
 * A subgroup is a *reference* — the parent's `members` holds its id and nothing
 * else — so the entities it contributes are not in the document the route has
 * in hand, and they are exactly the entities whose panels and edges a write to
 * the parent changes. Hence the walk, which is:
 *
 *   **workspace-scoped**, so a subgroup pointing outside the workspace
 *   contributes nothing rather than leaking another tenant's entity ids into a
 *   frame (the same rule `populateMembers` follows for titles);
 *
 *   **breadth-first in one query per level**, so the common case — a group with
 *   no subgroups at all — costs no query, and a nested one costs its depth
 *   rather than its size;
 *
 *   **cycle-guarded** by the set of groups already visited, because the model
 *   permits A → B → A (the route refuses only a group as its own direct
 *   subgroup), and bounded by `MAX_SUBGROUP_DEPTH` besides.
 */
export async function flattenEntityIds(group, workspaceId) {
  const reached = new Set(memberIds(group, 'Entity'));
  const visited = new Set([String(group._id)]);
  let frontier = memberIds(group, 'RelationshipGroup');

  for (let depth = 1; frontier.length; depth += 1) {
    const next = frontier.filter((id) => !visited.has(id));
    if (!next.length) break;
    if (depth > MAX_SUBGROUP_DEPTH) {
      log('light', `subgroup walk stopped at depth ${MAX_SUBGROUP_DEPTH} with ${next.length} group(s) unvisited (source: group ${group._id}); entityIds is short`);
      break;
    }
    for (const id of next) visited.add(id);

    const rows = await RelationshipGroup
      .find({ _id: { $in: next }, workspaceId })
      .select('members')
      .lean();

    frontier = [];
    for (const row of rows) {
      for (const id of memberIds(row, 'Entity')) reached.add(id);
      frontier.push(...memberIds(row, 'RelationshipGroup'));
    }
  }

  return [...reached];
}

/**
 * Builds one frame and puts it on the workspace's streams.
 *
 * Nothing here can fail the write that asked for it: the write has already
 * happened and the response is its own, so a flatten that could not read the
 * database is a missing live update reported at the light tier, never a 500 on
 * a request that succeeded.
 *
 * @param {string} name  the frame name
 * @param {object} group the group the frame is about (populated, when the
 *   caller has a populated copy)
 * @param {object} opts
 * @param {any}    opts.workspaceId  required; see `broadcast`
 * @param {string|null} [opts.excludeClientId]  the writer's own tab, which has the response
 * @param {string} opts.source  the write that asked for this frame, for the log
 * @param {Array<any>} [opts.alsoTouched]  entity ids the write changed that the
 *   group no longer reaches — a member it just removed, whose panel is as
 *   affected as the ones that stayed and which `flattenEntityIds` cannot know
 *   about, since it reads the row as it is now
 * @param {object} [extraPayload]  fields that lead the payload (`groupId`)
 */
async function emit(name, group, { workspaceId, excludeClientId = null, source, alsoTouched = [] }, extraPayload = {}) {
  let payload;
  try {
    const reached = await flattenEntityIds(group, workspaceId);
    const entityIds = [...new Set([...reached, ...alsoTouched.map((id) => String(id?._id ?? id))])];
    payload = { ...extraPayload, group: groupRow(group), entityIds };
  } catch (err) {
    log('light', `no ${name} frame for group ${group?._id} — it could not be built (source: ${source}: ${err.message}); another tab will go on showing a stale edge`);
    return;
  }

  broadcast(name, payload, { workspaceId, excludeClientId });
  log('light', `${name} ${payload.group._id} → workspace ${workspaceId}${excludeClientId ? `, excluding client ${excludeClientId}` : ' (no client excluded)'} (source: ${source})`);
  log('normal', `  entityIds: ${payload.entityIds.length ? payload.entityIds.join(', ') : '(none)'}`);
  log('verbose', `  row: ${JSON.stringify(payload.group)}`);
}

export function broadcastGroupCreated(group, opts) {
  return emit('group:created', group, opts);
}

/**
 * One frame for every write that changes a group's own row. See the header: the
 * nine writes share this name on purpose.
 */
export function broadcastGroupUpdated(group, opts) {
  return emit('group:updated', group, opts);
}

/**
 * The deleted group, mirroring `entity:deleted` and `question:deleted`: the id
 * at the top level, because that is all a listener needs to drop its edges, and
 * the row behind it so a toast can name what is gone. `entityIds` is the set it
 * held when it was deleted — the entities whose panels and edges just changed,
 * which is what a listener refreshes from.
 */
export function broadcastGroupDeleted(group, opts) {
  return emit('group:deleted', group, opts, { groupId: String(group._id) });
}
