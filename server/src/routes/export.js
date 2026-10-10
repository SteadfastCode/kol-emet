import { Router } from 'express';
import { exportWorkspace, exportFilename, exportLog as log } from '../lib/graphExporter.js';

/**
 * GET /export — the caller's whole workspace as one canonical JSON file (KOL-070).
 *
 * The way a user takes their graph out of the product, and the form a Git
 * connector will commit. The document itself, and every reason it looks the way
 * it does, is `lib/graphExporter.js`; this route is the HTTP skin on it:
 *
 *   - **Scope comes from the mount, not the query string.** Mounted behind
 *     `requireAuth` + `resolveWorkspace` in app.js like every other tenant
 *     content route, so the workspace is `req.workspaceId` and there is no
 *     parameter with which to ask for somebody else's.
 *   - **Serialized here, with two-space indentation, and sent with `res.send`**
 *     rather than handed to `res.json`: this file is meant to be read and
 *     diffed, and the indentation is part of the canonical form. The byte size
 *     is only knowable at this point, which is why it is this line that logs it.
 *   - **`Content-Disposition: attachment`** with the filename the exporter
 *     derives (`<workspace>-<YYYY-MM-DD>.json`), so a browser saves the file
 *     instead of rendering a megabyte of JSON into a tab.
 *
 * Deliberately not streaming: a workspace that is too large to serialize in one
 * go is a real concern and an item of its own (it needs a cursor per collection
 * and a hand-written JSON frame), and the sort that makes the document
 * deterministic needs each collection in memory anyway.
 *
 * Logging is `EXPORT_LOG_LEVEL` — see lib/graphExporter.js; the counts come
 * from there and the byte size from here, both at the light tier.
 */

const router = Router();

// GET /export — the whole workspace graph as an attachment.
router.get('/', async (req, res) => {
  try {
    const doc = await exportWorkspace(req.workspaceId, { source: 'GET /export' });
    const body = JSON.stringify(doc, null, 2);
    const filename = exportFilename(doc.workspace.name, doc.exportedAt);

    // The slug is ASCII with no quotes, spaces or separators by construction
    // (workspaceSlug), which is what makes it safe to interpolate into a header.
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.type('application/json');

    log('light', `sent ${Buffer.byteLength(body)} bytes as "${filename}" for workspace ${req.workspaceId} (source: GET /export)`);
    res.send(body);
  } catch (err) {
    log('light', `failed for workspace ${req.workspaceId} (source: GET /export): ${err.message}`);
    if (err.code === 'WORKSPACE_NOT_FOUND') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

export default router;
