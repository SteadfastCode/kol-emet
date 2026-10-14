/**
 * What the entity requests put on the wire. fetch is stubbed; the module is the real one.
 *
 * The search request is the point (KOL-082). `searchEntities` sent no `?limit=`, which on this
 * route means *no limit at all* — so a typed letter, which matches nearly every entity in a
 * workspace, asked the API to serialize that workspace's entire row set into one response, on the
 * single event loop every tenant shares, once per debounced word. KOL-067 removed exactly that read
 * from the initial load; the search box put it back. A query string is the whole fix, and a query
 * string is a thing no component test can see, so it is pinned here.
 *
 * Falsification: drop `limit` from the params and the first case fails; raise the default above the
 * route's `LIST_LIMIT_MAX` and the second one does; swap `URLSearchParams` for string
 * concatenation of a raw term and the punctuation case sends a `+` the server reads as a space.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEntityPage, searchEntities, SEARCH_RESULT_LIMIT } from './entities.js';

/** The envelope `?limit=` opts into, as the route answers it. */
const ENVELOPE = { items: [{ _id: 'e1', title: 'Boiler Room' }], nextAfter: null, total: 1 };

let requested;

beforeEach(() => {
  requested = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    requested.push(`${init.method ?? 'GET'} ${url}`);
    return { ok: true, status: 200, json: async () => ENVELOPE };
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The query parameters of the one request that was made. */
const sentParams = () => {
  expect(requested).toHaveLength(1);
  const [, url] = requested[0].split(' ');
  return new URL(url, 'http://localhost').searchParams;
};

describe('searchEntities', () => {
  it('asks for the keyword with a bounded number of matches, never an unbounded read', async () => {
    await searchEntities('toolchain');

    const params = sentParams();
    expect(params.get('q')).toBe('toolchain');
    // The whole defect: absent, this parameter means *no limit* server-side.
    expect(params.get('limit')).toBe(String(SEARCH_RESULT_LIMIT));
  });

  it('asks for no more than the route will serve', () => {
    // `LIST_LIMIT_MAX` in server/src/routes/entities.js. Above it the server clamps rather than
    // refusing, so a larger number here would not break — it would just quietly stop being the
    // number this client thinks it asked for.
    expect(SEARCH_RESULT_LIMIT).toBe(200);
  });

  it('sends a term with regex and query punctuation in it as the term it is', async () => {
    await searchEntities('C++ (v2)');

    // Not `C  (v2)`: a bare `+` in a query string is a space to the server's parser, and this term
    // is three characters of punctuation the route escapes rather than compiles.
    expect(sentParams().get('q')).toBe('C++ (v2)');
  });

  it('answers the envelope the limit opted into', async () => {
    expect(await searchEntities('toolchain')).toEqual(ENVELOPE);
  });

  it('takes an explicit limit, for a caller that wants fewer', async () => {
    await searchEntities('toolchain', { limit: 20 });

    expect(sentParams().get('limit')).toBe('20');
  });
});

describe('getEntityPage', () => {
  it('sends the cursor back as the two fields it is made of', async () => {
    await getEntityPage({ limit: 50, after: { title: 'Boiler Room', _id: 'e1' } });

    const params = sentParams();
    expect(params.get('limit')).toBe('50');
    expect(params.get('after[title]')).toBe('Boiler Room');
    expect(params.get('after[_id]')).toBe('e1');
  });
});
