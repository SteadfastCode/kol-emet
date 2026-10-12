/**
 * The one password rule this product has, in one place.
 *
 * Until this existed `POST /auth/register` accepted any non-empty string
 * (`usablePassword` in routes/auth.js), so `a` was a valid password on a
 * product with open registration — and since nothing could change a password
 * afterwards, it was a valid password for the life of the account. Both halves
 * are fixed by one function used by both routes: the signup form and
 * `POST /auth/password` call `passwordProblem()`, so the minimum a new account
 * must meet and the minimum a replacement must meet cannot drift apart.
 *
 * ─── Length, and nothing else ───────────────────────────────────────────────
 * NIST SP 800-63B §3.1.1.2 is the authority: a minimum length, and **no**
 * composition rules. No required digit, no required symbol, no mixed case —
 * those push people towards `Password1!`, which is weaker than three words and
 * is also what a password manager generates nothing like. 12 characters is the
 * minimum here (the standard's floor for user-chosen secrets is 8; 12 is the
 * length its own appendix and every current guideline recommend), and it is a
 * floor only: there is deliberately no maximum beyond what bcrypt itself reads,
 * nothing is trimmed, and a password of twelve spaces passes — whitespace is
 * part of a passphrase, and stripping it would quietly change what the user
 * typed into something they could not type again.
 *
 * ─── Counted in code points ─────────────────────────────────────────────────
 * `[...value].length`, not `value.length`: a password of twelve emoji is
 * twenty-four UTF-16 units and twelve characters, and "twelve characters" has
 * to mean the same thing whatever alphabet it is typed in. This is the rule
 * `workspaceName` in middleware/workspace.js already counts by, for the same
 * reason.
 *
 * Known limit, by design: bcrypt reads at most 72 **bytes**, so a very long
 * non-ASCII passphrase is silently truncated by the hash rather than by
 * anything here. That is a property of the hash, documented rather than
 * worked around, and it cannot make a password shorter than this minimum.
 *
 * ─── What this gates, and what it must never gate ───────────────────────────
 * Writes only: creating an account, and replacing a password. **Never
 * `POST /auth/login`.** An account registered before this minimum existed
 * holds a password shorter than it, and refusing that password at the sign-in
 * form would lock its owner out of their own workspace — a strictly worse
 * failure than the short password itself, and one they could not fix, since
 * changing a password requires signing in first. Forcing a rotation on those
 * accounts is a product decision with a migration behind it, and is not this.
 */

/** The minimum, in characters (code points). A floor, not a target. */
export const PASSWORD_MIN_LENGTH = 12;

/** Answered when there is no password at all to measure. */
export const PASSWORD_REQUIRED = 'A password is required.';

/** Answered when there is one and it is too short. A sentence, because it is shown to the user. */
export const PASSWORD_TOO_SHORT = `Your password must be at least ${PASSWORD_MIN_LENGTH} characters.`;

/**
 * `null` when `value` may be stored as a password, otherwise one sentence
 * saying why not — a sentence rather than a code, because both callers hand it
 * straight to the user as the body of a 400.
 *
 * A non-string (JSON can put an object where a password belongs) is answered
 * like a missing one: there is nothing to measure, and nothing here should be
 * the thing that decides what an operator object means.
 *
 * @param {unknown} value the password as the request sent it, untrimmed
 * @returns {string|null}
 */
export function passwordProblem(value) {
  if (typeof value !== 'string' || value === '') return PASSWORD_REQUIRED;
  if ([...value].length < PASSWORD_MIN_LENGTH) return PASSWORD_TOO_SHORT;
  return null;
}

export default passwordProblem;
