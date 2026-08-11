/**
 * setup.mjs — (re)create the live test topology. Everything is pwpoc- prefixed
 * and recorded in topology.json, which teardown.mjs uses as its manifest.
 *
 * Creates:
 *   3 domain applications -> relay contexts (pwpoc_inbound / pwpoc_outbound / pwpoc_child)
 *   2 phone numbers        -> pwpoc_child (PSTN child leg), pwpoc_inbound (PSTN caller entry)
 *
 * NOTE: purchased numbers cannot be released for 14 days (422 on DELETE), so
 * re-running this after a teardown should reuse numbers already on the space
 * whose name starts with pwpoc- instead of buying more. That reuse is
 * implemented below.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { loadRootEnv } = await import('../../../shared/env.mjs');
const { scopedPath, snapshotNumberRouting } = await import('../../../shared/provision.mjs');
loadRootEnv();
const SPACE = process.env.SIGNALWIRE_SPACE_URL;
const scoped = (base) => scopedPath(here, base, SPACE);
const auth = Buffer.from(
  `${process.env.SIGNALWIRE_PROJECT_ID}:${process.env.SIGNALWIRE_TOKEN}`
).toString('base64');
const headers = { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' };

const api = async (method, p, body) => {
  const res = await fetch(`https://${SPACE}/api/relay/rest/${p}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 422) throw new Error(`${method} ${p} -> ${res.status}`);
  return res.json();
};

// pre-run snapshots for teardown verification
for (const [kind, pathPart] of [
  ['domain_applications', 'domain_applications'],
  ['phone_numbers', 'phone_numbers'],
  ['sip_endpoints', 'endpoints/sip'],
]) {
  const data = await api('GET', `${pathPart}?page_size=200`);
  fs.writeFileSync(scoped(`inventory-pre-${kind}.json`), JSON.stringify(data, null, 2));
  console.log(`snapshot ${kind}: ${data.data.length}`);
}

// domain apps: reuse by name on re-runs — a tolerated 422 from a duplicate
// POST returns an error body, and writing that into the manifest leaves
// domainApps without name/domain and breaks every topology consumer.
const existingApps = (await api('GET', 'domain_applications?page_size=200')).data;
const domainApps = [];
for (const name of ['inbound', 'outbound', 'child']) {
  let app = existingApps.find((a) => a.name === `pwpoc-${name}`);
  if (app) {
    console.log(`reusing domain app ${app.name} -> ${app.domain}`);
  } else {
    app = await api('POST', 'domain_applications', {
      name: `pwpoc-${name}`,
      identifier: `pwpoc-${name}`,
      call_handler: 'relay_context',
      call_relay_context: `pwpoc_${name}`,
    });
    if (!app.id) throw new Error(`domain app pwpoc-${name} create failed: ${JSON.stringify(app)}`);
    console.log(`domain app ${app.name} -> ${app.domain} (${app.call_relay_context})`);
  }
  domainApps.push({ id: app.id, name: app.name, domain: app.domain, context: `pwpoc_${name}` });
}

// numbers, in preference order per slot:
//   1. a DID the user explicitly offered (PWPOC_REUSE_DIDS, comma-separated
//      E.164) — its routing is snapshotted so teardown restores it verbatim
//   2. a pwpoc-named number from an earlier run of this harness
//   3. purchase (last resort: spends money and locks the number for 14 days)
const allNumbers = (await api('GET', 'phone_numbers?page_size=200')).data;
const owned = allNumbers.filter((n) => (n.name || '').startsWith('pwpoc-'));
const offered = (process.env.PWPOC_REUSE_DIDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const wanted = [
  { name: 'pwpoc-child-did', context: 'pwpoc_child' },
  { name: 'pwpoc-inbound-did', context: 'pwpoc_inbound' },
];
const phoneNumbers = [];
for (const want of wanted) {
  let num = null;
  let prior = null;
  while (offered.length && !num) {
    const e164 = offered.shift();
    num = allNumbers.find((n) => n.number === e164 && !phoneNumbers.some((p) => p.id === n.id));
    if (!num) console.log(`offered DID ${e164} not found on ${SPACE}, skipping`);
  }
  if (num) {
    prior = snapshotNumberRouting(num);
    console.log(`adopting user DID ${num.number} for ${want.name} (routing snapshotted for restore)`);
  } else {
    num = owned.find((n) => n.name === want.name);
  }
  if (!num) {
    const search = await api('GET', 'phone_numbers/search?max_results=1');
    num = await api('POST', 'phone_numbers', { number: search.data[0].e164 });
    console.log(`purchased ${num.number}`);
  } else if (!prior) {
    console.log(`reusing ${num.number} (${want.name})`);
  }
  const updated = await api('PUT', `phone_numbers/${num.id}`, {
    name: want.name,
    call_handler: 'relay_context',
    call_relay_context: want.context,
  });
  phoneNumbers.push({
    id: updated.id,
    number: updated.number,
    name: want.name,
    context: want.context,
    ...(prior ? { reused: true, prior } : {}),
  });
}

// web-phone SIP endpoint: reuse if present, create otherwise; keep a known
// password in webphone.json so the in-app SIP.js phone can register.
const { randomBytes } = await import('node:crypto');
const webphonePath = scoped('webphone.json');
const saved = fs.existsSync(webphonePath) ? JSON.parse(fs.readFileSync(webphonePath, 'utf8')) : null;
const existingEps = (await api('GET', 'endpoints/sip?page_size=200')).data;
let ep = existingEps.find((e) => e.username === 'pwpoc-webphone');
let password = saved?.password ?? null;
if (!ep) {
  password = randomBytes(18).toString('base64url');
  ep = await api('POST', 'endpoints/sip', { username: 'pwpoc-webphone', password });
  console.log('created sip endpoint pwpoc-webphone');
} else if (!password) {
  password = randomBytes(18).toString('base64url');
  await api('PUT', `endpoints/sip/${ep.id}`, { password });
  console.log('reset pwpoc-webphone password (no saved credential)');
} else {
  console.log('reusing pwpoc-webphone endpoint');
}
fs.writeFileSync(webphonePath, JSON.stringify({ id: ep.id, username: 'pwpoc-webphone', password }, null, 2));

fs.writeFileSync(
  scoped('topology.json'),
  JSON.stringify(
    {
      createdAt: new Date().toISOString().slice(0, 10),
      space: SPACE,
      note: 'Resources created by this POC (pwpoc- prefix) are deleted by teardown.mjs; adopted user DIDs (reused: true) have their prior routing restored instead. Purchased numbers have a 14-day release lock.',
      sipHostSuffix: '.dapp.signalwire.com',
      domainApps,
      sipEndpoints: [{ id: ep.id, username: 'pwpoc-webphone' }],
      phoneNumbers,
    },
    null,
    2
  )
);
console.log('topology.json written');
