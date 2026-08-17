/**
 * evidence.mjs — the long-ring / timeout-window / busy-signal evidence matrix.
 *
 *   node apps/relay/live/evidence.mjs list
 *   node apps/relay/live/evidence.mjs <scenario>
 *   node apps/relay/live/evidence.mjs all          # every scenario, one child process each
 *
 * The question under test, per scenario, is what the PLATFORM does with an
 * inbound leg that is connected-but-unanswered for a long time:
 *   - does a connect timeout under 20s keep the call to one offer / one id?
 *   - does a timeout of 30/45s extend the window, or does the platform
 *     re-offer at ~20s regardless (timer starting at the connect)?
 *   - when a re-offer lands mid-ring, which call id carries the audio?
 *   - what does a busy B-leg reject with, and what does the caller hear
 *     after hangup('busy') in the exception flow?
 *
 * Four targets share one harness: the guarded relay app (src/), a raw
 * customer-shaped handler on the same old SDK (no guard, connect on every
 * offer), the @signalwire/sdk app (apps/serversdk), and SWML answer_on_bridge
 * (static script — no tunnel needed). The child simulator and the PSTN caller
 * are test scaffolding on the old SDK in every run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SignalWire, Voice } from '@signalwire/realtime-api';
import { RelayClient } from '@signalwire/sdk';
import { loadConfig } from '../src/config.js';
import { startApp } from '../src/signalwire/app.js';
import { startApp as startServerSdkApp } from '../../serversdk/src/signalwire/app.js';
import { callerIdentity } from '../../serversdk/src/signalwire/flow.js';
import { isAllowed, buildWhitelist } from '../src/identity.js';
import { safeDescribe } from '../src/faults.js';
import { compileStatic, createStaticPusher } from '../../swml/src/signalwire/static.js';
import { buildWhitelist as buildSwmlWhitelist } from '../../swml/src/whitelist.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const { loadRootEnv } = await import('../../../shared/env.mjs');
const { scopedPath } = await import('../../../shared/provision.mjs');
loadRootEnv();
const topology = JSON.parse(
  fs.readFileSync(scopedPath(here, 'topology.json', process.env.SIGNALWIRE_SPACE_URL), 'utf8')
);
const PROJECT = process.env.SIGNALWIRE_PROJECT_ID;
const TOKEN = process.env.SIGNALWIRE_TOKEN;
const SPACE = process.env.SIGNALWIRE_SPACE_URL;

const dapp = (name) => topology.domainApps.find((d) => d.name === name).domain + topology.sipHostSuffix;
const CHILD_SIP = `sip:child@${dapp('pwpoc-child')}`;
const DID_CHILD = topology.phoneNumbers.find((n) => n.name === 'pwpoc-child-did').number;
const INBOUND_DID = topology.phoneNumbers.find((n) => n.name === 'pwpoc-inbound-did');

// ── scenario matrix ──────────────────────────────────────────────────────────
const SCENARIOS = {
  // Does timeout < 20 keep it to one offer? Does 30/45 extend the window?
  'relay-t18-never': { target: 'relay', timeout: 18, child: 'never' },
  'relay-t30-never': { target: 'relay', timeout: 30, child: 'never' },
  'relay-t45-never': { target: 'relay', timeout: 45, child: 'never' },
  // Mid-ring re-offer: which call id carries the audio at a 30s pickup?
  'relay-t45-answer30': { target: 'relay', timeout: 45, child: 'answer', answerAtMs: 35_000, talkMs: 5000 },
  'relayraw-t45-answer30': { target: 'relayraw', timeout: 45, child: 'answer', answerAtMs: 35_000, talkMs: 5000 },
  // The customer's busy-signal bug, exception flow: connect throws, hangup('busy').
  'relayraw-busy': { target: 'relayraw', timeout: 18, child: 'busy' },
  'serversdk-busy': { target: 'serversdk', timeout: 18, child: 'busy' },
  // The A/B pair for ticket verification: the customer's EXACT reported shape
  // (try connect / catch hangup('busy')) on both SDKs, plus their ringback
  // playlist variant and their exact production timeout of 20 (the window
  // boundary — does it ring out clean or die by the platform kill?).
  'relayraw-busy-ringback': { target: 'relayraw', timeout: 18, child: 'busy', ringback: true },
  'serversdkraw-busy': { target: 'serversdkraw', timeout: 18, child: 'busy' },
  'relayraw-t20-never': { target: 'relayraw', timeout: 20, child: 'never' },
  'serversdkraw-t20-never': { target: 'serversdkraw', timeout: 20, child: 'never' },
  // Same window questions on the current server SDK…
  'serversdk-t18-never': { target: 'serversdk', timeout: 18, child: 'never' },
  'serversdk-t45-never': { target: 'serversdk', timeout: 45, child: 'never' },
  'serversdk-t45-answer30': { target: 'serversdk', timeout: 45, child: 'answer', answerAtMs: 35_000, talkMs: 5000 },
  // …and the SWML answer_on_bridge control.
  'swml-t18-never': { target: 'swml', timeout: 18, child: 'never' },
  'swml-t45-never': { target: 'swml', timeout: 45, child: 'never' },
  'swml-t45-answer30': { target: 'swml', timeout: 45, child: 'answer', answerAtMs: 35_000, talkMs: 5000 },
};

const arg = process.argv[2];
if (!arg || arg === 'list') {
  console.log(Object.keys(SCENARIOS).join('\n'));
  process.exit(arg ? 0 : 2);
}
if (arg === 'all') {
  const failed = [];
  for (const name of Object.keys(SCENARIOS)) {
    console.log(`\n════ ${name} ════`);
    const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], { stdio: 'inherit' });
    if (res.status !== 0) failed.push(name);
  }
  console.log(failed.length ? `\nFAILED: ${failed.join(', ')}` : '\nall scenarios completed');
  process.exit(failed.length ? 1 : 0);
}
const spec = SCENARIOS[arg];
if (!spec) {
  console.error(`unknown scenario ${arg} — try: node evidence.mjs list`);
  process.exit(2);
}

// ── logging (same JSONL shape as smoke.mjs) ─────────────────────────────────
const t0 = Date.now();
const logPath = path.join(here, `evidence-${arg}.log`);
fs.writeFileSync(logPath, '');
function jlog(evt, data = {}) {
  const entry = { ms: Date.now() - t0, evt, ...data };
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  console.log(`+${String(entry.ms).padStart(6)}ms ${evt}`, JSON.stringify(data));
}
const appLogger = {
  info: (msg, data) => jlog(`app:${msg}`, data),
  warn: (msg, data) => jlog(`app:warn:${msg}`, data),
  error: (msg, data) => jlog(`app:error:${msg}`, data),
  debug: (msg, data) => jlog(`app:debug:${msg}`, data),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errShape = (e) => ({
  code: e?.code ?? null,
  message: e?.message ?? safeDescribe(e),
  isError: e instanceof Error,
  constructor: e?.constructor?.name ?? null,
});

// ── DID arming (fresh-GET verification, mode-collision rule) ────────────────
const auth = 'Basic ' + Buffer.from(`${PROJECT}:${TOKEN}`).toString('base64');
const didUrl = `https://${SPACE}/api/relay/rest/phone_numbers/${INBOUND_DID.id}`;
async function rest(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${url}: ${safeDescribe(json)}`);
  return json;
}
async function armDid(fields, label) {
  await rest(didUrl, 'PUT', fields);
  const state = await rest(didUrl, 'GET'); // never trust the write's echo
  const view = {
    call_handler: state.call_handler,
    call_relay_context: state.call_relay_context ?? null,
    call_relay_script_url: state.call_relay_script_url ?? null,
  };
  jlog('did-armed', { label, ...view });
  for (const [k, v] of Object.entries(fields)) {
    if (state[k] !== v) throw new Error(`arming verify failed: ${k} is ${state[k]}, wanted ${v}`);
  }
  return view;
}
const armRelayContext = () =>
  armDid({ call_handler: 'relay_context', call_relay_context: INBOUND_DID.context }, 'relay_context');

// ── shared whitelist / authorize (the caller's DID is the allowed identity) ─
const AUTH_DELAY_MS = 1500;
const whitelistEntries = [{ kind: 'pstn', value: DID_CHILD }];
const whitelistSet = buildWhitelist(whitelistEntries, { region: 'US' });
const delayedAuthorize = async (identity) => {
  await sleep(AUTH_DELAY_MS);
  return isAllowed(identity, whitelistSet, { region: 'US' });
};

// ── offer instrumentation ────────────────────────────────────────────────────
const offers = [];
function recordOffer(call, extra = {}) {
  const entry = { ms: Date.now() - t0, callId: call.callId, from: call.from ?? null, state: call.state ?? null };
  offers.push(entry);
  jlog('offer', { index: offers.length - 1, ...entry, ...extra });
}

// ── targets ──────────────────────────────────────────────────────────────────
const cleanups = [];

async function startRelayTarget() {
  await armRelayContext();
  const config = loadConfig({
    SIGNALWIRE_PROJECT_ID: PROJECT,
    SIGNALWIRE_TOKEN: TOKEN,
    PWPOC_CHILD_SIP_URI: CHILD_SIP,
    PWPOC_WHITELIST: JSON.stringify(whitelistEntries),
    PWPOC_AUTH_DELAY_MS: String(AUTH_DELAY_MS),
    PWPOC_AUTH_TTL_MS: String(AUTH_DELAY_MS + 5000),
    PWPOC_DIAL_TIMEOUT_SEC: String(spec.timeout),
    PWPOC_CONNECT_DEADLINE_MS: String((spec.timeout + 15) * 1000),
    PWPOC_OUTBOUND_CALLER_ID: INBOUND_DID.number,
  });
  const app = await startApp({
    config,
    logger: appLogger,
    onOffer: (topic, call) => {
      recordOffer(call, { topic });
      try {
        call.on('call.state', (p) => jlog('aleg-state', { callId: p?.callId ?? call.callId, state: p?.callState ?? call.state }));
      } catch { /* observer only */ }
    },
  });
  cleanups.push(() => app.drain());
}

/**
 * The customer's handler shape on the old SDK: lookup, then connectSip, on
 * EVERY offer, no guard, no dedup. A 409 is logged and left alone. In the
 * busy scenario the exception flow calls hangup('busy') — the reported bug.
 */
async function startRelayRawTarget() {
  await armRelayContext();
  const client = await SignalWire({ project: PROJECT, token: TOKEN });
  await client.voice.listen({
    topics: [INBOUND_DID.context],
    onCallReceived: (call) => {
      const index = offers.length;
      recordOffer(call, { raw: true });
      try {
        call.on('call.state', (p) => jlog('aleg-state', { callId: p?.callId ?? call.callId, state: p?.callState ?? call.state }));
      } catch { /* observer only */ }
      (async () => {
        await sleep(AUTH_DELAY_MS); // their whitelist API check
        jlog('raw-connecting', { index, callId: call.callId, ringback: !!spec.ringback });
        try {
          const connectArgs = { from: call.from, to: CHILD_SIP, timeout: spec.timeout };
          if (spec.ringback) {
            // The customer's exact ringback shape from the ticket snippet.
            connectArgs.ringback = new Voice.Playlist({ volume: 1 }).add(
              Voice.Playlist.Ringtone({ name: 'us', duration: 5 })
            );
          }
          const result = await call.connectSip(connectArgs);
          jlog('raw-connect-resolved', { index, callId: call.callId, resultType: typeof result, state: call.state });
          await call.disconnected();
          jlog('raw-peer-disconnected', { index, callId: call.callId });
        } catch (e) {
          const shape = errShape(e);
          jlog('raw-connect-error', { index, callId: call.callId, ...shape });
          if (Number(shape.code) === 409) {
            jlog('raw-409-standdown', { index, callId: call.callId });
            return;
          }
          if (spec.child === 'busy') {
            // The reported bug: does the caller actually hear busy after this?
            try {
              await call.hangup('busy');
              jlog('raw-hangup-busy-ok', { index, callId: call.callId });
            } catch (e2) {
              jlog('raw-hangup-busy-failed', { index, callId: call.callId, ...errShape(e2) });
            }
          }
        }
      })().catch((e) => jlog('raw-escaped', errShape(e)));
    },
  });
  cleanups.push(() => client.disconnect());
}

/**
 * The customer's EXACT reported shape on the CURRENT server SDK:
 * try { connect } … failed/threw → hangup('busy'). No guard, no dedup —
 * the point is wire-level fidelity to the ticket, not good architecture.
 */
async function startServerSdkRawTarget() {
  await armRelayContext();
  const client = new RelayClient({ project: PROJECT, token: TOKEN, contexts: [INBOUND_DID.context] });
  client.onCall((call) => {
    const index = offers.length;
    recordOffer(call, { raw: true, sdk: 'serversdk' });
    (async () => {
      await sleep(AUTH_DELAY_MS); // their whitelist API check
      jlog('raw-connecting', { index, callId: call.callId });
      try {
        const ack = await call.connect([[{
          type: 'sip',
          params: { to: CHILD_SIP, from: callerIdentity(call), timeout: spec.timeout },
        }]]);
        jlog('raw-connect-ack', { index, callId: call.callId, code: ack?.code ?? null });
        const outcome = await call.waitFor(
          'calling.call.connect',
          (e) => {
            const s = e?.connectState ?? e?.params?.connect_state ?? null;
            return s === 'connected' || s === 'failed' || s === 'disconnected';
          },
          (spec.timeout + 15) * 1000,
        );
        const state = outcome?.connectState ?? outcome?.params?.connect_state ?? null;
        jlog('raw-connect-outcome', { index, callId: call.callId, connectState: state });
        if (state === 'connected') {
          await call.waitForEnded();
          jlog('raw-ended-after-bridge', { index, callId: call.callId });
          return;
        }
        await call.hangup('busy'); // the ticket's exception flow, verbatim
        jlog('raw-hangup-busy-ok', { index, callId: call.callId });
      } catch (e) {
        jlog('raw-connect-error', { index, callId: call.callId, ...errShape(e) });
        try {
          await call.hangup('busy');
          jlog('raw-hangup-busy-ok', { index, callId: call.callId });
        } catch (e2) {
          jlog('raw-hangup-busy-failed', { index, callId: call.callId, ...errShape(e2) });
        }
      }
    })().catch((e) => jlog('raw-escaped', errShape(e)));
  });
  await client.connect();
  cleanups.push(() => client.disconnect());
}

async function startServerSdkTarget() {
  await armRelayContext();
  const app = await startServerSdkApp({
    config: {
      project: PROJECT,
      token: TOKEN,
      // No host override: the space hostname 302s the websocket upgrade
      // (measured), exactly like the old SDK's C9. The default RELAY
      // endpoint authenticates the project/token pair fine.
      inboundContext: INBOUND_DID.context,
      authorize: delayedAuthorize,
      childSipUri: CHILD_SIP,
      dialTimeoutSec: spec.timeout,
    },
    logger: appLogger,
    onOffer: (context, call) => {
      recordOffer(call, { context, sdk: 'serversdk' });
      try {
        call.on('calling.call.state', (e) => jlog('aleg-state', { callId: call.callId, state: e?.callState ?? e?.params?.call_state ?? null }));
        call.on('calling.call.connect', (e) => jlog('aleg-connect', { callId: call.callId, state: e?.connectState ?? e?.params?.connect_state ?? null }));
      } catch { /* observer only */ }
    },
  });
  cleanups.push(() => app.drain());
}

async function startSwmlTarget() {
  const pusher = createStaticPusher({ spaceUrl: SPACE, projectId: PROJECT, token: TOKEN, name: 'pwpoc-evidence' });
  const doc = compileStatic({
    keys: buildSwmlWhitelist({ pstn: [DID_CHILD] }).keys,
    childUri: CHILD_SIP,
    timeout: spec.timeout,
  });
  const pushed = await pusher.push(doc);
  if (!pushed.supported) throw new Error('space has no swml_script hosting');
  jlog('swml-pushed', { requestUrl: pushed.requestUrl, timeout: spec.timeout });
  await armDid({ call_handler: 'relay_script', call_relay_script_url: pushed.requestUrl }, 'swml-static');
  // The mode-collision rule: SWML borrows the DID, relay gets it back.
  cleanups.push(() => armRelayContext());
}

// ── child simulator (scaffolding, old SDK) ───────────────────────────────────
async function startChildSim() {
  const client = await SignalWire({ project: PROJECT, token: TOKEN });
  await client.voice.listen({
    topics: ['pwpoc_child'],
    onCallReceived: (call) => {
      (async () => {
        jlog('child-offer', { callId: call.callId, from: call.from });
        call.on('call.state', (p) => jlog('child-state', { callId: call.callId, state: p?.callState ?? call.state }));
        if (spec.child === 'answer') {
          // Wall-clock pickup: every delivered B-leg races to answer at the
          // same moment (inside the SECOND connect window when re-offers
          // occur), so the logs show which call id actually wins the bridge.
          await sleep(Math.max(0, t0 + spec.answerAtMs - Date.now()));
          try {
            await call.answer();
            jlog('child-answered', { callId: call.callId, atMs: Date.now() - t0 });
          } catch (e) {
            jlog('child-answer-failed', { callId: call.callId, atMs: Date.now() - t0, ...errShape(e) });
          }
        } else if (spec.child === 'busy') {
          await call.hangup('busy');
          jlog('child-busy-sent', { callId: call.callId });
        } else {
          jlog('child-ignoring', { callId: call.callId });
        }
      })().catch((e) => jlog('child-error', errShape(e)));
    },
  });
  cleanups.push(() => client.disconnect());
}

// ── run ──────────────────────────────────────────────────────────────────────
jlog('scenario-start', { scenario: arg, ...spec, authDelayMs: AUTH_DELAY_MS });

await startChildSim();
const targets = { relay: startRelayTarget, relayraw: startRelayRawTarget, serversdk: startServerSdkTarget, serversdkraw: startServerSdkRawTarget, swml: startSwmlTarget };
await targets[spec.target]();
jlog('target-ready', { target: spec.target });

const caller = await SignalWire({ project: PROJECT, token: TOKEN });
cleanups.push(() => caller.disconnect());
jlog('caller-dialing', { from: DID_CHILD, to: INBOUND_DID.number });
const dialStarted = Date.now();
let callerCall = null;
try {
  callerCall = await caller.voice.dialPhone({ from: DID_CHILD, to: INBOUND_DID.number, timeout: 55 });
  jlog('caller-answered', { afterMs: Date.now() - dialStarted, callId: callerCall.callId });
} catch (e) {
  const m = safeDescribe(e).match(/"reason":\s*"(\w+)"/);
  jlog('caller-dial-failed', { afterMs: Date.now() - dialStarted, reason: m?.[1] ?? null, ...errShape(e) });
}

if (callerCall && spec.talkMs) {
  jlog('talking', { forMs: spec.talkMs });
  await sleep(spec.talkMs);
  try {
    await callerCall.hangup();
    jlog('caller-hungup', {});
  } catch (e) {
    jlog('caller-hangup-failed', errShape(e));
  }
}

// let trailing re-offers, state events and teardown land
await sleep(8000);

jlog('scenario-summary', {
  offers: offers.length,
  offerCallIds: [...new Set(offers.map((o) => o.callId))].length,
  offerTimeline: offers.map((o) => ({ ms: o.ms, callId: o.callId })),
  callerAnswered: callerCall !== null,
});

// ── CDRs for this window ─────────────────────────────────────────────────────
await sleep(3000);
try {
  const res = await fetch(`https://${SPACE}/api/voice/logs?page_size=30`, { headers: { Authorization: auth } });
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
  fs.writeFileSync(path.join(here, `evidence-${arg}-cdr.json`), JSON.stringify(cdrs, null, 2));
  jlog('cdrs', { count: cdrs.length });
  for (const c of cdrs) jlog('cdr', c);
} catch (e) {
  jlog('cdr-fetch-failed', errShape(e));
}

// ── teardown ─────────────────────────────────────────────────────────────────
jlog('draining', {});
const force = setTimeout(() => { jlog('force-exit', {}); process.exit(0); }, 20_000);
for (const fn of cleanups.reverse()) {
  try { await fn(); } catch (e) { jlog('cleanup-error', errShape(e)); }
}
clearTimeout(force);
jlog('scenario-done', {});
process.exit(0);
