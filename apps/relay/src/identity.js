/**
 * identity.js — whitelist policy. Pure, SDK-free, fail-closed.
 *
 * D12: a SIP identity is the user AND the whole host, anchored. Matching the
 * user part alone admitted sip:PARENT@anything.com; a naive endsWith admitted
 * host-suffix confusion (acme.sip.signalwire.com.attacker.com). Both are
 * denied here by exact host equality after lowercasing.
 *
 * D13: PSTN identities are normalized to E.164 before comparison, so ordinary
 * caller-ID formats (no +, national, spaces, dots, bare national digits) match
 * their whitelist entry instead of bouncing a parent to a support ticket.
 * Anything that cannot be confidently normalized is denied, never thrown on.
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

export function toE164(raw, region = 'US') {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || !/^[+()\-.\s\d]+$/.test(s)) return null;
  try {
    const p = parsePhoneNumberFromString(s, region);
    return p && p.isPossible() ? p.number : null;
  } catch {
    return null;
  }
}

/** Typed entries in, normalized key set out. Malformed entries are dropped. */
export function buildWhitelist(entries, { region = 'US' } = {}) {
  const keys = new Set();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue;
    if (e.kind === 'pstn') {
      const n = toE164(e.value, region);
      if (n) keys.add(`pstn:${n}`);
    } else if (e.kind === 'sip' && typeof e.user === 'string' && typeof e.host === 'string') {
      const user = e.user.trim().toLowerCase();
      const host = e.host.trim().toLowerCase();
      if (user && host) keys.add(`sip:${user}@${host}`);
    }
  }
  return keys;
}

/** Never throws. Denies anything it cannot confidently normalize. */
export function isAllowed(identity, whitelist, { region = 'US' } = {}) {
  if (!(whitelist instanceof Set) || whitelist.size === 0) return false;
  if (typeof identity !== 'string' || !identity.trim()) return false;

  const sip = parseSipUri(identity);
  if (sip) return whitelist.has(`sip:${sip.user.toLowerCase()}@${sip.host}`);

  const e164 = toE164(identity, region);
  return e164 ? whitelist.has(`pstn:${e164}`) : false;
}
