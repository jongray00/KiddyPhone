/**
 * teardown.mjs — delete exactly what setup created (topology.json is the
 * manifest), then re-inventory and diff against the pre-run snapshots.
 * Nothing outside the manifest is ever touched.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { loadRootEnv } = await import('../../../shared/env.mjs');
const { scopedPath } = await import('../../../shared/provision.mjs');
loadRootEnv();
const SPACE = process.env.SIGNALWIRE_SPACE_URL;
const scoped = (base) => scopedPath(here, base, SPACE);
const auth = Buffer.from(
  `${process.env.SIGNALWIRE_PROJECT_ID}:${process.env.SIGNALWIRE_TOKEN}`
).toString('base64');
const headers = { Authorization: `Basic ${auth}` };

const topology = JSON.parse(fs.readFileSync(scoped('topology.json'), 'utf8'));

async function del(kind, id, label) {
  const res = await fetch(`https://${SPACE}/api/relay/rest/${kind}/${id}`, {
    method: 'DELETE',
    headers,
  });
  console.log(`delete ${kind}/${label}: ${res.status}`);
}

for (const app of topology.domainApps) await del('domain_applications', app.id, app.name);
for (const num of topology.phoneNumbers) {
  if (num.reused && num.prior) {
    // an adopted user DID: put its routing back exactly as we found it
    const res = await fetch(`https://${SPACE}/api/relay/rest/phone_numbers/${num.id}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(num.prior),
    });
    console.log(`restore phone_numbers/${num.number} -> prior routing: ${res.status}`);
  } else {
    await del('phone_numbers', num.id, num.number);
  }
}
for (const ep of topology.sipEndpoints ?? []) await del('endpoints/sip', ep.id, ep.username);

// verify: current inventory must match the pre-run snapshot
for (const [kind, pathPart] of [
  ['domain_applications', 'domain_applications'],
  ['phone_numbers', 'phone_numbers'],
  ['sip_endpoints', 'endpoints/sip'],
]) {
  const res = await fetch(`https://${SPACE}/api/relay/rest/${pathPart}?page_size=200`, { headers });
  const now = (await res.json()).data.map((x) => x.id).sort();
  const pre = JSON.parse(
    fs.readFileSync(scoped(`inventory-pre-${kind}.json`), 'utf8')
  ).data.map((x) => x.id).sort();
  const extra = now.filter((id) => !pre.includes(id));
  const missing = pre.filter((id) => !now.includes(id));
  console.log(
    `${kind}: pre=${pre.length} now=${now.length} extra=${extra.length} missing=${missing.length}` +
      (extra.length || missing.length ? `  EXTRA=${extra} MISSING=${missing}` : '  MATCHES PRE-RUN')
  );
}
