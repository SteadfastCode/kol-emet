import { Router } from 'express';
import OpenQuestion from '../models/OpenQuestion.js';
import Entity from '../models/Entity.js';
import { entriesIn, ownEntryIds } from '../lib/scopedPopulate.js';
import { objectIdParam } from '../middleware/objectId.js';
import { boundedInteger, idCursor } from '../lib/searchFilter.js';

const router = Router();

// A malformed id is 400 INVALID_ID, not a CastError the catch turns into a 500.
// Registered here rather than per handler so a later route inherits it.
router.param('id', objectIdParam('id'));

/**
 * ─── Tiered debug logging ───────────────────────────────────────────────────
 * OPEN_QUESTION_LIST_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — every page of `GET /open-questions`: the limit, status filter and
 *             cursor it ran with, how many rows came back, the cursor it hands
 *             out next, and the query string all of that was read from. A page
 *             boundary that drops or repeats a question leaves no other trace —
 *             a caller concatenates pages and shows a list, so a missing
 *             question looks like a missing question. Also every refused cursor.
 *   normal  — light, plus the unpaged (bare array) reads, with their row count
 *   verbose — normal, plus the first and last id on each page, which is what a
 *             boundary bug is visible in
 */
const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.OPEN_QUESTION_LIST_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[openQuestions:${level}] ${msg}`);
}

/**
 * The page sizes `GET /open-questions` will serve. Below the minimum is no page
 * size at all (see `boundedInteger`); above the maximum is clamped to it.
 *
 * The same 200 `GET /entities` and `GET /relationship-groups` serve. This route
 * answered with every question in the workspace *and* resolved `entry_ids` for
 * each one, so its cost grew twice over with the workspace — on the single
 * event loop every tenant of this API shares. A caller who wants the whole set
 * still gets it, by asking for pages.
 */
export const QUESTION_LIMIT_MIN = 1;
export const QUESTION_LIMIT_MAX = 200;

/**
 * GET /open-questions — the workspace's questions, newest first, optional
 * `?status=open|resolved`, a page at a time when a page is asked for.
 *
 * The contract is the one `GET /entities` answers (KOL-067) with a bare-id
 * cursor, exactly as `GET /relationship-groups` answers it (KOL-092): `?limit=`
 * opts into `{ items, nextAfter }`, no `?limit=` is the unbounded bare array
 * this route has always answered, `?after=` is the previous page's `nextAfter`
 * verbatim, and a present-but-unusable cursor is 400 rather than a silent first
 * page (a client that pages until `nextAfter` is null would otherwise never
 * stop).
 *
 * The sort moved from `createdAt: -1` to `_id: -1`, which keeps the newest-first
 * order the route has always answered in while giving the cursor a position it
 * can name: an ObjectId leads with its creation timestamp, so descending `_id`
 * is descending creation order, and unlike `createdAt` it is unique — two
 * questions created in the same millisecond cannot straddle a page boundary and
 * lose one of themselves. It is indexed on every collection, so this needs no
 * new index on a live Atlas collection.
 *
 * `.lean()` for the same reason the entity list reads lean: nothing here needs a
 * hydrated document, and the page is serialized straight out.
 */
router.get('/', async (req, res, next) => {
  try {
    const filter = { workspaceId: req.workspaceId };
    if (req.query.status) filter.status = req.query.status;
    // `?limit=` through the same typing rule as every other query-string value
    // that becomes a query: `?limit[$gt]=1` arrives as an object and
    // `?limit=1&limit=2` as an array, and either reaching `.limit()` is a 500
    // rather than a page. Absent, unusable, or below the minimum all mean *no
    // limit* — today's unpaged bare array, unchanged.
    const limit = boundedInteger(req.query.limit, { min: QUESTION_LIMIT_MIN, max: QUESTION_LIMIT_MAX });

    const source = req.originalUrl.includes('?') ? `?${req.originalUrl.split('?').slice(1).join('?')}` : '(no query string)';
    const cursor = idCursor(req.query.after);
    if (cursor.error) {
      log('light', `refused 400 — ${cursor.error} (source: ${source}, after=${JSON.stringify(req.query.after)})`);
      return res.status(400).json({ error: cursor.error });
    }
    const after = cursor.after;

    // `$lt`, not `$gt`: the sort is descending, so the next page is the rows
    // *below* the cursor.
    const query = OpenQuestion.find(after ? { ...filter, _id: { $lt: after } } : filter)
      .sort({ _id: -1 });
    // One row past the page, so whether a next page exists is a fact about what
    // came back rather than something inferred from a second count query.
    if (limit) query.limit(limit + 1);

    const rows = await query.populate(entriesIn(req.workspaceId)).lean();

    if (!limit) {
      log('normal', `unpaged list → ${rows.length} question(s), bare array (source: ${source})`);
      return res.json(rows);
    }

    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    const nextAfter = rows.length > limit && last ? String(last._id) : null;

    log('light', `page → limit ${limit}, after ${after ?? '(none)'}, status ${filter.status ?? '(any)'}, ${items.length} question(s), next ${nextAfter ?? '(none)'} (source: ${source})`);
    log('verbose', `page ids: ${items.length ? `${items[0]._id} … ${last._id}` : '(empty)'}`);

    res.json({ items, nextAfter });
  } catch (err) {
    next(err);
  }
});

// GET /open-questions/:id
router.get('/:id', async (req, res, next) => {
  try {
    const q = await OpenQuestion.findOne({ _id: req.params.id, workspaceId: req.workspaceId })
      .populate(entriesIn(req.workspaceId));
    if (!q) return res.status(404).json({ error: 'Not found' });
    res.json(q);
  } catch (err) {
    next(err);
  }
});

// POST /open-questions
router.post('/', async (req, res, next) => {
  try {
    const { question, entry_ids: requested = [] } = req.body;
    // Only this workspace's entities are kept, so another tenant's entity id is
    // never stored — nor back-linked below.
    const entry_ids = await ownEntryIds(requested, req.workspaceId);
    const oq = await OpenQuestion.create({
      question,
      entry_ids,
      workspaceId: req.workspaceId,
    });

    // Back-link on each entry. Still scoped, as a second line behind the
    // filter above.
    if (entry_ids.length) {
      await Entity.updateMany(
        { _id: { $in: entry_ids }, workspaceId: req.workspaceId },
        { $addToSet: { open_questions: oq._id } }
      );
    }

    res.status(201).json(oq);
  } catch (err) {
    next(err);
  }
});

// PUT /open-questions/:id
router.put('/:id', async (req, res, next) => {
  try {
    const { question, status, entry_ids: requested } = req.body;
    const scope = { _id: req.params.id, workspaceId: req.workspaceId };
    const update = {};
    if (question !== undefined) update.question = question;
    if (status !== undefined) update.status = status;

    if (requested !== undefined) {
      // Sync back-links: remove from old entries, add to new
      const existing = await OpenQuestion.findOne(scope);
      if (!existing) return res.status(404).json({ error: 'Not found' });

      // Same rule as POST: another tenant's entity ids are dropped, not stored.
      const entry_ids = await ownEntryIds(requested, req.workspaceId);

      const oldIds = existing.entry_ids.map(id => id.toString());
      const newIds = entry_ids.map(id => id.toString());
      const removed = oldIds.filter(id => !newIds.includes(id));
      const added = newIds.filter(id => !oldIds.includes(id));

      if (removed.length) {
        await Entity.updateMany(
          { _id: { $in: removed }, workspaceId: req.workspaceId },
          { $pull: { open_questions: existing._id } }
        );
      }
      if (added.length) {
        await Entity.updateMany(
          { _id: { $in: added }, workspaceId: req.workspaceId },
          { $addToSet: { open_questions: existing._id } }
        );
      }

      update.entry_ids = entry_ids;
    }

    // `runValidators` because this is a `findOneAndUpdate`, which runs none by
    // default: without it the schema's `status` enum is enforced on create and
    // nowhere else, and `PUT { status: 'banana' }` answered 200 and stored it.
    // A client reading these counts the open ones (the badge in
    // client/src/components/EntityHeader.vue), so a third status is not a
    // cosmetic problem — it is a question that is neither open nor answered.
    // Validators run only on the paths the body named, so a `{ status }` write
    // is not refused for a `question` it never mentioned.
    const oq = await OpenQuestion.findOneAndUpdate(scope, update, { new: true, runValidators: true })
      .populate(entriesIn(req.workspaceId));
    if (!oq) return res.status(404).json({ error: 'Not found' });
    res.json(oq);
  } catch (err) {
    next(err);
  }
});

// DELETE /open-questions/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const oq = await OpenQuestion.findOneAndDelete({
      _id: req.params.id,
      workspaceId: req.workspaceId,
    });
    if (!oq) return res.status(404).json({ error: 'Not found' });

    // Remove back-links from entries
    await Entity.updateMany(
      { _id: { $in: oq.entry_ids }, workspaceId: req.workspaceId },
      { $pull: { open_questions: oq._id } }
    );

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
