/**
 * util.js
 *
 * Copied from the relay POC at the repo root (src/deadline.js, src/faults.js)
 * so this folder stays self-contained and can be handed over intact. The
 * provenance matters: withDeadline exists because a timed-out command on
 * @signalwire/realtime-api resolves with undefined (D7), and safeDescribe
 * exists because interpolating a Symbol rejection threw inside the original
 * logger (D8). Neither failure mode is SWML-specific; both are kept.
 */

export function withDeadline(promise, ms, label = 'command') {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`[${label}] no response within ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

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
