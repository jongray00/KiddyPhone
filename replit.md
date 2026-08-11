# KiddyPhone on SignalWire

A child-safe phone gateway with whitelist gating, built two ways on SignalWire. A parent keeps a whitelist of allowed callers; the app bridges allowed callers and silently blocks others — billing starts only at the bridge.

## How to run

```
npm run gateway   # starts the test lab at port 5000
```

The workflow "Start application" runs this automatically.

## Stack

- **Runtime:** Node.js 20 (ESM)
- **SignalWire:** `@signalwire/realtime-api` 4.2.1 + SWML webhook approach
- **Web phone:** SIP.js 0.21.2 (browser-side)

## Project layout

```
apps/relay/     RELAY Realtime SDK implementation
apps/swml/      SWML webhook implementation
console/        Demo shell: gateway server + landing page + line-test console
shared/         Env loading and per-space provisioning helpers
docs/           Findings and review reports
```

## Key entry points

- `console/gateway.mjs` — the HTTP gateway (port controlled by `PWPOC_GATEWAY_PORT`, defaults to 5000 on Replit)
- `apps/relay/src/signalwire/` — RELAY SDK integration (handler, connect-guard, app)
- `apps/swml/src/signalwire/` — SWML artifacts (docs, rest, arm, caller)

## Publishing

`.replit` carries a `[deployment]` section: `run = ["npm", "run", "gateway"]`,
target `vm`. Without it, publishing fails with "Invalid run command" — the
`[workflows]` entries drive the Run button only and are not a deployment
command.

Reserved VM rather than autoscale, because this is a stateful lab: the gateway
holds slot state in memory, runs the app it launched as a child process, keeps
SSE connections open for the length of a demo, and in RELAY mode owns a
persistent WebSocket to SignalWire. Scaling to zero drops a guided listener
mid-call; a second instance has no idea what the first one started.

The published hostname is picked up automatically — `REPLIT_DOMAINS` in a
deployment, `REPLIT_DEV_DOMAIN` in the workspace — so the SWML webhook base
follows the deployment without any change. Check that the three SignalWire
secrets are present on the deployment itself; the deployment does not read the
workspace's secrets pane.

## Routing and webhooks here

One public hostname fronts the whole lab. The gateway is the only process bound
to the outside; both apps listen on loopback and are reverse-proxied under a
path prefix, so nothing else needs a port or a tunnel.

| Public path | Serves |
|---|---|
| `/` | landing page: connect a space, pick a mode, launch |
| `/relay/…` | the RELAY line-test console (loopback :8787) |
| `/swml/…` | the SWML app: webhooks and the test-suite UI at `/swml/ui` (loopback :8080) |

The webhook base is derived from the environment at boot —
`https://$REPLIT_DEV_DOMAIN/swml` — and injected into the SWML app as
`PUBLIC_URL`. Arming a scenario points the DID at `<base>/inbound`,
`<base>/inbound/twostep`, or `<base>/inbound/request-flow`; `status_url` and the
request-flow `/auth` URL come from the same base. Nothing needs to be set by
hand.

Overrides, if the lab ever moves behind something else:

| Variable | Effect |
|---|---|
| `PWPOC_PUBLIC_ORIGIN` | the origin to advertise, e.g. `https://lab.example` |
| `PUBLIC_URL` | the SWML webhook base outright, bypassing derivation |
| `PWPOC_BIND` | gateway bind address (hosted default `0.0.0.0`, otherwise loopback) |

Both child apps bind loopback on purpose, and `.replit` maps exactly one port
(5000 → 80). If a `[[ports]]` entry for 8080 or 8787 ever appears there, it was
added by the editor's port detector, not by the app: it publishes a child
directly at `<domain>:<port>`, bypassing the gateway and its path prefix.
Remove it.

**Exposure:** the dev URL is public and unauthenticated. Anyone with the link
can reach the consoles, read the SIP credentials the web phone registers with,
and trigger billable test calls. Keep the URL private, or set
`PWPOC_ALLOW_FORWARDED_CONTROL=0` to refuse proxied requests for the SWML
phone credentials and test-call trigger (which also disables the web phone).

## Required secrets

Set in Replit Secrets:

| Secret | Description |
|---|---|
| `SIGNALWIRE_PROJECT_ID` | Project ID from SignalWire Dashboard → API |
| `SIGNALWIRE_TOKEN` | API token with Voice scope |
| `SIGNALWIRE_SPACE_URL` | Bare hostname, e.g. `example.signalwire.com` |

These three are the demo space's credentials. The gateway reconciles its stored
copy (`console/spaces.json`) with them on every boot and probes them once,
logging whether they were accepted — so correcting a secret and restarting is
enough, with no file to edit. Spaces connected through the landing page keep
their own credentials and are left alone.

## Tests

```
npm test   # runs both apps' unit suites (136 tests total)
```

## User preferences

- Keep existing project structure and stack.
