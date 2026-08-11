/**
 * faults.js — the error boundary.
 *
 * RELAY command failures on @signalwire/realtime-api 4.2.1 reject with things
 * that are not Errors: prototype-less plain objects with string codes (D5/D6),
 * and in at least one live-captured case a bare Symbol (D8). Everything the SDK
 * rejects with crosses this boundary exactly once and comes out as a Fault, a
 * real Error with a stack, a numeric code (or null), and a message that is safe
 * to log. Nothing downstream ever touches a raw rejection.
 */

/** Numeric RELAY code from anything, or null. Never throws. */
export function relayCode(err) {
  if (!err || typeof err !== 'object') return null;
  let raw;
  try {
    raw = err.code;
  } catch {
    return null;
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Describe any value as a string without ever throwing. Template-interpolating
 * a Symbol throws TypeError, which is how the original logger faulted inside
 * its own error handler and lost the underlying failure.
 */
export function safeDescribe(value) {
  try {
    if (typeof value === 'symbol') return value.toString();
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.message;
    if (value && typeof value === 'object') {
      let msg;
      try {
        msg = value.message;
      } catch {
        msg = undefined;
      }
      if (typeof msg === 'string' && msg) return msg;
      try {
        return JSON.stringify(value);
      } catch {
        return Object.prototype.toString.call(value);
      }
    }
    return String(value);
  } catch {
    return '[undescribable]';
  }
}

export class Fault extends Error {
  constructor(message, { code = null, kind = 'unknown', context = null, cause = undefined } = {}) {
    super(message);
    this.name = 'Fault';
    this.code = code;
    this.kind = kind;
    this.context = context;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Convert any rejection reason into a Fault. Real Errors keep their identity in
 * `cause`; their message and numeric code carry through.
 */
export function toFault(reason, context = null) {
  if (reason instanceof Fault) return reason;
  const code = relayCode(reason);
  const kind =
    typeof reason === 'symbol' ? 'symbol'
    : reason instanceof Error ? 'error'
    : code !== null ? 'relay'
    : 'unknown';
  const described = safeDescribe(reason);
  const message = context ? `[${context}] ${described}` : described;
  return new Fault(message, { code, kind, context, cause: reason });
}
