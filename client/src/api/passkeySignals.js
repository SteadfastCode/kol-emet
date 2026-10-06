/**
 * WebAuthn's Signal API: telling an authenticator what this account's
 * credentials actually are, so a passkey removed here stops being offered
 * (KOL-052, closing KOL-025's known gap).
 *
 * A passkey lives in the device or password manager that made it. Removing it
 * in Settings deletes the server's copy and nothing else, so the authenticator
 * keeps offering it and the sign-in it produces is answered "Passkey not
 * recognized" — a dead entry in the credential list with no way to clear it.
 * Two calls close that, each at the moment the server has just said which
 * credentials are real:
 *   - `signalAllAcceptedCredentials` after a removal: the ids still on the
 *     account, so the authenticator drops the rest.
 *   - `signalUnknownCredential` when a sign-in is refused as not recognized:
 *     the one id the server does not hold.
 *
 * Both need the relying party id and, for the first, the account's WebAuthn
 * user handle. Both come from the server's own answer rather than from
 * `location.hostname`: `WEBAUTHN_RP_ID` is what the ceremonies ran under, and
 * on a deployment where the client and the API sit on different hosts those
 * two are not the same string. A signal naming the wrong relying party reaches
 * nothing.
 *
 * Everything here is best-effort by design. The API is Chromium-only as of
 * today, so an absent one is the common case and must be a silent no-op, and a
 * throw from the authenticator must never surface as a failure of the removal
 * that already succeeded.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * localStorage.PASSKEY_LOG_LEVEL = off | light | normal | verbose (default
 * light), the same switch and tiers PasskeySettings.vue uses — a passkey
 * misbehaves on a particular phone, and the tiers are there to be turned up on
 * it.
 *   light   — every signal sent and every one skipped, naming the source
 *   normal  — light (the signals are themselves the change being logged)
 *   verbose — plus the first characters of the credential ids signalled
 */

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

/** Shared with PasskeySettings.vue, so one switch covers the whole passkey path. */
export function logPasskey(level, msg) {
  let setting = null;
  try { setting = localStorage.getItem('PASSKEY_LOG_LEVEL'); } catch { /* storage blocked */ }
  if ((LEVELS[setting] ?? LEVELS.light) >= LEVELS[level]) console.log(`[client/passkeys:${level}] ${msg}`);
}

const shortId = (id) => (typeof id === 'string' ? `${id.slice(0, 8)}…` : `<${typeof id}>`);

/** The static Signal API method, or null when this browser does not have it. */
function signalMethod(name) {
  const api = typeof window === 'undefined' ? undefined : window.PublicKeyCredential;
  return typeof api?.[name] === 'function' ? api[name].bind(api) : null;
}

/**
 * Sends one signal, or does nothing. Never throws and never returns a failure:
 * every caller has already finished the thing the user asked for.
 */
async function signal(name, options, source) {
  const send = signalMethod(name);
  if (!send) {
    logPasskey('light', `${name} skipped, this browser does not have it (source: ${source})`);
    return false;
  }
  try {
    await send(options);
    logPasskey('light', `${name} sent (source: ${source})`);
    return true;
  } catch (err) {
    // Includes a relying party the browser refuses to signal for, which is a
    // configuration problem worth a line and never a user-visible error.
    logPasskey('light', `${name} failed: ${err.name ?? ''} ${err.message} (source: ${source})`);
    return false;
  }
}

/**
 * The credentials this account still has. `credentialIDs` must be *every* one
 * of them: an authenticator may drop a credential this list does not name,
 * which is the point after a removal and would be data loss if the list were
 * partial. Does nothing without a user handle — an account registered before
 * KOL-052 has none, and its passkeys carry per-registration random handles
 * that no signal can reach anyway.
 */
export async function signalAcceptedCredentials({ rpId, userHandle, credentialIDs }, source) {
  if (!rpId || !userHandle || !Array.isArray(credentialIDs)) {
    logPasskey('light', `signalAllAcceptedCredentials skipped, no ${!rpId ? 'relying party' : !userHandle ? 'user handle' : 'credential list'} to name (source: ${source})`);
    return false;
  }
  logPasskey('verbose', `accepted ids: ${credentialIDs.map(shortId).join(', ') || 'none'} (source: ${source})`);
  return signal('signalAllAcceptedCredentials', {
    rpId,
    userId: userHandle,
    allAcceptedCredentialIds: credentialIDs,
  }, source);
}

/** One credential the server does not hold, so the authenticator can forget it. */
export async function signalUnknownCredential({ rpId, credentialId }, source) {
  if (!rpId || !credentialId) {
    logPasskey('light', `signalUnknownCredential skipped, no ${rpId ? 'credential' : 'relying party'} to name (source: ${source})`);
    return false;
  }
  logPasskey('verbose', `unknown id: ${shortId(credentialId)} (source: ${source})`);
  return signal('signalUnknownCredential', { rpId, credentialId }, source);
}
