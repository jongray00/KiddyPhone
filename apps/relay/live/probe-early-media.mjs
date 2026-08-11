/**
 * probe-early-media.mjs — the D16 contradiction, settled deliberately.
 *
 * Question: can a rejection message be PLAYED to a caller whose leg is never
 * answered? The space ledger once showed an unanswered leg with a TTS charge
 * and billing_ms null, which suggests yes. If it holds, a blocked caller can
 * hear "this number does not accept your call" while their handset never
 * shows connected and no voice minute is billed. That would answer the
 * silent-decline-versus-voicemail question without asking it.
 *
 * The probe listens on the inbound context itself (no app underneath), takes
 * one offer, attempts playTTS on the leg while it is still in `created`,
 * hangs up with decline, then pulls the CDRs for the window.
 *
 * SIP-to-SIP only. Run: node apps/relay/live/probe-early-media.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignalWire } from '@signalwire/realtime-api';
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
const SPACE = process.env.SIGNALWIRE_SPACE_URL;
const dapp = (name) => topology.domainApps.find((d) => d.name === name).domain + topology.sipHostSuffix;
const INBOUND_HOST = dapp('pwpoc-inbound');

const t0 = Date.now();
const jlog = (evt, data = {}) => console.log(JSON.stringify({ ms: Date.now() - t0, evt, ...data }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const result = {
  ttsPlayed: null,     // did playTTS run to completion on the unanswered leg
  ttsError: null,
  callerAnswered: null, // must stay false: no connected state, ever
  legStates: [],
};

const appClient = await SignalWire({ project: PROJECT, token: TOKEN });
await appClient.voice.listen({
  topics: ['pwpoc_inbound'],
  onCallReceived: (call) => {
    (async () => {
      jlog('offer', { callId: call.callId, from: call.from, state: call.state });
      call.on('call.state', (p) => {
        const s = p?.callState ?? call.state;
        result.legStates.push(s);
        jlog('leg-state', { state: s });
      });
      try {
        // The whole question: media on a leg still in `created`, no answer()
        const playback = await call.playTTS({
          text: 'This number does not accept your call.',
        });
        if (playback?.ended) await playback.ended();
        result.ttsPlayed = true;
        jlog('tts-played-on-unanswered-leg', { stateDuring: call.state });
      } catch (e) {
        result.ttsPlayed = false;
        result.ttsError = safeDescribe(e);
        jlog('tts-rejected', { error: result.ttsError, state: call.state });
      }
      try {
        await call.hangup('decline');
        jlog('declined', {});
      } catch (e) {
        jlog('hangup-error', { error: safeDescribe(e) });
      }
    })().catch((e) => jlog('probe-error', { error: safeDescribe(e) }));
  },
});
jlog('ready', { host: INBOUND_HOST });

const callerClient = await SignalWire({ project: PROJECT, token: TOKEN });
const dialStarted = Date.now();
jlog('caller-dialing', {});
try {
  const call = await callerClient.voice.dialSip({
    from: `sip:pwpoc-stranger@${INBOUND_HOST}`,
    to: `sip:child@${INBOUND_HOST}`,
    timeout: 25,
  });
  result.callerAnswered = true; // reaching here means the leg answered: P2 broken
  jlog('caller-ANSWERED', { afterMs: Date.now() - dialStarted, callId: call.callId });
  await call.hangup().catch(() => {});
} catch (e) {
  result.callerAnswered = false;
  jlog('caller-dial-failed-as-expected', { afterMs: Date.now() - dialStarted, error: safeDescribe(e) });
}

// CDRs land a few seconds after the legs die
await sleep(5000);
try {
  const auth = Buffer.from(`${PROJECT}:${TOKEN}`).toString('base64');
  const res = await fetch(`https://${SPACE}/api/voice/logs?page_size=20`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  const cdrs = ((await res.json()).data ?? [])
    .filter((c) => new Date(c.created_at) >= new Date(t0 - 10_000))
    .map((c) => ({
      from: c.from, to: c.to, direction: c.direction, status: c.status, type: c.type,
      duration_ms: c.duration_ms, billing_ms: c.billing_ms,
      charge: c.charge, charge_details: c.charge_details,
    }));
  for (const c of cdrs) jlog('cdr', c);
  const anyVoiceBilled = cdrs.some((c) => c.billing_ms > 0);
  const ttsCharged = cdrs.some((c) =>
    (c.charge_details ?? []).some?.((d) => /tts|text/i.test(JSON.stringify(d))) || (c.charge > 0 && !c.billing_ms));
  jlog('probe-summary', {
    ttsPlayed: result.ttsPlayed,
    ttsError: result.ttsError,
    callerAnswered: result.callerAnswered,
    anyVoiceBilled,
    ttsCharged,
    verdict: result.ttsPlayed && result.callerAnswered === false && !anyVoiceBilled
      ? 'EARLY MEDIA CONFIRMED: rejection audio on an unanswered leg, zero voice billing — D16 contradiction resolved'
      : result.ttsPlayed === false
        ? 'TTS refused on the unanswered leg — silent decline stands, voicemail question must go to the customer'
        : 'MIXED — read the leg states and CDRs above',
  });
} catch (e) {
  jlog('cdr-fetch-failed', { error: safeDescribe(e) });
}
process.exit(0);
