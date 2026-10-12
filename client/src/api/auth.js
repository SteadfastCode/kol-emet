import { startRegistration, startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { signalUnknownCredential } from './passkeySignals.js';

const BASE_URL = import.meta.env.VITE_API_URL ?? '';

async function req(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  if (!res.ok) throw Object.assign(new Error(`${res.status}`), { status: res.status });
  return res.json();
}

/**
 * The templates a new workspace can start from, `[{ key, name, description }]`
 * with the default first. Public: the signup form asks before there is a session.
 */
export const getTemplates = () =>
  req('/templates');

/**
 * `template` is a key from getTemplates(); left out, the server seeds its
 * default. `workspaceName` names the new workspace (KOL-071); left out, the
 * server's default ("My Workspace") stands. Both are omitted from the body
 * rather than sent empty: the server tells a missing field from an unusable
 * one, and only the second is a 400.
 */
export const register = (email, password, template, workspaceName) =>
  req('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      ...(template && { template }),
      ...(workspaceName && { workspaceName }),
    }),
  });

export const login = (email, password) =>
  req('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });

export const logout = () =>
  req('/auth/logout', { method: 'POST' });

export const getSession = () =>
  req('/auth/me');

export async function registerPasskey() {
  const options = await req('/auth/webauthn/register/begin', { method: 'POST' });
  const credential = await startRegistration({ optionsJSON: options });
  return req('/auth/webauthn/register/complete', {
    method: 'POST',
    body: JSON.stringify(credential),
  });
}

export const passkeysSupported = () => browserSupportsWebAuthn();

/**
 * Like req(), but a refusal keeps the server's message and, on a 409, the
 * workspaces that blocked it — account deletion shows both to the user,
 * passkey management shows the message, and the passkey sign-in below tells
 * one 401 from the other by it.
 */
async function accountReq(path, options) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    throw Object.assign(new Error(body?.error ?? `${res.status}`), {
      status: res.status,
      memberships: body?.memberships ?? [],
    });
  }
  return body;
}

/**
 * The shortest password `POST /auth/register` and `POST /auth/password` will
 * store, mirroring the server's rule (server/src/lib/passwordPolicy.js). Stated
 * at both forms so a user is told before they submit; the server is what
 * enforces it, and its sentence is what a refusal shows.
 */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Whether `value` is too short for the forms to send. Counted in code points,
 * as the server counts, so an emoji passphrase is as long here as it is there.
 */
export const passwordTooShort = (value) =>
  [...(value ?? '')].length < PASSWORD_MIN_LENGTH;

/**
 * Tiered debug logging for the password change: set
 * localStorage.PASSWORD_LOG_LEVEL to off | light | normal | verbose (default
 * light). The server logs the same change on its own PASSWORD_LOG_LEVEL.
 * **Neither password is ever logged, nor its length** — only what asked for the
 * change and how it ended.
 *   light   — every change sent from here and how it ended, naming what asked
 *             and which credential confirmed it
 *   normal  — light, plus the passkey challenge being fetched
 *   verbose — normal, plus the status a refusal carried
 */
const PASSWORD_LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logPasswordChange(level, msg) {
  let configured;
  try { configured = localStorage.getItem('PASSWORD_LOG_LEVEL'); } catch { configured = null; }
  const active = PASSWORD_LEVELS[configured] ?? PASSWORD_LEVELS.light;
  if (active >= PASSWORD_LEVELS[level]) console.log(`[auth/password:${level}] ${msg}`);
}

/** Sends one change and logs how it ended; `confirmedWith` names the credential. */
async function postPasswordChange(body, { source, confirmedWith }) {
  const asked = `source: ${source ?? 'POST /auth/password'}, confirmed with ${confirmedWith}`;
  try {
    const result = await accountReq('/auth/password', { method: 'POST', body: JSON.stringify(body) });
    logPasswordChange('light', `password changed (${asked})`);
    return result;
  } catch (err) {
    logPasswordChange('light', `password change refused: ${err.message} (${asked})`);
    logPasswordChange('verbose', `the refusal carried status ${err.status ?? 'none'} (${asked})`);
    throw err;
  }
}

/**
 * Replaces the signed-in account's password, re-authenticating with the current
 * one. Session only — a connector token is refused — and a wrong current
 * password is 403 rather than 401, so a client must not read it as a sign-out
 * (see docs/api.md#password). Through accountReq, because the server's own
 * sentence is what Settings shows: it says whether the current password was
 * wrong or the new one too short.
 */
export const changePassword = ({ currentPassword, newPassword }, { source } = {}) =>
  postPasswordChange({ currentPassword, newPassword }, { source, confirmedWith: 'the current password' });

/**
 * The same change, re-authenticated with a passkey instead: a challenge of this
 * route's own (never the sign-in or deletion one), asserted once. This is how an
 * account with no password of its own sets one.
 */
export async function changePasswordWithPasskey(newPassword, { source } = {}) {
  logPasswordChange('normal', `fetching a passkey challenge for a password change (source: ${source ?? 'POST /auth/password'})`);
  const options = await accountReq('/auth/password/passkey-challenge', { method: 'POST' });
  const passkey = await startAuthentication({ optionsJSON: options });
  return postPasswordChange({ newPassword, passkey }, { source, confirmedWith: 'a passkey' });
}

export const deleteAccount = ({ email, password }) =>
  accountReq('/auth/account', { method: 'DELETE', body: JSON.stringify({ email, password }) });

export async function deleteAccountWithPasskey(email) {
  const options = await accountReq('/auth/account/passkey-challenge', { method: 'POST' });
  const passkey = await startAuthentication({ optionsJSON: options });
  return accountReq('/auth/account', { method: 'DELETE', body: JSON.stringify({ email, passkey }) });
}

/**
 * `{ passkeys, hasPassword, userHandle, rpId }`: the signed-in user's passkeys
 * as Settings lists them, plus what a Signal API call needs to name the
 * account to an authenticator (see api/passkeySignals.js).
 */
export const listPasskeys = () =>
  accountReq('/auth/webauthn/passkeys', { method: 'GET' });

/** Removes one of the signed-in user's passkeys; answers the list as it now stands. */
export const removePasskey = (credentialID) =>
  accountReq(`/auth/webauthn/passkeys/${encodeURIComponent(credentialID)}`, { method: 'DELETE' });

// What POST /auth/webauthn/login/complete answers when no account holds the
// credential, as opposed to the other 401 — an assertion that did not verify,
// where the credential is real and signalling it unknown would wrongly take a
// working passkey out of the authenticator. Pinned by a server test, since
// matching on the message is what couples the two.
const NOT_RECOGNIZED = 'Passkey not recognized';

const LOGIN_SOURCE = 'POST /auth/webauthn/login/complete';

export async function loginWithPasskey(email) {
  const options = await req('/auth/webauthn/login/begin', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  const credential = await startAuthentication({ optionsJSON: options });
  try {
    // accountReq, not req: this needs the server's message, below.
    return await accountReq('/auth/webauthn/login/complete', {
      method: 'POST',
      body: JSON.stringify(credential),
    });
  } catch (err) {
    // The authenticator offered a passkey the server does not have — removed
    // in Settings on another device, or on an account since deleted. Tell it
    // so, or it keeps offering it forever (KOL-052). `options.rpId` is the
    // relying party the challenge was issued for, not this page's host.
    if (err.status === 401 && err.message === NOT_RECOGNIZED) {
      await signalUnknownCredential({ rpId: options.rpId, credentialId: credential.id }, LOGIN_SOURCE);
    }
    throw err;
  }
}
