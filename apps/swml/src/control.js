/**
 * control.js
 *
 * The test-suite UI's backend: dashboard page, arming, live source for the
 * code viewer, and the evidence stream. Mounted ahead of the webhook routes
 * by server.js; handle() returns false for anything it does not own so the
 * call path is untouched.
 *
 * The code viewer serves ONLY the files named in CODE_FILES, by exact
 * basename match, so no request shape can read .env or anything else.
 */

import { readFile, stat, open } from 'node:fs/promises';
import { watchFile, unwatchFile } from 'node:fs';
import { join } from 'node:path';
import { safeDescribe } from './util.js';

// Viewer name -> path under codeDir. The signalwire/ folder holds the
// SignalWire-exclusive pieces; everything else is supporting code.
const CODE_FILES = {
  'docs.js': 'signalwire/docs.js',
  'rest.js': 'signalwire/rest.js',
  'arm.js': 'signalwire/arm.js',
  'static.js': 'signalwire/static.js',
  'caller.js': 'signalwire/caller.js',
  'whitelist.js': 'whitelist.js',
  'identity.js': 'identity.js',
  'capture.js': 'capture.js',
  'server.js': 'server.js',
  'control.js': 'control.js',
  'util.js': 'util.js',
};

function sendJson(res, obj, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Did this request cross a proxy to get here? cf-* covers a Cloudflare tunnel;
// x-forwarded-* covers everything else, including the lab gateway on a hosted
// platform. Only a browser on the same machine arrives with none of them.
const FORWARD_HEADERS = ['cf-ray', 'cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-host'];
function isForwarded(req) {
  return FORWARD_HEADERS.some((h) => req.headers[h]);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    return null;
  }
}

async function tailLines(file, limit) {
  try {
    const text = await readFile(file, 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { raw: l };
        }
      });
  } catch {
    return [];
  }
}

export function createControl({ armer, evidenceFile, codeDir, uiPath, config, runtime = null, phone = null, caller = null, whitelist = null, capture = null, callerNumber = null, statics = null, allowForwarded = false }) {
  async function handle(req, res, url) {
    const route = url.pathname;
    const liveConfig = () => ({ ...config, checkDelayMs: runtime?.checkDelayMs ?? config.checkDelayMs });

    if (route === '/ui' && req.method === 'GET') {
      try {
        const html = await readFile(uiPath);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        sendJson(res, { error: safeDescribe(err) }, 500);
      }
      return true;
    }

    if (!route.startsWith('/api/')) return false;

    if (route === '/api/state' && req.method === 'GET') {
      try {
        sendJson(res, { config: liveConfig(), ...(await armer.state()) });
      } catch (err) {
        sendJson(res, { config: liveConfig(), error: safeDescribe(err) }, 502);
      }
      return true;
    }

    if (route === '/api/phone-config' && req.method === 'GET') {
      // SIP credentials for the in-app web phone. Refused for anything that
      // came through a proxy, so a public console URL never leaks the
      // registration — unless the deploy is inherently remote (hosted lab),
      // where every browser is proxied and refusing means no web phone at all.
      if (isForwarded(req) && !allowForwarded) {
        sendJson(res, { error: 'phone credentials are served to the local browser only' }, 403);
        return true;
      }
      if (!phone?.username || !phone?.password || !phone?.domain) {
        sendJson(res, { error: 'SIP_PHONE_USER / SIP_PHONE_PASSWORD / SIP_PHONE_DOMAIN not configured' }, 404);
        return true;
      }
      sendJson(res, {
        username: phone.username,
        password: phone.password,
        domain: phone.domain,
        wss: `wss://${phone.domain}`,
        aor: `sip:${phone.username}@${phone.domain}`,
      });
      return true;
    }

    if (route === '/api/place-call' && req.method === 'POST') {
      // Places a real, billable test call. Same gate as the phone credentials.
      if (isForwarded(req) && !allowForwarded) {
        sendJson(res, { error: 'test calls are placed from the local browser only' }, 403);
        return true;
      }
      if (!caller || !callerNumber || !config?.didNumber) {
        sendJson(res, { error: 'caller not configured' }, 404);
        return true;
      }
      const body = await readJsonBody(req);
      const callerAllowed = body?.callerAllowed !== false;
      if (whitelist) (callerAllowed ? whitelist.allow : whitelist.disallow)(callerNumber);

      // Respond immediately; the dial can legitimately take a minute. The
      // outcome lands on the evidence stream as /place-call#result.
      sendJson(res, { ok: true, from: callerNumber, to: config.didNumber, callerAllowed });
      caller
        .place({ from: callerNumber, to: config.didNumber, timeout: 60 })
        .then((result) => capture?.log('/place-call#result', { callerAllowed, ...result }))
        .catch((err) => capture?.log('/place-call#result', { callerAllowed, error: safeDescribe(err) }));
      return true;
    }

    if (route === '/api/check-delay' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ms = Math.min(Math.max(Number(body?.ms) || 0, 0), 120_000);
      if (runtime) runtime.checkDelayMs = ms;
      sendJson(res, { ok: !!runtime, checkDelayMs: runtime?.checkDelayMs ?? null });
      return true;
    }

    if (route === '/api/arm' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || typeof body.scenario !== 'string') {
        sendJson(res, { ok: false, error: 'scenario required' }, 400);
        return true;
      }
      if (body.scenario === 'static') {
        // no-tunnel fallback: compile the live whitelist into the document,
        // push it to the space's script hosting, arm the DID at the result
        if (!statics) {
          sendJson(res, { ok: false, error: 'static mode not configured' }, 400);
          return true;
        }
        try {
          const pushed = await statics.push(statics.compile());
          if (!pushed.supported) {
            sendJson(res, { ok: false, error: 'this space has no SWML script hosting (Call Fabric); use webhook mode with PUBLIC_URL' }, 422);
            return true;
          }
          const result = await armer.armUrl(pushed.requestUrl);
          sendJson(res, { ...result, scriptUrl: pushed.requestUrl }, result.ok ? 200 : 502);
        } catch (err) {
          sendJson(res, { ok: false, error: safeDescribe(err) }, 502);
        }
        return true;
      }
      const result = await armer.arm(body.scenario, { delayMs: Number(body.delayMs) || 0 });
      sendJson(res, result, result.ok ? 200 : 502);
      return true;
    }

    if (route === '/api/code' && req.method === 'GET') {
      const file = url.searchParams.get('file');
      if (!Object.hasOwn(CODE_FILES, file)) {
        sendJson(res, { error: 'unknown file' }, 404);
        return true;
      }
      try {
        const source = await readFile(join(codeDir, CODE_FILES[file]), 'utf8');
        sendJson(res, { file, source });
      } catch (err) {
        sendJson(res, { error: safeDescribe(err) }, 500);
      }
      return true;
    }

    if (route === '/api/evidence' && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 500);
      sendJson(res, { lines: await tailLines(evidenceFile, limit) });
      return true;
    }

    if (route === '/api/evidence/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      // Replay recent lines so the panel is never empty, then tail the file.
      for (const line of await tailLines(evidenceFile, 100)) {
        res.write(`data: ${JSON.stringify(line)}\n\n`);
      }

      let offset = await stat(evidenceFile).then((s) => s.size).catch(() => 0);
      let draining = false;

      const drain = async () => {
        if (draining) return;
        draining = true;
        try {
          const size = await stat(evidenceFile).then((s) => s.size).catch(() => 0);
          if (size < offset) offset = 0; // file rotated/truncated
          if (size > offset) {
            const fh = await open(evidenceFile, 'r');
            const buf = Buffer.alloc(size - offset);
            await fh.read(buf, 0, buf.length, offset);
            await fh.close();
            offset = size;
            for (const line of buf.toString().split('\n').filter(Boolean)) {
              let parsed;
              try {
                parsed = JSON.parse(line);
              } catch {
                parsed = { raw: line };
              }
              res.write(`data: ${JSON.stringify(parsed)}\n\n`);
            }
          }
        } finally {
          draining = false;
        }
      };

      // watchFile polls; fs.watch on macOS misses appendFile events often
      // enough that a 150ms poll is the more honest primitive here.
      watchFile(evidenceFile, { interval: 150 }, drain);
      const keepalive = setInterval(() => res.write(': keepalive\n\n'), 25_000);

      req.on('close', () => {
        unwatchFile(evidenceFile, drain);
        clearInterval(keepalive);
      });
      return true;
    }

    sendJson(res, { error: 'not found' }, 404);
    return true;
  }

  return { handle };
}
