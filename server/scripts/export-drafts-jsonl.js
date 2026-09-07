/**
 * Exports reviewed drafts as JSONL for fine-tuning.
 *
 * Every line is one complete training example: the braindump the model was
 * given, exactly what it proposed, and exactly what a human accepted, edited or
 * rejected. Discarded drafts are included by default and deliberately — a draft
 * that was reviewed in full and then thrown away still carries a complete set
 * of labels, and the rejections in it are the examples hardest to get any other
 * way.
 *
 * Ids never leave: workspaces, users and entities become keyed HMAC pseudonyms
 * (stable across runs, so the corpus is still joinable), and references to
 * things created inside the same draft become `local:<key>`. The export fails
 * loudly rather than emitting a record that still contains a raw ObjectId.
 *
 * Run:
 *   node --env-file=.env scripts/export-drafts-jsonl.js > corpus.jsonl
 *   node --env-file=.env scripts/export-drafts-jsonl.js --out corpus.jsonl --since 2026-09-01
 *
 * Flags:
 *   --out <file>        write to a file instead of stdout
 *   --since <ISO date>  only drafts created on or after this date
 *   --workspace <id>    restrict to one workspace
 *   --status <a,b>      status filter (default: every status except 'generating')
 *   --reviewed-only     skip drafts where every item is still pending
 *   --include-raw       include diagnostics.rawOutput (large; parse-ladder debugging)
 *   --stats             print a summary to stderr when done
 */

import mongoose from 'mongoose';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

import { makePseudonymizer, toJsonl, EXPORT_SCHEMA } from '../src/lib/draftExporter.js';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI not set in environment');
  process.exit(1);
}

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const flag = name => process.argv.includes(`--${name}`);

const OUT           = arg('out');
const SINCE         = arg('since');
const WORKSPACE     = arg('workspace');
const STATUS        = arg('status');
const REVIEWED_ONLY = flag('reviewed-only');
const INCLUDE_RAW   = flag('include-raw');
const STATS         = flag('stats');

let pseudonym;
try {
  pseudonym = makePseudonymizer(process.env.EXPORT_HMAC_SECRET);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

await mongoose.connect(MONGO_URI);
const { default: Draft } = await import('../src/models/Draft.js');

const query = {
  // 'generating' is excluded because those rows have no items yet — a draft
  // still in flight is not an example of anything.
  status: STATUS ? { $in: STATUS.split(',').map(s => s.trim()) } : { $ne: 'generating' },
};
if (SINCE) {
  const since = new Date(SINCE);
  if (Number.isNaN(since.getTime())) {
    console.error(`--since is not a date: ${SINCE}`);
    process.exit(1);
  }
  query.createdAt = { $gte: since };
}
if (WORKSPACE) query.workspaceId = new mongoose.Types.ObjectId(WORKSPACE);

const out = OUT ? fs.createWriteStream(OUT, { flags: 'w' }) : process.stdout;
const write = line => new Promise(resolve => {
  // Respect backpressure — a large corpus to a file will otherwise buffer the
  // whole export in memory.
  out.write(line + '\n') ? resolve() : out.once('drain', resolve);
});

const tally = {
  drafts: 0, skippedUnreviewed: 0, items: 0,
  accepted: 0, edited: 0, rejected: 0, pending: 0, applied: 0,
};

// Cursor rather than find().lean() — the corpus is unbounded by design and the
// braindump text is stored verbatim, so this must never load it all at once.
const cursor = Draft.find(query).sort({ createdAt: 1 }).cursor();

for await (const draft of cursor) {
  const decided = draft.items.some(it => it.decision !== 'pending');
  if (REVIEWED_ONLY && !decided) { tally.skippedUnreviewed++; continue; }

  let line;
  try {
    line = toJsonl(draft, { pseudonym, includeRawOutput: INCLUDE_RAW });
  } catch (err) {
    // A leaked id is a correctness failure in the exporter, not a bad row to
    // skip past. Stop, so it gets fixed rather than shipped into a corpus.
    console.error(`\nExport aborted on draft ${draft._id}: ${err.message}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  await write(line);
  tally.drafts++;
  for (const it of draft.items) {
    tally.items++;
    if (it.decision === 'accepted') tally.accepted++;
    else if (it.decision === 'edited') tally.edited++;
    else if (it.decision === 'rejected') tally.rejected++;
    else tally.pending++;
    if (it.applyState === 'applied') tally.applied++;
  }
}

if (OUT) await new Promise(resolve => out.end(resolve));

if (STATS) {
  const labelled = tally.accepted + tally.edited + tally.rejected;
  console.error(`\nschema  ${EXPORT_SCHEMA}`);
  console.error(`drafts  ${tally.drafts}${tally.skippedUnreviewed ? `  (${tally.skippedUnreviewed} unreviewed, skipped)` : ''}`);
  console.error(`items   ${tally.items}  →  ${labelled} labelled, ${tally.pending} pending`);
  console.error(`labels  accepted ${tally.accepted} · edited ${tally.edited} · rejected ${tally.rejected}`);
  console.error(`applied ${tally.applied}`);
  if (OUT) console.error(`\nwrote   ${OUT}`);
}

await mongoose.disconnect();
