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
// A docker-compose file and an OpenAPI document are not notes: each goes to its
// own producer (POST /drafts/compose, POST /drafts/openapi), which reads the
// structure rather than a model. `.json` is here for an OpenAPI document saved
// as JSON, which is how most tools emit one.
const PRODUCER_EXTENSIONS = ['.yml', '.yaml', '.json'];

export const ACCEPT_ATTR = [...TEXT_EXTENSIONS, ...DOCX_EXTENSIONS, ...PRODUCER_EXTENSIONS].join(',');
export const SUPPORTED_LABEL =
  'Text, Markdown, Word, docker-compose or OpenAPI (.txt, .md, .docx, .yml, .json)';

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
 * Which producer a structured file goes to, decided by its CONTENT rather than
 * its extension: an OpenAPI document and a docker-compose file both arrive as
 * `.yaml`, so the extension cannot choose between them. `openapi:`/`swagger:`
 * wins over `services:` when a document somehow declares both, because a spec
 * that happens to name a `services` tag is still a spec.
 *
 * @param {string} text
 * @returns {'openapi'|'compose'|null} null when it is neither, which is the
 *   client's own refusal — there is nothing to send and no producer to send it to
 */
export function producerFor(text) {
  const keys = topLevelKeys(text);
  if (keys.includes('openapi') || keys.includes('swagger')) return 'openapi';
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
