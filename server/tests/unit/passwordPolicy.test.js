/**
 * The product's one password rule (src/lib/passwordPolicy.js): a minimum
 * length, counted in code points, and nothing else.
 *
 * The boundary is the point of this file. 11 characters is refused and 12 is
 * accepted, so an off-by-one in either direction fails here rather than
 * shipping as "12 characters" meaning eleven. The rest pins what the rule
 * deliberately does *not* do: it asks for no digit, no symbol and no mixed
 * case (NIST SP 800-63B §3.1.1.2), it trims nothing, and it has no maximum —
 * every one of which, added later, would fail a test below rather than quietly
 * refusing passwords this product promised to accept.
 *
 * Where the rule is applied is pinned over HTTP in tests/http/password.test.js
 * (`POST /auth/register` and `POST /auth/password` refuse a short one) and by
 * the case there that sign-in never asks it, which is what keeps an account
 * registered before the minimum from being locked out.
 *
 * Falsification: change the constant to 11 and the boundary test fails; swap
 * `[...value].length` for `value.length` and the emoji case fails; add a
 * `.trim()` and the whitespace case fails.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  passwordProblem,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REQUIRED,
  PASSWORD_TOO_SHORT,
} from '../../src/lib/passwordPolicy.js';

/** A password of exactly `n` ASCII characters. */
const chars = (n) => 'a'.repeat(n);

describe('passwordProblem: the minimum length', () => {
  test('the minimum is 12 characters, and the sentence says so', () => {
    assert.equal(PASSWORD_MIN_LENGTH, 12);
    assert.match(PASSWORD_TOO_SHORT, /12 characters/, 'the refusal must name the minimum it enforces');
  });

  test(`${PASSWORD_MIN_LENGTH - 1} characters is refused and ${PASSWORD_MIN_LENGTH} is accepted`, () => {
    assert.equal(passwordProblem(chars(PASSWORD_MIN_LENGTH - 1)), PASSWORD_TOO_SHORT);
    assert.equal(passwordProblem(chars(PASSWORD_MIN_LENGTH)), null, 'exactly the minimum must pass');
  });

  test('every shorter length is refused with the same sentence', () => {
    for (let n = 1; n < PASSWORD_MIN_LENGTH; n++) {
      assert.equal(passwordProblem(chars(n)), PASSWORD_TOO_SHORT, `${n} characters`);
    }
  });

  test('there is no maximum: a long passphrase passes', () => {
    assert.equal(passwordProblem(chars(200)), null);
    assert.equal(passwordProblem('correct horse battery staple, and then some'), null);
  });
});

describe('passwordProblem: nothing to measure', () => {
  test('an empty string, a missing value and a non-string are all "a password is required"', () => {
    for (const value of ['', undefined, null, 12345678901234, { $ne: '' }, ['a'.repeat(12)], true]) {
      assert.equal(passwordProblem(value), PASSWORD_REQUIRED, JSON.stringify(value) ?? String(value));
    }
  });
});

describe('passwordProblem: length, and nothing else', () => {
  test('no composition rule — twelve lowercase letters, twelve digits and twelve spaces all pass', () => {
    assert.equal(passwordProblem('abcdefghijkl'), null, 'no required digit');
    assert.equal(passwordProblem('123456789012'), null, 'no required letter');
    assert.equal(passwordProblem('            '), null, 'whitespace is part of a passphrase');
    assert.equal(passwordProblem('aaaaaaaaaaaa'), null, 'no repetition rule');
    assert.equal(passwordProblem('password1234'), null, 'no dictionary check here (breach lists are their own item)');
  });

  test('nothing is trimmed: the spaces the user typed count', () => {
    // 10 characters padded to 12 by its own spaces. Trimming would refuse it,
    // and would also mean storing something other than what was typed.
    assert.equal(passwordProblem(` ${chars(10)} `), null);
    // And trimming cannot make a long password short either.
    assert.equal(passwordProblem(`  ${chars(4)}  `), PASSWORD_TOO_SHORT, '8 characters is 8, padded or not');
  });

  test('counted in code points: twelve emoji are twelve characters, not twenty-four', () => {
    const twelveEmoji = '🚂'.repeat(12);
    assert.equal(twelveEmoji.length, 24, 'the fixture is the UTF-16 trap this test exists for');
    assert.equal(passwordProblem(twelveEmoji), null);
    assert.equal(passwordProblem('🚂'.repeat(11)), PASSWORD_TOO_SHORT, 'eleven characters is eleven');
  });
});
