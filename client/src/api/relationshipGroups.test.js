/**
 * What the relationship-group requests put on the wire, and how the walk ends
 * (KOL-092). fetch is stubbed; the module is the real one.
 *
 * `getAllGroups` sent one unbounded `GET /relationship-groups`, and the graph
 * view makes that request the moment it opens: the route answered with every
 * group in the workspace, each carrying its whole `members` array, in a single
 * `JSON.stringify` on the single event loop every tenant shares. The route now
 * caps a response, so the whole set is a walk — which is a thing no component
 * test can see, hence here.
 *
 * The failure half is the point of the rest: a graph drawn from three pages of
 * five has every node present and some edges simply missing, so a page that
 * failed has to be *reportable*, with what did arrive. Hence `partial` and
 * `page` on the thrown error.
 *
 * Falsification: drop `limit` from the params and the first case fails; stop
 * sending `after` and the walk repeats page one forever (the loop guard here
 * catches it); drop `partial` from the error and the partial cases fail; return
 * `collected` instead of the array on a pre-cap server and the compatibility
 * case fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAllGroups, getGroupPage, GROUP_PAGE_SIZE } from './relationshipGroups.js';

const group = (id) => ({ _id: id, label: `Group ${id}`, members: [] });

let requested;
/** Queue of responses, one per request: `{ status?, body }`. */
let responses;

beforeEach(() => {
  requested = [];
  responses = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    requested.push(`${init.method ?? 'GET'} ${url}`);
    const next = responses.shift() ?? { body: { items: [], nextAfter: null } };
    const status = next.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 500 ? 'Internal Server Error' : 'OK',
      json: async () => next.body,
    };
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The query parameters of the nth request made. */
const paramsOf = (n) => new URL(requested[n].split(' ')[1], 'http://localhost').searchParams;

describe('getGroupPage', () => {
  it('asks for a bounded page, never an unbounded read', async () => {
    responses.push({ body: { items: [group('g1')], nextAfter: null } });

    await getGroupPage();

    // The whole defect: absent, this parameter means *no limit* server-side.
    expect(paramsOf(0).get('limit')).toBe(String(GROUP_PAGE_SIZE));
    expect(paramsOf(0).has('after')).toBe(false);
  });

  it('sends the cursor back as the bare id it is', async () => {
    responses.push({ body: { items: [], nextAfter: null } });

    await getGroupPage({ limit: 50, after: 'g2' });

    expect(paramsOf(0).get('limit')).toBe('50');
    expect(paramsOf(0).get('after')).toBe('g2');
  });

  it('asks for no more than the route will serve', () => {
    // `GROUP_LIMIT_MAX` in server/src/routes/relationshipGroups.js. Above it the
    // server clamps rather than refusing, so a larger number here would not
    // break — it would just quietly stop being the number this client asked for.
    expect(GROUP_PAGE_SIZE).toBe(200);
  });
});

describe('getAllGroups', () => {
  it('pages until nextAfter is null and concatenates, in order', async () => {
    responses.push(
      { body: { items: [group('g1'), group('g2')], nextAfter: 'g2' } },
      { body: { items: [group('g3')], nextAfter: 'g3' } },
      { body: { items: [], nextAfter: null } },
    );

    const groups = await getAllGroups();

    expect(groups.map((g) => g._id)).toEqual(['g1', 'g2', 'g3']);
    expect(requested).toHaveLength(3);
    expect(paramsOf(0).has('after')).toBe(false);
    expect(paramsOf(1).get('after')).toBe('g2');
    expect(paramsOf(2).get('after')).toBe('g3');
  });

  it('stops after one request when the first page is the last', async () => {
    responses.push({ body: { items: [group('g1')], nextAfter: null } });

    expect((await getAllGroups()).map((g) => g._id)).toEqual(['g1']);
    expect(requested).toHaveLength(1);
  });

  it('carries the pages that arrived, and which one failed, on the error', async () => {
    responses.push(
      { body: { items: [group('g1'), group('g2')], nextAfter: 'g2' } },
      { status: 500, body: { error: 'INTERNAL' } },
    );

    // A caller that only saw the rejection would have to choose between an
    // empty graph and a silently short one.
    const err = await getAllGroups().catch((e) => e);

    expect(err.status).toBe(500);
    expect(err.page).toBe(2);
    expect(err.partial.map((g) => g._id)).toEqual(['g1', 'g2']);
  });

  it('reports a first page that failed as a failure with nothing in it', async () => {
    responses.push({ status: 401, body: {} });

    const err = await getAllGroups().catch((e) => e);

    expect(err.status).toBe(401);
    expect(err.page).toBe(1);
    expect(err.partial).toEqual([]);
  });

  it('takes the bare array from an API that predates the cap', async () => {
    // The client and the API deploy independently (Netlify and Railway), so a
    // browser on this build can be talking to a server that answers the old
    // unbounded array however it is asked.
    responses.push({ body: [group('g1'), group('g2')] });

    expect((await getAllGroups()).map((g) => g._id)).toEqual(['g1', 'g2']);
    expect(requested).toHaveLength(1);
  });
});
