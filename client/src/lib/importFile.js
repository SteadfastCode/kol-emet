/**
 * Pull plain text out of a dropped or chosen file.
 *
 * Extraction happens in the browser: the file itself never reaches the server,
 * only the text the user then sees and can edit. That keeps a stray document —
 * a manuscript, a contract — from being uploaded wholesale just because someone
 * grabbed the wrong file, and it means the text going into the generator is
 * always the text they looked at.
 *
 * .docx is handled by mammoth, which is imported lazily so the ~150KB is only
 * paid by someone who actually imports a Word file.
 */

const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.text', '.rtf'];
const DOCX_EXTENSIONS = ['.docx'];
// A docker-compose file, an OpenAPI document, a Kubernetes manifest and a SQL
// schema dump are not notes: each goes to its own producer (POST
// /drafts/compose, /drafts/openapi, /drafts/kubernetes, /drafts/sql), which
// reads the structure rather than a model. `.json` is here for an OpenAPI
// document saved as JSON, which is how most tools emit one.
const PRODUCER_EXTENSIONS = ['.yml', '.yaml', '.json', '.sql'];

export const ACCEPT_ATTR = [...TEXT_EXTENSIONS, ...DOCX_EXTENSIONS, ...PRODUCER_EXTENSIONS].join(',');
export const SUPPORTED_LABEL =
  'Text, Markdown, Word, docker-compose, OpenAPI, Kubernetes manifests or SQL schemas ' +
  '(.txt, .md, .docx, .yml, .json, .sql)';

const extOf = name => {
  const i = String(name).lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
};

/** Whether `file` should go to a producer rather than into the notes textarea. */
export const isProducerFile = file => PRODUCER_EXTENSIONS.includes(extOf(file?.name ?? ''));

/**
 * The top-level keys of a structured document, without a YAML parser: enough to
 * tell which producer a file belongs to, and nothing more.
 *
 * JSON is tried first and read properly, because a JSON document's keys are all
 * indented and so are invisible to the line scan. The line scan is then the
 * YAML case: a key at column zero is a top-level key, which is exactly the
 * distinction that matters — `services:` nested under `paths:` does not make a
 * spec into a compose file.
 *
 * Every document of the stream is scanned, not just the first: a manifest is a
 * `---` stream, and `apiVersion`/`kind` are top-level keys of each document in
 * it. A `---` only resets the column-zero rule, which the line scan already
 * applies per line, so this needs nothing more than reading the whole file.
 */
function topLevelKeys(text) {
  const source = String(text ?? '');
  if (/^\s*[{[]/.test(source)) {
    try {
      const parsed = JSON.parse(source);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [];
    } catch {
      // Not valid JSON after all; the server will say so with a line number.
      return [];
    }
  }
  return source
    .split(/\r?\n/)
    .map(line => line.match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w.$-]*))\s*:(?:\s|$)/))
    .filter(Boolean)
    .map(m => m[1] ?? m[2] ?? m[3]);
}

/**
 * Which producer a structured file goes to.
 *
 * `.sql` is decided by the EXTENSION, and it is the only one that is: a schema
 * dump has no top-level key to read, and nothing else in this list arrives
 * under that name. It is therefore checked first, before the text is scanned
 * for keys it does not have.
 *
 * The rest are decided by their CONTENT rather than their extension: a
 * manifest, an OpenAPI document and a docker-compose file all arrive as
 * `.yaml`, so the extension cannot choose between them.
 *
 * Their order is the specificity order, for files that could be read two ways.
 * `openapi:`/`swagger:` wins first, because a spec that happens to name a
 * `services` tag is still a spec. `apiVersion` + `kind` together come next, and
 * both are required: `kind` alone is a word a CI config or a JSON schema uses,
 * while the pair is how Kubernetes itself identifies an object. `services:`
 * last, which is the compose file's one distinguishing key.
 *
 * @param {string} text
 * @param {string} [name]  the file's name, for the `.sql` reading
 * @returns {'sql'|'openapi'|'kubernetes'|'compose'|null} null when it is none
 *   of them, which is the client's own refusal — there is nothing to send and
 *   no producer to send it to
 */
export function producerFor(text, name = '') {
  if (extOf(name) === '.sql') return 'sql';
  const keys = topLevelKeys(text);
  if (keys.includes('openapi') || keys.includes('swagger')) return 'openapi';
  if (keys.includes('apiVersion') && keys.includes('kind')) return 'kubernetes';
  if (keys.includes('services')) return 'compose';
  return null;
}

/** Word leaves a lot of blank paragraphs behind; collapse them so the chunker
 *  sees real paragraph boundaries rather than runs of empty lines. */
function tidy(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

async function readAsText(file) {
  return tidy(await file.text());
}

async function readDocx(file) {
  const mammoth = await import('mammoth/mammoth.browser.js');
  const buffer = await file.arrayBuffer();
  const { value } = await mammoth.extractRawText({ arrayBuffer: buffer });
  return tidy(value);
}

/**
 * @returns {Promise<{name: string, text: string}>}
 * @throws  {Error} with a message written for the person who picked the file
 */
export async function extractText(file) {
  const ext = extOf(file.name);

  // Read verbatim, not tidied: the server names the line of a parse error, and
  // collapsing blank lines here would make that line wrong.
  if (PRODUCER_EXTENSIONS.includes(ext)) {
    const text = await file.text();
    if (!text.trim()) throw new Error(`"${file.name}" appears to be empty.`);
    return { name: file.name, text };
  }

  if (DOCX_EXTENSIONS.includes(ext)) {
    try {
      const text = await readDocx(file);
      if (!text) throw new Error('empty');
      return { name: file.name, text };
    } catch (err) {
      if (err.message === 'empty') {
        throw new Error(`"${file.name}" appears to contain no text.`);
      }
      throw new Error(`Couldn't read "${file.name}" — it may not be a valid .docx file.`);
    }
  }

  if (TEXT_EXTENSIONS.includes(ext) || file.type.startsWith('text/')) {
    const text = await readAsText(file);
    if (!text) throw new Error(`"${file.name}" appears to be empty.`);
    return { name: file.name, text };
  }

  // Named explicitly rather than "unsupported file": .doc and .pdf are the two
  // people reach for next, and a vague message leaves them guessing.
  if (ext === '.doc') {
    throw new Error(`"${file.name}" is the older Word format. Save it as .docx and try again.`);
  }
  if (ext === '.pdf') {
    throw new Error(`PDFs aren't supported yet — copy the text across, or save it as .docx.`);
  }
  throw new Error(`Can't read "${file.name}". Supported: ${SUPPORTED_LABEL}.`);
}

/**
 * Extract several files and join them. Failures are reported per file rather
 * than sinking the whole import — three good chapters and one bad file should
 * still get you three chapters.
 *
 * @returns {Promise<{text: string, names: string[], errors: string[]}>}
 */
export async function extractAll(files) {
  const parts = [], names = [], errors = [];
  for (const f of files) {
    try {
      const { name, text } = await extractText(f);
      parts.push(text);
      names.push(name);
    } catch (err) {
      errors.push(err.message);
    }
  }
  return { text: parts.join('\n\n'), names, errors };
}
