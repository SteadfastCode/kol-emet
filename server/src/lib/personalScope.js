/**
 * The filter for a caller's *own* rows inside one workspace.
 *
 * Two models hold data that belongs to a user rather than to the graph —
 * `Conversation` (a saved chat) and `UserMemory` (a fact remembered about the
 * user) — and both are produced and consumed by the assistant, which answers
 * out of exactly one workspace. Until KOL-091 they were filtered on `userId`
 * alone: `GET /conversations` listed every chat the user had ever had, from any
 * workspace, and `loadMemories` put every fact ever extracted into the system
 * prompt. Nothing showed, because every user had one workspace; KOL-090's
 * switcher is what made two of them ordinary.
 *
 * So the pair travels together. One call returns **both** halves of the filter,
 * rather than a workspace clause a caller has to remember to spread next to
 * their own `userId`, because the forgotten half is the whole bug.
 *
 * ─── Rows written before this: `workspaceId: null` ───────────────────────────
 * A chat or a memory stored before KOL-091 carries no workspace (`null`, or the
 * field missing entirely for one older than the column). **A null reads as the
 * caller's current workspace**: it matches wherever they are acting, so nobody
 * loses their history, and a user with two workspaces sees their pre-switch
 * chats from either one. The alternative was a migration, and a migration would
 * have to *guess* which workspace a row meant — there is nothing in the row to
 * guess from, and guessing wrong hides a chat rather than duplicating it. See
 * the Decision Log entry for KOL-091 in kol_emet_spec.md.
 *
 * `$in: [workspaceId, null]` and not `$or`, for two reasons: it composes with a
 * caller's other clauses (an `$or` would collide with theirs), and in MongoDB
 * `$in: [null]` matches a field that is null *and* one that is absent, which is
 * what the oldest rows look like.
 *
 * This is not a weakening of tenancy. Both halves are required, so another
 * user's row is unreachable whatever workspace they share; what a null relaxes
 * is only *which of the caller's own workspaces* one of their own rows appears
 * in. New writes always carry a workspace, so the set of null rows only shrinks.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId the acting user
 * @param {string|import('mongoose').Types.ObjectId} workspaceId req.workspaceId
 * @returns {{ userId: unknown, workspaceId: { $in: unknown[] } }}
 */
export function personalScope(userId, workspaceId) {
  return { userId, workspaceId: { $in: [workspaceId, null] } };
}

export default personalScope;
