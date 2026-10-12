/**
 * Unit tests for src/lib/passwordPolicy.js: the boundary, and the shape of the
 * answer every caller passes straight back to a user.
 *
 * The route-level behaviour — that `POST /auth/register` and
 * `POST /auth/password` both ask this, that `POST /auth/login` never does, and
 * that a refusal stores nothing — is in tests/http/password.test.js. What is
 * pinned here is the rule itself: twelve, counted in characters, with nothing
 * else asked of the value.
 *
 * Falsification checks: write the comparison as `<=` and the twelve-character
 * case fails; count `value.length` instead of code points and the astral
 * passphrase (six characters, twelve UTF-16 units) passes when it must not;
 * add a composition rule and the twelve-space and all-lowercase cases fail.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { PASSWORD_MIN_LENGTH, passwordProblem } from '../../src/lib/passwordPolicy.js';

describe('passwordProblem', () => {
  test('the minimum is twelve characters', () => {
    assert.equal(PASSWORD_MIN_LENGTH, 12);
  });

  test('eleven characters is refused and twelve is accepted', () => {
    const eleven = 'a'.repeat(11);
    const twelve = 'a'.repeat(12);

    assert.equal(passwordProblem(eleven), 'A password must be at least 12 characters.');
    assert.equal(passwordProblem(twelve), null, 'the minimum itself must be allowed');
    assert.equal(passwordProblem('a'.repeat(13)), null);
    // Every rung below the boundary, including the one-character password that
    // was valid before this module existed.
    for (let n = 1; n < PASSWORD_MIN_LENGTH; n++) {
      assert.ok(passwordProblem('a'.repeat(n)), `${n} characters must be refused`);
    }
  });

  test('a missing or non-string value is refused, with the sentence for a missing one', () => {
    for (const value of [undefined, null, '', 0, 12, {}, [], { $ne: '' }, true]) {
      assert.equal(passwordProblem(value), 'A password is required.', `${JSON.stringify(value) ?? String(value)} is not a password`);
    }
  });

  test('length is the only rule: no composition, no maximum', () => {
    // All one case, all digits, all whitespace, and a passphrase: NIST
    // SP 800-63B asks for length and nothing else, so each of these passes.
    assert.equal(passwordProblem('aaaaaaaaaaaa'), null);
    assert.equal(passwordProblem('123456789012'), null);
    assert.equal(passwordProblem(' '.repeat(12)), null);
    assert.equal(passwordProblem('correct horse battery staple'), null);
    // No maximum, deliberately: bcrypt reads the first 72 bytes and both
    // callers hash the same way, so a long passphrase still signs in.
    assert.equal(passwordProblem('x'.repeat(500)), null);
  });

  test('counts characters, not UTF-16 units', () => {
    // Six code points, twelve units. A rule counting `.length` would pass it.
    const sixAstral = '😀'.repeat(6);
    assert.equal(sixAstral.length, 12);
    assert.equal([...sixAstral].length, 6);
    assert.ok(passwordProblem(sixAstral), 'six characters must be refused however they are encoded');

    assert.equal(passwordProblem('😀'.repeat(12)), null);
  });

  test('the answer is one sentence, written for whoever typed it', () => {
    const problem = passwordProblem('short');
    assert.equal(typeof problem, 'string');
    assert.match(problem, /^[A-Z].*\.$/, 'a route answers this straight back as { error }');
    assert.ok(problem.includes(String(PASSWORD_MIN_LENGTH)), 'and it has to say what the minimum is');
  });
});
