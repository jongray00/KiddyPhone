/**
 * whitelist.js
 *
 * The identity decision, free of any SDK or transport import on purpose: the
 * same module serves the RELAY worker, this SWML webhook, and anything else.
 * Logic carried over from the reviewed reference (master context 14.2).
 *
 * Two rules close the two live defects:
 *   D12: a SIP identity matches only when user AND full host both match, so
 *        sip:PARENT@attacker.com and domain-suffix tricks are denied.
 *   D13: PSTN identities are normalized to E.164 before comparison, so a
 *        parent calling as "(555) 123-4567" is not rejected by string match.
 *
 * isAllowed never throws and denies anything it cannot confidently normalize.
 */

import { parsePhoneNumberFromString } from 'libphonenumber-js';

export function parseSipUri(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const angled = s.match(/<([^>]*)>\s*$/);
  if (angled) s = angled[1].trim();
  if (!/^sips?:/i.test(s)) return null;
  s = s.replace(/^sips?:/i, '').split(';')[0].split('?')[0];
  const parts = s.split('@');
  if (parts.length !== 2) return null;
  const user = parts[0].split(':')[0];
  const host = parts[1].split(':')[0].toLowerCase();
  if (!user || !host) return null;
  return { user, host };
}

export function normalizePstn(raw, region = 'US') {
  if (typeof raw !== 'string' || !/^[+()\-.\s\d]+$/.test(raw.trim())) return null;
  try {
    const p = parsePhoneNumberFromString(raw.trim(), region);
    return p && p.isPossible() ? p.number : null;
  } catch {
    return null;
  }
}

/**
 * Build the precomputed key set once. Entries that fail to normalize are
 * dropped rather than admitted in a broken form.
 */
export function buildWhitelist({ pstn = [], sip = [], region = 'US' } = {}) {
  const keys = new Set();

  for (const value of pstn) {
    const n = normalizePstn(value, region);
    if (n) keys.add(`pstn:${n}`);
  }
  for (const entry of sip) {
    if (entry && typeof entry.user === 'string' && typeof entry.host === 'string' && entry.user && entry.host) {
      keys.add(`sip:${entry.user.toLowerCase()}@${entry.host.toLowerCase()}`);
    }
  }

  function isAllowed(identity) {
    if (typeof identity !== 'string' || !identity.trim()) return false;
    const sipId = parseSipUri(identity);
    if (sipId) return keys.has(`sip:${sipId.user.toLowerCase()}@${sipId.host}`);
    const e164 = normalizePstn(identity, region);
    return e164 ? keys.has(`pstn:${e164}`) : false;
  }

  // Runtime toggles for the test console's SDK caller: blocked-caller
  // scenarios remove the caller's number, allow scenarios restore it.
  function allow(number) {
    const n = normalizePstn(number, region);
    if (n) keys.add(`pstn:${n}`);
    return !!n;
  }
  function disallow(number) {
    const n = normalizePstn(number, region);
    if (n) keys.delete(`pstn:${n}`);
    return !!n;
  }

  return { keys, isAllowed, allow, disallow };
}
