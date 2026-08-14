# The long-ring matrix — what the platform does with an unanswered connect

**Run:** 2026-08-14, SignalWire demo space, 13 live scenarios via
`apps/relay/live/evidence.mjs` (one child process per scenario, JSONL logs and CDR
snapshots in `apps/relay/live/evidence-*`; the files are gitignored, this document
is the durable record).
**Targets:** the guarded relay app (`@signalwire/realtime-api` 4.2.1), a raw
customer-shaped handler on the same package, the current server SDK
(`@signalwire/sdk` 2.x, `apps/serversdk`), and SWML `connect` with
`answer_on_bridge` hosted as a static script.
**Question under test:** how long can an inbound leg ring connected-but-unanswered,
what happens when a dial timeout exceeds that, and what does the caller actually
hear on ring-out and on busy.

Demo-space caveat stands: mechanism transfers, numbers should be confirmed on the
customer's own project before quoting externally. The caller in every run is an SDK
`dialPhone` leg with a 55 s timeout; reason codes below are what that surface
reports.

## The one-line result

The platform gives a connect roughly 20 seconds, regardless of the timeout you ask
for. Ringing longer than that is not a knob; it is a loop. Release the killed leg
and the still-ringing caller comes back as a fresh offer under a new call id, and
the flow runs again. Both SDKs behave identically; SWML runs the same loop
server-side where no application code sees it. Billing starts at the bridge in
every variant, including a pickup that lands mid-loop.

## Finding 1 — the ~20 s dial window is a platform ceiling

| Scenario | Requested timeout | What happened |
|---|---|---|
| `relay-t18-never`, `serversdk-t18-never` | 18 s | Clean ring-out: exactly 1 offer, 1 call id, `failedReason: "noAnswer"` at the requested timeout. |
| `relay-t30-never` | 30 s | Connect killed at ~21 s with `failedReason: "error"`. The timeout was not honored. |
| `relay-t45-never`, `serversdk-t45-never` | 45 s | Same kill at ~20–21 s, `failedReason: "error"`. |

A timeout of 18 s stays inside the window with margin and rings out cleanly. Any
value at or above ~20 s buys nothing except trading the clean `noAnswer` for an
`error`. This is why `PWPOC_DIAL_TIMEOUT_SEC` now defaults to 18.

`failedReason` is the discriminator, and it arrives on a code-less plain object on
4.2.1: `noAnswer` (clean ring-out), `busy` (destination refused), `error` (the
platform killed the connect at the window). `src/faults.js#failedReason` reads it
through the fault boundary.

## Finding 2 — long ringing is re-offer handling, not a longer timeout

With a 45 s timeout and a released leg, the caller was re-offered on a fresh call
id each cycle (`relay-t45-never`: offers at +2.8 s, +26.2 s, +55.3 s — three offers,
three distinct ids). The caller heard continuous ringback through all of it and
rang the full 55 s of its own dial timeout. Every leg billed $0.

The corrected mental model for the guarded app:

- Inside the window the connect suppresses re-offers (the RESULTS.md "1 offer,
  1 call id" rows all resolved inside it).
- At the window boundary the platform kills the connect (`error`) and, once the
  app releases the leg, re-offers under a new id. Each fresh offer restarts the
  window: the "switch lines" pattern.
- The guard's initiator/joiner roles keep each cycle to one connect, and a
  re-delivered offer that joins an in-flight attempt stands down instead of
  touching a leg it does not own.

## Finding 3 — the reported bug, reproduced exactly

`relayraw-t45-answer30` is the customer's handler shape: connect on every offer
with `timeout: 45`, nothing released on failure. The connect died at ~21 s
(`error`), the leg was left dangling, and **no re-offer ever arrived**. When the
child picked up at 35 s, the answer failed — the B-leg's connect was already dead.
The caller rang unanswered to its own 55 s timeout and got `noAnswer`.

That is the complaint verbatim: the phone rings for the full timeout, nobody can
pick up after the first ~20 s, and the caller ends in dead air. The fix is not a
bigger timeout; it is (a) a timeout inside the window, and (b) releasing the leg
on `error` so the platform re-offers and the next cycle can bridge.

The guarded app on the same package (`relay-t45-answer30`) proves the fix: first
connect died at ~21 s, leg released, re-offer at +26 s, second connect delivered a
fresh B-leg, child answered at +35 s, **bridged on the second call id**. Billing
covered only the ~5.5 s bridged window (caller leg $0.03382, inbound leg $0.0066,
SIP B-leg $0.003); every first-cycle leg billed null/$0. The current server SDK
(`serversdk-t45-answer30`) matched leg for leg.

## Finding 4 — busy works, and what ring-out sounds like

- `relayraw-busy` / `serversdk-busy`: the child's busy propagated as
  `failedReason: "busy"` about 5 s in; the caller's dial failed with
  `reason: "busy"`. On the raw handler `hangup('busy')` in the exception path
  succeeded. The busy path did not reproduce a defect in these runs.
- On every target, a silent release after ring-out reads as **busy** to the
  caller (~21–22 s in the t18 runs). A caller cannot tell "nobody answered" from
  "line busy" under the default decline.

That caller-experience gap is why the handler grew configurable ring-out actions
(`PWPOC_NO_ANSWER_ACTION`): `decline` (default, silent), `early-media-message`
(TTS on the unanswered leg, no answer, no voice minutes — the D16 result), or
`voicemail` (the one flow that deliberately answers, and therefore bills).
`PWPOC_BUSY_ACTION` mirrors this for busy.

## Finding 5 — the three avenues compared

| | RELAY 4.2.1 (guarded) | @signalwire/sdk 2.x | SWML `answer_on_bridge` |
|---|---|---|---|
| Dial window | ~20 s, `error` past it | identical | identical (internal) |
| Long ring | app handles re-offers | app handles re-offers | platform re-dials server-side; no app code involved |
| Mid-ring pickup | bridges on the newest call id | same | same (caller answered at the bridge moment, 35 s in) |
| Ring-out heard as | busy (configurable) | busy | busy |
| Billing | bridge-only, $0 otherwise | identical | identical |

SWML is the least code: the same 45 s intent produced a full 55 s of caller
ringback with the redial cycles invisible, and it never touched a webhook (static
script hosted on the space). The SDK paths buy programmability — per-call
authorization against a live API, custom ring-out actions — at the cost of owning
the re-offer loop.

## What changed in the app because of this evidence

- `PWPOC_DIAL_TIMEOUT_SEC` default 30 → **18** (inside the window, with margin).
- `connect-guard.js` returns a `role`: only the `initiator` owns the outcome;
  `joiner` deliveries stand down (a joiner hanging up was the D4 class of bug).
- `handler.js` routes `failedReason`: `noAnswer` → configured no-answer action,
  `busy` → configured busy action, `error` → release the leg so the re-offer
  cycle continues.
- `faults.js#failedReason` extracts the discriminator without throwing.

All behavior is pinned by the offline suites (88 relay, 6 serversdk, 64 swml).
