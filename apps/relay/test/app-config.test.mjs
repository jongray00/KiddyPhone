import test from 'node:test';
import assert from 'node:assert/strict';
import { handlerConfig } from '../src/signalwire/app.js';
import { loadConfig } from '../src/config.js';

// REGRESSION (found live, 2026-08-17 evidence-relay-t18-voicemail): app.js
// hand-picked the handler's config fields and silently dropped the no-answer
// and busy action settings, so PWPOC_NO_ANSWER_ACTION=voicemail declined
// instead of answering. The projection is now a named, tested seam.

const goodEnv = {
  SIGNALWIRE_PROJECT_ID: 'p',
  SIGNALWIRE_TOKEN: 't',
  PWPOC_CHILD_SIP_URI: 'sip:child@example.dapp.signalwire.com',
  PWPOC_WHITELIST: JSON.stringify([{ kind: 'pstn', value: '+12083799823' }]),
};

test('handlerConfig carries every field the handler consumes, actions included', () => {
  const cfg = loadConfig({
    ...goodEnv,
    PWPOC_NO_ANSWER_ACTION: 'voicemail',
    PWPOC_NO_ANSWER_MESSAGE: 'leave a message',
    PWPOC_BUSY_ACTION: 'early-media-busy',
    PWPOC_BUSY_MESSAGE: 'line is busy',
  });
  const h = handlerConfig(cfg);
  assert.equal(h.childSipUri, cfg.childSipUri);
  assert.equal(h.connectDeadlineMs, cfg.connectDeadlineMs);
  assert.equal(h.dialTimeoutSec, cfg.dialTimeoutSec);
  assert.equal(h.region, cfg.region);
  assert.equal(h.outboundCallerId, cfg.outboundCallerId);
  assert.equal(h.noAnswerAction, 'voicemail');
  assert.equal(h.noAnswerMessage, 'leave a message');
  assert.equal(h.busyAction, 'early-media-busy');
  assert.equal(h.busyMessage, 'line is busy');
});

test('defaults survive the projection (decline / decline)', () => {
  const h = handlerConfig(loadConfig(goodEnv));
  assert.equal(h.noAnswerAction, 'decline');
  assert.equal(h.busyAction, 'decline');
});
