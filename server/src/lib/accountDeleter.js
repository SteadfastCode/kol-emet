/**
 * Account deletion: a hard delete of a user and everything their tenancy holds.
 *
 * Daniel decided 2026-09-05 that deleting an account hard-deletes, drafts
 * included. `Draft` is otherwise permanent — it is the training corpus, and
 * DELETE /drafts/:id is a soft discard — so this is the only code path that
 * removes one. There is no route yet: DELETE /auth/account, its confirmation
 * UI and the signup disclosure copy are a separate follow-up.
 *
 * What goes:
 *   - every Workspace the user SOLELY owns — they are its ownerId and no other
 *     member holds the owner role — even if editors or viewers share it;
 *   - every document in those workspaces, in every model that carries
 *     workspaceId (WORKSPACE_SCOPED_MODELS; the test fails if a model with a
 *     workspaceId path is missing from the list);
 *   - the user's data that is keyed by user rather than workspace: UserMemory,
 *     and Conversation by userId, which also catches pre-tenancy chats still
 *     carrying workspaceId: null;
 *   - Settings.mcpUserId, if the MCP connector was authorized as this user;
 *   - the User, last.
 *
 * What refuses: membership of any workspace the user does not solely own, as
 * editor, viewer or co-owner. Deleting would leave that workspace pointing at a
 * user who no longer exists, and whether their content there stays, goes or
 * changes hands is a product decision nobody has made yet. A refusal deletes
 * nothing and reports the memberships, so a caller can show them.
 *
 * Not transactional: transactions need a replica set, the test mongod is a
 * standalone server, and an Atlas-only code path would ship untested. Order
 * carries the guarantee instead — content, then workspaces, then the user — so
 * a failure part-way leaves the user and their workspaces in place and a re-run
 * finishes the job. Content is swept a second time once the workspaces are
 * gone, which catches a write from a request that resolved the workspace while
 * the first pass was running.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * ACCOUNT_DELETE_LOG_LEVEL = off | light | normal | verbose (default light)
 * Deletion is irreversible and nobody watches it happen, so the default tier
 * leaves an audit trail. Lines carry ids, never the email: logs outlive the
 * account, and a hard delete that left the address in them would not be one.
 *   off     — nothing
 *   light   — per call: who asked (the caller's `source`), the outcome and the
 *             totals, plus anything the second sweep had to catch
 *   normal  — light, plus per-model counts for each pass
 *   verbose — normal, plus the workspace ids and every blocking membership
 */

import mongoose from 'mongoose';

import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import UserMemory from '../models/UserMemory.js';
import Settings from '../models/Settings.js';
import Entity from '../models/Entity.js';
import RelationshipGroup from '../models/RelationshipGroup.js';
import RelationshipType from '../models/RelationshipType.js';
import OpenQuestion from '../models/OpenQuestion.js';
import Draft from '../models/Draft.js';
import Conversation from '../models/Conversation.js';
import ChangeLog from '../models/ChangeLog.js';

/** Every model whose documents carry workspaceId. A new one must be added here. */
export const WORKSPACE_SCOPED_MODELS = [
  Entity,
  RelationshipGroup,
  RelationshipType,
  OpenQuestion,
  Draft,
  Conversation,
  ChangeLog,
];

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.ACCOUNT_DELETE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[accountDeleter:${level}] ${msg}`);
}

function isSolelyOwnedBy(workspace, userId) {
  if (String(workspace.ownerId) !== userId) return false;
  return workspace.members.every((m) => m.role !== 'owner' || String(m.userId) === userId);
}

function roleIn(workspace, userId) {
  // A workspace can match on ownerId alone, with no member row for the user.
  return workspace.members.find((m) => String(m.userId) === userId)?.role ?? 'owner';
}

/** One deleteMany per scoped model; adds to `deleted` and returns the pass total. */
async function deleteScopedContent(workspaceIds, deleted, pass) {
  let total = 0;
  for (const model of WORKSPACE_SCOPED_MODELS) {
    const { deletedCount } = await model.deleteMany({ workspaceId: { $in: workspaceIds } });
    deleted[model.modelName] = (deleted[model.modelName] ?? 0) + deletedCount;
    total += deletedCount;
    log('normal', `${pass} pass: ${model.modelName} -${deletedCount}`);
  }
  return total;
}

/**
 * Hard-deletes an account. See the module comment for what goes and why.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {{ source?: string }} [opts] — who is asking, for the audit line
 *   (e.g. 'DELETE /auth/account').
 * @returns {Promise<
 *   | { ok: true, workspaceIds: string[], deleted: Record<string, number>, mcpUserCleared: boolean }
 *   | { ok: false, reason: 'user-not-found' }
 *   | { ok: false, reason: 'member-elsewhere', memberships: { workspaceId: string, name: string, role: string }[] }
 * >}
 */
export async function deleteAccount(userId, { source = 'unspecified caller' } = {}) {
  const id = String(userId);
  log('light', `deleteAccount(${id}) requested by ${source}`);

  if (!mongoose.isValidObjectId(id) || !(await User.exists({ _id: id }))) {
    log('light', `deleteAccount(${id}) refused: user-not-found; nothing deleted (source: ${source})`);
    return { ok: false, reason: 'user-not-found' };
  }

  const workspaces = await Workspace.find({ $or: [{ ownerId: id }, { 'members.userId': id }] })
    .select('_id name ownerId members')
    .lean();

  const blocking = workspaces.filter((w) => !isSolelyOwnedBy(w, id));
  if (blocking.length) {
    const memberships = blocking.map((w) => ({ workspaceId: String(w._id), name: w.name, role: roleIn(w, id) }));
    log('light', `deleteAccount(${id}) refused: member-elsewhere, ${memberships.length} workspace(s) not solely owned; nothing deleted (source: ${source})`);
    for (const m of memberships) log('verbose', `  blocking membership: workspace ${m.workspaceId} as ${m.role}`);
    return { ok: false, reason: 'member-elsewhere', memberships };
  }

  const workspaceIds = workspaces.map((w) => w._id);
  log('verbose', `solely-owned workspaces: ${workspaceIds.join(', ') || '(none)'}`);
  const deleted = {};

  await deleteScopedContent(workspaceIds, deleted, 'content');
  // ownerId re-checked so a workspace that changed hands since the read survives.
  deleted.Workspace = (await Workspace.deleteMany({ _id: { $in: workspaceIds }, ownerId: id })).deletedCount;
  const swept = await deleteScopedContent(workspaceIds, deleted, 'sweep');
  if (swept) log('light', `deleteAccount(${id}): sweep removed ${swept} document(s) written during deletion (source: ${source})`);

  deleted.UserMemory = (await UserMemory.deleteMany({ userId: id })).deletedCount;
  deleted.Conversation += (await Conversation.deleteMany({ userId: id })).deletedCount;
  const mcpUserCleared = (
    await Settings.updateOne({ _id: 'global', mcpUserId: id }, { $set: { mcpUserId: null } })
  ).modifiedCount > 0;
  deleted.User = (await User.deleteOne({ _id: id })).deletedCount;

  const total = Object.values(deleted).reduce((sum, n) => sum + n, 0);
  log('light', `deleteAccount(${id}) done: ${total} document(s) across ${workspaceIds.length} workspace(s)${mcpUserCleared ? ', MCP connector user cleared' : ''} (source: ${source})`);
  log('normal', `  per model: ${JSON.stringify(deleted)}`);
  return { ok: true, workspaceIds: workspaceIds.map(String), deleted, mcpUserCleared };
}
