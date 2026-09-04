/**
 * Seeds a newly created workspace from a template.
 *
 * Runs at registration, on a path where partial success is worse than none:
 * a workspace with relationship types but no starter entities is a confusing
 * half-state. Each stage is therefore independently guarded and the whole
 * thing is best-effort — a seeding failure must never block account creation,
 * since the user can create their own content regardless.
 */

import RelationshipType from '../models/RelationshipType.js';
import RelationshipGroup from '../models/RelationshipGroup.js';
import OpenQuestion from '../models/OpenQuestion.js';
import Entity from '../models/Entity.js';
import { getTemplate, DEFAULT_TEMPLATE } from '../config/templates.js';

// off | light | normal — seeding runs unattended at registration, so the
// default tier records enough to tell a seeded workspace from a bare one.
const LEVELS = { off: 0, light: 1, normal: 2 };
function log(level, msg) {
  const active = LEVELS[process.env.SEED_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[workspaceSeeder:${level}] ${msg}`);
}

/**
 * @returns {Promise<{ok: boolean, counts: object, error?: string}>}
 */
export async function seedWorkspace(workspaceId, templateKey = DEFAULT_TEMPLATE) {
  const template = getTemplate(templateKey);
  const counts = { relationshipTypes: 0, entities: 0, relationshipGroups: 0, openQuestions: 0 };

  try {
    log('light', `seeding workspace ${workspaceId} from template "${templateKey}"`);

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
