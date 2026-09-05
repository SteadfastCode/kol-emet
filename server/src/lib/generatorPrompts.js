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
/**
 * How much qualification a member role should carry.
 *
 *   descriptive — "older sister", "twin brother", "unwitting agent". Richer, and
 *                 what real data already does: 38% of the labels in the first
 *                 production workspace carry a qualifier.
 *   canonical   — "Sister", "Brother", "Agent". Cleaner to group and filter on,
 *                 at the cost of detail the author wrote down.
 *
 * A genuine preference rather than a right answer, so it is an option rather
 * than a rule. Proper nouns stay out of roles under both styles: "Elias sister"
 * is not a role, it is a group label wearing the wrong hat.
 */
export const ROLE_STYLES = ['descriptive', 'canonical'];
export const DEFAULT_ROLE_STYLE = 'descriptive';

export function relationshipPrompt({ names, groupLabels = [], memberRoles = [], roleStyle = DEFAULT_ROLE_STYLE }) {
  // The two vocabularies are offered against the two fields they belong to —
  // merged, the model uses a group label as a member role — and with OPPOSITE
  // instructions, because they behave differently in practice:
  //
  //   member roles are a CLOSED set. "Sister", "Son", "Mother" are the complete
  //   answer; improvising here just fragments the vocabulary.
  //
  //   group labels are a BASE to build on. A bare "Family" is ambiguous the
  //   moment a wiki holds two families, so the proper-noun form ("Elias
  //   Family") is the better answer and must be encouraged, not suppressed.
  //   Real data carries both patterns: "Elias family" and "Elias siblings"
  //   alongside plain "Marriage" and "headquarters".
  const groupVocab = groupLabels.length
    ? `\n\nGROUP LABEL vocabulary — these are base kinds, not a closed list:\n` +
      groupLabels.map(t => `- ${t}`).join('\n') +
      `\nAny of them can take a proper noun, including the ones that look complete ` +
      `on their own: "Elias Family", "Elias Marriage", "Vurdaal Leadership". ` +
      `Qualify whenever there is a name available to qualify with — a bare kind is ` +
      `ambiguous as soon as the wiki holds two of them. Use the bare kind only when ` +
      `there is genuinely nothing to attach.`
    : '';

  const roleGuidance = roleStyle === 'canonical'
    ? `\nKeep roles to their plainest form: "Sister", not "older sister"; "Agent", ` +
      `not "unwitting agent". Strip qualifiers even when the text supports them.`
    : `\nQualifiers are welcome where the text supports them — "Older sister", ` +
      `"Twin brother", "Unwitting agent", "Future double agent" — since they carry ` +
      `detail the author actually wrote. Add a qualifier only when the text states ` +
      `it; never guess who is older. Capitalise the first word only: "Older sister", ` +
      `not "older sister" and not "Older Sister".`;

  const roleVocab = memberRoles.length
    ? `\n\nMEMBER ROLE vocabulary — prefer these as your base:\n` +
      memberRoles.map(t => `- ${t}`).join('\n') +
      roleGuidance +
      `\nNever put a proper noun in a role: "Elias sister" is a group label wearing ` +
      `the wrong hat. And ACCURACY WINS over the list: if no listed role truthfully ` +
      `describes the member's part, write the correct one. A creditor is a ` +
      `"Creditor", never a "Mentor" because "Mentor" happened to be available.`
    : '';

  const vocab = groupVocab + roleVocab;

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
    `- "label" names the relationship itself. Proper nouns are welcome and usually ` +
    `better — the label is how a human will recognise this group in a list.\n` +
    `- A relationship is a GROUP, not a pair. Put everyone who belongs to the same ` +
    `relationship in ONE object with all of them as members. A family of five is a ` +
    `single group with five members, each with their own role — never several ` +
    `two-person groups sharing a label.\n` +
    `- A relationship needs at least 2 members. Skip anything you cannot ground in the text.\n` +
    `- Only assert relationships the text actually states or clearly implies.\n` +
    `- If there are none, return [].\n\n` +
    `AVAILABLE NAMES (use these exactly):\n` +
    names.map(n => `- ${n}`).join('\n') +
    vocab
  );
}
