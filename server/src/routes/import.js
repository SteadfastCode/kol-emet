import express, { Router } from 'express';
import { requireActor } from '../middleware/auth.js';
import { requireWorkspaceRole } from '../middleware/workspace.js';
import { broadcast } from '../lib/broadcaster.js';
import { importWorkspace, importCaps, importLog as log } from '../lib/graphImporter.js';

/**
 * POST /import — read a canonical export back into an empty workspace (KOL-077).
 *
 * The other end of `GET /export`. The document, every id it rewrites and every
 * reason it refuses one is `lib/graphImporter.js`; this route is the HTTP skin
 * on it:
 *
 *   - **Scope comes from the mount, not the body.** `requireAuth` +
 *     `resolveWorkspace` in app.js like every other tenant-content route, then
 *     `requireWorkspaceRole('owner')` here: an import writes a whole graph, so
 *     it is the owner's call and not an editor's. A `workspaceId` in the
 *     uploaded file is never read — see the importer's header.
 *   - **A refusal is a code**, because the client branches on it:
 *     400 `MALFORMED_JSON` (the bytes are not JSON), 400 `MALFORMED_DOCUMENT`
 *     (they are, but a row is not what it must be), 400 `UNSUPPORTED_VERSION`,
 *     409 `WORKSPACE_NOT_EMPTY`, 413 `IMPORT_TOO_LARGE`. The *reason* — which
 *     field, which count, which version — stays in the log: a response that
 *     narrated the document back would be a nice oracle for a hand-edited one.
 *   - **201 with the counts**, since the request created documents and the
 *     counts are the only way a caller can tell a complete import from one that
 *     quietly dropped a collection.
 *   - **One `workspace:imported` frame on `/events`** (KOL-102), carrying those
 *     same counts and the actor. An import writes a whole graph in one request,
 *     and the per-entity events the normal write path broadcasts are not
 *     emitted here at all — so without this frame every *other* tab in the
 *     workspace, and the member on the next desk, showed the empty workspace
 *     until someone reloaded. One frame rather than a per-row burst for the
 *     same reason a draft apply sends one (`lib/changeLogger.js`): the client
 *     refetches. The originating client is excluded by `X-SSE-Client-Id` the
 *     way every other write excludes it — that tab reloads on its own 201.
 *
 * `importJsonBody` below is why this file imports express itself. The app-wide
 * `express.json()` has the default 100 kB limit and turns a parse failure into
 * an unhandled error, and it runs long before any router — so a bigger-than-
 * default upload and a 400 for malformed JSON both have to be arranged *ahead*
 * of it, path-scoped. See the mount in app.js.
 *
 * No transaction: the deployment is a single mongod, so there is none to be had
 * here. The importer instead settles every question it can — version, shape,
 * caps, the emptiness of the workspace — before the first insert, so a refused
 * import writes nothing. What is not covered is a *write* failing midway (a
 * disconnect, a disk): that leaves a partial graph in a workspace whose
 * emptiness rule then refuses a retry, and the owner has to clear it. Honest
 * limit, recorded here rather than hidden: a transaction needs the replica set
 * the hosted deployment does not yet have.
 *
 * Logging is `IMPORT_LOG_LEVEL` — see lib/graphImporter.js; the counts and
 * every refusal's reason come from there, the byte size from here.
 */

/** What a refused import answers, by the importer's code. */
const STATUS_BY_CODE = Object.freeze({
  MALFORMED_DOCUMENT: 400,
  UNSUPPORTED_VERSION: 400,
  WORKSPACE_NOT_EMPTY: 409,
  IMPORT_TOO_LARGE: 413,
});

/** The largest upload accepted, overridable per deployment. */
export const IMPORT_BODY_LIMIT = process.env.IMPORT_BODY_LIMIT || '8mb';

/**
 * The body parser for `/import`, plus the translation of its own failures.
 *
 * Mounted in app.js ahead of the app-wide `express.json()`, which body-parser
 * then skips (it leaves `req._body` set), so this is the one parser that sees
 * an import: a few megabytes of graph rather than the 100 kB a normal write
 * needs, and a `SyntaxError` answered as the caller's 400 instead of falling
 * through to the error handler's 500.
 */
export const importJsonBody = [
  express.json({ limit: IMPORT_BODY_LIMIT }),
  // Four arguments, so Express treats this as error middleware for the path.
  (err, req, res, next) => {
    // Only body-parser's own failures; anything else is not ours to answer.
    if (typeof err?.type !== 'string' || !err.type.startsWith('entity.')) return next(err);

    if (err.type === 'entity.too.large') {
      log('light', `refused ${req.method} ${req.originalUrl}: body over ${IMPORT_BODY_LIMIT} (source: importJsonBody, IMPORT_BODY_LIMIT)`);
      return res.status(413).json({ error: 'IMPORT_TOO_LARGE' });
    }

    log('light', `refused ${req.method} ${req.originalUrl}: the body is not JSON (source: importJsonBody, ${err.type})`);
    res.status(400).json({ error: 'MALFORMED_JSON' });
  },
];

const router = Router();

// POST /import — one export document into the caller's own empty workspace.
//
// `requireActor` sits behind the role gate (so a role refusal still costs no
// lookup) and ahead of the write, because the broadcast below names who
// imported: `req.actingUserId` is an id, and a toast in someone else's tab
// needs the label every other broadcast carries.
router.post('/', requireWorkspaceRole('owner'), requireActor, async (req, res, next) => {
  const source = `POST /import by user ${req.actingUserId}`;
  try {
    const result = await importWorkspace(req.body, req.workspaceId, { source, caps: importCaps() });

    const excludeClientId = req.headers['x-sse-client-id'] ?? null;
    broadcast('workspace:imported', {
      version:  result.version,
      imported: result.imported,
      actor:    { label: req.actor.label, type: req.actor.type },
    }, { workspaceId: req.workspaceId, excludeClientId });
    log('light', `told the workspace's other live clients: workspace:imported${excludeClientId ? ` (excluding client ${excludeClientId})` : ''} (source: ${source})`);

    res.status(201).json(result);
  } catch (err) {
    const status = STATUS_BY_CODE[err.code];
    // The importer already logged the reason at the light tier; this line is
    // the status that reason became.
    if (status) {
      log('light', `answered ${status} ${err.code} (source: ${source})`);
      return res.status(status).json({ error: err.code });
    }
    log('light', `failed for workspace ${req.workspaceId} (source: ${source}): ${err.message}`);
    next(err);
  }
});

export default router;
