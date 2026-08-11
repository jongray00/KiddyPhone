/**
 * probe-redial.mjs — the same-caller redial case, live.
 *
 * One app process, one caller identity, two calls back to back inside the
 * auth TTL. The first decision must wait out the full lookup delay; the
 * redial must join the cached verdict and decide near-instantly. Both calls
 * must bridge and tear down cleanly — no state bleed between them.
 *
 * SIP-to-SIP only. Run: node apps/relay/live/probe-redial.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignalWire } from '@signalwire/realtime-api';
import { loadConfig } from '../src/config.js';
import { startApp } from '../src/signalwire/app.js';
import { safeDescribe } from '../src/faults.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { loadRootEnv } = await import('../../../shared/env.mjs');
const { scopedPath } = await import('../../../shared/provision.mjs');
loadRootEnv();
const topology = JSON.parse(
  fs.readFileSync(scopedPath(here, 'topology.json', process.env.SIGNALWIRE_SPACE_URL), 'utf8')
);
const PROJECT = process.env.SIGNALWIRE_PROJECT_ID;
const TOKEN = process.env.SIGNALWIRE_TOKEN;
const dapp = (name) => topology.domainApps.find((d) => d.name === name).domain + topology.sipHostSuffix;
const INBOUND_HOST = dapp('pwpoc-inbound');
const CHILD_HOST = dapp('pwpoc-child');

const AUTH_DELAY_MS = 1500;
const t0 = Date.now();
const jlog = (evt, data = {}) => console.log(JSON.stringify({ ms: Date.now() - t0, evt, ...data }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CALLER = `sip:pwpoc-parent@${INBOUND_HOST}`;
const decisions = []; // { callId, offerAt, decidedAt, allowed }
const offers = new Map(); // callId -> offer wall-clock

const config = loadConfig({
  SIGNALWIRE_PROJECT_ID: PROJECT,
  SIGNALWIRE_TOKEN: TOKEN,
  PWPOC_CHILD_SIP_URI: `sip:child@${CHILD_HOST}`,
  PWPOC_WHITELIST: JSON.stringify([{ kind: 'sip', user: 'pwpoc-parent', host: INBOUND_HOST }]),
  PWPOC_AUTH_DELAY_MS: String(AUTH_DELAY_MS),
  PWPOC_AUTH_TTL_MS: '10000', // the redial window under test
  PWPOC_DIAL_TIMEOUT_SEC: '20',
});

const logger = {
  info: (msg, data) => {
    jlog(`app:${msg}`, data);
    if (msg === 'decision') {
      const offerAt = offers.get(data.callId) ?? null;
      decisions.push({ callId: data.callId, allowed: data.allowed, latencyMs: offerAt ? Date.now() - offerAt : null });
    }
  },
  warn: (msg, data) => jlog(`app:warn:${msg}`, data),
  error: (msg, data) => jlog(`app:error:${msg}`, data),
  debug: () => {},
};

const app = await startApp({
  config,
  logger,
  onOffer: (topic, call) => {
    if (!offers.has(call.callId)) offers.set(call.callId, Date.now());
    jlog('offer', { callId: call.callId, from: call.from });
  },
});

// child simulator: answers after 1s so both calls bridge
const childClient = await SignalWire({ project: PROJECT, token: TOKEN });
await childClient.voice.listen({
  topics: ['pwpoc_child'],
  onCallReceived: (call) => {
    (async () => { await sleep(1000); await call.answer(); jlog('child-answered', { callId: call.callId }); })()
      .catch((e) => jlog('child-error', { error: safeDescribe(e) }));
  },
});
jlog('ready', { caller: CALLER, authDelayMs: AUTH_DELAY_MS, ttlMs: 10000 });

const callerClient = await SignalWire({ project: PROJECT, token: TOKEN });
async function placeCall(label) {
  jlog(`${label}-dialing`, {});
  const started = Date.now();
  try {
    const call = await callerClient.voice.dialSip({ from: CALLER, to: `sip:child@${INBOUND_HOST}`, timeout: 25 });
    jlog(`${label}-answered`, { afterMs: Date.now() - started, callId: call.callId });
    await sleep(2000);
    await call.hangup();
    jlog(`${label}-hungup`, {});
    return true;
  } catch (e) {
    jlog(`${label}-failed`, { afterMs: Date.now() - started, error: safeDescribe(e) });
    return false;
  }
}

const first = await placeCall('call1');
await sleep(1500); // well inside the 10s TTL
const second = await placeCall('call2');
await sleep(3000);

const [d1, d2] = decisions;
const verdicts = {
  'call 1 answered at bridge': first,
  'call 2 (redial) answered at bridge': second,
  'both decisions ALLOW': decisions.length >= 2 && decisions.every((d) => d.allowed === true),
  'call 1 waited out the lookup (>=1.2s)': d1?.latencyMs >= 1200,
  'redial joined the cached verdict (<=400ms)': d2?.latencyMs != null && d2.latencyMs <= 400,
  'distinct call ids, no cross-call bleed': d1 && d2 && d1.callId !== d2.callId,
};
jlog('probe-summary', {
  decision1: d1 ?? null,
  decision2: d2 ?? null,
  verdicts,
  pass: Object.values(verdicts).every(Boolean),
});

await app.drain().catch(() => {});
process.exit(Object.values(verdicts).every(Boolean) ? 0 : 1);
