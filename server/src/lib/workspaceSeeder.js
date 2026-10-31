/**
 * Bringing a workspace into being: the `Workspace` document, and the starting
 * content it is seeded with.
 *
 * `createWorkspace()` at the foot of this file is the pair both callers use —
 * `POST /auth/register` and `POST /workspaces` (KOL-123). Everything above it
 * is the seeding half, which is also run on its own by
 * `scripts/seed-entity-types.js`.
 *
 * Seeding runs at registration, on a path where partial success is worse than none:
 * a workspace with relationship types but no starter entities is a confusing
 * half-state. Each stage is therefore independently guarded and the whole
 * thing is best-effort — a seeding failure must never block account creation,
 * since the user can create their own content regardless.
 */

import EntityType from '../models/EntityType.js';
import Workspace from '../models/Workspace.js';
import RelationshipType from '../models/RelationshipType.js';
import RelationshipGroup from '../models/RelationshipGroup.js';
import OpenQuestion from '../models/OpenQuestion.js';
import Entity from '../models/Entity.js';
import { getTemplate, hasTemplate, DEFAULT_TEMPLATE } from '../config/templates.js';
import { workspaceLog } from '../middleware/workspace.js';

// off | light | normal — seeding runs unattended at registration, so the
// default tier records enough to tell a seeded workspace from a bare one.
const LEVELS = { off: 0, light: 1, normal: 2 };
function log(level, msg) {
  const active = LEVELS[process.env.SEED_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[workspaceSeeder:${level}] ${msg}`);
}

/**
 * The template key `requested` actually seeds: itself when it names one, else
 * the default — getTemplate's fallback, named rather than left implicit.
 *
 * Exported because registration now *stores* the key on the workspace
 * (`Workspace.template`, read by the assistant's system prompt — KOL-105), and
 * what is stored has to be the key that was seeded. Deriving it there with a
 * second `hasTemplate(...) ? ... : DEFAULT_TEMPLATE` is how the two would
 * eventually disagree about what an unknown key means.
 *
 * @param {unknown} requested straight from a request body
 * @returns {string} a key of TEMPLATES
 */
export function resolveTemplateKey(requested) {
  return hasTemplate(requested) ? requested : DEFAULT_TEMPLATE;
}

/**
 * The same resolution, worded for a log line so a fallback is visible rather
 * than silent. `requested` comes straight from a request body, so it is
 * clipped rather than logged whole.
 */
function describeTemplate(requested) {
  return hasTemplate(requested)
    ? `template "${requested}"`
    : `template "${resolveTemplateKey(requested)}" (requested ${String(JSON.stringify(requested)).slice(0, 80)}, which is not a template)`;
}

/**
 * Inserts the template's entity types the workspace does not already have
 * (exact name, case-insensitive) and returns the names it added — or, with
 * `apply: false`, the names it would add. Separate from seedWorkspace because
 * scripts/seed-entity-types.js runs it over workspaces that predate the
 * registry, where a re-run must never duplicate a type.
 *
 * @returns {Promise<string[]>}
 */
export async function seedEntityTypes(workspaceId, templateKey = DEFAULT_TEMPLATE, { apply = true } = {}) {
  const wanted = getTemplate(templateKey).entityTypes ?? [];
  const have = new Set(
    (await EntityType.find({ workspaceId }).select('name').lean()).map(t => t.name.toLowerCase())
  );
  const missing = wanted.filter(t => !have.has(t.name.toLowerCase()));

  if (apply && missing.length) await EntityType.insertMany(missing.map(t => ({ ...t, workspaceId })));
  log('normal', `${apply ? 'added' : 'would add'} ${missing.length} entity type(s) to workspace ${workspaceId} (source: ${describeTemplate(templateKey)}): ${missing.map(t => t.name).join(', ') || '(none)'}`);
  return missing.map(t => t.name);
}

/**
 * @returns {Promise<{ok: boolean, counts: object, error?: string}>}
 */
export async function seedWorkspace(workspaceId, templateKey = DEFAULT_TEMPLATE) {
  const template = getTemplate(templateKey);
  const counts = { entityTypes: 0, relationshipTypes: 0, entities: 0, relationshipGroups: 0, openQuestions: 0 };

  try {
    log('light', `seeding workspace ${workspaceId} from ${describeTemplate(templateKey)}`);

    // ── Entity types ─────────────────────────────────────────────────────────
    // The registry behind the category pills. First, because the relationship
    // types and starter entities below are checked against it on insert.
    counts.entityTypes = (await seedEntityTypes(workspaceId, templateKey)).length;

    // ── Relationship types ───────────────────────────────────────────────────
    // These matter most: without them the relationship picker is empty and the
    // core feature of the product looks broken on first use.
    if (template.relationshipTypes?.length) {
      const docs = template.relationshipTypes.map(t => ({ ...t, workspaceId }));
      const created = await RelationshipType.insertMany(docs);
      counts.relationshipTypes = created.length;
    }

    // ── Starter entities ─────────────────────────────────────────────────────
    const idsByKey = new Map();
    if (template.starterEntities?.length) {
      for (const { key, ...data } of template.starterEntities) {
        const entity = await Entity.create({ ...data, workspaceId });
        idsByKey.set(key, entity._id);
        counts.entities++;
      }
    }

    // ── Starter relationship group ───────────────────────────────────────────
    // Skipped rather than half-built if any member entity is missing, so the
    // graph never contains a group pointing at nothing.
    const rel = template.starterRelationship;
    if (rel && rel.members.every(m => idsByKey.has(m.entityKey))) {
      const group = await RelationshipGroup.create({
        label: rel.label ?? null,
        workspaceId,
        members: rel.members.map(m => ({
          refId:    idsByKey.get(m.entityKey),
          refModel: 'Entity',
          label:    m.label ?? null,
          notes:    null,
        })),
      });
      await Entity.updateMany(
        { _id: { $in: rel.members.map(m => idsByKey.get(m.entityKey)) }, workspaceId },
        { $addToSet: { relationships: group._id } }
      );
      counts.relationshipGroups = 1;
    } else if (rel) {
      log('light', 'starter relationship skipped — a member entity was not created');
    }

    // ── Starter open question ────────────────────────────────────────────────
    const oq = template.starterOpenQuestion;
    if (oq) {
      const linkIds = (oq.linkTo ?? []).map(k => idsByKey.get(k)).filter(Boolean);
      const created = await OpenQuestion.create({
        question: oq.question,
        entry_ids: linkIds,
        workspaceId,
      });
      if (linkIds.length) {
        await Entity.updateMany(
          { _id: { $in: linkIds }, workspaceId },
          { $addToSet: { open_questions: created._id } }
        );
      }
      counts.openQuestions = 1;
    }

    log('light', `seeded workspace ${workspaceId}: ${JSON.stringify(counts)}`);
    return { ok: true, counts };
  } catch (err) {
    // Deliberately swallowed: registration has already created the user and
    // workspace, and failing the request here would leave them unable to retry
    // with the same email. An unseeded workspace is usable; a lost account is not.
    console.error('[workspaceSeeder] seeding failed:', err.message);
    log('light', `partial seed for ${workspaceId}: ${JSON.stringify(counts)}`);
    return { ok: false, counts, error: err.message };
  }
}

/**
 * Creates a workspace owned by `ownerId` and seeds it — the pair every caller
 * that brings a workspace into being needs, in one place (KOL-123).
 *
 * `POST /auth/register` was the only thing in the product that had ever created
 * a `Workspace`, so the create-and-seed pair lived inline in that route and
 * every account had exactly one workspace for life. `POST /workspaces` is the
 * second caller, and the two must not drift: the stored `template` key has to
 * be the key that was actually seeded (see resolveTemplateKey above), the
 * creator has to be an `owner` in `members` — the role every gate in
 * middleware/workspace.js judges — and a seeding failure has to stay
 * best-effort on both paths.
 *
 * Three rules, all of them load-bearing:
 *
 *   - **A create failure throws; a seed failure does not.** The caller decides
 *     what a workspace that could not be written means — registration deletes
 *     the user it has just made rather than strand an account with no
 *     workspace, `POST /workspaces` answers a 500 and has nothing to undo. A
 *     *seeding* failure is reported in the result and never thrown, because an
 *     unseeded workspace is usable and losing the account is not.
 *   - **`template: null` seeds nothing**, and is stored as nothing. This is the
 *     one shape registration cannot ask for (it refuses a `template` that names
 *     no template, `null` included — KOL-031): an empty workspace is only
 *     useful once a user can have a second one, and it is what gives
 *     `POST /import` somewhere to land, since the one workspace an account used
 *     to have was seeded at signup and an import refuses a non-empty workspace.
 *     `undefined` still means the default, as it always has.
 *   - **It does not touch the session.** Which workspace a session acts in is
 *     written in exactly one place, `POST /workspaces/:id/select`.
 *
 * @param {object} args
 * @param {string} args.name a name already through `workspaceName()` — this does not validate
 * @param {string|import('mongoose').Types.ObjectId} args.ownerId
 * @param {string|null|undefined} args.template a key of TEMPLATES, `undefined` for
 *   the default, `null` to seed nothing
 * @param {string} [args.source] what asked for it, for the light-tier log line
 * @returns {Promise<{ workspace: object, templateKey: string|null, seed: object }>}
 */
export async function createWorkspace({ name, ownerId, template, source = 'unspecified caller' }) {
  // Resolved once and stored, so what the document records is what was seeded.
  const templateKey = template === null ? null : resolveTemplateKey(template);

  const workspace = await Workspace.create({
    name,
    ownerId,
    members: [{ userId: ownerId, role: 'owner' }],
    template: templateKey,
  });
  workspaceLog('light', `created workspace ${workspace._id} named "${workspace.name}" owned by ${ownerId}, seeding from ${templateKey ? `template "${templateKey}"` : 'nothing — template: null, an empty workspace'} (source: ${source})`);

  const seed = templateKey
    ? await seedWorkspace(workspace._id, templateKey)
    : { ok: true, counts: {}, seeded: false };
  if (!seed.ok) console.error(`[workspaceSeeder] workspace ${workspace._id} seeded partially:`, seed.error);

  return { workspace, templateKey, seed };
}
