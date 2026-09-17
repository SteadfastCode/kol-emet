/**
 * The braindump input's import routing. Notes (.txt/.md/.docx) are appended to
 * the textarea for editing before a generation; a docker-compose file is not
 * notes, so it skips the textarea and goes to POST /drafts/compose, and the
 * finished draft is handed up (`drafted`) for the overlay's review stage.
 * These pin that split: the YAML is sent verbatim with its filename, a refusal
 * is shown rather than swallowed, and a compose file mixed into a multi-file
 * import is refused before anything is sent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import BraindumpInput from './BraindumpInput.vue';
import { createComposeDraft } from '../../api/drafts.js';
import { isComposeFile, ACCEPT_ATTR } from '../../lib/importFile.js';

vi.mock('../../api/drafts.js', () => ({ createComposeDraft: vi.fn() }));

beforeEach(() => { vi.clearAllMocks(); });

// extractText only reads name, type and text(), so a plain object stands in for a File.
const fakeFile = (name, text) => ({ name, type: '', text: async () => text });
const COMPOSE = '\n\nservices:\n  web:\n    image: nginx\n\n\n\n  db:\n    image: postgres\n';

async function drop(wrapper, files) {
  await wrapper.get('.drop').trigger('drop', { dataTransfer: { files } });
  await flushPromises();
}

describe('BraindumpInput import routing', () => {
  it('accepts .yml and .yaml, and recognises them as compose files', () => {
    expect(ACCEPT_ATTR.split(',')).toEqual(expect.arrayContaining(['.yml', '.yaml', '.md', '.docx']));
    expect(isComposeFile({ name: 'docker-compose.YML' })).toBe(true);
    expect(isComposeFile({ name: 'compose.yaml' })).toBe(true);
    expect(isComposeFile({ name: 'notes.md' })).toBe(false);
  });

  it('sends a dropped compose file verbatim to the compose producer and hands the draft up', async () => {
    const draft = { _id: 'd1', status: 'ready', counts: { proposed: 3 } };
    createComposeDraft.mockResolvedValue(draft);
    const wrapper = mount(BraindumpInput);

    await drop(wrapper, [fakeFile('docker-compose.yml', COMPOSE)]);

    expect(createComposeDraft).toHaveBeenCalledWith({ text: COMPOSE, filename: 'docker-compose.yml' });
    expect(wrapper.emitted('drafted')).toEqual([[draft]]);
    expect(wrapper.emitted('generate')).toBeUndefined();
    expect(wrapper.get('textarea').element.value).toBe('');   // the YAML does not land in the notes
  });

  it('shows the server\'s refusal and hands nothing up', async () => {
    createComposeDraft.mockRejectedValue(new Error('Invalid YAML on line 4: All mapping items must start at the same column'));
    const wrapper = mount(BraindumpInput);

    await drop(wrapper, [fakeFile('docker-compose.yml', COMPOSE)]);

    expect(wrapper.text()).toContain('Invalid YAML on line 4');
    expect(wrapper.emitted('drafted')).toBeUndefined();
  });

  it('refuses a compose file mixed into a multi-file import without sending anything', async () => {
    const wrapper = mount(BraindumpInput);

    await drop(wrapper, [fakeFile('notes.md', 'Some notes'), fakeFile('docker-compose.yml', COMPOSE)]);

    expect(createComposeDraft).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Import a docker-compose file on its own');
    expect(wrapper.get('textarea').element.value).toBe('');
  });

  it('still appends notes files to the textarea', async () => {
    const wrapper = mount(BraindumpInput);

    await drop(wrapper, [fakeFile('notes.md', 'Tamsin runs the salvage yard.')]);

    expect(createComposeDraft).not.toHaveBeenCalled();
    expect(wrapper.get('textarea').element.value).toBe('Tamsin runs the salvage yard.');
  });
});
