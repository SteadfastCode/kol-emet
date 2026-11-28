import { Router } from 'express';
import RelationshipType from '../models/RelationshipType.js';
import { similarity, findSimilar } from '../lib/similarity.js';

/**
 * The relationship-label vocabulary — see models/RelationshipType.js.
 *
 * `scope` is the field that makes this collection usable: a relationship
 * carries labels in two places and they are different vocabularies — the GROUP
 * has a label ("Marriage", "Depends on") and each MEMBER of it has its own
 * ("Wife", "Dependency"). The generator has split the two to name its edges
 * since the field was added (`lib/generator.js`), and `lib/workspaceSeeder.js`
 * seeds both halves into every new workspace.
 *
 * **Both writes read `scope` from the body (KOL-159).** Until then `POST`
 * destructured only `{ name, sourceCategory, targetCategory }` and `PUT` the
 * same three, so every type any client created took the model's `member`
 * default and no client could create or change a `group`-scoped one at all:
 * the half of the vocabulary that names a *group* was reachable only by
 * seeding. A `scope` outside the enum is **400 with nothing written**, checked
 * before the create or the update rather than left to `runValidators` — the
 * enum is the whole contract here, and a mongoose ValidationError would answer
 * 500 for what is a caller's mistake.
 *
 * The exact-name 409 is **across scopes**, so one workspace cannot hold "Owner"
 * as both a group label and a member role; and the near-duplicate `findSimilar`
 * warning still creates the type. Both are what `routes/entityTypes.js` does
 * one route over.
 *
 * **`PUT` runs that same exact-name check (KOL-165).** Until then only `POST`
 * did: `PUT` built an `update` and called `findOneAndUpdate`, so a rename could
 * put a second "owned by" into a workspace that already had one — the
 * `owns`/`Owns` drift this vocabulary exists to prevent, arriving through the
 * one screen built to manage it, and leaving two rows offering the same word
 * with no way to tell which of them the next rename moves. Three details, each
 * matching `routes/entityTypes.js` one route over:
 *   - the row is read **before** any name is compared, so a foreign or unknown
 *     id is 404 and a 409 is never the answer for a row the caller does not own;
 *   - the clash candidates **exclude the row being renamed**, so a change of
 *     case alone on its own name is a rename and not a clash;
 *   - a blank or non-string `name` is the same `400 Name is required` `POST`
 *     gives, rather than a `ValidationError` the error handler turns into a 400
 *     (or, for a non-string, a `TypeError` and a 500).
 * There is still **no unique index** behind either check — the model's compound
 * index is deliberately non-unique, unlike `EntityType`'s — so two concurrent
 * renames can both pass it. See the KOL-165 Decision Log entry.
 *
 * A foreign or malformed id is 404, never 403 or 400, as everywhere else:
 * nothing may confirm that an id exists in another workspace.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * RELATIONSHIP_TYPE_LOG_LEVEL = off | light | normal | verbose (default light),
 * the same key `client/src/components/RelationshipTypeSettings.vue` reads, so
 * one setting narrates a write from the settings row to the collection.
 *   off     — nothing
 *   light   — every write and how it ended, naming the source of the change:
 *             the scope a create or an update actually stored (the quiet
 *             failure here is a type silently taking the `member` default),
 *             and every refusal with its status
 *   normal  — light, plus each read and how many rows it answered
 *   verbose — normal, plus the names and scopes those rows carry
 */

const router = Router();

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so a test can change it.
  const active = LEVELS[process.env.RELATIONSHIP_TYPE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[relationshipTypes:${level}] ${msg}`);
}

/**
 * The `scope` values the model allows, read off the schema so this route cannot
 * drift from the enum it is validating against.
 */
export const SCOPES = RelationshipType.schema.path('scope').enumValues;

/**
 * `scope` as the body gave it: `{ ok: true, scope }` when it is absent (the
 * model's default stands) or one of the enum, `{ ok: false, error }` otherwise.
 */
function readScope(body) {
  const { scope } = body ?? {};
  if (scope === undefined) return { ok: true, scope: undefined };
  if (!SCOPES.includes(scope)) {
    return { ok: false, error: `scope must be one of: ${SCOPES.join(', ')}` };
  }
  return { ok: true, scope };
}

// GET /relationship-types
router.get('/', async (req, res, next) => {
  try {
    const filter = { workspaceId: req.workspaceId };
    const types = await RelationshipType.find(filter).sort({ name: 1 });

    // If ?q= provided, fuzzy-filter the results
    if (req.query.q) {
      const q = req.query.q.toLowerCase().trim();
      const scored = types
        .map(t => ({ t, score: similarity(q, t.name) }))
        .filter(({ score, t }) =>
          score >= 0.3 || t.name.toLowerCase().includes(q)
        )
        .sort((a, b) => b.score - a.score);
      log('normal', `GET /relationship-types?q=${req.query.q} -> ${scored.length} of ${types.length} row(s)`);
      log('verbose', `matched: ${scored.map(({ t }) => `${t.name} (${t.scope})`).join(', ') || '(none)'}`);
      return res.json(scored.map(({ t }) => t));
    }

    log('normal', `GET /relationship-types -> ${types.length} row(s)`);
    log('verbose', `rows: ${types.map(t => `${t.name} (${t.scope})`).join(', ') || '(none)'}`);
    res.json(types);
  } catch (err) {
    next(err);
  }
});

// POST /relationship-types
router.post('/', async (req, res, next) => {
  try {
    const { name, sourceCategory = null, targetCategory = null } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

    // Before the create, so a bad scope writes nothing at all (KOL-159).
    const scope = readScope(req.body);
    if (!scope.ok) {
      log('light', `POST /relationship-types "${name}" refused 400: ${scope.error} (source: the request body's scope)`);
      return res.status(400).json({ error: scope.error });
    }

    const trimmed = name.trim();
    const existing = await RelationshipType.find({ workspaceId: req.workspaceId });

    // Exact match check — across scopes, as it always has been.
    const exact = existing.find(t => t.name.toLowerCase() === trimmed.toLowerCase());
    if (exact) {
      log('light', `POST /relationship-types "${trimmed}" refused 409: "${exact.name}" (${exact.scope}) already exists`);
      return res.status(409).json({ error: 'Relationship type already exists', existing: exact });
    }

    // Near-duplicate warning (still creates, but warns)
    const similar = findSimilar(trimmed, existing);
    const type = await RelationshipType.create({
      name: trimmed,
      // Absent leaves the model's default ('member') to stand, which is what
      // every pre-KOL-159 create got whatever the caller sent.
      ...(scope.scope !== undefined && { scope: scope.scope }),
      sourceCategory,
      targetCategory,
      workspaceId: req.workspaceId,
    });

    const response = { ...type.toObject() };
    if (similar.length) response.warning = `Similar types exist: ${similar.join(', ')}`;
    log('light', `created "${type.name}" scope ${type.scope} (source: POST /relationship-types, scope ${scope.scope === undefined ? 'not in the body — the model default stands' : `"${scope.scope}" from the body`})${similar.length ? ` with a near-duplicate warning: ${similar.join(', ')}` : ''}`);
    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});

// PUT /relationship-types/:id
router.put('/:id', async (req, res, next) => {
  try {
    const { name, sourceCategory, targetCategory } = req.body ?? {};

    // Before the update, so a bad scope writes nothing at all — not the scope,
    // and not a name or a category sent in the same body (KOL-159).
    const scope = readScope(req.body);
    if (!scope.ok) {
      log('light', `PUT /relationship-types/${req.params.id} refused 400: ${scope.error} (source: the request body's scope)`);
      return res.status(400).json({ error: scope.error });
    }

    const update = {};
    if (scope.scope !== undefined) update.scope = scope.scope;
    if (sourceCategory !== undefined) update.sourceCategory = sourceCategory;
    if (targetCategory !== undefined) update.targetCategory = targetCategory;

    // The same 400 POST gives for a name that is not a name, and for the same
    // reason the scope 400 is here: `.trim()` on a non-string is a 500 for what
    // is a caller's mistake, and a blank one is a ValidationError reported as
    // the driver's rather than as the route's (KOL-165).
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        log('light', `PUT /relationship-types/${req.params.id} refused 400: Name is required (source: the request body's name, ${JSON.stringify(name)})`);
        return res.status(400).json({ error: 'Name is required' });
      }
      update.name = name.trim();
    }

    // The row as it stands, read before anything is written: a foreign or
    // unknown id is 404 before any name is compared, so the exact-name 409
    // below can never be the answer for a row the caller does not own. A
    // malformed id still casts here exactly as it did on the update it replaces.
    const current = await RelationshipType.findOne({
      _id: req.params.id,
      workspaceId: req.workspaceId,
    });
    if (!current) {
      log('light', `PUT /relationship-types/${req.params.id} refused 404: no such type in workspace ${req.workspaceId}`);
      return res.status(404).json({ error: 'Not found' });
    }

    // Exact match check — across scopes, as on POST, and excluding the row
    // being renamed so that a change of case alone on its own name is a rename
    // and not a clash with itself (KOL-165).
    if (update.name !== undefined) {
      const others = await RelationshipType.find({
        workspaceId: req.workspaceId,
        _id: { $ne: current._id },
      });
      const clash = others.find(t => t.name.toLowerCase() === update.name.toLowerCase());
      if (clash) {
        log('light', `PUT /relationship-types/${current._id} "${current.name}" → "${update.name}" refused 409: "${clash.name}" (${clash.scope}) already holds the name (source: the request body's name)`);
        return res.status(409).json({ error: 'Relationship type already exists', existing: clash });
      }
    }

    // runValidators so a category the workspace has no type for is refused
    // here as it is on create.
    const type = await RelationshipType.findOneAndUpdate(
      { _id: current._id, workspaceId: req.workspaceId },
      update,
      { new: true, runValidators: true }
    );
    if (!type) {
      // Deleted between the read above and this write.
      log('light', `PUT /relationship-types/${req.params.id} refused 404: no such type in workspace ${req.workspaceId}`);
      return res.status(404).json({ error: 'Not found' });
    }
    log('light', `updated "${type.name}" scope ${type.scope} (source: PUT /relationship-types, patch ${JSON.stringify(update)})`);
    res.json(type);
  } catch (err) {
    next(err);
  }
});

// DELETE /relationship-types/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const type = await RelationshipType.findOneAndDelete({
      _id: req.params.id,
      workspaceId: req.workspaceId,
    });
    if (!type) {
      log('light', `DELETE /relationship-types/${req.params.id} refused 404: no such type in workspace ${req.workspaceId}`);
      return res.status(404).json({ error: 'Not found' });
    }
    log('light', `deleted "${type.name}" scope ${type.scope} (source: DELETE /relationship-types)`);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
