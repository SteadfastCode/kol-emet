/**
 * Run the generation pipeline and print what it WOULD propose.
 *
 * Writes nothing — no Proposal row, no entities. Exists so prompt quality can
 * be compared across providers before any of it is wired to a route.
 *
 * Run: node --env-file=.env scripts/try-generate.js <workspaceId> <file> [provider]
 *      node --env-file=.env scripts/try-generate.js <workspaceId> - [provider]   (stdin)
 */

import mongoose from 'mongoose';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';
dotenv.config();

const [, , workspaceId, file, provider] = process.argv;

if (!workspaceId || !file) {
  console.error('Usage: node --env-file=.env scripts/try-generate.js <workspaceId> <file|-> [provider]');
  process.exit(1);
}

const text = file === '-'
  ? readFileSync(0, 'utf8')
  : readFileSync(file, 'utf8');

await mongoose.connect(process.env.MONGO_URI);

const { generateProposal } = await import('../src/lib/generator.js');

const t0 = Date.now();
let result;
try {
  result = await generateProposal({
    text,
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    provider,
    onStage: s => console.error(`  … ${JSON.stringify(s)}`),
  });
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  await mongoose.disconnect();
  process.exit(1);
}

const entities = result.items.filter(i => i.kind === 'entity');
const rels = result.items.filter(i => i.kind === 'relationship');

console.log(`\n${'='.repeat(70)}`);
console.log(`route      : ${result.route.provider}/${result.route.model}`);
console.log(`input      : ${text.length} chars`);
console.log(`time       : ${Date.now() - t0}ms`);
console.log(`parsedVia  : ${result.diagnostics.parsedVia.join(', ')}`);
console.log(`repaired   : ${result.diagnostics.repairAttempted}`);
console.log(`passes     : ${result.diagnostics.passes}`);
console.log(`proposed   : ${entities.length} entities, ${rels.length} relationships`);
console.log(`dropped    : ${result.diagnostics.dropReasons.length}`);
console.log('='.repeat(70));

for (const it of entities) {
  const tgt = it.op === 'update' ? `  [UPDATE -> ${it.targetEntityId}]` : '';
  const flags = it.flags.length ? `  {${it.flags.join(',')}}` : '';
  console.log(`\n${it.localKey}  ${it.proposed.title}  (${it.proposed.category})${tgt}${flags}`);
  if (it.proposed.normalizedCategory !== it.proposed.category) {
    console.log(`     category coerced -> ${it.proposed.normalizedCategory}`);
  }
  console.log(`     ${it.proposed.summary}`);
  if (it.proposed.tags.length) console.log(`     tags: ${it.proposed.tags.join(', ')}`);
  console.log(`     blocks: ${it.proposed.blocks.length}`);
  const ev = it.input.evidence;
  console.log(`     evidence: ${ev.charStart === null ? '(not located)' : `${ev.charStart}-${ev.charEnd}`} "${(ev.quote || '').slice(0, 60)}"`);
  if (it.duplicateOf) console.log(`     possible duplicate of ${it.duplicateOf} (${it.duplicateScore})`);
}

for (const it of rels) {
  console.log(`\n${it.localKey}  ${it.proposed.label ?? '(unlabelled)'}${it.flags.length ? `  {${it.flags.join(',')}}` : ''}`);
  for (const m of it.proposed.members) {
    const via = m.localKey ? `-> ${m.localKey}` : `-> existing ${m.refId}`;
    console.log(`     ${m.name} as "${m.label ?? '?'}"  ${via}`);
  }
  if (it.dependsOn.length) console.log(`     dependsOn: ${it.dependsOn.join(', ')}`);
}

if (result.diagnostics.dropReasons.length) {
  console.log(`\n--- dropped (${result.diagnostics.dropReasons.length}) ---`);
  for (const r of result.diagnostics.dropReasons) console.log(`  - ${r}`);
}

console.log('\nNothing was written.');
await mongoose.disconnect();
