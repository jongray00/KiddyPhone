/**
 * server.js
 *
 * The SWML webhook, three inbound flows side by side plus the outbound leg:
 *
 *   POST /inbound               decide inline, respond with the verdict SWML.
 *                               DELAY_MS or ?delay= holds the response, which
 *                               is the U4 probe for the undocumented webhook
 *                               response budget.
 *   POST /inbound/twostep       respond immediately with a park document
 *                               (connect toward a dead endpoint, unanswered),
 *                               run the check async, then hand the leg its
 *                               verdict over the Send Call Commands API.
 *   POST /inbound/request-flow  a static document: the leg itself asks /auth
 *                               mid-script and branches. No decision in the
 *                               webhook response path at all.
 *   POST /auth                  the auth API for request-flow. Simulates the
 *                               ~1.5s check, answers {"allowed":"yes"|"no"}.
 *   POST /outbound              the child dialing out; whitelist the
 *                               destination.
 *   POST /status                sink for connect status_url events.
 *   GET  /healthz
 *
 * Every request body is captured to the evidence log BEFORE anything acts on
 * it: the raw bodies are what settle U5. Anything unparseable or missing an
 * identity fails closed to a silent decline.
 */

import http from 'node:http';
import { buildWhitelist, parseSipUri, normalizePstn } from './whitelist.js';
import { extractIdentity } from './identity.js';
import { inboundConnect, decline, park, requestFlow, outboundConnect } from './signalwire/docs.js';
import { createCapture } from './capture.js';
import { createRestClient } from './signalwire/rest.js';
import { createArmer } from './signalwire/arm.js';
import { compileStatic, createStaticPusher } from './signalwire/static.js';
import { createControl } from './control.js';
import { createCaller } from './signalwire/caller.js';
import { safeDescribe } from './util.js';

const MAX_DELAY_MS = 600_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  try {
    return { body: JSON.parse(raw || '{}'), raw, parsed: true };
  } catch {
    return { body: null, raw, parsed: false };
  }
}

function sendJson(res, obj, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export function createApp(config) {
  const {
    whitelist,
    childUri,
    deadUri,
    publicUrl = '',
    checkDelayMs = 1500,
    capture,
    rest,
    region = 'US',
    control = null,
  } = config;

  // The lookup time is runtime-mutable (the UI's "whitelist lookup time"
  // control): share one object with the control layer instead of a constant.
  const runtime = config.runtime ?? { checkDelayMs };

  const statusUrl = publicUrl ? `${publicUrl}/status` : undefined;

  /**
   * The two-step's second step. Fired after the park document has already
   * been returned. A failed update is recorded as a finding: whether
   * `update` lands on an unanswered mid-connect leg is a POC question.
   */
  async function runTwoStepCheck({ callId, from }) {
    await sleep(runtime.checkDelayMs);
    const allowed = whitelist.isAllowed(from);
    const verdict = allowed ? inboundConnect({ to: childUri, statusUrl }) : decline();
    if (!callId) {
      await capture.log('/inbound/twostep#update', { finding: 'no call_id in webhook body, cannot update' });
      return;
    }
    const result = await rest.updateCall(callId, verdict);
    await capture.log('/inbound/twostep#update', { callId, from, allowed, result });
  }

  /** Destination for the outbound leg: raw SIP URI, or normalized E.164. */
  function resolveDestination(to) {
    if (parseSipUri(to)) return to;
    return normalizePstn(to, region);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;

    try {
      if (control && (route === '/ui' || route.startsWith('/api/'))) {
        if (await control.handle(req, res, url)) return;
      }
      if (route === '/healthz') {
        sendJson(res, { ok: true });
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, { error: 'POST only' }, 405);
        return;
      }

      const known = ['/inbound', '/inbound/twostep', '/inbound/request-flow', '/auth', '/outbound', '/status'];
      if (!known.includes(route)) {
        sendJson(res, { error: 'not found' }, 404);
        return;
      }

      const { body, raw, parsed } = await readBody(req);
      const identity = extractIdentity(body);
      // The whitelist decision rides along on the evidence line so the UI's
      // signal ladder can show ALLOW/DENY without re-deriving it.
      const allowed = !parsed
        ? undefined
        : route.startsWith('/inbound') || route === '/auth'
          ? whitelist.isAllowed(identity.from)
          : route === '/outbound'
            ? whitelist.isAllowed(identity.to)
            : undefined;
      // The UI renders live SWML previews against the real routes; preview
      // requests are synthetic and must never pollute the U5 evidence record.
      const preview = url.searchParams.get('preview') === '1';
      if (!preview) await capture.log(route, {
        allowed,
        method: req.method,
        query: url.search || undefined,
        headers: {
          'content-type': req.headers['content-type'],
          'user-agent': req.headers['user-agent'],
        },
        parsed,
        body: parsed ? body : undefined,
        raw: parsed ? undefined : raw.slice(0, 4096),
        identity,
      });

      if (route === '/status') {
        sendJson(res, { ok: true });
        return;
      }

      if (route === '/auth') {
        await sleep(runtime.checkDelayMs);
        const allowed = parsed && whitelist.isAllowed(body?.from);
        sendJson(res, { allowed: allowed ? 'yes' : 'no' });
        return;
      }

      // Webhook routes fail closed from here on.
      if (!parsed) {
        sendJson(res, decline());
        return;
      }

      if (route === '/inbound') {
        // The lookup delay comes from runtime state, not the URL: the
        // platform drops query strings from external SWML URLs (measured),
        // so ?delay= works only for direct local testing.
        const wait = url.searchParams.has('delay')
          ? Math.min(Math.max(Number(url.searchParams.get('delay')) || 0, 0), MAX_DELAY_MS)
          : runtime.checkDelayMs;
        if (wait > 0) await sleep(wait);
        sendJson(res, allowed ? inboundConnect({ to: childUri, statusUrl }) : decline());
        return;
      }

      if (route === '/inbound/twostep') {
        sendJson(res, park({ deadUri, statusUrl }));
        // After the response: the caller is parked, now decide. Previews get
        // the park document only; no REST update fires for synthetic calls.
        if (!preview) {
          runTwoStepCheck({ callId: identity.callId, from: identity.from }).catch((err) =>
            capture.log('/inbound/twostep#update', { error: safeDescribe(err) }),
          );
        }
        return;
      }

      if (route === '/inbound/request-flow') {
        sendJson(res, requestFlow({ authUrl: `${publicUrl}/auth`, childUri, statusUrl }));
        return;
      }

      if (route === '/outbound') {
        const dest = allowed ? resolveDestination(identity.to) : null;
        sendJson(res, dest ? outboundConnect({ to: dest, statusUrl }) : decline());
        return;
      }
    } catch (err) {
      // Last resort: never leave SignalWire hanging, never answer by accident.
      console.error('handler failed:', safeDescribe(err));
      if (!res.headersSent) sendJson(res, decline());
      else res.end();
    }
  });
}

// ── entrypoint ───────────────────────────────────────────────────────────────

function configFromEnv(env) {
  const csv = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const region = env.KIDDYPHONE_DEFAULT_REGION || 'US';
  return {
    whitelist: buildWhitelist({
      pstn: csv(env.WHITELIST_PSTN),
      sip: csv(env.WHITELIST_SIP).map((pair) => {
        const [user, host] = pair.split('@');
        return { user, host };
      }),
      region,
    }),
    childUri: env.KIDDYPHONE_ENDPOINT_SIP_URI,
    deadUri: env.KIDDYPHONE_DEAD_SIP_URI,
    publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
    delayMs: Number(env.DELAY_MS) || 0,
    checkDelayMs: Number(env.CHECK_DELAY_MS) || 1500,
    region,
    port: Number(env.PORT) || 8080,
    space: {
      spaceUrl: env.SIGNALWIRE_SPACE_URL,
      projectId: env.SIGNALWIRE_PROJECT_ID,
      token: env.SIGNALWIRE_TOKEN,
    },
    didId: env.PWPOC_DID_ID,
    didNumber: env.PWPOC_DID_NUMBER,
    sipEndpointId: env.PWPOC_SIP_ENDPOINT_ID,
    whitelistPstn: csv(env.WHITELIST_PSTN),
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    process.loadEnvFile(new URL('../.env', import.meta.url).pathname);
  } catch {
    // No SWML/.env; fall back to whatever the shell provided.
  }

  // D10's lesson carries over from the relay side: one unhandled rejection
  // must never take down every in-flight call. Log and keep serving.
  process.on('unhandledRejection', (r) => console.error('unhandledRejection:', safeDescribe(r)));
  process.on('uncaughtException', (e) => console.error('uncaughtException:', safeDescribe(e)));

  const cfg = configFromEnv(process.env);
  if (!cfg.childUri) throw new Error('KIDDYPHONE_ENDPOINT_SIP_URI is required');
  if (cfg.whitelist.keys.size === 0) throw new Error('whitelist is empty, refusing to start');
  if (!cfg.space.spaceUrl || !cfg.space.projectId || !cfg.space.token) {
    console.warn('SignalWire credentials missing: the two-step REST update will fail until they are set');
  }
  if (!cfg.publicUrl) {
    console.warn('PUBLIC_URL missing: status_url callbacks and the request-flow /auth URL will be broken');
  }

  const capture = createCapture(new URL('../evidence', import.meta.url).pathname);
  const rest = createRestClient(cfg.space);

  const runtime = { checkDelayMs: cfg.checkDelayMs };
  let control = null;
  if (cfg.didId && cfg.sipEndpointId) {
    const armer = createArmer({
      ...cfg.space,
      publicUrl: cfg.publicUrl,
      didId: cfg.didId,
      sipEndpointId: cfg.sipEndpointId,
    });
    const pusher = createStaticPusher({ ...cfg.space });
    control = createControl({
      armer,
      statics: {
        compile: () => compileStatic({ keys: cfg.whitelist.keys, childUri: cfg.childUri }),
        push: (contents) => pusher.push(contents),
      },
      evidenceFile: capture.file,
      codeDir: new URL('.', import.meta.url).pathname,
      uiPath: new URL('./ui.html', import.meta.url).pathname,
      config: {
        publicUrl: cfg.publicUrl,
        didNumber: cfg.didNumber,
        whitelistPstn: cfg.whitelistPstn,
        childUri: cfg.childUri,
        deadUri: cfg.deadUri,
        checkDelayMs: cfg.checkDelayMs,
      },
      phone: {
        username: process.env.SIP_PHONE_USER,
        password: process.env.SIP_PHONE_PASSWORD,
        domain: process.env.SIP_PHONE_DOMAIN,
      },
      caller: cfg.space.projectId && cfg.space.token ? createCaller(cfg.space) : null,
      whitelist: cfg.whitelist,
      capture,
      callerNumber: process.env.PWPOC_CALLER_NUMBER || '+12083799823',
      runtime,
    });
  } else {
    console.warn('PWPOC_DID_ID / PWPOC_SIP_ENDPOINT_ID missing: /ui disabled');
  }

  const app = createApp({ ...cfg, capture, rest, control, runtime });

  app.listen(cfg.port, () => {
    console.log(
      `kiddyphone swml poc on :${cfg.port}  whitelist=${cfg.whitelist.keys.size} delay=${cfg.delayMs}ms check=${cfg.checkDelayMs}ms evidence=${capture.file}`,
    );
  });
}
