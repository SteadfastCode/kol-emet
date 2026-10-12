/**
 * The one rule a password this product stores has to pass, in one place.
 *
 * Until KOL-074 there was none: `usablePassword()` in routes/auth.js asked only
 * that the field be a non-empty string, so `a` was a valid password on a product
 * with open registration. The rule itself is deliberately the smallest one that
 * is worth anything — a **12-character minimum, and nothing else**:
 *
 *   - **Length, not composition.** NIST SP 800-63B (§3.1.1.2) stopped
 *     recommending the upper/lower/digit/symbol rules a decade ago: they push
 *     people towards `Password1!` and away from the long passphrases that
 *     actually resist guessing, and they are the reason a user writes the
 *     password down. What survives the evidence is length.
 *   - **12, not 8.** Eight characters is within reach of offline cracking of a
 *     leaked hash; twelve is not, for a password that is not also on a breach
 *     list. Breach-list and strength (zxcvbn) scoring are the next rung up and
 *     deliberately out of scope here — they need a wordlist or a service, and
 *     nothing about this module's interface changes when one is added.
 *
 * Who asks, and who does not:
 *   - `POST /auth/register` and `POST /auth/password` both call this, which is
 *     the point of it being a module rather than two inline checks: the rule
 *     that gates a new account and the rule that gates a changed password
 *     cannot drift apart.
 *   - **`POST /auth/login` never calls it.** An account whose stored password is
 *     shorter than the minimum goes on signing in. Locking out everyone who
 *     registered before the rule existed is a worse failure than a short
 *     password, and a sign-in form that refuses a *correct* password teaches
 *     the user nothing it could act on. The policy gates writes.
 *
 * Not checked here, on purpose: a maximum. bcrypt only reads the first 72 bytes
 * of a password, so anything past that is silently ignored — by `/register` and
 * `/auth/password` alike, so the two agree and a long passphrase still signs
 * in. Refusing one would be a composition rule in disguise.
 *
 * The client states the same minimum at its own forms (client/src/api/auth.js)
 * so a user is told before they submit; this module is what *enforces* it, and
 * is the only side a request cannot skip.
 */

/** The shortest password `/auth/register` and `POST /auth/password` will store. */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Null when `value` may be stored as a password, otherwise one sentence saying
 * why not — written for the person who typed it, since every caller answers it
 * straight back as `{ error }`.
 *
 * Counted in code points (`[...value]`), not UTF-16 units: a passphrase written
 * in emoji or outside the BMP is as long as it looks, rather than twice as
 * long, so the rule cannot be *met* by characters a user did not type.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function passwordProblem(value) {
  if (typeof value !== 'string' || value === '') return 'A password is required.';
  if ([...value].length < PASSWORD_MIN_LENGTH) {
    return `A password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  return null;
}

export default passwordProblem;
