/**
 * Passkey credential ids: the one form they are stored in, and a lazy repair
 * for the form they used to be stored in.
 *
 * A WebAuthn credential id is raw bytes. The browser names it by their
 * base64url encoding (`id` in what @simplewebauthn/browser's
 * startAuthentication() returns), and @simplewebauthn/server 13 returns
 * `registrationInfo.credential.id` as that same string. That string is what is
 * stored, so a stored id and a browser's id compare with `===`. It is also the
 * form `allowCredentials`, `excludeCredentials` and the `credential.id` given
 * to verifyAuthenticationResponse all expect.
 *
 * Until KOL-024, POST /auth/webauthn/register/complete stored
 * `Buffer.from(credential.id).toString('base64url')`: the base64url string
 * encoded a second time, as text. No browser ever sends that, so every passkey
 * registered then was answered "Passkey not recognized". Those values are
 * still in the database. There is no migration script. Every lookup here
 * accepts both forms instead, and a verified assertion against a legacy value
 * rewrites it to the correct one (migrateCredentialId). Each legacy passkey is
 * repaired the first time it is used.
 *
 * Matching against an id the browser sent (findPasskey) is exact. Building
 * `allowCredentials` has no browser id to compare with, so it decides the form
 * from the stored value alone (browserCredentialId): a legacy value decodes to
 * text that is itself base64url. A correct id does that only if every one of
 * its raw bytes happens to be one of the 64 base64url characters, a chance of
 * (64/256)^n for an n-byte id. That is under 2^-32 for the 16 bytes the spec
 * sets as the minimum.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * PASSKEY_LOG_LEVEL = off | light | normal | verbose (default light). Account
 * ids only, never an email. Credential ids are public identifiers, not
 * secrets, but they still appear only at verbose, and only their first
 * characters.
 *   light   — every change to a stored passkey (added, removed, rewritten from
 *             the legacy form, or its sync status changed), each naming the
 *             request that made it
 *   normal  — light, plus every sign-in lookup: recognized (and in which
 *             form), not recognized, or refused by verification; and every
 *             refused removal
 *   verbose — normal, plus the credential ids looked up, offered and removed,
 *             and each listing
 */

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

export function logPasskey(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.PASSKEY_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[auth/passkey:${level}] ${msg}`);
}

/** The first characters of a credential id: enough to tell two apart in a log. */
export function shortId(id) {
  return typeof id === 'string' ? `${id.slice(0, 8)}…` : `<${typeof id}>`;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The legacy stored form of a browser's credential id: its base64url text, base64url-encoded again. */
export function legacyEncoding(browserId) {
  return Buffer.from(browserId, 'utf8').toString('base64url');
}

/** How `stored` names the credential a browser calls `browserId`: 'current', 'legacy', or null for neither. */
export function matchCredentialId(stored, browserId) {
  if (typeof stored !== 'string' || typeof browserId !== 'string' || !browserId) return null;
  if (stored === browserId) return 'current';
  if (stored === legacyEncoding(browserId)) return 'legacy';
  return null;
}

/**
 * The passkey in `passkeys` that the browser calls `browserId`, with whether it
 * is stored in the legacy form, as `{ passkey, legacy }`. Null when none is.
 */
export function findPasskey(passkeys, browserId) {
  for (const passkey of passkeys ?? []) {
    const form = matchCredentialId(passkey.credentialID, browserId);
    if (form) return { passkey, legacy: form === 'legacy' };
  }
  return null;
}

/** A User filter for the account holding `browserId` in either stored form. `browserId` must be a non-empty string. */
export function credentialIdQuery(browserId) {
  return { 'passkeys.credentialID': { $in: [browserId, legacyEncoding(browserId)] } };
}

/**
 * The lazy migration. Call it only after the assertion has verified: it
 * rewrites a legacy stored id, in place, to the browser's. The caller saves the
 * user. Returns true when it changed something.
 */
export function migrateCredentialId(found, browserId, { userId, source }) {
  if (!found?.legacy) return false;
  found.passkey.credentialID = browserId;
  found.legacy = false;
  logPasskey('light', `user ${userId}: passkey id rewritten from the legacy double-encoded form (source: ${source})`);
  return true;
}

/** The id a browser knows a stored credential by: a legacy value decoded, a correct one as it is. */
export function browserCredentialId(stored) {
  if (typeof stored !== 'string') return stored;
  const decoded = Buffer.from(stored, 'base64url').toString('utf8');
  return BASE64URL.test(decoded) && legacyEncoding(decoded) === stored ? decoded : stored;
}

/** `allowCredentials` / `excludeCredentials` entries for `passkeys`, in the form the browser matches on. */
export function credentialDescriptors(passkeys) {
  return (passkeys ?? []).map(pk => ({ id: browserCredentialId(pk.credentialID), transports: pk.transports }));
}

/**
 * Records a verified assertion on the passkey that made it: its counter, when
 * it was used, and the backup state the authenticator reports now. That state
 * fills in passkeys registered before KOL-024 recorded it, and follows one
 * that has since been synced. The caller saves the user.
 */
export function recordUse(passkey, authenticationInfo, { userId, source }) {
  const { newCounter, credentialDeviceType, credentialBackedUp } = authenticationInfo;
  passkey.counter = newCounter;
  passkey.lastUsedAt = new Date();
  if (passkey.deviceType === credentialDeviceType && passkey.backedUp === credentialBackedUp) return;
  logPasskey('light', `user ${userId}: passkey sync status ${passkey.deviceType ?? 'unrecorded'}${passkey.backedUp ? ', backed up' : ''} → ${credentialDeviceType}${credentialBackedUp ? ', backed up' : ''} (source: ${source})`);
  passkey.deviceType = credentialDeviceType;
  passkey.backedUp = credentialBackedUp;
}

/**
 * What Settings shows of a passkey, by the id the browser knows it by. A list
 * of fields rather than the stored document minus some, so a field added to
 * the schema later, like the public key now, stays on the server.
 */
export function passkeySummary(passkey) {
  return {
    credentialID: browserCredentialId(passkey.credentialID),
    deviceType: passkey.deviceType ?? null,
    backedUp: passkey.backedUp ?? null,
    createdAt: passkey.createdAt ?? null,
    lastUsedAt: passkey.lastUsedAt ?? null,
  };
}

/** The `credential` verifyAuthenticationResponse takes for `passkey`, which the browser calls `browserId`. */
export function webAuthnCredential(passkey, browserId) {
  return {
    id: browserId,
    publicKey: new Uint8Array(passkey.publicKey),
    counter: passkey.counter,
    transports: passkey.transports,
  };
}

/** The passkey to store for a verified registration's `registrationInfo`. */
export function passkeyFromRegistration(registrationInfo) {
  const { credential, credentialDeviceType, credentialBackedUp } = registrationInfo;
  return {
    // Already the base64url string the browser sends. Stored as-is: see the top of this file.
    credentialID: credential.id,
    publicKey: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ?? [],
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    createdAt: new Date(),
  };
}
