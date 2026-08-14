import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const goodEnv = {
  SIGNALWIRE_PROJECT_ID: 'proj-id',
  SIGNALWIRE_TOKEN: 'PT-token',
  PWPOC_INBOUND_TOPIC: 'pwpoc_inbound',
  PWPOC_OUTBOUND_TOPIC: 'pwpoc_outbound',
  PWPOC_CHILD_SIP_URI: 'sip:child@x.example.com',
  PWPOC_WHITELIST: JSON.stringify([
    { kind: 'pstn', value: '+15551234567' },
    { kind: 'sip', user: 'grandma', host: 'x.example.com' },
  ]),
};

test('loadConfig builds a validated config from env', () => {
  const cfg = loadConfig(goodEnv);
  assert.equal(cfg.project, 'proj-id');
  assert.equal(cfg.whitelist.size, 2);
  assert.equal(cfg.inboundTopic, 'pwpoc_inbound');
  assert.ok(cfg.connectDeadlineMs > 0);
});

test('missing credentials refuse to start', () => {
  assert.throws(() => loadConfig({ ...goodEnv, SIGNALWIRE_PROJECT_ID: '' }), /SIGNALWIRE_PROJECT_ID/);
  const { SIGNALWIRE_TOKEN, ...rest } = goodEnv;
  assert.throws(() => loadConfig(rest), /SIGNALWIRE_TOKEN/);
});

test('an empty or all-malformed whitelist refuses to start (fail closed, loudly)', () => {
  assert.throws(() => loadConfig({ ...goodEnv, PWPOC_WHITELIST: '[]' }), /whitelist/i);
  assert.throws(
    () => loadConfig({ ...goodEnv, PWPOC_WHITELIST: JSON.stringify([{ kind: 'pstn', value: 'junk' }]) }),
    /whitelist/i
  );
  assert.throws(() => loadConfig({ ...goodEnv, PWPOC_WHITELIST: 'not-json' }), /whitelist/i);
});

test('missing child SIP URI refuses to start', () => {
  const { PWPOC_CHILD_SIP_URI, ...rest } = goodEnv;
  assert.throws(() => loadConfig(rest), /PWPOC_CHILD_SIP_URI/);
});

// ── no-answer / busy actions and the sub-20s timeout default ────────────────

test('dial timeout defaults to 18 — inside the platform ~20s re-offer window', async () => {
  
  const cfg = loadConfig(goodEnv);
  assert.equal(cfg.dialTimeoutSec, 18);
});

test('no-answer and busy actions default to decline and accept the known values', async () => {
  
  const cfg = loadConfig(goodEnv);
  assert.equal(cfg.noAnswerAction, 'decline');
  assert.equal(cfg.busyAction, 'decline');

  const custom = loadConfig({
    ...goodEnv,
    PWPOC_NO_ANSWER_ACTION: 'voicemail',
    PWPOC_NO_ANSWER_MESSAGE: 'leave a message',
    PWPOC_BUSY_ACTION: 'early-media-busy',
    PWPOC_BUSY_MESSAGE: 'busy now',
  });
  assert.equal(custom.noAnswerAction, 'voicemail');
  assert.equal(custom.noAnswerMessage, 'leave a message');
  assert.equal(custom.busyAction, 'early-media-busy');
  assert.equal(custom.busyMessage, 'busy now');
});

test('an unknown action refuses to start rather than silently declining', async () => {
  
  assert.throws(() => loadConfig({ ...goodEnv, PWPOC_NO_ANSWER_ACTION: 'ring-forever' }), /PWPOC_NO_ANSWER_ACTION/);
  assert.throws(() => loadConfig({ ...goodEnv, PWPOC_BUSY_ACTION: 'shout' }), /PWPOC_BUSY_ACTION/);
});
