/**
 * The braindump input's import routing. Notes (.txt/.md/.docx) are appended to
 * the textarea for editing before a generation; a docker-compose file and an
 * OpenAPI document are not notes, so each skips the textarea and goes to its
 * own producer (POST /drafts/compose, POST /drafts/openapi), and the finished
 * draft is handed up (`drafted`) for the overlay's review stage.
 *
 * These pin that split, and the thing that decides it: the producer is chosen
 * by the file's CONTENT, not its extension — both kinds arrive as `.yaml` — the
 * file is sent verbatim with its filename, a refusal is shown rather than
 * swallowed, and a producer file mixed into a multi-file import is refused
 * before anything is sent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import BraindumpInput from './BraindumpInput.vue';
import { createComposeDraft, createOpenApiDraft } from '../../api/drafts.js';
import { isProducerFile, producerFor, ACCEPT_ATTR } from '../../lib/importFile.js';

vi.mock('../../api/drafts.js', () => ({
  createComposeDraft: vi.fn(),
  createOpenApiDraft: vi.fn(),
}));

beforeEach(() => { vi.clearAllMocks(); });

// extractText only reads name, type and text(), so a plain object stands in for a File.
const fakeFile = (name, text) => ({ name, type: '', text: async () => text });
const COMPOSE = '\n\nservices:\n  web:\n    image: nginx\n\n\n\n  db:\n    image: postgres\n';
const OPENAPI = 'openapi: 3.1.0\ninfo:\n  title: Pet Store API\n  version: 2.4.0\npaths:\n  /pets:\n    get: {}\n';
const OPENAPI_JSON = JSON.stringify({
  swagger: '2.0',
  info: { title: 'Legacy Orders', version: '1.2.0' },
  paths: { '/orders': { get: {} } },
}, null, 2);

async function drop(wrapper, files) {
  await wrapper.get('.drop').trigger('drop', { dataTransfer: { files } });
  await flushPromises();
}

describe('BraindumpInput import routing', () => {
  it('accepts .yml, .yaml and .json, and recognises them as producer files', () => {
    expect(ACCEPT_ATTR.split(',')).toEqual(expect.arrayContaining(['.yml', '.yaml', '.json', '.md', '.docx']));
    expect(isProducerFile({ name: 'docker-compose.YML' })).toBe(true);
    expect(isProducerFile({ name: 'compose.yaml' })).toBe(true);
    expect(isProducerFile({ name: 'openapi.json' })).toBe(true);
    expect(isProducerFile({ name: 'notes.md' })).toBe(false);
  });

  it('chooses the producer from the content, not the extension', () => {
    expect(producerFor(OPENAPI)).toBe('openapi');
    expect(producerFor(OPENAPI_JSON)).toBe('openapi');
    expect(producerFor(COMPOSE)).toBe('compose');
    // A spec that happens to declare a `services` tag is still a spec.
    expect(producerFor('openapi: 3.0.0\nservices:\n  - name: x\n')).toBe('openapi');
    // `services:` nested under another key is not a top-level key.
    expect(producerFor('paths:\n  /x:\n    services: {}\n')).toBe(null);
    expect(producerFor('name: CI\non: push\n')).toBe(null);
  });

  it('sends a dropped compose file verbatim to the compose producer and hands the draft up', async () => {
    const draft = { _id: 'd1', status: 'ready', counts: { proposed: 3 } };
    createComposeDraft.mockResolvedValue(draft);
    const wrapper = mount(BraindumpInput);

    await drop(wrapper, [fakeFile('docker-compose.yml', COMPOSE)]);

    expect(createComposeDraft).toHaveBeenCalledWith({ text: COMPOSE, filename: 'docker-compose.yml' });
    expect(createOpenApiDraft).not.toHaveBeenCalled();
    expect(wrapper.emitted('drafted')).toEqual([[draft]]);
    expect(wrapper.emitted('generate')).toBeUndefined();
    expect(wrapper.get('textarea').element.value).toBe('');   // the YAML does not land in the notes
  });

  it('sends a .yaml holding `openapi:` to the OpenAPI producer instead', async () => {
    const draft = { _id: 'd2', status: 'ready', counts: { proposed: 4 } };
    createOpenApiDraft.mockResolvedValue(draft);
    const wrapper = mount(BraindumpInput);

    await drop(wrapper, [fakeFile('petstore.yaml', OPENAPI)]);

    expect(createOpenApiDraft).toHaveBeenCalledWith({ text: OPENAPI, filename: 'petstore.yaml' });
    expect(createComposeDraft).not.toHaveBeenCalled();
    expect(wrapper.emitted('drafted')).toEqual([[draft]]);
    expect(wrapper.get('textarea').element.value).toBe('');
  });

  it('sends a .json holding `swagger:` to the OpenAPI producer', async () => {
    const draft = { _id: 'd3', status: 'ready', counts: { proposed: 2 } };
    createOpenApiDraft.mockResolvedValue(draft);
    const wrapper = mount(BraindumpInput);

    await drop(wrapper, [fakeFile('legacy.json', OPENAPI_JSON)]);

    expect(createOpenApiDraft).toHaveBeenCalledWith({ text: OPENAPI_JSON, filename: 'legacy.json' });
    expect(wrapper.emitted('drafted')).toEqual([[draft]]);
  });

  it('refuses a structured file that is neither, without sending anything', async () => {
    const wrapper = mount(BraindumpInput);

    await drop(wrapper, [fakeFile('ci.yml', 'name: CI\non: push\njobs: {}\n')]);

    expect(createComposeDraft).not.toHaveBeenCalled();
    expect(createOpenApiDraft).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('doesn\'t look like an OpenAPI document or a docker-compose file');
    expect(wrapper.emitted('drafted')).toBeUndefined();
  });

  it('shows the server\'s refusal and hands nothing up', async () => {
    createComposeDraft.mockRejectedValue(new Error('Invalid YAML on line 4: All mapping items must start at the same column'));
    const wrapper = mount(BraindumpInput);

    await drop(wrapper, [fakeFile('docker-compose.yml', COMPOSE)]);

    expect(wrapper.text()).toContain('Invalid YAML on line 4');
    expect(wrapper.emitted('drafted')).toBeUndefined();
  });

  it('refuses a producer file mixed into a multi-file import without sending anything', async () => {
    const wrapper = mount(BraindumpInput);

    await drop(wrapper, [fakeFile('notes.md', 'Some notes'), fakeFile('petstore.yaml', OPENAPI)]);

    expect(createComposeDraft).not.toHaveBeenCalled();
    expect(createOpenApiDraft).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Import a docker-compose or OpenAPI file on its own');
    expect(wrapper.get('textarea').element.value).toBe('');
  });

  it('still appends notes files to the textarea', async () => {
    const wrapper = mount(BraindumpInput);

    await drop(wrapper, [fakeFile('notes.md', 'Tamsin runs the salvage yard.')]);

    expect(createComposeDraft).not.toHaveBeenCalled();
    expect(createOpenApiDraft).not.toHaveBeenCalled();
    expect(wrapper.get('textarea').element.value).toBe('Tamsin runs the salvage yard.');
  });
});
