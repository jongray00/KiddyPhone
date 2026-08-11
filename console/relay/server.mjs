/**
 * server.mjs — the KiddyPhone line-test console.
 *
 * A zero-dependency local web server that drives the live smoke harness and
 * streams every RELAY event to the browser. It never talks to SignalWire
 * itself except for the read-only topology check; all call placement goes
 * through the same live/smoke.mjs used for the recorded evidence runs, so
 * what the console shows is exactly what the harness measured.
 *
 * Binds 127.0.0.1 only. Start with: npm run console
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scopedPath } from '../../shared/provision.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const relayApp = path.join(root, 'apps', 'relay');
const PORT = Number(process.env.PWPOC_CONSOLE_PORT || 8787);

for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const SPACE = process.env.SIGNALWIRE_SPACE_URL;
const auth = Buffer.from(
  `${process.env.SIGNALWIRE_PROJECT_ID}:${process.env.SIGNALWIRE_TOKEN}`
).toString('base64');

// ── SSE bus ──────────────────────────────────────────────────────────────────
const clients = new Set();
function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(frame);
}

// ── job runner: one live action at a time ────────────────────────────────────
let job = null; // { kind, row?, child }

function runJob(kind, args, extraEnv, meta = {}) {
  if (job) return false;
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
  });
  job = { kind, ...meta, child };
  broadcast({ channel: 'job', state: 'started', kind, ...meta });

  let buffer = '';
  const onLine = (line) => {
    if (!line.trim()) return;
    if (kind === 'scenario' || kind === 'guided') {
      try {
        broadcast({ channel: 'call', ...JSON.parse(line) });
        return;
      } catch { /* not JSONL, fall through */ }
    }
    broadcast({ channel: 'shell', kind, line: line.slice(0, 500) });
  };
  const consume = (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach(onLine);
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  child.on('exit', (code) => {
    if (buffer) onLine(buffer);
    broadcast({ channel: 'job', state: 'done', kind, code, ...meta });
    job = null;
  });
  return true;
}

// ── topology status (read-only) ──────────────────────────────────────────────
async function topologyStatus() {
  const get = async (p) => {
    const res = await fetch(`https://${SPACE}/api/relay/rest/${p}?page_size=200`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    return (await res.json()).data ?? [];
  };
  const [apps, numbers] = await Promise.all([get('domain_applications'), get('phone_numbers')]);
  const mine = (list, key) => list.filter((x) => (x[key] || '').startsWith('pwpoc-'));
  const domainApps = mine(apps, 'name').map((a) => ({ name: a.name, domain: a.domain, context: a.call_relay_context }));
  const dids = mine(numbers, 'name').map((n) => ({ name: n.name, number: n.number, context: n.call_relay_context }));
  return {
    ready: domainApps.length >= 3 && dids.length >= 2,
    domainApps,
    dids,
    space: SPACE,
  };
}

// ── http ─────────────────────────────────────────────────────────────────────
const send = (res, code, type, body) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};
const json = (res, code, obj) => send(res, code, 'application/json', JSON.stringify(obj));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (req.method === 'GET' && p === '/') {
      return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(here, 'index.html')));
    }

    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ channel: 'hello', busy: job !== null })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'GET' && p === '/api/status') {
      const topo = await topologyStatus().catch((e) => ({ ready: false, error: String(e) }));
      return json(res, 200, {
        topology: topo,
        busy: job ? { kind: job.kind, row: job.row ?? null, card: job.card ?? null } : null,
        cell: (process.env.PWPOC_CELL || '').trim() || null,
      });
    }

    if (req.method === 'GET' && p.startsWith('/api/history/')) {
      const row = p.split('/').pop();
      if (!/^[1-6]$/.test(row)) return json(res, 400, { error: 'row must be 1-6' });
      const logFile = path.join(relayApp, 'live', `row${row}.log`);
      const cdrFile = path.join(relayApp, 'live', `row${row}-cdr.json`);
      const events = fs.existsSync(logFile)
        ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : [];
      const cdrs = fs.existsSync(cdrFile) ? JSON.parse(fs.readFileSync(cdrFile, 'utf8')) : [];
      return json(res, 200, { row, events, cdrs });
    }

    // SIP.js ESM served straight from node_modules (its imports carry .js extensions)
    if (req.method === 'GET' && p.startsWith('/vendor/sipjs/')) {
      const base = path.join(root, 'node_modules', 'sip.js', 'lib');
      const file = path.normalize(path.join(base, p.slice('/vendor/sipjs/'.length)));
      if (!file.startsWith(base) || !file.endsWith('.js') || !fs.existsSync(file)) {
        return json(res, 404, { error: 'not found' });
      }
      return send(res, 200, 'application/javascript', fs.readFileSync(file));
    }

    if (req.method === 'GET' && p === '/api/webphone') {
      const credsPath = scopedPath(path.join(relayApp, 'live'), 'webphone.json', SPACE);
      if (!fs.existsSync(credsPath)) return json(res, 404, { error: 'webphone endpoint not provisioned — run setup' });
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      const profile = await (await fetch(`https://${SPACE}/api/relay/rest/sip_profile`, { headers: { Authorization: `Basic ${auth}` } })).json();
      return json(res, 200, {
        username: creds.username,
        password: creds.password,
        domain: profile.domain,
        wsServer: `wss://${profile.domain}`,
      });
    }

    if (req.method === 'GET' && p === '/api/devices') {
      const [profileRes, endpointsRes] = await Promise.all([
        fetch(`https://${SPACE}/api/relay/rest/sip_profile`, { headers: { Authorization: `Basic ${auth}` } }),
        fetch(`https://${SPACE}/api/relay/rest/endpoints/sip?page_size=200`, { headers: { Authorization: `Basic ${auth}` } }),
      ]);
      const profile = await profileRes.json();
      const endpoints = ((await endpointsRes.json()).data ?? []).map((e) => e.username);
      return json(res, 200, { domain: profile.domain, endpoints });
    }

    if (req.method === 'POST' && p.startsWith('/api/run/')) {
      const row = p.split('/').pop();
      if (!/^[1-6]$/.test(row)) return json(res, 400, { error: 'row must be 1-6' });
      // ?child=<sip uri> rings a real device instead of the simulator context.
      // ?authDelay=<ms> simulates a slow whitelist lookup (clamped 0–20000).
      const childUri = url.searchParams.get('child');
      const authDelay = Math.min(20000, Math.max(0, Number(url.searchParams.get('authDelay') || 1500)));
      const extraEnv = { PWPOC_JSONL: '1', PWPOC_AUTH_DELAY_MS: String(authDelay) };
      if (childUri && /^sip:[^@\s]+@[^@\s]+$/.test(childUri)) extraEnv.PWPOC_CHILD_SIP_URI = childUri;
      const ok = runJob('scenario', [path.join(relayApp, 'live', 'smoke.mjs'), row], extraEnv, { row, child: childUri || 'simulator', authDelay });
      return json(res, ok ? 202 : 409, ok ? { started: row } : { error: 'another action is already running' });
    }

    if (req.method === 'POST' && p === '/api/guided/start') {
      // The long-running cell-phone listener. The caller is a real handset,
      // so this stays up until /api/guided/stop. Starting a card while
      // another guided listener runs replaces it — the demo flow is
      // allow-card, deny-card, back again, and a 409 there is just friction.
      if (job && job.kind === 'guided') {
        job.child.kill();
        const freed = Date.now() + 4000;
        while (job && Date.now() < freed) await new Promise((r) => setTimeout(r, 100));
        if (job) return json(res, 409, { error: 'previous guided listener did not exit — try again' });
      }
      const card = url.searchParams.get('card') === 'deny' ? 'deny' : 'allow';
      const authDelay = Math.min(20000, Math.max(0, Number(url.searchParams.get('authDelay') || 1500)));
      const cell = (url.searchParams.get('cell') || process.env.PWPOC_CELL || '').trim();
      if (!/^\+\d{7,15}$/.test(cell)) {
        return json(res, 400, { error: 'cell must be E.164 (+14805551234); set it on the landing page or pass ?cell=' });
      }
      const credsPath = scopedPath(path.join(relayApp, 'live'), 'webphone.json', SPACE);
      if (!fs.existsSync(credsPath)) return json(res, 409, { error: 'webphone endpoint not provisioned — run setup first' });
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      const profile = await (await fetch(`https://${SPACE}/api/relay/rest/sip_profile`, { headers: { Authorization: `Basic ${auth}` } })).json();
      const childUri = `sip:${creds.username}@${profile.domain}`;

      // Re-point the inbound DID at the relay context — SWML mode arms the
      // same DID at its webhook, and a write's echo is never trusted (the
      // handler-revert trap): verify with a fresh GET.
      const topoPath = scopedPath(path.join(relayApp, 'live'), 'topology.json', SPACE);
      if (fs.existsSync(topoPath)) {
        const topo = JSON.parse(fs.readFileSync(topoPath, 'utf8'));
        const did = topo.phoneNumbers.find((n) => n.name === 'pwpoc-inbound-did');
        if (did) {
          const hdrs = { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' };
          await fetch(`https://${SPACE}/api/relay/rest/phone_numbers/${did.id}`, {
            method: 'PUT',
            headers: hdrs,
            body: JSON.stringify({ call_handler: 'relay_context', call_relay_context: 'pwpoc_inbound' }),
          });
          const check = await (await fetch(`https://${SPACE}/api/relay/rest/phone_numbers/${did.id}`, { headers: hdrs })).json();
          if (check.call_handler !== 'relay_context' || check.call_relay_context !== 'pwpoc_inbound') {
            return json(res, 502, { error: `DID did not take the relay_context handler (got ${check.call_handler}) — retry` });
          }
        }
      }
      const ok = runJob('guided', [path.join(relayApp, 'live', 'guided.mjs')], {
        PWPOC_GUIDED_CARD: card,
        PWPOC_CELL: cell,
        PWPOC_AUTH_DELAY_MS: String(authDelay),
        PWPOC_CHILD_SIP_URI: childUri,
      }, { card, cell, authDelay });
      return json(res, ok ? 202 : 409, ok ? { started: 'guided', card, cell, authDelay } : { error: 'another action is already running' });
    }

    if (req.method === 'POST' && p === '/api/guided/stop') {
      if (!job || job.kind !== 'guided') return json(res, 409, { error: 'no guided listener running' });
      job.child.kill();
      return json(res, 202, { stopping: true });
    }

    if (req.method === 'POST' && p === '/api/setup') {
      // ?reuse=+1555...,+1555... adopts existing DIDs on the space instead of
      // purchasing; setup snapshots their routing and teardown restores it.
      const reuse = (url.searchParams.get('reuse') || '').trim();
      const extraEnv = reuse ? { PWPOC_REUSE_DIDS: reuse } : {};
      const ok = runJob('setup', [path.join(relayApp, 'live', 'setup.mjs')], extraEnv);
      return json(res, ok ? 202 : 409, ok ? { started: 'setup' } : { error: 'another action is already running' });
    }

    if (req.method === 'GET' && p === '/api/numbers') {
      // the number picker: every DID on the space, flagged by current use
      const nums = (await (await fetch(`https://${SPACE}/api/relay/rest/phone_numbers?page_size=200`, {
        headers: { Authorization: `Basic ${auth}` },
      })).json()).data ?? [];
      return json(res, 200, {
        numbers: nums.map((n) => ({
          id: n.id,
          number: n.number,
          name: n.name,
          handler: n.call_handler,
          pwpoc: (n.name || '').startsWith('pwpoc-'),
        })),
      });
    }

    if (req.method === 'POST' && p === '/api/teardown') {
      const ok = runJob('teardown', [path.join(relayApp, 'live', 'teardown.mjs')], {});
      return json(res, ok ? 202 : 409, ok ? { started: 'teardown' } : { error: 'another action is already running' });
    }

    if (req.method === 'POST' && p === '/api/tests') {
      const ok = runJob('tests', ['--test', 'apps/relay/test/faults.test.mjs', 'apps/relay/test/deadline.test.mjs', 'apps/relay/test/identity.test.mjs', 'apps/relay/test/connect-guard.test.mjs', 'apps/relay/test/lifecycle.test.mjs', 'apps/relay/test/process-guards.test.mjs', 'apps/relay/test/handler.test.mjs', 'apps/relay/test/config.test.mjs', 'apps/relay/test/sdk-surface.test.mjs'], {});
      return json(res, ok ? 202 : 409, ok ? { started: 'tests' } : { error: 'another action is already running' });
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: String(e?.message ?? e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`KiddyPhone line-test console: http://127.0.0.1:${PORT}`);
});
