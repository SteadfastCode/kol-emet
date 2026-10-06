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

/** `template` is a key from getTemplates(); left out, the server seeds its default. */
export const register = (email, password, template) =>
  req('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, ...(template && { template }) }) });

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
