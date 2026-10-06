/**
 * The passkey sign-in path, over the real api/passkeySignals.js. fetch and the WebAuthn prompt are
 * stubbed; the feature detection is not, so jsdom's missing `PublicKeyCredential` is the no-API
 * case exactly as a non-Chromium browser is.
 *
 * What this defends (KOL-052): an authenticator offering a passkey the server does not hold — one
 * removed in Settings on another device — is told so, and keeps offering it forever otherwise. The
 * asymmetry is the point: `signalUnknownCredential` asks the authenticator to forget a credential,
 * so it may be sent only for the 401 that means "no account holds this", never for the one that
 * means the assertion did not verify. That credential is real, and signalling it would take a
 * working passkey out of the user's password manager. The two are told apart by the server's
 * message, which server/tests/http/passkeys.test.js pins from the other side.
 *
 * Falsification: widen the branch to any 401 and the second test fails; drop the rpId from
 * login/begin's options in favour of location.hostname and the first one's expectation fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startAuthentication } from '@simplewebauthn/browser';
import { loginWithPasskey } from './auth.js';

vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
  browserSupportsWebAuthn: vi.fn(() => true),
}));

// The relying party the challenge was issued for: WEBAUTHN_RP_ID, which on this deployment is not
// the host the client is served from.
const RP_ID = 'kol-emet.danielecker.dev';
const CREDENTIAL_ID = 'cmVtb3ZlZC1lbHNld2hlcmU';

/** `{ 'METHOD /path': (init) => [status, body] }`, answered by the stubbed fetch. */
let routes;

beforeEach(() => {
  localStorage.setItem('PASSKEY_LOG_LEVEL', 'off');
  routes = {
    'POST /auth/webauthn/login/begin': () => [200, { challenge: 'server-challenge', rpId: RP_ID }],
  };
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const key = `${init.method ?? 'GET'} ${new URL(url, 'http://localhost').pathname}`;
    if (!routes[key]) throw new Error(`unexpected request: ${key}`);
    const [status, body] = routes[key](init);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }));
  startAuthentication.mockResolvedValue({ id: CREDENTIAL_ID, type: 'public-key' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Stubs `PublicKeyCredential.signalUnknownCredential` and answers the mock. */
function stubSignalApi(impl = async () => {}) {
  const signalUnknownCredential = vi.fn(impl);
  vi.stubGlobal('PublicKeyCredential', { signalUnknownCredential });
  return signalUnknownCredential;
}

const complete = (status, body) => { routes['POST /auth/webauthn/login/complete'] = () => [status, body]; };

describe('loginWithPasskey', () => {
  it('signs in and signals nothing', async () => {
    const signal = stubSignalApi();
    complete(200, { ok: true });

    await expect(loginWithPasskey('someone@example.test')).resolves.toEqual({ ok: true });
    expect(signal).not.toHaveBeenCalled();
  });

  it('tells the authenticator to forget a credential the server does not hold', async () => {
    const signal = stubSignalApi();
    complete(401, { error: 'Passkey not recognized' });

    await expect(loginWithPasskey('someone@example.test')).rejects.toMatchObject({ status: 401 });
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith({ rpId: RP_ID, credentialId: CREDENTIAL_ID });
  });

  it('signals nothing when the credential is real and the assertion failed', async () => {
    const signal = stubSignalApi();

    complete(401, { error: 'Passkey authentication failed' });
    await expect(loginWithPasskey('someone@example.test')).rejects.toMatchObject({ status: 401 });

    complete(400, { error: 'Unexpected authentication response challenge' });
    await expect(loginWithPasskey('someone@example.test')).rejects.toMatchObject({ status: 400 });

    complete(429, { error: 'Too many attempts. Try again later.' });
    await expect(loginWithPasskey('someone@example.test')).rejects.toMatchObject({ status: 429 });

    expect(signal).not.toHaveBeenCalled();
  });

  it('still reports the refusal when the browser has no Signal API, or it throws', async () => {
    expect(window.PublicKeyCredential).toBeUndefined();
    complete(401, { error: 'Passkey not recognized' });
    await expect(loginWithPasskey('someone@example.test')).rejects.toMatchObject({ status: 401 });

    const signal = stubSignalApi(async () => { throw new DOMException('nope', 'NotAllowedError'); });
    await expect(loginWithPasskey('someone@example.test')).rejects.toMatchObject({ status: 401 });
    expect(signal).toHaveBeenCalledTimes(1);
  });
});
