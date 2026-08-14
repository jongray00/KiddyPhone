import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlers, safeHangup } from '../src/signalwire/handler.js';
import { ConnectGuard, memoizeAuthorizer } from '../src/signalwire/connect-guard.js';
import { CallRegistry } from '../src/lifecycle.js';
import { buildWhitelist, isAllowed } from '../src/identity.js';

const HOST = 'pwpoc.sip.example.com';
const CHILD = `sip:child@${HOST}`;
const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeFakeCall(opts = {}) {
  const {
    from = '+15551234567',
    to = '+15559990000',
    callId = 'call-1',
    context = 'pwpoc_inbound',
    connectRejection = null,
    hangupRejection = null,
    ttsRejection = null,
  } = opts;
  // D7's whole point is an undefined resolution, so a default parameter would
  // swallow the case — distinguish "absent" from "explicitly undefined".
  const connectResult = Object.hasOwn(opts, 'connectResult') ? opts.connectResult : { peer: true };
  let resolveDisconnected;
  const call = {
    from,
    to,
    callId,
    nodeId: 'node-1',
    context,
    counts: { answer: 0, connect: 0, hangup: 0 },
    hangupReasons: [],
    async answer() {
      call.counts.answer += 1;
    },
    async connectSip() {
      call.counts.connect += 1;
      if (connectRejection) throw connectRejection;
      return connectResult;
    },
    async connectPhone() {
      call.counts.connect += 1;
      if (connectRejection) throw connectRejection;
      return connectResult;
    },
    async hangup(reason) {
      call.counts.hangup += 1;
      call.hangupReasons.push(reason);
      if (hangupRejection) throw hangupRejection;
    },
    ttsTexts: [],
    async playTTS({ text } = {}) {
      if (ttsRejection) throw ttsRejection;
      call.counts.playTTS = (call.counts.playTTS ?? 0) + 1;
      call.ttsTexts.push(text);
      return { async ended() {} };
    },
    async recordAudio() {
      call.counts.record = (call.counts.record ?? 0) + 1;
      return { async ended() {} };
    },
    disconnected: () =>
      new Promise((r) => {
        resolveDisconnected = () => r(call);
      }),
    endPeerCall: () => resolveDisconnected && resolveDisconnected(),
  };
  return call;
}

function makeDeps(overrides = {}) {
  const whitelist = buildWhitelist(
    [
      { kind: 'pstn', value: '+15551234567' },
      { kind: 'sip', user: 'grandma', host: HOST },
      { kind: 'sip', user: 'child', host: HOST },
    ],
    { region: 'US' }
  );
  const lookups = { count: 0 };
  const authorize = memoizeAuthorizer(async (id) => {
    lookups.count += 1;
    if (overrides.authFailure) throw new Error('auth API down');
    return isAllowed(id, whitelist);
  }, { ttlMs: 1000 });

  const deps = {
    authorize,
    guard: new ConnectGuard(),
    registry: new CallRegistry(),
    logger: silent,
    config: {
      childSipUri: CHILD,
      connectDeadlineMs: 500,
      dialTimeoutSec: 30,
      region: 'US',
      ...(overrides.configExtra ?? {}),
    },
    ...overrides,
  };
  delete deps.configExtra;
  return { deps, lookups };
}

// ── P1/P3: the allow path never answers; connect holds the call ─────────────

test('P3: allowed inbound call is connected, NEVER answered, torn down after peer ends', async () => {
  const { deps } = makeDeps();
  const { handleInbound } = createHandlers(deps);
  const call = makeFakeCall();

  const flow = handleInbound(call);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(call.counts.connect, 1, 'connect issued');
  assert.equal(call.counts.hangup, 0, 'call held while bridged');
  call.endPeerCall();
  await flow;

  assert.equal(call.counts.answer, 0, 'answer() must never be called');
  assert.equal(call.counts.hangup, 1, 'cleaned up after the far end dropped');
  assert.equal(deps.registry.size, 0);
});

// ── P2: blocked caller — silent decline on the unanswered leg ───────────────

test('P2: blocked caller gets hangup(decline), no connect, no answer', async () => {
  const { deps } = makeDeps();
  const { handleInbound } = createHandlers(deps);
  const call = makeFakeCall({ from: '+19998887777' });
  await handleInbound(call);
  assert.equal(call.counts.answer, 0);
  assert.equal(call.counts.connect, 0);
  assert.deepEqual(call.hangupReasons, ['decline']);
});

test('D12: SIP caller with right user, wrong domain is declined', async () => {
  const { deps } = makeDeps();
  const { handleInbound } = createHandlers(deps);
  const call = makeFakeCall({ from: `sip:grandma@${HOST}.attacker.com` });
  await handleInbound(call);
  assert.equal(call.counts.connect, 0);
  assert.deepEqual(call.hangupReasons, ['decline']);
});

// ── D4: the outage line — a 409 must not hang up ────────────────────────────

test('D1/D4: connect rejecting with the live 409 shape stands down — NO hangup', async () => {
  const { deps } = makeDeps();
  const { handleInbound } = createHandlers(deps);
  const call = makeFakeCall({
    connectRejection: { code: '409', message: 'Wait for connect to finish' },
  });
  await handleInbound(call);
  assert.equal(call.counts.hangup, 0, 'hanging up here tears down the winning bridge');
  assert.equal(call.counts.answer, 0);
  assert.equal(deps.registry.size, 0);
});

test('D2: connect rejecting 404 (stale offer) does nothing — no hangup, no crash', async () => {
  const { deps } = makeDeps();
  const { handleInbound } = createHandlers(deps);
  const call = makeFakeCall({ connectRejection: { code: '404', message: 'Call not found' } });
  await handleInbound(call);
  assert.equal(call.counts.hangup, 0);
});

test('a real connect failure (400 No valid devices) releases the caller', async () => {
  const { deps } = makeDeps();
  const { handleInbound } = createHandlers(deps);
  const call = makeFakeCall({ connectRejection: { code: '400', message: 'No valid devices' } });
  await handleInbound(call);
  assert.equal(call.counts.hangup, 1, 'caller must not sit in silence');
  assert.equal(call.counts.answer, 0);
});

// ── D7: undefined resolution is a failure, caller released ──────────────────

test('D7: connect resolving undefined releases the caller instead of silent success', async () => {
  const { deps } = makeDeps();
  const { handleInbound } = createHandlers(deps);
  const call = makeFakeCall({ connectResult: undefined });
  await handleInbound(call);
  assert.equal(call.counts.hangup, 1);
});

// ── D2/D3: duplicate offers collapse to one connect and one lookup ──────────

test('D2/D3: three offers for one logical call = one connect, one auth lookup', async () => {
  const { deps, lookups } = makeDeps();
  const { handleInbound } = createHandlers(deps);
  const calls = ['id-1', 'id-2', 'id-3'].map((callId) => {
    const c = makeFakeCall({ callId });
    setTimeout(() => c.endPeerCall(), 30);
    return c;
  });
  await Promise.all(calls.map((c) => handleInbound(c)));
  const totalConnects = calls.reduce((n, c) => n + c.counts.connect, 0);
  assert.equal(totalConnects, 1, 'single flight across call ids');
  assert.equal(lookups.count, 1, 'auth API hit once, not three times');
});

// ── fail closed: auth API down → decline, never connect ─────────────────────

test('authorization failure fails CLOSED: decline, no connect, no answer, no crash', async () => {
  const { deps } = makeDeps({ authFailure: true });
  const { handleInbound } = createHandlers(deps);
  const call = makeFakeCall();
  await handleInbound(call);
  assert.equal(call.counts.connect, 0);
  assert.deepEqual(call.hangupReasons, ['decline']);
});

// ── safeHangup: idempotent and absorbs the SDK's junk rejections ────────────

test('safeHangup absorbs a plain-object rejection and never runs twice', async () => {
  const call = makeFakeCall({ hangupRejection: { code: '404', message: 'Call not found' } });
  await safeHangup(call, 'hangup', silent);
  await safeHangup(call, 'hangup', silent);
  assert.equal(call.counts.hangup, 1);
});

// ── outbound: whitelist runs on the DESTINATION ─────────────────────────────

test('outbound to a whitelisted SIP destination connects via SIP, never answers', async () => {
  const { deps } = makeDeps();
  const { handleOutbound } = createHandlers(deps);
  const call = makeFakeCall({
    context: 'pwpoc_outbound',
    from: CHILD,
    to: `sip:grandma@${HOST}`,
  });
  setTimeout(() => call.endPeerCall(), 20);
  await handleOutbound(call);
  assert.equal(call.counts.connect, 1);
  assert.equal(call.counts.answer, 0);
});

test('outbound to a whitelisted PSTN destination in national format connects', async () => {
  const { deps } = makeDeps();
  const { handleOutbound } = createHandlers(deps);
  const call = makeFakeCall({
    context: 'pwpoc_outbound',
    from: CHILD,
    to: '(555) 123-4567',
  });
  setTimeout(() => call.endPeerCall(), 20);
  await handleOutbound(call);
  assert.equal(call.counts.connect, 1);
});

test('outbound ATA-style destination (digits as SIP user) is treated as PSTN', async () => {
  // A real ATA dials digits; the INVITE arrives as sip:<digits>@<domain>. The
  // whitelist decision and the dial must both use the E.164 those digits mean,
  // not the SIP URI (connecting to the raw URI would loop back into our own
  // domain app).
  const { deps } = makeDeps({
    config: {
      childSipUri: CHILD,
      connectDeadlineMs: 500,
      dialTimeoutSec: 30,
      region: 'US',
    },
  });
  const { handleOutbound } = createHandlers(deps);
  const connectKinds = [];
  const call = makeFakeCall({
    context: 'pwpoc_outbound',
    from: CHILD,
    to: 'sip:+15551234567@demo-pwpoc-outbound.dapp.signalwire.com',
  });
  const origSip = call.connectSip.bind(call);
  const origPhone = call.connectPhone.bind(call);
  call.connectSip = (p) => { connectKinds.push(['sip', p.to]); return origSip(p); };
  call.connectPhone = (p) => { connectKinds.push(['phone', p.to]); return origPhone(p); };
  setTimeout(() => call.endPeerCall(), 20);
  await handleOutbound(call);
  assert.deepEqual(connectKinds, [['phone', '+15551234567']]);
});

test('outbound PSTN dial uses the configured E.164 caller id when from is a SIP URI', async () => {
  const { deps } = makeDeps();
  deps.config.outboundCallerId = '+12085550100';
  const { handleOutbound } = createHandlers(deps);
  let fromSeen = null;
  const call = makeFakeCall({
    context: 'pwpoc_outbound',
    from: CHILD, // a SIP URI is not a legal PSTN caller id
    to: 'sip:+15551234567@demo-pwpoc-outbound.dapp.signalwire.com',
  });
  const orig = call.connectPhone.bind(call);
  call.connectPhone = (p) => { fromSeen = p.from; return orig(p); };
  setTimeout(() => call.endPeerCall(), 20);
  await handleOutbound(call);
  assert.equal(fromSeen, '+12085550100');
});

test('outbound to a non-whitelisted destination is declined', async () => {
  const { deps } = makeDeps();
  const { handleOutbound } = createHandlers(deps);
  const call = makeFakeCall({
    context: 'pwpoc_outbound',
    from: CHILD,
    to: '+19998887777',
  });
  await handleOutbound(call);
  assert.equal(call.counts.connect, 0);
  assert.deepEqual(call.hangupReasons, ['decline']);
});

// ── initiator/joiner: a duplicate delivery must not adopt the bridge ─────────

test('duplicate offer joining an in-flight connect stands down without holding or hanging up', async () => {
  const { deps } = makeDeps();
  const { handleInbound } = createHandlers(deps);
  const initiator = makeFakeCall({ callId: 'id-1' });
  const joiner = makeFakeCall({ callId: 'id-2' });

  const p1 = handleInbound(initiator);
  const p2 = handleInbound(joiner);

  // The joiner must finish while the initiator is still bridged: it neither
  // awaits disconnected() on its own (wrong) call object nor hangs it up.
  const joinerFinished = await Promise.race([
    p2.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 100)),
  ]);
  assert.equal(joinerFinished, true, 'joiner stood down while the bridge lives');
  assert.equal(joiner.counts.hangup, 0, 'joiner never touches its call');
  assert.equal(joiner.counts.answer, 0);

  initiator.endPeerCall();
  await p1;
  assert.equal(initiator.counts.hangup, 1, 'initiator owns the teardown');
});

// ── no-answer actions (dial timeout, failedReason noAnswer) ──────────────────

const NO_ANSWER = { connectState: 'failed', failedReason: 'noAnswer', callId: 'x' };

test('noAnswerAction decline (default): release the unanswered leg, no media', async () => {
  const { deps } = makeDeps();
  const { handleInbound } = createHandlers(deps);
  const call = makeFakeCall({ connectRejection: NO_ANSWER });
  await handleInbound(call);
  assert.equal(call.counts.answer, 0);
  assert.equal(call.counts.playTTS ?? 0, 0);
  assert.equal(call.counts.hangup, 1);
});

test('noAnswerAction early-media-message: TTS on the UNANSWERED leg, then decline', async () => {
  const { deps } = makeDeps({ configExtra: { noAnswerAction: 'early-media-message', noAnswerMessage: 'try later' } });
  const { handleInbound } = createHandlers(deps);
  const call = makeFakeCall({ connectRejection: NO_ANSWER });
  await handleInbound(call);
  assert.equal(call.counts.answer, 0, 'early media must not answer (that would bill)');
  assert.deepEqual(call.ttsTexts, ['try later']);
  assert.equal(call.counts.hangup, 1);
});

test('noAnswerAction voicemail: answer deliberately, prompt, record, hang up', async () => {
  const { deps } = makeDeps({ configExtra: { noAnswerAction: 'voicemail', noAnswerMessage: 'leave a message' } });
  const { handleInbound } = createHandlers(deps);
  const call = makeFakeCall({ connectRejection: NO_ANSWER });
  await handleInbound(call);
  assert.equal(call.counts.answer, 1, 'voicemail is the one flow that answers — billing starts here by design');
  assert.deepEqual(call.ttsTexts, ['leave a message']);
  assert.equal(call.counts.record, 1);
  assert.equal(call.counts.hangup, 1);
});

// ── busy action (failedReason busy) ──────────────────────────────────────────

const BUSY = { connectState: 'failed', failedReason: 'busy', callId: 'x' };

test('busyAction early-media-busy: busy notice on the unanswered leg, then release', async () => {
  const { deps } = makeDeps({ configExtra: { busyAction: 'early-media-busy', busyMessage: 'line busy' } });
  const { handleInbound } = createHandlers(deps);
  const call = makeFakeCall({ connectRejection: BUSY });
  await handleInbound(call);
  assert.equal(call.counts.answer, 0);
  assert.deepEqual(call.ttsTexts, ['line busy']);
  assert.equal(call.counts.hangup, 1);
});

test('busyAction default: plain release, media failures never crash the flow', async () => {
  const { deps } = makeDeps();
  const { handleInbound } = createHandlers(deps);
  const call = makeFakeCall({ connectRejection: BUSY, ttsRejection: { code: '404', message: 'Call not found' } });
  await handleInbound(call);
  assert.equal(call.counts.playTTS ?? 0, 0);
  assert.equal(call.counts.hangup, 1);
});

test('early-media action absorbs a TTS failure on an already-dead leg and still releases', async () => {
  const { deps } = makeDeps({ configExtra: { busyAction: 'early-media-busy', busyMessage: 'line busy' } });
  const { handleInbound } = createHandlers(deps);
  const call = makeFakeCall({ connectRejection: BUSY, ttsRejection: { code: '404', message: 'Call not found' } });
  await handleInbound(call);
  assert.equal(call.counts.hangup, 1, 'the leg is still released');
});
