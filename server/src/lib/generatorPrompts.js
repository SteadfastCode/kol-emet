/**
 * Prompts for the braindump generator.
 *
 * Bumping PROMPT_VERSION is meaningful: it is recorded on every proposal, so
 * "did accept-rate improve when the prompt changed" is answerable later from
 * the corpus alone.
 *
 * Two narrow passes rather than one wide one. A single prompt asking for
 * entities and relationships together makes weaker models emit relationships
 * referring to entities they never listed. Pass 2 is given the finished name
 * list, which turns that failure mode into a constrained choice.
 */

export const PROMPT_VERSION = 'gen-v1';

/**
 * Pass 1 — entities.
 *
 * The model is asked for a flat `body` markdown string, not a blocks array.
 * Entity content is an ordered blocks array, but making a 3B-14B model emit
 * that structure reliably is the single biggest source of unusable output;
 * the server wraps `body` into one text block instead. The cost is real and
 * worth naming: v1 generates text-only entities, so attributes, quotes and
 * timeline events must be added by hand afterwards.
 */
export function entityPrompt({ categories, existingTitles }) {
  const roster = existingTitles.length
    ? `\n\nENTITIES THAT ALREADY EXIST in this wiki — do NOT propose these again; ` +
      `refer to them by exactly these names if the text mentions them:\n` +
      existingTitles.map(t => `- ${t}`).join('\n')
    : '';

  return (
    `You extract structured wiki entities from an author's rough notes.\n\n` +
    `Return ONLY a JSON array. No prose, no markdown fences.\n\n` +
    `Each element must be an object with exactly these keys:\n` +
    `  "title"    — the entity's name, as the author would write it\n` +
    `  "category" — EXACTLY one of: ${categories.map(c => `"${c}"`).join(', ')}\n` +
    `  "summary"  — one sentence, under 140 characters\n` +
    `  "body"     — markdown notes drawn ONLY from the source text; "" if there is nothing more to say\n` +
    `  "tags"     — array of short lowercase strings, may be empty\n` +
    `  "quote"    — a SHORT verbatim span copied from the source text that this entity came from\n\n` +
    `Rules:\n` +
    `- Only propose entities the text actually describes. Never invent people, ` +
    `places, organizations or events that are not there.\n` +
    `- "quote" must be copied character-for-character from the source. It is used ` +
    `to show the author where each entity came from.\n` +
    `- Do not restate the whole source in "body". Summarise what is known about ` +
    `THAT entity specifically.\n` +
    `- If the text describes nothing worth an entity, return [].${roster}`
  );
}

/**
 * Pass 2 — relationships over a closed name list.
 *
 * Members are named, never id'd: the model has no way to know an ObjectId, and
 * name resolution is the server's job. Role labels are asked for per member
 * because the graph stores a label per membership, not per edge.
 */
export function relationshipPrompt({ names, relationshipTypes }) {
  const vocab = relationshipTypes.length
    ? `\n\nPreferred role labels already used in this wiki — reuse these when they fit:\n` +
      relationshipTypes.map(t => `- ${t}`).join('\n')
    : '';

  return (
    `You identify relationships between entities that an author has written about.\n\n` +
    `Return ONLY a JSON array. No prose, no markdown fences.\n\n` +
    `Each element must be an object with exactly these keys:\n` +
    `  "label"   — a name for the relationship group, or null (e.g. "Elias Family")\n` +
    `  "members" — array of at least 2 objects, each { "name": string, "role": string }\n` +
    `  "quote"   — a SHORT verbatim span from the source text supporting this relationship\n\n` +
    `Rules:\n` +
    `- "name" MUST be exactly one of the names in the list below. Never introduce a new name.\n` +
    `- "role" describes that member's part in this specific relationship, and must be ` +
    `specific to them: use "father"/"mother" not "parent", "brother"/"sister" not "sibling".\n` +
    `- A relationship needs at least 2 members. Skip anything you cannot ground in the text.\n` +
    `- Only assert relationships the text actually states or clearly implies.\n` +
    `- If there are none, return [].\n\n` +
    `AVAILABLE NAMES (use these exactly):\n` +
    names.map(n => `- ${n}`).join('\n') +
    vocab
  );
}
