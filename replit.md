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

## Required secrets

Set in Replit Secrets:

| Secret | Description |
|---|---|
| `SIGNALWIRE_PROJECT_ID` | Project ID from SignalWire Dashboard → API |
| `SIGNALWIRE_TOKEN` | API token with Voice scope |
| `SIGNALWIRE_SPACE_URL` | Bare hostname, e.g. `example.signalwire.com` |

## Tests

```
npm test   # runs both apps' unit suites (136 tests total)
```

## User preferences

- Keep existing project structure and stack.
