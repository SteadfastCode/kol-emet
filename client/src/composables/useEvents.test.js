/**
 * The live-sync channel's own rules (KOL-102), driven through a fake
 * `EventSource` rather than a socket: what this composable does with a frame,
 * and what it does when a stream ends.
 *
 * Three things are pinned here, each of which was a real hole:
 *
 *   **A bulk write reaches this tab.** `draft:applied` and `workspace:imported`
 *   are one frame each for a write that touched many rows, and nothing used to
 *   listen for either — so an apply in one tab, or an import, was invisible in
 *   every other one until a reload. Each has to call its handler exactly once,
 *   with the frame's payload: the layout turns that into one `loadEntities` and
 *   one toast (components/WikiLayout.test.js pins that half).
 *
 *   **A frame the server wrote is a stop, not a retry.** An `EventSource`
 *   dispatches both a transport failure and a server-written `event: error`
 *   frame as `error`, and only the latter carries `data`. Treating them alike
 *   had a tab whose session was revoked — or one over the per-user stream cap —
 *   re-dial the same refusal every 3 seconds for as long as it stayed open. So
 *   `session-ended` and `too-many-streams` must schedule nothing and report a
 *   reason, while a transport failure must still reconnect, with a delay that
 *   grows.
 *
 *   **The default log tier carries no payload.** Every frame used to be
 *   `console.log`ged whole, entity bodies included.
 *
 * Falsification: drop the two new `onFrame` registrations and the first group
 * fails; read `es.readyState` instead of `e.data` on the error path and the
 * stop cases reconnect; keep the fixed 3000 ms and the backoff case fails; log
 * `e.data` at the light tier and the last case fails.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import {
  useEvents, reconnectDelay, STOP_REASONS,
  RECONNECT_BASE_MS, RECONNECT_MAX_MS, RECONNECT_JITTER,
} from './useEvents.js';

/**
 * Stands in for the browser's `EventSource`: records every listener, and lets a
 * test deliver exactly the frames the server can send — including the two
 * different things that arrive as `error`.
 */
class FakeEventSource {
  static instances = [];

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.readyState = 0;           // CONNECTING
    this.closed = false;
    this.listeners = new Map();
    FakeEventSource.instances.push(this);
  }

  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }

  close() {
    this.closed = true;
    this.readyState = 2;           // CLOSED
  }

  emit(name, event) {
    for (const fn of [...(this.listeners.get(name) ?? [])]) fn(event);
  }

  /** The connection succeeded. */
  opened() {
    this.readyState = 1;           // OPEN
    this.emit('open', {});
  }

  /** One `event: <name>` frame with a JSON body. */
  frame(name, data) {
    this.emit(name, { data: JSON.stringify(data) });
  }

  /** The server's own `event: error` frame — it carries data. */
  serverError(detail) {
    this.emit('error', { data: JSON.stringify(detail) });
  }

  /** A dropped socket: an error event with no data at all. */
  transportError() {
    this.readyState = 0;
    this.emit('error', {});
  }
}

const sources = () => FakeEventSource.instances;
const latest = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];

/** Mounts a component whose only job is to run the composable. */
function mountEvents(handlers = {}) {
  return mount({ setup() { useEvents(handlers); return () => null; } });
}

/** Mounts, and reports the stream as connected, which is the steady state. */
function connected(handlers = {}) {
  const wrapper = mountEvents(handlers);
  latest().opened();
  latest().frame('client:id', { clientId: 'client-1' });
  return wrapper;
}

let wrapper;
let logged;
let reported;

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  // The light tier is the default and the one the payload case is about, so
  // nothing here sets a level unless that is the thing under test.
  localStorage.removeItem('SSE_LOG_LEVEL');
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(args.join(' ')); });
  // One case below drives a handler that throws, which this module reports.
  reported = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => { reported.push(args.join(' ')); });
  // Jitter off, so a delay can be asserted exactly. Its spread is checked
  // against `reconnectDelay` itself at the bottom of this file.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a bulk write', () => {
  it('reaches this tab through one draft:applied frame, once', () => {
    const onDraftApplied = vi.fn();
    wrapper = connected({ onDraftApplied });

    latest().frame('draft:applied', {
      draftId: 'd1', applied: 30, failed: 0, blocked: 0, skipped: 2,
      actor: { label: 'alice@example.test', type: 'generator' },
    });

    expect(onDraftApplied).toHaveBeenCalledTimes(1);
    expect(onDraftApplied.mock.calls[0][0]).toMatchObject({
      draftId: 'd1', applied: 30, actor: { label: 'alice@example.test', type: 'generator' },
    });
  });

  it('reaches this tab through one workspace:imported frame, once', () => {
    const onWorkspaceImported = vi.fn();
    wrapper = connected({ onWorkspaceImported });

    latest().frame('workspace:imported', {
      version: 'kol-emet/workspace-export@1',
      imported: { entities: 18, relationshipGroups: 7, openQuestions: 3 },
      actor: { label: 'alice@example.test', type: 'user' },
    });

    expect(onWorkspaceImported).toHaveBeenCalledTimes(1);
    expect(onWorkspaceImported.mock.calls[0][0].imported).toEqual({
      entities: 18, relationshipGroups: 7, openQuestions: 3,
    });
  });

  it('does not take the listener down when a handler throws', () => {
    const onDraftApplied = vi.fn(() => { throw new Error('the layout blew up'); });
    const onEntityUpdated = vi.fn();
    wrapper = connected({ onDraftApplied, onEntityUpdated });

    latest().frame('draft:applied', { draftId: 'd1', applied: 1 });
    latest().frame('entity:updated', { entity: { _id: 'e1', title: 'Engine' }, actor: {}, changes: {} });

    expect(onEntityUpdated).toHaveBeenCalledTimes(1);
    expect(reported.some((l) => l.includes('draft:applied handler threw'))).toBe(true);
  });
});

describe('a stream the server ended on purpose', () => {
  it('session-ended stops the loop and reports being signed out elsewhere', () => {
    const onStreamEnded = vi.fn();
    wrapper = connected({ onStreamEnded });
    const first = latest();

    first.serverError({ error: 'session-ended' });

    expect(onStreamEnded).toHaveBeenCalledTimes(1);
    expect(onStreamEnded.mock.calls[0][0].reason).toBe('session-ended');
    expect(onStreamEnded.mock.calls[0][0].message).toMatch(/signed out in another window/i);
    expect(first.closed).toBe(true);

    // Nothing is waiting, and a long wait opens no second connection.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(sources()).toHaveLength(1);
  });

  it('too-many-streams stops the loop and names the limit', () => {
    const onStreamEnded = vi.fn();
    wrapper = connected({ onStreamEnded });

    latest().serverError({ error: 'too-many-streams', limit: 10 });

    expect(onStreamEnded).toHaveBeenCalledTimes(1);
    expect(onStreamEnded.mock.calls[0][0]).toMatchObject({ reason: 'too-many-streams', limit: 10 });
    expect(onStreamEnded.mock.calls[0][0].message).toContain('10');

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(sources()).toHaveLength(1);
  });

  it('a close the server means to be temporary is retried, not a stop', () => {
    // What a deploy sends (lib/shutdown.js): the stream ends, but the
    // credential is still good, so this one must come back.
    const onStreamEnded = vi.fn();
    wrapper = connected({ onStreamEnded });

    latest().serverError({ error: 'server-restarting' });

    expect(onStreamEnded).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RECONNECT_MAX_MS);
    expect(sources()).toHaveLength(2);
  });
});

describe('a dropped socket', () => {
  it('reconnects, and successive delays grow rather than repeating one', () => {
    wrapper = connected();

    // First failure: one base delay, and not before it.
    latest().transportError();
    vi.advanceTimersByTime(RECONNECT_BASE_MS - 1);
    expect(sources()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sources()).toHaveLength(2);

    // Second consecutive failure — no `opened()` in between — waits longer.
    latest().transportError();
    vi.advanceTimersByTime(RECONNECT_BASE_MS);
    expect(sources()).toHaveLength(2);
    vi.advanceTimersByTime(RECONNECT_BASE_MS);
    expect(sources()).toHaveLength(3);

    // Third longer still, so the old fixed 3000 ms cannot pass this.
    latest().transportError();
    vi.advanceTimersByTime(4 * RECONNECT_BASE_MS - 1);
    expect(sources()).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(sources()).toHaveLength(4);
  });

  it('a connection that opened starts the backoff over', () => {
    wrapper = connected();

    latest().transportError();
    vi.advanceTimersByTime(RECONNECT_BASE_MS);
    expect(sources()).toHaveLength(2);
    latest().opened();

    latest().transportError();
    vi.advanceTimersByTime(RECONNECT_BASE_MS);
    expect(sources()).toHaveLength(3);
  });

  it('is logged with its attempt number and its delay, at the default tier', () => {
    wrapper = connected();
    logged = [];

    latest().transportError();

    const line = logged.find((l) => l.includes('reconnecting'));
    expect(line).toBeTruthy();
    expect(line).toContain('attempt 1');
    expect(line).toContain(`${RECONNECT_BASE_MS}ms`);
    expect(line).toContain('transport failure');
  });

  it('stops for good once the view is gone', () => {
    wrapper = mountEvents();
    latest().opened();
    const only = latest();

    wrapper.unmount();
    wrapper = null;

    expect(only.closed).toBe(true);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(sources()).toHaveLength(1);
  });
});

describe('the default log tier', () => {
  it('names the connection but carries no payload', () => {
    const secret = 'THE-ENTIRE-BODY-OF-A-PRIVATE-ENTITY';
    wrapper = connected();

    latest().frame('entity:updated', {
      entity: { _id: 'e1', title: secret, blocks: [{ type: 'text', data: { markdown: secret } }] },
      actor: { label: 'alice@example.test', type: 'user' },
      changes: { summary: { to: secret } },
    });
    latest().frame('draft:applied', { draftId: 'd1', applied: 1, note: secret });

    // The tier is on — otherwise this case would pass with logging disabled.
    expect(logged.some((l) => l.includes('connected'))).toBe(true);
    expect(logged.every((l) => l.startsWith('[sse:light]'))).toBe(true);
    expect(logged.filter((l) => l.includes(secret))).toEqual([]);
  });

  it('verbose is what carries the frame', () => {
    localStorage.setItem('SSE_LOG_LEVEL', 'verbose');
    wrapper = connected();

    latest().frame('entity:updated', { entity: { _id: 'e1', title: 'Engine' }, actor: {}, changes: {} });

    expect(logged.some((l) => l.startsWith('[sse:verbose]') && l.includes('"Engine"'))).toBe(true);
    // normal names the event and the id it is about, and nothing more.
    expect(logged.some((l) => l.startsWith('[sse:normal]') && l.includes('entity:updated — entity e1'))).toBe(true);
  });

  it('off is silent', () => {
    localStorage.setItem('SSE_LOG_LEVEL', 'off');
    wrapper = connected();
    latest().frame('entity:deleted', { entityId: 'e1', entityTitle: 'Engine', actor: {} });

    expect(logged).toEqual([]);
  });
});

describe('reconnectDelay', () => {
  it('doubles, is capped, and is spread either side of the backoff', () => {
    const noJitter = () => 0.5;
    expect(reconnectDelay(1, noJitter)).toBe(RECONNECT_BASE_MS);
    expect(reconnectDelay(2, noJitter)).toBe(2 * RECONNECT_BASE_MS);
    expect(reconnectDelay(3, noJitter)).toBe(4 * RECONNECT_BASE_MS);
    expect(reconnectDelay(99, noJitter)).toBe(RECONNECT_MAX_MS);

    // The jitter is what keeps every tab in the deployment from coming back in
    // the same instant, and it is bounded so successive delays still grow.
    expect(reconnectDelay(1, () => 0)).toBe(RECONNECT_BASE_MS * (1 - RECONNECT_JITTER));
    expect(reconnectDelay(1, () => 1)).toBe(RECONNECT_BASE_MS * (1 + RECONNECT_JITTER));
    expect(reconnectDelay(2, () => 0)).toBeGreaterThan(reconnectDelay(1, () => 1));
  });
});

describe('STOP_REASONS', () => {
  it('is exactly the two refusals a reconnect cannot fix', () => {
    expect(Object.keys(STOP_REASONS).sort()).toEqual(['session-ended', 'too-many-streams']);
  });
});
