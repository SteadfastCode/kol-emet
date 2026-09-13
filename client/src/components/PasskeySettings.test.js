/**
 * The Passkeys group in Settings, over the real client API module. fetch is stubbed rather than
 * api/auth.js mocked, so what is pinned here is the routes the group calls and what it does with
 * their answers. The one thing mocked is the WebAuthn prompt (@simplewebauthn/browser), since
 * jsdom has no authenticator. The server's own rules are in server/tests/http/passkeys.test.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { startRegistration } from '@simplewebauthn/browser';
import PasskeySettings from './PasskeySettings.vue';

vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
  browserSupportsWebAuthn: vi.fn(() => true),
}));

const SYNCED = {
  credentialID: 'c3luY2VkLXBhc3NrZXk', deviceType: 'multiDevice', backedUp: true,
  createdAt: '2026-09-01T10:00:00.000Z', lastUsedAt: '2026-09-12T10:00:00.000Z',
};
const BOUND = {
  credentialID: 'Ym91bmQtcGFzc2tleQ', deviceType: 'singleDevice', backedUp: false,
  createdAt: '2026-09-02T10:00:00.000Z', lastUsedAt: null,
};

const day = (iso) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** `{ 'METHOD /path': (init) => [status, body] }`, answered by the stubbed fetch. */
let routes;
/** Every request made, as 'METHOD /path'. */
let calls;

beforeEach(() => {
  localStorage.setItem('PASSKEY_LOG_LEVEL', 'off');
  calls = [];
  routes = {};
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const key = `${init.method ?? 'GET'} ${new URL(url, 'http://localhost').pathname}`;
    calls.push({ key, body: init.body });
    if (!routes[key]) throw new Error(`unexpected request: ${key}`);
    const [status, body] = routes[key](init);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mountLoaded(list) {
  routes['GET /auth/webauthn/passkeys'] = () => [200, list];
  const wrapper = mount(PasskeySettings);
  await flushPromises();
  return wrapper;
}

const button = (wrapper, text, within = wrapper) => {
  const found = within.findAll('button').find((b) => b.text() === text);
  if (!found) throw new Error(`no "${text}" button`);
  return found;
};

describe('PasskeySettings', () => {
  it('lists the passkeys from GET /auth/webauthn/passkeys, labelled by sync status, with dates', async () => {
    const wrapper = await mountLoaded({ passkeys: [SYNCED, BOUND], hasPassword: true });

    expect(calls.map((c) => c.key)).toEqual(['GET /auth/webauthn/passkeys']);
    const [synced, bound] = wrapper.findAll('.passkey-item');
    expect(synced.text()).toContain('Synced passkey');
    expect(synced.text()).toContain(`Added ${day(SYNCED.createdAt)}`);
    expect(synced.text()).toContain(`last used ${day(SYNCED.lastUsedAt)}`);
    expect(bound.text()).toContain('This device only');
    expect(bound.text()).toContain('no sign-in recorded');
  });

  it('says so when there are none, and still offers to add one', async () => {
    const wrapper = await mountLoaded({ passkeys: [], hasPassword: true });

    expect(wrapper.text()).toContain('No passkeys yet.');
    expect(button(wrapper, 'Add a passkey on this device').element.disabled).toBe(false);
  });

  it('adds a passkey on this device through the register routes, then lists it', async () => {
    let lists = [{ passkeys: [SYNCED], hasPassword: true }, { passkeys: [SYNCED, BOUND], hasPassword: true }];
    routes['GET /auth/webauthn/passkeys'] = () => [200, lists.shift()];
    routes['POST /auth/webauthn/register/begin'] = () => [200, { challenge: 'server-challenge' }];
    routes['POST /auth/webauthn/register/complete'] = () => [200, { ok: true }];
    startRegistration.mockResolvedValue({ id: BOUND.credentialID, type: 'public-key' });
    const wrapper = mount(PasskeySettings);
    await flushPromises();

    await button(wrapper, 'Add a passkey on this device').trigger('click');
    await flushPromises();

    expect(calls.map((c) => c.key)).toEqual([
      'GET /auth/webauthn/passkeys',
      'POST /auth/webauthn/register/begin',
      'POST /auth/webauthn/register/complete',
      'GET /auth/webauthn/passkeys',
    ]);
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: 'server-challenge' } });
    expect(JSON.parse(calls[2].body)).toEqual({ id: BOUND.credentialID, type: 'public-key' });
    expect(wrapper.findAll('.passkey-item')).toHaveLength(2);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('treats a dismissed prompt as no error, and names a device that already has one', async () => {
    routes['POST /auth/webauthn/register/begin'] = () => [200, { challenge: 'c' }];
    const wrapper = await mountLoaded({ passkeys: [SYNCED], hasPassword: true });

    startRegistration.mockRejectedValueOnce(Object.assign(new Error('dismissed'), { name: 'NotAllowedError' }));
    await button(wrapper, 'Add a passkey on this device').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);

    startRegistration.mockRejectedValueOnce(Object.assign(new Error('exists'), {
      name: 'InvalidStateError', code: 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED',
    }));
    await button(wrapper, 'Add a passkey on this device').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('This device already has a passkey for your account.');
    expect(calls.some((c) => c.key === 'POST /auth/webauthn/register/complete')).toBe(false);
  });

  it('removes a passkey with DELETE /auth/webauthn/passkeys/:credentialID, only after a confirmation', async () => {
    routes[`DELETE /auth/webauthn/passkeys/${BOUND.credentialID}`] = () => [200, { passkeys: [SYNCED], hasPassword: true }];
    const wrapper = await mountLoaded({ passkeys: [SYNCED, BOUND], hasPassword: true });
    const bound = wrapper.findAll('.passkey-item')[1];

    await button(wrapper, 'Remove', bound).trigger('click');
    expect(calls.some((c) => c.key.startsWith('DELETE'))).toBe(false);

    await button(wrapper, 'Remove', wrapper.findAll('.passkey-item')[1]).trigger('click');
    await flushPromises();

    expect(calls.at(-1).key).toBe(`DELETE /auth/webauthn/passkeys/${BOUND.credentialID}`);
    const items = wrapper.findAll('.passkey-item');
    expect(items).toHaveLength(1);
    expect(items[0].text()).toContain('Synced passkey');
  });

  it("shows the server's refusal to remove the last way in", async () => {
    const refusal = 'This passkey is the only way to sign in to this account. Add another before removing it.';
    routes[`DELETE /auth/webauthn/passkeys/${SYNCED.credentialID}`] = () => [409, { error: refusal }];
    const wrapper = await mountLoaded({ passkeys: [SYNCED, BOUND], hasPassword: false });

    await button(wrapper, 'Remove', wrapper.findAll('.passkey-item')[0]).trigger('click');
    await button(wrapper, 'Remove', wrapper.findAll('.passkey-item')[0]).trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toBe(refusal);
    expect(wrapper.findAll('.passkey-item')).toHaveLength(2);
  });

  it("disables Remove on a passwordless account's only passkey", async () => {
    const wrapper = await mountLoaded({ passkeys: [SYNCED], hasPassword: false });

    expect(button(wrapper, 'Remove').element.disabled).toBe(true);
  });
});
