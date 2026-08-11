/**
 * gateway.mjs — the unified entry for the KiddyPhone test lab.
 *
 * One landing → connect a space → pick RELAY or SWML → the gateway spawns the
 * chosen app with that space's credentials injected. Both child apps load
 * their own .env with never-override semantics, so what the gateway injects
 * wins and the root .env stays a by-hand fallback.
 *
 * The space store lives server-side (console/spaces.json, 0600). Tokens are
 * validated with a read-only sip_profile probe — which also yields the real
 * SIP domain (the demo-<identifier>.sip.signalwire.com trap) — and are never
 * sent back to the browser.
 *
 * Binds 127.0.0.1 only. Start with: npm run gateway
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repoRoot, loadRootEnv } from '../shared/env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PWPOC_GATEWAY_PORT || 8790);
const STORE = path.join(here, 'spaces.json');
const DEMO_CELL = '+14803769009';

loadRootEnv();

// ── space store ──────────────────────────────────────────────────────────────
function readStore() {
  if (!fs.existsSync(STORE)) return { spaces: [] };
  return JSON.parse(fs.readFileSync(STORE, 'utf8'));
}
function writeStore(store) {
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2), { mode: 0o600 });
}
function publicView(s) {
  return {
    id: s.id,
    label: s.label,
    spaceUrl: s.spaceUrl,
    sipDomain: s.sipDomain,
    cell: s.cell,
    isDemo: s.id === 'demo',
    tokenHint: s.token ? `…${s.token.slice(-4)}` : null,
  };
}

// Seed the demo space from the root .env on first boot.
function seedStore() {
  const store = readStore();
  if (!store.spaces.some((s) => s.id === 'demo') && process.env.SIGNALWIRE_SPACE_URL) {
    store.spaces.unshift({
      id: 'demo',
      label: 'SignalWire demo space',
      spaceUrl: process.env.SIGNALWIRE_SPACE_URL,
      projectId: process.env.SIGNALWIRE_PROJECT_ID,
      token: process.env.SIGNALWIRE_TOKEN,
      sipDomain: null, // filled by the first probe
      cell: DEMO_CELL,
    });
    writeStore(store);
  }
  return store;
}

// The read-only credential probe. A 200 proves the creds and returns the one
// fact the webphone cannot guess: the space's real SIP domain.
async function probeSpace({ spaceUrl, projectId, token }) {
  const auth = Buffer.from(`${projectId}:${token}`).toString('base64');
  const res = await fetch(`https://${spaceUrl}/api/relay/rest/sip_profile`, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`sip_profile probe failed: HTTP ${res.status}`);
  const profile = await res.json();
  if (!profile.domain) throw new Error('sip_profile returned no domain');
  return { sipDomain: profile.domain };
}

// ── child process slots ──────────────────────────────────────────────────────
const SLOT_DEFS = {
  relay: {
    port: Number(process.env.PWPOC_CONSOLE_PORT || 8787),
    // Same-origin path, not a loopback URL: the gateway proxies it, so this
    // works for a remote viewer over a tunnel as well as for the operator.
    url: () => '/relay/',
    ready: () => `http://127.0.0.1:${SLOT_DEFS.relay.port}/`,
    spawn: (space, cell) =>
      spawn(process.execPath, [path.join(here, 'relay', 'server.mjs')], {
        cwd: repoRoot,
        env: {
          ...process.env,
          SIGNALWIRE_SPACE_URL: space.spaceUrl,
          SIGNALWIRE_PROJECT_ID: space.projectId,
          SIGNALWIRE_TOKEN: space.token,
          PWPOC_CONSOLE_PORT: String(SLOT_DEFS.relay.port),
          PWPOC_CELL: cell,
        },
      }),
  },
  swml: {
    port: Number(process.env.PWPOC_SWML_PORT || 8080),
    url: () => '/swml/ui',
    ready: () => `http://127.0.0.1:${SLOT_DEFS.swml.port}/healthz`,
    // On the demo space apps/swml/.env supplies the DID/endpoint/child wiring.
    // On any other space, resolve them from the space itself so /ui and the
    // armer work without a hand-written .env (pwpoc-named resources first).
    extraEnv: async (space) => {
      if (space.id === 'demo') return {};
      const auth = Buffer.from(`${space.projectId}:${space.token}`).toString('base64');
      const get = async (p) => {
        const res = await fetch(`https://${space.spaceUrl}/api/relay/rest/${p}?page_size=200`, {
          headers: { Authorization: `Basic ${auth}` },
          signal: AbortSignal.timeout(8000),
        });
        return res.ok ? (await res.json()).data ?? [] : [];
      };
      const [numbers, endpoints] = await Promise.all([get('phone_numbers'), get('endpoints/sip')]);
      const did = numbers.find((n) => n.name === 'pwpoc-inbound-did') ?? numbers[0];
      const child = endpoints.find((e) => e.username === 'pwpoc-webphone') ?? endpoints[0];
      const env = {};
      if (did) {
        env.PWPOC_DID_ID = did.id;
        env.PWPOC_DID_NUMBER = did.number;
      }
      if (child && space.sipDomain) {
        env.PWPOC_SIP_ENDPOINT_ID = child.id;
        env.KIDDYPHONE_ENDPOINT_SIP_URI = `sip:${child.username}@${space.sipDomain}`;
      }
      return env;
    },
    spawn: (space, cell, extra = {}) =>
      spawn(process.execPath, [path.join(repoRoot, 'apps', 'swml', 'src', 'server.js')], {
        cwd: path.join(repoRoot, 'apps', 'swml'),
        env: {
          ...process.env,
          ...extra,
          SIGNALWIRE_SPACE_URL: space.spaceUrl,
          SIGNALWIRE_PROJECT_ID: space.projectId,
          SIGNALWIRE_TOKEN: space.token,
          PORT: String(SLOT_DEFS.swml.port),
          PWPOC_CELL: cell,
        },
      }),
  },
};

// slot: { child, spaceId, log: string[], startedAt }
const slots = { relay: null, swml: null };

function slotState(mode) {
  const slot = slots[mode];
  return {
    mode,
    running: Boolean(slot && slot.child.exitCode === null),
    spaceId: slot?.spaceId ?? null,
    url: SLOT_DEFS[mode].url(),
    logTail: slot ? slot.log.slice(-8) : [],
  };
}

function stopSlot(mode) {
  const slot = slots[mode];
  if (slot && slot.child.exitCode === null) slot.child.kill();
  slots[mode] = null;
}

async function launchSlot(mode, space, cell) {
  const def = SLOT_DEFS[mode];
  const current = slots[mode];
  if (current && current.child.exitCode === null && current.spaceId === space.id) {
    return slotState(mode); // already serving this space
  }
  stopSlot(mode);

  const extra = def.extraEnv ? await def.extraEnv(space).catch(() => ({})) : {};
  const child = def.spawn(space, cell, extra);
  const slot = { child, spaceId: space.id, log: [], startedAt: Date.now() };
  const keep = (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) slot.log.push(line.slice(0, 300));
    }
    if (slot.log.length > 60) slot.log.splice(0, slot.log.length - 60);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('exit', () => { /* state read lazily via exitCode */ });
  slots[mode] = slot;

  // Wait for the app to actually answer before telling the browser to open it.
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(def.ready(), { signal: AbortSignal.timeout(1000) });
      if (res.ok) return slotState(mode);
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return slotState(mode); // running:false + logTail carries the reason
}

// ── http ─────────────────────────────────────────────────────────────────────
const send = (res, code, type, body) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};
const json = (res, code, obj) => send(res, code, 'application/json', JSON.stringify(obj));
const body = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 64 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });

/**
 * Reverse proxy to a child app on loopback.
 *
 * This exists so one public hostname serves the whole lab. A quick tunnel
 * grants exactly one hostname per tunnel and rate-limits new ones, so the
 * cross-port `window.open('http://127.0.0.1:8787')` the landing page used to
 * do cannot work for anyone but the operator.
 *
 * hop-by-hop headers are dropped: Node re-frames the body itself, and echoing
 * the upstream's transfer-encoding on top of that corrupts the response.
 */
function proxy(req, res, port, path) {
  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  delete headers.connection;
  delete headers['transfer-encoding'];
  delete headers['accept-encoding']; // no compression to buffer

  const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path, headers }, (up) => {
    const out = { ...up.headers };
    delete out.connection;
    delete out['transfer-encoding'];
    res.writeHead(up.statusCode, out);
    res.flushHeaders?.();
    up.pipe(res);
  });
  upstream.on('error', (e) => {
    if (!res.headersSent) json(res, 502, { error: `proxy to :${port} failed: ${e.message}` });
    else res.end();
  });
  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    // /relay/... and /swml/... belong to the child apps.
    const mounted = p.match(/^\/(relay|swml)(\/.*)?$/);
    if (mounted) {
      const [, mode, rest] = mounted;
      // The SWML app has no page at its root, only /ui. Relay serves its
      // console at /, so /relay/ proxies straight through; bare /relay needs
      // the trailing slash first or the child UI's relative BASE is wrong.
      const landing = mode === 'swml' ? '/swml/ui' : '/relay/';
      if (!rest || (mode === 'swml' && rest === '/')) {
        res.writeHead(302, { location: landing });
        return res.end();
      }
      return proxy(req, res, SLOT_DEFS[mode].port, rest + (url.search || ''));
    }

    if (req.method === 'GET' && p === '/') {
      return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(here, 'index.html')));
    }

    if (req.method === 'GET' && p === '/api/spaces') {
      return json(res, 200, { spaces: readStore().spaces.map(publicView) });
    }

    if (req.method === 'POST' && p === '/api/spaces') {
      const { label, spaceUrl, projectId, token } = await body(req);
      if (!spaceUrl || !projectId || !token) {
        return json(res, 400, { error: 'spaceUrl, projectId, and token are all required' });
      }
      const host = String(spaceUrl).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      let probe;
      try {
        probe = await probeSpace({ spaceUrl: host, projectId, token });
      } catch (e) {
        return json(res, 422, { error: String(e.message ?? e) });
      }
      const store = readStore();
      const existing = store.spaces.find((s) => s.spaceUrl === host && s.projectId === projectId);
      const space = existing ?? {
        id: `space-${host.split('.')[0]}-${projectId.slice(0, 8)}`,
        cell: '',
      };
      Object.assign(space, {
        label: label || host,
        spaceUrl: host,
        projectId,
        token,
        sipDomain: probe.sipDomain,
      });
      if (!existing) store.spaces.push(space);
      writeStore(store);
      return json(res, existing ? 200 : 201, { space: publicView(space) });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/spaces/')) {
      const id = decodeURIComponent(p.split('/').pop());
      if (id === 'demo') return json(res, 400, { error: 'the demo space cannot be removed' });
      const store = readStore();
      store.spaces = store.spaces.filter((s) => s.id !== id);
      writeStore(store);
      for (const mode of Object.keys(slots)) {
        if (slots[mode]?.spaceId === id) stopSlot(mode);
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/launch') {
      const { spaceId, mode, cell } = await body(req);
      if (!SLOT_DEFS[mode]) return json(res, 400, { error: 'mode must be relay or swml' });
      const store = readStore();
      const space = store.spaces.find((s) => s.id === spaceId);
      if (!space) return json(res, 404, { error: `unknown space: ${spaceId}` });
      const useCell = (cell || space.cell || (space.id === 'demo' ? DEMO_CELL : '')).trim();
      if (useCell !== space.cell) { space.cell = useCell; writeStore(store); }
      if (!space.sipDomain) {
        try {
          const probe = await probeSpace(space);
          space.sipDomain = probe.sipDomain;
          writeStore(store);
        } catch { /* probe failure surfaces inside the apps, not here */ }
      }
      const state = await launchSlot(mode, space, useCell);
      return json(res, state.running ? 200 : 502, state);
    }

    if (req.method === 'POST' && p === '/api/stop') {
      const { mode } = await body(req);
      if (!SLOT_DEFS[mode]) return json(res, 400, { error: 'mode must be relay or swml' });
      stopSlot(mode);
      return json(res, 200, slotState(mode));
    }

    if (req.method === 'GET' && p === '/api/state') {
      return json(res, 200, {
        gateway: { port: PORT },
        slots: { relay: slotState('relay'), swml: slotState('swml') },
      });
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: String(e?.message ?? e) });
  }
});

process.on('exit', () => { stopSlot('relay'); stopSlot('swml'); });
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

seedStore();
// Loopback by default: the gateway holds space tokens and can launch apps,
// so it must not face the LAN uninvited. Hosted platforms (Replit) need
// 0.0.0.0 — detected there, or opt in anywhere with PWPOC_BIND.
const BIND = process.env.PWPOC_BIND || (process.env.REPL_ID ? '0.0.0.0' : '127.0.0.1');
server.listen(PORT, BIND, () => {
  console.log(`KiddyPhone test lab gateway: http://${BIND}:${PORT}`);
});
