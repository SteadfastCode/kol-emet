/**
 * A software WebAuthn authenticator for the server tests. It answers the
 * server's own registration and authentication options with real objects: a
 * 'none' attestation and a signed assertion, made with a real P-256 key, in the
 * JSON shape @simplewebauthn/browser's startRegistration() and
 * startAuthentication() return. Nothing on the server is stubbed, so
 * @simplewebauthn/server parses and verifies these exactly as it would a
 * browser's.
 *
 * Like a browser, it refuses to register when `excludeCredentials` names it,
 * and refuses to assert when a non-empty `allowCredentials` does not. A server
 * that offers ids in the wrong form therefore fails here the way it fails on a
 * real device.
 *
 * Byte layouts follow WebAuthn Level 3: §6.1 authenticator data, §6.5.4 the
 * attestation object, §6.3.3 the assertion signature over
 * authData ‖ SHA-256(clientDataJSON).
 */

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

// Authenticator-data flag bits (§6.1).
const UP = 0x01; // user present
const UV = 0x04; // user verified
const BE = 0x08; // backup eligible: a synced, "multi-device" credential
const BS = 0x10; // backed up
const AT = 0x40; // attested credential data follows

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const sha256 = (data) => createHash('sha256').update(data).digest();

/**
 * @param {object} opts
 * @param {string} opts.origin  the page origin a browser would report
 * @param {boolean} [opts.synced=true]  backup-eligible and backed up, as a
 *   synced passkey is; false for a device-bound one
 * @param {string} [opts.id]  reuse a credential id (base64url): an impostor
 *   that holds someone else's id but not their key
 */
export function createSoftAuthenticator({ origin, synced = true, id } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { x, y } = publicKey.export({ format: 'jwk' });
  const rawId = id ? Buffer.from(id, 'base64url') : randomBytes(16);
  const credentialId = b64url(rawId);
  const flags = UP | UV | (synced ? BE | BS : 0);
  let signCount = 0;

  function authenticatorData(rpId, extraFlags = 0, attested = Buffer.alloc(0)) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(signCount);
    return Buffer.concat([sha256(rpId), Buffer.from([flags | extraFlags]), counter, attested]);
  }

  const clientDataJSON = (type, challenge) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

  const refuse = (name, message) => Object.assign(new Error(message), { name });

  return {
    /** The credential id as a browser reports it: base64url of the raw bytes. */
    id: credentialId,

    /** A RegistrationResponseJSON answering `options` from /auth/webauthn/register/begin. */
    register(options) {
      if (options.excludeCredentials?.some(c => c.id === credentialId)) {
        throw refuse('InvalidStateError', 'this authenticator is already registered (named in excludeCredentials)');
      }
      const rpId = options.rp?.id ?? new URL(origin).hostname;
      const coseKey = new Map([
        [1, 2],   // kty: EC2
        [3, -7],  // alg: ES256
        [-1, 1],  // crv: P-256
        [-2, new Uint8Array(Buffer.from(x, 'base64url'))],
        [-3, new Uint8Array(Buffer.from(y, 'base64url'))],
      ]);
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(rawId.length);
      const attested = Buffer.concat([Buffer.alloc(16) /* AAGUID */, idLength, rawId, Buffer.from(isoCBOR.encode(coseKey))]);
      const attestationObject = isoCBOR.encode(new Map([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', new Uint8Array(authenticatorData(rpId, AT, attested))],
      ]));
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        response: {
          clientDataJSON: b64url(clientDataJSON('webauthn.create', options.challenge)),
          attestationObject: b64url(attestationObject),
          transports: ['internal'],
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },

    /** An AuthenticationResponseJSON answering `options` from a sign-in or deletion challenge. */
    assert(options) {
      if (options.allowCredentials?.length && !options.allowCredentials.some(c => c.id === credentialId)) {
        throw refuse('NotAllowedError', `allowCredentials does not name this authenticator (offered: ${options.allowCredentials.map(c => c.id).join(', ')})`);
      }
      const rpId = options.rpId ?? new URL(origin).hostname;
      signCount += 1;
      const authData = authenticatorData(rpId);
      const clientData = clientDataJSON('webauthn.get', options.challenge);
      // ES256 assertion signatures are DER-encoded, which is node's default for EC keys.
      const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), privateKey);
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        response: {
          clientDataJSON: b64url(clientData),
          authenticatorData: b64url(authData),
          signature: b64url(signature),
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },
  };
}
