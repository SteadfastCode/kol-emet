/**
 * The client origin the HTTP suites speak from, and an agent that sends it.
 *
 * `src/middleware/originGuard.js` refuses an unsafe method from a session
 * caller whose `Origin` is not this deployment's client (KOL-058). A supertest
 * agent sends no `Origin` of its own, so without this helper every
 * session-cookie POST/PUT/PATCH/DELETE in `tests/http` would be a 403 that has
 * nothing to do with what the test is asserting.
 *
 * So each suite names an origin in its env block —
 *   process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
 * — and builds its session agents with `originAgent(app)` instead of
 * `request.agent(app)`. The header is set as an agent *default*, so it rides
 * every request that agent makes, including ones written later.
 *
 * Deliberately a real-looking origin rather than a placeholder: the guard
 * compares parsed origins, and a value that is not a URL would be normalized to
 * nothing and match nothing — a suite that passed for the wrong reason.
 *
 * An unauthenticated `request(app)` call needs nothing from here: with no
 * signed-in session there is no cookie to ride, so the guard does not check it.
 * Tests that assert the guard's own behaviour live in
 * `tests/http/originGuard.test.js` and `tests/unit/originGuard.test.js`.
 */

import request from 'supertest';

/** The origin these suites configure as `CLIENT_ORIGIN` and send as `Origin`. */
export const CLIENT_ORIGIN = 'http://localhost:5173';

/**
 * A supertest agent (cookie jar and all) that sends `Origin: CLIENT_ORIGIN` on
 * every request it makes.
 *
 * @param {import('express').Express} app
 * @returns {import('supertest').SuperAgentTest}
 */
export function originAgent(app) {
  return request.agent(app).set('Origin', CLIENT_ORIGIN);
}

export default originAgent;
