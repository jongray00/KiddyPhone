/**
 * identity.js
 *
 * What SignalWire POSTs to an external SWML URL is open item U5: no published
 * shape was found, so this extraction is deliberately defensive and the
 * evidence capture (capture.js) is the authority that settles it after one
 * live call. Covered shapes: a nested call object with from/to (SIP legs) or
 * from_number/to_number (phone legs), and the same keys at the top level.
 *
 * Never throws. Missing fields come back null; the caller fails closed.
 */

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

export function extractIdentity(body) {
  if (!body || typeof body !== 'object') return { from: null, to: null, callId: null };
  const call = body.call && typeof body.call === 'object' ? body.call : null;
  return {
    from: pick(call, ['from', 'from_number']) ?? pick(body, ['from', 'from_number']),
    to: pick(call, ['to', 'to_number']) ?? pick(body, ['to', 'to_number']),
    callId: pick(call, ['call_id', 'id']) ?? pick(body, ['call_id']),
  };
}
