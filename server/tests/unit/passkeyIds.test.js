/**
 * Unit tests for src/lib/passkeyIds.js: how a stored passkey id is matched
 * against the id a browser sends, and how the legacy form is repaired.
 *
 * KOL-024: registration stored `Buffer.from(credential.id).toString('base64url')`,
 * which base64url-encodes an id that @simplewebauthn/server 13 already returns
 * as base64url. Every lookup compares against the browser's own id, so no
 * passkey was ever recognized. These tests pin the three things the fix rests
 * on:
 *   - a new registration stores the browser's id itself;
 *   - a lookup finds a stored id in either form, and exactly one passkey;
 *   - the lazy rewrite turns a legacy value into the correct one, once, and
 *     leaves a correct one alone.
 * KOL-043 adds the fourth: the two queries are different questions. The sign-in
 * lookup (credentialIdQuery) asks for two stored forms; registration's
 * duplicate check (credentialConflictQuery) asks for three, because an
 * authenticator picks its own raw bytes and a new id can be the legacy
 * encoding of an id already on file.
 * The same functions run over HTTP, against the real library, in
 * tests/http/passkeys.test.js.
 *
 * Plain objects stand in for the User's passkey subdocuments: the functions
 * only read and assign fields, so a database would add nothing here.
 *
 * Falsification checks: re-encode `credential.id` in passkeyFromRegistration
 * and the registration → lookup test fails; drop the legacy branch of
 * matchCredentialId and the legacy tests fail; make migrateCredentialId rewrite
 * unconditionally and the "correct value untouched" test fails on its return
 * value; drop the round-trip check in browserCredentialId and the
 * random-id test misreads correct ids as legacy; drop the decoded form from
 * credentialConflictQuery and the both-directions test fails, leaving the
 * duplicate check open to KOL-043.
 *
 * Logging: the rewrite logs on PASSKEY_LOG_LEVEL, silenced here unless set.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import {
  browserCredentialId,
  credentialConflictQuery,
  credentialDescriptors,
  credentialIdQuery,
  findPasskey,
  legacyEncoding,
  matchCredentialId,
  migrateCredentialId,
  passkeyFromRegistration,
  webAuthnCredential,
} from '../../src/lib/passkeyIds.js';

process.env.PASSKEY_LOG_LEVEL ??= 'off';

/** A credential id as a browser sends it: base64url of 16 random bytes, the spec's minimum. */
const newBrowserId = () => randomBytes(16).toString('base64url');

const CONTEXT = { userId: 'user-under-test', source: 'tests/unit/passkeyIds' };

describe('matchCredentialId', () => {
  test('names the form a stored id is in, relative to the browser id', () => {
    const id = newBrowserId();
    assert.equal(matchCredentialId(id, id), 'current');
    assert.equal(matchCredentialId(legacyEncoding(id), id), 'legacy');
    assert.equal(matchCredentialId(newBrowserId(), id), null, 'another credential');
    assert.equal(matchCredentialId(legacyEncoding(newBrowserId()), id), null, "another credential's legacy form");
  });

  test('the legacy form is the pre-KOL-024 registration expression, byte for byte', () => {
    const id = newBrowserId();
    assert.equal(legacyEncoding(id), Buffer.from(id).toString('base64url'));
  });

  test('a missing or non-string id matches nothing', () => {
    const id = newBrowserId();
    for (const browserId of [undefined, null, '', 42, { $ne: '' }, [id]]) {
      assert.equal(matchCredentialId(id, browserId), null, JSON.stringify(browserId));
    }
    assert.equal(matchCredentialId(undefined, id), null);
  });
});

describe('findPasskey and migrateCredentialId (the lazy rewrite)', () => {
  test('a legacy value matches once and is rewritten to the browser id', () => {
    const id = newBrowserId();
    const passkeys = [{ credentialID: legacyEncoding(id), counter: 3 }];

    const found = findPasskey(passkeys, id);
    assert.equal(found?.passkey, passkeys[0]);
    assert.equal(found.legacy, true);

    assert.equal(migrateCredentialId(found, id, CONTEXT), true, 'a legacy match must be rewritten');
    assert.equal(passkeys[0].credentialID, id, 'rewritten to exactly what the browser sends');
    assert.equal(passkeys[0].counter, 3, 'the rewrite touches the id only');

    const again = findPasskey(passkeys, id);
    assert.equal(again?.passkey, passkeys[0], 'the rewritten passkey still matches');
    assert.equal(again.legacy, false, 'and now in the current form');
    assert.equal(migrateCredentialId(again, id, CONTEXT), false, 'a second sign-in rewrites nothing');
  });

  test('a correct value matches untouched', () => {
    const id = newBrowserId();
    const passkeys = [{ credentialID: id }];

    const found = findPasskey(passkeys, id);
    assert.equal(found?.passkey, passkeys[0]);
    assert.equal(found.legacy, false);
    assert.equal(migrateCredentialId(found, id, CONTEXT), false);
    assert.equal(passkeys[0].credentialID, id);
  });

  test('finds the one passkey the browser names among several, and none for a stranger', () => {
    const [a, b, c] = [newBrowserId(), newBrowserId(), newBrowserId()];
    const passkeys = [{ credentialID: a }, { credentialID: legacyEncoding(b) }, { credentialID: c }];

    assert.equal(findPasskey(passkeys, b)?.passkey, passkeys[1]);
    assert.equal(findPasskey(passkeys, c)?.passkey, passkeys[2]);
    assert.equal(findPasskey(passkeys, newBrowserId()), null);
    assert.equal(findPasskey([], a), null);
    assert.equal(findPasskey(undefined, a), null);
  });

  test('credentialIdQuery asks for both stored forms', () => {
    const id = newBrowserId();
    assert.deepEqual(credentialIdQuery(id), { 'passkeys.credentialID': { $in: [id, legacyEncoding(id)] } });
  });
});

describe('credentialConflictQuery (registration\'s duplicate check, KOL-043)', () => {
  /** The stored values `query` would match. */
  const forms = (query) => query['passkeys.credentialID'].$in;

  test('an ordinary new id asks for its own two forms, and nothing else', () => {
    const id = newBrowserId();
    assert.deepEqual(forms(credentialConflictQuery(id)), [id, legacyEncoding(id)]);
  });

  test('an id that is itself a legacy encoding also asks for the id it encodes', () => {
    // What an authenticator reports when it picks raw credential-id bytes
    // equal to utf8(victimId): the browser names them legacyEncoding(victimId).
    const victimId = newBrowserId();
    const crafted = legacyEncoding(victimId);
    assert.deepEqual(forms(credentialConflictQuery(crafted)), [crafted, legacyEncoding(crafted), victimId]);
  });

  test('either id blocks the other, whichever was stored first', () => {
    // The property the check rests on: if a sign-in could resolve to both rows,
    // the second registration must be refused — from either direction.
    const victimId = newBrowserId();
    const crafted = legacyEncoding(victimId);

    assert.ok(forms(credentialConflictQuery(crafted)).includes(victimId),
      'a current-form id on file must block the crafted id that decodes to it');
    assert.ok(forms(credentialConflictQuery(victimId)).includes(crafted),
      'the crafted id on file must block the current-form id it decodes to');

    // Which is exactly the pair a sign-in for victimId matches, so no stored
    // value can be ambiguous and unblocked.
    assert.deepEqual(forms(credentialIdQuery(victimId)), [victimId, crafted]);
  });

  test('a stranger\'s id is not asked for', () => {
    const id = newBrowserId();
    const stranger = newBrowserId();
    for (const value of [stranger, legacyEncoding(stranger)]) {
      assert.ok(!forms(credentialConflictQuery(id)).includes(value), value);
      assert.ok(!forms(credentialConflictQuery(legacyEncoding(id))).includes(value), value);
    }
  });
});

describe('registration → lookup', () => {
  test('a registration is stored under the id the browser will sign in with', () => {
    const id = newBrowserId();
    // The shape @simplewebauthn/server 13's verifyRegistrationResponse returns.
    const registrationInfo = {
      credential: { id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal', 'hybrid'] },
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
    };

    const stored = passkeyFromRegistration(registrationInfo);
    assert.equal(stored.credentialID, id, 'stored as-is, not encoded again');
    assert.deepEqual(stored.publicKey, Buffer.from([1, 2, 3]));
    assert.equal(stored.counter, 0);
    assert.deepEqual(stored.transports, ['internal', 'hybrid']);
    assert.equal(stored.deviceType, 'multiDevice');
    assert.equal(stored.backedUp, true);
    assert.ok(stored.createdAt instanceof Date);

    const found = findPasskey([stored], id);
    assert.equal(found?.passkey, stored, 'the browser id must find the passkey just registered');
    assert.equal(found.legacy, false);
  });

  test('transports default to an empty list', () => {
    const registrationInfo = {
      credential: { id: newBrowserId(), publicKey: new Uint8Array([1]), counter: 0 },
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
    };
    assert.deepEqual(passkeyFromRegistration(registrationInfo).transports, []);
  });

  test("the credential given to verifyAuthenticationResponse carries the browser's base64url id, not a Buffer", () => {
    const id = newBrowserId();
    const credential = webAuthnCredential({ credentialID: legacyEncoding(id), publicKey: Buffer.from([9, 8]), counter: 4, transports: ['usb'] }, id);
    assert.equal(credential.id, id);
    assert.equal(typeof credential.id, 'string');
    assert.ok(credential.publicKey instanceof Uint8Array);
    assert.deepEqual([...credential.publicKey], [9, 8]);
    assert.equal(credential.counter, 4);
    assert.deepEqual(credential.transports, ['usb']);
  });
});

describe('browserCredentialId and credentialDescriptors (the ids offered to the browser)', () => {
  test('decodes a legacy value to the browser id and leaves a correct one alone', () => {
    const id = newBrowserId();
    assert.equal(browserCredentialId(legacyEncoding(id)), id);
    assert.equal(browserCredentialId(id), id);
  });

  test('never mistakes a correct id for a legacy one across 10,000 random ids', () => {
    // A correct id is misread only when every raw byte is a base64url
    // character: (1/4)^16 per 16-byte id, so a failure here means the check
    // broke, not bad luck.
    for (let i = 0; i < 10_000; i++) {
      const id = newBrowserId();
      assert.equal(browserCredentialId(id), id, `misread ${id} as legacy`);
    }
  });

  test('offers every passkey in the form the browser matches on, with its transports', () => {
    const [a, b] = [newBrowserId(), newBrowserId()];
    const passkeys = [
      { credentialID: a, transports: ['internal'] },
      { credentialID: legacyEncoding(b), transports: ['hybrid', 'usb'] },
    ];
    assert.deepEqual(credentialDescriptors(passkeys), [
      { id: a, transports: ['internal'] },
      { id: b, transports: ['hybrid', 'usb'] },
    ]);
    assert.deepEqual(credentialDescriptors(undefined), []);
  });
});
