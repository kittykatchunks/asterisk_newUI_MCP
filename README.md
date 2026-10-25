# asterisk_newUI_MCP

Planning a containerised, multi-customer Asterisk platform with a multilingual
management UI, roaming-agent console, AI voice handling, and MCP integration.

See the [project plan](./PROJECT-PLAN.md) for agreed requirements, proposed
architecture, open decisions, and the delivery and verification approach.

The [first milestone specification](./MILESTONE-1.md) defines the proposed local
calling, tenant-isolation, and engineering-evidence proof.

The [component evaluation](./COMPONENT-EVALUATION.md) records the foundation
shortlist, upstream sources, and technical proof gates.

Status: planning plus an initial local Asterisk runtime proof. No web application
or production deployment exists yet.

## Deterministic synthetic booking harness

`openBookingSimulation` in [src/booking-simulation.ts](./src/booking-simulation.ts)
is a trusted in-process test harness, not a live dispatch connector or an
authenticated API. It uses its own absolute-path SQLite database and accepts
only fixture customers `customer-a` and `customer-b`. Each customer's locations
are `<customer>-station` and `<customer>-hotel`; these identifiers are also the
fixed synthetic location labels. Conversations use `synthetic-...` IDs, names
start with `Synthetic ` and contacts use `test-contact-...`, not real numbers.
Only book-now journeys with one to eight passengers are supported.

Reproduce the acceptance harness with Node.js 24:

```powershell
npm run typecheck
node --test .\tests\booking-simulation.test.ts
```

Example in-process sequence (supply a dedicated absolute database path):

```typescript
import { openBookingSimulation } from "./src/booking-simulation.ts";

const store = openBookingSimulation(databasePath);
try {
  const draft = store.create("customer-a", "synthetic-call", {
    pickup: "customer-a-station", destination: "customer-a-hotel",
    passenger: "Synthetic Alice", contact: "test-contact-alice", passengers: 2,
  });
  const summary = store.review("customer-a", draft.id);
  // The harness represents explicit confirmation of the exact displayed revision.
  store.confirm("customer-a", draft.id, summary.revision);
  const unknown = store.submit("customer-a", draft.id, "lose-reply");
  console.log(unknown.simulation, unknown.state); // true, outcome unknown
  const recovered = store.reconcile("customer-a", draft.id);
  console.log(recovered.simulation, recovered.state); // true, accepted
} finally {
  store.close();
}
```

Cases are `accept`, `reject`, `lose-reply` (acceptance committed before simulated
reply loss), and `unresolved`. Every operation/read requires customer scope.
`edit` invalidates confirmation, submitted payloads cannot be edited, and replaying
an already-settled/unknown operation returns its current state without another
dispatch effect. A still-`submitting` operation rejects submission retries;
reopen does not run work automatically. Explicit `reconcile` looks up the
existing result; absence stays unknown. Creating or submitting a replacement in
the same conversation is blocked while another operation is pending/unknown.
An explicitly confirmed later booking is allowed after settlement.

Simulator effects and application receipts commit separately in the same dedicated
database so the test can exit a process between them. `afterEffect` is an optional
synchronous fault-injection hook, not an application callback or worker service.
Unexpected errors propagate and leave committed submission evidence for explicit
reconciliation. Only the simulator's defined uncertainty becomes an unknown
outcome automatically. SQLite write transactions serialize mutations across
connections/processes; reads return detached, validated snapshots. Ordered
transition records include state, safe reason and revision within each scoped
operation record. They are not a tamper-proof production audit log.

`handover(customer, id, reason)` returns collected details, revision/confirmation,
actual outcome/reference and a safe reason (`human_requested`, `caller_disconnected`
or `unsupported_request`). It performs no call transfer or cancellation. Invalid
or unsupported draft fields throw before dispatch; for a collected supported draft,
the harness can explicitly produce an unsupported-request handover rather than
submit. Caller disconnect preserves unknown state and permits later reconciliation.

Validation passed eight booking tests plus ten existing lease/assignment storage
regressions (18 total) and typecheck. Tests cover confirmation invalidation,
two-customer denial, stable rejection, detached reads, lost replies, unresolved
absence, competing processes, storage faults, corrupt stores and process exit after
effect commit. Temporary databases are removed by tests; no service is started.

Limitations: this is not booking authorisation, real personal-data processing,
Autocab idempotency evidence, a production recovery protocol, availability/fare/ETA
or allocation evidence, voice AI, or a UI/HTTP/MCP surface. A trusted caller that
invents another conversation identity is outside the same-conversation duplicate
guard; future user-facing identity, permissions and reconciliation must not rely
on caller-supplied scope. See the
[BS-01 through BS-10 evidence](./PROJECT-PLAN.md#executed-booking-simulation-evidence).

### Authenticated simulation API foundation

The simulation workspace now includes a browser page, eligible agent navigation,
fixed simulation login return and explicit local-launcher opt-in, described below.
Normal local engineering startup still
does not open a simulation database or grant simulation permission. Calling and
real dispatch remain disabled.

The optional final `bookingSimulation` argument to `createDiagnosticApi` is the
explicit embedded-server opt-in. Supply a dedicated absolute-path store from
`openBookingSimulation` and matching application-session configuration; supplying
the store without application sessions fails at startup. The server owner must
close the store after stopping the server. Existing agent/device/diagnostic stores
must not be supplied as the simulation database. With no supplied simulation
store, eligible requests receive `503 booking_simulation_disabled`.

Every simulation request requires a current application session bound to the URL
customer and provisioned membership in **both** `agent:access` and
`booking:simulate`. Neither token roles nor diagnostic support grants supply these
permissions. The adapter derives issuer/subject from verified server context and
does not expose the trusted customer-only harness methods. Session mutations use
the existing exact-origin/CSRF protections; bearer-only use is denied. Simulation
reads also require the page's `X-CSRF-Token` to bind them to its bootstrap session:
an old page cannot list/read through a newly rotated cookie. Reads do not
mutate or reconcile. All responses are non-cacheable and carry a request reference;
simulation responses are explicitly labelled, including unavailable/error results.

The API prefix is `/api/customers/<customer>/booking-simulation`. This is an
authenticated synthetic test surface, **not** real booking authorisation:

| Method and suffix | Strict JSON body / result |
|---|---|
| GET `conversations` | Own conversation IDs and operation IDs/states/revisions only. No request body or query parameters. |
| POST `conversations` | `{}`; allocate a server-generated synthetic conversation owned by the verified issuer/subject/customer. |
| POST `conversations/<id>/drafts` | `{ "details": <SyntheticJourney> }`; create a validated draft in an owned conversation. |
| GET `operations/<id>` | Read an owned operation's actual durable state. |
| POST `operations/<id>/edit` | `{ "details": <SyntheticJourney>, "revision": <displayed revision> }`; update only that revision and invalidate confirmation. |
| POST `operations/<id>/review` | `{ "revision": <displayed revision> }`; return the canonical summary for confirmation. |
| POST `operations/<id>/confirm` | `{ "revision": <displayed revision> }`; explicitly confirm that summary. |
| POST `operations/<id>/submit` | `{ "scenario": "accept" \| "reject" \| "lose-reply" \| "unresolved", "revision": <displayed revision> }`; separately submit the confirmed revision. |
| POST `operations/<id>/reconcile` | `{}`; look up the existing result without another dispatch effect. |
| POST `operations/<id>/handover` | `{ "reason": "human_requested" \| "caller_disconnected" \| "unsupported_request" }`; return context without transferring/cancelling. |

Bodies are limited to 2,048 bytes, JSON only with no extra keys or compressed
encoding. Invalid input is `400`, foreign/unowned resources are `404`, state/stale
revision conflicts are `409`, and unexpected storage/audit errors are `503` without
private exception text. `401`/`403` retain the existing session/permission/CSRF
meaning. A lost response is not a business rejection: explicitly list your own
conversations to recover lost creation receipts, then read/reconcile known operation
IDs. Do not automatically repeat creation or submission after a transport error.

Simulation schema 2 adds persistent conversation ownership; schema-1 harness
records stay unowned and inaccessible through this API. The trusted local harness
still reads them. The diagnostic audit store migrates schemas 1/2 to schema 3 with
a nullable booking-operation correlation column. Existing rows remain intact and
older schema-1/2 diagnostic backups remain readable. Backup manifest format 2 is
unchanged (it is not the database schema number). Use matching updated binaries
for upgraded databases; old binaries reject the newer schemas. Simulation ownership
storage is not covered by the diagnostic backup and no production backup/recovery
claim is made for this new surface.

Audit commits gate data responses/mutation intents; they are not completed booking
receipts and are not atomic with the simulation database. Known authorised operation
IDs are correlated without storing passenger/contact details, cookies or tokens.
Logout while an audit is waiting fences the subsequent mutation. An unexpected
failure after simulator commit is an explicit unavailable result; the existing
operation remains discoverable for reconciliation, never automatically resubmitted.

Reproduce the foundation and affected regressions:

```powershell
npm run typecheck
node --test .\tests\booking-simulation.test.ts .\tests\booking-simulation-ownership.test.ts .\tests\booking-simulation-http.test.ts .\tests\access.test.ts .\tests\application-session.test.ts .\tests\agent-device-http.test.ts .\tests\diagnostic-store.test.ts
```

Recorded result: typecheck and 60 tests passed, including six new ownership/HTTP
tests, permission-specific checks and audit migration/backup coverage. The suite
uses temporary databases and loopback synthetic identity servers, cleaned up on
completion. It does not run the real Keycloak launcher proof or any REFER checks.
This was the initial API-only evidence; the completed browser/launcher increment
and its broader verification follow.

### Synthetic booking browser workspace

The finite SW-01 through SW-12 scope is implemented and verified for a local
synthetic exercise. Start the explicitly opted-in launcher:

```powershell
.\scripts\Start-LocalEngineering.ps1 -WithSimulation
```

Prerequisites are Node.js 24, the existing dependencies/Playwright browser, Docker
with the pinned local identity image available, free local proof ports, and existing
synthetic identity fixture accounts. If these accounts have never been generated,
run `.\scripts\Test-IdentityProof.ps1` once first. Do not use live identities or
credentials. The launcher retains the exact existing Alice/Bob subjects while
rotating synthetic passwords/client secrets. Missing or invalid accounts fail
explicitly rather than silently assigning ownership to new subjects.
When a simulation database already exists, later launches/proof runs also retain
these subjects even if simulation is not enabled; retention never grants permission.

Open `http://127.0.0.1:18766/simulation/customer-a` and sign in as synthetic Alice
using the ignored local fixture credentials. Login returns only to the fixed
customer-scoped simulation path, not an arbitrary URL. The public page shell has no
customer data; its session-bound API must verify both permissions before loading
own exercises. Eligible agent pages also show an **Open booking simulation (no
real bookings)** link. Synthetic Bob remains denied, including direct navigation.

`-WithSimulation` explicitly grants Alice `agent:access` and `booking:simulate` and
opens `.local-proof\engineering\booking-simulation.sqlite`. It does **not** require
an agent assignment database, reserve a device or enable phone controls. Add the
existing `-WithAgents` switch only if separately testing reservations; its existing
operator-provisioned assignment preflight still applies. No opt-in is remembered as
a default grant, even when the database remains on disk.

The page provides only fixed synthetic passenger/contact/location choices and
passenger counts. Its persistent **SIMULATION ONLY — no taxi will be booked**
notice applies to every exercise:

1. Explicitly start a synthetic exercise or resume your own durable conversation.
   Landing/reload lists IDs/states but creates nothing and does not read an
   operation until you choose Resume.
2. Create/edit a draft, review its canonical summary, then explicitly confirm the
   displayed revision. Unsaved edits disable review/confirmation/submission;
   saving clears confirmation. Server-side revision checks also fence stale tabs.
3. Separately choose one of four labelled test scenarios and submit. Accepted is
   only simulated acceptance, never allocation/ETA/fare or a real booking.
4. Use Read current operation and explicit Reconcile for pending/unknown results.
   A lost response blocks further mutations until explicit recovery; it never
   becomes rejection or an automatic retry. Lost conversation/draft creation
   replies are recoverable through Refresh own exercises without recreating them.
5. Show saved handover context for human request, unsupported request or caller
   disconnect. This does not transfer/cancel anything and preserves unknown state.
   A second operation in the same conversation is offered only after settlement.
6. Logout immediately clears displayed details and aborts pending work before
   waiting for the server receipt. Failed logout is explicit; reload to check and
   retry. Expiry/denial also clears details, and late replies cannot restore them.
   A later login can resume the same identity's work; logout never cancels it.

There is no polling, background reconciliation, microphone request, SIP/WebSocket
activation or browser storage of credentials/details. Starting a new exercise is
explicitly a separate synthetic request, not a duplicate-retry escape hatch.
Errors retain request references and require an explicit read/list recovery rather
than claiming success. This is a plain HTML/JS proof, not a visual-design or
comprehensive accessibility audit.

Reproduce all focused checks:

```powershell
npm run typecheck
node --test .\tests\booking-workspace.test.ts .\tests\booking-simulation.test.ts .\tests\booking-simulation-ownership.test.ts .\tests\booking-simulation-http.test.ts .\tests\access.test.ts .\tests\application-session.test.ts .\tests\agent-console.test.ts .\tests\agent-profile.test.ts .\tests\agent-device-http.test.ts .\tests\agent-device-lease.test.ts .\tests\local-agent-launcher.test.ts .\tests\diagnostic-store.test.ts
.\scripts\Test-IdentityProof.ps1
```

Recorded results: typecheck and **75 focused tests passed**, including five browser
workflow tests with keyboard/status/traffic checks and injected transport loss,
pending replies, conflicts, unavailability, malformed data, denial, expiry and
failed logout. The real Keycloak runner also passed identity, application-session
and launcher proofs. Its simulation extension verifies fixed login return, eligible
navigation, Bob denial, no assignment/device prerequisite, default-off restart and
one unknown result recovered to acceptance after restart with exactly one simulator
effect. Temporary databases/servers and the runner-owned identity deployment are
cleaned up; interactive startup runs until you type `stop` then Enter or press
Ctrl+C and preserves its local databases.

The SW increment is complete only for the synthetic browser contract. No real
Autocab/YAML integration, voice AI, call activation, external dispatch failure
semantics, production booking authority or simulation-store backup/restore proof
is claimed. REFER remained frozen and was not rerun. See the
[executed workspace evidence](./PROJECT-PLAN.md#executed-simulation-workspace-evidence).

## Local runtime proof

Prerequisites: Docker Desktop with a running Linux engine, Docker Compose v2,
and PowerShell 7. The initial image download requires registry access.

```powershell
docker compose config --quiet
.\scripts\Test-LocalProof.ps1
docker compose stop
```

The test starts two digest-pinned Asterisk 22.11.0 instances and restarts them to
verify persistence. It leaves them running for inspection; stop them afterward
when not needed. It does not stop Docker Desktop or unrelated containers.

Each instance has its own internal network and named data volumes, no published
host ports, a non-root process, and read-only mounted configuration. The shared
configuration is a synthetic fixture, not customer-specific production settings.
HTTP and AMI are disabled; no SIP endpoints or trunk credentials are configured.

The test checks module readiness, generates internal Local-channel tone and empty
queue calls, checks fresh CEL lifecycles and queue timeout events, verifies a WAV
with an audio payload, and verifies database/log/recording persistence after restart.
It also checks separate Docker networks/volumes and absence of published ports.
Tests add synthetic history and recordings on each run; this is not a retention
implementation.

Useful inspection commands:

```powershell
docker compose ps
docker compose exec customer-a asterisk -rx "cel show status"
docker compose exec customer-a asterisk -rx "pjsip show transports"
docker compose logs --tail 50
```

Validated locally on 22 October 2026: both runtime instances passed the automated
proof. This does **not** prove SIP/RTP calls, browser audio, user authentication,
adversarial tenant isolation, diagnostic capture, restore from backup, or the
50-call/10-AI capacity target.

`docker compose stop` preserves data. `docker compose down` removes the project
containers/networks; do not add `--volumes` unless intentionally deleting test
data. No production credentials or real caller data should be used in this proof.

## Authenticated SIP and RTP proof

With the same prerequisites, run:

```powershell
.\scripts\Test-SipProof.ps1
docker compose stop
```

This opts into `compose.sip-proof.yaml`. It generates different random endpoint
passwords per customer in ignored `.local-proof` directories. Keep those files
private; they are local test credentials, not a production secrets implementation.
The default Compose configuration has no endpoint credentials.

The script force-recreates both proof PBXs to load the test settings, interrupting
any active synthetic calls. It starts disposable software clients inside each
customer's private network, using Python already present in the pinned image.
No host ports are published and no third-party SIP account is needed.

Each client verifies:

- An unauthenticated INVITE is challenged.
- Wrong and other-customer credentials are rejected.
- Correct credentials establish a PCMU call to the restricted echo route.
- At least 70 of 100 distinct synthetic RTP payloads return unchanged.
- The dialog ends successfully with BYE.

The runner then verifies a fresh PJSIP CEL lifecycle and a mono, 8-kHz, 16-bit WAV
containing at least one second of audio. Both customers returned 100/100 distinct
RTP frames in the local test on 22 October 2026. The baseline persistence test
also passed after the changes.

This is a bounded UDP/PCMU integration fixture, not a production SIP client or
endpoint-provisioning design. It deliberately uses digest authentication on an
internal test network; TLS/WSS, DTLS-SRTP, browser certificate trust, registration,
WAN networking, and complete tenant isolation remain unverified.

`Test-LocalProof.ps1` uses only the base configuration and recreates the PBXs
without these test endpoint mounts when run afterward. Test data volumes are
shared between these two modes and preserved.

## Rejected-target REFER proof

```powershell
.\scripts\Test-ReferProof.ps1
```

This uses [compose.refer-proof.yaml](./compose.refer-proof.yaml), reuses or
generates customer A's ignored synthetic endpoint credentials, and force-recreates
only customer A. It interrupts that PBX's synthetic calls. The runner waits for
health, checks Asterisk 22.11.0, explicitly loads and verifies
`res_pjsip_refer` and the proof dialplan's `func_cut`, and tests
both `norefersub=yes` and `norefersub=no` using an ignored proof-only
configuration mount. It verifies both the CLI setting and the presence/absence
of `Supported: norefersub` on each INVITE `200`, and stops customer A between
settings and in a `finally` block. For each setting it also recreates the PBX
with a proof-only `allow_transfer=no` endpoint override and verifies the CLI
value before running the disabled-transfer cases. No host ports or
external SIP accounts are used, and persistent proof data is preserved.

On 24 October 2026, the complete runner passed 106 rejected-target/policy dialogs,
144 accepted bridged-transfer dialogs (24 Local-target and 120 PJSIP-target
cases), and 24 bridged-call preservation dialogs, with
six additional branch/CSeq sequencing attempts inside two of those dialogs. The
full run includes all 32 answered/busy target ACK-loss cases (16 single-loss
and 16 consecutive-two-loss cases), all eight target-BYE-response-loss cases,
and all 24
cancellation-response-loss cases, including isolated
CANCEL `200` and INVITE `487` loss, alongside the rejection, transfer,
preservation, and notification-loss regressions. Scenario totals were checked
against the completed runner output; all correlated channel-cleanup assertions
passed and the proof PBX was stopped without removing persistent volumes.
Before this complete run, eight busy-target ACK-loss cases were added and passed focused
validation with 16 existing busy-target cases. Eight answered-target ACK-loss
cases were then added; a 48-case focused matrix passed answered/busy ACK loss,
final-response loss, and baseline transfers across all effective settings.
After tightening the 2xx ACK branch assertion, all eight answered ACK-loss
cases passed again. The subsequent complete run verified all these additions
together with the existing regressions.
Sixteen consecutive-two-ACK-loss cases also passed a
48-case focused matrix alongside baseline and single-ACK-loss regressions.
The complete run then verified these cases alongside all existing scenarios.
Eight target-BYE-response-loss cases also passed a 40-case focused matrix
before the complete run verified them alongside all existing regressions.
All 56 answered PJSIP-target cases echoed 100/100 distinct post-transfer RTP
payloads. The current runner and complete validation both cover 144 accepted
transfers (24 Local-target and 120 PJSIP-target).
The eight BYE-loss cases were subsequently strengthened to gate retry on all
four correlated channel ends. A 40-case focused matrix passed that ordering
check and related answered-target regressions. The complete suite then passed
again with the strengthened ordering check enabled; scenario totals are unchanged.
A later eight-case extension sends a new BYE transaction after recovery.
It passed alongside eight baseline cases in focused validation. The final
complete run also passed all eight extensions, including unchanged settled
CEL through the new transaction and its retry; transfer totals are unchanged.
The accepted and preservation totals include 24 cancellation-response-loss cases,
16 target-INVITE response-loss cases,
16 controlled REFER-response-loss cases,
and 16 terminal-NOTIFY acknowledgement-loss cases (eight first-only and
eight permanent-loss cases) described below. The
unknown-target group covers 48 cases: 12
`Refer-Sub` forms, each with and without `Require: norefersub`, under both
global advertisement settings. The baseline cases had these results:

| Unknown-target REFER | Final response | Progress |
| --- | --- | --- |
| `Refer-Sub: false` | `404` with `Refer-Sub: false` | No NOTIFY during a one-second observation |
| Implicit subscription (no `Refer-Sub`) | `202` | Terminal sipfrag `404`, subscription `terminated;reason=noresource` |
| `Require: norefersub` plus `Refer-Sub: false` | Same `404` response | No NOTIFY during a one-second observation |
| `Require: norefersub`, no `Refer-Sub` | `202` | Same terminal failure NOTIFY |

The extended header cases behaved identically across both settings and both
`Require` forms:

| `Refer-Sub` field value(s), in wire order | Final response | Progress |
| --- | --- | --- |
| `FALSE` or `false;foo=bar` | `404`, echo `false` | No NOTIFY during one second |
| `true`, `TrUe`, `true;foo=bar`, or invalid `trueX` | `202`, echo `true` | Terminal sipfrag `404` |
| Invalid `tru` or an empty field value | `404`, echo `false` | No NOTIFY during one second |
| Two fields: `false` then `true` | `404`, echo `false` | No NOTIFY during one second |
| Two fields: `true` then `false` | `202`, echo `true` | Terminal sipfrag `404` |

These observations confirm the pinned handler's permissive four-character
`true` prefix check and first-header selection. Accepting malformed/duplicate
inputs in this fixture is descriptive, not the policy for a future admission
gate; that gate must reject ambiguous or invalid inputs.

Another 20 cases cover missing `Refer-To`, an empty field, malformed
`<sip:>`, a `tel:` URI, and an `https:` URI, each with absent or false
`Refer-Sub` under both advertisement settings. All returned `400` without
`Refer-Sub` or `202`, repeated the same final response on an identical
retransmission, emitted no NOTIFY during one second, and accepted BYE.
This confirms peer-visible early rejection for those inputs; the fixture
does not instrument subscription allocation or operation claims.

Another 12 dialogs use a bare SIP URI (without angle brackets), an
angle-bracketed SIPS URI, or the compact `r` header, each naming an unknown
local extension with absent/false `Refer-Sub` under both advertisement
settings. All reached the same unknown-target outcome: subscribed `202`
followed by terminal sipfrag `404`, or no-subscription `404` with
`Refer-Sub: false`. Retransmissions and BYE passed. Accepting a SIPS target
here is a parsing/routing observation, not evidence of TLS transport or
successful target signaling.

Two additional dialogs (one per advertisement setting) start with a
no-subscription unknown-target REFER, then exercise transaction sequencing:

| Next REFER attempt in that dialog | Final response |
| --- | --- |
| Same Via branch, higher CSeq | `400`, no `Refer-Sub` |
| New Via branch, unchanged CSeq | `500`, no `Refer-Sub` |
| New Via branch, higher CSeq | `404`, `Refer-Sub: false` |

All six sequencing attempts emitted no NOTIFY during their one-second
observation windows, and both dialogs accepted BYE. These wire results match
the source-derived transaction/dialog rejection paths. They do not instrument
supplement invocation counts or prove custom claim serialization.

Another 24 dialogs repeat the unknown and five invalid target forms with
`allow_transfer=no`, absent/false `Refer-Sub`, and both advertisement settings.
All returned `603` without `Refer-Sub`, repeated the same final response on
retransmission, emitted no NOTIFY during one second, and accepted BYE. This
matches the endpoint-policy check running before target validation and progress
setup. It does not prove every transfer mechanism is disabled or satisfy the
product's required blind-transfer path.

Every dialog's baseline REFER is retransmitted with the identical transaction
key and checked for the same final status, To tag, and `Refer-Sub` response.
The fixture acknowledges NOTIFY requests and ends every dialog with a
successful BYE. The subscribed cases directly establish that this
fixture can create the implicit subscription and send its `202`; the later
failure NOTIFY does not make `202` target admission or transfer success.

The rejected-target cases do not prove response-send failure behavior,
transaction/reference lifetime, or reliable transport.
Their negative NOTIFY assertion is bounded by the
one-second window. The existing SIP/RTP probe also passed after the shared
message-parser/header changes, echoing 100/100 synthetic frames.

### Bridged call preservation after rejected REFER

The runner additionally uses [sip_refer_transfer_proof.py](./tests/sip_refer_transfer_proof.py)
to reject an unknown target while a PJSIP source is already bridged to a
Local transferee. Eight cases cover absent/false `Refer-Sub`, both global
`norefersub` settings, and both `refer_blind_progress` settings.
No-subscription REFER returns `404` with `Refer-Sub: false`; subscribed REFER
returns `202` followed by terminal sipfrag `404`. Identical retransmissions
preserve the status, To tag, and `Refer-Sub` response.

After that result, each case drains queued RTP and receives at least ten
distinct fresh PCMU RTP sequence numbers from the negotiated PBX address and
port within two seconds. Correlated CEL still shows exactly the original
three channel identities, the same source/transferee bridge, no bridge exit,
hangup, channel end, target execution, or `BLINDTRANSFER`. Client BYE then
receives `200`, and all three original channels end without any additional
channel creation or delayed transfer execution in the collected evidence.

This proves bounded original-call preservation and continued inbound RTP
delivery after rejection, not two-way audio quality, indefinite bridge
survival, external media, or preservation after an accepted transfer whose
target later fails. No-subscription NOTIFY absence is observed for one
second, as in the rejection matrix.

### Accepted bridged REFER proof

The same runner also executes [sip_refer_transfer_proof.py](./tests/sip_refer_transfer_proof.py)
with `allow_transfer=yes` and both `refer_blind_progress` settings verified
through the CLI. A proof-only dialplan include creates a PJSIP-to-Local bridge, then
redirects the original Local transferee to a unique target extension that
dials and bridges an answered second Local pair. Synthetic tones keep the
local media paths active; no external endpoint or real caller is involved.
The tester mounts the PBX's existing CEL volume read-only.

Twenty-four Local-target cases passed: answered/busy/no-answer targets with absent/false `Refer-Sub`
under both `norefersub` settings and both `refer_blind_progress` settings.
Eight cases have an answered target.
The no-subscription path returned `200` with `Refer-Sub: false` and no NOTIFY;
the subscribed path returned `202`. Answered targets produced terminal sipfrag
`200`; failed-target notifications are distinguished below.
Each case independently verifies:

- The source SIP Call-ID maps to the source CEL unique ID and linked ID.
- The source and original transferee entered the same bridge before REFER.
- That exact transferee executes the unique target; answered cases also
  prove a shared bridge with an answered target leg, while failure cases
  prove the target pair never answers or enters a bridge.
- An identical REFER retransmission returns the same final response and
  creates neither a second target execution nor a second `BLINDTRANSFER`.
- The `BLINDTRANSFER` event names the correct source, transferee, context,
  and target extension.
- The transferer dialog ends through BYE and all five correlated channels
  have both `CHAN_START` and `CHAN_END`.

The target route waits two seconds before creating its outgoing Local pair.
With `refer_blind_progress=no`, the subscribed cases observed terminal
NOTIFY `200` while CEL still showed no target-leg `CHAN_START`. They then
independently verified the later target outcome and cleanup. This
demonstrates that the early success sipfrag is not target-answer evidence;
the CEL observation is bounded to this fixture, not an instrumented proof of
the callback's exact instruction ordering.

These Local-target cases establish bounded accepted local blind transfers,
not generation claims/fencing, send-failure ordering, multi-party fallback,
or PJSIP transaction/refcount cleanup. The separate synthetic PJSIP-target
cases below cover outbound target signaling and bounded RTP echo. Terminal
NOTIFY alone remains insufficient proof: these tests rely on independently
correlated target bridges and CEL lifecycles.

Eight accepted-transfer cases redirect to a Local target running
`Busy(1)`. CEL verifies that the rejecting Local pair never answers or enters
a bridge, the original transferee finishes with `DIALSTATUS=BUSY`, and all
five channels end. Exactly one correlated transfer and target execution still
occur despite REFER retransmission. The fixture observes:

| Target outcome | `refer_blind_progress` | Subscribed terminal sipfrag |
| --- | --- | --- |
| Answered target | `yes` | `200` |
| Busy target, no answer | `yes` | `503` |
| Outbound PJSIP target rejects INVITE with `486 Busy Here` | `yes` | `503` |
| Ringing target that times out without answer | `yes` | Active `180`, then terminal `200` |
| Outbound PJSIP target rings until Dial timeout/CANCEL | `yes` | Active `180`, then terminal `200` |
| Any of these target outcomes | `no` | Early `200`, before target-leg creation |

The `503` is this fixture's observed progress result, not a claim that every
busy target maps to SIP `503`. In both modes the subscribed REFER itself
returns `202`; without a subscription it returns `200` and no NOTIFY even
when the target later fails. Thus neither REFER acceptance nor the disabled-
progress terminal `200` proves target success.

Eight additional cases use a Local target that rings but does not answer,
with a three-second `Dial()` timeout. CEL confirms `DIALSTATUS=NOANSWER`,
no target answer/bridge, and a target-pair lifetime of at least 2.5 and under
five seconds. All five correlated channels end; retransmission still creates
exactly one transfer and target execution. Normal-progress subscribed cases
observed active sipfrag `180` followed by terminal `200` despite the verified
no-answer outcome. The fixture retains synthetic tones on the original
Local peer; it does not instrument which frame/callback produces this terminal
result. Do not generalize this to every timeout or infer a target answer from
the sipfrag, even with normal blind progress enabled.

### Outbound PJSIP target and post-transfer RTP proof

Eight further accepted-transfer cases use a synthetic UDP SIP peer outside
the PBX process, implemented in
[sip_refer_peer_proof.py](./tests/sip_refer_peer_proof.py). They cover
absent/false `Refer-Sub`, both `norefersub` settings, and both
`refer_blind_progress` settings. All remain inside customer A's internal
Compose network, with no host ports, external accounts, or real audio.

A proof-only source route first bridges the authenticated PJSIP source to
an answered, non-optimized Local pair running `Echo()`. The original Local
transferee then executes a unique target route that dials the synthetic
PJSIP peer through the existing proof endpoint. Its address comes from the
source's network address and its random SIP port is encoded in the unique
test extension; these routes are isolated to the REFER proof include.

Each case verifies:

- A distinct outbound SIP Call-ID, target INVITE/PCMU offer, `200` answer,
  matching ACK, and successful target-initiated BYE.
- A pre-dial CEL marker mapping that exact outbound Call-ID to the target
  channel, its ANSWER, and its shared bridge with the original transferee.
- At least 70 of 100 distinct synthetic PCMU payloads echo unchanged from
  the target through the PBX and the original Local echo peer within three
  seconds. All eight cases returned **100/100** in the verified run.
- Exactly one matching `BLINDTRANSFER` and target execution despite
  identical REFER retransmission, source dialog cleanup, and all four
  correlated channels ending (two PJSIP channels and one Local pair).

Subscribed REFER returns `202` with terminal sipfrag `200`; without a
subscription it returns `200` with `Refer-Sub: false` and no observed NOTIFY.
With blind progress disabled, terminal success still precedes target-channel
creation; the later target answer, bridge, and RTP echo are checked separately.
The shared RTP checker also passed the original two-customer SIP regression:
wrong/cross-customer credentials returned `401`, both calls echoed 100/100
payloads, and fresh CEL lifecycles and WAV recordings were verified.

This establishes bounded media round-trip delivery through a synthetic
outbound PJSIP target, not a real dispatch trunk, production audio quality,
TLS/SRTP, target authentication, long-call stability, generation fencing,
or transaction/reference cleanup.

### Outbound PJSIP busy rejection

Eight additional accepted-transfer cases make the synthetic PJSIP peer
reject its outbound INVITE with `486 Busy Here` instead of answering.
They cover absent/false `Refer-Sub` under both advertisement and
blind-progress settings, reusing the original Local echo transferee and
the same two-second target-route delay.

The peer verifies that the subsequent ACK has the INVITE Call-ID, matching
CSeq number, and the original Via transaction branch. A CEL pre-dial marker
correlates that outbound Call-ID to exactly one distinct target PJSIP
channel. CEL must show no target ANSWER or BRIDGE_ENTER, the original
transferee's `DIALSTATUS=BUSY`, exactly one matching `BLINDTRANSFER` and
target execution despite REFER retransmission, and all four channels ending.
There is no target media proof in these cases because the target never answers.

The subscribed REFER returns `202`. With normal blind progress its terminal
sipfrag is `503`, despite the target's actual SIP `486`; with progress disabled
it is early `200` before target-channel creation. Without a subscription,
REFER returns `200` with `Refer-Sub: false` and no observed NOTIFY despite
the later target rejection. These results match the Local busy case but
add independent outbound SIP rejection evidence. They are fixture-specific,
not a universal SIP failure mapping or proof of target success from REFER
acceptance. Source dialog cleanup also succeeds in every case.

### Outbound PJSIP ringing timeout and CANCEL

Eight additional accepted-transfer cases have the synthetic PJSIP target
send `180 Ringing` without answering. They cover absent/false `Refer-Sub`
under both advertisement and blind-progress settings. The existing target
route has a five-second `Dial()` timeout after its two-second route delay.

The peer requires Asterisk to send CANCEL between 4.5 and seven seconds
after receiving the INVITE. CANCEL must match the INVITE Call-ID, CSeq number,
and Via transaction branch. The peer responds `200 OK` to CANCEL and
`487 Request Terminated` to the original INVITE, then verifies a matching
non-2xx ACK. It never sends an answer SDP or target media.

The outbound SIP Call-ID is independently correlated to its target PJSIP
channel through CEL. Each case requires no target ANSWER or BRIDGE_ENTER,
`DIALSTATUS=NOANSWER` on the original transferee, a target-channel CEL
lifetime between 4.5 and seven seconds, exactly one matching transfer and
target execution despite REFER retransmission, source dialog cleanup, and
all four correlated channels ending.

With normal blind progress, subscribed REFER returns `202`, emits active
sipfrag `180`, and ends with terminal `200` despite the verified no-answer
outcome and INVITE `487`. With progress disabled, terminal `200` arrives
before target-channel creation. No-subscription REFER returns `200` with
`Refer-Sub: false` and no observed NOTIFY despite the later timeout.
The success-shaped terminal result therefore also occurs with an actual
outbound PJSIP ringing target and the original Local peer running `Echo()`,
not only the earlier Local-target fixture retaining synthetic tones.
The precise frame/callback causing the result remains uninstrumented;
these observations are not a universal timeout mapping or target-success proof.

### Lost busy-target ACK recovery

Eight cases discard the first received ACK to the synthetic target's
`486 Busy Here`, covering absent/false `Refer-Sub` under both CLI-verified
advertisement/progress settings. Asterisk successfully sends that ACK;
the loss is injected at the target's receive boundary.

The target retransmits its byte-identical `486` after half a second, with
bounded exponential backoff until ACK. The recovered ACK must match the
discarded ACK's complete parsed request line, headers, and body, including
the original INVITE transaction branch and CSeq number. It must arrive
after the `486` retransmission and within two seconds of first ACK receipt.
Exactly one target INVITE must have been received.

All eight recovered in 0.502-0.548 seconds. Independent CEL still proves
BUSY, no target answer/bridge, one transfer, target execution, and outbound
channel, and all four channels ending. Existing REFER response,
retransmission, and progress assertions remain unchanged. Focused validation
also passed eight baseline busy cases and eight busy final-response-loss
cases across the same effective settings. The subsequent complete runner
passed all eight ACK-loss cases again, recovering in 0.502-0.535 seconds,
alongside all other REFER scenarios.

This tests Asterisk's ACK recovery against the synthetic peer's final-response
retransmission timer, not Asterisk's own UAS retry timer, internal send errors,
permanent ACK loss, transaction/reference destruction, or target media.

### Lost answered-target ACK recovery

Eight cases discard the first received ACK to the synthetic target's `200 OK`,
under absent/false `Refer-Sub` and both CLI-verified advertisement/progress
settings. The shared target ACK-loss fixture stores the complete final-response
bytes, including SDP, and retransmits them after half a second with bounded
backoff until ACK. Loss is injected after Asterisk sends the first ACK.

The recovered ACK must match the first ACK's complete parsed request line,
headers, and body, arrive after the response retry and within two seconds,
and leave exactly one received target INVITE. Unlike the non-2xx case, its
Via branch must differ from the INVITE branch; its Request-URI must match the
answered Contact and its To header must carry the target's dialog tag.

The 48-case focused matrix passed eight answered ACK-loss, eight busy ACK-loss,
16 final-response-loss, and 16 baseline answered/busy cases. A subsequent
eight-case rerun with the explicit branch-parameter comparison recovered in
0.502-0.567 seconds; each echoed 100/100 distinct post-transfer RTP payloads
and completed target-initiated BYE. Independent CEL verifies one transfer,
target execution, outbound target channel, answered target bridge, and all
four channels ending. Existing REFER progress/retransmission assertions pass.
The subsequent complete runner passed all eight answered ACK-loss cases
alongside the busy ACK-loss and existing regression matrices, recovering in
0.472-0.557 seconds; each again echoed 100/100 payloads.

This is bounded 2xx ACK recovery against the synthetic UAS timer, not internal
Asterisk send-error injection, its own UAS retry timer, permanent ACK loss,
transaction/reference destruction, or production-trunk interoperability.

### Two consecutive target ACK losses

Sixteen cases extend the shared target ACK-loss fixture to discard the first
two ACKs to answered `200 OK` or busy `486 Busy Here`. They cover absent/false
`Refer-Sub` under both CLI-verified advertisement/progress settings. The fixture
accepts a loss count of zero, one, or two and retains the existing single-loss
cases in the runner.

The target must receive three identical parsed ACKs and send exactly two
byte-identical final-response retries before recovery. Each repeated ACK must
follow a corresponding response retry. The first retry must be sent 0.45 to
under one second after first ACK receipt; the second must follow 0.95 to under
two seconds after the first retry. Total recovery must finish within three
seconds with exactly one received target INVITE. Existing non-2xx transaction
and 2xx Contact/dialog/branch assertions still apply.

All eight answered cases recovered in 1.505-1.632 seconds and all eight busy
cases in 1.506-1.540 seconds. Focused validation passed all 48 cases: 16 new
two-loss cases, 16 single-loss cases, and 16 baseline answered/busy transfers.
All 24 answered cases echoed 100/100 distinct post-transfer RTP payloads and
completed target-initiated BYE. Independent CEL still verifies one transfer,
target execution and outbound channel, the expected answered/bridged or
BUSY/unanswered outcome, and all four channels ending.
The subsequent complete runner passed all 16 two-loss cases alongside the
existing regressions. Answered recovery took 1.517-1.683 seconds and busy
recovery took 1.507-1.544 seconds. All 48 answered PJSIP-target cases in that
full run echoed 100/100 distinct payloads; all correlated cleanup assertions
passed and proof services stopped with persistent data preserved.

This establishes bounded recovery through two synthetic UAS retries, not
permanent ACK loss, Asterisk UAS timer behavior, internal send failures,
transaction/reference destruction, or production interoperability.

### Lost target BYE response recovery

Eight answered PJSIP-target cases discard the first received final `200 OK`
to the target-initiated BYE. They cover absent/false `Refer-Sub` under both
CLI-verified advertisement/progress settings. After proving post-transfer
media, the target sends BYE and retransmits the exact same request bytes,
including branch and CSeq. After discarding the first response it pauses
retries until the CEL observer has verified all four correlated channel ends,
then waits another half-second before retrying.

The recovered final response must match the discarded response's complete
parsed status line, headers, and body, match the BYE branch, Call-ID and CSeq,
and arrive after a request retry within two seconds of the peer observing
the channel-end signal. Recovery must be at least half a second after that
observation, and correlated CEL must remain unchanged through recovery.
Before this explicit ordering gate, all eight cases recovered in
0.500-0.534 seconds. The 40-case focused matrix
also passed eight cases each of baseline transfer, single-ACK loss,
two-consecutive-ACK loss, and final-INVITE-response loss. Every case echoed
100/100 distinct post-transfer RTP payloads before BYE.
The subsequent complete runner passed all eight BYE-response-loss cases
alongside the existing regressions, recovering in 0.502-0.543 seconds.
All 56 answered PJSIP-target cases in that run echoed 100/100 distinct
payloads; all correlated cleanup assertions passed and proof services
stopped with persistent data preserved.
After adding the channel-end gate, all eight cases passed again, recovering
0.502-0.503 seconds after observing the channel-end signal and 0.553-0.703
seconds after discarding the first response. Settled correlated CEL remained
unchanged. The 40-case focused run also passed eight cases each of baseline,
single-ACK loss, two-ACK loss, and final-INVITE-response loss; every case
echoed 100/100 distinct RTP payloads. The ten-second BYE exchange deadline
bounds both waiting for channel-end synchronization and response recovery.
The subsequent complete runner passed all eight ordering-gated cases alongside
all existing regressions, recovering 0.502-0.506 seconds after observing the
channel-end signal and 0.503-0.673 seconds after first response receipt.
Settled CEL remained unchanged in every gated case. All 56 answered PJSIP-target
cases echoed 100/100 distinct payloads, all correlated cleanup assertions
passed, and proof services stopped with persistent data preserved.

Existing CEL assertions independently verify one transfer, target execution,
outbound target channel, target answer/bridge, and all four channels ending.
This is bounded response recovery at the target receive boundary after call
teardown, not proof that SIP dialogs/transactions are destroyed at channel end,
internal send-error injection, transaction/reference destruction,
permanent BYE-response loss, or production-trunk interoperability.

### New BYE transaction after channel end

The eight ordering-gated BYE-loss cases now also send a new BYE with a fresh
Via branch and CSeq `2 BYE` after recovering the original CSeq `1 BYE` response.
The Call-ID, dialog tags and Request-URI remain unchanged. This distinguishes
a new request transaction from an identical retransmission of the original BYE.
The fixture sends that new request again and requires the complete parsed
final response to remain identical, with the new branch, Call-ID and CSeq.
Each response exchange has a two-second deadline and half-second request retries.

An initial `481` expectation failed: the pinned runtime returned `200 OK`.
All eight CLI-verified advertisement/progress/subscription combinations then
consistently returned `200` for the new transaction and its identical retry.
The 16-case focused run passed those eight extensions and eight baseline
answered transfers; every case echoed 100/100 distinct RTP payloads.
Correlated CEL remained unchanged through both original-response recovery
and the new BYE transaction/retry.

Pinned pjproject 2.17's
[disconnected-state handler](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-ua/sip_inv.c#L6241-L6273)
explicitly handles incoming BYE with `200 OK`. That is consistent with this
wire result, but the exact runtime dispatch path is not instrumented here.
Neither channel end nor a success response to a later BYE proves an active
media call, dialog destruction, transaction destruction, reference-count
cleanup, or the eventual response after all SIP retention timers expire.

### Lost outbound target CANCEL response recovery

Eight additional accepted-transfer cases withhold both responses that would
normally follow the ringing target's first CANCEL: CANCEL `200 OK` and the
original INVITE's `487 Request Terminated`. They cover absent/false
`Refer-Sub` under both advertisement and blind-progress settings. Active
ringing signaling and the five-second Dial timeout remain unchanged.

The peer records the first CANCEL without sending either response. Asterisk
must retransmit CANCEL within two seconds with the identical parsed request
line, complete headers (including branch, Call-ID, and CSeq), and body.
Only then does the peer send CANCEL `200` and INVITE `487` and require a
matching non-2xx ACK. All eight cases recovered after two identical CANCELs;
the first retry arrived 0.475-0.501 seconds after initial receipt.

Independent CEL still requires exactly one transfer, target execution,
and correlated outbound PJSIP channel, no target answer/bridge,
transferee `DIALSTATUS=NOANSWER`, and all four channels ending. REFER
retransmission and existing progress checks also pass: normal-progress
subscriptions report active `180` then terminal `200` despite NOANSWER,
disabled progress reports early `200`, and no-subscription REFER returns
`200` without observed NOTIFY. The target never answers or sends media.

Focused regression also passed all 24 baseline PJSIP answered, busy, and
timeout cases under both effective advertisement/progress settings and
absent/false `Refer-Sub`; answered cases echoed 100/100 RTP payloads.
The subsequent complete runner also passed all eight paired-response-loss
cases alongside the rest of the suite.
This models a withheld response pair at the synthetic target's send
boundary, not internal send failure, permanent cancellation-response loss,
independent loss of only one response, transaction/reference cleanup, or
production-trunk behavior.

### Isolated CANCEL 200 loss and transaction independence

Eight further cases withhold only the first CANCEL `200 OK`, while sending
INVITE `487 Request Terminated` immediately. They cover absent/false
`Refer-Sub` under both effective advertisement and blind-progress settings.
The peer must receive the matching non-2xx ACK **before** the next CANCEL:
completing the INVITE transaction must not prevent independent CANCEL retry.

The peer keeps its SIP socket open after ACK, requires a second CANCEL
with an identical parsed request line, complete headers, and body, and
answers that retry with `200` without resending INVITE `487`. The retry
must arrive within two seconds; all eight observed two identical CANCELs,
with the retry at 0.455-0.501 seconds. This ordering is explicitly asserted,
not inferred from a completed call or a final progress notification.

All cases independently verify `DIALSTATUS=NOANSWER`, no target answer or
bridge, one correlated transfer, target execution, and outbound channel,
existing REFER retransmission/progress results, and all four channels ending.
The eight paired-response-loss cases also passed again. These 16 focused
checks ran under CLI-verified settings. The subsequent complete runner also
passed this matrix alongside both other cancellation-response-loss matrices.

This proves bounded wire-level independence of the INVITE and CANCEL
transactions for one suppressed CANCEL response. It does not inspect their
internal state/refcounts, establish permanent CANCEL-response-loss cleanup,
or model loss of only INVITE `487`, internal send errors, or reliable transport.

### Isolated INVITE 487 loss after successful CANCEL

Eight complementary cases send CANCEL `200 OK` immediately but suppress
the first constructed INVITE `487 Request Terminated`. They cover
absent/false `Refer-Sub` under both CLI-verified advertisement/progress
settings. The peer schedules retransmission of the byte-identical `487`
after half a second without waiting for another CANCEL or INVITE.
Its bounded retransmission loop backs off until the matching non-2xx ACK
arrives; an ACK before the retransmitted `487` is sent fails the proof.

Each case requires the first `487` retransmission between 0.45 and two
seconds after CANCEL receipt. The peer continues receiving for one second
after ACK and requires exactly one CANCEL throughout the observation.
This checks that receiving CANCEL `200` stops CANCEL retries while the
original INVITE still needs its own final response and ACK.

Independent CEL and REFER assertions remain unchanged: target NOANSWER,
no target answer/bridge, one transfer, target execution, and outbound
channel, all four channels ending, and expected progress signaling including
terminal `200` despite timeout. Focused validation includes these eight
cases, eight baseline PJSIP timeouts, and both earlier cancellation-loss
matrices (16 cases). The subsequent complete runner passed all these cases
alongside the rejection, transfer, preservation, and notification-loss cases.

This is bounded wire-level recovery driven by the synthetic peer's `487`
retransmission timer. It does not prove Asterisk's own UAS retransmission
timer implementation, indefinite absence of CANCEL retries, internal
transaction/refcount destruction, permanent `487` loss, or send failures.

### Lost outbound target INVITE response recovery

Sixteen additional accepted-transfer cases discard the synthetic target's
first constructed final INVITE response: eight answered `200 OK` cases and
eight `486 Busy Here` cases, covering absent/false `Refer-Sub` under both
advertisement and blind-progress settings. The peer does not send that first
response or a provisional response. This models a missing target response
at the peer's send boundary; it does not inject a socket-send error.

Asterisk must retry the INVITE within two seconds. The complete parsed
request line, headers (including Via branch, Call-ID, and CSeq), and SDP body
must match the original. The peer then constructs the response again,
requires byte-for-byte equality with the discarded final response, sends
it, and requires the matching ACK. This specifically tests INVITE request
retransmission while no response has arrived, not a target's autonomous
2xx retransmission after an ACK is lost.

All 16 cases recovered after two identical INVITEs in the verified run,
with the first retry 0.467-0.515 seconds after initial receipt.

The answered cases independently prove the original transferee/target
bridge, post-transfer RTP echo, and target BYE. The busy cases prove actual
target `486`, a matching non-2xx transaction ACK, no target answer/bridge,
and transferee `DIALSTATUS=BUSY`. All cases retain one correlated transfer,
target execution, and outbound target channel, pass the existing REFER
retransmission/progress checks, and end all four channels.

The expected REFER results remain unchanged: subscribed `202`, terminal
`200` for answered targets and normal-progress `503` for busy targets, or
early terminal `200` with progress disabled. No-subscription REFER is `200`
with `Refer-Sub: false` and no observed NOTIFY regardless of later target
success or failure. These are bounded synthetic UDP recovery checks, not
permanent target-response loss, reliable transport, production-trunk
interoperability, internal send-failure ordering, or transaction/refcount proof.

### Lost final REFER response recovery

The same runner adds 16 controlled response-loss cases: an unknown target
and an answered synthetic PJSIP target, each with absent/false `Refer-Sub`
under both advertisement and blind-progress settings. The client deliberately
discards the first matching final REFER response rather than returning it
to the scenario. It retains that parsed response only for comparison and
continues the existing half-second retransmission schedule with the identical
request bytes, branch, and CSeq. NOTIFY and BYE handling remain active.

Every case recovered after exactly two request transmissions in the verified
run. The recovered status, complete parsed header map, and body must equal
the discarded response; a second response before request retransmission or
failure to recover within the five-second exchange deadline fails the test.
Another explicit same-key retransmission is still checked afterward.

The eight unknown-target cases additionally verify original bridge/channel
preservation, ten fresh inbound RTP packets, the expected subscription
outcome, successful BYE, and all three original channels ending. The eight
accepted cases verify exactly one target execution and `BLINDTRANSFER`,
one correlated outbound PJSIP dialog and answered bridge, post-transfer RTP
echo (100/100 distinct payloads in all eight cases), and all four channels
ending.

This injects application-visible loss at the test client's receive boundary.
Asterisk successfully sent the discarded datagram. It does **not** inject
an internal response-helper/transport-send error, prove response-send versus
transfer-enqueue ordering, measure transaction reference lifetimes, or cover
permanent loss, reliable transport, or production network behavior.

### Terminal NOTIFY acknowledgement-loss recovery

Eight additional subscribed cases withhold the first terminal NOTIFY's
`200 OK`: an unknown target and an answered synthetic PJSIP target under
both advertisement and blind-progress settings. Active progress NOTIFYs
are acknowledged normally. The first terminal result is validated and
recorded, but its response is deliberately not sent. A subsequent terminal
request must have the identical request line, complete parsed header map
(including Via branch and CSeq), and sipfrag body before it is acknowledged.
The test explicitly waits for that acknowledgement, rather than treating
the first received terminal result as recovery.

All eight cases observed and acknowledged an identical retry within
0.460-0.502 seconds of first receipt in the verified run; recovery must
complete within five seconds of the scenario's wait. The four rejected
transfers still preserve the original bridge and ten fresh inbound RTP
packets, then end all three channels after BYE. The four accepted transfers
still create exactly one correlated transfer, target execution, and answered
outbound PJSIP dialog, echo 100/100 distinct post-transfer RTP payloads, and
end all four channels. Retransmitted terminal notifications remain one
logical result keyed by NOTIFY CSeq.

This establishes bounded UDP terminal-notification retry after a deliberately
withheld peer acknowledgement. It does not establish permanent-loss timeout
cleanup, subscription/transaction reference lifetimes, reliable-transport
behavior, or failure of an internal Asterisk send operation.

### Permanently withheld terminal NOTIFY acknowledgements

Eight further subscribed cases never acknowledge a terminal NOTIFY, covering
an unknown target and an answered synthetic PJSIP target under both
advertisement/progress settings. Active progress requests and BYE are still
acknowledged. Every terminal retry must match the original parsed request
line, complete header map (including branch and CSeq), and body.

The source SIP socket remains open for 40 seconds from first terminal
receipt, including after the source dialog and all correlated channels have
ended. Each case requires at least six identical terminal requests, the last
receipt between 20 and 35 seconds, and at least five seconds of final
silence. The verified cases observed 11 identical requests each, with the
last approximately 31.5 seconds after the first. These are receive-boundary
timings on this pinned UDP fixture, not exact internal timer measurements.

Before that observation completes, the unknown-target cases prove original
bridge preservation and ten fresh inbound RTP packets, then successful
client BYE and all three channels ending. The accepted cases independently
prove one transfer/target execution, one answered outbound PJSIP dialog,
post-transfer RTP echo, and all four channels ending. The complete correlated
CEL rows must remain unchanged throughout the remaining retry observation:
no delayed channel or transfer work may appear after the channels settle.

This establishes bounded retry cessation on the wire and channel cleanup
despite permanently withheld terminal acknowledgements. It does not inspect
subscription objects, PJSIP transaction state, reference counts, or timeout
callbacks, and therefore does not prove their destruction or leak freedom.
It also does not cover permanent REFER-response loss, internal send errors,
reliable transport, or indefinite absence of later traffic.

### REFER investigation stopping point

The current synthetic REFER matrix is frozen for this development round.
The final complete run passed 106 rejection/policy dialogs, 144 accepted
transfers (24 Local-target and 120 PJSIP-target), 24 preservation dialogs,
six additional sequencing attempts, and all eight post-channel-end new-BYE
extensions. All 56 answered PJSIP-target cases echoed 100/100 distinct RTP
payloads. Counts were checked against runner output; all correlated cleanup
assertions passed and proof services stopped with persistent data preserved.

Do not add further REFER permutations or rerun this full suite automatically
as the next development increment. Retain the tests as a regression baseline;
rerun relevant coverage when related code changes or a concrete defect requires it.
Reopening exploratory scope requires an explicit decision.

Deferred, not completed:

- Instrument the exact cause of success-shaped no-answer terminal notifications.
- Measure permanent-loss behavior and internal SIP transaction/dialog/reference
  lifetimes; wire silence and channel cleanup are not destruction evidence.
- Inject internal response-creation and transport-send failures.

Real dispatch/trunk interoperability, production TLS/SRTP, capacity and deployment
remain separate acceptance gates. This freeze is not production approval.
The next functional priority is the existing
[management and roaming-agent vertical slice](./PROJECT-PLAN.md#15-delivery-sequence-and-next-planning-work),
followed by a simulated booking connector before real Autocab integration.

## Browser WSS and encrypted WebRTC proof

Additional prerequisites: Node.js 24, npm, and Docker Compose 2.24.4+ (network
override support). From PowerShell 7:

```powershell
npm ci
npx playwright install chromium
.\scripts\Test-WebRtcProof.ps1
```

The runner creates two-day self-signed localhost certificates and fresh per-customer
credentials under ignored `.local-proof\webrtc`. It does not change Windows trust.
Only the dedicated test Chromium process exempts the exact generated public-key
pins from normal certificate verification. This is not publicly trusted PKI or a
recommendation to bypass certificate verification in the actual agent console.

The optional `compose.webrtc-proof.yaml` replaces the internal-only networks with
separate bridge networks so Docker can publish host-loopback ports:

| Customer | WSS on host loopback | UDP media on host loopback |
|---|---|---|
| A | 18089 | 10000-10019 |
| B | 28089 | 10100-10119 |

These bridge networks can have outbound connectivity. They are not the base
fixture's internal-only networks or a production firewall policy. No ports are
deliberately published on LAN/public addresses. Do not use this local ICE mapping
for cloud deployment.

The script inspects container addresses and creates explicit ICE host mappings to
127.0.0.1, then restarts the PBXs. Each test browser registers with SIP.js over WSS,
calls the echo route, and requires at least 70 sent and received audio packets,
non-zero received audio energy, connected DTLS, and a negotiated SRTP cipher.
It then ends the call and unregisters.

Synthetic microphone input and autoplay permission are enabled in the dedicated
headless browser. mDNS candidate hiding is disabled there because the Docker/WSL
proof otherwise stalled media negotiation. This does not change the user's normal
browser, but it leaves default-browser ICE, TURN, real microphone permissions,
autoplay interaction, and remote-network calling as separate required tests.
No actual microphone is captured. A real agent console is not implemented.

The browser HTTPS server and test browser are closed, and both proof PBXs are
stopped in cleanup, including on test failure. Docker Desktop and unrelated
containers are left running. All three proof modes use the same PBX service names;
do not run them concurrently. Each mode may recreate or restart those services.

Validated on 22 October 2026: both customers passed WSS registration, two-way
synthetic browser media, non-zero decoded energy, and DTLS-SRTP negotiation using
Playwright Chromium. This is not a human listening test, complete audio quality
assessment, tenant-isolation certification, or a capacity benchmark.

## Engineering packet-evidence proof

```powershell
.\scripts\Test-CaptureProof.ps1
```

This runs the SIP proof, builds a local diagnostics image containing tcpdump and
tshark, then activates a 15-second capture in each customer's own network namespace.
It generates new synthetic test calls, snapshots CEL, and creates an incident
directory under ignored `.local-proof\evidence`. The runner stops its PBXs and
collectors and removes the collector containers during cleanup. Do not run proof
modes concurrently.

The collectors have only `NET_RAW` capability, a read-only root filesystem, one
customer-specific writable evidence mount, and no Docker socket or host network.
They run as container root with other capabilities dropped; this is a local
operator fixture, not an authenticated production capture service.

Capture is fixed to non-promiscuous `eth0`, full-snaplen UDP port 5060 signalling.
It does not capture RTP audio, other interfaces, TCP reassembly, or decrypted
TLS/WSS. Collection stops after 15 seconds or a sampled 1-MiB soft size threshold.
The 20-ms polling and buffered writes can overshoot that threshold; hard disk
quotas and the size-trigger path have not been validated. The duration path has.
Unexpected collector failure is an error, not an empty successful report.

Each customer evidence directory contains:

- `signalling.pcap`: original raw packet evidence, including sensitive SIP digest
  authentication material. Never send this to third parties automatically.
- `capture.stderr`: collector diagnostics and loss counters.
- `manifest.json`: incident/customer, capture scope, UTC times, limits, stop reason,
  kernel-drop count, tool version, and original PCAP SHA-256.
- `cel.csv`: a restricted local snapshot of that customer's call events.
- `report.html`: a printable signalling table/ladder and explicit CEL correlations.
- `export-manifest.json`: hashes of packet evidence, CEL, and generated report.

The synthetic echo route emits `PROOF_SIP_DIALOG` containing the received Call-ID.
Report correlation uses that exact value, not temporal proximity. Report output
uses allowlisted fields and pseudonymised endpoint/dialog/channel identifiers,
excluding raw SIP, SDP, authentication headers, names, and raw call identifiers.
It includes no attachments or externally loaded resources. A fixed embedded
script enables dialog/message filters, expandable packet provenance, visible
counts, and reset/empty states. A hash-based Content Security Policy allows only
the bundled script/style and blocks network connections. Packet data never
becomes executable code. Raw evidence remains separately
restricted; hashes detect modification but do not make files immutable.

Validated locally on 22 October 2026: three captured SIP dialogs per customer,
one explicitly correlated accepted call per customer, duration-limit shutdown,
zero reported kernel drops, original hash verification, and readable HTML output.
Five unit tests cover whitelist redaction, missing correlation, incomplete
synthetic call evidence, unsupported input, and HTML escaping of incident metadata.
The capture runner also executes Playwright tests on each generated report:
dialog/message filtering, expanded details, no matches/reset, complete printing
despite active filters, no-JavaScript fallback, and no external requests.

For these browser checks, install the declared npm dependencies and Chromium
using the WebRTC prerequisites above. A report can be rechecked independently:

```powershell
node .\tests\diagnostics\report-ui.mjs "C:\absolute\path\to\report.html"
```

The report's challenge/BYE counts are observed-message counts, not diagnoses.
Retransmissions may contribute to those counts. A 401 can be normal authentication;
a BYE alone does not prove every dialog completed successfully.

Run those tests without network access:

```powershell
docker run --rm --network none --user 1000:999 --cap-drop ALL `
  --entrypoint python3 `
  --mount "type=bind,source=$((Get-Location).Path),target=/work,readonly" `
  -w /work asterisk-local-diagnostics:proof `
  -B -m unittest discover -s tests -p test_diagnostic_report.py
```

This is not the full engineering workspace: cross-incident search/raw-message
inspection, manual/automatic incident controls, audit/authorisation, encrypted
application signalling ingestion, AI diagnosis, PDF export, retention, immutable
storage, and arbitrary-customer-data redaction remain to implement.
No trace data is sent to AI. Do not use this fixture with real caller data.

The base Asterisk digest is fixed, but diagnostics packages currently come from
Debian repositories at build time. Package locking, minimal production packaging,
and dependency review remain deployment gates.

## Customer-scoped access boundary

The initial TypeScript backend foundation validates signed OIDC-style access
tokens using JOSE and a configured JWKS endpoint, then checks provisioned
issuer/subject/customer memberships. A signed `roles` or `customer` claim is not
permission to access another customer.

```powershell
npm ci
npm run typecheck
npm run test:access
```

The integration tests run an ephemeral loopback JWKS issuer and HTTP API and close
them afterward. They use generated RSA signing keys in memory, not production
credentials or real user identities. No services remain running.

The base permission resource is `GET /api/customers/{customer}/diagnostics`.
It reports whether an incident catalog is configured; capture and raw evidence
serving remain disabled. The optional incident resources are described below.

Access checks require RS256 signature, exact configured issuer/audience, subject,
issued-at and expiry claims, and a maximum 15-minute token age. Production identity
URLs require HTTPS; a deliberate test-only option permits loopback HTTP.
Configure the API's own ingress TLS before exposing it; the server factory itself
does not terminate TLS and has no production executable/listener yet.

Support grants require a customer, bounded start/expiry interval, recorded reason,
and contract reference. Active grants authorise diagnostic metadata only; playback,
exports, raw packets, and configuration changes are not implicitly permitted.
An application must separately authorise grant creation and persist/revoke grants;
this initial configuration-backed verifier is not that workflow.

Every evaluated access decision awaits an audit sink. If audit persistence fails,
access returns an explicit 503 and invokes the operational error logger. Tokens
are not written to audit records. The unit fixture uses an in-memory sink; the
real identity proof uses the SQLite adapter described below. Production audit
operations, access reviews, and retention remain unimplemented.

Automated tests cover customer separation, misleading token role claims,
invalid/missing/expired/future/wrong-signature/issuer/audience tokens, required
expiry, bounded support elevation, audit failure, unavailable JWKS, configuration
mutation, and absence of capture mutation routes.

This is an access-control foundation, **not** completed Keycloak integration,
interactive OIDC login, MFA, SAML/Entra federation, session handling, or production
authorisation. JWTs already verified with cached keys can remain usable until
expiry; immediate account/grant revocation and signing-key rotation require
additional lifecycle design and tests.

## Real Keycloak browser-login proof

With Docker, PowerShell 7, Node.js 24, npm dependencies, and Playwright Chromium
installed as above:

```powershell
.\scripts\Test-CaptureProof.ps1 # Generate synthetic reports first, if absent
.\scripts\Test-IdentityProof.ps1
```

This uses Keycloak 26.8.1 pinned by image digest, in a separate Compose project.
The runner generates two synthetic users with different customer memberships and
random credentials under ignored `.local-proof\identity`. The imported realm,
including plaintext test passwords, must stay private; it is not an export
template for real users. Access/ID tokens and signing private keys are not exported.

Keycloak binds only host loopback port 18080; an ephemeral API listener and callback
on loopback 18765 exist for the original browser test. The server-session proof
also uses loopback 18766. If ports are occupied, the proof
must fail rather than repurpose another service. It does not require a bootstrap
administrator account or expose a management console with default credentials.

The original public client permits authorization-code login with S256 PKCE and one exact
callback URL. A separate confidential client is used for the server-session proof
below, with its own exact callback and generated ignored client secret.
Password grants, service accounts, registration, and password reset
are disabled in this synthetic fixture. The API audience mapper applies to access
tokens, not ID tokens.

Verified locally:

- Missing PKCE and an unapproved redirect URI are rejected.
- Both users sign in through the real Keycloak browser form.
- Callback state is checked and a signed ID token's nonce/subject is verified.
- Authorization code is exchanged with its verifier; consumed code replay fails.
- Real access tokens allow the provisioned customer and deny the other customer.
- ID tokens fail API audience validation.
- Password-grant requests fail; API decisions are committed to local SQLite.

The runner closes browsers/HTTP listeners and removes the identity container and
its project network even after failure. Its development database is ephemeral;
the next run imports fresh users. Generated files remain ignored locally.
No Asterisk services need to run for this proof.

**Not production identity:** development mode, loopback HTTP, one test realm,
local-only audit, and configuration-backed membership are deliberate limitations.
Deployment TLS, production database/backup, administrator recovery, secure
production application sessions, MFA, federation, global logout/revocation, key rotation, customer
onboarding, and grant administration remain outstanding. Passing this proof does
not make the management application available or enable capture controls.

## Permission-controlled incident catalog and reports

The API factory optionally accepts a provisioned incident catalog:

| Resource | Required permission |
|---|---|
| `GET /api/customers/{customer}/diagnostics/incidents` | `diagnostics:read` |
| `GET /api/customers/{customer}/diagnostics/incidents/{incident}/report` | `diagnostics:report` |

Incident IDs must match `incident-` followed by 32 lowercase hexadecimal characters.
Metadata access, including diagnostic-only support grants, does not imply report
access. Every successful response waits for the access audit sink. Failure of
audit persistence prevents report delivery. Cross-customer report guesses are
denied, and unknown incidents within an authorised scope return 404.

The catalog interface supports an immutable in-memory snapshot or the local
SQLite adapter below, both provisioned with trusted, approved entries. Neither
is an arbitrary directory browser. Lists return only ID,
title, and creation time. Approved report bytes must match their supplied SHA-256
and fit a 2-MiB size limit. A checksum verifies consistency, not redaction quality
or HTML safety; trusted ingestion must approve the actual report. No HTTP route
imports files or accepts a path from the caller.

HTML reports are served without caching, with a sandboxed Content Security Policy
that does not grant same-origin privileges, blocks network access and forms, and
disallows embedding. The report's own hash-based policy further restricts its
fixed interactive script. Raw PCAP, CEL, manifests, and filesystem paths have no
API resource. Report delivery is a distinct disclosure permission, not a general
right to export all engineering evidence.

The real Keycloak proof now requires captured reports for both customers:

```powershell
.\scripts\Test-CaptureProof.ps1
.\scripts\Test-IdentityProof.ps1
```

The test chooses the latest incident with both export manifests, verifies customer
and incident provenance, and loads the report hashes through the catalog. Missing
or tampered reports fail explicitly. It does not publish the evidence directory.
Alice receives report permission for customer A; Bob has metadata-only access to
customer B. Both can list their own captured incident. Alice can view and filter
her report in Chromium, with sandboxed origin storage denied; Bob cannot view
his report, and neither can access the other customer. Twenty-two API decisions
are audited in the successful identity test.

Twenty access tests cover the original authentication boundary plus incident
metadata, report permission, report/audit failure, unavailable catalogs, tampering,
path-like raw-file requests, and response restrictions.

Outstanding: production storage/backup and ingestion approval, audit operations,
production application session operations, customer/engineer navigation,
grant administration, and authenticated capture controls. Reports are exercised
through test-controlled browser credentials, not a finished user-facing viewer.

## Persistent diagnostic storage proof

`openDiagnosticStore` in [src/diagnostic-store.ts](./src/diagnostic-store.ts)
provides a local SQLite catalog and audit sink using Node 24's built-in,
currently experimental `node:sqlite` module. No database package or service is
added. This is a local adapter evaluation, not a production database selection.

- A trusted absolute database path and an existing, private parent directory are
  required. Do not use shared directories, network filesystems, or caller paths.
  The operator must enforce filesystem ACLs and encryption; this adapter does
  not provision them or encrypt the database.
- Schema version 2 contains customer-keyed published incidents, staged candidate
  snapshots, review receipts, and allowlisted access-audit columns. Unknown
  versions, corrupt files, and nonempty unversioned databases fail explicitly.
  The version-1 migration and its disclosure change are described below.
- `stage` validates and stores a whole candidate batch atomically, without
  publishing it. `review` records approval or rejection of an exact snapshot.
  Existing customer/incident keys cannot be overwritten. These are trusted code
  operations, not HTTP uploads or an automated approval workflow.
- Report hashes and customer/incident provenance are checked again on reads.
  Malformed or tampered entries cause an explicit 503, not empty successful lists.
  Catalog errors are logged and audited when audit storage remains writable.
- Each audit insert commits with `synchronous=FULL` and rollback journalling
  before its promise resolves. Duplicate request IDs, unavailable storage, or
  contention beyond the 250-ms busy timeout reject the write and block delivery.
  Records contain no request headers, tokens, report HTML, or arbitrary extra fields.
- The API still accepts the catalog and audit callback separately; deployment
  code must explicitly wire both from the opened store and close it on shutdown.

```powershell
npm run typecheck
node --test .\tests\access.test.ts .\tests\diagnostic-store.test.ts
```

Fourteen storage tests cover close/reopen persistence, customer isolation, atomic
imports, integrity failures, committed audit visibility, lock/closed-store failures,
invalid databases, staged approvals, migration, and the backup/restore failures below.
The access suite additionally proves that a real database
write lock prevents report bytes being served. The Keycloak proof imports both
synthetic reports, closes/reopens their database before login, and independently
reads back all twenty-two committed access decisions. It also backs up and restores
both captured reports and compares every restored audit, candidate, and review
column. Its temporary SQLite files
are removed after the test; normal adapter databases persist until explicitly
removed by their operator.

Limitations: synchronous operations can block the event loop, metadata listing
currently validates full stored reports, and no paging, retention/deletion,
off-host append-only audit, tamper-evident audit chain, off-host disaster recovery,
multi-process load, or power-loss test exists. A matching hash is not independent
approval evidence if an attacker can rewrite the database and hash together.
Filesystem administrators can alter both evidence and audit; do not treat this
proof as an immutable third-party evidence archive.

### Local diagnostic backup and separate restore

[src/diagnostic-backup.ts](./src/diagnostic-backup.ts) provides two trusted
operator functions, not HTTP resources:

1. `backupDiagnosticStore(sourcePath, parentDirectory)` opens an existing database
   read-only and uses SQLite's online backup API, not a filesystem copy of a live
   database. It returns a newly generated backup directory containing
   `diagnostics.sqlite` and `manifest.json`.
2. `restoreDiagnosticStore(backupDirectory, parentDirectory)` returns the database
   path inside a newly generated, separate restore directory. It never restores
   over the source or an existing application database.

All arguments must be absolute paths in operator-controlled local directories.
The parent directory must already exist and have appropriate private ACLs.
The backup contains **every customer's approved, pending and rejected report,
review receipts, and audit history** in that database; it is not a customer export.
No raw capture files, credentials,
membership configuration, or identity-provider database are included.

The manifest records format version, creation time, database SHA-256, incident
count, and audit count; version 2 also records candidate and review counts.
Backup validation checks SQLite integrity, schema version, required columns,
report hashes, incident/customer provenance, and approval/publication consistency.
Restore copies
into its new directory, checks that exact copy against the manifest, then repeats
database/content validation and verifies counts before returning success.
Failures remove only the newly allocated output directory and propagate the error.
Missing database/manifest files never become empty successful restores.

The automated recovery test takes a backup with the source store still open,
adds a later audit event, removes the closed original database, and restores
reports plus the exact pre-backup audit history. It verifies customer separation,
new audit writes on the restored store, and a second independent restore without
overwriting the first. Negative tests cover incomplete files, malformed manifests,
count/checksum mismatch, invalid reports even with a recomputed database checksum,
unsupported schemas, and missing sources. Run `npm run test:storage` for this proof.
The real Keycloak proof additionally verifies backup/restore of generated packet
reports and its twenty-two access decisions.

Backups are point-in-time copies, so later events require a later backup. The
manifest is a consistency check, not a signature or independent approval record.
Do not promote a restored copy into service until separately checking deployment
identity, permissions, storage protection, and application configuration.
Scheduling, encryption/key custody, off-host copies, retention, restore promotion,
large-database/concurrent-write load, interrupted-process/power-loss recovery,
and full PBX/recording/identity disaster recovery remain unverified. The backup
directory and manifest are not claimed to be crash-atomically published.

### Staged report review

The persistent adapter no longer has a direct `importApproved` operation.
Merely placing evidence on disk, staging it, or knowing its hash does not publish
it. Its local workflow is:

1. A trusted importer validates customer/incident provenance and report content,
   then calls `stage(entries)`. Each new candidate has a generated ID and a SHA-256
   binding its complete stored customer/metadata/report snapshot.
2. An authorised operator uses `pending(customer)` and `candidate(id)` to inspect
   the candidate. These methods return sensitive, **unapproved** content and are
   not connected to HTTP resources or the public incident catalog. Candidate HTML
   must not be rendered as trusted application HTML.
3. After actually reviewing scope, redaction and suitability for disclosure, the
   operator calls `review(id, { decision, reviewer, reason, sha256 })` with
   `decision` set to `approve` or `reject`. A nonempty reviewer/reason and the
   exact reviewed snapshot hash are required.
4. Approval publishes that exact snapshot in the same transaction as its review
   receipt. Rejection records the decision without publishing anything. Failed
   receipt or publication writes roll back both. Decisions are one-shot: this
   proof has no overwrite, corrected resubmission, revocation, or reapproval path.

Pending/rejected candidates are absent from customer incident lists; their report
routes return 404 even to a permitted report reader. Published reads verify the
snapshot against its candidate and approval receipt. Receipt deletion or mismatch
fails explicitly rather than bypassing approval. Read/report permissions do not
expose the operator staging/review methods.

**Trust boundary:** these store methods remain privileged in-process functions.
Direct callers must authenticate the operator and enforce customer-scoped approval
permission; a directly supplied reviewer string is not verified identity. The
authenticated API below provides that boundary for HTTP requests. The Keycloak
test exercises authenticated browser approval of known synthetic fixtures; it does
not certify real redaction or provide a production application/session flow.
The separate in-memory catalog still accepts trusted, already-approved entries;
it is not the persistent ingestion workflow.

**Version-1 migration:** opening a version-1 database transactionally moves its
legacy published entries to pending candidates and clears their published copies,
while preserving access-audit records. Legacy reports consequently disappear
from customer listings until explicitly reviewed. It does not fabricate reviewers
or approvals. Back up before opening an older database. Version-1 backups can
still be validated/restored separately; opening the restored database performs
the same migration. Version-2 backups retain pending/rejected state and validate
approval receipts as well as the published reports.

Tests cover hidden pending/rejected reports, hash-bound review, missing reviewer
or reason, duplicate decisions, transaction rollback, receipt tampering,
version-1 migration, and review-state recovery. Approval receipts are local
records, not signatures or a tamper-proof external audit trail. Production
reviewer provisioning/revocation, rejection correction, approval revocation, production review UI,
and retention remain outstanding.

### Authenticated review API proof

The API factory's optional fifth argument is a review store exposing `pending`,
`candidate`, `review`, and `history` from the opened diagnostic store. It is deliberately
separate from the public incident catalog; no staging/upload endpoint exists.
All review routes require the explicit provisioned **`diagnostics:review`**
permission for the customer in the path:

| Resource | Result |
|---|---|
| `GET /api/customers/{customer}/diagnostics/reviews` | Pending candidate IDs, snapshot hashes and allowlisted summaries |
| `GET /api/customers/{customer}/diagnostics/reviews/{candidate}` | Candidate metadata, snapshot hash, and unapproved report as JSON |
| `POST /api/customers/{customer}/diagnostics/reviews/{candidate}` | Approve or reject the exact candidate |
| `GET /api/customers/{customer}/diagnostics/reviews/history` | At most 50 recent recorded decisions, newest first |
| `GET /api/customers/{customer}/diagnostics/reviews/history/{candidate}` | Exact recorded outcome for a candidate, including older decisions |

Candidate IDs are generated UUIDs. A candidate belonging to another customer
returns 404 within an authorised customer scope; trying an unauthorised customer
path returns 403. Metadata/report permissions, token roles, and diagnostic-only
support grants do not imply review authority. Conversely, review permission does
not grant the published-report route.

A decision body contains exactly `decision` (`approve` or `reject`), nonblank
`reason` (at most 2,000 characters), and the candidate's `sha256`. Reviewer identity
is taken from the verified access-token subject; a caller-supplied `reviewer` or
other extra field is rejected. The endpoint requires JSON, accepts at most 8,192
body bytes, rejects encoded bodies, and limits body receipt to five seconds.
Invalid input returns 400/413/415/408 as appropriate; stale hashes or already
decided candidates return 409. No silent overwrite or success-shaped retry exists.

Candidate content is returned as `application/json` with no-store, nosniff and a
restrictive CSP, not as rendered unapproved HTML. Clients must keep it inert or
use a separately sandboxed preview. Successful list/candidate responses await the
configured audit sink. Successful decisions instead commit their access audit,
review receipt and publication together through the same SQLite transaction.
The deployment must wire the real store for review, not an adapter that ignores
the transactional access-audit argument. The ordinary audit callback handles
denials and invalid/conflicting requests; it is not called again after the store
has already committed a successful decision audit.

History reads also await the configured audit sink (`review-history` operation);
storage/integrity/audit failures return an explicit 503 without history data.
History routes accept GET only. Responses contain `{ requestId, reviews, truncated }`.
Each review contains only candidate `id`, snapshot `sha256`, allowlisted incident
`summary`, `decision`, `reviewer`, `reason`, and `decidedAt`; report HTML and raw
evidence are never returned. Stored snapshot provenance/hash and receipt fields
are validated before disclosure. No database migration is needed.

Recent history uses descending decision time with candidate-ID tie-breaks and
sets `truncated: true` when more than 50 decisions exist. Exact lookup is independent
of that limit. It returns an empty array for pending, unknown or other-customer
candidate IDs within an authorised scope, without distinguishing them. Empty
results are not proof that a submission failed or that retrying is safe: an
in-flight decision can commit after the read. History records decisions, not a
new guarantee of current publication availability, and remains subject to the
existing database-administrator tampering limitations.

Tests verify customer separation, permission separation, reviewer spoof rejection,
exact byte boundaries, body timeout, conflicting decisions, and rollback when
either decision audit or publication fails. The real Keycloak proof leaves Alice's
captured report pending across database reopen, then uses her access token to
inspect and approve it; the receipt records her actual subject. Bob's metadata-only
token cannot review. All twenty-two decisions and review receipts survive backup/restore.

This remains a loopback server-factory proof with configuration-backed grants.
The optional server-session layer below adds browser cookie authentication and
CSRF-protected mutation requests. Production ingress/rate limits, approval
revocation, and live grant administration remain absent. Use TLS and complete
session operations before exposing it to real operators.

### Browser engineering-review workspace proof

The API now serves a static shell at `/engineering/reviews/{customer}`, with
fixed JavaScript/CSS resources and a restrictive same-origin CSP. The shell is
public but contains no evidence or token and makes no API requests by itself.
An unrecognised customer name in this shell URL does not grant access: every
evidence request still passes the existing customer/review-permission checks.

The browser module [src/review-workspace.js](./src/review-workspace.js) exposes
`connectReviewWorkspace(accessToken)` for the original bearer-based test and
`connectReviewWorkspace({ csrf })` for the server-session adapter below.
The original Keycloak test supplies its freshly verified access token in memory.
There is deliberately no token entry box, URL token, browser-storage token,
embedded credential, or implicit cookie authentication. The returned disconnect
function aborts pending requests, clears the connection token and removes
evidence from the workspace; reconnecting first disconnects the old connection.
This adapter hook is **not** an end-user login/logout implementation.

The workspace lists pending candidate IDs, loads a selected snapshot, and shows
customer, incident, title, creation time and snapshot hash. It provides the
restricted rendered preview described below plus the exact original HTML through
`textContent` in a collapsible source view. Raw source is never inserted into a
live document or frame. Approved interactive reports remain a separate
permission-controlled route.

Pending reports are displayed as individual cards with title, incident ID,
creation time, candidate ID and snapshot SHA-256, so engineers can identify
evidence before opening it. The review-list API adds an allowlisted `summary`
object (`id`, `title`, `createdAt`) to each candidate reference, derived from the
integrity-checked stored snapshot. It does not return report HTML, arbitrary
snapshot fields or another customer's metadata. The existing review permission
and audit-before-delivery checks still apply. Titles are inserted as text, not
HTML. Opening a candidate checks that its metadata and hash agree with the list;
malformed or changed metadata produces an explicit error and no decision
controls. Existing candidate-ID ordering is unchanged; paging and assignment
remain future work.

**Filter pending reports** applies a trimmed, case-insensitive literal substring
to loaded report titles, incident IDs and candidate IDs. Its count explicitly
shows visible versus loaded candidates; a no-match result is not an empty queue.
**Clear pending filter** restores the full loaded list. Filtering makes no network
request, loads no report content, and sends or persists no filter text. The
200-character filter is retained across list refresh and decisions within the
current connection, but cleared when that connection closes. Filtering does not
close or change the open candidate, review reason, evidence search or approval
hash. The controls are unavailable during requests and hidden until a valid list
has loaded. This is a local convenience, not server-side search or pagination.

**Sort pending reports** offers candidate-ID order (the unchanged default),
oldest-created first and newest-created first. Creation-time ordering compares
parsed instants, including timezone offsets, with ascending candidate ID as a
deterministic tie-breaker. It orders loaded cards only, combines with the current
filter and does not request evidence or change an open review. The chosen order
survives refresh/decisions within the connection but resets on reconnection;
neither it nor the filter is stored in browser storage. Sorting is by incident
creation time, not staging time or urgency. The visible/loaded status announces
the active order, and clearing the filter does not reset it.

**Close review without deciding** removes the selected report's frame, original
source, evidence-search controls, reason and scope check from the workspace.
It sends no request or decision and leaves the candidate pending; list metadata,
filter and ordering remain available. Focus returns to the pending filter.
If any reason text or scope confirmation has been entered, a separate discard
dialog requires **Discard and close**; Cancel or Escape preserves the local
review. Reopening fetches the candidate again and starts with an empty reason
and unchecked scope confirmation. This is screen cleanup, not secure memory
erasure, logout, or a persisted draft workflow.

Refreshing the pending list or opening any candidate (including reopening the
same candidate) uses the same discard protection when a reason or scope check
has been entered. The dialog identifies the requested action; **Discard and
refresh** or **Discard and open** performs it only after confirmation. Cancel
or Escape leaves the reason, scope check and evidence search untouched and sends
no API request. Confirmed navigation sends only the ordinary list/candidate GET,
never a decision POST; the previous candidate remains pending. Blank reviews
navigate without prompting. Successful decisions refresh normally without a
redundant discard prompt. Session expiry, logout and connection replacement are
not guarded; session cleanup still clears evidence immediately. Drafts are not
saved or recovered.

While a reason or scope check is present, a native browser `beforeunload` warning
also requests confirmation for reload or leaving the document. The listener is
attached only while that local review is dirty and removed when fields are
cleared, evidence is closed, a decision completes, or the connection is disposed.
Cancel preserves the review; leaving discards it without submitting a decision.
The browser controls the warning text and whether to show it (usually requiring
prior user interaction). This is best-effort protection, not guaranteed on tab
termination, mobile shutdown, crashes or every browser navigation. It does not
save drafts or prevent logout/session expiry. Browser tests exercise cancelled
and accepted reloads, cleared fields and connection cleanup; the real session
fixture verifies dirty-review logout removes the warning and report evidence.

The session header also warns when the advertised session deadline is two minutes
away (or immediately if less time remains). It explains that unsaved work will
be cleared and no decision is submitted automatically. The warning does not
extend the session, save a draft or trigger sign-in. Successful logout or expiry
removes it; expiry still clears evidence and dirty-review unload protection.
Browser timers can be delayed in suspended/background tabs, so this is advance
guidance, not an exact countdown or a substitute for server-side expiry checks.
The real-login fixture uses a controlled browser clock and shortened advertised
deadline to verify the warning threshold and dirty-review UI cleanup without a
decision POST; server token/session-expiration checks are tested separately.

The session UI rechecks the absolute advertised deadline on `visibilitychange`
and `pageshow`, as well as timer callbacks. Returning from a suspended/background
page therefore catches up the warning or clears expired evidence immediately
when those events run, rather than relying solely on delayed timers. These checks
make no request or decision and do not extend the server session. Expiry/logout
remove the listeners and pending timer; repeated restoration events cannot revive
an ended workspace. Controlled-clock tests advance wall time without firing
timers, then exercise both events before and after expiry. This is not a
cross-tab revocation check: earlier server-side invalidation is still enforced
when the next authenticated request is made.

Bootstrap also rejects an advertised deadline at or before the browser's current
time **before** connecting the review workspace. It displays an explicit expiry
error and keeps sign-in available, without fetching pending metadata or candidate
evidence. Controlled-clock tests cover both the exact deadline and one millisecond
past it, asserting zero review API requests and no decision POST. This browser
check complements, rather than replaces, server-side session enforcement.

Deadline handling is installed while the initial pending-list request is still
loading, rather than after it completes. A session-owned abort signal disposes
the workspace and cancels outstanding review fetches on expiry/logout, including
initial load. An already-aborted connection starts no review request. The
real-login fixture holds a list response across a shortened advertised deadline
and verifies cancellation, evidence cleanup and no late list restoration or
decision POST. Cancellation does not undo a server-side decision that may already
have committed; a lost decision response still requires refreshing after sign-in.

A review API **401** in application-session mode now immediately closes the
workspace, clears loaded list/evidence/local form state and unload protection,
removes expiry timers/listeners and shows an explicit sign-in-again message.
This applies to list, candidate and decision requests, even if the 401 body is
not valid JSON. Decisions are never automatically retried; the message asks the
reviewer to check report state after signing in before retrying. A **403** remains
a permission denial, not a logout: sign-out remains available for that valid
session. The original in-memory bearer-token test adapter retains its existing
error handling. Real-login browser tests inject 401 responses on each review
surface and verify cleanup and no retry; this is reactive to requests, not
cross-tab revocation polling or an identity-provider logout.

Failed sign-out explicitly says **sign-out was not confirmed** and that the
session may still be active, retaining a retry button rather than showing
sign-in as though logout succeeded. Server errors and transport failures both
use this wording; no automatic retry is attempted. A real-login test injects a
logout-audit failure and verifies the cookie/server session, dirty review and
unload warning remain active, with no successful logout receipt. It then aborts
a browser logout request and verifies the same retry behaviour before a manual
retry succeeds, clears evidence and denies session replay. A lost response may
still follow a completed server logout; the message deliberately does not claim
that the session is definitely active.

Session-bootstrap errors provide **Retry session connection** alongside the
explicit error and sign-in link. This manually reloads the current workspace,
rechecks the existing HttpOnly session and fetches the pending list only if
bootstrap succeeds. It does not automatically retry, start an identity login,
submit a review decision, or recover discarded drafts. Normal unauthenticated
401 responses still offer sign-in rather than an error/retry loop. Real-browser
tests cover server errors, malformed JSON and network failure before login, plus
successful recovery with the same application-session cookie after login. No
review requests are made during failed bootstrap.

Keyboard focus follows review actions: a loaded list focuses its filter, opening
a candidate focuses the review heading, and request/validation errors focus the
visible alert. Request-completion focus runs after controls are re-enabled;
disposed workspaces never reclaim focus. Review headings and alerts are
programmatically focusable without adding extra Tab stops, with a visible focus
outline. Confirmation/discard dialogs initially focus **Cancel**, not the
destructive or disclosure action. Browser tests verify Tab from the heading to
evidence search, error/list focus and Enter cancelling a newly opened approval
dialog without a POST. These checks are not a complete accessibility audit.

Session-bootstrap and unconfirmed-logout errors display the response's
`X-Request-Id` for correlation with server logs. Only UUID-shaped references are
shown; missing/invalid headers and network failures explicitly show `unavailable`,
not a fabricated ID. Headers are used even for malformed JSON responses, and
references are rendered as text without exposing session cookies or CSRF values.
The real-login fixture verifies a failed logout's visible reference exactly
matches the HTTP header and server error logger, alongside bootstrap malformed,
missing/invalid-reference and transport-failure cases. An audit failure may leave
no durable audit row; the ID then correlates with the operational error logger,
not a claimed successful logout receipt.

Review-list, candidate and decision responses now use the same validated
`X-Request-Id` helper as session errors. Malformed JSON produces an explicit
error with HTTP status and request reference without displaying raw upstream
content. Valid JSON errors display only bounded identifier-shaped error codes;
body-provided request IDs are not trusted in place of the response header.
Missing/invalid references show `unavailable`. A malformed decision acknowledgement
does not imply rollback: the browser removes the selected evidence/decision
controls and warns that the decision may already have committed, without retrying.
Browser tests cover malformed list/candidate responses, invalid references/codes
and an approval actually committed in storage before its response is damaged.

Review transport failures now explicitly warn that a lost response may follow a
committed decision, rather than displaying only a generic fetch exception.
Failures before headers show `request unavailable`; interruptions while reading
a received body retain its HTTP status and validated request reference. Request
timeouts have an explicit timeout message. Selected evidence/decision controls
are removed and no automatic retry is sent. Cancellation caused by session
cleanup retains the session's own closed/expired message instead of overwriting
it with a transport error. Browser tests disconnect approval requests both before
server delivery and after an actual commit, verifying the differing stored
outcomes and the same conservative browser recovery guidance. Refresh/re-sign-in
and inspect the pending/published state before deciding whether to retry.

The browser regression also exercises the real 15-second request timeout without
mocking browser timers: an approval commits while its acknowledgement is held
back. The test verifies the timeout does not occur before 15 seconds and is
reported within the test's 20-second wait window, with no retry or remaining
decision controls. Releasing the late success cannot overwrite the timeout;
refresh reconciles the pending list against the committed approval without a
second decision POST. This deliberately adds about 15 seconds to the UI test.

After a valid successful decision acknowledgement, the workspace displays a
separate **Last confirmed review** status with the decision, candidate ID,
snapshot hash and validated server request reference for audit/log correlation.
Only a UUID-shaped `X-Request-Id` response header supplies that reference; missing
or invalid headers display `unavailable`, never an ID from the response body.
It is set before refreshing the list, so a failed follow-up GET
cannot erase the confirmed outcome or imply rollback. It explicitly advises not
to resubmit that decision. The status remains through manual refresh, is replaced
only by another confirmed decision, and disappears when the connection closes or
the page reloads. It is a local acknowledgement, not a new durable receipt API or
history view; SQLite still holds the authoritative review record. Malformed/lost
acknowledgements do not create a confirmation. Browser tests cover both approve
and reject followed by a 503 list refresh, recovery without a second POST, and
preservation of the previous confirmation when another response is damaged.
They also match successful decision references to persisted access audits and
verify that refresh references cannot replace them.

Invalid successful pending-list or candidate JSON also retains the validated
header request reference in its validation error, including snapshot, customer-scope
and metadata mismatches. These failures expose neither response fields nor evidence
or decision controls; missing/invalid headers show `unavailable` rather than a
body-supplied ID. An explicit refresh or inspection is required to recover.

HTTP success alone does not confirm a review: the response must be a JSON object
with the recognised `incident_review_recorded` code. Null, arrays and unexpected
codes produce an explicit unconfirmed-outcome error with HTTP status and validated
header reference. The browser warns that the decision may already have committed,
clears evidence/decision controls and does not replace the last confirmed outcome
or retry. Tests cover unrecognised JSON both without server delivery and after a
real approval commit; raw response fields are not displayed in the error.

While a review request is in flight, the workspace sets `aria-busy` and disables
its buttons, search/filter/order inputs, reason and scope checkbox. Decision
submission explicitly says it is awaiting confirmation. This prevents local
inputs from drifting from the submitted decision; it does not change the
hash-bound request or make it safe to retry an uncertain outcome. Controls are
re-enabled after completion/failure and busy state is cleared on disposal.
The separate session-header sign-out remains usable during workspace loading.
Browser coverage checks the locked form during a stalled acknowledgement,
recovery after timeout, and busy cleanup on session expiry during initial load.

The review reason has associated live character-count feedback and a local
2,000-character guard, using the same JavaScript string-length measurement as
the server. Blank/whitespace-only reasons remain invalid. Before confirmation,
the browser also checks the exact UTF-8 JSON decision body against the server's
8,192-byte cap, since escaped control characters can exceed that cap within
2,000 characters. It submits the checked body unchanged. Neither limit truncates
the reason silently; oversized input shows an explicit error without a dialog
or POST. Browser tests exercise 2,000/2,001 characters, blank reasons and JSON
escaping beyond the byte cap. Server validation remains authoritative.

Boundary regression coverage verifies both approve and reject at exactly 8,192
and 8,193 encoded bytes: the first opens confirmation, the second blocks it with
no POST or reason truncation. A real 8,192-byte browser approval then verifies
the transmitted JSON, successful publication and exact persisted review reason
and snapshot hash. This checks the browser and API limits together, rather than
assuming that a locally accepted body will be accepted unchanged by the server.

The reason counter explains that the existing 2,000-character limit measures
UTF-16 code units: some symbols, including emoji, count as two. Browser tests
exercise 1,000 supplementary-plane symbols at the limit and one extra code unit
over it for both decisions, plus exact 8,192/8,193-byte bodies containing multibyte
Unicode. A real rejection verifies a 2,000-code-unit reason containing accented
text, CJK, emoji and combining marks reaches the API and SQLite unchanged, without
Unicode normalization or truncation. The UTF-8 byte cap remains independent.

### Durable review history and outcome reconciliation

The workspace's **Recorded review history** section loads only on explicit action.
It shows up to 50 recent decisions and offers an exact candidate-UUID lookup for
older or uncertain outcomes. Inspection pre-fills that candidate ID, retaining it
in the current connection after a failed acknowledgement; it is not saved in
browser storage. After reload, paste the ID or load recent history. Both actions
are read-only GETs and never replay approval/rejection. An open draft receives the
existing discard confirmation before history loading closes the review.

Recorded reasons, reviewer identities and metadata render as literal text only.
History is a snapshot: use explicit reload/lookup to update it. Empty exact
lookups carry an uncertainty warning, not an invitation to resubmit. History reads
do not replace the separate **Last confirmed review** acknowledgement. History
request references identify the read, not the original decision request. New
connections, expiry and sign-out remove loaded history; no browser persistence
or new report-disclosure permission is introduced.

Tests cover reopening SQLite, more than 50 decisions, deterministic tie-breaking,
exact older outcome lookup, corruption, audit failures, customer/permission and
GET-only boundaries. Browser coverage reconciles a committed approval whose
acknowledgement timed out after a fresh connection, verifies rejected outcomes,
draft guards, literal hostile-looking text, invalid responses and no extra POST.
The real confidential-session proof also reads history after reload and checks
cross-customer denial and logout replay denial.

The storage recovery regression also backs up 54 candidates with 53 recorded
decisions across two customers, closes and removes the original test database,
then restores into a fresh path. It compares the exact recent-history results
(including the 50-record cap and ordering) and every candidate lookup, including
an older decision outside that list. Reviewer, reason, hash and decision timestamp
must survive unchanged, including multiline Unicode and literal markup. It also
checks tenant separation, pending/approved/rejected publication state and history
after reopening the restored database. This is a local SQLite recovery proof,
not an offsite-backup or IONOS disaster-recovery acceptance test.

Backup/restore inspection also enforces candidate UUID syntax and the same
200-code-unit reviewer / 2,000-code-unit reason bounds used by recorded-history
reads. This prevents a structurally valid SQLite backup from being accepted when
its restored receipts would be unreadable. Regression probes reject over-limit
approved and rejected receipts and malformed pending IDs during both backup and
restore, including artifacts with a recalculated valid checksum. Exact-limit
Unicode reasons remain accepted; failed operations remove their newly allocated
output without modifying the source or existing restored databases.

Held-response browser tests also verify history lifecycle behaviour: old results
clear before a read, all workspace controls lock with `aria-busy` while it is
pending, and successful completion restores controls and focuses the history
status. Replacing the connection during that read clears history and aborts the
old request; releasing its late response cannot populate the new connection or
overwrite it with an abort error. Neither path sends a decision POST.

### Authenticated agent-console foundation (assignment metadata only)

`GET /api/customers/{customer}/agent/profile` introduces the first authenticated
agent-console boundary. It requires explicit provisioned membership with
`agent:access`, independently of all diagnostics permissions. Support grants cannot
confer this permission, even if configured with that value. Token roles, query
parameters, usernames and caller-supplied extension values do not choose an agent.

Inject a `createAgentDirectory` result as the optional ninth `createDiagnosticApi`
argument. Each operator-provisioned assignment contains `issuer`, `subject`,
`customer`, numeric-string `extension` (1–16 digits) and `displayName` (1–128
characters without control characters). Lookup binds all three identity/scope
fields exactly; duplicate identity/customer entries fail at construction. The
directory copies its configuration and returns fresh allowlisted profile objects.
The API validates output again and discloses only:

```json
{
  "requestId": "SERVER_GENERATED_UUID",
  "customer": "customer-a",
  "agent": { "extension": "1001", "displayName": "Synthetic agent Alice" }
}
```

The route is GET-only, `no-store`, request-correlated and audited with operation
`agent-profile`/outcome `agent_profile_viewed` before disclosure. An authorised but
unassigned member receives 404 `agent_not_assigned`; an absent or invalid directory
returns 503, not an invented extension. Permission failures are 401/403, non-GET
requests from authorised members are 405, and audit failure blocks the profile.
Existing confidential application sessions work without browser bearer tokens.

Validate with `node --test .\tests\agent-profile.test.ts` and
`.\scripts\Test-IdentityProof.ps1`. The real browser-session proof provisions Alice
only, verifies her own profile and durable subject/customer/request audit, denies
diagnostics-only Bob and foreign scopes, and rejects cookie replay after logout.
Unit/API tests additionally cover support denial, mutation isolation, missing
assignments, invalid output, directory failure, extra-field stripping and audit
failure. The local engineering launcher does not yet provision agent assignments
or `agent:access`; the route remains unavailable/denied there by default.

This is a read-only identity/assignment foundation, **not a usable phone console**.
It creates no SIP credentials, WSS connection, device lease, registration, queue
availability or call controls. Production provisioning workflow, shared-device conflicts and session-bound SIP credential lifecycle must
be designed before enabling phone registration. No existing AMI credential is
repurposed or disclosed to an agent.

#### Persistent operator-provisioned assignments

`openAgentStore(absolutePath)` supplies the same `AgentDirectory` interface from a
separate versioned SQLite database. Inject the returned store as the API's ninth
argument and close it during server shutdown. It is separate from the diagnostic
database: diagnostic backup/restore does **not** include agent assignments.
Schema creation refuses nonempty unversioned, unsupported or malformed databases.
Reads validate stored assignments again and return only extension/display name.

The selected provisioning policy is insert-only.
`store.provision(assignments, { operator, reason })` validates the entire batch,
commits it and its receipt in one transaction and returns
`{ id, timestamp, sha256, inserted, unchanged }` only after commit.
An identical existing assignment is
accepted; changing its extension **or display name** rejects the whole batch,
including earlier inserts. Duplicate identities, invalid input, database locks
and corrupt stored assignments fail explicitly. Reads survive closing/reopening
the database; changes to returned objects cannot mutate storage.

For trusted operator use, prepare an absolute-path JSON file containing an array:

```json
[
  {
    "issuer": "https://identity.example/realms/customer",
    "subject": "OIDC_SUBJECT_NOT_USERNAME",
    "customer": "customer-a",
    "extension": "1001",
    "displayName": "Agent Alice"
  }
]
```

Run with existing parent directories and operator-controlled paths, for example:

```powershell
node .\scripts\Provision-AgentAssignments.ts 'C:\operator-data\agents.sqlite' 'C:\operator-data\assignments.json' 'operator-reference' 'Initial approved assignment batch'
```

The command prints receipt metadata and inserted/unchanged counts, exits unsuccessfully on a
conflict or storage failure and never silently replaces an assignment. Provisioning
does not create membership or grant `agent:access`: provision that independently.
Protect both the JSON and database as identity metadata. There is no web mutation
route, history API/UI, reassignment, deletion, extension exclusivity,
active-device lease or SIP secret in this store.
Multiple people sharing an extension is not yet a supported phone-session policy;
metadata persistence must not be treated as permission to enable registration.

Validate persistence and the operator command with
`node --test .\tests\agent-store.test.ts .\tests\agent-profile.test.ts`.
The real confidential browser-session proof now provisions SQLite, closes it,
reopens it as the API directory, and checks the existing profile/audit/customer/
logout boundaries. The default local launcher remains unconfigured for agents;
the CLI does not automatically wire a database into it.

Successful provisioning now writes `agent_provision_receipts` in schema version 2.
Each receipt contains a generated UUID, server timestamp, operator reference
(1–200 UTF-16 code units), reason (1–2,000 code units), SHA-256 and the exact
allowlisted assignment JSON in input order, plus inserted/unchanged counts.
Operator and reason must be nonblank and free of control characters; values are
preserved, not trimmed. The hash covers UTF-8 JSON with fields in
issuer/subject/customer/extension/displayName order, excluding unrelated input
fields. Identical reruns create new receipts with the same batch hash; they do not
reuse an earlier receipt. Empty batches are recorded with zero counts.

Receipt insertion failure rolls back assignment inserts, and invalid, conflicting
or locked batches do not create successful receipts. Version-1 stores migrate
without changing existing assignments or inventing historical receipt provenance.
Receipts are operator-local records, not cryptographic signatures, independently
authenticated operator identities or tamper-proof logs: the CLI's operator/reason
are trusted caller assertions, command-line values can appear in process history,
and file owners can modify SQLite. Keep sensitive material out of those arguments.
There is no failed-attempt log or receipt-history browser endpoint yet. Receipts
contain identity metadata and need the same protection and recovery policy
as assignments; diagnostic backup tooling still does not include this database.

An operator can retrieve one known receipt without opening a writer:

```powershell
node .\scripts\Read-AgentProvisionReceipt.ts 'C:\operator-data\agents.sqlite' 'REPLACE_WITH_RECEIPT_UUID'
```

This command opens an existing schema-2 database read-only, does not create a
missing source or migrate older schemas, and prints validated receipt metadata,
operator/reason and assignment snapshots. Protect its output as identity metadata;
this is not a customer-scoped web endpoint. `openAgentStore(path, { readOnly: true })`
also exposes `receipt(uuid)` for trusted server/operator use. Invalid UUIDs,
corrupt receipts and unavailable storage fail explicitly. A well-formed unknown
UUID yields `undefined` in the store and a nonzero CLI error, not a fabricated
successful receipt.

Reads validate canonical timestamp, context limits, safe nonnegative counts,
count-to-batch length, unique assignment identities, exact allowlisted JSON shape
and the SHA-256 of stored JSON. Returned objects are detached. A bad receipt is
rejected even when its hash has been recalculated around invalid or extra-field
assignment data. These consistency checks are not cryptographic provenance:
someone who can rewrite the database can rewrite valid data and its hash.
Historical receipts are not matched against today's assignment row or used to
authorise an agent; the existing profile boundary remains independent.

Retain the UUID from provisioning output for this exact lookup. It can reconcile
a previously recorded receipt reference after process restart; it cannot discover
a UUID lost with the entire response. Receipt absence is not proof a batch failed
or that a concurrent operation cannot commit. This adds no automatic retry,
history listing, failed-attempt log or browser route.

#### Agent assignment and receipt backup/recovery

`backupAgentStore(sourcePath, parentDirectory)` uses SQLite's online backup API
against an existing read-only source, so the writer may remain open. It returns a
new `agent-backup-*` directory containing `agents.sqlite` and a manifest with
format version 1, agent schema version 2, creation time, file SHA-256 and
assignment/receipt counts. The copied database must pass SQLite integrity checks
and the same profile/receipt validators used by normal reads.

`restoreAgentStore(backupDirectory, parentDirectory)` copies into a newly allocated
`agent-restore-*` directory, verifies file checksum, manifest counts and all stored
assignments/receipts, then returns the restored database path. It never replaces
the live database. Both functions require absolute local paths and existing,
operator-controlled parent directories. Failure removes only the newly allocated
output directory; missing sources are not created. Schema-1 sources are refused
without migration: migrate explicitly with the trusted writer before backing up.

The operator command prints a JSON object containing operation and output path:

```powershell
node .\scripts\Manage-AgentBackup.ts backup 'C:\operator-data\agents.sqlite' 'C:\operator-backups'
node .\scripts\Manage-AgentBackup.ts restore 'C:\operator-backups\agent-backup-REPLACE' 'C:\operator-restores'
```

These artifacts contain **all customers' assignments and provisioning receipts**,
including operator/reason and historical assignment snapshots. Restrict access and
protect off-host copies; no encryption, signing, retention automation or upload is
provided. Checksums and validation detect inconsistency, not a malicious file
owner who rewrites valid data and matching hashes. Historical receipts are not
required to match present assignments: legacy rows have no invented provenance.
This database remains separate from diagnostic backups and from identity grants,
PBX config, SIP credentials and sessions; it is not a complete platform backup.

`node --test .\tests\agent-backup.test.ts` verifies live-writer snapshotting,
post-snapshot exclusion, source-file removal before restore, exact two-customer
profiles/receipts, CLI backup/restore, empty stores, checksum/count/content
corruption (including recomputed hashes), old-schema refusal and failed-output
cleanup. A restore is a candidate database for explicit operator inspection and
later cutover, not automatic replacement, membership granting or phone enablement.
Offsite recovery, full-system restore and production recovery timing remain open.

#### Authenticated assignment console

With application sessions configured, `/agent/{customer}` now serves a
non-calling console: sign in, view your own assignment, explicitly refresh it,
manage a short backend device reservation and sign out. The fixed login selector `workspace=agent` is bound to the pending
OIDC flow and returns only to that customer's console. Arbitrary return URLs are
not accepted; existing review login remains the default.

The page bootstraps the HttpOnly application session, checks its customer scope,
then calls the own-profile route without browser bearer tokens. It renders
assignment values as literal text, clears old data before refresh/failure, offers
manual retry rather than polling, warns near expiry and clears data at expiry,
401, successful logout or page disposal. Expiry is also rechecked on visibility
and page restoration. Sign-out uses the session CSRF token; an unconfirmed logout
remains an explicit error with retry and does not claim the session ended.
Requests have bounded timeouts and errors carry validated header request IDs.
No profile is loaded before a valid matching session bootstrap.

The phone section explicitly states that connection is disabled: assignment,
registration/reachability, queue availability and call state are separate.
No microphone prompt, WSS connection, SIP credential, call button or browser
storage is introduced. Without configured application sessions, console routes
return 503. The default launcher still grants no agent access; synthetic Alice's
assignment is provisioned only in the real identity proof, and diagnostics-only
Bob is denied.

`node --test .\tests\agent-console.test.ts .\tests\application-session.test.ts`
covers literal hostile-looking names, stale-data clearing, errors/manual recovery,
mismatched sessions/results, expiry, 401 and logout confirmation, including a held
profile response across sign-out: logout stays available and a late response cannot
repopulate the cleared console. The real identity proof additionally opens the
console with ordinary Alice/Bob sessions and, in fresh browser contexts, signs in
directly from the console through Keycloak PKCE. It verifies the fixed console
return, Alice's assignment, Bob's explicit access denial, manual refresh and CSRF
sign-out with durable logout audits and rejected session-cookie replay. Console
landing requests only the scoped profile, without browser bearer tokens or
engineering data. This is an authenticated assignment screen, not yet a phone console.

#### Bounded agent workspace workflow

The console now identifies the selected customer before sign-in and separates
next-step guidance from assignment, reservation and disabled phone capability.
Guidance explains explicit acquisition, renewal, release-before-device-move and
the absence of automatic takeover. If assignment refresh fails while a lease is
known, the profile clears and acquisition is hidden, but release remains available
for an explicit server-authorised attempt; denial does not discard the retry handle.

The [AW-01 through AW-12 evidence](./MILESTONE-1.md#executed-workflow-ui-evidence)
records focused browser/backend checks and the real Keycloak/session/launcher run.
Tests cover customer context, denied/missing/unavailable assignment states,
keyboard reservation actions, retained lease recovery, no unexpected API/WebSocket
traffic and no microphone request. This is not an accessibility certification or
live phone readiness. Existing session, profile and lease APIs are unchanged.

#### Backend device-lease foundation (subsequently connected to the console)

The agreed device policy is one active device per issuer/subject/customer: a second
device is rejected until explicit release or expiry, with no automatic takeover.
The future in-call sign-out policy is to stop new offers immediately, finish the
current call, then release the phone session. Call draining is **not implemented**
by this increment.

`openAgentDeviceLeaseStore` in `src/agent-device-lease.ts` is a trusted-backend
primitive with `acquire`, `renew`, `release` and a non-mutating `current(owner, leaseId)`
ownership read. It uses a dedicated absolute-path
SQLite database, separate from assignments, receipts and diagnostic evidence.
`BEGIN IMMEDIATE` serialises competing writers, including separate processes.
Each lease binds the exact agent identity, backend application-session ID and a
device UUID. Only a SHA-256 hash of the session ID is stored; callers receive only
the lease UUID and expiry. A different session on the same device also conflicts.
Retries by the same owner return the existing lease without extending its life.
Renewal is explicit and lasts at most 60 seconds, capped by the supplied verified
application-session expiry. At the exact expiry boundary it is no longer owned.
`current` validates every owner dimension, returns a detached ID/expiry snapshot
capped by the supplied verified session expiry, and never extends or acquires a
lease. Independent database connections see committed renewals. Released, replaced
or expired leases throw the same explicit ownership errors as mutations; corrupt
rows and database failures are not treated as normal expiry. This trusted-backend
read adds no HTTP endpoint and is not an authorisation to act later on a stale snapshot.
Reacquisition after expiry or release generates a new UUID; stale IDs cannot renew
or release a replacement lease. Ownership/conflict/session-expiry errors have
explicit codes; invalid input, corrupt rows and SQLite failures throw.

The caller must supply server-verified session/identity data and independently
enforce `agent:access` and a valid assignment. This module does not authenticate,
read cookies, grant membership, check assignment existence, reserve an extension,
or authorise a SIP operation. There is no phone activation, automatic heartbeat,
logout release hook or credential issuance yet. Distinct
agents sharing a provisioned extension are not made safe by identity exclusivity.
Expired rows are replaced on the next acquisition for that identity. Database
reopen preserves reservations, not application sessions or permission to reconnect.
Lease data is deliberately excluded from assignment backups and must not be used
as a recoverable phone session. Lease expiry alone does not disconnect a SIP
endpoint; downstream fencing/revocation and call-aware draining remain prerequisites
before enabling calling. Timings depend on a correct backend wall clock.

Validate with
`node --test .\tests\agent-device-lease.test.ts .\tests\agent-profile.test.ts .\tests\agent-store.test.ts .\tests\agent-backup.test.ts`.
Tests cover exact expiry, session caps, all owner dimensions, stale lease fencing,
explicit release, rollback/locking, corrupt state and six competing processes
producing exactly one winner.

#### Authenticated backend device-lease routes

An optional tenth `createDiagnosticApi` argument injects the lease store. It is
not enabled by the default engineering launcher. When explicitly configured with
application sessions and the assignment directory, these routes are available:

| Method and route | JSON body | Result |
| --- | --- | --- |
| `POST /api/customers/{customer}/agent/device-lease` | `{ "deviceId": "<uuid>" }` | Acquires or reconciles the same owner's unexpired lease |
| `POST /api/customers/{customer}/agent/device-lease/renew` | `{ "deviceId": "<uuid>", "leaseId": "<uuid>" }` | Renews only the current owned lease |
| `POST /api/customers/{customer}/agent/device-lease/release` | `{ "deviceId": "<uuid>", "leaseId": "<uuid>" }` | Releases only the current owned lease |

The routes require a live HttpOnly application session bound to the path's
customer, same-origin CSRF validation, direct `agent:access` membership and a
valid own assignment. Bearer-only access is rejected, even with agent permission;
identity/session/expiry/extension fields cannot be supplied in the body. Even a
member of both customers must sign in for the specific customer. A device UUID
selects the device within the verified session; it is not hardware attestation.
All methods other than POST are rejected. Bodies are JSON-only, uncompressed,
limited to 1,024 bytes and five seconds, and reject extra fields or malformed IDs.
The shared bounded JSON reader preserves the existing review-route contracts.

Successful acquire/renew responses contain only
`{ requestId, customer, lease: { id, expiresAt } }`, where expiry is Unix milliseconds;
release returns `{ requestId, customer, code: "agent_device_released" }`.
Responses are `no-store` and request-correlated. Ownership/active-device conflicts
return 409; expired or missing sessions return 401; membership/scope/CSRF denial
returns 403; missing assignment returns 404; unavailable configuration, storage,
directory or audit returns 503. No SIP credentials or calling controls are returned.

Each request has one audit record, preserving the existing unique request-ID
constraint. Early denials record their reason. Valid mutations require a committed
`agent-device-acquire`, `agent-device-renew` or `agent-device-release` event with
outcome `agent_device_<action>_requested` **before** calling the store. This is an
authorised intent, not a durable success receipt: a subsequent conflict, storage
error, concurrent logout or lost response may prevent confirmation. Audit failure
before mutation prevents the change. Raw session/device/lease IDs and request
bodies are not added to these audits. An uncertain acquisition can be retried by
the same session/device; release or expiry permits the next owner.

The live session is rechecked after body reading and intent auditing, before the
synchronous lease mutation. Concurrent logout/rotation therefore cannot activate,
renew or release from a stale request. Logout invalidates future lease calls but
does not currently delete the reservation: it blocks other sessions until at most
its remaining 60 seconds elapse. Explicit release while signed in avoids that
wait. This is deliberately not the future call-aware sign-out implementation.

`node --test .\tests\agent-device-http.test.ts` covers authentication, CSRF,
cross-customer sessions, membership/support denial, missing assignments, strict
input, conflicts, renewal/release, stale holders, expiry, failure handling and
logout during an awaited audit. `.\scripts\Test-IdentityProof.ps1` also exercises
these routes through real Alice/Bob Keycloak browser sessions: Alice acquires,
renews and releases, Bob is denied, intent audit persists in SQLite, and a
logged-out cookie cannot renew a retained lease. The console now exposes explicit
reservation controls as described below; it still has no phone activation or
automatic heartbeat.

#### Explicit console reservation controls (phone still disabled)

After a valid own assignment loads, the console offers **Reserve this device**,
**Renew reservation** and **Release reservation**. Only an explicit button click
sends a lease request. The page generates a random device UUID in memory, retains
the returned lease ID in memory, and uses the bootstrapped CSRF token with
same-origin cookies. No browser storage, bearer token, SIP secret or microphone
request is introduced. This UUID identifies this page instance, not attested
hardware. Reloading, another tab or reopening creates a different device UUID
and can conflict until the previous reservation is released or expires.

A confirmed reservation shows its expiry and explicitly says the phone remains
disabled. Expiry clears the local lease and offers acquisition again; it never
automatically renews, retries or releases. Visibility/pageshow deadline checks
also recheck lease expiry. Refreshing an assignment hides acquisition until a
valid profile returns, but preserves release/renew controls for a known lease.
Missing backend configuration surfaces an explicit request-correlated failure.

Conflicts and malformed/failed responses never manufacture success. Uncertain
acquisition retains the same page device identity for an explicit retry.
Uncertain release retains the known lease handle for retry until its expiry.
Responses validate customer, UUID, bounded future expiry and renewal identity;
release requires the explicit release response code. Buttons are disabled during
a lease request, but sign-out remains available. A confirmed sign-out, session
expiry, 401 or page closure aborts in-flight lease requests and clears/hides local
reservation data; a late response cannot restore it. These actions do not confirm
server release: explicitly release before sign-out or wait for the remaining
lease expiry. This is not the future call-aware draining workflow.

`node --test .\tests\agent-console.test.ts` covers reserve/renew/release, request
shape, explicit-only behavior, failures and malformed responses, conflicts, local
expiry, reload identity, access denial and a held acquisition across logout.
The real identity proof clicks Alice's actual reservation buttons and checks the
persisted intent audit; Bob's denied assignment keeps the controls hidden and
the backend still denies a direct request.

### Read-only PBX operational status (local AMI proof)

`GET /api/customers/{customer}/pbx/status` requires provisioned
`diagnostics:read` for that customer. It accepts GET only, is audited as
`pbx-status`, and returns only `requestId`, `customer`, `checkedAt`,
`coreStartedAtLocal` and `activeCalls`. Audit failure prevents status disclosure.
Review permission alone does not confer status access; existing bounded
diagnostics-read support grants can read it within their authorised scope.
Unauthorised requests do not open an AMI connection.

The **PBX operational status** workspace section checks only on explicit action.
It uses the existing application session, draft-discard protection, request
references, busy controls and disposal. Invalid or failed reads clear the previous
status rather than presenting stale success. A successful snapshot confirms AMI
core reachability and the reported active-call count at the check time. It does
**not** prove SIP registration, trunk reachability, RTP/audio quality or the
50-call capacity target. Asterisk's startup timestamp is PBX-local time, not UTC;
no timezone or calculated uptime is invented.

The AMI adapter uses operator-provisioned customer mappings, never browser-supplied
hosts or credentials. It sends only `Login` with events disabled and `CoreStatus`,
matches action IDs, limits each connection to three seconds / 64 KiB, and allows
only one check per customer concurrently per application process. Connections
are closed after each check; there is no polling, event subscription, command,
origination or call-control API. Raw AMI data and credentials are never returned.
Missing configuration, refusal, denied actions, malformed/oversized data and
timeouts produce explicit unavailable responses, not a healthy/zero-call fallback.

`createDiagnosticApi` accepts an optional seventh `PbxStatusSource` argument.
The local launcher loads `.local-proof/pbx-status/connections.json` when present:

```json
[
  {
    "customer": "customer-a",
    "host": "127.0.0.1",
    "port": 15038,
    "username": "status-reader",
    "secret": "REPLACE_WITH_OPERATOR_PROVISIONED_SECRET",
    "tls": false
  }
]
```

This file is server-side and ignored by Git. Store/protect it as a credential,
not as a browser setting. Plaintext is accepted only for literal loopback
addresses; all other connections require TLS with normal certificate/hostname
verification. Production certificate deployment and remote AMI networking are
not proven by the local fixture. AMI accounts should have `read = none` and
`write = reporting`; Asterisk classifies the read-only `CoreStatus` request in
the reporting action class. This is not unrestricted `write = all` access.

Run the separate synthetic AMI TLS transport proof with:

```powershell
.\scripts\Test-AmiTlsProof.ps1
```

It generates fresh short-lived self-signed test identities under a unique ignored
directory, installs their explicit trust only in its child Node process, and
removes the generated keys/certificates afterward. A loopback TLS AMI simulator
verifies both fixed actions succeed with trusted matching identity. Untrusted,
trusted-but-mismatched IP SAN and expired certificates must fail with their
specific TLS verification errors; the adapter returns only its sanitised
connection error and sends no credentials or application bytes. Repeated rejected
queries also verify the customer's in-flight guard is released. No verification
bypass, production trust change or application dependency is added. This is an
adapter transport proof, not a real Asterisk TLS listener, DNS/SNI, remote network
or production PKI acceptance proof.

Run the isolated real-runtime proof with:

```powershell
.\scripts\Test-PbxStatusProof.ps1
```

It starts two separate pinned Asterisk 22 containers, publishes AMI only on
loopback TCP ports 15038/15039 (plain) and 15048/15049 (TLS), generates distinct
ignored credentials, checks both
cores, and verifies unauthenticated access plus `Command`/`Originate` are denied.

The same runner now enables real Asterisk AMI TLS on container port 5039 with a
fresh one-day self-signed IP-SAN identity per customer. The shared proof certificate
generator is also used by the simulator test. Read-only mounts hold the ignored
per-customer certificate/key files, and both TLS host ports are checked before
startup. A dedicated child Node process trusts only the fixture identities added
through `NODE_EXTRA_CA_CERTS`; its prior environment value is restored afterward.
Against both real TLS listeners the adapter verifies:

- Core reads and complete endpoint snapshots with distinct mapped credentials.
- The reporting-only account cannot enumerate endpoints.
- A different customer's secret cannot authenticate.
- The same core adapter remains usable after action denial.
- A fresh process without the fixture trust rejects both self-signed peers with
  the expected TLS verification cause and sanitised adapter errors on repeated
  core/endpoint requests, without falling back to the plain listener.

The standalone TLS test uses connection copies; default launcher/browser mappings
remain plain loopback. The opt-in combined TLS mode below temporarily changes both
source mappings for its scoped acceptance run.
Certificates, private keys and the trust bundle remain in ignored
`.local-proof/pbx-status` beside the fixture's existing credentials and regenerate
on each run; protect them and do not share them. Owned containers/networks/volumes
are removed as before. The application gains no Docker access or TLS verification
bypass. Real local Asterisk TLS is now accepted; DNS/SNI, remote networking,
production PKI provisioning/rotation and end-to-end production TLS remain open.

The probe does not originate a call. Its fixture lock/port/ownership checks
prevent taking over existing services; cleanup removes only this compose
project's containers, networks and disposable state volumes.

For a manual browser demonstration, run that script with `-Interactive`, then
start `.\scripts\Test-IdentityProof.ps1 -Interactive` in another terminal and use
the engineering workspace. Enter `stop` in each owning terminal when finished.
Without interactive mode the PBXs are removed after testing; the retained
mapping then correctly yields unavailable until matching runtimes are started.
Existing PBX proof containers and their credentials are not modified.

`npm run test:pbx-status` covers action framing, fragmented replies, unrelated
events, denied/malformed/oversized/disconnected responses, timeout, concurrency,
credential injection guards and configuration immutability. API/browser tests
cover permission/customer boundaries, GET-only behaviour, audit gating, safe
allowlisted results and clearing a mismatched response.

For the complete identity-to-runtime acceptance path, run:

```powershell
.\scripts\Test-PbxStatusProof.ps1 -WithIdentity
```

This keeps both isolated PBXs running while the existing Keycloak, application
session and launcher proofs execute. The application-session proof explicitly
enables the real AMI adapter for this run: Alice and metadata-only Bob each log in,
click the status control for their own customer and receive a real Asterisk
snapshot. Tests match its header request reference to the durable customer/subject
audit record, deny foreign-customer requests and deny cookie replay after logout.
Bob's status access does not grant review authority. Browser requests still carry
no bearer token. Ordinary identity runs do not require running PBXs.

The combined runner restores its test-only environment flag and cleans up both
owned fixtures on completion/failure. `-WithIdentity` and `-Interactive` are
mutually exclusive. This local end-to-end proof does not validate remote TLS or
production monitoring.

To exercise the authenticated browser/API path with verified TLS on the
**backend-to-PBX hop**, run:

```powershell
.\scripts\Test-PbxStatusProof.ps1 -WithIdentity -WithTls
```

`-WithTls` requires `-WithIdentity` and cannot be used interactively. After the
ordinary protocol/registration checks, the exclusive owner temporarily rewrites
both ignored source mappings to TLS ports 15048/15049 and installs fixture trust
for child Node processes before they start. The existing application-session test
asserts both loaded mappings use those TLS listeners and normal certificate
verification, then exercises Alice and Bob's core/endpoint reads, durable audits,
foreign-customer denial and logout replay denial. The same-source real outage and
recovery proof also runs over TLS. Existing launcher tests run with those mappings.

The runner restores the original mapping text, prior trust environment and test
flags in `finally`, including on test failure, before fixture teardown. The default
command and interactive workflow remain unchanged. No browser receives AMI
credentials or test certificates, and no verification bypass or application Docker
access is added. Browser-to-application and identity traffic is still loopback HTTP;
this is not full-chain HTTPS, remote-network or production PKI acceptance.

The status fixture also exercises real outage isolation before any optional
identity run. Long-lived separate core and endpoint sources first check both PBXs,
then the test stops only its owned customer-A container. Two rounds concurrently
query all four core/endpoint customer-source combinations. A's core and endpoint
reads must reject within a five-second round bound while both B reads succeed;
no cached healthy snapshot, zero-call fallback or successful empty endpoint list
is accepted. After restarting A and waiting for core boot, the same source
instances and credentials must read both PBXs again. Endpoint snapshots before,
during (B only) and after the outage must preserve the exact no-contact/static
inventory, zero active channels, customer scope and contact-address redaction.
The default run covers plain loopback; `-WithIdentity -WithTls` covers verified TLS.
The application adapter itself has no Docker access: fixed container stop/start
commands exist only in the exclusive test fixture. This proves local adapter
recovery, not browser outage UX or production failover.

Separate browser fault-injection coverage verifies the outage UX: after a
successful snapshot, a held recheck immediately replaces the old reachable text
with a checking state and locks controls. A 503 response clears the old status,
shows its validated request reference and focuses the error. No automatic recheck
is started. An explicit check can then display a new successful snapshot with its
new observation/startup times and clear the error, without any decision POST.
These browser responses are injected; the real outage proof above separately
validates the AMI runtime behaviour.

### SIP endpoint visibility (observed contacts, not registration proof)

`GET /api/customers/{customer}/pbx/endpoints` is GET-only and requires that
customer's `diagnostics:read`. Successful disclosure waits for a durable
`pbx-endpoints` access audit. The response contains `requestId`, `customer`,
`checkedAt` and `endpoints`; each endpoint includes only `id`, `deviceState`,
`hasContacts` and `activeChannels`. Raw contact URIs, IP addresses, transport/AOR
details and authentication names/secrets are excluded. Endpoint IDs themselves
remain operator-provisioned identifiers and should not contain sensitive data.

The workspace loads this snapshot only when **Check SIP endpoints** is selected.
It protects an open draft, renders all endpoint data as literal text, clears old
results before checking, and removes results on failure/session disposal. Empty
lists mean a completed check found no configured endpoints; denied, incomplete,
malformed or oversized lists produce explicit unavailable errors, never an empty
healthy fallback. The list is capped at 200; exceeding either that cap, the 64 KiB
AMI response cap or the three-second deadline fails the whole check rather than
silently truncating it. Completion/action IDs and item counts must match.

**Meaning:** `hasContacts` means Asterisk reported at least one associated contact,
which may be statically configured. It does not distinguish dynamic registration,
expired contacts or reachability. Reported device state is not a health verdict.
This increment therefore provides endpoint/contact visibility, **not yet a
verified registered/unregistered phone inventory**. Dynamic REGISTER/unregister
and natural expiry transitions, plus synthetic SIP qualification loss/recovery,
are now covered by the local proof below. These do not establish audio health.

**Separate credential authority:** Asterisk 22 classifies `PJSIPShowEndpoints`
under the AMI `system` action class, not `reporting`. Following the explicit design
decision, endpoint enumeration uses a separately provisioned account with
`read = none` and `write = system,reporting`. The original core-status account
remains reporting-only and the real proof verifies it cannot enumerate endpoints.
The new account's class permits other system actions if its credentials are
misused outside this application: it is **not a server-enforced read-only AMI
account**. Keep it private, tenant-bound and on a restricted management network;
production use needs explicit operator acceptance of that broader authority.
No arbitrary AMI action or system-control route is exposed by the application.

The optional eighth `createDiagnosticApi` argument is a `PbxEndpointSource`.
The local launcher separately loads ignored
`.local-proof/pbx-status/endpoint-connections.json`, with the same connection
schema/TLS constraints as core status but distinct `endpoint-reader` credentials.
Absence leaves endpoint visibility explicitly unavailable. Never replace the
reporting-only core-status mapping with the broader account.

The existing `Test-PbxStatusProof.ps1` fixture now provisions distinct endpoint
credentials and two synthetic endpoints per PBX: one without contacts and one
with a static contact. It modifies only this isolated fixture, not existing PBXs.
`-WithIdentity` additionally verifies Alice and Bob's own-customer endpoint
snapshots, durable audit correlation, foreign-scope denial and logout replay
denial through real browser sessions. AMI unit tests cover fragmented Unicode,
zero/exact-limit/over-limit lists, duplicate IDs, malformed state, wrong counts
and missing completion; API/browser tests cover permission/audit gating, safe
allowlisted output and hostile-looking endpoint names.

The same fixture additionally publishes synthetic SIP only on loopback UDP ports
15060/15061 and provisions separate per-customer digest-auth secrets in ignored
`.local-proof/pbx-status/registrations.json`. It checks those ports before startup.
The registration probe uses bounded, retransmitted REGISTER transactions—no calls
or RTP—and verifies for each customer:

- An unauthenticated REGISTER receives a 401 digest challenge.
- The other customer's secret cannot register the endpoint.
- A valid authenticated REGISTER succeeds and the AMI snapshot gains a contact.
- The other customer's dynamic endpoint remains without contacts.
- Authenticated unregister (`Expires: 0`) removes the observed contact.
- A second registration requests a five-second lifetime and disappears naturally,
  with no refresh, unregister or other SIP transaction during observation.
- The configured endpoint remains listed and its static-contact neighbour stays
  present throughout.

Only this synthetic fixture lowers the AOR minimum lifetime to five seconds; its
default and maximum are sixty seconds. The probe checks the successful response's
Contact expiry (four or five remaining whole seconds), observes initial contact
presence, rejects premature disappearance with a one-second rounding allowance,
and allows up to forty seconds for natural removal including the registrar's
periodic cleanup sweep. Every observation also checks the other customer's dynamic
endpoint remains contact-free and both static neighbours remain present. AMI
observation is bounded test polling, not a new application polling behaviour.

The dynamic fixture AOR also enables OPTIONS qualification once per second with a
half-second timeout. A third, sixty-second registration uses a loopback SIP socket
inside the owned customer container: host-loopback Docker UDP forwarding does not
reliably carry new PBX-originated OPTIONS requests back to the host client.
A test-only Python UDP bridge, controlled through `docker compose exec` standard
input/output, permits only that container's `127.0.0.1:5060`. It adds no host port,
container image, application Docker access or production configuration.

For each customer the probe answers real OPTIONS with 200, then deliberately
stops answering, then resumes. The same AMI source must observe `Not in use`,
`Unavailable`, and `Not in use` again, each within fifteen seconds, while the
contact remains present. Packet counters verify fresh OPTIONS traffic, no REGISTER
is sent between these states, foreign dynamic contacts stay absent and both static
contacts remain present. The probe explicitly unregisters and closes its bridge;
the owned fixture is removed on failure. This demonstrates why contact presence
alone is not reachability. It is synthetic SIP signalling acceptance, not audio,
WebRTC, trunk or production-network health acceptance.

Successful and cleanup unregister transactions are checked explicitly; the owned
fixture is removed on failure. This proof exercises dynamic contact transitions
through the real adapter, not browser registration controls. It does not add
registration/mutation routes, save SIP credentials in the browser or make static
contacts into proof of registration. WebRTC registration and audio-path acceptance
are outside this increment. Tested expiry of a synthetic
dynamic contact does not make every contact a current or reachable registration.

#### Isolated per-lease SIP credential/revocation proof

Next architecture: the [customer-local provisioning worker plan](./AGENT-PROVISIONING-PLAN.md)
defines a proposed narrow authenticated worker boundary, durable operations,
reconciliation and call-drain gates. It is a plan, not an implemented provisioning
service; the web application has no Docker/config-file provisioning access.

`Test-PbxStatusProof.ps1` now also runs
`tests\identity\pbx-device-credential-proof.ts`. For each customer it acquires a
real backend SQLite device lease, generates a fresh `lease-<lease UUID>` SIP
username and 256-bit random secret, and installs a temporary endpoint/auth/AOR in
only the owned fixture's PJSIP configuration. The context has no call-routing
rules. Provisioning uses fixture-owner Docker CLI access, **not** application AMI
credentials or a new application mutation endpoint. Browser activation stays off.

Real challenged REGISTER transactions verify authentication denial before
provisioning, foreign-PBX denial, wrong-secret denial and successful registration
after provisioning. The accepted contact lifetime is four or five remaining whole
seconds for the requested five seconds. AMI confirms the lease endpoint's contact
and customer isolation while unrelated static contacts remain present.

Two cycles exercise explicit lease release and real wall-clock backend lease
expiry. The expiry cycle uses the default backend clock and waits for an actual
60-second lease, with a monotonic elapsed-time assertion. A fixture-owner scheduler
is armed after provisioning and reads current ownership through a separate SQLite
connection at intervals of at most 250 milliseconds. Thirty seconds into the
lease, the test explicitly renews backend ownership once, extending its deadline
by at least thirty seconds. SIP registration and the same backend lease ID must
remain valid at least one second past the original deadline. The scheduler reads
the persisted renewed expiry rather than revoking from its initial snapshot.
Apart from that one explicit backend renewal, the client refreshes only its
five-second SIP registration up to shortly before the renewed deadline.
The scheduler verifies backend renewal is
rejected, removes the temporary endpoint/auth/AOR and reloads PJSIP, completing
no earlier than renewed expiry and within ten seconds afterward. At least
89 real seconds must elapse from acquisition. The test checks no
REGISTER/unregister is sent while waiting for the final timer completion.
The endpoint must then disappear from the real AMI listing.
Previously issued credentials must receive SIP authentication denial, rather than
merely timing out. The CLI contact inventory must lose the retired contact within
a further 40-second cleanup bound without a client unregister; a new lease uses
a different username/secret, rejects the previous secret and does not resurrect
the previous identity. Original configuration is restored in `finally`; temporary
lease storage is removed and the owning runner tears down its PBX volumes.
The existing registration/qualification proof shares the same bounded digest
REGISTER client to avoid divergent test authentication logic.

This proves a **fixture-controller release and scheduled expiry revocation
sequence**, not native secret expiry at Asterisk. Removing a lease row alone does
not revoke SIP access. Pending timers are cancelled and settled before restoring
the original configuration during cleanup, so they cannot overwrite restoration.
There is no production credential issuer, reconciliation worker, protected secret
delivery, atomic lease/PBX transaction, scheduler restart recovery, multi-lease
reconciliation or SIP call fencing. The proof scheduler handles one known lease
with one explicit renewal; it is not an application worker or persistent queue.
Storage/corruption errors fail the proof instead of being mistaken for expiry.
Contact expiry/endpoint disappearance does not prove active dialogs are drained
or terminated. WSS/TLS browser delivery, extension-to-lease routing, shared-extension
conflict safety and the agreed stop-new-offers/finish-current-call sign-out policy
remain prerequisites before enabling a phone.

#### Durable provisioning intent store (backend only)

`src/agent-provisioning-store.ts` begins stage A of the
[worker plan](./AGENT-PROVISIONING-PLAN.md). `openAgentProvisioningStore` uses a
separate absolute-path SQLite database (schema 2, FULL synchronous, DELETE journal,
250ms busy timeout). It is not opened by the launcher or connected to any HTTP
route. There is no worker, dispatcher, secret storage, PBX adapter or new privilege.
Diagnostic and assignment backups do not include this database.

Trusted backend methods:

- `enrol(customer, epoch)` explicitly binds a customer to one authority UUID.
  Exact enrolment repeats are harmless; changing an enrolled epoch is rejected.
  Epoch rotation and backup-restore fencing are intentionally not implemented.
- `enqueue(command, context)` validates an exact version-1 command envelope:
  operation UUID, customer, epoch, positive revision, lease UUID, future Unix-ms
  `notAfter`, fixed action and allowlisted payload. `prepare` carries generation
  UUID plus numeric extension; `activate`, `extend`, `drain`, and `revoke` carry only
  a generation UUID. Passwords, paths, extra fields and arbitrary commands are
  rejected. This is data validation, not a generation/phone lifecycle validator.
- The intent, canonical SHA-256, accepted time, request UUID, asserted actor/reason
  and customer revision increment commit in one `BEGIN IMMEDIATE` transaction.
  Revisions start at 1 and must be contiguous per customer/epoch. The intent row
  itself is the outbox item; it cannot be committed without its audit context.
- An exact operation retry returns the original intent and context without a
  new revision or audit entry; different payloads conflict. Retrying after
  `notAfter` still retrieves the original intent for reconciliation, **not**
  renewed authority to dispatch it. Operation IDs are globally unique.
- `operation(customer, operationId)` returns a detached scoped intent and receipt
  history, or `undefined` for an unknown/foreign-customer operation. Absence does
  not prove a remote effect never occurred.
- `record(customer, operationId, receipt)` appends an asserted worker stage using
  a unique receipt UUID, contiguous per-operation sequence and bounded code.
  Initial stages may be `applying` or `uncertain`; applying may become verified,
  failed or uncertain; uncertain may become applying, verified or failed.
  Verified/failed are terminal. Exact receipt retries reconcile without duplicate
  rows; changed content, gaps and terminal transitions fail explicitly.
- `pending(customer, limit)` returns up to 100 nonterminal intents in revision
  order, including applying/uncertain operations and expired intents requiring
  reconciliation. Terminal receipts remain accessible by exact lookup. Pending
  is not permission to apply later revisions after an earlier failed/uncertain
  operation; use the ordered-head contract rather than treating this as a queue
  of independently executable work.

Reads validate canonical command/context data, hashes, scope, receipt structure
and transitions. Pending scans validate visited rows before skipping terminal
operations; output is bounded, but history-scan cost is not yet capacity-tested.
Multi-statement reads use a consistent transaction. Malformed data, lock contention,
closed storage and unsupported/foreign schemas fail rather than return empty
success. Hashes are integrity checks, not signatures or tamper-proof audit.

The caller must independently authenticate the actor/worker, verify current
session/permission/assignment/lease, enforce generation/extension lifecycle and
cap deadlines before enqueue or receipt ingestion. Stored receipt stages are
trusted assertions, not proof of a verified PBX until a real adapter and receipt
boundary exist. No operation is automatically applied. Existing lease HTTP audits
and reservation behaviour are unchanged.

`node --test .\tests\agent-provisioning-store.test.ts` verifies reopen/reconciliation,
exact/conflicting retries, customer/authority/revision isolation, receipt history,
atomic rollback of intent/context/revision, lock failures, malformed/secret-bearing
input, corrupt data and four competing processes producing one revision winner.
Stage A still needs application integration, authenticated worker journal/receipt
contracts and recovery/fencing acceptance before any PBX dispatch.

#### Customer-pinned worker journal (no execution)

`openAgentProvisioningJournal` reuses the validated intent/receipt engine in
`src/agent-provisioning-store.ts` but opens a **different database** from the backend
outbox. Its initial customer/epoch binding is committed locally and cannot be
changed by commands or subsequent opens. It rejects an already-enrolled backend
database, and a bound journal cannot be reopened through the backend store API.
It exposes no authority-enrolment or arbitrary-customer lookup method. Binding
is operator configuration, not remote authentication; protect local database access.

- `accept(command, context)` requires the pinned customer/epoch and the same
  strict envelope, hash, revision and exact-retry rules as the backend. It stores
  acceptance only. The receiving caller must authenticate the controller first;
  actor/context values are still trusted assertions.
- `operation(operationId)` retrieves the pinned customer's exact intent/history.
  Retry reconciliation does not create a new generation or extend authorisation.
- `next()` examines revisions in order. Verified commands may be passed over;
  the first unverified command is returned as `ready` (unstarted and unexpired),
  `expired`, `reconcile` (applying/uncertain) or `blocked` (failed). With all
  revisions verified it returns `idle`. Gaps, invalid authority, corrupt rows and
  invalid clocks throw. Interrupted applying work is never automatically “ready.”
- `record(operationId, receipt)` atomically checks the ordered head and appends a
  valid transition. Later revisions cannot start until preceding ones are
  verified. Entering/re-entering applying at or after `notAfter` is rejected.
  Exact historical receipt retries remain harmless, including after a later
  revision becomes the head. Uncertain/failed/verified observations can still
  be recorded after expiry to reconcile an earlier effect; they do not authorise
  endpoint activation. Failed heads require a future explicit recovery policy:
  there is no silent skip, reset or epoch rotation.

Reopen preserves the binding, command order, interrupted stage and receipts.
Four competing worker processes with different applying receipts produce exactly
one accepted start record. This is **not** an exactly-once execution claim:
recording a receipt has no PBX side effect, identical delivery may be retried,
and crashes still require runtime reconciliation. The executor ownership lock
below serialises participating local executors; it is not runtime fencing.
There is no local expiry enforcement, credential storage or PBX adapter in
the journal itself. The optional mTLS transport below does not execute work.
A journal deadline check at
start cannot cancel an external side effect occurring later.

`node --test .\tests\agent-provisioning-journal.test.ts .\tests\agent-provisioning-store.test.ts`
covers durable scope/authority pinning, backend-file misuse, ordered stages,
restart reconciliation, exact retries, failed-head blocking, exact expiry,
clock/lock/receipt failures, revision gaps and cross-process contention.
Stage A remains incomplete until authenticated transport/receipt integration,
application ownership validation and recovery acceptance are implemented.

#### Worker report reconciliation (in-process contract)

The journal's `report(operationId)` exports only
`{ version, customer, epoch, operationId, revision, sha256, receipts }`. It contains
no command payload, actor/reason, lease/device/session identifiers or credentials.
An unknown operation returns `undefined`, not a fabricated empty report. Reports
are detached snapshots validated through the same stored-data checks as exact
lookup. Version 1 permits at most 100 receipts per report; a longer journal history
fails explicitly instead of truncating it. Pagination is not implemented.

The backend's `reconcile(workerBinding, report)` requires a separately supplied
expected customer/epoch, then matches the existing intent's operation UUID,
customer, epoch, revision and canonical command SHA-256. The caller must derive
that binding from trusted configuration/authenticated worker identity, **not**
copy it from the received report. This parameter is not itself authentication.
There is no HTTP receipt-write route. The optional mTLS transport below carries
readback reports; it does not make the in-process binding parameter an authenticator.

The complete report must have valid contiguous stages and distinct receipt IDs.
Its shared history must exactly match the backend's existing prefix. New receipts
are appended together in one transaction; malformed or conflicting history, a
duplicate ID in another operation, a locked database or a late insert failure
cannot leave a partial batch. The result is `{ inserted, unchanged }`, counting
new entries and the matching overlap. Exact repeat delivery is harmless.
A delayed report containing an older exact prefix is also harmless: it inserts
nothing and never deletes newer local receipts. Divergent history fails.

Reconciliation is allowed after the command deadline because it records an
observation of earlier work, not renewed authorisation to dispatch. A terminal
worker report can resolve the backend pending entry after a lost response or
process restart without issuing a new operation. Neither hashes nor receipt
stages establish worker authenticity or actual PBX verification. Missing worker
history after an unintended restore cannot be diagnosed from a shorter prefix
alone; authority/recovery fencing remains a later gate.

`node --test .\tests\agent-provisioning-reconciliation.test.ts` checks separate-file
restart/lost-response recovery, exact and delayed reports, detached/allowlisted
output, scope/hash/revision conflicts, malformed histories, lock contention and
mid-batch rollback/retry. No dispatch, runtime side effect, secret handling or
phone activation is introduced.

#### Single-step provisioning dispatcher (injected transport only)

`src/agent-provisioning-dispatcher.ts` provides an opt-in, in-process coordinator.
Nothing starts it in the launcher or HTTP API. Its injected transport must
authenticate the configured customer/epoch worker. The optional mTLS
implementation below supplies a client/listener, not a retry loop or executor.

`store.next(customer, epoch)` validates the enrolled authority, scans contiguous
revisions and returns the same ordered-head states as the journal. Only verified
heads are skipped. Unlike the pending view, a failed head blocks later revisions.
An unknown authority is an error, not an empty queue.

Each `dispatch()` handles at most one operation:

- Query the worker's report before sending anything. An existing report is
  reconciled against that exact operation, including after expiry. No accepted
  command is automatically executed or restarted.
- If the worker has no operation, require no local receipt history, recheck the
  backend head/history and deadline after the asynchronous query, then send the
  original intent for durable acceptance. Never infer “missing” from a transport
  exception. A missing remote operation with local receipts fails explicitly.
- Reconcile the returned report transactionally. Return `accepted` for empty
  receipt history, `reconcile` for applying/uncertain, `verified` or `blocked`
  for terminal stages, or `expired`/`idle` when appropriate. These describe
  assertions/journal state, not registration, media or lease readiness.

Calls share a five-second abort signal across query and acceptance. The transport
must honour cancellation; this is a cooperative budget, not a forced interruption
of an uncooperative adapter. Errors and timeouts propagate, release the local
in-flight guard and never produce a success result. Another explicit attempt
queries the same operation first, so a lost acceptance response does not require
creating a replacement UUID. There is no automatic retry or process-level lock:
multiple coordinator instances may send the same immutable command, and worker
acceptance must remain idempotent. This is not exactly-once execution.

Deadline checks are not live lease/session revalidation or recovery fencing. A
worker restore that loses accepted history without any backend receipts is still
indistinguishable from first delivery, so no real adapter may be enabled on this
contract alone. Application authorisation, authenticated transport, autonomous
expiry, recovery/authority fencing and runtime verification remain gates.

`node --test .\tests\agent-provisioning-dispatcher.test.ts` covers ordered delivery,
failed-head blocking, lost-response recovery with a fresh coordinator after
expiry, foreign reports/authority, deadlines racing queries, missing/changed
history, invalid clocks, transport failure, cooperative timeout and local overlap.

#### Customer-pinned mutual-TLS journal transport (no executor)

`src/agent-provisioning-https.ts` provides explicit factories for an HTTPS client
and a journal-only HTTPS server. Neither is wired into the launcher, web routes
or any default listener. The caller owns the listener, journal and shutdown.
This establishes part of the stage B transport boundary, **not** stage B completion
or approval to enable real effects; stage A application/recovery gates also remain.

Each side requires its own certificate/private key, an explicit CA and one
operator-configured uppercase SHA-256 peer certificate fingerprint. TLS 1.2 or
later, normal chain/expiry checks and client certificate authentication are
mandatory. The client additionally checks the worker hostname and pinned leaf
certificate before HTTP bytes are sent. The worker requires a trusted client
certificate and checks the pinned controller leaf before any journal access.
A different CA-signed controller gets 403; missing, untrusted or expired client
certificates fail TLS. No bearer token, forwarded identity or browser cookie is
accepted as an alternative. Certificates/keys are injected by the owning process,
never commands or generated repository configuration.

The client accepts a fixed HTTPS origin without user info, path, query or
fragment; per-call endpoints and TLS overrides are not supported. The only
worker routes are:

- `GET /v1/operations/{UUID}`: allowlisted report, or the exact missing-operation
  response. No arbitrary customer selector or receipt-write endpoint exists.
- `POST /v1/operations`: exact `{ command, context }` envelope, validated before
  journal acceptance. The pinned journal checks customer/epoch, command hash,
  deadline and revision; success returns its report with no apply action.

Requests require JSON, reject compression/extra fields and are bounded to 8 KiB
with a five-second body budget. Client responses are limited to 32 KiB, require
uncompressed JSON and strict report shape, and do not follow redirects. Only the
exact GET 404 missing-operation code becomes `undefined`; other statuses,
malformed responses, disconnects and TLS failures reject. The client honours the
dispatcher's abort signal and has an additional five-second socket timeout.
Worker headers/requests have finite timeouts and connections close after replies.
Input/conflict responses are sanitised; storage/unexpected errors return a generic
500 and are passed to the mandatory owning-process error callback, never replaced
with an empty report.

The worker is bound by its local journal and controller pin. The backend must
associate the worker certificate/origin with its configured customer/epoch; the
dispatcher reconciles returned reports against that binding and stored intent.
Protect configuration and local files. There is no certificate enrolment,
rotation overlap, revocation distribution, deployment service, runtime fencing,
PBX adapter, disconnected expiry enforcement or restore fencing yet.
Changing certificates requires explicit reconfiguration/restart; do not bypass
verification to rotate them.

`node --test .\tests\agent-provisioning-https.test.ts` generates an ephemeral CA
and leaf keys in memory using PowerShell 7/.NET. Real loopback TLS tests cover
valid dispatch/readback, exact retry, foreign customer, extra/unsafe fields,
oversized/malformed input, nonexistent routes, storage-error reporting, missing/
foreign/untrusted/expired clients, and worker chain/expiry/hostname/pin rejection
before HTTP requests. Client tests also cover response bounds, redirects,
truncation and cancellation. No trust-store modifications or persisted private
keys are used; owned servers and temporary databases are closed/removed.

The same suite also proves restart recovery across separate backend, worker
journal and fake-runtime SQLite files. An initial command is accepted over real
mTLS. A child Node executor then exits abruptly (without running its cleanup)
at one of three cuts: after the applying receipt but before the fake effect,
after committing the fake effect, or after observing it but before the completion
receipt. The fake effect is only an immutable operation/command row, not a PBX
configuration or credential.

Both coordination stores reopen after the command deadline. A new mTLS listener
and dispatcher read back the durable applying receipt, then the executor only
observes the separate fake-runtime row. Existing effects verify and reconcile
back to the backend; missing effects stay uncertain. Repeated steps/readback
neither replay apply nor duplicate effects/receipts. This combines transport,
ownership crash release, durable evidence and post-expiry recovery, but does not
model power loss, journal restore, autonomous revocation or an actual PBX.

#### Single-step worker executor (fake-adapter proof only)

`src/agent-provisioning-executor.ts` provides a separately invoked `step()` over
the pinned journal and an injected `apply(command, signal)` / `observe(command,
signal)` adapter. No runtime adapter ships, no HTTP route starts execution, and
no launcher, background loop, shell, Docker, file reload or SIP secret is added.
The tests use only fake effects; this is not permission to attach a PBX adapter.

- Unstarted unexpired work first commits a fresh `applying` receipt. Only a
  successful commit permits the adapter call. Each command is passed as a detached
  copy, without its actor/reason context.
- After apply, observation must explicitly return `verified`, `failed` or
  `unknown`. Apply returning successfully alone does not mean verified.
  Unknown becomes `uncertain`; repeated unknown observations do not append
  duplicate stages or exhaust the 100-receipt report limit.
- Applying/uncertain work is **observation only**, including after process reopen,
  cancellation, apply error or failed completion commit. There is no automatic
  replay, even if the effect might never have started. Unknown state blocks later
  revisions pending explicit future recovery policy.
- Verified observations allow later work on the next explicit step. Failed
  observations append a terminal failure and block later revisions. Expired
  unstarted work never reaches the adapter; observation after expiry can reconcile
  an earlier effect but cannot renew authorisation.

Apply and observation share a cooperative five-second abort budget, optionally
combined with caller cancellation. Apply additionally receives a signal capped
to the remaining command authorisation time, checked before and after the
applying commit and again when apply returns. Expiry before the commit returns
`expired` without a receipt; expiry after it throws and preserves `applying` for
observation-only recovery. A timed-out/expired apply does not proceed directly to
observation in that attempt. A later explicit step can still observe after expiry
under its own five-second budget, but cannot replay or extend the command.
The optional executor `now` clock must use the same epoch-millisecond time basis
as journal deadlines (production defaults to `Date.now`); invalid clocks fail.
The relative abort timer does not track later wall-clock jumps: clocks must be
maintained reliably and adapters must recheck deadlines at the actual side-effect
boundary. Post-apply checking catches an observed forward jump, not an effect
that already happened.

Exceptions, invalid observations, cancelled
work and storage failures propagate to the caller; no catch converts them to
success or a fabricated terminal receipt. Durable applying/uncertain evidence
survives for subsequent observation. Adapter cancellation must be honoured;
a deadline check cannot forcibly stop an external effect occurring later.
Observation is a trusted adapter assertion, not independently established proof.

A shared in-process guard rejects overlapping steps using the **same journal
object**, including through another executor instance. The local SQLite ownership
lock below also excludes separate participating handles/processes. Runtime
fencing, autonomous expiry, live lease validation and restore recovery remain
unimplemented. Never use journal receipt uniqueness or execution ownership as an
exactly-once execution guarantee.

`node --test .\tests\agent-provisioning-executor.test.ts` checks all five fixed
actions, commit-before-apply, observation-only restart at both sides of an effect,
failed initial/completion writes, detached commands, expiry, uncertain/failure
blocking, bounded receipt growth, errors, invalid observations, cancellation,
same-object overlap and the real five-second timeout. The mTLS integration test
also runs a fake step and reconciles its verified report back to the backend.
Additional deadline tests check exact expiry and invalid clocks, expiry racing
the applying commit/return, and real sub-second apply cancellation while ownership
remains held until the adapter settles, followed by observation-only recovery.
Stage B remains incomplete; no real phone capability is enabled.

#### Cross-process worker execution ownership (local SQLite only)

Every executor step now runs inside `journal.exclusive(callback)`. It opens a
dedicated SQLite sidecar at the journal's canonical `realpath` plus
`.executor-lock.sqlite` and holds `BEGIN IMMEDIATE` for the complete asynchronous
step: head read, applying commit, adapter work, observation and result receipt.
The intentionally empty/unversioned sidecar stores no receipt, owner PID,
deadline or authority. Contention fails immediately rather than queuing a stale
execution attempt. Foreign schemas, unsupported versions, corruption and
filesystem errors fail before adapter entry; no repair or bypass is attempted.

This is a separate database so journal readback, acceptance and receipt writes
do not share the long-lived ownership transaction. Separate customer journal
files have independent locks. Normal completion, callback errors and cancellation
release ownership in `finally`; SQLite/OS process cleanup releases it after a
crash without deleting or guessing stale PID files. The sidecar file remains.
Cancellation/timeouts are still cooperative: ownership is held until the adapter
promise actually settles, not released while an effect might still be running.
Recovery then observes the durable interrupted stage; it does not replay apply.

All executors must use the same protected local journal/sidecar and participate
in this lock. Do not remove, replace, relocate or restore either file while
workers are live. Canonical path resolution handles ordinary path aliases, not
hard-linked journals or copies. Network filesystems, multiple hosts, privileged
manual journal mutation, copied/restored journals and effects that outlive their
process are outside this guarantee. This is not a distributed lease, a runtime
generation fence, persistent adapter ownership or exactly-once execution.
Deployment/recovery controls remain required before enabling real PBX effects.

`node --test .\tests\agent-provisioning-ownership.test.ts` exercises competing
handles, actual competing processes, forced owner-process termination followed
by observation-only recovery, cancellation with a still-running adapter,
independent customer execution, concurrent journal access, callback-error release
and foreign/unsupported/corrupt/externally locked sidecar failures.

#### Disconnected-expiry drain sweep (fake-runtime proof)

Selected policy: stop new calls/offers at expiry, let existing calls finish and
block replacement while draining. There is no automatic forced-hangup timeout.
Unknown dialog state must remain blocked, not be treated as zero dialogs.

`src/agent-provisioning-expiry.ts` supplies an explicitly invoked `sweep()` with
an injected customer-pinned inventory/fence/observe/revoke adapter. It uses the
same local execution lock and a cooperative five-second budget. All inventory
entries (maximum 100, unique generation UUIDs) are validated before effects.
Only expired or already-draining generations are selected. For each it:

1. Requires an idempotent, durably latched new-call fence.
2. Reads back the fence and exact generation's dialog state.
3. Returns `draining` for active dialogs or `uncertain` for unknown dialogs.
4. Revokes only after a verified fence and zero dialogs, then verifies removal.

Errors, unverified fences/removal, malformed observations and cancellation
propagate. No forced hangup, silent repair or replacement activation occurs.
The adapter must preserve the drain latch across restart and prevent extensions
or clock rollback from reactivating it. Revocation must atomically enforce the
zero-dialog precondition at the real side-effect boundary; an observation alone
cannot prevent races with signalling. The sweep does not implement that adapter.

`node --test .\tests\agent-provisioning-expiry.test.ts` uses a separate durable
SQLite fake runtime to check expiry, active-call preservation, unknown dialogs,
restart/clock rollback, eventual removal and untouched unexpired generations.
It also covers inventory rejection, fence/removal failures, cancellation and
ownership contention. No scheduler is started by default; the explicit monitor
below proves controller-independent scheduling only against a fake runtime.
Real routing/dialog correlation, replacement blocking,
inventory completeness, expiry lag limits and crash/race-safe PBX removal remain
acceptance gates. No PBX privileges, credentials or browser calling are added.

#### Explicit expiry monitor (fake-runtime scheduling proof)

`runAgentProvisioningExpiry(expiry, signal, onSweep)` immediately performs a sweep,
awaits its mandatory async reporting callback, waits 250 ms, and repeats. Sweeps
and callbacks never overlap; there is no catch-up burst or unbounded work queue.
The supplied abort signal cancels both sweep work and the between-pass timer.
The returned lifetime promise rejects on cancellation, adapter/storage errors,
ownership contention or callback failures. The owner must await it and surface
failure; the function does not silently retry or imply continued protection.
No launcher, web route or service starts it automatically.

Shutdown waits for active adapter work to actually settle before releasing its
execution lock. As with a sweep, an adapter ignoring cancellation can delay
shutdown indefinitely. Reporting callbacks must also be bounded by their owner;
a blocked callback delays the next pass. The 250 ms pause is not a guaranteed
expiry lag: sweep duration, callback latency, scheduling and lock contention all
matter. Running a separate executor against the same journal can make the
monitor fail immediately on ownership contention. A production single-owner
coordinator, health supervision and measured worst-case expiry limits remain
required; this monitor alone is not a deployment-ready worker.

`node --test .\tests\agent-provisioning-expiry-monitor.test.ts` proves real-time
expiry without a controller or network client against a durable SQLite fake
runtime: fencing is not early and occurs within one second in the idle fixture,
an active call is preserved, then removal follows call completion. Further tests
cover serial timing, callback/adapter failures, pre-cancellation, shutdown while
waiting and ownership retention during an unsettled adapter. All test monitors
are awaited and stopped; no long-running process is left behind.

#### Durable fake generation lifecycle (test-only)

`tests/identity/fake-provisioning-runtime.ts` is a reusable SQLite fixture with
separate execution and expiry adapters over the same durable state. Its database
is pinned to a customer/epoch and separate from both backend intents and worker
receipts. All five fixed actions commit generation changes and an immutable
operation/effect row together; exact retries do not repeat effects and changed
operations fail. Its observation verifies recorded fake command effects, **not**
current registration, media readiness or continued live authorisation.

The fixture deliberately models **one generation slot per customer**, not the
eventual multi-agent allocation design. Prepare cannot replace any existing
nonremoved generation. Prepared state denies calls; activation permits simulated
calls only before its deadline. Extension cannot shorten that deadline or
reactivate expired/draining state. Drain is irreversible. Revoke checks the
durable drain latch and zero known dialogs in the same transaction as removal.
Unknown/active dialogs block removal and replacement. After verified removal a
fresh generation may prepare. No PBX configuration, SIP authentication, real call
or lease/session validation is involved.

`node --test .\tests\agent-provisioning-lifecycle.test.ts` exercises executor-driven
prepare/activate/extend, surviving the old deadline, restart, expiry with an active
call, denied new calls, blocked replacement/extension, unknown-dialog recovery,
clock rollback and eventual removal before replacement. It also covers explicit
drain/revoke, exact/conflicting retries, foreign scope/authority, expired input,
and two local handles attempting replacement (not a multiprocess race proof).
The real-time expiry monitor test reuses this adapter rather than a separate
hand-written generation model. This supplies repeatable stage B fake-runtime
evidence only; production allocation, replacement fencing and Asterisk enforcement
remain unimplemented.

#### Worker health and fail-stop supervision (opt-in)

`createAgentProvisioningWorkerSupervisor(journal, adapters, { stallAfterMs })`
wraps the serial worker lifetime below. It starts no listener, process, watchdog
or retry loop. Call and await `supervisor.run(signal, onCycle)` once; its original
error/cancellation is still rejected to the caller, which must handle it through
its operational logging/alerting path. A second run is rejected, including after
failure or cancellation. No automatic restart or effect replay is introduced.

`supervisor.health()` returns a detached, allowlisted process-local snapshot:

```typescript
{
  state,           // idle | running | stalled | stopping | stopped | failed
  phase,           // null | expiry | execution | reporting | waiting
  phaseAgeMs,      // monotonic elapsed time in the current phase; zero when settled
  completedCycles, // only cycles whose reporting callback returned successfully
  stopRequested
}
```

The caller must supply a finite positive `stallAfterMs`; there is no implicit
production expiry-lag threshold. At exactly that elapsed phase age an unsettled
lifetime is `stalled`. Before that threshold, requested cancellation is
`stopping`; after it, `stalled` plus `stopRequested: true` preserves visibility
of an uncooperative shutdown. The default health clock is monotonic
`performance.now()`, separate from the wall clock used for command expiry.
An optional `monotonicNow` is for controlled tests and rejects invalid/backward
readings. A later phase resets the age, so a stall can recover naturally without
starting a new worker.

After the awaited lifetime settles, `stopped` means caller cancellation propagated
as the original reason or its standard `AbortError` wrapper; unrelated failures,
even concurrent with cancellation, remain `failed`. The last phase is retained
for diagnosis. No error messages, customer identifiers, commands, tokens or
runtime adapter data are copied into health snapshots. The original rejection
still carries failure details for the caller's protected error handling.

Health is **responsiveness evidence, not PBX readiness or expiry protection**.
Even `running` may have an expired/blocked head, uncertain receipts, or draining
dialogs; cycle results and adapter verification remain separate. `failed` means
this lifetime no longer performs expiry sweeps. A stalled effect keeps its
execution lock until its actual promise settles; observation never frees the
lock, kills the process, cancels an effect, or starts another sweep concurrently.
Long inventory sweeps can legitimately exceed a chosen threshold, so operators
must choose and measure it for their deployment.

The worker tests cover exact threshold boundaries, a real-time held inventory,
each active phase, reporting counts, concurrent cancellation/failure, single-use
behaviour and lock retention. The disconnected mTLS fake-worker proof now uses
this supervisor and confirms local cycles continue with the controller listener
offline before explicit shutdown.

This is in-process fail-stop observation, not a deployed supervisor or public
health endpoint. A dead process or blocked event loop cannot answer a health
query; an independent monitor/service manager and a separately designed safe
failure response are still required. Snapshots are not persisted or published
automatically. No production worker, Asterisk adapter or browser calling is
enabled.

#### Serial worker lifetime (injected adapters, off by default)

`src/agent-provisioning-worker.ts` exposes `runAgentProvisioningWorker(journal,
adapters, signal, onCycle, options)`. It composes the existing expiry monitor and
executor using the same journal and clock. Each pass awaits:

1. An expiry sweep, including fence/dialog/removal verification.
2. At most one ordered execution or observation step.
3. The mandatory async callback with `{ expiry, execution }`.
4. The existing 250 ms pause before the next sweep.

This avoids self-contention from running separate monitor/executor loops for the
same worker. It does not nest ownership locks: sweep and execution each acquire
and release the journal's sidecar lock. Another participating process may run
between those phases; this is not lifetime-exclusive service ownership. Do not
also start a standalone expiry monitor or executor on that journal. Contention
still rejects rather than silently retrying.

Expiry failure prevents that pass's execution. Cancellation is checked between
phases; exceptions from expiry, execution, storage or reporting reject the entire
awaited lifetime. The caller must supervise and alert on failure: a rejected loop
is no longer enforcing expiry. Nonthrowing `expired`, `blocked` or `uncertain`
execution results do not stop subsequent sweeps. Draining/uncertain expiry
observations are reported, not treated as permission to replace a generation;
the runtime adapter must enforce its own irreversible drain/replacement barrier.

An execution step may delay the next sweep by its cooperative five-second budget,
and an uncooperative adapter or reporting callback can delay it further. This
composition is not a production expiry-lag guarantee, runtime fence, restore
detector or live session/lease authorisation layer. No network listener, backend
dispatcher, supervision process or adapter is started implicitly. Only fake
adapters have been exercised; Asterisk privileges remain absent.

`node --test .\tests\agent-provisioning-worker.test.ts` verifies queued prepare/
activate, expiry preserving the current call, old-generation removal before
queued replacement, continued sweeps with an expired head, failure ordering,
interrupted-effect observation without replay, cancellation and lock release.

The mTLS suite additionally runs the real serial worker loop against the reusable
durable fake runtime. Backend prepare, activate and extend commands travel over
mutual TLS and verified receipts return through report reconciliation. The test
then closes the controller-facing listener before reading the extension's
completion: no transport is available, but the worker survives the old deadline,
fences at the renewed deadline within one second in the idle fixture, preserves
its active simulated call and removes the generation only after call completion.
A reopened backend and restarted listener recover the delayed receipt without
reissuing an effect. That historical `verified` receipt is **not** evidence the
now-removed generation remains active. The worker is explicitly cancelled and
awaited before fixture cleanup. This combines the stage B primitives, not a
production service: no real PBX, multi-host partition, restore detection, power
loss or production expiry-lag guarantee is established.

#### Live provisioning acceptance gate (opt-in backend integration primitive)

`src/agent-provisioning-authorisation.ts` wraps an existing authenticated transport
with `createAuthorisedProvisioningTransport`. It is not enabled by the launcher
and does not create an API or desired-state producer. For prepare, activate and
extend, acceptance requires:

- A protected backend resolver mapping the exact intent to its original owner,
  generation and assigned extension. Actor/reason fields are never authority.
- A live session matching the original session ID, subject and customer.
- A fresh agent-access decision for that issuer/subject/customer with direct
  membership, never a support grant or a different subject.
- A second session read after asynchronous access verification, plus a current
  validated assignment matching the resolved extension.
- The existing device lease store's exact owner/session/device/lease check, with
  the effective session deadline capped to both original and live expiry.
  Command `notAfter` must not exceed that lease deadline; it is rejected, not
  silently rewritten or extended.

Input and owner snapshots are detached before verification; the final assignment
and lease reads occur immediately before calling the underlying transport.
Errors and cancellations propagate without an acceptance or synthetic receipt.
Readback is not gated on a still-live browser session: historical recovery must
remain possible after logout. Customer/epoch-scoped drain/revoke commands also
remain available to the trusted controller after logout; this wrapper is **not**
their controller authentication, ownership validation or drain-policy boundary.

The mandatory resolver/session/access callbacks are trusted backend integration
points, not caller JSON. Resolve must bind the immutable operation/generation to
protected original ownership, and agentAccess must use the existing verifier for
`agent:access` under that identity. No durable resolver mapping or background
session lookup is supplied yet. Tests use the real lease persistence and injected
session/access/directory state; they do not prove a new real OIDC integration.
Raw session IDs/device IDs are not added to commands, reports or audit context.

This gate checks immediately before **dispatch acceptance**, not remote execution.
Logout/release after the check or after a command is accepted still requires
worker cancellation/drain and generation fencing; a distributed atomic check is
not claimed. Already accepted empty-history work can still execute later under
its stored deadline. Production wiring, atomic desired-state/ownership capture,
audit integration, worker-side execution fencing and restore protection remain
required. The unwrapped transport remains a low-level trusted primitive.

`node --test .\tests\agent-provisioning-authorisation.test.ts` covers dispatcher
integration, logout/session rotation, shortened expiry, lease release/expiry
during query or verification, assignment changes/removal, denied/foreign/support
access, missing/wrong owner mappings, deadline bounds, successful activate/extend,
cleanup after logout, errors/cancellation and absence of session/device data in
worker storage. Lease checks never acquire or renew reservations.

The mTLS integration suite now also wraps the real HTTPS transport with this
gate, using separate backend/journal/fake-runtime databases and the real device
lease store. Guarded prepare/activate/extend commands reach the worker and
execute through the durable fake adapter. A changed extension, logout or lease
release during verification prevents any POST to the worker and leaves the
operation absent from its journal, with no extra fake effect. Restoring the
assignment permits the unchanged pending renewal to proceed; historical receipt
recovery still works after logout. Worker storage contains neither raw session
nor device identifiers. Session/membership/directory state and protected owner
resolution remain fixture callbacks, not production OIDC or durable owner lookup.
This proves the gate's transport placement, not cancellation of work accepted
before ownership was lost.

#### Backend-only live session lookup

The application session manager now exposes `lookupIdentity(owner)` for trusted
backend consumers holding the original `{ issuer, subject, customer, sessionId }`.
It checks the configured issuer and exact stored identity, removes expired
sessions and returns only a detached `{ sessionId, subject, customer, expiresAt }`.
Unknown or foreign owners return `undefined`; malformed identity/session IDs
throw. No access token, CSRF value or confidential-client secret is returned.

The live gate's session callback can use `sessions.lookupIdentity(owner)` when
the owning application shares that session manager. This is not a new HTTP
endpoint and does not replace request Host, cookie or CSRF checks. Browser
bootstrap output remains unchanged and does not expose session IDs. Lookup is
only a session-liveness check, not fresh membership, assignment or lease
authorisation.

`node --test .\tests\application-session.test.ts` uses the existing local
signed-token OIDC fixture to check exact scope, detached results, rotation,
logout and real expiry, as well as an independent manager rejecting a still-live
session from another instance. The real-Keycloak fixture coverage is described below.
Sessions remain process-local: restarted or separate managers have no session
history and must deny lookup. Production application wiring remains needed before
background dispatch is enabled. The companion access check and durable
original-owner reference are described below; shared session persistence is not
enabled.

#### Session-backed agent access verification

`sessions.verifyAgentAccess(owner, verify, signal)` now supplies the companion
backend-only access check. It resolves the exact live owner, passes that session's
stored bearer token internally to the existing access verifier for `agent:access`,
then rechecks session liveness and identity after the await. Only the same subject
with direct membership may return allowed. Support grants and mismatched subjects
are denied; verifier denials/unavailability remain explicit and exceptions or
cancellation propagate. No token is returned to the consumer.

For an application sharing the session manager and its configured verifier, the
gate callbacks can be wired as:

```typescript
session: sessions.lookupIdentity,
agentAccess: (owner, signal) => sessions.verifyAgentAccess(owner, verify, signal),
```

`verify` must be the trusted verifier configured for this application's issuer,
audience and provisioned memberships, not caller-supplied code. Existing verifier
membership configuration remains immutable for its lifetime; this method does
not introduce dynamic membership reload, token refresh or issuer-side revocation
introspection. Cancellation is checked before and after verification, not forced
into the verifier's in-flight JWKS request.

The local signed-token session regression now connects these actual callbacks to
guarded dispatch and real lease/journal storage. It verifies direct membership,
denial, unavailable verification, cancellation, foreign owner rejection, and
logout/rotation/expiry races during verification.

`.\scripts\Test-IdentityProof.ps1` also runs a real Keycloak/browser proof of these
backend callbacks before the existing application-session browser tests. A
separate test-only listener reuses the approved confidential-client origin and
callback, closes before the application listener starts, and adds no production
route. The proof checks Alice's direct agent membership, Bob's denial, foreign
owner scope rejection and session rotation. Alice's renewed session then drives
guarded dispatch against real SQLite lease/backend/worker journals. Logout while
the real JWT verifier's result is deliberately held prevents another worker
delivery, while historical report lookup remains available. This proves the
post-await check, not an issuer-side revocation subscription or an atomic
controller/worker authorisation claim.

The real Keycloak fixture, identity browser proof, application-session proof and
launcher proof have passed together; the launcher tears down its owned identity
container afterward. This remains local fixture evidence, not production service
wiring. Production ownership capture, audit integration and post-acceptance worker
fencing remain gates. Real token/session expiry races remain covered by the local
signed-token regression, not this Keycloak run.

#### Python read-only conformance experiment (approved fixture only)

`.\scripts\Test-BrokerPeerProof.ps1 -Conformance` now runs the shared
TypeScript vector test followed by an isolated Linux Python experiment.
Both consume `tests/identity/broker-conformance.json`: the same 36 cases cover
inventory at the exact 8 KiB request limit, observed unknown dialogs, missing
generation, invalid JSON/version/UUID/scope, forbidden mutation/secret fields,
BOM, invalid UTF-8, zero/oversized length, truncation and trailing bytes.
Frames are sent in fragments. Successful replies must equal the same
language-neutral expected objects.

The Python server owns the actual accepted Unix socket, obtains kernel
`SO_PEERCRED`, checks the approved UID/primary GID before frame reads, enforces
length/UTF-8/EOF and validates fixture-supplied fake inventory/observations. The client
checks that valid requests receive no response before request EOF. Rejected
requests produce no success frame; final source-read/rejection counters are
checked by the parent. A foreign UID receives no source access, and the approved
identity reconnects after all cases. Server/clients run non-root without effective
capabilities in the same restricted owned-container setup as the original peer
proof. Both original and conformance proofs have passed.

Request versions use matching numeric semantics: `1`, `1.0`, `1e0` and `10e-1`
are accepted as version 1; booleans, strings, fractions and overflow are rejected.
Python parses request integers as floating-point numbers to match JavaScript JSON
number decoding, while explicitly excluding booleans. Shared wire-text vectors
preserve the integral/exponent forms rather than normalising them before send.
Independent source-entry counters require zero entries for each malformed
request and one for every valid request, including missing-generation readback.
Every source-output case enters the source once even when its output is rejected;
successful response counts remain separate. TypeScript checks the same counts.

Strict JSON syntax is also shared: Python explicitly rejects its decoder's
non-standard `NaN`, `Infinity` and `-Infinity` constants. Three regression cases
put each token in an earlier duplicate version field followed by valid version 1,
so rejection must happen during parsing, not merely final-field validation.
Both implementations require a JSON syntax error, zero source entries and zero
response bytes. A quoted `"NaN"` value overwritten by version 1 remains valid
JSON and succeeds, preserving the existing last-field-wins behaviour rather than
introducing a substring filter or a new duplicate-key policy.

Two shared timing cases send a complete valid inventory frame, hold request EOF
for 50 ms, and require no response bytes or server EOF during that interval. One
then half-closes cleanly and receives the expected inventory; the other appends
a trailing byte before half-close and must receive zero response bytes with zero
source entries. Both real Python and Node clients exercise these cases. The
TypeScript stream test additionally checks that the source has not been entered
at the end of the wait. This is a measured delayed-EOF subset, not proof of every
transport race or peer-disconnect behaviour.

Eight additional framing cases cover one-/two-/three-byte headers followed by
EOF, a valid inventory payload truncated by one byte, two concatenated complete
valid requests, and overlong/surrogate/incomplete UTF-8 payloads. TypeScript and
Python assert the relevant framing/decode failure category, not merely any JSON
rejection, and require zero source entries per case. A fresh approved readback
still succeeds after the corpus. The concatenated-frame case can close with a
read-side connection reset because the rejected connection contains unread
trailing data: that case alone accepts EOF or the exact read-reset error, always
with zero response bytes. No timeout, write error or other socket error is
accepted as its rejection. Other negative cases retain the zero-byte EOF check.

An additional 28 shared source-output cases run through TypeScript readback
and the authenticated Python socket server. They exercise valid empty inventory,
safe integer boundaries and unknown/zero dialogs, and reject duplicate or invalid
generation IDs, extra secret-like fields, missing fields, boolean/numeric type
confusion, fractional/unsafe counts and invalid deadlines. Python validates exact
field sets and the JavaScript safe-integer range before constructing a response.
Integral JSON numbers such as `1.0` remain valid in both languages. Invalid source
outputs close the connection without a response frame; valid replies match the
shared value exactly. Source cases are selected by trusted fixture sequence, not
by new client fields/actions. This does not add a dynamic PBX source adapter.

The inventory boundary cases expand trusted fixture-only `inventoryCount`
metadata into 100 or 101 unique generations. Zero-based indices form the
12-character hexadecimal UUID suffix, deadlines are index plus one, and draining
alternates starting with true. TypeScript and Python generate the same ordered
values. Exactly 100 entries must return intact through the bounded response
frame; 101 must close with zero response bytes after exactly one source entry.
The subsequent cases and approved reconnect still succeed, proving rejection
does not terminate the fixture server. The count metadata is never sent as a
request property and does not raise the production inventory limit.

This is the approved **experiment**, not a production Python runtime decision,
full protocol equivalence or a privileged broker. There is no dynamic source
adapter, durable operation ledger, apply method or production service. The shared-vector Python server
processes clients sequentially; the separate
admission experiment below tests held source/deadline behaviour. Its socket
deadline does not preempt blocked Python source code. Other TypeScript tests
still supply broader source/response/timeout/cancellation coverage; the shared
vector set is a tested subset, not proof of those features in Python.

Next acceptance work must address broader source/error/cancellation parity and
production client lifecycle integration, then container/namespace identity mapping.
No PBX probe or secret issuance is authorised by this experiment.

The conformance command now also runs a second non-root Unix-socket server
experiment with **one nonblocking admission slot**. A held idle request excludes
competitors and closes at its five-second deadline. An approved framed request
then enters a deliberately held fake source; the connection closes at deadline,
but a new competitor is still rejected until the original source is explicitly
released. A later approved readback succeeds. The experiment then injects a
typed fake-source exception during another approved request: no response bytes
are returned, the expected fixed diagnostic appears on server stderr, and the
slot is released so a fresh approved readback succeeds. Exact counters verify
nine source invocations (including two failures), five capacity denials, three
deadline closures and one explicit cancellation. Capacity is checked
before peer lookup/read, and accepted requests still require real kernel UID/GID.

This experiment uses a source thread, an independent connection deadline timer,
and a test-only parent control pipe to cancel a connection or release the fake
source. The pipe is not
a broker request/action or an operator API. Child processes, socket entries and
the container are cleaned up. A backlog of one is not a total kernel-resource
or connection-rate bound; threads/timers and the control harness are not a
selected production architecture. Unexpected fixture errors fail the proof
rather than returning a success frame.
The parent requires stderr to contain exactly the two expected source diagnostics,
so unexpected thread/timer tracebacks also fail the experiment. The source hook
and deterministic failure schedule are fixture-only; no client can select a
failure mode. This proves the injected inventory and generation failure/recovery cases, not all
source errors or disconnect races.

The cancellation case holds a new fake source and uses the private parent pipe
to close its connection. The client must receive EOF without response bytes
within three seconds (before the five-second deadline); another approved client
is still denied capacity until the source is explicitly released. A subsequent
approved readback succeeds. Cancellation and deadline closure share a
connection-bound, synchronised terminal callback so only the first closes/counts
the lifetime, and settled connections cannot be cancelled later. This proves
the tested owner-cancellation path, not automatic detection of peer disconnect
while source code is blocked, process supervision or production cancellation.

#### Cross-runtime Unix-socket conformance (approved test image only)

Build the separate test-only Node/Python image, then run the cross-runtime proof:

```powershell
docker build --tag asterisk-broker-cross-runtime:proof --file .\tests\identity\broker-cross-runtime.Dockerfile .\tests\identity
.\scripts\Test-BrokerPeerProof.ps1 -CrossRuntime
```

The Dockerfile pins the Node 24.11.1 Debian base by digest and installs Python
without copying project code. Building requires registry/package access; Debian
package versions are not snapshot-pinned. Running the proof does not build or
pull: the launcher resolves the existing local image to its immutable image ID.
The original diagnostics image and default/conformance modes are unchanged.

The new mode implies `-Conformance` and substitutes a separate Node process for
each sequential vector client. It imports the actual TypeScript frame reader and
writer, sends valid requests with request EOF, validates complete framed replies,
and requires zero response bytes for rejected requests. Malformed raw frames
deliberately bypass the writer. The two delayed-EOF cases use the production frame
encoder but explicit writes/half-close to control timing; ordinary valid requests
still use the production writer. All 36 request/framing and 28 source-output cases,
foreign-UID denial and approved reconnect pass over a real Unix socket against
the Python server. The admission/failure/cancellation experiment then runs with
Node clients too: idle connections reach the server deadline; timed-out held
sources keep capacity occupied; an injected source exception returns no bytes
and permits recovery; explicit owner cancellation closes the held request within
three seconds while competitors remain excluded until settlement. Every recovery
uses a new approved Node connection and the production frame reader/writer.
Negative/lifecycle clients require EOF with zero response bytes rather than
treating a locally timed-out client as successful rejection. Their eight-second
watchdog is longer than the server's five-second deadline.

Both client variants use the same server scenario and exact counters: nine source
invocations (two failed, with exactly two generation-source entries), five capacity denials, three deadline closures and one
explicit cancellation. Default `-Conformance` retains Python clients; only
`-CrossRuntime` substitutes Node clients. Cancellation still originates from the
private parent pipe, not a client action. This does not prove automatic
peer-disconnect handling during a blocked source or production cancellation races.

After the inventory and cancellation cases, a valid generation readback invokes
a deliberately failing fake source. The client requires EOF with zero bytes:
neither a success object nor a `missing` fallback is acceptable. The next fresh
approved connection reads that same generation and must receive the exact
expected observed state, including unknown dialogs. Both Python and Node clients
run this scenario. A TypeScript readback regression separately requires original
exception identity, no inventory-source access, and successful observed recovery.
The source hook receives its fixture default only after request validation;
failure selection remains trusted sequencing, not a new client-controlled field.

The final lifecycle case sends a complete valid inventory frame but never
half-closes its request direction. A competitor is capacity-denied, the server's
five-second deadline closes the stalled request with zero response bytes, and a
fresh approved readback succeeds. Both Python and Node clients exercise this
case with an eight-second client watchdog. Two of the three server timeouts must
occur in the request phase (idle and complete-without-EOF), with unchanged source
entry counts; only the held-source timeout occurs after readback begins. Node
uses the production frame encoder but deliberately bypasses the ending writer
for this test. This proves bounded waiting for mandatory EOF, not full peer-loss
detection while source code is blocked.

Only the fixture, vectors, Node client and frame helper are mounted read-only,
not the repository or PBX. Runtime networking is disabled; existing resource,
capability, tmpfs and owned-container cleanup restrictions apply. Node clients
assert their exact UID/primary GID and zero effective capabilities. This is
test interoperability, not a production client, runtime selection, deployment
identity-map proof or completion of the broker acceptance gate.

#### Broker OS identity integration: production option still unselected

The [separate-container experiment plan](./AGENT-PROVISIONING-PLAN.md#911-planned-separate-container-identity-and-socket-publication-experiment)
now defines an isolated labelled socket volume, separate broker/worker
namespaces, mapped UID/GID evidence, denial/publication/restart cases and bounded
owned cleanup. That initial plan was **planning only**, not evidence of a run.
It explicitly separates read-only socket mounts from peer authentication. The
subsequent scoped approval/results below supersede its planning-only status for
the implemented subset, not for every planned case.
No production topology, runtime or privileged probe is selected.

The user approved a first [separate-container identity/publication subset](./AGENT-PROVISIONING-PLAN.md#912-approved-separate-container-identitypublication-subset)
with exact kernel UID/primary-GID authorisation and PID recorded only. Run it
using the already-built local cross-runtime proof image:

```powershell
.\scripts\Test-BrokerContainerProof.ps1
.\scripts\Test-BrokerContainerProof.ps1 -NodeClients
```

The launcher creates a new labelled Linux Docker volume, a CHOWN-only setup
container, and separate capability-free non-root broker/client containers. It
requires matching full identity UID/GID maps and shared user namespace, but
distinct broker/client PID/mount namespaces. Remapped/rootless mappings are
unsupported and fail explicitly. The observed peer PID was zero: UID/primary GID
checks still admitted the exact approved identity and denied foreign UID/wrong
primary GID before reading. Supplementary socket-group membership does not
substitute for the primary GID. An unrelated identity is denied by filesystem
permissions.

The proof checks inventory/generation readback, read-only and writable-mount
worker publication denial (the writable case requires permission denial, not
cross-device failure), duplicate broker exclusion and successful subsequent
approved reads. Exact source/denial counters are checked. It reuses the Python
protocol functions, not a new production server; the default uses Python clients.
The subsequent corpus phase runs all shared vectors across containers as
described below.

Every runtime has network disabled, read-only root, explicit limits and only
three read-only fixture inputs (the opt-in Node corpus and lifecycle clients additionally mount
their TypeScript client and framing helper read-only). Cleanup removes only recorded containers matching
the owner label, then their exact new labelled volume; no PBX or unrelated
container is touched. After normal broker completion, two additional broker-user
containers test a regular file and a symlink at the exact socket pathname.
The actual server must fail with EADDRINUSE and no readiness/peer events;
path inode/mode/ownership and sentinel contents remain unchanged, including
symlink text and target identity/contents. Child execution is bounded, and only
the verified fixture-created entries are removed afterward.

An explicit crash/restart phase now publishes and records a socket's device/inode,
authenticates one approved client, reads its complete request and exits with
fixture-only code 23 before source entry, bypassing normal socket cleanup. The
client receives EOF with zero response bytes. After Docker confirms the original
container has stopped, an approved client must get connection-refused at the
stale pathname and a new broker must fail startup without deleting it.

Parent-authorised cleanup first tests a wrong inode (which must fail without
removal), then requires the recorded device/inode, socket type, broker owner and
mode plus a refused connection before unlinking the exact path. Only then does
the launcher explicitly start a fresh broker and approved client. Its peer is
reauthenticated, exact inventory readback succeeds and exactly one source entry
is recorded. No request is automatically replayed. This is an isolated,
before-source crash case, not general crash recovery, atomic hostile-writer
protection, automatic restart or production stale-socket removal policy.

The launcher now also starts a sequential conformance broker and a new client
container for each of the 36 request/framing and 28 source-output cases, plus a
foreign-UID denial and final approved reconnect. It reuses the existing corpus
server/client functions, retaining per-case source-entry and failure-category
checks, including exact inventory bounds and delayed EOF. Every client must have
the approved user-namespace mapping and separate PID/mount namespaces from the
live broker. Every accepted socket's kernel tuple and final counters are checked.
The corpus broker records peer PID without requiring visibility; the original
single-container server still requires positive PID by default.

The extra corpus phase has a 180-second broker alarm, five-second connection
budgets, ten-second accept waits and 15-second client process alarms. It creates
only owned labelled containers on the same isolated volume and uses no new
mounts or runtime network access. Successful finite-corpus conformance is not
proof of all protocol behaviour.

The opt-in `-NodeClients` mode runs the sequential corpus through the existing
Node/TypeScript client, including exact framed responses, zero-byte rejections,
the narrowly scoped concatenated-frame read-reset allowance and final approved
reconnect. A Python wrapper first records/checks namespace identity and groups,
then starts Node in the same container with a ten-second subprocess budget;
Node independently checks UID/GID and zero effective capabilities. Node must exit
successfully without stdout/stderr, and the wrapper emits explicit per-case Node
completion evidence. The launcher checks that evidence rather than inferring
which runtime ran from a flag. No fallback to Python occurs on Node failure.

Only Node corpus, crash/restart, admission and request-disconnect clients receive the extra two read-only
mounts. The broker, identity/publication/conflict checks and stale cleanup remain Python in both modes, with
unchanged resource limits and ownership-checked cleanup. Default Python corpus
clients also emit checked runtime completion evidence.

With `-NodeClients`, the crash-wait, stale-refused and restart-read clients now
also run in Node, each on a fresh read-only-volume client container. The crash
client sends through the production writer and requires EOF with zero response
bytes; resets/timeouts do not satisfy this case. Stale connect must fail with
exact connect-side `ECONNREFUSED` and zero bytes read/written. After parent-only
verified cleanup/restart, the Node client uses the production frame reader/writer
and checks exact inventory. The existing server evidence still requires crash
before source entry, stopped old container, stale startup refusal, wrong-inode
cleanup rejection and exactly one newly authenticated read after restart.
The wrapper emits checked per-step Node runtime completion with no fallback.
Default mode keeps the original Python crash/restart clients.

The separate-container admission phase overlaps an authenticated idle client
with an approved competitor, then repeats with a complete framed inventory
request whose client withholds EOF. Each waiting client holds the single slot;
its competitor gets EOF without response bytes. Before starting the second
competitor, the parent requires broker evidence that the exact valid request
body has arrived, not merely that a client connected. The fixture measures each
five-second deadline (at least five and below the eight-second client watchdog),
verifies zero source entries at both timeouts, then releases the slot. Timeout
evidence distinguishes idle/no-body from complete-body/missing-EOF.
After the request deadlines, a fresh complete request deliberately encounters
an inventory-source exception. Its client requires EOF with zero response bytes,
not a reset/timeout or success-shaped fallback. The broker must emit exactly one
fixed `Fixture source unavailable` diagnostic and one source-failure event,
with one source entry and the unchanged two request timeouts. The parent waits
for slot release before starting the recovery client, which must return exact
inventory on a fresh authenticated connection. Unexpected log lines fail parsing
rather than being discarded.
The same broker then receives a generation request whose source raises an
exception. That client also requires EOF with zero bytes, so a `missing` response
cannot satisfy the test. Exactly one `Fixture generation source unavailable`
diagnostic and a second source-failure event are required. The parent waits for
slot release, then a fresh generation client must receive the exact `observed`
response. Failure evidence records three total source entries, one generation
entry and the unchanged two timeouts before this recovery.
Next, a complete inventory request enters a deliberately uncooperative source.
One competitor must be rejected before the five-second deadline. The held client
then observes EOF with zero response bytes, but a second competitor must still
be rejected: both observations require the slot to remain locked with exactly
five source entries. Before the post-timeout competitor, the parent sends
test-only `SIGUSR2` after the timed-out client has exited. The existing terminal
callback must report the late cancellation as a no-op: five source entries,
three timeouts, zero cancellations and a locked slot. The parent requires that
evidence before starting the competitor. Only then does it deliver test-only `SIGUSR1` to
the exact recorded broker container to release the source. The fixture rejects
early or duplicate release control, requires terminal state before source
settlement, and keeps admission occupied until settlement. Its 15-second source
watchdog fails the experiment rather than providing successful recovery.
After explicit settlement and slot-release evidence, a fresh inventory read
must succeed. No release action is added to the socket protocol.
The next held inventory source is cancelled by test-only parent `SIGUSR2`.
From signal dispatch through client container exit, the launcher requires less
than three seconds and successful zero-byte EOF completion. The fixture must
record cancellation, not an additional timeout. A competitor remains rejected
with the slot locked, seven source entries and one cancellation. The parent
then sends one additional test-only `SIGUSR2`, which must reach the same
connection's terminal callback and report a no-op with those counters and the
lock unchanged. Explicit repeated-cancellation evidence is required before
source release; it adds no new client or source entry. A third cancellation
signal or an out-of-phase signal fails the fixture.
The parent
then waits for the original timer's callback, which must record a measured
five-to-eight-second deadline with the same source/timeout/cancellation counts
and the slot still locked. A further competitor must remain rejected after
that deadline. Only then may parent `SIGUSR1` release this source; settlement and slot-release evidence must
precede a fresh successful read. Both signal handlers are fixture-only, validate
the expected phase and are restored on exit; neither is a wire operation.
Final counters require eight source entries (two generation entries), two source
failures, six capacity rejections, three timeouts (two request timeouts and one
held-source timeout) and one cancellation.
All sixteen clients have separate PID/mount namespaces from the broker and the
same approved UID/GID maps; every connection records its kernel peer tuple.
Default mode uses Python; `-NodeClients` uses Node for all sixteen clients with
checked runtime completion and no fallback. Each finite waiting client runs
alongside its competitor only for this phase and remains subject to
ownership-checked cleanup.

This covers both ordered outcomes while the source remains held: cancellation
before a later deadline callback, and timeout before late cancellation.
It also covers one sequential repeated cancellation of an already-cancelled
connection while its source remains held.
Final event evidence also requires exactly three timeout outcomes, one
cancellation outcome and ten slot releases, preventing a second terminal event
or double release from satisfying only the aggregate counters.
Per-admission delivery evidence independently records source-entry count,
response-send attempts, discarded late results, timeout/cancellation state and
the still-locked slot before release. All ten admitted connections must match
the expected sequence: only the four fresh successful reads attempt one
response each; neither failed source nor either request deadline attempts a
response. Both held source results must be discarded after source-settled
evidence and immediately before slot-release evidence, with zero send attempts.
This checks the server path even after the original clients have exited; a
failed write to a closed connection cannot masquerade as deliberate suppression.
The held and recovery inventory sources also return distinguishable fixture
values: source entries five through eight use the baseline `notAfter` plus
their entry number. Delivery evidence requires discarded values `160005` and
`160007`; the Python and Node recovery clients independently require exact
inventories with `160006` and `160008`. Returning the old baseline or a discarded
result therefore fails recovery, even if a new source-entry counter increments.
These are synthetic fixture values, not real credential deadlines or a wire
schema change. The original shared corpus and single-container lifecycle retain
their existing expected responses.
These ordered cases alone do not establish simultaneous cancellation/deadline
race safety or cancellation after a successful response. The separate barrier
case below adds bounded deadline/cancellation contention evidence.

The shared concurrent fixture also rechecks terminal state/deadline after frame
EOF and before source entry. This prevents deadline-triggered socket shutdown
from supplying an apparent request EOF that could otherwise reach the source.
The original single-container lifecycle sequence remains covered.

An additional finite broker phase exercises early request disconnects. Fresh
approved clients connect and close both directions without sending bytes, after
each one/two/three-byte partial header, after the complete four-byte header
without a body, after that header plus three bytes of its body, and one byte
before completing either the ordinary body or an 8,192-byte padded body.
The Python client closes the socket after `sendall`; Node finishes the selected
bytes locally, destroys the socket and waits for local close. Neither treats a
transport error or watchdog expiry as success.
The broker's actual frame reader must observe exactly 0/1/2/3/4/7 bytes, then
the ordinary UTF-8 body length plus three, then 8,195 bytes, in that order.
It must reject specifically as a truncated frame, with no source entry or
response attempt. The partial headers and header-only case are prefixes of the
same valid inventory frame, not malformed-length proxies. Only this mode
accepts these expected framing failures; other failures remain fatal.
The two final-byte boundary clients construct valid frames and assert that exactly one byte
is withheld. The maximum case declares the permitted 8,192-byte body, not an
oversized length; its missing byte is trailing JSON whitespace, so a parser
accepting available JSON before checking declared length would fail this test.
Every rejected prefix is immediately followed by a fresh approved client that
must receive exact inventory before the next prefix is tested. Rejection evidence
must leave the cumulative source/send counts unchanged; recovery evidence must
increment each exactly once. The launcher checks the alternating rejection/
recovery outcome order, not just the final totals.
The same eight boundaries are then repeated with write half-close instead of
full local close. Python shuts down only its write side; Node ends its write side
and keeps reading. Each must receive zero-byte EOF, not a timeout, reset or
response byte, before closing locally. Each half-close rejection also has an
immediate exact-inventory recovery.
Each recovery source returns a copied observation with synthetic `notAfter`
equal to the baseline plus its one-based source-entry count. Python and Node
require the complete expected inventory, including that distinct expiry; the
launcher also checks the emitted expiry sequence. Replaying any earlier
recovery response cannot satisfy a later read. Shared corpus values are unchanged.
Final counters require sixteen request rejections, sixteen source entries and
sixteen response attempts. All thirty-two clients require explicit runtime
completion, kernel peer authentication and separate PID/mount namespace evidence.
The optional byte-count observation hook does not alter frame parsing and is
disabled for existing callers. This adds no wire operation, mount or privilege.

An isolated broker phase holds one inventory source while two threads
contend to invoke the existing terminal callback. Parent `SIGUSR2` arms the
cancellation thread; it waits at a two-party barrier with the actual five-second
deadline timer. Both then contend for the existing lifetime lock, without forcing
which reason wins. An eight-second barrier watchdog fails missing participation.
The launcher requires two attempt records at five to under eight elapsed seconds:
one winner and one no-op loser with identical terminal counters and no send attempt.
The old client must receive zero-byte EOF. Fresh authenticated competitors are
denied before contention and after both callbacks finish; the source still owns
the single slot. Only parent `SIGUSR1` releases the test source. Its late result
(`notAfter` baseline plus one) must settle, be discarded with zero send attempts,
then release the slot. A fresh client must receive exact inventory with baseline
plus two. Four fresh client containers require runtime completion, kernel
UID/primary-GID checks and the same separate PID/mount namespace evidence.
This unforced case is followed by the same barrier test with a bounded ordering
hook: the deadline contender must wait for the cancellation contender to finish.
The launcher requires cancellation to win and the actual deadline callback to
leave that outcome unchanged. Neither case bypasses the terminal callback.

Four additional isolated response/terminal schedules start with a complete
request, one settled source result and a fresh capacity-denied competitor:

| Schedule | Required result |
| --- | --- |
| Response before cancellation | Both threads meet at a barrier, then the cancellation callback waits for response completion. The client receives exact inventory; cancellation is a no-op. |
| Cancellation before response | Both threads meet at a barrier, then the response path waits for cancellation. The client receives zero-byte EOF; the ready result is discarded without a send attempt. |
| Deadline before response | The ready response waits at a barrier with the real five-second timer, then waits for the terminal callback. The client receives zero-byte EOF with no send attempt. |
| Completed response before deadline | The response completes before five seconds; the fixture retains its lifetime until the real timer runs. The timer must be a no-op, not a second terminal outcome. |

The shared test fixture now performs its terminal-state check, deadline check,
send and successful-completion marker under the existing lifetime lock. Terminal
callbacks treat successful completion as final. This closes the fixture's former
check/send window; it is not a production broker implementation. Socket writes
still use the remaining connection deadline.
The launcher checks exactly one winning action, correct per-action timing,
send/terminal counters, locked-slot delivery evidence and exactly two releases.
After each schedule, a fresh client must receive baseline-plus-two inventory,
distinct from the first result's baseline-plus-one value. Both client runtimes
require either the complete exact response or zero-byte EOF, never partial-frame,
reset or timeout success. Each schedule uses three independently authenticated
client containers with the existing namespace/resource restrictions.

These controlled schedules complete the planned terminal-ordering batch; they
do not establish all thread schedules, simultaneous duplicate cancellation,
partial-write interruption or production cancellation policy. Blocked-source
peer disconnect and slow/non-reading clients are tested separately below. Existing
shared lifecycle regressions retain their expected results; no wire action,
PBX access or production runtime selection is added.

The blocked-source peer-loss phase adds a Linux-only `poll` watcher to the
test fixture, disabled in existing modes. After the complete request and mandatory
write EOF, `POLLRDHUP` without `POLLHUP` records half-close, not cancellation.
The watcher then stops requesting read-hangup notifications to avoid spinning on
the persistent EOF; it waits for full hangup without consuming request bytes.
The source remains held while a fresh authenticated competitor is rejected.
Only after that evidence and a runtime-specific `holdingPeer` marker does the
parent kill the owned client container with `SIGKILL`, requiring exit 137.
The Node marker comes from the actual TypeScript client, not its Python wrapper.
This intentional client death cannot emit normal successful runtime completion.

The accepted socket must then report `POLLHUP`. The existing terminal callback
records exactly one peer-disconnect outcome before the five-second deadline,
with zero timeout/cancellation outcomes or send attempts. Parent signal dispatch
through observed hangup must take under three seconds. Poll errors, invalid file
descriptors and timeout are failures, not alternate disconnect evidence.
A second fresh competitor is denied after peer loss, proving that disconnection
does not free the slot while the source is blocked. Parent `SIGUSR1` alone releases
that source; baseline-plus-one inventory must settle, be discarded without a
send attempt, then release the slot. A new client must receive exact
baseline-plus-two inventory. Final totals are two sources, two capacity denials,
one peer disconnect and two slot releases. All four clients retain kernel
UID/primary-GID and namespace checks. Polling stops and its thread is joined
before releasing the slot.

This completes the bounded blocked-source disconnect batch for the tested Linux
Unix-stream/container topology. It does not prove other kernels/transports,
arbitrary disconnect/response races, leaked duplicate descriptors or remote
network failure detection. Slow/non-reading clients are the final bounded
experiment batch below; the subsequent implementation approval is recorded next.
Broader namespace configurations remain future cases. The earlier framing
failures alone do not prove the half-close distinction. Conflicting-path preservation is not proof of general
managed-file symlink confinement or production socket rotation.

The final writer batch runs slow and non-reading clients against two isolated
broker instances. The first source produces valid inventory with synthetic
baseline-plus-one expiry, padded with JSON whitespace to the allowed 32,768-byte
response body (32,772 bytes including the header). Only these writer cases request
a small `SO_SNDBUF`; the actual kernel buffer must be smaller than the frame.
The fixture initially sends nonblocking until a real `BlockingIOError` (`EAGAIN`)
with a strictly partial frame. Merely sleeping a client or shrinking a buffer is
not sufficient evidence. It then restores the original remaining socket deadline
and sends the rest using the same response attempt.

The slow reader waits one second, then consumes approximately 512 bytes per
20 milliseconds. Node uses a 512-byte readable high-water mark to prevent its
normal buffering from silently consuming the whole frame. Both clients must
receive the exact frame length, valid header, EOF and complete expected inventory;
the server must finish before five seconds without a terminal outcome.
The non-reading client defers application reads for six seconds. The server must
hit its remaining write deadline at five to under eight seconds, emit exactly one
timeout and release capacity. When reading resumes, the actual Python frame
reader or production TypeScript frame reader must reject specifically as a
truncated frame, not a reset, local read timeout or successful response.
Node may buffer a bounded initial chunk; server-side `EAGAIN` and write timeout
are required independently, so this cannot masquerade as full client consumption.

Each case rejects a fresh competitor while backpressured, records a single
attempted response (a timed-out partial write is not zero-byte suppression), and
releases only after the write settles. A fresh client then receives exact
baseline-plus-two inventory. Three clients per case require runtime completion,
mapped kernel credentials, namespace separation and existing resource restrictions.
This proves bounded write settlement for these fixtures, not immediate cancellation
during a blocking send: the lifetime lock serializes sends and terminal callbacks,
and the socket deadline bounds the wait. No retry or completion is claimed for
the partially transmitted response.

**Experiment closure:** the three planned batches (terminal orderings, blocked
peer loss and slow/non-reading clients) are covered for the approved Linux
default-map topology with Python and Node clients. Stop expanding this fixture
without a specific new requirement. Broader namespace modes, arbitrary schedules,
process/rate-limit architecture and production runtime/identity integration remain
explicit deployment/design decisions, not reasons to claim production readiness.

The current [broker acceptance-gap review](./AGENT-PROVISIONING-PLAN.md#910-acceptance-gap-review-after-cross-runtime-lifecycle-proof)
separates tested read-only interoperability from unproved parity/deployment
behaviour. The request-version forms and independent source-entry accounting
gaps are now covered by shared tests; broader terminal scheduling and production
integration remain open. The first acceptance gate is not signed off; production
deployment and every privileged probe still require separate approval.

### Dedicated Python read-only broker implementation

After closing the finite experiment, the user approved a dedicated Python broker
for **unprivileged read-only implementation**, not PBX control or real-secret
access. [local/broker/readback.py](./local/broker/readback.py) now provides an
independent `Binding`, explicit `Source` adapter contract and socket-owning
`Broker.serve(path, stop, ready)` entry point. It imports no test fixtures.
The caller supplies protected configuration and an adapter; no CLI service,
Compose listener or concrete PBX source is enabled by this change.

The Linux listener authenticates the exact accepted socket with `SO_PEERCRED`
before request consumption. Only the configured kernel UID/primary GID is
authorised; PID is diagnostic. It requires non-root/capability-free execution,
default namespace maps, a broker-owned 0750 non-symlink directory and matching
primary socket group. Socket mode is 0660; conflicting paths fail without
unlinking, and shutdown cleanup verifies the original device/inode/type.
Customer, epoch and principal never come from peer identity claims.

The module implements the shared read-only schemas and framing limits with one
admission slot and a five-second deadline starting at accept. Deadline, shutdown
or full peer hangup signals the adapter's cancellation event. Required request
write half-close is not treated as full peer loss. An uncooperative source keeps
its slot until settlement, including during shutdown. Partial writes may occur
on termination and must fail framing; nothing is replayed.
For generation reads, only the explicit `MISSING` sentinel means authoritative
absence. `None`, invalid source output and exceptions are failures, not missing.
Logs omit request bodies and adapter exception text.

Run the implementation proof using the already-built cross-runtime proof image:

```powershell
.\scripts\Test-PythonBroker.ps1
```

This tests the new module against all 36 request/framing and 28 source-output
vectors, strict bindings and source/cancellation behaviour. The real Unix-socket
test runs the broker unprivileged and verifies kernel peer denial, live-path
preservation, deadline EOF, source-slot retention and distinct Python/Node
recovery before socket cleanup. The test supervisor alone performs fixture
identity setup. No dependencies or images are implicitly installed.

The implementation proof also runs independent deadline, blocked-source peer-loss
and draining-shutdown lifetimes. Each verifies that required write half-close is
nonterminal, and checks the exact terminal diagnostic rather than allowing one
cause to substitute for another. Full peer loss must cancel the source within
three seconds and retain capacity until settlement, followed by distinct Python/
Node recovery. Shutdown must close the client within three seconds while keeping
the broker process and socket path alive until the held source is released.
Final shutdown source counts exclude replay; fixed diagnostic counts reject
unexpected source/monitor failures. These are real Linux process/socket tests,
not yet separate-container integration coverage of the implementation.

Publication tests also run the actual module as the unprivileged broker UID.
Startup must reject an existing regular file or symlink with `EADDRINUSE`,
without signalling readiness or entering a source. Tests preserve and compare
device/inode, full mode, UID/GID, sentinel contents and symlink target.
For shutdown cleanup, the test renames the original live socket aside and
publishes a different regular file or socket at its old pathname. Cleanup must
raise exactly `Broker socket changed; refusing cleanup` and leave both the
replacement and saved original untouched. Keeping the original inode alive
avoids inode-reuse ambiguity. After test-owned conflicts are explicitly removed,
the same broker instance must start and stop cleanly with no source calls.
These controlled publication checks do not prove arbitrary filesystem-race
resistance, stale-socket recovery policy or general managed-file confinement.

Real-socket source-failure tests run inventory and generation failure/recovery
pairs with both Python and actual Node clients. Each injected adapter exception
must yield zero-byte EOF, never an error-shaped success or `missing` generation.
The immediately following fresh client must receive the exact expected inventory
or `observed` generation. Per-request counters require one source call and exclude
automatic replay; final counts are four calls per operation across eight clients.
Captured broker diagnostics must be exactly four fixed
`Broker read-only source failed` messages, with no adapter exception detail,
additional terminal outcome or hidden recovery error.

The complete 36-case request/framing corpus also runs through the actual
authenticated listener with Python and Node clients (72 fresh connections),
rather than only a socketpair decoder. Both clients exercise exact limits,
UTF-8/JSON/schema rejection, scope, concatenated/trailing frames and delayed EOF.
Each request must add zero source calls when rejected and exactly one when valid;
the complete successful response must match the shared expected value.
Only the corpus's concatenated-valid-request case permits read-side connection
reset instead of EOF, always with zero response bytes. All other errors fail.
A fresh exact-inventory read follows each runtime's corpus. Captured diagnostics
must contain only the exact expected number of fixed request-rejection messages,
with no hidden peer-loss, deadline, source or capacity outcomes. Clean stop must
remove the socket. This is same-container process integration, not yet proof of
the implementation's separate-container deployment.

The same authenticated-listener harness also exercises all 28 source-output
vectors with each client runtime (56 fresh corpus connections). These requests
are valid: every case must enter exactly one source, including rejected outputs.
Invalid inventory/observation values must close with zero response bytes;
valid outputs must match the complete expected response. This includes the
100/101 inventory boundary, duplicate generations, unsafe numeric values,
unexpected fields and invalid/null observations. A test-owned source selector
stays inside the server process boundary, never in request JSON; the runtime
listener and validation are unchanged. The selector is cleared for fresh
inventory recovery after each corpus. Exact diagnostic counts exclude hidden
failures or success-shaped fallback.

The implementation now has a focused separate-container check:

```powershell
.\scripts\Test-PythonBrokerContainers.ps1
```

It runs the actual Python module as broker UID 1101/GID 2100 with no capabilities,
network disabled, read-only root and fixed resource limits. Seven fresh clients
use a shared labelled socket volume mounted read-only on the client side.
Python and Node foreign-UID clients must be denied; a worker with wrong primary
GID but supplementary socket-group access must also be denied. Approved Python
inventory and typed Node generation, authoritative missing-generation and
inventory reads must match exact expected responses. Final source calls must be
four, with exactly three peer denials. The Node approved reads use the reusable
TypeScript client, not just the framing helper; each completion record explicitly
identifies whether the typed client ran. A missing-generation read is followed
by fresh inventory on a separate connection to the same running broker.

The launcher checks default UID/GID maps, shared user namespace and distinct
broker/client PID and mount namespaces, with runtime-specific completion records.
Denied sibling peers must be recorded with kernel PID zero and exact UID/GID;
PID is not an authorization input. Parent `SIGUSR1` requests only test-owned
clean stop; the fixture verifies socket removal before successful exit.
Temporary containers/volume are cleaned using exact names plus ownership labels.
Only setup receives CHOWN; broker and clients remain capability-free.
This is focused deployment-topology evidence, not the old fixture's full
separate-container lifecycle/corpus coverage or a production service launcher.

The first concrete source bridge is deliberately **test-only**:
[`fake-broker-source.py`](./tests/identity/fake-broker-source.py) reads the existing
TypeScript fake provisioning runtime's synthetic SQLite database. It opens a
fresh `mode=ro` connection with `query_only`, checks the pinned customer/epoch
inside each read transaction, bounds inventory to the protocol limit, and checks
cancellation before and after the read. It neither creates a database nor imports
mutation operations. An absent generation remains an error, matching the fake
runtime; it is not converted into authoritative `missing`.

```powershell
node --test .\tests\python-broker-source.test.ts
```

This requires local Python 3 and Node with SQLite support. The existing
`Test-PythonBroker.ps1` also runs it inside the existing Linux proof image before
the socket regression. The test creates state through the actual TypeScript
runtime, compares Python readback with TypeScript expiry reads across prepared,
active, draining and removed states, including live and unknown dialog counts,
and verifies unchanged database bytes, file list and effect count. A write
attempt on the reader connection must fail with `SQLITE_READONLY`. Wrong binding,
missing database/generation, corrupt state and pre-cancellation must fail.
The Linux launcher additionally wires that concrete source through the actual
authenticated Python listener. For each of five state snapshots (prepared,
active with one dialog, active with unknown dialogs, draining, removed), both
Python and actual Node clients check foreign-UID denial, wrong-epoch rejection,
exact inventory and generation responses, zero-byte rejection for an absent
generation, and a fresh inventory recovery. Each client then reads inventory and
generation while a separate SQLite writer holds `BEGIN IMMEDIATE` with an
uncommitted wrong epoch and invalid phase; both reads must still match the
committed snapshot. A subsequent `BEGIN EXCLUSIVE` must cause both operations to
close with zero response bytes and the fixed source-failure diagnostic. The
fixture requires exact `SQLITE_BUSY`, no cancellation, and a source duration of
0.2 to less than 2 seconds around the configured 250 ms busy timeout, not a
substituted five-second broker deadline. After rollback, both operations must
recover through the same running listener.

These are 120 connections with exactly 100 source entries and 50 expected
peer/rejection/source-failure diagnostics, including 20 exact lock failures.
Denied peers and
wrong-scope requests must never enter the source. Node uses the production frame
reader/writer. The TypeScript driver compares complete responses and verifies
database bytes, directory entries and effect counts across each socket batch.

The broker runs as UID 1101, primary GID 2100, with no capabilities and a separate
supplementary read-only database group; worker clients have no database-reader
group. The root supervisor creates only synthetic state and protected socket
directories, restores fixture permissions, waits for clean stop/socket removal,
and cleans exact owned processes. The launcher retains its existing capabilities,
network isolation and read-only root; its task limit is now 64 to accommodate
the nested Node test runner, real Node client and Python processes/threads.
This is same-container concrete-source integration, not a production source
installation or separate-container database deployment.
This establishes only these reserved/exclusive writer schedules in rollback
journal mode. Concurrent commits within a read snapshot, WAL/shared-memory
behavior, real-source authority and production source installation are not
established by this fake-runtime proof.

The runtime choice is now approved; deployment is **not**. Prior experimental
race/container/writer evidence is not automatically evidence for this new module.
Implementation-specific integration coverage, concrete read-only source wiring
and packaging/supervision remain before deployment. See the
[approved implementation scope](./AGENT-PROVISIONING-PLAN.md#914-dedicated-python-runtime-approved-read-only-implementation).

The reusable TypeScript [`createAgentBrokerClient`](./src/agent-broker-client.ts)
now exposes only the `BrokerReadbackSource` inventory/generation methods. It
copies and validates the configured customer/epoch/principal, accepts an absolute
local socket path, and opens a fresh half-open connection per read. A single
five-second budget covers connect, request write, response read and required EOF;
caller cancellation closes the socket and propagates its reason. Calls on the
same client cannot overlap. Failures are propagated without retry or cached
fallback; only an exact, validated `state: "missing"` response returns
`undefined`. Scope/action/generation correlation, exact response fields and
existing expiry validators are checked before returning data. The principal
remains out-of-band, never sent as a claimed transport identity.

The caller must supply a trusted socket publication/path policy: echoed scope is
not authentication of the server. This client is not automatically wired into
the worker, expiry mutation adapter or any application route, and does not grant
PBX access. The synthetic integration's approved/rejected Node reads now use this
client against the actual Python listener. Separate Linux Unix-socket tests
cover malformed responses, missing state, cancellation/recovery, no retries and
the client deadline even when a complete frame arrives without EOF.
`Test-PythonBroker.ps1` runs these tests in the existing Linux image. Socket
behavior tests are explicitly skipped on non-Linux hosts; Windows named pipes
do not supply the required Unix half-close semantics.
The separate-container launcher also verifies typed Node inventory, observed and
authoritative missing-generation results through the actual Python listener,
with explicit client markers and unchanged kernel UID/primary-GID enforcement.
Its source remains a deterministic in-memory fixture, not a shared SQLite
database or live PBX source.

The next design gate is the
[live read-only source authority contract](./AGENT-PROVISIONING-PLAN.md#915-live-read-only-source-authority-contract-design-only),
not more transport fixture variants. Existing AMI endpoint/channel reporting is
not generation-correlated dialog, deadline or verified fence authority. The
contract separates protected ledger/model evidence from runtime observation,
defines fail-closed handling for every wire result, and lists the owner,
observation mechanism and consistency decisions required before live adapter
implementation. It does not approve new PBX access, permissions or deployment.

The subsequently approved
[broker-owned metadata ledger foundation](./AGENT-PROVISIONING-PLAN.md#916-broker-owned-metadata-ledger-foundation-approved-local-implementation)
is implemented in [`local/broker/ledger.py`](./local/broker/ledger.py). It
explicitly initializes a new customer/epoch/namespace-pinned SQLite database and
records immutable generation UUID/deadline pairs with exact idempotence and
conflict rejection. Existing/missing/uninitialized databases are never silently
recreated. Binding checks run inside every transaction; lock and schema failures
propagate. It stores no credentials and performs no PBX operations.

```powershell
python -I -B .\tests\identity\broker-ledger-proof.py
```

The existing Linux broker launcher also runs the ledger tests as non-root with
zero effective capabilities. This is local metadata storage, not an installed
service or live readback source: it cannot infer fencing, dialogs, removal or
authoritative runtime absence. Protected path publication, power-loss durability
and restored-authority detection remain separate work.

The [dedicated AMI observation assessment](./AGENT-PROVISIONING-PLAN.md#917-dedicated-ami-observation-contract-assessment-design-only)
checks the repository's pinned Asterisk 22.11.0 upstream source. AMI `write`
permissions authorize queries as well as mutations; endpoint queries require a
class that also permits control actions, and even `reporting` is not a strict
query-only action class. Endpoint details can include authentication material.
Therefore a dedicated username alone is not an enforced read-only boundary.
No AMI account or permission has been added. A separately reviewed fixed
observation authority/enforcement owner must be selected before live source
implementation; endpoint channel counts still cannot stand in for verified
generation dialogs or fencing.

The [observation-boundary comparison](./AGENT-PROVISIONING-PLAN.md#918-pbx-side-observation-surface-versus-isolated-collector-recommendation-only)
recommends an isolated higher-trust collector as the next **synthetic development
candidate**, rather than immediately adding code inside Asterisk. This is
conditional: a collector holding AMI credentials still has their broader
authority, and process isolation does not make that authority read-only.
If that trust is unacceptable, or required fencing/dialog evidence cannot be
proved, the design must use another constrained authority or investigate a
purpose-built PBX-side surface. No collector runtime, credentials, access or
deployment is approved by the recommendation.

The approved next increment is a
[synthetic broker-side evidence validator](./AGENT-PROVISIONING-PLAN.md#919-synthetic-broker-side-evidence-validator-approved-bounded-implementation),
implemented in [`local/broker/evidence.py`](./local/broker/evidence.py).
It checks broker-owned scope/generation/mapping/runtime expectations, a fresh
single-use request ID, a local monotonic lifetime shorter than five seconds,
cancellation and exact complete/unknown/unavailable result shapes. Unknown
dialogs never become zero; unavailable evidence raises an explicit error.
Contradictory removal evidence is rejected.

```powershell
python -I -B .\tests\identity\broker-evidence-proof.py
```

The Linux broker launcher also runs these synthetic tests as non-root with no
effective capabilities. This is not evidence authentication or PBX truth: no
collector runtime, transport, credentials, access, live source or deployment
has been added. Runtime enrollment, mapping persistence and authority-change
coordination remain prerequisites for integrating a real producer.

The [generation mapping and authority lifecycle design](./AGENT-PROVISIONING-PLAN.md#920-protected-generation-mapping-and-authority-lifecycle-design-only)
proposes deterministic, role-separated endpoint/auth/AOR names derived from the
full customer/epoch/namespace/generation tuple, never from an extension or
caller-selected object name. It distinguishes immutable naming, mapping
revision, command revision and PBX runtime identity; restarts invalidate evidence
without silently renaming objects. Runtime enrollment and continuity remain
unresolved rather than being inferred from an AMI login or start-time string.
This is documentation only: no schema migration, object creation, collector,
credentials or PBX access is introduced.

The [pure mapping helper](./AGENT-PROVISIONING-PLAN.md#921-pure-generation-mapping-helper-synthetic-implementation)
now implements that deterministic derivation in
[`local/broker/mapping.py`](./local/broker/mapping.py), with exact-record
validation and synthetic ownership/conflict checks. Five tests cover an
independent Node reference digest, scope separation, 70-byte role names,
unverified ownership and forced collisions:

```powershell
python -I -B .\tests\identity\broker-mapping-proof.py
```

The existing Linux launcher also runs these checks as non-root with no effective
capabilities. A supplied ownership snapshot is not authenticated by this helper;
matching a derived name does not prove ownership of a live PBX object. No ledger
schema, collector, runtime enrollment or PBX configuration has changed.

The subsequent
[explicit ledger mapping migration](./AGENT-PROVISIONING-PLAN.md#922-explicit-ledger-mapping-migration-local-metadata-only)
adds schema 2 support in [`local/broker/ledger.py`](./local/broker/ledger.py).
Local `migrate_ledger_mappings` atomically preserves generation metadata,
derives/stores immutable revision-1 mappings and commits the schema version.
Opening a database never migrates it silently; bootstrap still produces schema
1 until explicitly upgraded. Version-2 records commit metadata and mapping
together and revalidate stored names/associations on every operation.

The existing ledger proof now covers migration rollback, insertion conflicts,
missing/corrupt mappings, binding/lock failures and reopen persistence. This is
metadata-only integration, not PBX ownership proof, runtime enrollment or
production upgrade/crash-durability certification.

The [runtime enrollment comparison](./AGENT-PROVISIONING-PLAN.md#923-runtime-enrollment-and-continuity-comparison-design-only)
recommends a trusted lifecycle supervisor only where the project is explicitly
allowed to own the real Asterisk process lifetime. Externally managed PBXs need
operator enrollment plus an approved continuity source; manual approval alone
is not continuous identity evidence. Either design must bind the observation
connection to the enrolled process and invalidate stale evidence on restart or
uncertainty. No supervisor, Docker access, PBX lifecycle control or runtime
enrollment implementation is added.

The subsequent
[project-owned lifecycle enrollment design](./AGENT-PROVISIONING-PLAN.md#924-project-owned-lifecycle-enrollment-boundary-design-only)
uses the recommended project-owned deployment assumption without authorizing
lifecycle control. It defines starting, association-pending, observation-ready
and invalidated states, and requires both real child ownership and a proven
observation-connection association. The existing foreground Asterisk entrypoint
is unchanged. Authority-session/revision coordination is proposed but is not
implemented by the current synthetic evidence validator.

The [synthetic authority-state model](./AGENT-PROVISIONING-PLAN.md#925-synthetic-authority-state-and-evidence-coordination-model)
now coordinates those local checks in
[`local/broker/authority.py`](./local/broker/authority.py). It accepts trusted
caller lifecycle facts, rejects out-of-order transitions, and binds one-use
evidence collections to a session/revision under the same lock as invalidation.
An invalidation followed by the same binding cannot revive an old collection.

```powershell
python -I -B .\tests\identity\broker-authority-proof.py
```

The existing Linux launcher runs the four synthetic tests as non-root with no
effective capabilities. This is not a supervisor or process attestation: real
child ownership, connection association, callback ordering and cross-process
invalidation remain unimplemented. No PBX access or lifecycle control is added.

The next milestone is the
[isolated-PBX feasibility plan](./AGENT-PROVISIONING-PLAN.md#926-isolated-pbx-lifecycleconnection-feasibility-plan-not-execution-approval).
It proposes one finite batch binding a real owned Asterisk child to an exact
loopback AMI connection using kernel socket/descriptor evidence, then checking
exit, replacement and reconnect invalidation. This mechanism is unverified;
permission failures or ambiguous ownership stop the proof rather than trigger
privilege escalation. The plan requires separate approval for a disposable
PBX, synthetic account and exact child lifecycle operations. Nothing has been
started, and the existing status fixture and Asterisk entrypoint are unchanged.

After explicit approval, the
[disposable lifecycle association proof](./AGENT-PROVISIONING-PLAN.md#927-disposable-asterisk-lifecycle-association-feasibility-result)
was implemented and passed:

```powershell
.\scripts\Test-PbxEnrollmentProof.ps1
```

It uses the existing local diagnostics image, requires Asterisk 22.11.0 and runs
as non-root with no capabilities or published ports. An exact established AMI
connection must map to a socket descriptor of the owned Asterisk child, checked
alongside its pidfd lifetime. Wrong-process connections fail; reconnect requires
fresh association; child exit invalidates held local evidence; replacement gets
a new runtime identity. Only synthetic Login/CoreStatus/Logoff and exact
disposable-child lifecycle operations are performed. Owned children, container
and temporary credentials/state are cleaned.

This proves the bounded inspection mechanism works in that isolated topology,
not an installed supervisor or authoritative generation fence/dialog evidence.
The test does not accept CoreStatus as a generation observation, and no existing
PBX service, account or entrypoint is changed.

The [generation fencing and dialog ownership contract](./AGENT-PROVISIONING-PLAN.md#928-generation-fencing-and-dialog-ownership-contract-design-only)
defines the next functional gate: a final generation-aware admission fence,
complete ownership of outstanding dialogs/pending admissions, and a coordinated
safe-zero/removal check. Channel counts, endpoint state and ledger intent are
not substitutes. Transfer semantics and the concrete PBX enforcement/ownership
mechanism still require decisions before a separately approved synthetic-call
proof. This design introduces no PBX mutation, call or live source.

The [enforcement comparison](./AGENT-PROVISIONING-PLAN.md#929-dialplan-only-versus-in-process-admissiondialog-enforcement-recommendation)
checks Asterisk 22 transfer and Dial/Queue behavior. Recommendation: a
closed generated dialplan plus a small in-process final-admission/lifecycle
owner—not dialplan Gosubs alone. Asterisk 22.11 runs per-callee `b()` Gosubs
after `Dial()`/`Queue()` inherit datastores and before `ast_call()`; this is a
candidate invocation point for an atomic in-process per-leg claim, not a
serialization guarantee by itself. Queue waiting needs a separate parent
obligation, and parallel branches need unique child claims. Native transfer
paths can be independent of core feature-code options. Milestone 1 already
includes browser blind transfer, so section 9.30 reconciles that scope with the
required generation-aware handoff and synthetic-call matrix. Pinned Asterisk
source shows ARI-only REFER publication and transfer success do not constitute
a synchronous generation claim. Asterisk's bridge transfer callback is a
potential claim-propagation point for a custom REFER path, but its void callback
and claim-lifetime/failure semantics need proof. Datastore inheritance can omit
a child datastore or leave its duplicated payload NULL on allocation failure;
target admission must validate usable trusted state and fail closed. DTMF
transfer and parking need separate treatment. This remains design work: no
module, call path, PBX config or call was changed.
The candidate claim contract now distinguishes one generation/session/REFER
operation from unique channel-attempt and per-callee child identities.
Retransmissions must resolve to the same operation; parking fallback on a
different Local requires a distinct attempt. Parent obligations remain open
until every child is reconciled, and the callback's `void` result means claim
capacity must be secured before entering a path that cannot abort.
The PJSIP `incoming_request` supplement runs synchronously on a SIP servant
thread; the pinned dispatch path shows no admission-owner per-session latch.
PJSIP holds the dialog lock across each in-dialog usage callback, so distinct
REFER callbacks on that dialog are serialized. A valid later REFER needs a
new Via branch and a higher CSeq; while the original transaction is active,
reusing its branch with a changed CSeq enters the transaction-layer stateless
`400` path, while a new branch with a non-increasing CSeq enters the
dialog-layer stateless `500` path before supplements. Verify actual wire
responses. A later valid REFER can still arrive while the first transfer
remains pending, so a bounded PBX-side per-session reservation must reject or
safely resolve that second operation.

The repository's pinned SIP.js version is 0.21.2. Its `SessionManager` installs
an incoming `onRefer` handler that accepts referrals and sends an INVITE to the
referral target, replacing any existing session handler. Low-level Session and
UserAgent defaults instead reject incoming REFER when no delegate is present.
The existing WebRTC proof uses the low-level API and does not exercise REFER;
the chosen production API surface must explicitly gate referrals. In the
low-level API, the `Session.refer()` promise resolves with a request handle and
does not wait for the REFER final response; 2xx response and later NOTIFY are
separate callbacks. Its single per-session NOTIFY callback can be replaced by a
second overlapping REFER, so transfers need per-dialog serialization and PBX
lifecycle evidence beyond REFER/NOTIFY status. Asterisk 22.11 attempts to
accept an implicit-subscription REFER with 202 before the transfer outcome;
later sipfrag NOTIFY may carry progress if the subscription and response
succeed. The acceptance call's return is ignored, so capture wire behavior
before treating 202 as sent or successful subscription setup as proof of
target admission.
`refer_blind_progress` defaults to yes, but disabling it emits
terminal 200 from the transfer callback before target answer; monitoring setup
failures can also explicitly fall back to assumed-success 200. Therefore pin
the effective setting and require channel/bridge ownership evidence; never use
terminal NOTIFY 200 alone as a safe-zero signal.
When implicit-subscription setup succeeds, the built-in handler attempts
`202` before checking target-extension existence; if Asterisk submits that
response, an unknown target can receive it followed by a failure NOTIFY.
The generic Asterisk session-supplement contract warns that incoming callback
`rdata` is cloned and module data is not copied. However, the pinned Asterisk
22.11 in-dialog INVITE-session path invokes its transaction-state callback
with `e->body.tsx_state.src.rdata` and passes that same pointer to the session
supplements; pinned pjproject sets the transaction module data on that `rdata`
before dispatching the `TRYING` event. The local `Refer-Sub: false` probe also
received the handler's final response. Thus the generic clone warning does
not describe this specific in-dialog REFER path; do not infer a missing
transaction or failed subscription setup from it. The acceptance call's
return is still ignored, so response-creation or send errors remain possible
and wire behavior must be captured. A generation/allowlist rejection that must
precede accepted-transfer signaling needs an earlier REFER supplement at a
strictly lower priority than the built-in handler
(`AST_SIP_SUPPLEMENT_PRIORITY_CHANNEL + 1`). A nonzero supplement result only
stops later handlers; the rejecting callback must send its own SIP response.
The gate must reserve before returning zero to continue into built-in handling,
or send the final response itself and stop dispatch.
For this pinned in-dialog path, source order and the runtime response support
using `pjsip_rdata_get_tsx()` in the callback. The public callback contract
still conflicts with that implementation detail, so verify the exact deployed
version before relying on this behavior elsewhere.
Keep `Refer-Sub: false` as a distinct proof case: it skips subscription
creation, but Asterisk executes the transfer handler before trying its final
response. For a valid blind transfer the core can therefore queue the bridge
action first; the later `pjsip_dlg_send_response()` still uses
`pjsip_rdata_get_tsx()` and ignores its return. The local UDP test received a
`404` with `Refer-Sub: false` for an unknown target, confirming a final
response in that case; a separate known-extension attempt returned `400`.
Neither spot check exercised an accepted transfer or response-send failure.
The later [accepted bridged proof](#accepted-bridged-refer-proof) covers local
transfer acceptance and channel/bridge outcomes, but not send failures. The
matching REFER supplement still suppresses the generic dialog `500` fallback
if handling fails before a final response. Verify transfer enqueue and retry
behavior separately; a missing REFER response must not be mistaken for
rejection or trigger an uncorrelated retry.
The no-subscription setup returns before Asterisk's `pjsip_xfer_accept()` call,
so it does not send the implicit-subscription `202`. It still allocates its
progress object; with normal blind-progress monitoring enabled, the transfer
callback can attach a framehook and bridge observer even without a SIP
subscription. Progress notifications then skip SIP `NOTIFY`, emitting an ARI
event only if ARI transfer state exists
([no-subscription notification](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L208-L229),
[monitor setup](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L818-L908)).
Prove monitor cleanup separately from the absence of `202`/sipfrag and from
the bridge/channel outcome. The no-subscription branch also skips the
terminal failure-NOTIFY path used for subscribed transfers
([handler branch](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L2069-L2100)).
Thus the final REFER response is the only SIP-level terminal outcome; if that
send fails, no sipfrag failure notification recovers it. For ordinary blind
transfer the progress path has no ARI state either, so rely on independently
correlated channel/bridge lifecycle and leave an absent response unresolved.
RFC 4488 defines `Refer-Sub` as `true` or `false` with optional extension
parameters. A `false` request is only a request: suppression is granted when
the recipient echoes `Refer-Sub: false` in a 2xx response, and the issuer
should use it only when the REFER itself will not fork
([RFC 4488](https://www.rfc-editor.org/rfc/rfc4488.html#section-4)).
Asterisk's parser is more permissive: it looks at the first matching header
and enables subscription only if the first four characters compare
case-insensitively with `true`; `trueX` enables it, while a short value such as
`tru` takes the no-subscription path. Test duplicates, casing and malformed
values, or reject forms outside the explicitly supported set
([lookup](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_msg.c#L374-L387),
[value check](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L553-L569)).
The repeatable rejected-target proof now confirms these branches for both
advertisement settings, including mixed casing, valid extension parameters,
`trueX`, `tru`, an empty value, and conflicting duplicates in both orders.
Without a final 2xx echo, do not treat subscription suppression as negotiated.
Asterisk advertises `Supported: norefersub` by default through the global
`norefersub=yes` setting
([default](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip/config_global.c#L52-L57),
[registration](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L2168-L2177));
this capability advertisement is not itself a per-request grant. The setting
only gates capability registration in the source: the incoming parser chooses
the no-subscription path from `Refer-Sub` without checking that option. Thus
`norefersub=no` should not be assumed to disable that request behavior
([advertisement check](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L2168-L2177),
[incoming parser](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L553-L569)).
The REFER supplement does not itself inspect `Require`; pjproject's
`pjsip_inv_verify_request3()` option check is for INVITE session handling, not
proof of REFER validation
([INVITE verifier](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-ua/sip_inv.c#L1318-L1328),
[Require check](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-ua/sip_inv.c#L1595-L1653)).
The REFER-specific transfer and event-subscription UAS constructors also
validate transaction/subscription inputs, not `Require`
([transfer UAS](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-ua/sip_xfer.c#L216-L268),
[event-subscription UAS](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L960-L1009)).
No automatic 420 can be assumed from those paths.
Test `Require: norefersub` with and without `Refer-Sub: false` under both
global settings, and capture any 420/`Unsupported` before progress.
The repeatable [rejected-target proof](#rejected-target-refer-proof) now covers
both forms under both settings: none returned `420`; they followed the
same `404` no-subscription or `202` plus terminal failure-NOTIFY paths as
requests without `Require`. The INVITE responses separately confirmed that
`Supported: norefersub` was present only when the setting was enabled. This
is evidence for this pinned fixture, not general required-option compliance.
RFC 3261 requires that response when a UAS does not support a required option
([Require rules](https://www.rfc-editor.org/rfc/rfc3261.html#section-8.2.2.3)).
Do not infer required-option behavior only from `Supported` advertisement.
Verify both effective settings on the deployed build. Also capture
response code and header together: Asterisk's no-subscription response builder
adds `Refer-Sub: false` without restricting it to 2xx
([response path](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L2069-L2088)),
although RFC 4488 defines that response header for 2xx only. A non-2xx echo
does not establish successful negotiation.
A local Asterisk 22.11.0 UDP spot check with `res_pjsip_refer` loaded sent a
`404` plus `Refer-Sub: false` for an authenticated in-dialog REFER to an
unknown target. The test confirms this response shape for that case only; it
does not exercise an accepted transfer, measure response reference counts, or
validate transaction lifetime.
The later accepted bridged proof separately covers eight answered Local-target,
eight busy-target, eight no-answer, and outbound PJSIP-target transfers with
answered, SIP `486`-rejected, and ringing timeout/CANCEL outcomes, plus
controlled loss cases.
The answered PJSIP cases additionally verify correlated target signaling and
post-transfer RTP echo; response-reference and transaction-lifetime measurements
remain open.
The repeatable proof additionally confirmed implicit-subscription `202`
followed by terminal sipfrag `404`, successful same-key final-response
retransmission, and BYE cleanup for the 48 unknown-target cases. An additional
20 invalid-target cases returned early `400` with no `Refer-Sub` response
header and no observed NOTIFY. These
results do not establish transaction resource counts or lifetime.
Asterisk's out-of-dialog REFER client also compares the entire echoed header
value to `false` rather than parsing RFC 4488 extension parameters. Thus a
valid `Refer-Sub: false;foo=bar` 2xx echo does not trigger its immediate
subscription termination. Because a suppressing recipient sends no NOTIFY,
pjproject's default REFER event-package expiry is 600 seconds; absent an
`Expires` override, it schedules a refresh around 585–594 seconds later. Its
default refresh is a `SUBSCRIBE`, not another REFER, and Asterisk's caller
header is attached only to the initial request, so that refresh does not
inherit `Refer-Sub: false`
([Asterisk response handler](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1281-L1307),
[pjproject expiry and refresh](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-ua/sip_xfer.c#L31-L32),
[default refresh method](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-ua/sip_xfer.c#L585-L600),
[Asterisk's one-time header insertion](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1473-L1477),
[RFC 4488 grammar](https://www.rfc-editor.org/rfc/rfc4488.html#section-4)).
pjproject rearms the refresh timer after a successful refresh, using any
response `Expires` value or retaining the existing duration. If the peer
continues returning 2xx without a terminating NOTIFY, recurring `SUBSCRIBE`s
are possible
([successful refresh handling](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L1917-L1973)).
Test repeated refresh and eventual termination separately from transfer
completion.
If that refresh receives 481 or another non-2xx response, pjproject normally
terminates the UAC subscription and Asterisk treats it as a failed REFER
subscription; status 490 (`Request Updated`) is explicitly ignored by this
path and must be tested separately. A terminated refresh subscription is not
evidence of target-call failure or ownership settlement
([pjproject handling](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L1975-L2008),
[Asterisk callback](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1309-L1385)).
Test refresh responses and cleanup separately from transfer outcome.
Neither SIP.js 0.21.2 nor Asterisk 22.11 adds `Refer-Sub: false` to its
outgoing REFER by default. Asterisk's PJSIP transfer builder adds `Refer-To`,
then its REFER sender copies caller-supplied REFER variables as headers; that
header is not blocked. Its local UAC event subscription is created before the
caller-supplied headers are copied, so explicitly sending `Refer-Sub: false`
still depends on the peer's 2xx echo and Asterisk's response parser
([Asterisk sender](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1441-L1481),
[PJSIP builder](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-ua/sip_xfer.c#L284-L342)).
On an exact `false` echo, Asterisk clears its subscription data and locally
terminates the event subscription; pjproject's termination function changes
local state without sending a SIP request
([pjproject implementation](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L1077-L1097)).
That callback does not report transfer completion. The initial REFER 2xx is
acceptance only, not proof of target-call completion or ownership settlement.
The callback checks the response header without recording whether the outgoing
REFER requested suppression; Asterisk may locally terminate on exact
`Refer-Sub: false` even when the request omitted it. Test request and response
values independently, and do not treat this local behavior as proof of valid
RFC negotiation
([Asterisk state and response check](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1161-L1164),
[RFC 4488](https://www.rfc-editor.org/rfc/rfc4488.html#section-4)).
401/407 REFER challenges have two source-level handlers. pjproject may retry
using dialog auth when credentials are configured in that dialog session.
The REFER path associates the endpoint with the dialog but does not copy its
`outbound_auths` vector there; Asterisk's separate retry explicitly uses that
vector. In the complete Asterisk 22.11.0 source tree, the outbound-auth helper
initializes and populates a stack-local `pjsip_auth_clt_sess`, uses it to
reinitialize the challenged txdata, then deinitializes it; the REFER setup
does not attach it to the dialog. A source-tree search finds no Asterisk call
to `pjsip_dlg_set_auth_sess()` or `pjsip_auth_clt_set_parent()`, and the only
call to `pjsip_auth_clt_set_credentials()` is in that endpoint-auth helper.
Thus the pinned Asterisk source provides no endpoint-credential wiring into
this REFER dialog's persistent auth session. This does not rule out downstream
patches or runtime code outside the pinned source
([Asterisk dialog construction](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip.c#L962-L1074),
[endpoint association](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip/pjsip_distributor.c#L291-L317),
[REFER dialog setup and endpoint-auth retry](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1326-L1338),
[stack-local endpoint auth session](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_outbound_authenticator_digest.c#L470-L598),
[temporary auth-session cleanup](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_outbound_authenticator_digest.c#L644-L649)).
Async auth is opt-in, but the pinned Asterisk 22.11.0 source tree contains no
call to `pjsip_auth_clt_async_configure()`. A new pjproject dialog auth session
starts with `async_opt = NULL`; for the REFER evsub, the async challenge
helper then returns non-success and `on_tsx_state_uac()` falls through to
synchronous `pjsip_auth_clt_reinit_req()`. Thus the pinned source follows the
synchronous path unless downstream or runtime code configures async auth
([dialog auth-session defaults](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L912-L945),
[async opt-in API](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1866-L1880),
[evsub async-to-sync fallback](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L1850-L1914)).
The transaction callback runs before the internal challenge handler, but
Asterisk's initial `SENT` subscription state does not enter its later
`ACTIVE`/`TERMINATED` retry branch. If synchronous auth fails, the terminal
callback can expose the original challenge to Asterisk's separate endpoint-auth
retry. That retry is initiated after the subscription is already terminated;
pjproject skips terminated no-event-id UAC subscriptions when associating
transactions, so the retry response does not get that subscription's state
callback. When Asterisk successfully creates fallback txdata, its callback
`goto out` leaves `res` clear and does not release the initial AO2 reference
stored as evsub module data. The original challenged transaction remains
counted as pending while the terminal callback runs; when it later terminates,
pjproject decrements the pending count and destroys the already-terminated
evsub without another Asterisk state callback. `evsub_destroy()` does not
clear module data or call the Asterisk REFER-object destructor. The retained
REFER object therefore has no cleanup in the pinned source control flow on
this branch, and its destructor's dialog-session decrement is not reached.
The missing cleanup is source-confirmed; the resulting object/dialog-session
retention is a leak candidate whenever fallback request creation succeeds,
regardless of whether the fallback send succeeds. Runtime validation should
measure the retained object and dialog-session lifetime; no downstream cleanup
hook is visible in the pinned Asterisk/pjproject paths
([pjproject subscription lookup](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L1591-L1688),
[Asterisk retry callback](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1326-L1338),
[REFER module-data setup](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1426-L1461),
[retained-dialog destructor](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1235-L1252),
[pending transaction and subscription destruction](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L2433-L2467),
[evsub destruction behavior](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L560-L590)).
This association gap applies to Asterisk's terminal fallback, not
pjproject's own dialog-auth retry: pjproject attempts that retry before
terminating the evsub, so its new transaction can still be associated by
`Event: refer`. Trace the two retry branches separately
([pjproject retry ordering](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L1825-L1914),
[transaction association](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L1520-L1688)).
That distinction is conditional: if dialog auth cannot reinitialize or send
the retry, pjproject terminates the evsub and delivers the challenge to
Asterisk. A credential rejection without a stale nonce is one such failure;
stale=true or a changed nonce can instead permit another dialog-auth attempt.
The initial REFER request calls `pjsip_auth_clt_init_req()`, which resets the
cached realm/algorithm stale counter. Auth retries use
`pjsip_auth_clt_reinit_req()` followed by dialog send, so they do not repeat
that reset: `PJSIP_MAX_STALE_COUNT` applies across the retry transaction
sequence for that challenge, but not across later, freshly created requests.
When initialization completes its cached-auth loop, it has zeroed every stale
counter in the session, not just the pair challenged by that request
([counter-reset loop](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1373-L1391)).
The pjproject 2.17 header defaults `PJSIP_AUTH_QOP_SUPPORT` to 1, while
`PJSIP_AUTH_HEADER_CACHING` and `PJSIP_AUTH_AUTO_SEND_NEXT` default to 0.
Asterisk 22.11.0's bundled `config_site.h` explicitly sets
`PJSIP_AUTH_ALLOW_MULTIPLE_AUTH_HEADER` to 0, matching pjproject's default.
These are source/build defaults, not proof of a particular deployed binary's
effective compiler definitions; inspect that build's configuration before
applying conditional cache, regeneration, or multi-header findings
([pjproject auth defaults](https://github.com/pjsip/pjproject/blob/2.17/pjsip/include/pjsip/sip_config.h#L1202-L1237),
[multiple-header default](https://github.com/pjsip/pjproject/blob/2.17/pjsip/include/pjsip/sip_config.h#L1368-L1372),
[Asterisk bundled override](https://github.com/asterisk/asterisk/blob/22.11.0/third-party/pjproject/patches/config_site.h#L109-L111)).
When `PJSIP_AUTH_HEADER_CACHING` is enabled, that same initialization can
shallow-clone a cached Digest Authorization header onto the new request when
the cached entry has no qop and its method matches. Thus a fresh request can
both reset the stale budget and reuse a cached header; verify the deployed
build option, method, and resulting header rather than treating request
initialization as a counter reset alone
([header caching on Digest response](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1204-L1256),
[header reuse on request initialization](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1373-L1428)).
That method-keyed cached header does not distinguish WWW from Proxy
authorization. With header caching enabled, qop-less challenges for the same
realm and algorithm arriving as both 401 and 407 use the same cached auth
entry; a later successful response replaces the cached method's header with
the other class, and a subsequent initialized request clones that
class-specific header. This cache replacement/reuse is source-confirmed;
runtime validation should capture the deployed build setting, request
destination, and peer response
([class-specific header creation and method-only cache](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1204-L1256),
[header clone](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1373-L1428)).
The cache lookup is by method, not Request-URI, while the cached Digest
header's `uri` and response were generated for the original Request-URI. For a
same-method request whose URI changes, the qop-less cache-hit path shallow
clones that cached header into the new request without regenerating its
credentials; `PJSIP_AUTH_AUTO_SEND_NEXT` regeneration is reached only when no
cached header for that method is found. Thus the new request can carry a
Digest header whose `uri` and response still correspond to the old Request-URI.
This is a source-confirmed construction result, not evidence the peer accepts
the credential for the changed URI; confirm the deployed build options and
capture the emitted header and peer response
([cached method key](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1237-L1256),
[cached header clone](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1387-L1400),
[cache-miss-only regeneration](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1408-L1422),
[Digest URI assignment](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L650-L672)).
Separately, when both `PJSIP_AUTH_QOP_SUPPORT` and
`PJSIP_AUTH_AUTO_SEND_NEXT` are enabled, initialization can regenerate a
qop-auth Digest header for a later request from the cached challenge.
`auth_respond()` runs the nonce-count update during that generation, so `nc`
may advance on a fresh request rather than only on a 401/407 retry. Confirm
both build options and inspect the generated header and `nc`
([automatic qop-auth regeneration](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1428-L1460),
[nonce-count update](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L719-L810)).
The initialization paths also handle failures differently. On a qop-less
cache miss, `new_auth_for_req()` generates a header against the current
Request-URI and adds it directly only after successful credential lookup and
digest generation. Its status is ignored by `pjsip_auth_clt_init_req()`;
missing credentials, a missing previous challenge, or an `auth_respond()`
error therefore does not itself fail request initialization and leaves that
auth entry without a generated Authorization header. This remains true when
header caching is disabled, where every qop-less entry takes the regeneration
path. By contrast, a missing qop-auth credential skips that cache entry, while
an `auth_respond()` error in the qop-auth path is returned immediately. These
are source-confirmed status/header-construction differences; runtime
validation need only establish deployed build options and the resulting
request or wire headers
([qop-less generator and direct header add](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1278-L1308),
[ignored cache-miss status](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1392-L1422),
[qop-auth regeneration and errors](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1428-L1460)).
Because that qop-auth error returns from inside the cache loop, entries later
in the list have not yet had their stale counters reset, and any headers
already queued in the local `added` list are not attached before the return.
Test a failing qop-auth cache entry followed by another cached realm/algorithm
entry and inspect both counters and the initialized request headers. If an
earlier qop-auth entry regenerated successfully, its cached `nc` may already
have advanced before a later entry aborts initialization, even though the
queued Authorization header is never attached; distinguish this state change
from a request sent on the wire
([qop-auth iteration and early return](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1428-L1460),
[nonce-count update](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L719-L810),
[deferred header attachment](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1460-L1508)).
For a later outgoing REFER, this init error occurs before a transaction is
created or the request is sent: dialog request creation returns the status,
`pjsip_evsub_initiate()` propagates it, and Asterisk takes its REFER
request-creation failure cleanup path. This is not a received 401/407, so it
does not enter the response-driven endpoint-auth fallback. There is also a
dialog-sequence boundary: `pjsip_evsub_initiate()` returns immediately when
dialog request creation fails, before any request is sent.
`pjsip_dlg_send_request()` is where pjproject updates the outgoing CSeq
(`dlg->local.cseq++`), so this pre-send auth-init failure does not consume a
dialog CSeq.
([evsub initiate error return](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L1136-L1160),
[dialog request creation return](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_dialog.c#L1293-L1335),
[CSeq update during dialog send](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_dialog.c#L1360-L1410)).
Separately, the source confirms an unreleased txdata reference: request
construction initializes the new txdata's reference count to one, and
`dlg_create_request_throw()` returns on auth-init error before assigning it
to its output pointer. The
outer `pjsip_dlg_create_request()` only decrements txdata when that pointer is
non-NULL, so the request's initial reference is not released on this path.
This confirms the lost reference in source; the cache-pool teardown below
establishes the pool's maximum lifetime in the Asterisk unload path
([dialog request construction and early return](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_dialog.c#L1225-L1284),
[outer request cleanup](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_dialog.c#L1293-L1335),
[request txdata initialization and error cleanup](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_util.c#L399-L473),
[txdata pool creation and refcounted destruction](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_transport.c#L490-L589),
[evsub initiate propagation](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L1136-L1210),
[Asterisk REFER creation failure path](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1458-L1491)).
Each failed request therefore leaves its txdata object and separately
allocated pool with the initial reference outstanding; repeated occurrences
can accumulate retained txdata/pools while the PJSIP module remains loaded.
Asterisk destroys its pjproject caching pool during `res_pjsip` unload, and
pjproject's caching-pool teardown explicitly frees pools still on its used
list. Because the txdata object is allocated from its pool, that teardown
also reclaims the unreleased txdata storage without decrementing its reference
count. This is therefore a runtime/module-lifetime retention issue, not an
allocation shown to persist beyond that teardown
([Asterisk PJSIP unload and cache destruction](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip.c#L3793-L3832),
[pjproject caching-pool destroy](https://github.com/pjsip/pjproject/blob/2.17/pjlib/src/pj/pool_caching.c#L97-L129),
[active pools added to the used list](https://github.com/pjsip/pjproject/blob/2.17/pjlib/src/pj/pool_caching.c#L134-L218)).
The optional transport-manager txdata tracking list does not add another
retained-list concern in the pinned default configuration: pjproject defaults
`PJSIP_HAS_TX_DATA_LIST` to `0`, and Asterisk's bundled `config_site.h` does
not override it. A custom build that enables this option would need separate
review of the txdata-list cleanup path
([pjproject option default](https://github.com/pjsip/pjproject/blob/2.17/pjsip/include/pjsip/sip_config.h#L1544-L1548),
[conditional list insertion](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_transport.c#L525-L530),
[Asterisk bundled config](https://github.com/asterisk/asterisk/blob/22.11.0/third-party/pjproject/patches/config_site.h)).
Subscription cleanup is separate from the potentially unreturned txdata
reference. On request-init failure, Asterisk releases the REFER object, clears
the evsub module data, and terminates the subscription without notification.
No request transaction was sent, so `pending_tsx` remains zero. The new UAC
dialog's temporary Asterisk session hold has already been dropped, and evsub
creation adds the only remaining dialog session hold. The REFER object stores
the dialog pointer without acquiring another session, but its destructor
calls `pjsip_dlg_dec_session()`. On this branch, `ao2_cleanup(refer)` runs
before `pjsip_evsub_terminate(sub, PJ_FALSE)`; the destructor's servant task
runs inline or is synchronously waited for. With the traced one-session,
zero-transaction state, that decrement reaches zero and pjproject's dialog
unlock path calls `unregister_and_destroy_dialog()` before the subsequent
evsub termination accesses `sub->dlg`. The premature dialog destruction and
resulting use-after-free sequence are source-confirmed for this state; runtime
reproduction is still needed to establish whether the deployed build manifests
a crash. This dialog-lifetime issue is distinct from the separate unreturned
txdata reference; the same cleanup callbacks do not release that reference
([Asterisk failure cleanup](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1483-L1491),
[REFER-object dialog decrement](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1235-L1252),
[synchronous servant decrement](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip.c#L2150-L2158),
[Asterisk temporary dialog session hold](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip.c#L998-L1074),
[zero-initialized dialog state](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_dialog.c#L80-L130),
[evsub session increment](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L935-L957),
[dialog destruction at zero sessions](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_dialog.c#L1040-L1084),
[evsub termination accesses dialog](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L1077-L1097),
[evsub terminal destruction condition](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L684-L705),
[evsub session release](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L560-L590)).
Any Digest nonce-count changes made while initializing this failed REFER are
local to its dialog auth session: Asterisk creates a new UAC dialog for each
out-of-dialog REFER, so the changed `nc` is not carried into a later REFER's
newly created dialog, regardless of this dialog's final lifetime
([per-REFER dialog creation](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1430-L1434),
[dialog-owned auth-session initialization](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_dialog.c#L111-L128)).
The cached qop mode is set only while its value is `PJSIP_AUTH_QOP_NONE`; it
is not reset when a later challenge for the same realm/algorithm omits qop.
With qop support and auto-send-next enabled, that qop-less challenge can
replace `last_chal` while the cached mode remains qop-auth. A later request
then enters the qop-auth regeneration branch, but `respond_digest()` explicitly
supports an empty-qop challenge by generating a Digest response without qop,
`nc`, or `cnonce`. Because the cached mode remains qop-auth, subsequent
initializations continue through that regeneration branch unless another
challenge changes the cached state. This is not an unsupported-qop error;
verify the generated Authorization fields and the cache mode on the deployed
build
([qop-mode assignment](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1204-L1256),
[qop-less challenge retention](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L719-L758),
[fresh-request qop branch](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1428-L1460),
[qop response generation](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L670-L714)).
With `PJSIP_AUTH_HEADER_CACHING` disabled, an already initialized qop
session's `update_digest_session()` increments `nc` for an unchanged nonce
without refreshing `last_chal`. On a nonce change, it copies only nonce and
changed opaque into `last_chal`, not the rest of the new challenge fields
(such as qop, domain, or stale). If `PJSIP_AUTH_AUTO_SEND_NEXT` is enabled,
later request initialization can therefore regenerate from stale cached
challenge fields even though the just-processed challenge had different
values. By contrast, when `PJSIP_AUTH_HEADER_CACHING` is enabled, the
successful-auth path clones the full new challenge into `last_chal`, so those
fields are refreshed there. This contrast is source-confirmed; runtime checks
should confirm the deployed options and resulting generated header
([selective cached challenge update](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L779-L810),
[header-caching challenge refresh](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1240-L1268),
[fresh-request regeneration](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1428-L1460)).
Each counter is scoped to a cached case-insensitive realm/algorithm pair, so
multiple supported challenge pairs have independent stale-retry budgets rather
than sharing one request-wide count
([cache key](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L814-L840)).
When the Digest `algorithm` parameter is omitted, pjproject resolves it to
MD5; omitted and explicit `algorithm=MD5` challenges therefore share the same
realm/MD5 cache and stale counter
([algorithm default](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L526-L545),
[cache creation](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1771-L1790)).
The cache key also omits the WWW-versus-Proxy challenge class: sequential 401
and 407 challenges with the same case-insensitive realm and resolved algorithm
reuse the same cached auth context, although the Authorization header class
and authenticating peer differ. Stale-state evaluation and counter increment
also require a prior Authorization header matching the challenge's class,
realm, and scheme, so cross-class cache reuse alone does not guarantee the
counter advances. Verify cache reuse separately from counter advancement in
multi-hop scenarios, both with and without a matching prior class-specific
header
([lookup key](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L814-L840),
[cache creation](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1771-L1796),
[stale-state check](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1580-L1675)).
For qop-enabled Digest, the shared entry also holds `cnonce`, `nc`, and the
last challenge. Sequential same-realm/same-algorithm 401 and 407 challenges
can therefore advance or reset the same nonce-count state even though each
response produces a different Authorization header class. With an unchanged
nonce the count advances; a changed nonce resets it. Capture `nc`, nonce, and
header class independently across the proxy/server hop
([shared qop state](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L719-L810),
[challenge-class-specific header creation](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1204-L1220)).
When a cached qop session receives a changed nonce, pjproject resets `nc` to
1 but does not regenerate `cnonce`; that value is initialized only when the
cache's cnonce is empty. Verify emitted `cnonce` alongside nonce and `nc`
across changed-nonce challenges, including class changes
([cnonce initialization and nonce-count reset](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L753-L810)).
The pjproject 2.17 default is 3 unless overridden at build time. Confirm the
deployed value: the counter increments before its `>=` check, so the default
allows two stale retries, and a third stale challenge ends pjproject's retry
path. A challenge's `stale=true` flag permits that retry even if its nonce is
unchanged; only when `stale` is false does pjproject use a changed nonce as an
alternative stale signal. This stale evaluation and counter increment happen
only when the challenged request already contains a matching Authorization
header; an initial `stale=true` challenge with no prior matching header does
not consume the stale budget and may still produce the first credentialed
request. With a matching prior header, `stale=false` and an unchanged nonce
returns `PJSIP_EFAILEDCREDENTIAL` without incrementing the stale counter. Test
the initial no-header case, each subsequent combination, exhaustion, and a new
request separately before concluding that a challenge uses only one retry path
([auth reinitializer errors](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1559-L1705),
[stale retry classification](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1580-L1675),
[initial request auth initialization](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_dialog.c#L1265-L1270),
[evsub auth fallback](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L1825-L1914),
[default stale retry count](https://github.com/pjsip/pjproject/blob/2.17/pjsip/include/pjsip/sip_config.h#L1244-L1249)).
For a stale challenge that matches a prior Authorization header, pjproject
increments and checks the stale counter before looking up credentials or
generating a replacement digest. Missing credentials or a digest-generation
error can therefore consume the internal stale budget without producing a
replacement Authorization header; measure actual retries separately from
counter advancement
([stale check and credential processing](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1580-L1675)).
This retry budget is distinct from Digest qop `nc`: with qop enabled and the
same nonce, `update_digest_session()` increments the nonce-count even when the
challenge explicitly says `stale=true`; a changed nonce resets `nc` to 1.
That state update occurs before qop validation and digest response generation,
so a failed attempt (for example, an unsupported qop offer) can advance the
cached nonce-count without producing an Authorization header. Do not infer an
emitted `nc` from the internal counter alone; verify both processing status
and the wire header
([nonce-count update](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L719-L810),
[pre-response state update](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1204-L1220),
[qop validation](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L670-L714)).
This stale counter belongs to pjproject's persistent dialog-auth session.
Asterisk's endpoint-auth fallback initializes a fresh stack-local auth session
per helper invocation, so repeated fallback callbacks (if observed) do not
inherit that counter. The helper returns the authenticated txdata, not its
temporary auth session (and deinitializes that session before returning where
the API is available), so it does not install endpoint credentials into the
dialog's persistent auth session. A later fallback must reconstruct credentials
from endpoint configuration rather than inherit that auth cache; track
repeated callbacks against Asterisk's separate
`MAX_RX_CHALLENGES` branch limit
([Asterisk auth helper](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_outbound_authenticator_digest.c#L470-L598),
[temporary auth session cleanup](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_outbound_authenticator_digest.c#L644-L649),
[REFER callback limit](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1326-L1338)).
If configured async auth is abandoned, pjproject terminates the evsub and
substitutes a dummy `PJSIP_EVENT_USER` for the NULL event. Asterisk maps that
non-transaction event to status 500 and handles it as terminal failure; it
does not enter the 401/407 fallback branch or send a zero-expiry SUBSCRIBE
because the subscription is already terminated. This is distinct from a
transaction-response event
([pjproject abandonment and event substitution](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L618-L684),
[Asterisk event handling and terminal-state behavior](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1318-L1378)).
Asterisk's counter allows at most nine qualifying callback attempts; it
increments before checking endpoint availability or creating a request, so a
missing endpoint or failed construction consumes the budget and fewer than
nine retries may be sent. This is only a callback-branch threshold, not
necessarily a limit on sequential wire retries: the terminal-state retry may
not remain associated with a live evsub, so its response may not reach
Asterisk's callback. This does not bound pjproject's separate attempts.
The auth reinitializer starts from the challenged `last_tx`, adding
Authorization and changing the Via branch rather than rebuilding the REFER;
the original Refer-To and caller-supplied headers, including Refer-Sub, are
therefore expected to carry over. Asterisk also skips its Refer-To rewrite
when Authorization is already present. Capture the wire retry to verify
headers and URI handling
([pjproject reinitializer](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1708-L1861),
[Asterisk rewrite guard](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1200-L1220)).
This reinitializer operates directly on the supplied txdata (`tdata =
old_request`), not on a clone. When it classifies a prior matching
Authorization header as stale, it removes that header before credential
lookup and digest generation; if either later fails, the failed
reinitialization does not restore it. In the evsub challenge path, the
supplied txdata is `tsx->last_tx`, and Asterisk's terminal-state fallback also
passes that same `last_tx` to its endpoint-auth helper. Therefore, when
internal auth classifies the old header stale and then fails, the fallback
starts from the mutated request without that header. This mutation and input
identity are source-confirmed; capture the fallback's actual emitted headers
and result at runtime
([in-place reinitializer and challenge loop](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1708-L1861),
[stale-header removal](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1580-L1675),
[evsub reinitialization input](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L1875-L1914),
[Asterisk fallback input](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1318-L1338)).
For multiple WWW/Proxy challenges, pjproject processes each challenge and
continues after an unsupported or uncredentialed challenge. If it creates at
least one Authorization header, it returns success and retries the mutated
original request; failures from the other challenges do not necessarily prevent
that partial retry. Existing Authorization headers that do not match a
challenge's class, realm, and scheme can remain alongside newly created
headers, so inspect the complete final header set. There is an important
same-realm interaction:
after one challenge adds a header, a later matching stale challenge in the
same response can remove it before attempting replacement credentials. If
that later attempt fails, the success count is not decremented, so
reinitialization can still return success even though that earlier header is
no longer present. Asterisk may then attempt to send the mutated request;
capture the final header set rather than infer it from the success status. If
no challenge succeeds, the function returns the last failing challenge's
error, so challenge order can affect the result
([challenge loop and completion status](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1736-L1844),
[prior-header removal](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1580-L1675)).
For multiple Digest algorithms under the same realm/auth type,
`PJSIP_AUTH_ALLOW_MULTIPLE_AUTH_HEADER` defaults to 0; a later challenge may
replace or reject an earlier header depending on nonce/stale values instead of
retaining both. Without the option, previous-header matching checks class,
realm, and scheme but not Digest algorithm; a different-algorithm challenge
can therefore compare stale/nonce state against the earlier algorithm's header
and increment the new algorithm's cached counter. With the option enabled,
different-algorithm headers are skipped by that prior-attempt check and can be
retained alongside the new header. Verify both challenge orders, counter
effects, the deployed compile-time setting, and emitted headers
([header handling](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1584-L1675),
[default](https://github.com/pjsip/pjproject/blob/2.17/pjsip/include/pjsip/sip_config.h#L1365-L1372)).
Asterisk's endpoint-auth helper prefers a case-insensitive exact realm match
even if a wildcard auth object appeared earlier; among duplicate exact or
wildcard matches, the first eligible object wins. It also deduplicates
challenge realms case-insensitively. Eligibility depends on the challenge
algorithm and a usable credential: an exact-realm auth object that cannot
supply the challenged algorithm does not prevent an eligible wildcard object
from being selected. For each realm, it takes credentials
from the first supported challenge that also has a matching endpoint auth
object; an unsupported challenge or missing credential does not by itself
prevent a later same-realm challenge from being considered. Challenge-header
order can therefore decide which Digest algorithm is used once a matching
credential is found. Test these selections separately from
pjproject's generic lookup: it checks algorithm eligibility first, returns an
eligible exact-realm credential immediately, and otherwise chooses the last
eligible literal `*` wildcard credential in its list; an empty credential
realm is not a pjproject wildcard. Asterisk, by contrast, accepts empty or `*`
configured auth realms as wildcard objects, then supplies the concrete
challenge realm in the credential passed to pjproject. Its helper supplies at
most one credential per realm, so duplicate-wildcard list ordering applies
only to other pjproject callers. If a pjproject auth session has a parent, its
credentials are searched first and a parent wildcard can precede a child exact
match. That parent lookup does not apply to the fresh out-of-dialog REFER
dialog traced here: pjproject initializes each new dialog auth session with
`parent = NULL`, and the Asterisk dialog-creation and REFER setup path does
not attach a parent session. Consequently, this dialog's persistent auth
session searches only its own credentials; the separate endpoint-auth
fallback's stack-local session is not its parent
([credential lookup](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L843-L901),
[parent initialization](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L912-L945),
[dialog auth-session initialization](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_dialog.c#L104-L114),
[Asterisk dialog creation](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip.c#L998-L1074),
[REFER dialog creation](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1430-L1434),
[explicit dialog parent setter](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_dialog.c#L2606-L2610)).
These source paths establish which credentials the client selects and headers it
constructs, not which credential the peer accepts. Establish peer acceptance
with peer-side evidence or controlled tests that offer one candidate credential
at a time
([Asterisk selection](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_outbound_authenticator_digest.c#L91-L248),
[per-realm challenge handling](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_outbound_authenticator_digest.c#L303-L426),
[pjproject credential lookup](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L843-L901)).
That Asterisk helper also keys the challenge-header class to status: its
401 path scans `WWW-Authenticate`, while 407 scans `Proxy-Authenticate`.
Test those pairings and any opposite-class challenge separately
([status/header selection](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_outbound_authenticator_digest.c#L44-L61)).
pjproject's dialog-auth reinitializer differs: after accepting either 401 or
407, it scans both `WWW-Authenticate` and `Proxy-Authenticate` headers without
filtering by response status. An opposite-class challenge with usable
credentials can therefore produce the other Authorization header class in
pjproject's retry, while Asterisk's endpoint fallback selects only the class
associated with the status. Test the two retry paths separately
([pjproject status guard and challenge scan](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_auth_client.c#L1720-L1755),
[Asterisk status/header selection](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_outbound_authenticator_digest.c#L44-L61)).
Its UAC challenge lookup does not use the global default realm; it requires
matching endpoint outbound-auth credentials (exact or wildcard). A global
default realm alone is not a substitute
([Asterisk challenge matching](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_outbound_authenticator_digest.c#L147-L155)).
Asterisk then sends it through the stateful dialog helper: pjproject assigns
the next local CSeq and creates a new UAC transaction. The `auth_retry` txdata
marker does not resume the challenged transaction or restore subscription
association. Its explicit evsub check appears in challenged NOTIFY response
handling; the UAC REFER challenge branch does not consult it. Verify CSeq and
response association on the wire
([Asterisk send helper](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip.c#L1488-L1495),
[pjproject dialog send](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_dialog.c#L1361-L1445),
[auth retry marker](https://github.com/pjsip/pjproject/blob/2.17/pjsip/include/pjsip/sip_transport.h#L655-L663),
[REFER challenge handling](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L1825-L1914),
[NOTIFY-only flag check](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L2328-L2342)).
Asterisk's digest helper also increments the cloned request's CSeq after
reinitialization, but dialog send overwrites it from the current
`local.cseq`. If another in-dialog request intervenes, verify the final CSeq
on the wire rather than attributing it to that pre-increment
([Asterisk helper increment](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_outbound_authenticator_digest.c#L590-L614),
[pjproject assignment](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_dialog.c#L1390-L1405)).
Asterisk ignores the retry send result; at its own retry limit, it
attempts a zero-expiry `SUBSCRIBE` only if the subscription is not already
terminated, and ignores that send result too. Capture event types, requests
actually sent, challenge codes, credentials, subscription state, any
peer-visible unsubscribe, and cleanup
([Asterisk retry path](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1309-L1378),
[pjproject auth path](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L1825-L1914),
[pjproject callback ordering](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L2433-L2455),
[Asterisk state gate](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1281-L1310),
[pjproject async abandonment](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L605-L684),
[pjproject send result](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L1441-L1493),
[send result](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip.c#L1488-L1495)).
Asterisk's `Refer completed` debug line is emitted for statuses at or above
200, with 2xx classified as success and other codes as failure; it may
therefore describe an intermediate challenge, not target-call completion
([status classification and log](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1358-L1378)).
The lookup also uses only the first matching response header, making conflicting
duplicates order-sensitive; test both orders and reject duplicates as ambiguous.
Test exact/case-varied values, extension parameters, absent headers, and cleanup
without inferring success from the suppressed-subscription path.
An exact retransmission of the same branch/CSeq is handled by the existing UAS
transaction; while it remains in `TRYING` without a saved response, pjproject
ignores the retransmitted request rather than rerunning the supplement or
resending a response
([lookup](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_transaction.c#L937-L1017),
[TRYING handling](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_transaction.c#L3104-L3143)).
A retry with a new Via branch and higher CSeq is a distinct REFER and can
reach the gate while the original bridge action is pending, so transaction
deduplication alone does not prevent duplicate work. The operation owner needs
an idempotency key or must reject a second unresolved operation; separately
verify cleanup/lifetime of the unanswered transaction. Source inspection
shows the UAS `TRYING` path does not arm the normal final-response timeout;
exact retransmissions are ignored without scheduling a response. Test whether
the transaction remains registered beyond 64*T1 on unreliable transport, and
confirm separately that reliable transport also has no timeout while the
transaction remains in `TRYING`. The ordinary non-INVITE Timer J is started
only after a final response is successfully sent; it is 64*T1 on unreliable
transport and zero on reliable transport.
The transaction layer unregisters only after `DESTROYED`, while the dialog
counts the transaction until `TERMINATED` and cannot destroy itself while that
count remains nonzero
([transaction destroy/unregister](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_transaction.c#L1556-L1563),
[dialog count and destroy guard](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_dialog.c#L1035-L1059),
[transaction count update](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_dialog.c#L2342-L2379)).
This predicts retained transaction/dialog resources until a termination event
or endpoint transaction-layer shutdown; it remains a source-derived lifecycle
risk to verify, not a runtime-confirmed leak.
If new-branch/higher-CSeq retries repeat the same failed response path, each
may leave another transaction registered and increase dialog-held resources.
Measure repeated retries and prove every attempt is bounded or terminated;
an operation latch prevents duplicate transfer work but does not by itself
clean up leaked PJSIP transactions.
The session-supplement header warns that callback request data is cloned, but
the pinned in-dialog REFER callback path passes the transaction event's
`src.rdata` directly through Asterisk's session callback. pjproject attaches
the active transaction to that same `rdata` before invoking the `TRYING`
callback. Thus the `Refer-Sub: false` response path has a transaction in this
source trace; the local UDP spot check's `404` response confirms it for that
unknown-target case. This invalidates the clone-based NULL-transaction and
unreleased-txdata hypothesis for this path. Asterisk still ignores the send
result, so test transport-send failures and bridge-action ordering separately
([Asterisk response creation and send](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L2069-L2088),
[transaction attached to rdata](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_transaction.c#L2123-L2137),
[Asterisk transaction callback dispatch](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_session.c#L4839-L4849)).
The actual in-dialog request transaction belongs to the dialog, so
`pjsip_dlg_respond()` can use it; its argument and dialog-ownership checks
still apply
([response guard](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_dialog.c#L1720-L1764)).
Asterisk's early `400`/`404` branches ignore that return. The custom gate
can use the dialog-owned active transaction through `pjsip_dlg_respond()` or
build/send a stateful response with the existing transaction; it must check
and surface errors. `ast_sip_send_stateful_response()` remains unsuitable
inside this callback because it tries to create a second UAS transaction with
the same key, which pjproject rejects with `PJ_EEXISTS`. A stateless response
helper sees the active transaction and refuses to bypass it; it does not hide
the transaction in this path. PJSIP's generic unhandled
request `500` is not a reliable fallback here: Asterisk's dialog usage marks
an in-dialog method handled whenever a matching session supplement exists,
independent of the supplement callback's return
([supplement check](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_session.c#L4194-L4209),
[handled return](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_session.c#L4267-L4297),
[PJSIP fallback](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_dialog.c#L1931-L1950)).
Thus a failed response helper may leave no final response rather than get a
generic `500`; capture the peer-visible result and retransmissions. A custom
response path should use the active transaction already associated with this
request, not create or look up a duplicate transaction. Watch send failures:
pjproject records the final status before transport send, but leaves the
transaction short of `COMPLETED` if that send fails. Independently, Asterisk's
matching session supplement marks the request handled, so PJSIP's generic
unhandled-request `500` is suppressed even if the transaction status is still
provisional. The gate must stop transfer handling even on this error and
surface the missing-response condition.
For an allowed request, returning zero continues into Asterisk's built-in
transfer callback; that alone does not bind transfer work to a custom claim.
A custom propagation callback requires the supplement to own the transfer,
response, and progress lifecycle and stop later handling, or the design must
prove another mechanism correlates and settles built-in work to the reservation.
The built-in handler attempts `404` before progress setup when its session has
no channel, and attempts `400` for missing or malformed `Refer-To`. These
branches use `pjsip_dlg_respond()` and ignore its return, so response delivery
still depends on successful response construction and send. The matching
REFER supplement still makes the dialog usage report the request handled, so
PJSIP does not supply a generic fallback `500`; verify the actual wire
response or timeout. No such request may create a transfer claim.
For blind REFER, Asterisk routes using `TRANSFER_CONTEXT` (or the endpoint
context) and the `Refer-To` URI user, not its displayed URI as a whole. With
`ignore_uri_user_options` enabled it truncates user text at `;`, and an empty
user becomes extension `s`; admission must validate that same effective target
and pin the global setting.
The built-in handler also dispatches a target URI containing `Replaces` to the
attended-transfer path, so a blind-only gate must reject that parameter rather
than validating only the URI user.
Asterisk's progress watcher tracks the transferee's frames/bridge re-entry; its
internal `completed` flag
marks transfer-action preparation, not target answer. Progress NOTIFY is thus
not an identity-complete record for forked target legs.
With `refer_blind_progress=no`, the callback queues terminal `200` before the
two-party bridge action is enqueued; if enqueue then fails, Asterisk can also
queue a failure NOTIFY and return a non-200 REFER response. This success-shaped
sipfrag is possible without a framehook race and must not be treated as
transfer success.
In the two-party path, `completed` is already set when the callback attaches
the progress framehook, before the bridge action is enqueued. If that enqueue
fails, a concurrent frame may still produce a progress `200`; test and record
this separately from core transfer failure and target signaling. For a
non-200 transfer result, Asterisk also queues a failure NOTIFY, so wire order
and any competing terminal sipfrags must be captured.
The `completed` field is a plain integer read from both the channel framehook
and bridge Stasis callback and written by parking/core paths; the separate
pooled subscriptions do not establish cross-callback synchronization. This is
an unsynchronized-access candidate requiring concurrency validation, not a
confirmed runtime race or an admission mechanism.
Terminal NOTIFY allocation failure can also bypass cleanup in both progress
callbacks: unsubscribe/framehook detach are nested under successful allocation.
Verify injected failure and cleanup; treat missing progress as unresolved, not
as transfer settlement. For voice-derived answer, the framehook sets
`subclass` before allocation, so later voice frames do not retry the notification;
verify the hook is still cleaned through another path. This is source-level
behavior, not a confirmed permanent leak.
Even with successful allocation, terminal `ast_sip_push_task()` failure frees
the notification after detach/unsubscribe, with no retry in those callbacks.
Test task-queue failure and require channel/claim reconciliation when NOTIFY is
missing.
If copying the transferee unique ID fails, the callback still creates a bridge
subscription; that callback later passes the NULL field to `strcmp()`. Inject
the failure and prove this cannot reach an unguarded comparison or be mistaken
for successful transfer/claim settlement. This is a potential invalid access,
not a confirmed runtime crash.

The multi-party transfer callback receives the Local `;1` channel. Asterisk's
Local driver then inherits datastores to `;2` before starting its target
dialplan, but that copy can fail silently. The generated target route must
validate the inherited operation claim before any call-producing application,
and ownership must be proven across Local optimization into every actual target
leg. The Local bridge swap/merge path does not itself guarantee datastore
transfer to the surviving target; the in-process owner must retain the parent
operation while any per-target child claim remains unsettled. Local-channel
hangup or optimization completion alone cannot settle active target work. A
child datastore's destroy callback may provide conservative final settlement
when the actual callee channel is destroyed, but that may lag hangup and must
not lose or deadlock the claim-owner handoff. Asterisk 22.11's `Dial()` also
has a forwarding bypass: replacement channels are signaled without rerunning
the per-callee `b()` hook. Forwarding must be intercepted or explicitly
disabled on every protected route before the admission design can be complete.
Queue has the same bypass when member forwarding is allowed; its `i` option
suppresses member forwarding and is a candidate containment that must be
validated on every protected route. PJSIP `redirect_method=uri_pjsip` follows
3xx redirects inside `chan_pjsip`, supports multiple potential targets, and
cannot be prevented by core handling; protected endpoints need a PJSIP-level
target gate or must exclude that mode. Asterisk 22.11's in-tree channel drivers
do not assign `pre_call` overrides, but deployment must reject or separately
audit out-of-tree drivers that could replace the configured admission Gosub.
AMI Originate, ARI Stasis channel dialing, and `ast_dial` callers can also
place calls outside Dial/Queue; their optional/absent predial Gosubs are not a
universal admission gate, so those APIs must be gated or restricted. Unlike
the `Dial()`/`Queue()` app-forward paths, generic `ast_dial` re-runs its
predial callback on a forwarded replacement when that caller configured one;
this remains opt-in and must not depend on inherited state if no requestor
channel exists.
The broader Asterisk 22.11 `ast_call()` inventory adds `FollowMe()`, core
call-forward/request-and-dial, bridge transfer, parking-feature, and DAHDI/PRI
idle-dial paths. These are not uniformly covered by dialplan callee hooks:
each must be explicitly admitted at its path or excluded by deployment policy.
Attended-transfer targets/recalls and parking remain outside the initial
supported set unless separately integrated or disabled. A source-wide scan
found channel technology `->call()` dispatch only inside core `ast_call()`,
which has no admission callback; this is a possible core interception point,
but Local calls can start dialplan/bridge/masquerade work, and `ast_call()`
holds the channel lock at dispatch. A safe gate must account for that lifecycle
and prove bounded execution and lock ordering; internal PJSIP redirects remain
a separate gap. Admission also has distinct stages: reserve transfer work
before it is queued, gate the Local/core call, then create a unique claim for
each outbound branch. No one stage substitutes for the others. This is not
implementation approval. The blind-transfer propagation callback returns
`void`: attachment failure cannot reject the queued/started transfer, so safe
support requires proving attachment cannot fail or adding an earlier abortable
interception point while preserving the existing call. Preallocation could
remove allocation failure, but Asterisk's pinned datastore-add helper always
returns success and does not detect duplicate attachments, so exact-once
association still needs a locked, serialized proof. Parking is an additional
bypass: its multi-party path inherits datastore state and calls a Local channel
before the supplied transfer callback, and can retry the callback after
bridge-insertion failure. A source-channel operation claim plus a synchronous
Local `ast_call()` gate is not enough: Local copies datastores from `;1` to
`;2` after that gate, ignores inheritance failure, and starts the PBX thread
before the transfer callback. The callback's later `;1` attachment cannot
repair `;2`; finite datastore inheritance also needs enough hops for the
parking/Local/target-leg path. Safe support needs validation after inheritance
but before `ast_pbx_start()`; a first-priority dialplan guard alone is too late.
Pinned `core_local.c` has no callback in that interval, so this appears to
require a version-pinned Local/core change; a PJSIP supplement alone cannot
provide it. If a multi-party parking Local succeeds but bridge insertion fails
after the parking callback, ordinary fallback reuses the REFER transfer wrapper;
PJSIP progress setup replaces one set of target, framehook, and subscription
fields while acquiring new references on each callback invocation, with no
visible repeated-setup cleanup. This is a potential lost-correlation/resource
cleanup defect; the progress fields are also shared by the callback, framehook,
and bridge subscription without an evident common lock. This potential
cross-thread state race requires focused validation and an upstream fix or
explicit path exclusion before relying on parking fallback. The Local target
PBX is already started before the parking callback and bridge insertion; a
failed bridge insertion then runs ordinary transfer against the same
destination. Source ordering does not prove the first route was stopped before
signaling, so fallback must prevent or explicitly account for overlapping
target attempts. On repeated progress setup, the older bridge callback can
match the overwritten target identity but unsubscribe the newer stored
subscription instead of itself; verify callback-specific unsubscribe and
single-target notification in the focused fallback test.
Fallback needs a separately settled child claim; ordinary multi-party fallback
fails before bridge insertion if its Local `ast_call()` is rejected, and the
two-party path does not remove the transferer when action enqueue fails. Built-in
PJSIP REFER maps a core transfer failure to `500`; synthetic proof must still
verify the source bridge and exact claim settlement. Otherwise protected
transfers must exclude parking.

The earlier [identity integration comparison](./AGENT-PROVISIONING-PLAN.md#98-os-identity-integration-options-comparison-not-selection)
now weighs three approaches: a maintained native Node binding, a socket-owning
credential helper, and a dedicated local runtime with Python as the current
fixture candidate. The subsequent approval selects the dedicated Python direction
for read-only implementation; no native package or helper protocol is selected.

The important invariant is connection ownership: credentials must come from the
exact accepted socket and remain bound to that request/lifetime. A reported UID,
PID or file-descriptor number must not become a reusable identity token for
another connection. A helper adds a trusted IPC/proxy boundary; a separate
runtime adds protocol-conformance and operational responsibilities; a native
binding adds native dependency and compatibility requirements.

The user approved the dedicated Python **read-only conformance fixture** described
above, joining real Linux credentials and a tested subset of the fixed
framing/readback contract on one socket. This is not a production runtime selection
or permission to implement PBX operations. The current TypeScript handler remains
an internal primitive with injected identity.

#### Linux Unix-socket peer-identity experiment (test only)

`.\scripts\Test-BrokerPeerProof.ps1` runs a separate Linux-only Python
standard-library experiment inside the existing `asterisk-local-diagnostics:proof`
image, resolved to its immutable local image ID before execution. It does not
build/pull an image automatically. If needed, build the existing diagnostics
image using its documented fixture workflow first.

The owned container has no network, published ports, PBX/control/config mounts,
Docker socket or writable repository. It mounts only the experiment script
read-only and a small disposable tmpfs. Unique container naming/ownership labels
limit cleanup to that invocation. A root fixture orchestrator sets up distinct
numeric Linux identities using only CHOWN/SETUID/SETGID/KILL capabilities; the
actual socket server and clients run non-root with **zero effective
capabilities**. The orchestrator is not a proposed broker deployment identity.

The server owns a mode-0750 directory and mode-0660 Unix socket. It obtains
`SO_PEERCRED` from the accepted connection and requires exact worker UID and
primary GID before reading any probe bytes, with positive PID returned for
comparison against the real client process. Tests prove:

- The approved UID/GID connects, completes a half-closed probe and reconnects.
- Another UID in the socket group can connect but is denied before request read.
- The approved UID with a wrong primary GID is denied even when a supplementary
  group permits filesystem access.
- An unrelated UID/GID cannot connect through the directory/socket permissions.
- The approved connecting worker cannot unlink the socket or create replacement
  entries in the broker-owned directory.

This demonstrates kernel identity and filesystem policy, **not a working broker
transport**. The Python probe intentionally does not reimplement the JSON/frame
protocol. The TypeScript handler's `identify` callback still has no OS credential
implementation; Python is not selected as the production broker language/helper.
The experiment uses processes in one container/PID/user namespace, not separate
deployment containers or user-namespace remapping. UID/GID provisioning,
cross-container credential interpretation, socket publication/replacement and
same-UID compromise remain separate deployment concerns. Do not treat kernel
PID as a durable application identity.

The launcher awaits bounded child processes and removes its owned container;
the server unlinks its socket and the temporary directory is removed. No
production service, PBX privilege, secret issuance or calling is enabled.

#### Opt-in broker connection admission (no listener)

`createAgentBrokerConnectionHandler(readback, identify)` composes the existing
read-only broker and bounded frame reader/writer for an already-accepted socket.
The caller explicitly invokes and awaits `handle(socket, signal?)`, handles its
rejection through protected operational logging, and owns the listener. This
factory does not bind an address, create a service or authenticate an OS peer.

The handler accepts one in-flight connection per instance, matching the
readback source's existing serial contract. A competitor is destroyed and
rejected before peer lookup or frame consumption. Each socket is single-use;
an overlapping call with the same socket rejects without destroying the
already-running operation. Different handler instances are not a shared
admission authority: use one owner for one source.

The synchronous trusted `identify(socket)` callback must obtain identity from
the connection's authenticated transport, not request bytes or a claimed
customer field. Its returned principal/customer/epoch is checked through the
same broker peer gate **before frame reading**. Failure or missing/foreign peer
identity rejects without source access. Identity metadata is detached before
the first await. The callback must not read/resume the socket or block the event
loop; Linux peer-credential support remains unimplemented.

An admitted socket must have an unused byte-mode read/write direction and
`allowHalfOpen: true`. One total cooperative five-second signal spans identity
checks, request EOF, readback and response finish, in addition to the individual
codec bounds. Cancellation/deadline or detected socket loss destroys the
connection. Errors reject without a success-shaped response. An uncooperative
source keeps the admission slot until its actual promise settles, even after
socket closure; it is never replaced with concurrent work. Local write finish
still does not prove peer acceptance.

A request half-close is normal, so TCP FIN is not treated as peer disappearance.
A client that stops reading without a detectable error may only be noticed by
write/deadline behaviour. A stalled event loop cannot enforce these timers.
The application must separately limit OS/listener backlog, total accepted sockets
and connection attempts; this handler bounds only work admitted through itself.
Kernel/stream buffering is outside its bounded payload copy.

Real ephemeral loopback tests verify peer rejection before reading, exactly one
admission, subsequent admission after cancellation/errors, source exception
propagation, deadline closure, and slot retention while an observation ignores
cancellation. All listeners and owned sockets are cleaned up. Tests still inject
peer metadata: they prove plumbing, not Unix-domain socket identity or permission
isolation. No production listener, PBX access, apply operation or recovery
mutation is enabled.

#### Bounded broker stream framing (no listener)

`encodeBrokerFrame(text, kind)` and `readBrokerFrame(stream, kind, signal?)`
provide a one-message byte-stream format for the unprivileged fixture. Each
frame has a four-byte unsigned big-endian UTF-8 payload length followed by exactly
that many bytes. Request payloads are 1..8192 bytes; responses are 1..32768 bytes.
The limits exclude the header and match readback's existing JSON bounds.

The reader validates the declared length before allocating its bounded payload,
handles split headers/payloads, and waits for EOF before returning text. Empty,
truncated, oversized, trailing or concatenated frames fail. Invalid UTF-8 fails
rather than being replaced; a BOM is preserved for the JSON layer to accept or
reject, not silently stripped. The codec does not itself parse or validate JSON.
Encoding and decoding are distinct from peer authentication.

Each fresh byte-mode stream is single-use, including after failure. The reader
rejects already-consumed, flowing, object-mode or text-decoded streams. It owns
consumption and destroys the stream on malformed data, premature close,
cancellation, source error or its five-second read deadline; original source
errors and cancellation reasons propagate. Listeners/timers are removed when
the read settles. No operation is invoked from a complete prefix while later
bytes or EOF are still outstanding.

This deliberately chooses **one request/response per connection**, not a
persistent or multiplexed protocol. A future socket transport must support
half-close: the client ends its request-writing direction, the server reads EOF,
then writes/ends its response direction. The connection owner must configure
that lifecycle explicitly, authenticate the peer before reading, bound connection
admission and outgoing writes, and handle/log failures. These codecs start no
listener and provide no socket authentication. The complementary bounded writer
and loopback lifecycle evidence are described below.
The bounded payload copy cannot prevent allocations already performed by an
upstream stream producer or operating-system buffering.

Tests use byte-mode streams to prove fragmented multibyte roundtrips, exact size
limits, early oversized-header rejection, late trailing bytes, EOF/deadline,
source errors, cancellation and listener cleanup. A framed request/response also
exercises the fixed readback handler; malformed framing never invokes its source.
Linux peer credentials and socket permissions still require separate
local-transport evidence before any privileged broker work.

`writeBrokerFrame(stream, text, kind, signal?)` now provides the complementary
bounded write/end primitive. It writes one validated frame, ends the owned
byte-mode writable direction and waits for local `finish`, with a five-second
deadline and optional cancellation. A writer is single-use, including after
failure; malformed size, invalid writable state, source error, premature close,
timeout or cancellation rejects and destroys that stream. Callers must provide
an unused direction and must not interleave their own writes. No connection
listener, retry or peer identity is created. Local `finish` is not evidence that
the peer received, parsed or accepted the frame.

The test-only loopback socket fixture now proves the actual half-close lifecycle
with `allowHalfOpen: true`: the client ends its request direction, the server
reads EOF, the fixed readback handler runs, and the response is framed/written
before that direction ends. A complete request without EOF does not invoke
readback; trailing bytes are rejected before source access. All owned sockets
and the ephemeral listener are closed after the test. Writable tests also prove
timeout under unresolved backpressure, cancellation/error propagation and
listener cleanup.

This TCP loopback fixture injects trusted test peer metadata. It is **not** a
production network endpoint, Linux Unix-domain peer-credential proof or deployed
broker. The opt-in handler above adds per-instance admission and lifetime composition;
actual local identity/permissions, listener-level limits and deployment lifecycle
remain unimplemented. No privileged PBX probe is enabled.

#### Unprivileged broker readback protocol fixture

`createAgentBrokerReadback(binding, source)` implements only fixed read-only
inventory/generation queries. `binding` contains deployment-pinned
`customer`, `epoch` and `principal`; `source` supplies observation callbacks.
The explicit `read(jsonText, peer, signal?)` entry point checks trusted peer
metadata before decoding or accessing the source, then rejects any body scope
mismatch. There is no listener, apply action, command forwarding or PBX access.

Accepted JSON requests have exactly these fields:

```typescript
{ version: 1, customer, epoch, action: "inventory" }
{ version: 1, customer, epoch, action: "generation", generationId }
```

Responses repeat version/scope/action. Inventory returns `generations` with
generation ID, deadline and durable drain flag; generation readback returns
`state: "missing"` only for exact `undefined`, or `state: "observed"` with
`observation: { newCallsBlocked, dialogs, removed }`. Unknown dialog counts stay
`"unknown"`. These are source observations, not operation receipts, verified PBX
readiness or authorisation to mutate. Adapter errors do not become missing state.

Request JSON is limited to 8 KiB UTF-8, inventories to 100 unique generations,
and responses to 32 KiB UTF-8. Exact fields, generation IDs, safe deadlines,
booleans and dialog counts are validated through the same detached validators
used by the expiry sweep. Extra secret/config fields are rejected, not echoed.
One request per instance may be in flight; a cooperative five-second budget and
optional caller cancellation are checked around source awaits. A stuck source
retains the overlap guard until it actually settles. Errors reject explicitly;
the future connection owner must log/notify through its protected error path.

**This fixture does not authenticate operating-system peers.** `peer` is trusted
out-of-band metadata supplied by a future authenticated connection owner, never
a caller-provided JSON field. Tests inject it to prove binding/denial order only.
No Unix socket, peer-credential check, connection admission limit or deployed
broker exists yet. The bounded framing codec above supplies the stream-read
primitive, but is not a connected transport. The JSON byte bound alone does not
bound upstream memory. Source callbacks must themselves be
read-only and customer-pinned.

Tests cover exact 8 KiB request and 100-generation boundaries, malformed/foreign
requests, mutation/CLI/path/secret rejection, detached replies, invalid source
output, cancellation, timeout and overlap. The durable fake runtime's database
is byte-identical before/after readback, with no new effects or phase change.
This is the first read-only subset of the unprivileged protocol acceptance gate,
not completion of local peer authentication or permission for privileged probes.

#### Planned Asterisk adapter privilege boundary

Recovery remains read-only by user choice. The next adapter design uses a
separate customer-local **fixed-operation broker**: the network-facing journal
worker gets no PBX control socket or writable PBX configuration mount. The
broker would own the managed include directory, its durable operation ledger
and that customer's local PBX control access. It must accept only fixed,
validated operations, not CLI strings, file paths, templates or shell commands.

This is design selection only; no broker/service, new mount, PBX effect or
calling was enabled. The plan defines local peer authentication, filesystem
confinement, separate worker/broker lock ownership, observation-only crash
recovery and a staged acceptance sequence beginning with an unprivileged
protocol fixture. Secret sealing, runtime routing/dialog fences and independent
expiry protection after worker failure remain approval gates. See
[the selected broker design](./AGENT-PROVISIONING-PLAN.md#9-selected-asterisk-adapter-design-fixed-operation-broker).

#### Read-only provisioning recovery assessment

`createAgentProvisioningAssessment(store, binding, transport, sessions, options)`
provides an explicitly invoked `assess(signal?)` diagnostic for the current
ordered head. It needs only `next`/`ownership` reads, worker `report` access and
the backend session reference resolver. No listener or automatic loop is started.
Use the authenticated customer/epoch-pinned transport; caller authentication,
customer-scoped access and operational error logging remain the application's
responsibility.

An empty queue returns exactly `{ state: "idle" }`. Otherwise the allowlisted
result contains:

```typescript
{
  state: "assessed", operationId, revision, deadlineExpired,
  localStage,  // none | applying | uncertain | verified | failed
  workerStage, // missing | none | applying | uncertain | verified | failed
  history,     // worker-missing | worker-history-missing | equal | worker-ahead | worker-behind
  ownership    // missing | session-unresolved | session-resolved | trusted-cleanup
}
```

`workerStage: "none"` means the worker returned an accepted operation with no
receipts; `"missing"` means exact missing-operation readback. Missing remote
history alongside local receipts is specifically `worker-history-missing`.
`worker-behind` means an exact shorter history prefix, which may be a delayed
snapshot rather than data loss. `worker-ahead` identifies additional validated
receipts available for a separate reconciliation action. Equal empty histories
do not prove an effect has or has not occurred. Receipt stages are historical
evidence, never current runtime/PBX readiness.

The assessment shares `compareProvisioningReport` with receipt reconciliation:
worker scope, intent/hash/revision, sequence, transitions and common history
prefix must match. Invalid or divergent evidence rejects; it is not converted
into an ordinary status. Local head/receipt changes during the remote await also
reject, avoiding a result for an operation that is no longer the same head.
Readback has the existing cooperative five-second budget plus optional caller
cancellation; outages, timeouts, storage/session failures and invalid clocks
propagate explicitly. Overlapping calls on one assessment object are rejected.

`session-resolved` only means the original process-local session reference
currently resolves. It does **not** reverify JWT membership, assignment or lease,
and must never be interpreted as permission to dispatch. `trusted-cleanup`
identifies drain/revoke's separate policy path, not an approval for the viewer
to run cleanup. Deadline status is sampled after readback. Any observation may
become stale immediately afterward.

The operation does not accept commands, import receipts, append audit context,
advance revisions, skip heads, cancel effects or rebind ownership. A caller may
separately audit access before exposing these diagnostics. Missing worker history
is not proof that a command was never accepted, and no result authorises automatic
abandonment or replay.

Tests compare backend/worker database bytes before and after assessment, cover
missing/accepted/ahead/delayed/failed history, expiry, invalidated ownership,
foreign/divergent reports, stale-head races, cancellation and timeout recovery.
The real-session regression distinguishes a live manager from a fresh manager;
the mTLS regression checks historical verified readback without a POST or local
receipt import. This remains an opt-in backend diagnostic, not an operator UI,
recovery endpoint or worker cancellation/fence protocol.

#### Session-authorised provisioning producer (backend only)

`createSessionProvisioningProducer({ store, sessions, verify, agents, leases })`
provides `enqueue(command, context, owner, signal)` for a trusted backend caller.
It accepts prepare/activate/extend only, detaches inputs before asynchronous work,
and uses the existing session/JWT verifier, assignment directory and non-renewing
lease lookup. Direct membership for the exact subject is required. Session,
assignment and lease/deadline are checked after verification; the helper derives
the opaque authorisation reference and assigned extension itself, then invokes
`enqueueOwned` without yielding after the final checks. It creates no worker
delivery and no receipts.

The producer and guarded transport share the same live-owner checks so enqueue
and later delivery enforce consistent membership, assignment and deadline rules.
Checks at enqueue do not replace the delivery checks: queued work can become
unauthorised afterward. Logout, rotation, assignment/lease loss, denied or
unavailable verification, cancellation and storage failures reject explicitly;
no fallback unowned command is created.

This is not an HTTP authentication endpoint. The caller must derive `owner`
(issuer, subject, customer, session ID, original expiry and device ID) from its
authenticated request/session and verified device context, never arbitrary
browser metadata. It must also supply the trusted command generation/operation,
authority/revision and audit request/actor/reason. The helper does not invent
these, enrol authorities, allocate runtime generations, enforce a new generation
policy, grant cleanup privileges, renew leases or select retry/recovery policy.
Trusted drain/revoke remains a separately authorised backend path. Its persisted
context is atomic intent audit evidence, not proof of dispatch or completion.

Exact live retries reuse the original ownership; a lost session does not gain an
exception for retries. Historical status remains available separately through
the store/report paths. Final checks and enqueue are synchronous in one process,
not a distributed transaction with the lease/assignment database or the worker;
cross-process changes still require the delivery/runtime fences.

The producer tests exercise all three actions, failed live checks with no stored
operation, input mutation during verification, no lease renewal and the absence
of an extra asynchronous gap before commit. The local signed-token and real
Keycloak browser proofs now enqueue through this helper before using persisted
ownership for guarded dispatch; a logged-out Keycloak session cannot enqueue
another intent. No production API route, launcher wiring or automatic dispatcher
has been enabled.

#### Durable opaque provisioning ownership

The selected policy is to persist a non-login authorisation reference, not the
browser cookie or access token. Each successful application login creates a
separate random reference. Backend-only
`sessions.authorisationReference(owner)` returns it only for the exact live
issuer/subject/customer/session owner. `sessions.resolveAuthorisation(reference)`
resolves an exact identity/reference through the same live manager; it is not an
HTTP route, login credential, or substitute for JWT verification. Rotation,
logout, expiry and a fresh manager invalidate resolution. A new sign-in does not
adopt the old reference.

`store.enqueueOwned(command, context, ownership)` stores these exact fields
alongside the immutable operation, in the **same transaction** as its command,
audit context and authority revision:

```typescript
{
  issuer, subject, customer, authorisationId, sessionExpiresAt,
  deviceId, generationId, extension
}
```

The trusted producer must obtain these from the authenticated session and its
verified assignment/lease, never browser-submitted ownership metadata. The
primitive validates field shape, customer/generation/extension consistency and
the original session deadline, but is not itself a session/lease authorisation
check. Only prepare/activate/extend accept ownership. Exact retries require the
same original ownership; rebinding, attaching ownership retroactively to an
unowned operation, or retrying an owned operation through `enqueue` is rejected.
`store.ownership(customer, operationId)` returns a validated detached snapshot.
The existing unowned API remains for the established fixtures and trusted cleanup,
not as a way around the guarded transport.

`createSessionProvisioningAuthorisation({ store, sessions, verify, agents, leases })`
provides the authorisation callbacks for the guarded transport. It matches the
submitted command/hash to the persisted intent and resolves the original opaque
reference into an in-memory session owner. The transport still checks JWT direct
membership, session liveness after verification, current assignment and exact
owned lease/deadline. Missing ownership or an invalidated reference blocks new
acceptance; report readback and trusted cleanup keep their existing paths.
Ownership is not added to `ProvisioningIntent`, the command hash, wire requests,
worker reports or worker journal rows. The provisioning database stores no raw
session cookie, bearer token or CSRF value.

Schema 2 adds the ownership table to the shared persistence engine; worker
journals have an empty table and expose no ownership-write API. Existing version-1
backend/journal files upgrade transactionally without changing historical
commands, hashes, audit context, receipts or worker binding. Old intents remain
unowned and fail the new resolver rather than receiving an invented owner.
Older binaries reject schema 2; do not run them against an upgraded file.

The ownership/session regressions prove rollback, lock failure, exact retry,
cross-customer isolation, invalid/extra-field rejection, migration, reopen,
no worker-reference leakage, cookie replay denial and restart blocking. The real
Keycloak proof now uses this persisted owner resolver for guarded dispatch and
rejects subsequent resolution after logout.

This is an opt-in backend primitive, not production enqueue/HTTP/launcher wiring.
Sessions intentionally remain process-local. A backend restart or fresh sign-in
does **not** reauthorise old queued commands, and ownership cannot be rebound.
Such an unresolved ordered head remains blocked; no automatic skip, abandonment
or replacement policy is introduced. Explicit recovery handling, application
audit policy and post-acceptance worker fencing still need implementation before
production use.

Approval/rejection requires a reason and an explicit scope/redaction check.
A modal confirmation repeats the customer, incident, snapshot hash and reason.
Cancel sends no decision; confirm submits that exact snapshot once, with controls
disabled while requests are active. A successful decision refreshes pending
reports. Stale/conflicting decisions, expired/unauthorised access, malformed API
responses, network errors and storage outages display an error rather than
success. Errors clear the selected report and require a fresh selection; no
automatic decision retry occurs, since a lost response can follow a committed
decision. Client requests have a 15-second timeout and never forward credentials
through redirects or to external origins.

```powershell
npm run typecheck
npm run test:review-ui
.\scripts\Test-IdentityProof.ps1
```

The Playwright workspace regression covers malicious preview markup without
execution or external requests, cancel/confirm, approval/rejection, conflict
handling, denied/expired tokens, malformed responses, network/storage errors,
disconnect cleanup, and absence of token DOM/storage/cookies. The real Keycloak
test now approves Alice's actual captured synthetic report using the workspace
and checks her verified reviewer subject plus all 22 audited API requests through
backup/restore. Test browsers/listeners and temporary storage are cleaned up.

Remaining: production session operations, full-fidelity interactive review
preview, reviewer navigation/assignment, production localisation/accessibility
validation, and safe deployment operations. No long-running management service
is started by these tests.

#### Restricted rendered report preview

[src/review-preview.js](./src/review-preview.js) rebuilds a simplified preview from
an explicit HTML element allowlist. Raw markup is parsed only in inert template
content, never with a live document or a detached resource-loading document.
Fresh nodes preserve ordinary headings, paragraphs, text, lists, tables and
packet-provenance details. Details are opened so evidence is not hidden behind
collapsed controls. Source attributes are discarded except bounded numeric table
cell spans; report classes, IDs, CSS and event handlers are not retained.

Scripts, styles, images, embedded frames/objects, SVG/MathML, metadata and resource
elements are discarded. Links, forms and unsupported wrappers are unwrapped to
ordinary text rather than preserving URLs, submission or navigation behaviour.
The rebuilt HTML is placed in a sandboxed frame with **no sandbox allowances**,
an opaque origin, no referrer and a restrictive `default-src 'none'` CSP. It
cannot run report scripts or access the parent application/storage. The parent
workspace CSP permits this local frame but does not grant it script privileges.

The preview warns that content has been simplified and reports removed/unwrapped
element counts. The original source remains available for inspection. Approval
still binds the exact original snapshot, not the rebuilt display, and the
published report bytes are unchanged. This renderer does **not** redact evidence,
certify its suitability, reproduce source styling or provide the report's
interactive filters. Reviewers must check original content and intended
disclosure, not treat the simplified preview as proof that the export is safe.

The application-owned **Find evidence text** control highlights case-insensitive
literal matches within individual text nodes of the simplified preview. Enter
or **Highlight matches** applies the search; **Clear highlights** restores the
unmarked view. Search never hides rows or other evidence and does not modify the
original report, source view, review reason or approval hash. Terms spanning
separate inline elements do not match. Queries are limited to 200 characters and
only the first 1,000 occurrences are highlighted, with an explicit notice when
more exist. Searching rebuilds the frame and resets its scroll position; no
script or same-origin sandbox allowance is added. Search text is not sent to the
server or persisted in browser storage.

Input is limited to 2 MiB, 100,000 visited nodes and 128 levels of nesting.
Exceeding limits fails explicitly, clears the selected review and offers no
approval controls for that failed selection. Limits bound the reconstruction;
they are not a browser parsing performance guarantee.

Playwright verifies readable signalling rows, cell spans and expanded packet
details; active markup and resource-loading probes cannot execute or issue
external requests, and the frame cannot access parent DOM or localStorage.
Size/depth/node-limit failures are tested. The real Keycloak proof checks the
captured SIP report's two evidence tables and visible provenance before approving
the original snapshot, including search highlighting without changing evidence
text or table counts. Search tests cover literal punctuation/HTML, Unicode case
matching, text-node boundaries, no matches and the exact 1,000-highlight boundary.
Failure/disconnect paths remove preview, search controls and source.

### Server-managed application login/session proof

**Selected architecture:** server-managed application sessions (confirmed during
planning). Identity access/ID tokens and client credentials stay on the server;
the engineering browser uses an opaque HttpOnly cookie and a per-session CSRF
token, not browser-held Keycloak credentials. The original public-client PKCE
fixture remains a separate API integration regression, not the application login
implementation.

The API factory's optional sixth argument configures the application origin,
issuer, fixed authorization/token/JWKS endpoints, confidential client ID/secret
and API audience. Identity configuration must match the API verifier. HTTPS is
required except for explicitly opted-in loopback-only test HTTP. URLs cannot be
selected by requests, and callback destinations are fixed rather than accepting
arbitrary return URLs. Never expose the generated fixture secret or use it as a
production credential.

| Route | Behaviour |
|---|---|
| `GET /auth/login?customer={customer}` | Starts confidential-client authorization-code/S256 PKCE login for a validated customer slug |
| `GET /auth/callback` | Checks one-use state and browser-binding cookie, exchanges code server-side, verifies signed ID/access tokens and nonce/subject, then rotates the application session |
| `GET /auth/session` | Returns only workspace customer, CSRF token and expiry; no identity credentials |
| `POST /auth/logout` | Requires the session cookie, exact configured Origin and CSRF header; audits and invalidates this local session |

When this layer is configured, the workspace automatically shows **Sign in**,
redirects through Keycloak, restores its connection after page reload, and offers
**Sign out**. No browser test hook or manual token entry is needed for this flow.
The bootstrap module [src/review-session.js](./src/review-session.js) connects
through same-origin cookies. Session expiry disconnects the workspace and clears
its displayed evidence.

Cookies use HttpOnly, SameSite=Lax and Path=/; HTTPS uses Secure `__Host-` cookie
names. The loopback HTTP fixture uses explicitly test-named cookies without
Secure. Pending login state expires after five minutes. Active sessions end at
the earliest ID/access-token expiry or fifteen minutes, without sliding renewal
or refresh-token storage. Both login state and active sessions are in bounded,
process-local maps (1,000 each); expired entries are removed on access. Restarting
the server requires fresh login and does not restore identity tokens from the
diagnostic database.

Cookie-authenticated API mutations require both the exact configured Origin and
the per-session `X-CSRF-Token`; cross-site Fetch Metadata and mixed session/bearer
credentials are rejected. API membership/review/report checks still execute
against the server-held access token on every request. Login to a workspace is
not customer membership: Bob can authenticate but still cannot review reports.
Existing explicit bearer API callers remain supported without cookie sessions;
do not combine their credentials.

Login completion waits for durable access audit before issuing a session.
Logout waits for audit before invalidating it; if audit fails, the browser reports
failure and must retry sign-out. Signing out invalidates the local cookie ID, so
replaying it cannot restore access. This does **not** log out the Keycloak SSO
session or other devices, and valid previously issued bearer tokens are not
globally revoked. Invalid-login/CSRF operational coverage is narrower than a
production identity-event audit; successful login/logout and API decisions are
persisted without credentials.

```powershell
npm run typecheck
npm run test:session
.\scripts\Test-IdentityProof.ps1
```

The identity runner now executes both the original 22-decision browser/API proof
and a separate application-session proof using the generated confidential client
and exact `http://127.0.0.1:18766/auth/callback`. The latter uses normal sign-in
links/forms without injecting access tokens into page code. It verifies Alice's
review, Bob's denial, reload persistence, HttpOnly cookie properties, CSRF rejection,
local logout and cookie replay denial, plus persisted login/logout audits.
The session regression also covers callback binding/replay, nonce mismatch,
exchange rejection, session rotation/expiry, audit failures, secure-cookie flags,
and rejected identity configuration.

Limitations: development-mode Keycloak, loopback HTTP (no real TLS proof), single
process/in-memory sessions, fixed short lifetimes, no session persistence or
cross-instance coordination, no refresh, no MFA/federation proof, no IdP logout or
back-channel revocation, no production secret manager/rate limiting, and no
production application deployment yet. Full managed-session deployment and
recovery remain future work, not implied by passing browser tests.

## Run the local engineering workspace interactively

Requirements: Docker Desktop running, PowerShell 7, Node 24, and the existing npm
dependencies. This is a **local synthetic-data proof**, not a production installer.
Do not expose its HTTP ports or load real customer evidence into it.

From a PowerShell terminal in the repository:

```powershell
.\scripts\Start-LocalEngineering.ps1
```

The launcher generates the ignored test identity fixture, starts its isolated
Keycloak container, checks readiness, type-checks the application, and starts the
engineering server in the foreground. Open:

- Customer A: `http://127.0.0.1:18766/engineering/reviews/customer-a`
- Customer B: `http://127.0.0.1:18766/engineering/reviews/customer-b`

Click **Sign in**, then use the generated credentials in
`.local-proof\identity\accounts.json`. Alice can inspect/approve/reject customer A
reports; Bob has customer B metadata access but is deliberately denied review
authority. Do not share the accounts, realm import, or confidential-client JSON:
they contain plaintext synthetic credentials. No credentials are printed by the
application launcher.

The default start imports **no evidence**. To explicitly stage the latest complete
synthetic captured incident for both customers:

```powershell
.\scripts\Test-CaptureProof.ps1 # Only needed if no completed synthetic capture exists
.\scripts\Start-LocalEngineering.ps1 -StageCapturedReports
```

Staging uses the same captured-incident loader as the identity regression. Both
customer manifests must match their incident/customer scope, and report SHA-256
checks must pass. Incomplete incident directories are skipped; malformed complete
manifests or missing/tampered selected reports fail startup explicitly. All
imported reports start pending: nothing is automatically approved. Reusing the
flag does not restage identical candidates or reset prior approval/rejection;
changed content/metadata under an existing customer/incident key is refused.
Generate a new capture with a new incident ID for another review exercise.

Diagnostic candidates, review receipts, published reports, and access audits are
persisted at `.local-proof\engineering\diagnostics.sqlite`. Restarting preserves
them but invalidates application sessions. The development Keycloak database is
ephemeral: each default launcher run generates fresh test credentials and subject IDs.
Historical reviewer IDs remain recorded as originally issued; this is not
production identity continuity. New generated credentials are required after
restart. Sessions currently last at most the fixture's two-minute token lifetime.

### Opt-in local agent reservations

Use `-WithAgents` only for the synthetic Alice console. It explicitly adds
`agent:access` for Alice/customer-a while retaining the existing diagnostics
permissions; Bob/customer-b remains diagnostics-read-only. Without the flag,
neither identity gains agent access, even if assignment and lease databases exist.
This is local proof configuration, not a production membership administration API.

Agent mode requires `.local-proof\engineering\agents.sqlite` to have been
provisioned separately for Alice's **current verified issuer/subject/customer**.
The launcher opens it read-only: it does not create, migrate, provision, reassign
or infer permissions from its rows. Missing files, old schemas, corrupt assignments
and an absent current Alice assignment fail startup. It opens a separate
`.local-proof\engineering\device-leases.sqlite` only after validating the assignment.
Both stores close on normal shutdown and startup failure.

One-time setup:

1. Run the default launcher once, then stop it gracefully. This creates the current
   ignored identity configuration and engineering directory.
2. Build a JSON assignment array using Alice's `subject` from the resulting
   `.local-proof\identity\accounts.json`, issuer
   `http://127.0.0.1:18080/realms/local-proof`, customer `customer-a`, and your chosen
   synthetic extension/display name. Do not copy the account password into it.
3. Run the existing operator CLI with absolute paths:

   ```powershell
   node .\scripts\Provision-AgentAssignments.ts 'C:\path\to\repo\.local-proof\engineering\agents.sqlite' 'C:\operator-data\assignments.json' 'local-operator' 'Approved synthetic Alice assignment'
   ```

4. Start the explicit mode, then open the printed agent-console URL:

   ```powershell
   .\scripts\Start-LocalEngineering.ps1 -WithAgents
   # Optional independent report staging:
   .\scripts\Start-LocalEngineering.ps1 -WithAgents -StageCapturedReports
   ```

In this mode the PowerShell owner validates and retains the two existing
username/customer/subject mappings while regenerating passwords and the confidential
client secret. Missing, malformed, foreign or duplicate mappings are refused before
Docker startup or rewriting credentials. Retained IDs let the separately provisioned
assignment survive this **explicit** fixture restart; no assignment is silently
rewritten. Always use the newly generated passwords. Running the default launcher
or ordinary identity proof later generates new subject IDs again; agent mode will
then require separate operator provisioning for the new Alice identity. Historical
assignments/receipts are not deleted or repointed.

The TypeScript entry point accepts `--with-agents` against an already-running
matching fixture; it does not recreate or preserve Keycloak itself. The PowerShell
proof accepts `-WithAgents` only together with `-Interactive`. Review staging is
independent of this flag. Restart invalidates application sessions but retains
unexpired device reservations, so a newly signed-in session may need to wait up to
the remaining 60 seconds; no automatic takeover or recovered phone session occurs.
No SIP credentials, microphone, registration, queue operation or calling is enabled.

The real launcher acceptance test exercises missing/stale assignment refusal,
Alice's console and reservation, Bob's denial, lease persistence with old-session
rejection, occupied-port cleanup and return to the safe default without the flag.
`node --test .\tests\local-agent-launcher.test.ts` separately verifies the PowerShell
identity preflight preserves exact IDs without rewriting the account file and
rejects invalid/missing configuration.

**Stop:** type `stop` and press Enter in the launcher terminal (recommended), or
press Ctrl+C. The server closes its listener and database; the PowerShell owner
then removes only its identity Compose container/network. The diagnostic database,
captures and generated credential files remain ignored on disk. A hard terminal
kill, machine crash or forced process termination is not graceful cleanup; inspect
and stop only this fixture's Compose project before restarting. Do not delete
the database just to clear a review decision.

The runner takes an exclusive identity-fixture lock before generating credentials,
refuses existing fixture containers, and preflights loopback ports 18080, 18765 and
18766. A competing launcher or occupied port fails rather than replacing another
service. The Node listener binds only `127.0.0.1`; no container socket, raw capture
control, or unauthorised filesystem API is exposed. The older identity tests now
use the same lock, so do not run them while the interactive fixture is open.

`Test-IdentityProof.ps1` additionally runs the launcher regression: real browser
login/review, database persistence across restart, lost-session rejection, identical
capture reuse, tampered/changed capture refusal, competing launcher/occupied-port
denial, and graceful CLI stop. Temporary regression databases are removed; the
actual local application database is deliberately preserved. The test's CLI
smoke start does not import reports into that application database.

The TypeScript entry point `scripts\Start-LocalEngineering.ts` is also available
when the correct identity fixture is already running; it does **not** own Docker
or generate identity configuration. Prefer the PowerShell launcher for normal use.
No service is automatically left running after validation.