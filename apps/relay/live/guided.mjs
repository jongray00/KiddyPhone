/**
 * guided.mjs — the cell-phone test listener.
 *
 * Unlike smoke.mjs (which places its own SDK calls and exits), this starts
 * the real app and then WAITS: the caller is you, dialing the inbound DID
 * from your own handset. Allowed calls bridge to the in-page web phone; the
 * deny card's whitelist deliberately excludes your cell, so your handset
 * must never show a connected state — that is the product promise on a real
 * carrier leg, observed on a real screen.
 *
 * Runs until killed (the console's stop button). JSONL on stdout always.
 *
 * env:
 *   PWPOC_GUIDED_CARD   allow | deny            (default allow)
 *   PWPOC_CELL          +E164 of your handset   (required)
 *   PWPOC_CHILD_SIP_URI where allowed calls bridge (the web phone)
 *   PWPOC_AUTH_DELAY_MS simulated lookup time   (default 1500)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const DID_INBOUND = topology.phoneNumbers.find((n) => n.name === 'pwpoc-inbound-did').number;

const CARD = (process.env.PWPOC_GUIDED_CARD || 'allow').trim();
const CELL = (process.env.PWPOC_CELL || '').trim();
const CHILD_SIP = (process.env.PWPOC_CHILD_SIP_URI || '').trim();
const AUTH_DELAY_MS = Math.min(20000, Math.max(0, Number(process.env.PWPOC_AUTH_DELAY_MS || 1500)));
if (!CELL) {
  console.error('PWPOC_CELL is required: the guided cards test from a real handset');
  process.exit(2);
}
if (!CHILD_SIP) {
  console.error('PWPOC_CHILD_SIP_URI is required (the web phone the allowed call bridges to)');
  process.exit(2);
}

const t0 = Date.now();
function jlog(evt, data = {}) {
  console.log(JSON.stringify({ ms: Date.now() - t0, evt, ...data }));
}
const appLogger = {
  info: (msg, data) => jlog(`app:${msg}`, data),
  warn: (msg, data) => jlog(`app:warn:${msg}`, data),
  error: (msg, data) => jlog(`app:error:${msg}`, data),
  debug: (msg, data) => jlog(`app:debug:${msg}`, data),
};

// allow: your cell IS the whitelist. deny: the whitelist is valid but your
// cell is not on it (config fails closed on an empty list, by design).
const whitelist =
  CARD === 'deny'
    ? [{ kind: 'pstn', value: '+15005550006' }]
    : [{ kind: 'pstn', value: CELL }];

const config = loadConfig({
  SIGNALWIRE_PROJECT_ID: process.env.SIGNALWIRE_PROJECT_ID,
  SIGNALWIRE_TOKEN: process.env.SIGNALWIRE_TOKEN,
  PWPOC_CHILD_SIP_URI: CHILD_SIP,
  PWPOC_WHITELIST: JSON.stringify(whitelist),
  PWPOC_AUTH_DELAY_MS: String(AUTH_DELAY_MS),
  PWPOC_AUTH_TTL_MS: String(AUTH_DELAY_MS + 5000),
  PWPOC_DIAL_TIMEOUT_SEC: '30',
  PWPOC_OUTBOUND_CALLER_ID: DID_INBOUND,
});

// Per-call CDR pull: the billing ledger is the demo's proof, so every call
// gets its own fetch a few seconds after its A-leg ends (records land late).
let activeCall = null; // { callId, startedAt }
async function emitCdrs(windowStart) {
  await new Promise((r) => setTimeout(r, 3500));
  try {
    const auth = Buffer.from(
      `${process.env.SIGNALWIRE_PROJECT_ID}:${process.env.SIGNALWIRE_TOKEN}`
    ).toString('base64');
    const res = await fetch(`https://${process.env.SIGNALWIRE_SPACE_URL}/api/voice/logs?page_size=30`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    const body = await res.json();
    const cdrs = (body.data ?? [])
      .filter((c) => new Date(c.created_at) >= new Date(windowStart - 10_000))
      .map((c) => ({
        id: c.id, parent_id: c.parent_id, from: c.from, to: c.to,
        direction: c.direction, status: c.status, type: c.type,
        duration_ms: c.duration_ms, billing_ms: c.billing_ms,
        charge: c.charge, charge_details: c.charge_details, created_at: c.created_at,
      }));
    jlog('cdrs', { count: cdrs.length });
    for (const c of cdrs) jlog('cdr', c);
  } catch (e) {
    jlog('cdr-fetch-failed', { error: safeDescribe(e) });
  }
}

const app = await startApp({
  config,
  logger: appLogger,
  onOffer: (topic, call) => {
    if (!activeCall) activeCall = { callId: call.callId, startedAt: Date.now() };
    jlog('offer', { topic, callId: call.callId, from: call.from, to: call.to, state: call.state });
    try {
      call.on('call.state', (p) => {
        const state = p?.callState ?? call.state;
        jlog('aleg-state', { callId: p?.callId ?? call.callId, state });
        if (state === 'ended' && activeCall && (p?.callId ?? call.callId) === activeCall.callId) {
          const { startedAt } = activeCall;
          activeCall = null; // the next offer opens a fresh window
          emitCdrs(startedAt);
        }
      });
    } catch { /* observer only */ }
  },
});

jlog('guided-ready', {
  card: CARD,
  cell: CELL,
  did: DID_INBOUND,
  child: CHILD_SIP,
  authDelayMs: AUTH_DELAY_MS,
  whitelisted: CARD !== 'deny',
});

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  jlog('guided-stopping', { signal });
  try {
    await app.drain();
  } catch (e) {
    jlog('guided-drain-error', { error: safeDescribe(e) });
  }
  process.exit(0);
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
