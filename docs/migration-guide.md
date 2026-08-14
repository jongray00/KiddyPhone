# Migrating the KiddyPhone flow from `@signalwire/realtime-api` to `@signalwire/sdk`

The whole KiddyPhone decision — authorize while the leg stays unanswered, connect
with the child as the peer, or decline — carries over to the current server SDK
intact. `apps/serversdk/src/signalwire/` is the working proof: the same live
matrix (ring-out, long ring, mid-ring pickup, busy) passed on both packages with
identical platform behavior and identical billing. What changes is the API
surface, and a handful of the changes are semantic, not cosmetic. This guide
catalogs the ones we hit, each verified live on `@signalwire/sdk` 2.x.

## Wiring

Old (4.2.1):

```js
const client = await SignalWire({ project, token });
await client.voice.listen({ topics: ['kiddyphone_inbound'], onCallReceived: handle });
```

New:

```js
const client = new RelayClient({ project, token, contexts: ['kiddyphone_inbound'] });
client.onCall(handle);
await client.connect();
```

Two traps here:

1. **One `onCall` handler per client.** Registering a second replaces the first.
   The old SDK let each `listen` carry its own handler; on the new SDK you route
   inside a single handler (or run one client per context).
2. **Do not pass your space hostname as `host`.** The space hostname answers the
   websocket upgrade with a 302 and the connection dies. The default RELAY
   endpoint authenticates the project/token pair fine.

## Caller identity moved

`call.from` does not exist on the new call object. The inbound identity lives in
the wire device descriptor:

```js
const from = call.device?.params?.from_number ?? call.device?.params?.from ?? null;
```

If your whitelist check reads `call.from`, it will see `undefined` and (if you
fail closed, which you should) decline every call. This is the quietest breakage
in the migration — nothing throws.

## `connect()` resolves at the ACK, not at the outcome

This is the largest semantic change. On 4.2.1, `connectSip(...)` resolved when
the B-leg bridged and rejected when the dial failed, so try/catch was the control
flow. On the new SDK:

```js
const ack = await call.connect([[{ type: 'sip', params: { to, from, timeout } }]]);
// ack is the command acknowledgment ({ code: '200' }) — nothing has rung yet.

const outcome = await call.waitFor(
  'calling.call.connect',
  (e) => ['connected', 'failed', 'disconnected'].includes(e?.connectState ?? e?.params?.connect_state),
  (timeoutSec + 15) * 1000,
);
```

A port that keeps the old try/catch shape will treat every dial as an instant
success. The outcome (`connected` / `failed`) arrives later as a
`calling.call.connect` event, and you must wait for it explicitly.

Note the argument shape as well: `connect()` takes a device plan (serial groups
of parallel devices) instead of the `connectSip` / `connectPhone` variants.

## Errors became real Errors

4.2.1 rejected with plain objects — no `Error` identity, string codes, sometimes
no code at all (the connect-failure object is `{ connectState: 'failed',
failedReason: 'noAnswer' | 'busy' | 'error', ... }`). The new SDK throws
`RelayError`, a real `Error` subclass with a numeric `code`. Any fault boundary
built around "compare `Number(err.code)`" keeps working; string-equality checks
on codes do not.

The 409 rule survives unchanged and still matters: a conflict ("Wait for connect
to finish") means another attempt owns the leg. Log it and stand down. Hanging up
on a 409 is what tore down live bridges on the old package.

## Waiting for the far end

4.2.1 has a real bug here: `Call.waitForDisconnected()` returns the `disconnect`
method instead of waiting (use `disconnected()`). On the new SDK the equivalent
is `call.waitForEnded()`, which behaves as named.

## What does not change

Measured identical on both packages in the live matrix
(`docs/longring-findings.md`):

- The platform's ~20 s dial window. A connect timeout past ~20 s is killed with
  `failedReason: "error"` on either SDK. Keep dial timeouts at 18 s or below.
- The re-offer loop. Release a killed leg and the still-ringing caller returns
  as a fresh offer under a new call id; long ringing means handling that loop.
  Leave the leg dangling and the caller strands in ringback until their own
  timeout — the original bug, and it reproduces identically on both packages if
  you port the broken shape faithfully.
- Billing starts at the bridge. Ring time is free on every leg type, including
  carrier PSTN legs, including a pickup that lands mid-loop.
- Busy propagation: the destination's busy reaches the caller as a busy result
  within ~5 s.
- Never answer to decide. `answer()` is still what starts billing; the decision
  flow works entirely on the unanswered leg on both packages.

## Suggested port order

1. Wire the new client next to the old one on a test context (both SDKs coexist
   in one process; this repo does exactly that in the evidence harness).
2. Move identity extraction to the device descriptor and re-run your whitelist
   tests against it.
3. Rebuild the connect around ACK-plus-event and route `failedReason`.
4. Port the 409 stand-down and the release-on-error re-offer handling last, and
   verify with a long-ring call, not only a quick-answer call — the quick path
   hides the window entirely.
