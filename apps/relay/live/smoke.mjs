/**
 * smoke.mjs — one live matrix row per invocation: node live/smoke.mjs <row>
 *
 *   1  inbound allow, child answers   (SIP caller -> SIP child)
 *   2  inbound allow, child never answers
 *   3  inbound deny (stranger)        — also records the exact arriving From
 *   4  outbound allow                 (ATA-style digits -> PSTN DID -> child-sim)
 *   5  outbound deny
 *   6  inbound allow via PSTN         (PSTN caller DID -> SIP child)
 *
 * Three RELAY clients in one process: the app under test (src/app.js,
 * untouched), a child simulator on pwpoc_child that answers after a ring
 * delay, and a caller that originates the A-leg. Everything is logged as
 * JSONL with wall-clock offsets to live/row<N>.log, and the row ends by
 * pulling CDRs for its window into live/row<N>-cdr.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignalWire } from '@signalwire/realtime-api';
import { loadConfig } from '../src/config.js';
import { startApp } from '../src/signalwire/app.js';
import { safeDescribe } from '../src/faults.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// ── env (.env in the project root; never printed) ───────────────────────────
const { loadRootEnv } = await import('../../../shared/env.mjs');
const { scopedPath } = await import('../../../shared/provision.mjs');
loadRootEnv();
const topology = JSON.parse(
  fs.readFileSync(scopedPath(here, 'topology.json', process.env.SIGNALWIRE_SPACE_URL), 'utf8')
);
const PROJECT = process.env.SIGNALWIRE_PROJECT_ID;
const TOKEN = process.env.SIGNALWIRE_TOKEN;
const SPACE = process.env.SIGNALWIRE_SPACE_URL;

// ── topology-derived addresses ───────────────────────────────────────────────
const dapp = (name) => topology.domainApps.find((d) => d.name === name).domain + topology.sipHostSuffix;
const INBOUND_HOST = dapp('pwpoc-inbound');
const OUTBOUND_HOST = dapp('pwpoc-outbound');
const CHILD_HOST = dapp('pwpoc-child');
// The child's phone. Default: the simulator context (answers itself after 3s).
// Override with PWPOC_CHILD_SIP_URI to ring a real registered SIP device — note
// the full sip_profile domain (demo-<identifier>.sip.signalwire.com); the bare
// space domain fails the connect with a misleading 400 "No valid devices".
const CHILD_SIP = process.env.PWPOC_CHILD_SIP_URI || `sip:child@${CHILD_HOST}`;
const DID_CHILD = topology.phoneNumbers.find((n) => n.name === 'pwpoc-child-did').number;
const DID_INBOUND = topology.phoneNumbers.find((n) => n.name === 'pwpoc-inbound-did').number;

const row = process.argv[2];
if (!row) {
  console.error('usage: node live/smoke.mjs <1|2|3|4|5|6>');
  process.exit(2);
}

// ── logging ──────────────────────────────────────────────────────────────────
const t0 = Date.now();
const logPath = path.join(here, `row${row}.log`);
fs.writeFileSync(logPath, '');
function jlog(evt, data = {}) {
  const entry = { ms: Date.now() - t0, evt, ...data };
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  if (process.env.PWPOC_JSONL) {
    console.log(JSON.stringify(entry)); // machine mode for the test console
  } else {
    console.log(`+${String(entry.ms).padStart(6)}ms ${evt}`, JSON.stringify(data));
  }
}
const appLogger = {
  info: (msg, data) => jlog(`app:${msg}`, data),
  warn: (msg, data) => jlog(`app:warn:${msg}`, data),
  error: (msg, data) => jlog(`app:error:${msg}`, data),
  debug: (msg, data) => jlog(`app:debug:${msg}`, data),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── observed identity from the calibration row ──────────────────────────────
const observedPath = path.join(here, 'observed-from.json');
const observed = fs.existsSync(observedPath) ? JSON.parse(fs.readFileSync(observedPath, 'utf8')) : null;
// Whitelist host for SIP callers: what the platform actually presented in row 3.
const sipCallerHost = observed?.host ?? INBOUND_HOST;

// ── row definitions ──────────────────────────────────────────────────────────
const PARENT_USER = 'pwpoc-parent';
const STRANGER_USER = 'pwpoc-stranger';

const rows = {
  1: {
    name: 'inbound allow, child answers (SIP->SIP)',
    whitelist: [{ kind: 'sip', user: PARENT_USER, host: sipCallerHost }],
    childMode: 'answer',
    caller: { kind: 'sip', from: `sip:${PARENT_USER}@${INBOUND_HOST}`, to: `sip:child@${INBOUND_HOST}` },
    expect: 'caller answered at child pickup; exactly 1 offer; app never answers',
    talkMs: 5000,
  },
  2: {
    name: 'inbound allow, child never answers',
    whitelist: [{ kind: 'sip', user: PARENT_USER, host: sipCallerHost }],
    childMode: 'never',
    dialTimeoutSec: 10,
    caller: { kind: 'sip', from: `sip:${PARENT_USER}@${INBOUND_HOST}`, to: `sip:child@${INBOUND_HOST}` },
    expect: 'caller never answered; dial fails after ring timeout; zero billing',
  },
  3: {
    name: 'inbound deny (stranger) — calibration row',
    whitelist: [{ kind: 'pstn', value: '+15551234567' }], // nobody we will call from
    childMode: 'never',
    caller: { kind: 'sip', from: `sip:${STRANGER_USER}@${INBOUND_HOST}`, to: `sip:child@${INBOUND_HOST}` },
    expect: 'silent decline on unanswered leg; caller sees failure; no connected state',
    record: true,
  },
  4: {
    name: 'outbound allow (ATA digits -> PSTN DID -> child-sim)',
    whitelist: [{ kind: 'pstn', value: DID_CHILD }],
    childMode: 'answer',
    caller: { kind: 'sip', from: `sip:pwpoc-child-ata@${OUTBOUND_HOST}`, to: `sip:${DID_CHILD.replace('+', '')}@${OUTBOUND_HOST}` },
    expect: 'app dials E.164 via connectPhone; child-sim answers the DID leg',
    talkMs: 5000,
  },
  5: {
    name: 'outbound deny',
    whitelist: [{ kind: 'pstn', value: DID_CHILD }],
    childMode: 'never',
    caller: { kind: 'sip', from: `sip:pwpoc-child-ata@${OUTBOUND_HOST}`, to: `sip:19998887777@${OUTBOUND_HOST}` },
    expect: 'decline on unanswered leg; no dial to the destination',
  },
  6: {
    name: 'inbound allow via PSTN (DID caller -> SIP child)',
    whitelist: [{ kind: 'pstn', value: DID_CHILD }],
    childMode: 'answer',
    caller: { kind: 'phone', from: DID_CHILD, to: DID_INBOUND },
    expect: 'PSTN A-leg unanswered until child pickup; billing starts at bridge',
    talkMs: 5000,
  },
};

const spec = rows[row];
if (!spec) {
  console.error(`unknown row ${row}`);
  process.exit(2);
}
// Simulated whitelist-lookup time. KiddyPhone's stated check is ~1.5s; anything
// past ~4s means re-offers land mid-check and the guards must contain them.
const AUTH_DELAY_MS = Math.min(20000, Math.max(0, Number(process.env.PWPOC_AUTH_DELAY_MS || 1500)));

jlog('row-start', { row, name: spec.name, expect: spec.expect, authDelayMs: AUTH_DELAY_MS });

// ── app under test ───────────────────────────────────────────────────────────
const offers = [];
const config = loadConfig({
  SIGNALWIRE_PROJECT_ID: PROJECT,
  SIGNALWIRE_TOKEN: TOKEN,
  PWPOC_CHILD_SIP_URI: CHILD_SIP,
  PWPOC_WHITELIST: JSON.stringify(spec.whitelist),
  PWPOC_AUTH_DELAY_MS: String(AUTH_DELAY_MS),
  // The memoizer can only join in-flight lookups it still remembers: the cache
  // TTL must exceed the lookup's own duration or re-offers trigger fresh
  // lookups mid-check. Real deployments: TTL > p99 of the auth API.
  PWPOC_AUTH_TTL_MS: String(AUTH_DELAY_MS + 5000),
  PWPOC_DIAL_TIMEOUT_SEC: String(spec.dialTimeoutSec ?? 25),
  PWPOC_OUTBOUND_CALLER_ID: DID_INBOUND,
});

const app = await startApp({
  config,
  logger: appLogger,
  onOffer: (topic, call) => {
    offers.push({ ms: Date.now() - t0, topic, callId: call.callId, from: call.from, to: call.to });
    jlog('offer', { topic, callId: call.callId, from: call.from, to: call.to, state: call.state });
    try {
      call.on('call.state', (p) => jlog('aleg-state', { callId: p?.callId ?? call.callId, state: p?.callState ?? call.state }));
    } catch { /* observer only */ }
  },
});

// ── child simulator ──────────────────────────────────────────────────────────
const childClient = await SignalWire({ project: PROJECT, token: TOKEN });
await childClient.voice.listen({
  topics: ['pwpoc_child'],
  onCallReceived: (call) => {
    (async () => {
      jlog('child-offer', { callId: call.callId, from: call.from, to: call.to });
      call.on('call.state', (p) => jlog('child-state', { state: p?.callState ?? call.state }));
      if (spec.childMode === 'answer') {
        await sleep(3000); // ring the "child's phone" for 3s before pickup
        await call.answer();
        jlog('child-answered', { callId: call.callId });
      } else {
        jlog('child-ignoring', { callId: call.callId });
      }
    })().catch((e) => jlog('child-error', { error: safeDescribe(e) }));
  },
});
jlog('child-sim-ready', { mode: spec.childMode });

// ── caller ───────────────────────────────────────────────────────────────────
const callerClient = await SignalWire({ project: PROJECT, token: TOKEN });
jlog('caller-dialing', spec.caller);
const dialStarted = Date.now();
let callerCall = null;
try {
  callerCall =
    spec.caller.kind === 'sip'
      ? await callerClient.voice.dialSip({ from: spec.caller.from, to: spec.caller.to, timeout: 30 })
      : await callerClient.voice.dialPhone({ from: spec.caller.from, to: spec.caller.to, timeout: 30 });
  jlog('caller-answered', { afterMs: Date.now() - dialStarted, callId: callerCall.callId });
} catch (e) {
  jlog('caller-dial-failed', { afterMs: Date.now() - dialStarted, error: safeDescribe(e), code: e?.code ?? null });
}

if (callerCall && spec.talkMs) {
  jlog('talking', { forMs: spec.talkMs });
  await sleep(spec.talkMs);
  jlog('caller-hanging-up', {});
  try {
    await callerCall.hangup();
    jlog('caller-hungup', {});
  } catch (e) {
    jlog('caller-hangup-failed', { error: safeDescribe(e) });
  }
}

// let trailing state events and the app's own teardown land
await sleep(4000);

// ── record observed From for calibration (row 3) ────────────────────────────
if (spec.record && offers.length > 0) {
  const raw = offers[0].from;
  const m = typeof raw === 'string' ? raw.match(/^sips?:([^@]+)@([^;>]+)/i) : null;
  const data = { raw, user: m?.[1] ?? null, host: m?.[2]?.toLowerCase() ?? null };
  fs.writeFileSync(observedPath, JSON.stringify(data, null, 2));
  jlog('observed-from-recorded', data);
}

// ── summary ──────────────────────────────────────────────────────────────────
jlog('row-summary', {
  offers: offers.length,
  offerCallIds: [...new Set(offers.map((o) => o.callId))].length,
  callerAnswered: callerCall !== null,
});

// ── CDRs for this window ─────────────────────────────────────────────────────
await sleep(3000);
try {
  const auth = Buffer.from(`${PROJECT}:${TOKEN}`).toString('base64');
  const res = await fetch(`https://${SPACE}/api/voice/logs?page_size=30`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  const body = await res.json();
  const windowStart = new Date(t0 - 10_000);
  const cdrs = (body.data ?? [])
    .filter((c) => new Date(c.created_at) >= windowStart)
    .map((c) => ({
      id: c.id, parent_id: c.parent_id, from: c.from, to: c.to,
      direction: c.direction, status: c.status, type: c.type,
      duration_ms: c.duration_ms, billing_ms: c.billing_ms,
      charge: c.charge, charge_details: c.charge_details, created_at: c.created_at,
    }));
  fs.writeFileSync(path.join(here, `row${row}-cdr.json`), JSON.stringify(cdrs, null, 2));
  jlog('cdrs', { count: cdrs.length });
  for (const c of cdrs) jlog('cdr', c);
} catch (e) {
  jlog('cdr-fetch-failed', { error: safeDescribe(e) });
}

// ── drain and exit ───────────────────────────────────────────────────────────
jlog('draining', {});
const force = setTimeout(() => { jlog('force-exit', {}); process.exit(0); }, 15_000);
try {
  await app.drain();
  await childClient.disconnect();
  await callerClient.disconnect();
} catch (e) {
  jlog('drain-error', { error: safeDescribe(e) });
}
clearTimeout(force);
jlog('row-done', {});
process.exit(0);
