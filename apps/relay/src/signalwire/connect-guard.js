/**
 * connect-guard.js — D1 through D4, plus D3's lookup fan-out.
 *
 * The 409 ("Wait for connect to finish") reports that another delivery of the
 * SAME call already has a connect in flight. It is not this request failing;
 * it is this request losing a race it was never supposed to enter. Two layers:
 *
 *   1. Single-flight per LOGICAL call (intentKey: context|from->to, never the
 *      call id — one physical call arrives under up to six ids). Duplicates
 *      join the in-flight attempt and learn its real outcome. This is the
 *      optimization.
 *   2. Classification. If a 409 still reaches us (multi-worker, lock miss),
 *      stand down: no hangup, no retry. Hanging up on the 409 destroyed the
 *      winning bridge — that was the outage. This is the guarantee.
 */

import { toFault, relayCode } from '../faults.js';
import { expectResult } from '../deadline.js';

export const Outcome = {
  BRIDGED: 'bridged',
  STOOD_DOWN: 'stood-down',
  GONE: 'gone',
  FAILED: 'failed',
};

/** Classify any connect rejection. Never throws. */
export function classify(reason) {
  const code = relayCode(reason);
  if (code === 409) return Outcome.STOOD_DOWN;
  if (code === 404 || code === 410) return Outcome.GONE;
  return Outcome.FAILED;
}

/**
 * BRIDGED: the bridge owns the call now. STOOD_DOWN: someone else's bridge
 * does — hanging up here kills the good call. GONE: nothing exists to tear
 * down (the hangup would 404 too). Only FAILED warrants teardown.
 */
export function shouldTeardown(outcome) {
  return outcome === Outcome.FAILED;
}

/** The logical call: who is calling whom on which topic. No call id. */
export function intentKey({ context, from, to }) {
  const norm = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
  return `${norm(context)}|${norm(from)}->${norm(to)}`;
}

export class ConnectGuard {
  constructor() {
    this._inFlight = new Map();
  }

  get size() {
    return this._inFlight.size;
  }

  /**
   * Run `fn` (the actual connect) at most once per key; concurrent callers with
   * the same key await the same attempt. Resolves { outcome, response, fault }
   * and never rejects — control flow downstream branches on the outcome, not on
   * exceptions it cannot identify.
   */
  connectOnce(key, fn) {
    const existing = this._inFlight.get(key);
    if (existing) return existing;

    const attempt = (async () => {
      try {
        const response = expectResult(await fn(), 'connect');
        return { outcome: Outcome.BRIDGED, response, fault: null };
      } catch (reason) {
        const fault = toFault(reason, 'connect');
        return { outcome: classify(reason), response: null, fault };
      } finally {
        this._inFlight.delete(key);
      }
    })();

    this._inFlight.set(key, attempt);
    return attempt;
  }
}

/**
 * D3: one caller generates up to 19 handler runs in a burst; the whitelist
 * lookup must not run 19 times. Results (allow AND deny) are cached per
 * identity for ttlMs; in-flight lookups are joined; lookup ERRORS are never
 * cached, so an auth-API blip does not poison the cache.
 */
export function memoizeAuthorizer(lookup, { ttlMs = 5000, now = Date.now } = {}) {
  const cache = new Map(); // identity -> { promise, expiresAt }

  return function authorize(identity) {
    const entry = cache.get(identity);
    if (entry && now() < entry.expiresAt) return entry.promise;

    const promise = Promise.resolve()
      .then(() => lookup(identity))
      .catch((err) => {
        cache.delete(identity);
        throw err;
      });

    cache.set(identity, { promise, expiresAt: now() + ttlMs });
    return promise;
  };
}
