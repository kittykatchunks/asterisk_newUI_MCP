# Customer-local agent provisioning worker

Planning baseline: 22 October 2026.

Status: proposed implementation contract, not an implemented service or a production
approval. The customer-local, narrowly authenticated worker boundary was selected.
Storage engine, certificate operations and production deployment remain provisional.
Browser phone activation stays disabled until the acceptance gates below pass.

Related: [Project plan](./PROJECT-PLAN.md), [Milestone 1](./MILESTONE-1.md),
[executed proofs](./README.md#isolated-per-lease-sip-credentialrevocation-proof).

## 1. Agreements and current evidence

- One Asterisk instance per customer.
- Agent identity is issuer + verified subject + customer, independent of device.
- Reject a second device while a lease is active; require release or expiry.
- Stop new offers on sign-out, finish the current call, then release the phone
  session. Do not silently replace this with unconditional hangup.
- Assignment provisioning is insert-only; no implicit reassignment.
- The web application must not receive Docker, shell, arbitrary Asterisk command
  or PBX configuration-file access.

Implemented today:

- `src/agent-device-lease.ts` serialises exclusive SQLite reservations, with
  explicit renewal capped at 60 seconds and the verified application-session expiry.
  `current(owner, leaseId)` is a non-mutating, scoped ownership read.
- `src/agent-device-http.ts` requires a customer-bound application session, CSRF,
  direct `agent:access` membership and a valid assignment. Its audit is a pre-change
  intent, not a provisioning result receipt.
- The console holds page-device and lease IDs in memory. There is no automatic
  heartbeat, SIP credential delivery or calling.
- The fixture installs unique per-lease SIP credentials, rejects foreign/retired
  credentials, and removes endpoints/contact state after release or real renewed
  lease expiry. The scheduler observes committed renewal through another SQLite
  connection. These are fixture-owner file writes and Docker CLI reloads only.

Not proven: active-dialog draining, prevention of all new call paths after
revocation, application-to-worker authentication, durable provisioning recovery,
production WSS trust, or production capacity. A contact is not a phone-readiness
verdict. The existing Compose files are proof deployments, not this architecture.

## 2. Boundary and deployment

```text
Browser -- HTTPS/session+CSRF --> Application
                                  |
                     authorise + commit desired state/outbox
                                  |
                           authenticated dispatcher
                                  |
                         private mTLS connection
                                  v
                    Worker pinned to one customer
                      |                 |
              local durable state   fixed PBX adapter
                                        |
                              that customer's Asterisk
```

Recommendation: one worker process/container per customer, bound to a private
management network and one configured customer ID. An authenticated caller cannot
change that binding through a URL/body field. No host-published worker port is
needed in the initial Compose proof.

The worker receives only that customer's managed include directory and required
local PBX control access. Base configuration, other customers' files, host root,
Docker socket, recording storage and diagnostic captures are not mounted. Run as
a dedicated non-root identity with bounded CPU/memory, no extra capabilities and
bounded request/log storage.

Selected next design boundary: generated PJSIP include files plus a fixed reload
operation through a separate customer-local fixed-operation broker. This is
design approval, not approval to implement or deploy privileged services. The controller must
generate a complete allowlisted model, never interpolate caller-provided config.
A broker's access to Asterisk's control socket is powerful even if its local
API is narrow; compromise of that broker can compromise its customer PBX.
The network-facing journal worker must not mount that socket or write PBX files.
Prove broker socket permissions and reload behaviour in a separate fixture before
adopting this adapter. Do not expand the existing read-only/reporting AMI accounts.
Realtime PJSIP remains an alternative if file/reload consistency cannot meet gates.

Use one local writer lock across journal reconciliation, include generation and
reload. Fence duplicate worker processes; an expired generation's cleanup must
never overwrite a replacement generation's include. Atomic rename requires a
directory mount, not the current fixture's individual bind-mounted config file.
Neither a reload timeout nor the appearance of a new file proves runtime apply.
With the selected broker split, the journal lock remains worker-local; broker
requests must be serialised under a separate broker-owned apply lock and durable
operation ledger. These are not a distributed transaction. The ownership and
crash-cut acceptance gates in section 9 must pass before either is used for PBX
effects.

## 3. Authentication and command envelope

Recommendation: verified mTLS in both directions. A deployment-managed mapping
binds the controller certificate identity to a permitted customer; the application
pins the expected worker/customer identity. Reject untrusted, expired, wrong-name
and foreign-customer certificates before accepting commands. Never forward a
browser bearer token or raw application-session cookie to the worker.

Each command has a strict versioned JSON envelope:

| Field | Meaning |
| --- | --- |
| `version` | Exact supported protocol version; initially 1. |
| `operationId` | UUID generated and committed by the backend before dispatch. |
| `customer` | Must equal both the worker binding and the certificate's permission. |
| `epoch` | Provisioned controller-authority epoch, not self-selected by a request. |
| `revision` | Increasing desired-state revision within that epoch/customer. |
| `leaseId` | Exact reservation generation; never substitute the newest lease implicitly. |
| `notAfter` | Absolute authorisation deadline, no later than verified backend ownership. |
| `action` | One of the fixed actions below. |
| `payload` | Action-specific allowlisted data, with no file paths or command strings. |

Proposed fixed actions:

- `prepare`: generate a unique credential generation and install a disabled
  endpoint/authentication model; no routing, queue membership or browser disclosure.
- `activate`: enable only an already-prepared generation after backend ownership
  and worker deadline checks. Readiness still requires separate registration/media checks.
- `extend`: update the same lease/generation deadline, never past fresh backend
  authorisation. It must not create or reactivate an absent/draining generation.
- `drain`: irreversibly disable new offers and new sessions for this generation,
  retaining only already-observed dialogs according to the drain policy.
- `revoke`: remove credential/new-session access; report separately whether any
  existing dialogs remain. Not an implicit emergency hangup.
- `operation`: exact durable receipt lookup by operation UUID; no re-execution.

The worker serialises revisions per customer. A stale epoch/revision or a reused
operation UUID with a different canonical payload hash is a conflict, never a
success-shaped fallback. An identical retry returns the recorded operation status.
Sequence gaps return an explicit reconciliation requirement; they do not apply
later commands out of order. A status lookup is authenticated and customer-scoped.
Initial request limits should reuse the bounded JSON-reader pattern, with explicit
body/deadline/capacity limits measured against the actual envelope before release.

Certificate rotation may overlap trusted identities temporarily, but does not
reset revision/epoch state. Authority replacement requires an operator-controlled
epoch transition that fences the old controller. A restored backup must not rewind
live fencing state or allow its old credentials to become active again.

## 4. Durable state and reconciliation

Use a dedicated provisioning store, not the diagnostic database or assignment
backup. SQLite is sufficient for the first single-controller proof; PostgreSQL
remains the project's provisional production choice. Storage selection does not
change the desired-state/receipt contract.

Backend transaction:

1. Validate the current customer session, direct permission, assignment and lease.
2. Reserve the extension/agent mapping needed for phone activation. Existing
   assignments allow two people to share an extension: reject ambiguous activation
   until exclusivity/routing is explicit; do not change insert-only assignments.
3. Commit desired generation/revision, operation UUID, actor/request correlation
   and an outbox item atomically. Do not claim PBX success in this transaction.
4. A dispatcher sends the exact committed operation. Network timeout leaves it
   pending/uncertain; reconcile the same UUID rather than inventing a new credential.

Worker durable journal: operation UUID/hash, epoch/revision, lease/generation,
authorisation deadline, desired model digest, stage, timestamps and sanitised
error code. Keep secrets outside plaintext journals, receipts, traces and logs.
Persist intent before changing the PBX; persist observed outcome before reporting
completion. File replacement and Asterisk reload are not one transaction.

Stages: `accepted`, `applying`, `verified`, `failed` or `uncertain`.
Verification must inspect the intended runtime objects and generation, not merely
the reload command's exit code. Partial apply, timeout or mismatched runtime state
remains unavailable for credential delivery and call routing.

On worker restart:

1. Load deadlines, fencing state and incomplete operations from durable storage.
2. Keep new offers disabled until customer identity, current authority and runtime
   inventory reconcile. An unavailable controller does not extend a deadline.
3. Resolve interrupted apply against the generated model and actual PBX inventory.
   Retire unknown/expired managed generations; do not touch unrelated base objects.
4. Reconcile receipts with the backend outbox. Missing operation lookup does not
   prove the PBX change never happened.

The worker must locally enforce its stored deadline even while disconnected from
the backend. Use a monotonic countdown while running and a checked wall clock for
persisted deadlines. Backward time jumps or uncertain clock health must not extend
authorisation; define and test bounded fail-closed behaviour. Forward jumps drain
early with an explicit operational event. Do not treat database corruption or
read errors as harmless missing leases.

## 5. Credentials and browser delivery

Recommendation: worker-generated random per-generation SIP credentials, not a
shared extension password. The worker needs recoverable secret material for
idempotent prepare/recovery, so seal it under an operator-provided key mounted
separately from the database. Do not invent custom cryptography. Select a
maintained authenticated-encryption implementation/key source before coding this
surface. A missing/wrong key is an explicit failure, never replacement issuance.

Generated Asterisk auth configuration still contains usable credential material.
Restrict its owner/mode and mount scope, exclude it from ordinary report/assignment
backups, and define protected recovery and deletion separately. Sealing the journal
does not encrypt Asterisk's live configuration or make a worker compromise harmless.

Application delivery is a separate gated step: authenticate/authorise again,
revalidate the exact lease and active verified generation, then return only its
credential and approved SIP connection parameters over HTTPS with `no-store`.
Secrets remain memory-only in the page; no query strings, localStorage, diagnostics
or shared credentials. WSS certificate verification must work without fixture
exemptions. Do not add this endpoint during the intent-store/worker milestones.

Delivery timeout is uncertain, not proof that the page never received a secret.
Re-disclosure to the same still-authorised generation must be explicitly audited
and bounded; retries must not generate extra active identities. SIP digest alone
does not make a password expire: worker enforcement and new-call fencing are
required. Secret loss, authority restore and key rotation require reconciliation
or re-issuance after revoking the old generation, not an untracked fallback.

## 6. Drain, lease expiry and sign-out

Maintain separate ownership, credential, routing and dialog state. In particular:

| State/event | Required behaviour |
| --- | --- |
| Prepared | No browser secret disclosure, queue offers or new calls. |
| Active | One verified generation; explicit lease extension only. |
| Sign-out or release | Disable new offers immediately; enter irreversible drain. |
| Lease/controller deadline | Stop new calls/offers locally, even if the backend is unreachable. |
| Draining with observed dialogs | Finish current call; never route a new offer to this generation. |
| No remaining dialogs | Revoke generation, verify removal, then complete phone-session release. |
| Runtime/dialog state unknown | Block replacement activation; report uncertain state, not idle. |

The current reservation-only release API immediately deletes the reservation.
It must not be reused unchanged for a connected phone: keep an independent
draining generation/activation lock until the dialog policy resolves. A new
reservation must not bypass a draining old phone. Ordinary application sign-out
can invalidate the browser session without giving its expired token control over
the worker; completion of call draining is server-owned.

Removing PJSIP authentication or a contact is not sufficient proof that every new
INVITE, outbound call, queue offer or transfer path is blocked. Prove a
generation-aware routing/dialplan fence, cover cached authentication and
retransmissions, and correlate dialogs to the exact generation. Existing dialog
signalling needed to finish the call must remain possible after sign-out.

Selected disconnected-expiry policy: stop new calls/offers immediately, preserve
existing calls until they finish, and block replacement while draining. No
automatic forced-disconnect deadline is selected. This applies even when the
controller is unreachable; it does not permit continued new-call access.

Open policy gates: operator handling when a call never ends, emergency intervention,
any future maximum drain duration,
emergency disconnect permissions, transfer semantics, and whether device takeover
may proceed after an operator override. Do not choose a forced-hangup timeout
implicitly. Until decided, an unresolved drain blocks activation and alerts an
operator; it does not grant unbounded new-call access.

## 7. Audit and operational visibility

Keep the existing unique-request access audit unchanged. Add provisioning operation
events/receipts keyed by operation UUID plus stage/revision; one HTTP request may
start a long-running operation with multiple durable transitions. Correlate them
without inserting several access-audit rows with the same request ID.

Expose only scoped state, operation UUID, generation, deadline, sanitised errors
and reconciliation lag. Do not label `accepted` as activated, `verified` as
registered, or registered as media-ready. Alert on expired-but-not-revoked state,
unknown runtime generations, drain uncertainty, failed receipts and worker outage.
Document retention and protect all-customer backend metadata separately from each
customer worker's local state.

## 8. Implementation order and acceptance gates

Each stage remains off by default. No web Docker/config access is introduced.

| Stage | Deliverable | Required acceptance before advancing |
| --- | --- | --- |
| A | Durable backend desired-state/outbox and worker journal contract, no secrets or PBX adapter. | Atomic intent/audit, exact retry/hash conflict, epoch/revision ordering, cross-customer denial, reopen/lock/corruption, timeout reconciliation. |
| B | Customer-pinned mTLS worker with fake adapter. | Foreign/invalid certificates rejected, fixed actions only, no arbitrary commands/paths, bounded input, duplicate delivery, crash between each stage, disconnected expiry. |
| C | Owned Asterisk adapter, no browser delivery. | Generated-file/runtime verification, interrupted apply/restart, renewal survives old deadline, expired/released/unknown generations fenced, unrelated customer/base objects unchanged. |
| D | Call-aware routing fence and drain. | New inbound/outbound/queue/transfer paths denied while an existing synthetic call completes; unknown dialog state blocks replacement; chosen emergency/drain policies verified. |
| E | HTTPS/WSS credential delivery and browser activation. | Live session/lease/generation checks, uncertain delivery recovery, no secret leakage/storage, real verified TLS, explicit readiness, two-way audio and logout-during-call acceptance. |

Before stage C, choose and prove the fixed PBX adapter/control-socket privilege
model. Before stage D, decide the outstanding call policies above. Before stage E,
select secret sealing/key lifecycle and real ingress trust. These are approval
gates, not assumptions authorised by this plan.

Next recommended implementation: stage A only. It provides durable coordination
without claiming a working phone or expanding PBX privileges.

### Stage A progress: backend persistence primitive

`src/agent-provisioning-store.ts` now implements the first backend-only part of
stage A: explicit customer/epoch enrolment, ordered immutable command intents
with atomic audit context, a pending outbox view and append-only receipt stages.
It is not wired into session/lease APIs or the launcher. No production service,
receipt-write endpoint or PBX adapter is implemented.
The [README contract](./README.md#durable-provisioning-intent-store-backend-only)
records exact behaviour and remaining gates. Stage A is not complete.

The same persistence engine now supports a separate customer/epoch-pinned local
worker journal. Binding is durable; remote command data cannot change it, and
backend and bound-journal files cannot be interchanged through the public APIs.
Ordered-head checks and receipt appends share a transaction. Restarted applying
work requires reconciliation, expired work cannot start, and failed work blocks
later revisions. Exact historical retries remain reconcilable. This establishes
a local journal contract only, not worker authentication, exactly-once execution,
exclusive executor ownership, PBX verification or automatic deadline enforcement.
See the [worker-journal contract](./README.md#customer-pinned-worker-journal-no-execution).

The journal can now export an allowlisted versioned report containing the operation
scope, command hash and receipt history. Backend reconciliation validates a
separately supplied expected worker binding, matches the stored intent, checks the
complete shared history and appends new receipt stages atomically. Exact and
delayed-prefix reports do not duplicate or rewind history. Separate-database tests
cover lost responses across restart and mid-import rollback. This is an in-process
reconciliation contract, not authenticated ingestion or verified PBX execution.
Reports are limited to 100 receipts and longer histories fail explicitly; transport
bounds, pagination and authority-restore detection remain unimplemented. See the
[report contract](./README.md#worker-report-reconciliation-in-process-contract).

An opt-in single-step dispatcher now consumes a customer/epoch-validated ordered
backend head through an injected transport. It queries reports before acceptance,
rechecks head/history/deadline after awaits, reconciles lost responses, propagates
transport errors and shares a cooperative five-second cancellation budget. It
does not execute work, start a loop, authenticate a worker or revalidate live
leases. Multiple instances still rely on immutable idempotent acceptance.
Missing remote history with local receipts blocks acceptance; undetectable loss
of acceptance-only history remains a recovery-fencing gate before real effects.
See the [dispatcher contract](./README.md#single-step-provisioning-dispatcher-injected-transport-only).

### Stage B transport proof: journal only

Explicit HTTPS client/server factories now carry fixed acceptance/readback routes
over mutually authenticated TLS. Both peers require configured CA trust and exact
leaf certificate pins; the client also verifies hostname. The worker's local
journal enforces customer/epoch scope. Real ephemeral-CA loopback tests reject
missing/foreign/untrusted/expired clients and invalid worker identities, exercise
strict bounded input/output and cancellation, and surface storage failures.
No listener is enabled by default. There is no production executor, certificate lifecycle
automation, disconnected expiry enforcement or authority-restore fencing.
Stage A application/recovery acceptance and the rest of stage B remain incomplete;
this transport proof does not authorise PBX effects. See the
[mTLS contract](./README.md#customer-pinned-mutual-tls-journal-transport-no-executor).

### Stage B executor proof: injected fake effects only

A separately invoked single-step executor now commits applying before adapter
work and requires explicit observation before verified/failed receipts. Restarted
applying/uncertain work is observation-only, never blindly replayed; unstarted
expired work does not reach the adapter. Unknown state blocks progression without
unbounded receipt growth. Tests cover interrupted effects/commits, all fixed
actions, cancellation/timeouts and fake verified reports reconciled over mTLS.
No PBX adapter or automatic execution is wired. A local cross-process ownership
lock now also covers separate executor handles/processes as described below;
runtime/restore fencing, live lease validation and disconnected expiry remain gates. See the
[executor contract](./README.md#single-step-worker-executor-fake-adapter-proof-only).

Each executor step now holds a separate SQLite ownership transaction across
asynchronous adapter work and receipt completion. A canonical journal-derived
sidecar makes competing local handles/processes fail before adapter entry while
leaving the journal available for readback and acceptance. Actual process
termination tests prove lock release and observation-only recovery; an unsettled
adapter keeps ownership even after cancellation. The sidecar must not be removed
or replaced while workers are live. This is cooperative single-host ownership,
not distributed/runtime generation fencing or exactly-once execution. See the
[ownership contract](./README.md#cross-process-worker-execution-ownership-local-sqlite-only).

Apply now has an additional cooperative budget capped to the command's remaining
authorisation time, rather than receiving a fresh five seconds near expiry.
Checks around the applying commit and on adapter return preserve interrupted
evidence without fabricating verification. Real sub-second expiry tests keep
ownership until the adapter settles, then recover through observation only.
Observation after expiry remains permitted, not renewed execution authority.
Clock maintenance, side-effect-boundary checks and autonomous revocation of
already-applied state remain adapter/deployment gates; this is not disconnected
expiry enforcement or a forced interruption of uncooperative effects.

An end-to-end mTLS recovery proof now joins these primitives across actual child
process exits and three separate durable stores (backend, journal, fake runtime).
It cuts execution before a fake effect, after its commit, and after observation
but before a terminal receipt. Reopened coordination stores recover after the
command deadline: existing fake effects verify through observation/readback,
missing effects remain uncertain, and neither path replays apply. Repeated
recovery does not duplicate effects or receipts. This is process-exit recovery,
not power-loss durability, restored-authority detection, PBX state verification
or disconnected expiry enforcement; stage B remains incomplete.

A single explicitly invoked expiry sweep now exercises the selected drain policy
against an injected durable fake runtime. It shares executor ownership, validates
the complete bounded inventory, fences new calls before dialog observation and
requires verified zero dialogs before revocation, then verifies removal. Unknown
dialogs stay uncertain; active dialogs stay draining without forced hangup.
Persisted drain remains irreversible across restart/clock rollback. There is no
default scheduler, real routing/dialog adapter or replacement activation gate;
the production policy is not yet enforced. Stage B remains incomplete.

An explicitly started expiry monitor now performs an immediate sweep followed by
serial sweeps with 250 ms pauses after reporting. Real-time durable fake-runtime
tests verify controller-independent fencing within one second in an idle fixture,
call preservation and eventual removal. Cancellation and any adapter, storage,
ownership or reporting failure reject its awaited lifetime; nothing auto-starts
or silently retries it. This is not a production expiry latency guarantee:
uncooperative adapters/reporting and competing execution can delay or stop it.
Single-owner work coordination, health supervision, measured worst-case expiry,
real PBX fences and replacement blocking remain gates. See the
[monitor contract](./README.md#explicit-expiry-monitor-fake-runtime-scheduling-proof).

The fake-runtime evidence now uses a reusable customer/epoch-pinned SQLite
generation lifecycle adapter, shared with the real-time monitor test. It models
prepare/activate/extend/drain/revoke, atomic effect records, immutable exact
retries and transactionally checked zero-dialog removal. Tests prove renewal
past the old deadline, restart, expiry-call preservation, unknown-dialog blocking,
irreversible drain and replacement only after removal. Its deliberately single
customer-wide generation slot is a fixture simplification, **not** the production
multi-agent allocation policy. No production replacement gate, live ownership
validation or PBX adapter is introduced. See the
[fake-runtime contract](./README.md#durable-fake-generation-lifecycle-test-only).

An explicit serial worker lifetime now composes expiry, one execution step and
reporting on the same journal/clock before each 250 ms pause. This avoids
self-contention between independent monitor/executor loops. Fake-runtime tests
prove removal before queued replacement, ongoing sweeps despite an expired head,
phase cancellation and error propagation. Each phase holds its own ownership
lock, not a lifetime-exclusive service lock; runtime replacement checks remain
mandatory. Execution/reporting latency can delay expiry and failures stop the
awaited lifetime. Production supervision, expiry latency acceptance, live
authorisation and restore/runtime fencing remain gates. Nothing auto-starts.
See the [worker contract](./README.md#serial-worker-lifetime-injected-adapters-off-by-default).

The mTLS integration suite now drives that actual serial loop with the reusable
durable fake adapters. Prepare/activate/extend travel over authenticated transport;
the controller-facing listener then goes offline before extension completion is
read back. The worker survives the old deadline and drains at the renewed real
deadline, preserves the simulated call and removes the generation after its end.
Reopening the backend and listener reconciles delayed historical receipts without
replaying effects. The idle fixture fences within one second of expiry, not a
production latency guarantee. This joins stage B components but does not close
application authorisation, restore fencing, deployment/supervision or PBX gates.

### Live dispatch authorisation: integration primitive

The selected next boundary is live authorisation before prepare/activate/extend
acceptance. An opt-in transport wrapper now checks trusted original-owner
resolution, matching live session, direct agent membership, current assignment
and exact owned device lease with a bounded command deadline. Session/assignment/
lease are rechecked after asynchronous access verification. Historical readback
and trusted controller drain/revoke remain possible after browser logout.
Tests use real lease persistence and injected session/access state; no new OIDC
flow or production producer is wired. Durable original-owner mapping, application
audit/desired-state capture and remote execution fencing after acceptance remain
unimplemented. This is a pre-dispatch check, not atomic distributed authorisation.
See the [live gate contract](./README.md#live-provisioning-acceptance-gate-opt-in-backend-integration-primitive).

The gate is now exercised around the actual mTLS client with real device-lease
persistence and the durable fake lifecycle adapter. Worker POST counts prove
assignment changes, logout and lease release during verification prevent delivery,
not merely later execution. Valid prepare/activate/extend operations execute,
and historical receipt reconciliation survives logout without exposing raw
session/device context. Owner/session/membership resolution is still injected
fixture state; durable application integration and cancellation/fencing after
remote acceptance remain open gates.

The existing application-session manager now supplies a backend-only scoped
identity lookup for the gate's session callback. Exact issuer/subject/customer/
session ID are required, and rotation/logout/expiry invalidate lookup. It returns
no access token or CSRF material, changes no browser route and does not persist
sessions across restart. The local signed-token OIDC regression verifies these
properties, not a new production Keycloak integration. Durable owner mapping,
shared session operations, dynamic membership operations and actual background
dispatcher wiring remain unfinished. See the
[session lookup contract](./README.md#backend-only-live-session-lookup).

The session manager now also verifies agent access through the existing trusted
JWT/membership verifier using its stored token internally. A post-await liveness
check rejects concurrent rotation/logout/expiry; only the same subject with
direct membership can be allowed. Cancellation, denial and infrastructure failure
remain explicit, with no token returned. The local signed-token regression wires
both actual session callbacks into guarded dispatch with real lease/journal
storage. This closes the callback primitive, not production wiring: original-owner
persistence, audit integration, dynamic membership operations and post-acceptance
fencing remain unfinished. See the
[session access contract](./README.md#session-backed-agent-access-verification).

The real Keycloak browser launcher now additionally exercises the actual backend
session callbacks using its approved confidential client. It verifies scoped
lookup, Alice's direct membership/Bob's denial, rotation invalidation, and guarded
dispatch with real SQLite leases/backend/worker journals. A deliberately held
real-verifier result is rejected after concurrent logout without another worker
delivery; historical readback remains available. The identity, application-session
and launcher proofs passed together and their owned fixture was removed. This is
local integration evidence only: no PBX execution, production owner resolver,
issuer-side revocation subscription or post-acceptance worker cancellation was
added. The signed-token regression remains the expiry/cancellation proof.

### Durable original-owner reference: selected restart policy

The user selected a durable **opaque non-login authorisation reference**, not
persistent/shared browser sessions. Each successful login has a separate random
reference held by its process-local session manager. Rotation/logout/expiry or
backend restart invalidate it; a fresh sign-in must not adopt old queued work.
No cookie, access token or CSRF value is persisted in provisioning ownership.

`enqueueOwned` now atomically records exact issuer/subject/customer/reference,
original session expiry, device, generation and extension with the intent, audit
context and revision. Retries cannot rebind it or retrofit ownership onto an old
unowned operation. Schema 2 transactionally upgrades version-1 backend and worker
files without changing command hashes/history; old operations stay unowned.
The opt-in session authorisation factory resolves this protected persisted
mapping and retains the existing JWT/assignment/lease checks. Ownership never
travels to the worker.

The local ownership/session regressions and real Keycloak integration prove
atomic failure/reopen, exact retry, scoped lookup, reference-not-cookie behaviour,
restart denial and concurrent logout fencing. This closes the durable mapping
primitive, not production capture/audit/launcher wiring. An unresolved original
owner still blocks its ordered head; no automatic abandonment/rebinding policy
has been selected. Explicit recovery, supervision and post-acceptance worker
fencing remain production gates. See the
[opaque ownership contract](./README.md#durable-opaque-provisioning-ownership).

### Worker health: selected fail-stop policy

The user selected observable worker health without automatic restart/replay.
An opt-in single-use supervisor now wraps the same serial expiry/execution/report
lifetime. Pull-based detached snapshots expose the current phase, monotonic phase
age, successfully reported cycle count, stop request and explicit
idle/running/stalled/stopping/stopped/failed state. The caller supplies the stall
threshold; reaching it observes a stall but does not cancel work or release its
execution lock. Original exceptions/cancellation still propagate to the awaited
caller, and an unrelated failure concurrent with shutdown remains a failure.

Tests cover phase stalls, the exact threshold, default real-time observation,
uncooperative cancellation with ownership retained, no restart, and failure
classification. The disconnected mTLS fake-worker proof uses the supervisor
while local expiry continues without the controller listener.

This adds no external process manager, health HTTP route, automatic alert or
failure-recovery action. A dead process/blocked event loop requires an independent
monitor; a failed lifetime no longer enforces expiry. Deployment supervision,
measured expiry guarantees and a safe runtime failure response remain gates.
See the [worker health contract](./README.md#worker-health-and-fail-stop-supervision-opt-in).

### Session-authorised producer primitive

An opt-in backend producer now checks the exact live session, verified direct
agent membership, current assignment and non-renewing owned lease before
prepare/activate/extend enqueue. It captures the opaque reference and extension
from protected backend state, then atomically persists the owned intent. Inputs
are detached before verification; final live checks and enqueue do not introduce
another asynchronous gap. The existing delivery gate shares those live checks
and still revalidates before worker acceptance.

The producer does not authenticate browser-supplied owner metadata, allocate
revisions/generations, enrol authorities, authorise cleanup or dispatch effects.
The caller must supply authenticated device/session context, trusted command
scope and audit context. Cross-process lease/assignment changes are not atomic
with the intent database; delivery and eventual runtime fences remain necessary.

Focused regressions cover each action, live-check races, no failed-intent writes,
input mutation and synchronous commit ordering. Both signed-token and real
Keycloak proofs now use the producer before persisted-owner guarded dispatch.
Production API/launcher capture, recovery and post-acceptance fencing remain
unfinished. See the
[producer contract](./README.md#session-authorised-provisioning-producer-backend-only).

### Read-only recovery assessment: selected next boundary

The user selected diagnostic assessment before any recovery mutation. The new
opt-in assessment reads the ordered head, queries the authenticated worker and
compares report evidence using the same validator as receipt reconciliation,
without importing receipts or changing either queue. It reports local/worker
stages, exact missing/ahead/delayed-prefix history, deadline status and whether
the original session reference resolves. Scope/history divergence, concurrent
head changes and transport/storage/cancellation failures reject explicitly.

A resolved session is not a fresh membership/assignment/lease decision, and a
missing report is not proof of no prior acceptance. No result permits skipping,
rebinding, automatic replay or cleanup. History import remains a separate
existing reconciliation action; cancellation of potentially accepted work needs
a worker-side fence protocol and its own policy approval.

Database-byte comparisons prove no persistent mutation. Tests cover historical
readback over actual mTLS without POST/import, real session-manager restart
resolution, expiry/logout status, divergent/missing/delayed evidence, stale
heads and cooperative timeout. This adds no operator route/UI or automatic
recovery. See the
[assessment contract](./README.md#read-only-provisioning-recovery-assessment).

## 9. Selected Asterisk adapter design: fixed-operation broker

Decision recorded 23 October 2026: keep provisioning recovery read-only for now,
and develop a customer-local fixed-operation broker rather than giving the
network-facing journal worker direct PBX control-socket access. This section is
a design/acceptance contract only. No broker, privileged adapter, deployment
mount or browser phone is implemented or authorised by this decision.

### 9.1 Trust and resource ownership

```text
Application -- private pinned mTLS --> customer journal worker
                                          |
                              authenticated local fixed protocol
                                          v
                               customer apply broker
                                 |              |
                         managed include    PBX control socket
                                 |              |
                                 +-- customer Asterisk
```

- The journal worker retains command validation, ordered receipts, expiry
  coordination and health. It has no Docker socket, shell-execution API, PBX
  control socket or writable PBX configuration mount.
- The broker has its own non-root identity and is pinned at deployment to one
  customer/authority and one managed namespace. It owns its durable ledger,
  managed include directory and only the required customer PBX control access.
  It has no other-customer mounts, recording/capture storage or application
  session/token access.
- Use a private local Unix-domain protocol as the initial Linux fixture
  candidate. Prove actual peer identity and filesystem/socket permissions under
  the chosen container layout; a socket pathname or body customer field is not
  authentication. No TCP listener or host publication is assumed. Namespace
  UID/GID mappings and reconnect identity need explicit tests.
- Local authentication is not a defence against a compromised authorised worker
  sending its permitted operations. Bound the allowed model and damage scope.
  The broker is a powerful customer-local trust boundary, not an Asterisk
  sandbox; the control socket itself may permit much more than this API exposes.

### 9.2 Fixed protocol, not CLI forwarding

The protocol should mirror only the existing command/observation responsibilities:
apply a fixed prepare/activate/extend/drain/revoke operation, observe an exact
operation, and enumerate/observe expiry state for the pinned namespace. It must
also support idempotent new-call fencing and zero-dialog removal for the expiry
adapter. The wire schema, version and action mapping still need implementation
review; do not assume every worker command maps to an arbitrary broker method.

Every mutating request needs immutable operation identity, canonical intent
digest and exact generation/deadline binding. Expiry effects need stable
broker-ledger identity too, not a new random operation on every sweep. A retry
with the same identity but different data is a conflict. Readback must not start
an apply or repair. Bound message size, inventory, response size, execution time
and concurrent connections; timeout/disconnect remains uncertain.

Never accept paths, include filenames, templates, CLI arguments, dialplan text,
module names, shell strings, environment overrides or credentials from a remote
command. The broker selects its own fixed reload/readback operations and renders
validated identifiers through a closed template. Desired endpoint/auth/AOR names
derive from a protected namespace and generation mapping, not a caller-chosen
base-object name. Existing shared transports/base dialplan remain operator-owned.

### 9.3 Files, secrets and broker durability

- Mount a managed directory into Asterisk read-only, with its parent/include
  relationship established by an operator-owned base configuration. The broker
  gets write access only to that managed directory; it must not rewrite the base
  config. Do not repurpose the existing per-file bind-mount fixture as proof of
  atomic replacement.
- Confine generated filenames to the namespace; reject symlinks, path traversal,
  foreign files, changed ownership and unsupported directory state. Temporary
  files must have restricted permissions from creation. Prove atomic replacement,
  file/directory durability and crash outcomes on the deployment filesystem;
  Windows host bind mounts are not automatically evidence for Linux permissions
  or crash durability.
- The broker, not the journal worker, should own recoverable per-generation
  credential material. Apply/observe replies expose no password, key or rendered
  config. This does not select a sealing implementation/key lifecycle: section 5
  remains an approval gate before credential-bearing prepare is implemented.
- Persist immutable intent and applying evidence before touching files or runtime.
  Record file-model digest and verified runtime evidence without recording
  secrets in receipts/logs. Exact retries recover the same generation; missing
  secrets/key material never cause silent replacement issuance.
- Hold the broker's exclusive apply lock until the actual PBX operation settles,
  including after client cancellation. A disconnected worker must not allow
  a second request to overlap an uncooperative first operation. Worker and broker
  locks/ledgers are separate; process crashes release OS locks, not uncertainty.

### 9.4 Runtime truth, expiry and recovery constraints

Successful reload output is not verified apply. Observation must compare the
expected generation/model against runtime endpoint/auth/AOR and relevant routing
state. Absent, partial, stale or contradictory evidence is unknown/failed as
appropriate, not success. A prepared identity must not receive new-call access;
activation remains gated until the separate routing/dialog proof passes.

After an interrupted apply, the worker's observation-only executor must reach a
broker observation that does not replay the effect. If a published file has not
been loaded, readback must report that discrepancy; any later repair operation
needs a separately reviewed authorisation/reconciliation rule. Retrying reload
automatically from an observe endpoint is forbidden.

The broker must enforce stored generation deadlines at mutating entry and
before enabling any new access. Deadline checks alone do not revoke access
afterward. Worker expiry currently provides periodic protection only while its
lifetime runs; neither its in-process health nor a broker makes failed-worker
expiry safe by itself. Independent expiry enforcement/failure response remains
an unresolved deployment gate. Do not claim disconnected-expiry safety from the
broker split alone.

Keep the selected drain-until-finished policy: stop new calls/offers, preserve
active dialogs, block replacement while state is unknown or dialogs remain,
and verify fence plus zero dialogs before removal. Permanent cancellation
tombstones, skipped revisions, authority replacement and lost-owner recovery
mutations remain deferred. No broker API may create these policies implicitly.

### 9.5 Bounded acceptance sequence before real effects

| Step | Required evidence | Still forbidden |
| --- | --- | --- |
| Unprivileged protocol fixture | Exact/bounded schema, local peer rejection, customer binding, malformed/foreign requests, detached readback, explicit errors. | PBX socket, reload, secrets or browser delivery. |
| Owned control-access probe | Actual Linux non-root socket permissions; only fixed broker-selected observation; worker denied direct file/socket access; unrelated customer unchanged. | Arbitrary CLI/shell route or expansion of reporting AMI permissions. |
| Non-secret managed-include probe | Closed rendering, namespace collision rejection, symlink confinement, restricted temporary files, atomic publish and readback, duplicate broker exclusion. | Credential issuance or activation. |
| Crash/uncertainty probe | Process exits before/after ledger commit, file publish, reload and runtime observation; response loss; same-identity retry; observation never applies; original uncertainty preserved. | Success-shaped fallback or blind repair/replay. |
| Credential-bearing prepare | Separately approved secret/key lifecycle; exact generation recovered; unrelated/base objects unchanged; prepared new-call access denied. | Browser disclosure and usable active phone. |
| Routing/dialog and expiry proof | Generation-aware call-path fence, active-call preservation, zero-dialog removal, replacement exclusion, independent failure/expiry policy and measured lag. | Production activation until all remaining stage C/D/E gates pass. |

First proposed implementation is the unprivileged protocol fixture only. Further
privilege probes require explicit scope/ownership confirmation and their own
test fixture; existing Docker-driven SIP proofs are historical evidence, not
authorisation to modify a live PBX.

### 9.6 First protocol subset: unprivileged readback fixture

The initial implementation now supplies fixed inventory and generation readback
only, with exact versioned JSON, pinned customer/epoch/principal checks, bounded
request/output/inventory and detached validated observations. Mutation, CLI,
path/config and secret fields are rejected. Shared expiry validators keep
inventory/dialog shapes consistent with the current worker. Source errors and
cancellation reject; requests do not overlap even while cancellation waits for
an uncooperative source.

Trusted peer metadata is injected out of band for the fixture. This proves scope
checks and denial before parsing/source access, **not** Linux local peer
authentication. No socket, connection limits, apply protocol,
broker ledger or PBX access is implemented. The subsequent codec subset below
adds bounded stream framing only. Real peer-credential/permission
proof remains required before the first acceptance step is complete.

The durable fake runtime readback test compares unchanged database bytes and
effect count, alongside malformed/foreign/oversized requests, exact bounds,
extra-field rejection, missing/unknown observations, timeout and cancellation.
No privileged control probe is authorised by this increment. See the
[readback fixture contract](./README.md#unprivileged-broker-readback-protocol-fixture).

The next unprivileged subset now supplies bounded one-frame stream codecs:
four-byte big-endian length, exact UTF-8 payload, mandatory EOF and separate
8 KiB request/32 KiB response limits. Length is checked before payload allocation;
truncation, extra frames/bytes, invalid encoding, timeout and cancellation reject
without invoking readback. Streams are single-use and destroyed on failure.
Tests cover fragmentation, exact limits, delayed trailing bytes and a framed
fixed-readback roundtrip.

This is a single request/response connection design; a future local transport
must deliberately implement request half-close and response completion, trusted
peer authentication, connection admission and bounded writes. No listener or OS
peer-credential proof is included. The first acceptance gate remains incomplete;
PBX/control probes remain unauthorised. See the
[framing contract](./README.md#bounded-broker-stream-framing-no-listener).

The complementary bounded writer now ends one frame's writable direction and
awaits local finish, with explicit timeout/cancellation/source-error handling.
Unresolved backpressure destroys only that owned stream after the write budget;
completion does not assert remote receipt or processing. The writer is single-use
and requires an unused byte-mode direction.

A test-only ephemeral TCP loopback fixture proves request half-close, mandatory
EOF before readback, framed response completion and trailing-data rejection
before source access. It closes all owned sockets/listeners. This narrows the
remaining transport uncertainty but still injects peer metadata: it does not
prove Linux Unix-domain identity, permissions, connection admission or a deployed
broker. No privileged apply/observation access or PBX effects were introduced.

The next unprivileged subset supplies an opt-in connection handler for an
already-accepted half-open socket, not a listener. It verifies trusted
transport-derived peer metadata before reading, admits one in-flight connection
per instance and applies a total five-second cooperative budget across readback
and response writing. Competitors are rejected before identity/source access;
cancelled uncooperative observations retain admission until actual settlement.
Original exceptions propagate without a success reply or automatic retry.

Loopback tests cover early peer denial, admission/cancellation/error recovery,
deadline closure and source slot retention after socket loss. Peer identity is
still injected test metadata; synchronous OS credential acquisition, Unix-domain
permissions and listener/backlog admission remain deployment gates. No runtime
listener or PBX authority is created. See the
[connection contract](./README.md#opt-in-broker-connection-admission-no-listener).

### 9.7 Linux peer-credential and filesystem experiment

A separate test-only Python standard-library fixture now proves actual
`SO_PEERCRED` behaviour on Linux. Its non-root server owns the mode-0750 socket
directory and mode-0660 socket, maps only the exact approved UID/primary GID,
and compares positive kernel PID to the client process. Foreign UID and primary
GID are denied before reading even if group permissions allow connection;
unrelated filesystem identities cannot connect. The approved worker cannot
unlink or create entries in the broker-owned socket directory. Server and
clients assert zero effective capabilities.

The PowerShell launcher uses the existing immutable local diagnostics image ID,
no network, read-only root/script, isolated tmpfs and a uniquely labelled owned
container. A capability-limited root orchestrator only establishes fixture
identities and cleans up bounded children; it is not the proposed broker.
The experiment touches no PBX, repository files or other containers.

This does not complete the first protocol gate: the Python probe is separate
from the TypeScript framing/readback handler, and no native binding/helper or
production broker language is selected. Deployment containers, UID/GID mapping,
user namespaces, trusted socket publication and same-UID compromise still need
explicit treatment. The next design decision is how the application acquires
OS-derived identity without accepting caller claims; privileged control probes
remain gated. See the
[Linux peer experiment](./README.md#linux-unix-socket-peer-identity-experiment-test-only).

### 9.8 OS identity integration options: comparison, not selection

Decision recorded 23 October 2026: compare integration approaches before adding
a native dependency, helper or second production runtime. No approach below is
approved for implementation or deployment by this comparison.

Current repository evidence:

- The TypeScript connection handler expects a synchronous
  `identify(acceptedSocket)` callback before frame consumption. Its tests inject
  metadata; they do not acquire kernel credentials.
- The installed Node type definitions provide socket/child-process handle APIs
  but no peer-credential method used by this project. No native peer-credential
  package has been selected, installed or evaluated. This is not a claim that
  every Node runtime/version lacks any possible solution.
- The Python fixture obtains Linux `SO_PEERCRED` on the accepted Unix socket and
  proves selected UID/GID filesystem policy. It implements neither the broker
  framing contract nor production admission, error reporting or supervision.
- Neither test proves identity mapping across separate containers, user
  namespaces or a socket passed between processes.

#### Option comparison

| Approach | Reuse and benefit | New trust/build cost | Required proof before selection |
| --- | --- | --- | --- |
| Native Node peer-credential binding | Keeps TypeScript framing, admission and readback in one process; potentially fits the synchronous callback. | Native code executes inside the broker; package provenance, maintenance, Node/N-API compatibility, architecture/libc packaging and failure behaviour need investigation. | A maintained candidate must query the exact accepted socket without undocumented Node handle access, fail closed on unsupported platforms and pass real UID/GID/namespace tests with the current handler. |
| Socket-owning credential helper | Small OS-specific component can accept/authenticate the local connection while TypeScript retains application validation. | Adds an authenticated local IPC boundary, lifecycle owner and crash/backpressure handling. A helper that forwards bytes becomes a trusted proxy, not merely a credential reader. | Prove unambiguous socket-to-request binding, bounded private IPC, no bypass path, ownership/cancellation on either-process death, and no unbounded queue or automatically replayed request. |
| Dedicated local broker runtime, Python as the current fixture candidate | Uses the already-proven standard-library kernel call directly on the socket it owns; no Node native extension or helper-to-handler identity hop. | Adds a separately deployed/runtime-tested implementation. Exact framing, schemas, cancellation and evidence behaviour must be ported and kept compatible; the current tiny Python probe is not that implementation. | Run shared protocol conformance cases plus actual Unix-socket identity/admission tests, then establish read-only source integration and production packaging/patching responsibility. |

No external package support/maintenance conclusion has been reached. If native
Node is chosen for investigation, evaluate current upstream sources and supported
runtime/platform matrices before dependency installation. Do not assume a package
is safe or maintained because it exposes the desired function.

#### Identity binding rules common to all options

1. Obtain credentials from the exact accepted Unix socket before reading request
   bytes. Map kernel UID/primary GID to a deployment-owned principal; customer
   and authority come from protected configuration, not peer JSON.
2. Do not look up a caller-supplied PID, `/proc` path, socket pathname or numeric
   file descriptor as proof of ownership. Descriptor numbers can be reused,
   process identity can change, and PID is diagnostic evidence rather than a
   durable principal. Kernel credential semantics after connection/descriptor
   transfer must be tested, not inferred.
3. Never return a free-standing `{ uid, gid, principal }` token that a caller can
   attach to another socket/request. Authentication and lifetime ownership must
   remain bound to that connection through decoding, source access and writing.
4. File-descriptor transfer is not automatically solved by Node child-process
   handle APIs. A Python/native-helper handoff requires a separately proven
   protocol and receiver support. Byte proxying instead requires a private,
   authenticated channel and a single trusted origin for forwarded identity.
5. Only the chosen entry path may reach the source. No test/injected-identity
   listener may be accidentally exposed beside the authenticated one. The
   current TypeScript factory remains an internal primitive, not an auth service.
6. Keep a single bounded admission owner across any helper/proxy layers. A
   cancelled or dead client must not release a slot while an uncooperative
   source still owns work. Independent process loss must surface explicitly;
   a restart must not manufacture acceptance or replay.
7. Preserve half-close/EOF framing and response limits end to end. A proxy must
   not turn request EOF into premature response shutdown or strip extra bytes
   before the validator can reject them.

#### Recommended next experiment, subject to approval

Prefer a **dedicated Python read-only conformance fixture** as the next experiment,
not a production runtime commitment. It can join the existing real kernel
credential check and bounded readback contract on one accepted Unix socket without
introducing an unproven native extension or identity-forwarding protocol. Keep it
unprivileged and source-fake-only; do not copy any privileged apply functionality.
The experiment must reuse language-neutral test vectors for field/size/encoding,
missing/unknown observations, half-close and error behaviour so the TypeScript
contract is not silently changed.

If retaining one TypeScript runtime is a higher operational priority, investigate
a maintained native binding instead before writing the Python implementation.
The credential-helper approach is least attractive for the first experiment
because it introduces an additional trusted hop whose socket/lifetime binding
must be established before it closes the current gap.

Selection still requires user approval. After selection, first prove an allowed
Unix peer can obtain the exact fixed readback response while a foreign peer,
oversized/trailing frame and conflicting concurrent connection cannot reach the
source. Prove failure cleanup and namespace mapping in the intended container
layout before any PBX control-access experiment. Secret/key management,
independent expiry protection and mutation/recovery policies remain unchanged
approval gates.

### 9.9 Approved Python read-only conformance experiment

The user approved a dedicated unprivileged Python fixture, not a production
runtime selection. The existing owned-container launcher now has `-Conformance`:
it first runs the TypeScript shared-vector test, then the Linux Python socket
fixture with the same language-neutral JSON cases mounted read-only.

Thirty-six shared cases verify exact expected replies for static inventory,
unknown dialogs and missing generation; reject foreign scope, mutation/secret
fields, invalid JSON/version/UUID/BOM and malformed/oversized/trailing frames;
and cover fragmented framing at the exact 8 KiB request boundary. The Linux
fixture checks kernel UID/primary GID before reading and confirms no valid reply
before request EOF. Final source counters prove rejected/foreign requests did
not invoke the fake source, and an approved client reconnects afterward.
The original filesystem/credential proof and the new conformance run pass with
non-root capability-free server/client identities; owned containers are removed.

This is deliberately not full runtime parity. Python uses fixture-supplied fake
source data and a sequential vector server, with separate admission/lifetime
evidence below. Broader source/error/cancellation conformance remains unfinished.
The test-only cross-process client is described below; no production
service, ledger, mutation or PBX authority was introduced. Further experiments
must close those protocol/lifetime gaps before the first broker acceptance gate
can be considered complete. See the
[Python fixture contract](./README.md#python-read-only-conformance-experiment-approved-fixture-only).

The conformance command now additionally runs a separate real Unix-socket
admission/lifetime experiment. One nonblocking slot excludes competitors before
identity lookup or read. An idle request expires after five seconds. A subsequent
approved framed request enters a held fake source: its socket closes at deadline,
but the slot remains occupied until the source actually settles. An approved
reconnect then succeeds. A further approved request invokes a fake source that
raises a typed exception: the client receives no response bytes, the server emits
the expected fixed stderr diagnostic and releases the slot, and the next approved
request succeeds. Exact counters require nine source invocations (two failed,
including exactly two generation-source entries),
five capacity denials, three timeouts (two before request EOF) and one explicit cancellation; accepted clients still use real kernel
UID/primary GID. The parent requires exactly the expected diagnostic, rejecting
unexpected thread/timer tracebacks too. Source hooks/failure sequencing remain
fixture-only, not wire actions or a production exception policy.

The test uses source/deadline threads and a private parent control pipe solely
to cancel a connection or release the fake source deterministically. It selects no production
threading/control architecture, creates no remote release action and adds no PBX
authority. All owned children/socket entries/containers are removed. Broader
source/error/cancellation parity, actual container identity
mapping and deployment supervision remain incomplete. The first broker gate
is still not approved as complete.

The explicit owner-cancellation case closes a held-source connection through
that private pipe. EOF with no response bytes is required within three seconds,
before the five-second deadline. A competitor remains capacity-denied until
source settlement, then an approved reconnect succeeds. A synchronised,
connection-bound terminal callback prevents a second cancellation/deadline close
and is removed before slot release. No wire-level cancellation operation is
added. Peer-disconnect detection while source code blocks, general cancellation
races and production supervision remain unproved.

Twenty-eight additional shared source-output vectors now exercise exact inventory
and observation validation in TypeScript readback and over authenticated Python
Unix sockets. Valid output matches exactly; invalid output (including secret-like
extra fields, duplicates, unsafe/fractional numbers, boolean/numeric confusion and
missing fields) closes without a response frame. Python enforces JavaScript-safe
integer bounds while accepting integral JSON numbers such as `1.0`. Selection of
fake source values is trusted fixture sequencing, never a wire-level override.
This proves the tested validation subset only, not dynamic PBX integration,
complete source failure handling or a production runtime choice.

The user additionally approved a separate test-only Node/Python Linux image.
`Test-BrokerPeerProof.ps1 -CrossRuntime` now launches non-root Node clients
against the Python server's actual Unix socket. The client imports the production
TypeScript framing helper; all 36 request/framing vectors and 28 source-output
vectors, foreign-UID denial and approved reconnect pass across the language
boundary. Invalid raw frames intentionally bypass the writer; valid replies
must decode and equal the expected object, and rejections must return zero bytes.

The image pins its Node base digest, adds Python and copies no project code.
Build-time registry/package access is distinct from the network-disabled proof
runtime; Debian packages are not snapshot-pinned. The launcher requires the
already-built image, resolves its local immutable ID, and mounts only four
read-only inputs. Existing privilege/resource/cleanup restrictions remain.
The admission/failure/cancellation phase now also substitutes Node clients in
`-CrossRuntime` mode. The same scenario proves idle and held-source deadlines,
capacity exclusion after timeout/cancellation until actual source settlement,
source-exception recovery, and successful fresh approved Node readbacks.
Lifecycle rejections require EOF with zero bytes; the Node watchdog allows eight
seconds for the server's five-second deadline, while explicit owner cancellation
must finish within three seconds. The existing exact counters and expected stderr
diagnostic remain mandatory. Default `-Conformance` continues using Python
clients, and cancellation remains on the private parent control pipe.
Production client lifecycle, peer-disconnect handling during blocked source code,
separate-container namespace identity mapping,
supervision and full broker acceptance remain open. See the
[cross-runtime proof commands](./README.md#cross-runtime-unix-socket-conformance-approved-test-image-only).

### 9.10 Acceptance-gap review after cross-runtime lifecycle proof

Review recorded 23 October 2026 against the implemented fixtures and TypeScript
helpers, not against a deployed broker. The first step in section 9.5 has
substantial subset evidence but is **not signed off as complete**. None of the
later steps is authorised by passing these tests. Python remains a test runtime,
and the separate Node/Python image remains an approved experiment only.

| Surface | Evidence now present | Remaining evidence / decision |
| --- | --- | --- |
| Read-only request/response subset | Shared 36 request/framing and 28 source-output vectors pass independently and with real Node clients against Python Unix sockets, including strict JSON constants, exact 100/101 inventory bounds, delayed EOF, truncation, concatenated-frame and strict UTF-8 rejection. | Broader parser/response boundary parity; this finite corpus is not protocol equivalence. No mutation schema or ledger is implemented. |
| Numeric JSON semantics | Shared request text now accepts `1.0`, `1e0` and `10e-1` as version 1 and rejects booleans, strings, fractions and overflow. Source validators enforce safe integers. | Tested numeric forms now agree; this does not establish equivalence for every parser edge case. |
| Source accounting | Independent source-entry instrumentation now asserts zero entries for every rejected request and one for valid requests, including missing generation; every source-output case enters once, even when its output fails validation. Successful responses are counted separately. Idle and complete-without-EOF deadlines leave source counts unchanged. | These per-case assertions cover the fixture corpus, not all future sources/actions. Concurrent scenarios count nine actual source invocations, including two failures and exactly two generation entries. |
| Lifecycle | Both client variants prove idle/held-source deadlines, exclusion until settlement, injected source failures, private owner cancellation and fresh recovery. Section 9.12 adds terminal ordering, Linux poll-based blocked-source peer loss and measured backpressure with slow-reader completion/non-reader deadline recovery. | Arbitrary terminal/disconnect scheduling and immediate cancellation during partial writes remain unproved. Required request EOF alone is not proof of peer loss. Production integration and other transports remain separate. |
| Transport authority | Real accepted-socket `SO_PEERCRED`, exact UID/primary GID, non-root capability-free processes and broker-owned directory/socket modes are exercised. Section 9.12 adds separate-container default-map evidence and publication denial. | Broader user-namespace mappings, restart/conflicting-path publication and same-UID compromise still need explicit deployment treatment. PID positivity alone is not process attestation. |
| Admission/resources | One active slot is retained until source settlement; capacity denial precedes peer lookup/read; fixtures have container limits. | Backlog one is not an end-to-end resource/rate limit. Production listener policy, process supervision, shutdown and crash behaviour are unselected. Fixture threads/control pipe are not that architecture. |
| Production integration | Node uses the real framing helper; Python owns its accepted Unix socket. Section 9.14 records the later dedicated-Python approval and first authenticated read-only implementation. No PBX access is needed. | No OS-identity integration is wired into the TypeScript connection handler. The Python implementation still needs implementation-specific deployment coverage, concrete read-only source wiring and packaging/supervision. Fixture interoperability alone is not deployment approval. |
| Privileged effects | No new evidence is claimed beyond the unprivileged subset. | Control access, managed-file confinement/durability, crash ledger, secrets, runtime truth, routing/dialog fences and independent expiry remain the separate gates in sections 9.3-9.5. |

The shared request-number parity and source-entry accounting increment is now
implemented within the existing unprivileged fixtures. Python request integer
decoding uses floating-point semantics to match JavaScript JSON numbers and
explicitly rejects booleans. Next test peer disconnect/terminal races without confusing request
half-close with cancellation. A separate-container experiment requires an
explicit namespace/socket-publication test design; production runtime selection
and any control-access probe require their own decision and approval.

The original review was documentation-only; the follow-up parity/accounting
increment changes test fixtures only. It does not retroactively broaden earlier
PASS messages or approve a later gate. The lifecycle fixture also now uses one
deadline for socket I/O and its timer, funnels socket deadline expiry through the
same terminal callback, and includes server stderr if its event stream closes
unexpectedly. This improves fixture diagnostics and deadline accounting without
claiming that general terminal races are proved.

The generation-failure follow-up uses the same typed fixture failure boundary
and requires a second exact stderr diagnostic. Both client variants see EOF with
zero bytes, then successfully read the same generation as observed on a fresh
connection. TypeScript separately asserts unchanged exception identity and no
inventory-source invocation. The fake source receives a validated-operation
default, and its failure schedule remains private to the fixture. No production
error policy, retry, repair or mutation is introduced.

Two timing vectors now hold a complete valid inventory payload open for 50 ms:
both real client variants require no response bytes or server EOF before request
EOF. Clean half-close then returns exact inventory; a trailing byte sent after
the wait rejects with zero source entries. The TypeScript stream variant also
asserts no source invocation at the end of the delay. Node uses the production
encoder with explicit writes/half-close for these two cases only; normal valid
requests retain the production writer. These are timing fixtures, not new wire
fields: `delayEofMs` and `trailingHex` never become JSON request properties.
The result does not complete peer-disconnect or general terminal-race evidence.

Both lifecycle client variants additionally send a complete valid inventory frame
without EOF. The admitted request excludes a competitor, closes at the shared
five-second deadline with zero response bytes and no source entry, then permits
a fresh approved inventory read. Exact counters require two request-phase
timeouts (idle and complete-without-EOF) and one held-source timeout. Node uses
the production encoder and intentionally leaves its writable direction open.
An eight-second client watchdog is a failure bound, not a substitute for server
closure. This does not detect full peer loss during blocked source execution
or approve production listener behaviour.

The malformed-frame follow-up adds eight shared cases: partial headers at each
nonzero short length, a valid request missing its final payload byte, two complete
valid frames concatenated, and overlong/surrogate/incomplete UTF-8. Independent
source-entry checks remain zero; framing/decode error categories are asserted in
both implementations so a later JSON error cannot stand in for UTF-8 rejection.
These cases still permit a fresh approved readback after rejection.

The concatenated-frame case exposes a real Unix-socket closure distinction:
unread trailing data can produce a read-side connection reset, even with an
explicit shutdown before close. That named case alone accepts EOF or the exact
read-reset error with zero bytes; timeouts, write errors and unrelated errors
fail. Other rejection cases continue to require zero-byte EOF. No unbounded drain
or production transport-policy change is added to hide this distinction.

The inventory-limit follow-up adds shared trusted `inventoryCount` recipes for
100 and 101 unique generations. Each zero-based index forms a 12-digit lowercase
hex UUID suffix, deadline index plus one and alternating draining flag (true at
zero). Both languages expand these locally, never through client request fields.
The 100-entry reply must match all ordered values exactly through framed socket
readback; 101 yields zero response bytes after one source entry. Later cases and
approved reconnect remain successful. This proves the existing inventory bound,
not a configurable limit, a larger response-size boundary or production source.

The strict-JSON follow-up closes a reproduced Python decoder discrepancy:
`NaN`, `Infinity` and `-Infinity` tokens are rejected via `parse_constant`
before request/source validation. Shared regressions hide each token behind a
later duplicate version 1, requiring a JSON syntax error and zero source entries,
not just eventual version rejection. A quoted `"NaN"` overwritten by version 1
is a valid control case and still succeeds. Existing last-field-wins parsing
matches TypeScript; no new duplicate-key policy or text filtering is introduced.
This changes the test-only Python fixture, not the production TypeScript parser,
and does not establish equivalence for every JSON edge case.

### 9.11 Planned separate-container identity and socket-publication experiment

Initial decision recorded 23 October 2026: plan this experiment before
implementation. The later scoped fixture approval and results are recorded in
section 9.12; this plan alone did not authorise execution or a production runtime.
It extends the existing unprivileged read-only fixture only; PBX/control sockets,
managed configuration, credentials, mutation and network listeners remain out
of scope. Existing single-container PASS results are not deployment evidence.

#### Topology and ownership

- A future dedicated launcher creates one uniquely named and ownership-labelled
  Docker volume plus separate broker and worker containers. Use local immutable
  image IDs from the existing test-only images; do not pull/build implicitly.
  Do not reuse an operator/customer volume, Windows host bind mount, or existing
  socket directory. A Docker-managed Linux volume tests that backing filesystem,
  not all production filesystems.
- Use distinct default PID/mount namespaces, `--network none`, read-only roots,
  no-new-privileges and zero runtime capabilities. Do not use privileged mode,
  host PID/user namespace flags, Docker socket mounts or extra device access.
  Retain explicit per-container CPU/memory/PID limits and bounded subprocess
  lifetimes. No repository-wide mount is needed.
- A short-lived, separately labelled setup container may initialise only the
  new volume's exact socket subdirectory, owned by broker UID 1101 / GID 2100,
  mode 0750. It has only the capability needed to establish ownership and exits
  before either runtime starts. Do not recursively chown a shared parent or
  relax directory permissions after a failed test.
- The broker runs as 1101:2100 with the volume writable; the worker runs as
  1102:2100 with the socket directory mounted read-only. Bind mode is not
  authentication: a read-only mount may still permit connecting to a Unix
  socket. Kernel credentials and filesystem mode checks remain mandatory.
  Node clients need only their fixture, vectors and framing helper read-only.
- Foreign clients are separate short-lived containers with exact test identities.
  Only the broker writes/unlinks the socket entry. The host launcher owns
  lifecycle coordination, not application identity assertions.

#### Namespace evidence before making identity claims

Record the daemon security/rootless/user-namespace configuration relevant to
the run and each fixture process's numeric UID/GID, supplementary groups,
`uid_map`, `gid_map`, effective capabilities and PID/user namespace links.
Do not collect unrelated host/container environment or credentials.

On each accepted connection, acquire `SO_PEERCRED` from that socket before frame
read, recording the observed tuple in test evidence. Compare UID/primary GID
against the explicitly declared policy in the broker's namespace. A client
claim in JSON, its container's numeric UID alone, or an inspected container name
is not a substitute for the observed credentials. Unmapped/overflow identities
must fail closed; unexpected mappings block the run rather than silently changing
the allowlist. One passing daemon mapping does not approve all user namespaces.

Do not carry over the single-container assumption that peer PID is positive and
equals a client-local PID. Cross-PID-namespace observations can differ or be zero.
Measure and report them; PID is not authentication or process attestation. Before
implementation, explicitly decide whether this fixture authorises by mapped
UID/primary GID alone when PID is not visible, or treats that environment as
unsupported. Do not silently weaken the existing fixture's checks.

#### Required cases and measurable outcomes

| Case | Required result |
| --- | --- |
| Approved worker | Exact mapped UID/primary GID observed before read; valid inventory/generation replies match the shared corpus; runtime identities have zero effective capabilities. |
| Foreign UID, same socket group | Filesystem connection may succeed, but broker denies before any frame read/source entry; no success bytes. |
| Wrong primary GID with approved supplementary group | Where the measured namespace/group setup supports the case, traversal/connect may succeed but broker still denies before read. Supplementary group membership must not substitute for the primary-GID policy. |
| No socket-directory group | Filesystem connect fails; no broker admission/source access. Distinguish this from protocol-level denial. |
| Worker publication attempts | Approved worker cannot create, unlink, rename or replace entries in its read-only socket mount. Repeat against a temporary writable mount of this fixture volume with the same worker identity, proving broker directory ownership/mode rather than mount mode alone. Touch no paths outside that volume. |
| Sequential availability | A denied client does not kill the broker or consume its slot indefinitely; a fresh approved connection succeeds afterward. |
| Duplicate broker | A second broker fails on the live pathname without unlinking it or serving on a fallback path; original broker remains reachable. No pre-bind unconditional stale-socket removal. |
| Broker exit and explicit restart | Observe existing-connection loss and new-connect failure, then restart only through explicit parent control after verifying the old owned container has exited. Remove only the verified fixture-owned stale socket, if present. Fresh approved clients must reconnect and reauthenticate; no replay of old requests. |
| Conflicting publication state | A regular file or symlink at the expected pathname makes startup fail without overwriting/following it. Create these only in the newly owned fixture volume after stopping the broker. |
| Bounds and cleanup | Explicit readiness and per-case deadlines; failures retain diagnostics and fail the launcher. Stop/remove only recorded container IDs with matching ownership labels, then remove only the exact newly created labelled volume after owned containers are gone. |

Socket publication uses a fixed path under the protected directory, not a
client-supplied pathname. Restrict socket mode at creation (for example with a
restrictive process umask), verify final owner/mode before readiness, and never
make an unverified socket available as ready. An existing connection remains
bound to its original accepted socket: pathname replacement cannot transfer its
identity. The restart case is test-driven operator action, not automatic
supervision, recovery mutation or a selected production rotation policy.

#### Stop conditions and approval boundary

Stop on unexpected namespace mappings, missing kernel credential support,
unexplained permissions, inability to verify owned cleanup, or any need for host
namespace/privileged access. Report unsupported environments separately from
passing cases; do not use success-shaped skips. Do not fix a failing mapping by
granting DAC override, broad supplementary groups or world-writable directories.

Before implementation, confirm the peer-PID visibility policy above and approve
the dedicated launcher/labelled-volume scope. A successful experiment would
support only the measured separate-container fixture topology. It would not
choose native binding/helper/Python production integration, solve same-UID
compromise, establish production supervision or complete the control-access,
secret, crash-durability, routing/dialog and independent-expiry gates.

### 9.12 Approved separate-container identity/publication subset

The user approved the isolated test implementation and chose authorisation by
exact mapped kernel UID/primary GID. Peer PID is recorded, not used to authorise.
The older single-container fixture retains its positive-PID check unchanged.
This is not a production authentication-policy or runtime selection.

`scripts/Test-BrokerContainerProof.ps1` now creates a fresh uniquely labelled
Docker volume and recorded containers using the existing immutable local
cross-runtime image ID. It records daemon security options without collecting
environment/credential dumps. A short-lived root setup container has only CHOWN
in addition to the restrictive common flags and initialises exact new paths;
broker/clients are separate non-root, zero-capability containers with network
disabled, read-only roots and resource limits. Three fixture inputs are
mounted read-only; opt-in Node corpus and lifecycle clients add only their client and framing
helper read-only. No PBX, Docker socket or repository-wide mounts are used.

The Python fixture reuses the existing framing/readback/validation functions;
an import guard prevents importing that fixture from starting its original
orchestrator or installing its alarm. Each separate process installs its own
bounded alarm. The broker verifies directory ownership/mode and publishes under
a restrictive umask, checking socket ownership/mode before readiness.

Verified subset:

- Separate PID/mount namespaces, shared user namespace, full identity UID/GID
  maps (`0 0 4294967295`). Other mappings are explicitly unsupported and fail,
  not skipped or allowed by changing identities. Every process records its
  groups/maps/namespace links and asserts zero effective capabilities.
- Approved 1102:2100 clients receive exact inventory and generation responses.
  Kernel peer PID was **0** in this topology; exact UID/primary GID remained
  visible. Foreign UID 1103 with GID 2100 and approved UID with primary GID 2101
  plus supplementary 2100 are denied before frame read/source entry.
- Unrelated 1104:2101 fails at filesystem connect. Expected group membership is
  checked in each client, distinguishing filesystem denial from peer denial.
- Approved workers cannot create/unlink/rename/replace the socket entry:
  read-only mounts produce EROFS/EACCES; writable-volume tests require EACCES,
  proving directory protection independently of mount mode. Replacement uses an
  existing worker-owned file on the same volume, not cross-device failure.
- A duplicate broker fails with address-in-use without removing the live path.
  The original subsequently serves approved reads. Three actual source entries,
  two pre-read identity denials and five accepted-socket peer tuples are required.
- Normal completion removes only the same verified socket inode. Cleanup checks
  exact recorded container names plus owner labels, removes their IDs, then
  removes the exact labelled volume only if container cleanup succeeded.
  Readiness is bounded, ordinary broker alarm is 60 seconds, client alarms are 15 seconds;
  no service is intentionally left running.

This subset uses Python clients; the follow-up below adds the entire shared
vector corpus across separate containers. Namespace identifiers can be reused after sequential client
containers exit; only client-versus-live-broker separation is asserted. The
observed rootful/default-map topology does not establish rootless/remapped user
namespace support. Same-UID compromise remains outside this identity policy.

Still open from section 9.11: broader namespace configurations and
separate-container concurrent lifecycle coverage. The bounded explicit
crash/restart case is recorded below, not a general recovery policy.
No automatic restart, production listener, control access or later acceptance
gate is implemented or approved by these results.

The conflicting-path follow-up now runs after the original broker has completed.
Two new recorded, labelled containers run as broker UID/GID on the same isolated
volume, creating either a regular sentinel file at the exact socket pathname or
a symlink to a separate sentinel file inside the fixture directory. Each starts
the actual fixture server in a bounded subprocess with inherited non-root,
capability-free identity. Bind must fail with structured EADDRINUSE evidence and
nonzero exit, without readiness or peer events; an arbitrary startup error does
not satisfy the assertion.

The parent verifies the original path's device/inode, mode and ownership.
Regular-file contents must remain exact; symlink text plus target device/inode,
mode, ownership and bytes must remain exact. Cleanup unlinks only the verified
fixture-created entries after child settlement; containers and volume retain
the launcher's existing ownership-checked cleanup. This proves preservation for
these fixed conflicting-path cases, not general symlink confinement of managed
configuration, stale-socket recovery or a production publication implementation.

The explicit crash/restart follow-up records the published socket's device/inode,
then authenticates and fully reads one approved request before `os._exit(23)`
deliberately bypasses cleanup. Zero source entries at that crash point and EOF
without response bytes are required. The host launcher waits for exit 23 and
inspects stopped state before authorising any stale cleanup; all involved
containers remain newly recorded and ownership-labelled.

A separate approved client must receive connection-refused at the stale path.
Starting another broker must fail address-in-use without readiness or implicit
unlink. A broker-user cleanup process first rejects a deliberately wrong inode;
the subsequent successful cleanup proves that rejection preserved the original
entry. Actual removal requires the recorded device/inode, socket type,
owner/mode, connection-refused and unchanged inode immediately before unlink.
It operates only on the fixed path in the isolated new fixture volume.

Only explicit parent sequencing then starts a new broker and a fresh approved
client. The new accepted socket's UID/primary GID is checked again, exact
inventory readback succeeds and its server records exactly one source entry and
no denials. This proves no automatic replay in this before-source crash scenario,
not response-loss recovery after an effect, automatic supervision, active-call
safety or a production stale-path policy. The protected fixture directory and
stopped owned containers exclude concurrent writers during cleanup; the
stat/connect/stat/unlink sequence is not claimed atomic against a hostile broker
UID or host administrator.

The shared-corpus follow-up starts an additional sequential broker after the
explicit restart proof completes. It reuses the existing conformance server and
client functions instead of copying their schema/framing checks. Its test-only
`require_visible_pid=False` setting applies the explicitly approved separate-PID
namespace policy; the default remains true for all older single-container runs.
Every accepted socket records kernel PID/UID/GID. Peer PID remains evidence only,
while exact UID/primary GID controls access.

The launcher creates a fresh non-root client container per case: foreign UID
first, all 36 request/framing cases, all 28 source-output cases, then approved
reconnect. Client socket mounts are read-only; only the broker can publish/remove
the socket. Client-versus-live-broker maps, user namespace equality and distinct
PID/mount namespaces are checked for every case. Server per-case source-entry
assertions and framing/JSON error categories remain active. Final successful
response, source-entry, rejection and foreign-denial counters are derived from
the same shared vectors; kernel peer tuples must match every expected client.

The corpus broker has an explicit 180-second process alarm to allow bounded
container startup overhead, five-second connection budgets and a ten-second
accept wait. Each client retains its 15-second process alarm and existing socket
budget. Cleanup retains every recorded container until the run ends for evidence,
then removes only owner-labelled resources. Passing this complete finite corpus
does not establish full protocol equivalence, remapped user-namespace support or
general concurrent lifecycle behaviour across containers; those remain distinct gaps.

`Test-BrokerContainerProof.ps1 -NodeClients` now substitutes Node/TypeScript
clients for the sequential separate-container corpus, the three crash/restart
client steps, the admission phase and the early request-disconnect phase below. The existing client
imports the production framing helper, and every case must produce explicit
wrapper completion evidence identifying Node. The Python identity wrapper
checks maps/groups/namespaces first and runs Node with inherited credentials,
a ten-second subprocess timeout, exact zero exit and empty stdout/stderr.
Node independently checks UID/GID and zero effective capabilities. Failures do
not fall back to Python. The default Python mode emits equivalent checked runtime
completion evidence.

Only these Node client containers mount the two additional read-only TypeScript
files. Broker, identity/publication, conflict and stale cleanup stay Python,
and ownership/resource restrictions remain unchanged. Both modes pass the 36
request/framing and 28 source-output cases plus foreign denial and approved
reconnect across separate containers. This proves sequential cross-language
interoperability in the measured default-map topology, not concurrent lifecycle
or broader namespace support and not production runtime selection.

The Node crash/restart follow-up additionally substitutes the crash-wait,
stale-refused and restart-read clients in `-NodeClients` mode. Each wrapper checks
explicit lifecycle-case/runtime completion and inherits the same non-root
identity/map checks, ten-second child timeout and empty stdout/stderr requirement.
Node crash-wait requires EOF without response bytes, never a timeout/reset
fallback; stale-refused requires exact connect-side ECONNREFUSED with zero
bytes sent/received. Fresh restart-read uses the production frame reader/writer
and exact expected inventory.

The parent continues to require the old broker's controlled before-source exit,
stopped state, refusal at the stale path, startup refusal, wrong-inode cleanup
rejection and exact inode cleanup before explicitly starting its replacement.
The replacement authenticates a new socket and records one source entry.
Default Python mode is unchanged. This extends the same bounded no-replay
scenario across runtimes, not a general retry or response-loss recovery policy.

The bounded separate-container idle/missing-EOF admission follow-up reuses the concurrent
fixture with its default positive-PID check retained for the original topology.
Only the approved separate-container mode authorises mapped UID/primary GID
without using PID, and records all sixteen kernel peer tuples. An idle authenticated
client occupies the one slot while an overlapping approved competitor must close
with EOF and zero bytes. The idle connection times out after a measured five
seconds (at least five, below the eight-second client watchdog) with zero source
entries, then releases the slot. The sequence repeats with a complete valid framed
inventory body but withheld EOF. The parent waits for explicit broker
body-received evidence before starting that competitor. The observation hook
checks the exact fixture payload (unpadded inventory request, its specified padded
reconnect form or the generation request) before the frame reader waits for EOF; it neither accepts EOF
nor enters a source. The second timeout must report body received, whereas the
first must report no body, both with zero source entries and measured
five-to-eight-second budgets. Both waiting clients require EOF without response
bytes, never reset/timeout success fallbacks.
A new authenticated client then sends a complete inventory request whose source
deliberately raises `FixtureSourceFailure`. It must receive EOF with zero response
bytes, never a reset/timeout or successful/missing fallback. Broker evidence
requires exactly one fixed `Fixture source unavailable` diagnostic plus a
source-failed event and structured evidence of one source entry with the two
earlier request timeouts unchanged. The launcher accepts only the two exact source diagnostics;
all other log lines must parse as structured evidence, so unexpected tracebacks
or extra diagnostics fail.
The parent waits for the third slot release before starting a fresh authenticated
recovery client, which must return exact inventory. No automatic retry is added.
The broker remains available for a generation-source exception on the third
total source entry (first generation entry). That client must get EOF with zero
response bytes, not a `missing` or other success-shaped response. Exactly one
`Fixture generation source unavailable` diagnostic and a second source-failed
event are required; structured evidence must show three total source entries,
one generation entry and the unchanged two timeouts.
After the fifth slot release, a new authenticated generation connection must
return the exact `observed` response, not merely any valid response frame.

After generation recovery and the sixth slot release, the fifth source entry
holds an inventory read on an uncooperative fixture event. An approved competitor
must be rejected before its deadline. At the measured five-second deadline,
the original client must receive EOF without response bytes; timeout evidence
records exactly five source entries. After the client exits, the parent sends
test-only `SIGUSR2` in this timeout-first phase. The existing terminal callback
must emit explicit late-cancellation evidence with five source entries, three
timeouts, zero cancellations and the slot locked, without changing the timeout
outcome or closing/releasing again. This late attempt is admitted only once in
the expected phase; duplicate or out-of-phase parent control fails the fixture.
The parent requires the observation before starting the post-timeout competitor.
A further approved competitor must still
be rejected after client exit, with the slot locked and no new source entry.
The two structured capacity observations distinguish the two-timeout
pre-deadline state from the three-timeout post-deadline state.

Only after late-cancellation evidence and both denials does the parent send test-only `SIGUSR1` via Docker to
the exact recorded broker container. This releases only the fixture source event:
there is no wire release request, extra mount, network access or worker privilege.
The handler is installed only in separate-container admission mode, restored
on exit, and records an experiment failure for early/duplicate control or an
unexpected source/capacity/timeout state. Source settlement requires terminal
connection state with the admission slot still locked. A missing parent release
fails the fixture's 15-second source watchdog, never a success-shaped fallback.
The parent requires explicit source-settled and seventh slot-release evidence
before a fresh authenticated inventory read can succeed. This extends the
existing test-only parent-control pattern, not production signal/recovery policy.
After the eighth slot release, source entry seven holds a second inventory
request. The parent waits for its source-entered event, then sends fixture-only
`SIGUSR2` to the exact recorded broker container. The launcher measures signal
dispatch through successful client container exit and requires less than three
seconds, zero-byte EOF and explicit runtime completion, not reset/timeout
fallback. The cancellation handler validates the phase and uses the existing
terminal callback under the lifetime lock; unexpected/out-of-phase control fails
the experiment. The output lock is reentrant so signal-triggered terminal
logging cannot deadlock if it interrupts logging in the same thread.

After the cancellation event, another approved competitor must be rejected
with the slot still locked, seven source entries, three timeouts and exactly
one cancellation. The parent sends one further fixture-only `SIGUSR2` in this
exact phase. It must reach the same terminal callback and produce explicit
repeated-cancellation evidence with seven source entries, three timeouts,
one cancellation and a locked slot. This is a no-op: no second terminal
outcome, socket close, source entry or slot release. The handler permits exactly
this one repeated attempt; a third or out-of-phase signal fails the experiment.
Source release requires the repeated-attempt observation. No extra client,
wire action, mount or privilege is introduced.
The source remains held through the original connection
deadline. The parent requires explicit evidence from the original timer callback
at a measured five-to-eight seconds: seven source entries, three timeouts,
one cancellation and a still-locked slot. The already-terminal callback must
not close the connection again, increment timeout counters or release admission.
After this evidence, another approved competitor must receive zero-byte EOF
without source entry; the post-deadline capacity observation must retain the
same terminal counters and lock state. No sleep-based proxy substitutes for
the timer callback evidence.
Parent `SIGUSR1` then releases the source in this exact six-denial phase.
Source settlement and ninth slot release must precede a fresh authenticated
inventory response. Both handlers exist only in separate-container admission
mode and are restored on exit. This is explicit test-parent cancellation,
not worker access to Docker signals or a production cancellation protocol.
Final counters are exactly eight source entries, six capacity rejections, three
timeouts (two request and one held-source timeout), two generation reads, two
source failures and one cancellation.
Final event evidence independently requires exactly three timeout outcomes,
one cancellation outcome and ten slot releases, in addition to the aggregate
counter checks. The late and repeated attempts add no client or source entry.

The delivery follow-up records response-send attempts for each admitted
connection, incrementing immediately before the actual send call, not only
after successful delivery. The launcher requires all ten delivery records in
source-entry order `0,0,1,2,3,4,5,6,7,8`, with attempts
`0,0,0,1,0,1,0,1,0,1`. Every observation must precede admission release while
the slot is still locked. The timeout/cancellation marker is true only for
the two request deadlines and the two held-source terminal outcomes; source
exceptions remain separately counted failures.

Exactly the timed-out and cancelled held-source results must be marked
discarded, with no response attempt. Each such delivery record must occur
immediately after source-settled and immediately before slot-release evidence.
Thus late source completion is checked after its original client has exited,
rather than inferring suppression only from the earlier zero-byte EOF or
silently treating a failed send as success. Fresh recovery clients still require
exact inventory/generation responses; no replay, new wire action, resource
privilege or production behavior is added.

The freshness follow-up makes the two held-source inventory results and their
recovery results distinguishable. In separate-container admission mode only,
source entries five through eight return copied generation metadata with
`notAfter` equal to the shared fixture baseline plus the source-entry number.
The baseline object is not mutated. Delivery evidence requires values `160005`,
`160006`, `160007`, `160008` for those entries, independently of response-attempt
and discard assertions. Both Python and Node recovery clients build their exact
expected inventory from the fixture baseline plus six or eight, respectively.
Thus an old baseline or a discarded result cannot pass as the fresh recovery
response merely because the broker logged another source entry. The new client
modes are used only by these recovery steps; shared corpus and original
single-container lifecycle behavior remain unchanged. No real clock, credential
lifetime, production caching policy or protocol field is introduced.

Both default Python and opt-in Node clients exercise this sequence in independent
containers with checked identity/maps, distinct broker/client PID/mount namespaces,
runtime completion and the existing resource/cleanup restrictions. No extra
mounts beyond the already approved Node inputs or network access are introduced.
The fixture exits after the post-settlement fresh inventory read, without a new
wire operation. The original full lifecycle sequence and private stdin control
remain unchanged by default.

Validation exposed a shared fixture race: deadline shutdown could supply EOF
to a complete waiting frame before its thread observed terminal state. The
concurrent fixture now checks terminal state and the same monotonic deadline
after frame reading and under the lifetime lock before source entry. This is a
test-fixture correction, not a production implementation change.
Passing these request-wait, held-source and explicit cancellation scenarios does
not prove peer-disconnect handling or general terminal-race safety.
In particular, the two ordered cases (cancellation before a later no-op deadline,
and timeout before late cancellation) do not prove simultaneous
cancellation/deadline or response-completion races. A later isolated barrier
case below adds bounded evidence for deadline/cancellation contention only.
The sequential repeated-cancellation case likewise does not establish
simultaneous cancellation delivery or cancellation after successful completion.

The early-disconnect follow-up uses a separate finite broker instance on the
same isolated socket volume after the admission broker has exited and removed
its path. Thirty-two fresh approved clients run in sixteen rejection/recovery pairs.
The rejected prefixes are: close without a
request, close after one/two/three bytes of a valid four-byte length header,
close after the full header without any body, close after that header plus
three body bytes, close one byte short of the ordinary body, close one byte
short of an 8,192-byte padded body. Each rejection is immediately followed by a
new complete inventory read that must succeed before the next prefix. Each prefix
comes from a valid inventory frame, so invalid length is not substituted for
truncation. The two final-byte boundary clients assert that their full encoded frame is
exactly one byte longer than the selected prefix. The maximum case uses the
permitted length, not an oversized declaration, and withholds trailing JSON
whitespace: parseable partial JSON must not bypass the exact frame-length check.
Python closes its socket after the selected
send; Node waits for local write finish, destroys the socket and waits for local
close. Errors/watchdog expiry are not successful disconnect completion.

The existing frame reader has an optional byte-count observation hook at actual
successful receives, disabled by default. The broker requires exactly
0/1/2/3/4/7 bytes, the ordinary UTF-8 body length plus three, then 8,195 bytes,
in order, and the specific `Truncated frame` exception for each rejected
connection. Each rejection must leave cumulative source-entry/send-attempt
counts unchanged at its pair index; the following recovery must increment
both exactly once and return exact inventory. The launcher independently checks
all sixteen recovery records and the alternating rejection/recovery event order.
Other errors or unexpected complete frames fail.
After the eight full-close boundaries, the same prefixes run in write-half-close
mode: Python uses write shutdown and Node ends its writable side while retaining
the readable side. Both require zero-byte EOF before local close, without accepting
a timeout, transport reset or response bytes. Every half-close rejection also
requires immediate exact-inventory recovery. The expected byte-count sequence
therefore repeats once.
Every recovery source returns a copied observation whose synthetic `notAfter`
is the shared baseline plus its one-based source-entry count. Independently
indexed Python and Node clients require that exact inventory, and the launcher
checks each recovery event's expiry. A previous successful response cannot pass
as a later recovery. The shared corpus is not mutated.
Final evidence requires sixteen expected rejections, sixteen source entries and
sixteen response attempts, thirty-two authenticated kernel peers,
explicit Python/Node completion and approved maps with distinct broker/client
PID/mount namespaces. Runtime restrictions and ownership-checked cleanup are
unchanged; no extra mount, signal or wire action is added.

This proves bounded handling of early framing disconnects, not disconnect
detection during a blocked source or differentiation of full peer close from
the protocol's required write half-close after a complete request.

The terminal-contention follow-up starts another isolated broker using an opt-in
mode of the existing concurrent fixture. The first approved request enters a held
inventory source. A fresh competitor is denied; then parent `SIGUSR2` starts a
cancellation thread waiting at a two-party barrier with the real five-second
deadline timer. The barrier has an eight-second watchdog. Both callbacks contend
for the existing lifetime lock; neither reason is selected in advance.
Both Python and Node clients require the old request to end with zero response
bytes. Structured evidence must show exactly one winner, one no-op loser, stable
reason/counters, zero send attempts and a locked slot, at five to under eight
elapsed seconds. A second fresh competitor is denied after both callbacks finish.
Parent `SIGUSR1` then releases only the held test source. Its late inventory
(`notAfter` baseline plus one) must settle, be discarded and release the slot in
that order. The final fresh client independently requires exact inventory with
baseline plus two, and one send attempt.

Final evidence requires two source entries, two capacity denials, one terminal
outcome, no request timeout or source failure, two slot releases, four kernel
peers and explicit client-runtime completion. All existing identity, namespace,
resource and ownership-checked cleanup restrictions remain.

The next terminal-ordering batch repeats that case with an explicit
cancellation-first schedule. After the common barrier, the deadline contender
waits up to three seconds for cancellation to finish. The existing terminal
callback must select cancellation, and the real timer callback must preserve its
reason/counters. This is controlled schedule coverage, not a claim that an
unforced run happened to select both winners.

Four further isolated broker instances exercise a settled inventory result
competing with a terminal action:

1. **Response before cancellation:** both contenders meet at a barrier; the
   callback waits for the response path to finish. Exact baseline-plus-one
   inventory is delivered before five seconds, with cancellation a no-op.
2. **Cancellation before response:** after the barrier, delivery waits for the
   callback. The ready result is discarded with no send attempt and zero-byte EOF.
3. **Deadline before response:** the ready result meets the actual five-second
   timer at a barrier, then waits for timeout to win. No response is attempted.
4. **Completed response before deadline:** delivery completes before five
   seconds, but the fixture keeps the lifetime/slot until the real timer fires.
   Successful completion must prevent a timeout outcome.

Each uses a complete request and one actual source entry. A fresh competitor is
denied while delivery is paused; after both actions are observed, exactly one
winning action, correct elapsed-time bounds, send/terminal counters and locked
slot must be recorded before release. There are exactly two slot releases, three
authenticated client containers and a final fresh inventory with baseline plus
two. Both Python and Node clients independently require exact inventory or
zero-byte EOF according to schedule; transport errors, partial responses and
watchdog expiry are not success.

The response path previously checked terminal state and sent outside the lifetime
lock. The shared test fixture now checks state/deadline, sends and records
successful completion under that lock; terminal callbacks reject completion as
already final. Writes retain the remaining socket deadline. This is a coupled
fixture correction, not a production implementation or a slow-writer proof.
Default lifecycle/control regressions must preserve their existing results.

This completes the bounded terminal-ordering batch, not arbitrary scheduling,
simultaneous duplicate cancellation, partial-write interruption or production
cancellation policy. The blocked-source peer-disconnect batch is described below;
slow/non-reading-client handling is the final planned experiment batch below. No production runtime
or privileged operation is selected.

The blocked-source peer-disconnect batch uses an opt-in Linux `poll` watcher in
another isolated broker instance. It starts only after the actual frame reader
has validated the full request and write EOF and the first inventory source has
entered. `POLLRDHUP` without `POLLHUP` must be observed as nonterminal half-close:
one source, zero responses, zero terminal counts, with the slot locked.
The watcher then removes read-hangup interest to avoid a persistent-EOF busy loop;
it does not read from the socket or alter framing. A fresh competitor must be denied.

The held client sends a runtime-specific marker after writing and half-closing;
the Node marker is emitted by TypeScript itself through the wrapper's inherited
stdout. The parent verifies that marker before explicitly killing only the owned
client container. Exit 137 is required; this intentional process death has no
normal successful client-completion record. The broker must observe real
`POLLHUP` and invoke the existing terminal callback, producing one peer-disconnect
outcome, zero timeout/cancellation outcomes and no send attempt before the
five-second connection deadline. Parent kill dispatch through hangup observation
must take under three seconds. Poll errors or invalid descriptors are failures,
not accepted proxies for full peer loss.

A fresh competitor is denied again after disconnect. Parent `SIGUSR1` releases
only the test source. Its baseline-plus-one result must settle, be discarded with
zero send attempts and then release the slot. The final fresh read independently
requires baseline-plus-two inventory. Final evidence requires two sources, two
capacity denials, one peer disconnect, zero request timeouts/source failures and
two releases. The watcher is stopped/joined before slot release. All four clients,
including the killed one, require mapped kernel identity and separate namespace
evidence; the other three require explicit runtime completion. Existing resource
limits, signals and ownership-checked cleanup remain unchanged.

Both Python and Node clients pass this bounded Linux Unix-stream/container
disconnect case. It is not a production runtime choice or proof for other
transports/kernels, arbitrary disconnect/response interleavings, leaked duplicate
socket descriptors or remote network failure. The final planned experiment batch
is slow/non-reading-client response handling, described next.

The bounded writer batch starts two more isolated brokers, one for a slow reader
and one for a non-reading client. The first source produces baseline-plus-one
inventory and the fixture pads its valid JSON body to the permitted 32,768 bytes.
Including the four-byte header, the frame must be exactly 32,772 bytes. Only these
cases request a small `SO_SNDBUF` and require the actual kernel buffer to be smaller
than that frame. Initial nonblocking sends must reach real `BlockingIOError`
(`EAGAIN`) after sending strictly more than zero and less than the complete frame.
No backpressure is inferred merely from the requested buffer size or client delay.
The remainder uses `sendall` with the existing connection's remaining deadline,
not a fresh five-second write budget. Both portions count as one response attempt.

The slow reader pauses one second, then consumes approximately 512 bytes per
20 milliseconds; the Node socket's readable high-water mark is 512 bytes.
Each runtime requires exactly one complete frame, header length 32,768, EOF and
exact baseline-plus-one inventory. The broker must complete before five seconds
with no timeout. The non-reading client delays application reads for six seconds;
bounded initial Node buffering is allowed, but actual server backpressure and
write timeout remain mandatory. The socket's write deadline must expire at five
to under eight elapsed seconds. The existing terminal callback records one timeout,
not a request timeout or source failure. When client reads resume, the actual
Python frame reader and production TypeScript frame reader must reject the
partial response specifically as truncation. Reset/read timeout is not success.

A fresh competitor must be denied while each write is backpressured. Evidence
requires one response attempt, incomplete delivery on timeout, a locked slot
until write settlement and exactly two releases. The final fresh client must
receive baseline-plus-two inventory. Both cases require three authenticated peers,
explicit runtime completion, separate PID/mount namespaces and existing resource/
ownership-checked cleanup restrictions. The timed-out write has already sent
bytes; it is not classified as zero-byte suppression or retried.

The lifetime lock remains held during the bounded write. This batch proves
deadline-bounded settlement, not immediate owner cancellation during a blocked
send or atomic rollback of transmitted bytes. The writer-specific small buffer,
nonblocking prefill and padded response are opt-in test conditions; default
shared corpus/lifecycle expectations and production sources remain unchanged.

### 9.13 Read-only experiment closure review

The three bounded follow-up batches are complete for the approved Linux
default-map container topology:

| Batch | Closure evidence |
| --- | --- |
| Terminal orderings | Unforced contention, controlled cancellation winning, response/cancellation orderings, timeout-before-response and timer no-op after completed response; distinct fresh recovery. |
| Blocked-source peer loss | Required write half-close remains nonterminal; killed client produces full hangup before deadline, retained source capacity, late-result discard and distinct recovery. |
| Slow/non-reading clients | Measured partial-send `EAGAIN`; slow reader receives exact inventory, non-reader reaches write deadline and framing rejects the partial result; capacity and fresh inventory recover. |

Both Python and actual Node/TypeScript client modes pass, alongside the existing
shared conformance/lifecycle regressions. This closes the planned finite
experiment scope, not the first production acceptance gate. Do not continue
adding fixture variants without a concrete deployment need or observed defect.

Remaining limitations are explicit: arbitrary schedules, simultaneous duplicate
cancellation, immediate cancellation during blocking writes, other kernels/
transports, rootless/remapped namespaces, leaked descriptors and production
listener/rate-limit/supervision architecture. Unsupported namespace modes may
remain unsupported rather than expanding the experiment.

The next milestone was a separate production runtime/OS-identity integration
decision. The subsequent approval and first implementation are recorded in
section 9.14; this closure review alone selected no runtime.
PBX access, secret lifecycle, managed-file confinement/durability, mutation ledger,
live routing/dialog fences and independent expiry retain their separate approval
and acceptance gates.

### 9.14 Dedicated Python runtime: approved read-only implementation

On 23 October 2026, after experiment closure, the user selected
**Dedicated Python broker — approve unprivileged read-only implementation**.
This supersedes the earlier runtime-not-selected status for that scope only.
It does not approve PBX control, real secrets, mutation, deployment or privileged
adapters.

The first implementation is [local/broker/readback.py](./local/broker/readback.py),
independent of the experimental fixtures. `Binding` validates a protected
customer/epoch/principal and exact mapped worker UID/primary GID. `Broker.serve`
owns the Unix listener and accepted sockets; it obtains `SO_PEERCRED` before
reading any frame. PID is diagnostic only. Non-root Linux, zero effective
capabilities, default UID/GID maps, broker-owned non-symlink parent directory
mode 0750 and socket group matching the broker primary GID are required.
The published socket is 0660; existing paths are never removed to permit bind,
and cleanup checks the published device/inode/type before unlinking.

The implementation supports only inventory and generation readback with shared
limits, strict UTF-8, request EOF and exact schemas. `Source.inventory(event)` and
`Source.generation(id, event)` are explicit synchronous adapter boundaries.
Generation must return the module's `MISSING` sentinel for authoritative absence:
`None`, malformed data and exceptions must not become a successful missing result.
No concrete PBX/credential source, CLI service or Compose listener is installed.
An embedding caller supplies the protected binding, source, stop event and
readiness event; there is no injected-peer-identity network path.

One admission slot covers decoding, source work and sending. The five-second
monotonic deadline starts at accept. A bounded monitor observes full Linux
hangup, deadline or shutdown and signals adapter cancellation, without treating
mandatory write EOF as peer loss. Source work retains admission until it returns,
even after the socket is shut down; shutdown deliberately waits for settlement
rather than abandoning or replaying work. Writes use the remaining socket budget.
Terminal events can interrupt a send, so a partial frame is a failure, not a
rollback or successful response. Diagnostics use fixed messages and numeric peer
credentials, never request text or adapter exception contents.

[scripts/Test-PythonBroker.ps1](./scripts/Test-PythonBroker.ps1) runs the
implementation tests in the existing locally resolved proof image, with no
network, read-only mounts, resource limits and ownership-checked cleanup.
It runs all 36 shared request/framing and 28 source-output vectors against the
new module, plus binding, cancellation and source-failure tests. A real Linux
listener runs as UID 1101/GID 2100 with zero effective capabilities. Tests prove
foreign UID denial before source entry, duplicate-bind/live-path preservation,
deadline cancellation, capacity rejection before and after a held-source timeout,
source settlement, distinct Python and actual Node recovery, and socket cleanup.
The root test supervisor has only fixture setup/identity-switching capabilities;
the broker itself is not root.

The next implementation-level increment runs three independent real-listener
lifetimes: deadline, full peer loss and shutdown while a source remains held.
Each first verifies that mandatory request write half-close does not signal
source cancellation, then rejects an overlapping approved client. Peer loss uses
an explicitly killed worker process and requires cancellation in under three
seconds; deadline must not substitute for that outcome. A second approved client
remains excluded until source settlement. Both non-shutdown cases independently
require distinct Python and actual Node recovery reads.

Shutdown signals the broker stop event and must cancel the source and close the
client within three seconds. While the source still refuses to settle, the
broker process must remain alive and its socket pathname must remain published.
Only source release permits clean shutdown and socket removal; the final source
counter must remain one, proving no replay. Every lifetime captures fixed broker
diagnostics and requires exactly its intended terminal reason, one rejected
late result, the expected capacity/identity denials and no additional records.
The test module does not replace or instrument the runtime's socket/source logic.

Implementation-specific publication tests now cover four additional cases under
the real non-root broker UID: conflicting regular file, conflicting symlink,
replacement regular file at shutdown and replacement socket at shutdown.
Both startup conflicts must raise `EADDRINUSE` without readiness/source entry.
Exact device/inode, full mode and owner/group metadata must survive; regular-file
contents and symlink target/target metadata are independently checked.
The cleanup cases rename the original published socket aside, keeping its inode
alive, before installing a new object at the pathname. On stop, cleanup must raise
exactly `Broker socket changed; refusing cleanup`, leaving the replacement and
saved original unchanged. This avoids substituting inode reuse for a genuine
replacement. Only the test removes those explicitly owned paths afterward.
The same `Broker` instance must then start/stop successfully, proving that both
startup and cleanup failure release its serving guard. Every case requires zero
source entries. This is controlled publication evidence, not an arbitrary
filesystem-race, stale-socket recovery or managed-file-confinement proof.

The implementation source-failure follow-up uses one real authenticated listener
and eight fresh clients: inventory failure/recovery and generation
failure/recovery, each repeated with Python and the actual TypeScript client.
The adapter raises a fixture-only exception containing a sentinel detail on odd
calls, then returns valid output on the following even call. Failed reads must
end in zero-byte EOF; generation failure cannot be converted to `missing`.
Each recovery must return the exact expected inventory or `observed` generation.
The parent checks source counters after every request, requiring one new call
only to the selected operation, with final inventory/generation totals of four
each. No implicit retry or replay is permitted.

The test captures the implementation logger, not an emulated connection path.
All captured diagnostics must be exactly four fixed
`Broker read-only source failed` records. Exception details, tracebacks,
unexpected terminal outcomes and capacity failures cannot pass as source-failure
evidence. The socket must be removed on clean stop. This adds implementation
coverage without changing runtime behaviour or wiring a real source adapter.

The authenticated-listener corpus follow-up now runs all 36 request/framing
vectors independently with Python and actual Node clients against the
implementation listener: 72 fresh corpus connections, plus a fresh inventory
recovery after each runtime. This complements, rather than replaces, the direct
decoder/source-output tests. No test identity is injected into the listener;
clients run as the authorised UID/primary GID and the broker performs its real
accepted-socket credential check.

Per-request source counters must remain unchanged for every rejection and
increment exactly once for every valid request. Successful complete responses
must equal the shared expected values. Delayed-EOF requests must not receive a
response before EOF. Only the specifically named concatenated-valid-request
case accepts a read-side connection reset as an alternative to zero-byte EOF;
other transport failures cannot pass. The broker's captured diagnostics must
be exactly the expected number of fixed connection-rejection messages, excluding
unexpected source/terminal/capacity outcomes. Clean shutdown removes the socket.
This is implementation-specific same-container integration, not a claim that the
experimental separate-container proof automatically covers this runtime.

The authenticated corpus harness additionally runs all 28 shared source-output
cases with Python and actual Node clients (56 fresh corpus connections, plus a
fresh inventory read after each runtime). A protected test-process selector
chooses adapter output, not customer/authority or a new wire field. Both source
operations verify that the selected corpus kind matches the operation requested.
The selector is reset before recovery so stale invalid output cannot be silently
reused as the recovery source.

Every source-output request is valid and must enter exactly once, including
invalid outputs. Rejected values must produce zero response bytes; valid values
must equal the complete expected inventory or observation. Covered shapes include
100/101 inventory entries, duplicates, unsafe numbers, extra fields and null/
malformed observations. Captured diagnostics must equal the exact invalid-case
count, using only fixed connection-rejection messages; no source exception,
terminal event, capacity denial or missing-state fallback may pass. This reuses
the authenticated request-corpus harness without changing runtime code.

The first implementation-specific separate-container check is
[scripts/Test-PythonBrokerContainers.ps1](./scripts/Test-PythonBrokerContainers.ps1).
It uses the existing image resolved locally to its immutable ID; it never builds
or pulls implicitly. A temporary owner-labelled volume contains the broker-owned
0750 directory. Setup alone receives CHOWN; the actual broker UID 1101/GID 2100
and all seven clients run capability-free with network none, read-only root,
no-new-privileges, pids 16, memory 96 MiB and one CPU. Client socket-volume mounts
are read-only.

Python and actual Node foreign-UID clients must receive zero-byte EOF; a worker
with primary GID 2101 and supplementary GID 2100 must likewise be rejected.
Approved Python inventory and typed Node generation, authoritative
missing-generation and inventory reads require exact responses. The same actual module owns every accepted socket and performs kernel
identity lookup; no fixture server or supplied peer identity is substituted.
Final counts require exactly four source calls and three fixed peer-denial
diagnostics. The diagnostic PID must be zero for sibling namespace peers, while
UID/primary GID remain exact authorization inputs.

The launcher requires default maps and matching user namespace, separate
broker/client PID and mount namespaces, exact UID/GID/group sets and explicit
Python/Node completion. Parent `SIGUSR1` is a private fixture stop event, not a wire
operation. The fixture must return cleanly and verify socket removal before its
completion record. Exact named/labelled resources are cleaned on success/failure;
no unrelated containers or volumes are touched.

This establishes focused implementation-topology evidence only. It does not
inherit the old fixture's entire separate-container corpus, blocked-source or
terminal-schedule coverage, and is not production packaging/supervision.

This is the first implementation slice, not inherited production certification
from fixture tests. Broader separate-container lifecycle, terminal-schedule,
blocked-write and filesystem-race checks still need implementation-specific evidence before
deployment. The real-process peer-loss and draining-shutdown cases above
are covered, but are not separate-container or arbitrary-schedule proofs. The
focused separate-container readback/denial/shutdown check above covers only its
explicit topology and operations.
Existing fixture results do not automatically cover the new
code. Production packaging/supervision and a concrete read-only source adapter
remain next integration work; real-source authority and privileged gates remain
separately approved.

The next integration increment introduces a test-only concrete source bridge,
`tests/identity/fake-broker-source.py`, for the synthetic database written by
`fake-provisioning-runtime.ts`. It is not installed in the production broker.
Each call opens SQLite in URI `mode=ro`, sets `query_only`, and checks exactly one
matching customer/epoch binding in the same read transaction as its query.
Inventory is bounded and validated; generation output uses the existing Python
observation validator. Cancellation is checked before connection and after the
read, with a SQLite progress handler for query interruption and a bounded busy
timeout. There is no schema creation or mutation API. Missing generations fail
like the existing fake runtime rather than returning authoritative absence.

`tests/python-broker-source.test.ts` uses the real TypeScript runtime to produce
prepared, active, draining and removed state, including live and unknown dialog
counts. It invokes the actual Python protocol encoder with the concrete reader
and compares inventory/observation to TypeScript expiry results after each state
change. Successful and rejected reads leave database bytes, directory entries
and effect counts unchanged. The reader's connection must reject a write with
`SQLITE_READONLY`; wrong epoch, absent database/generation, corrupt state and
pre-cancellation fail explicitly. The ordinary implementation launcher runs this
cross-runtime test in Linux before the existing listener suite; it can also run
locally with Python 3 and Node.

The subsequent integration wires that concrete synthetic source through the
actual Python authenticated listener under Linux. At each of five snapshots
(prepared, active with a dialog, active with unknown dialogs, draining, removed),
Python and actual Node clients each exercise foreign UID, wrong epoch, inventory,
generation, absent generation and fresh inventory recovery. Each client also
reads inventory and generation while a separate SQLite connection holds
`BEGIN IMMEDIATE` with a staged wrong epoch and invalid generation phase. The
writer verifies its own staged values; the broker must still return the exact
committed inventory/observation. The writer rolls back, takes `BEGIN EXCLUSIVE`,
and both reads must fail with zero response bytes and the fixed
`Broker read-only source failed` diagnostic. The harness requires exact
`SQLITE_BUSY`, no cancellation, and source execution lasting at least 0.2 and
less than 2 seconds around the configured 250 ms busy timeout; deadline failure
cannot substitute for the expected lock outcome. After rollback, both reads
must recover through the same listener without restart.

Full responses must
match the TypeScript source and database bytes/file list/effect counts must stay
unchanged. The 120 connections require exactly 100 source calls and 50 expected
diagnostics, including 20 exact lock failures and excluding capacity, deadline
or hidden source failures. Wrong peers
and wrong request scope enter no source; absent generations close with zero
response bytes rather than inventing authoritative missing state.

The Linux launcher enables this path explicitly with
`ASTERISK_SYNTHETIC_LISTENER_PROOF=1`; the ordinary local test retains direct
cross-runtime coverage on Windows. The test-owned root supervisor assigns a
separate read-only database group to the capability-free broker, not the worker
clients. It restores fixture permissions and requires clean listener exit and
socket removal at each snapshot. The task limit rises from 32 to 64 for nested
Node/Python runtimes; network, capabilities, read-only root and other limits are
unchanged. No runtime module, live adapter or deployed service is changed.

This is same-container synthetic-source integration, not live PBX integration or
separate-container database deployment. The fixture uses the fake runtime's default
rollback journal. Only the explicit reserved/exclusive writer schedules above
are established; concurrent commits inside a read snapshot, WAL/shared-memory behavior, source-path
deployment policy and production packaging are not certified. Those remain
separate integration decisions, not permission to access real PBX state.

The read-only consumer boundary now has a reusable TypeScript implementation,
`src/agent-broker-client.ts`, returning the existing `BrokerReadbackSource`
interface. It pins a detached validated customer/epoch/principal binding and an
absolute local socket path; principal is never put on the wire. Each operation
owns one fresh half-open socket with a single five-second connect/write/read/EOF
budget and caller cancellation. One client rejects overlapping calls, propagates
errors explicitly and never retries, replays or substitutes an empty inventory.
It validates exact response keys, scope, action and generation ID before using
the shared expiry validators. Only exact authoritative missing responses map to
`undefined`; EOF, truncation and source failure remain errors.

Binding validation is shared with the existing TypeScript server readback rather
than copied. The synthetic source integration now uses this typed client for
Node inventory/generation requests, including expected rejections, writer locks
and fresh recovery. Dedicated Linux Unix-socket tests cover malformed and
mis-correlated responses, absent generations, connect failure, cancellation,
overlap, detached binding and a real five-second deadline when a valid response
frame lacks EOF. The existing implementation launcher runs those tests; the
Unix-socket behavior cases explicitly skip non-Linux hosts because Windows
named pipes do not preserve mandatory write-half-close semantics.

This client adds no worker/application wiring or privileged operation. Protected
socket publication and server authority are caller prerequisites, not proved by
an echoed customer/epoch. Production source installation, deployment supervision
and live-source authority remain gated.

The separate-container implementation launcher now routes its approved Node
operations through the reusable typed client as well. Completion records
explicitly distinguish typed operations from raw denied-peer/Python probes.
Observed generation, authoritative missing generation, then fresh inventory
must match exact expected results through the same live broker; no retries or
server restart substitute for recovery. The seven clients retain the existing
capability, namespace/map, UID/primary-GID and read-only socket-volume assertions,
with four source calls and three exact cross-namespace denials. This establishes
typed-consumer topology evidence with the existing in-memory fixture, not
separate-container SQLite publication, production supervision or PBX access.

### 9.15 Live read-only source authority contract (design only)

The synthetic path is now connected from typed consumer through authenticated
Python listener to read-only fake SQLite state. Stop expanding that fixture as
a substitute for choosing real state authority. This section defines the next
integration boundary; it does not approve PBX access, credentials, new AMI
permissions, a deployed broker or any mutation.

#### Existing evidence and why it is insufficient

| Existing component | What it establishes | What it cannot establish |
| --- | --- | --- |
| `src/pbx-status.ts` | Customer-pinned reporting of core status and endpoint list fields, including endpoint active-channel counts and contact presence. | Generation identity, stored generation deadline, verified new-call fence, complete generation dialog ownership or removal of all managed objects. |
| `tests/identity/fake-provisioning-runtime.ts` | Synthetic generation/deadline lifecycle and simulated dialogs in a customer/epoch-pinned database. | Actual loaded PBX configuration, routing, authentication or live dialogs. |
| Provisioning command/receipt journals | Recorded intent and execution/recovery evidence under their existing contracts. | That the current PBX still matches a prior receipt, or that a missing row proves absence at runtime. |
| `local/broker/readback.py` and typed client | Scoped, bounded, validated read-only transport with exact mapped worker UID/primary GID enforcement. | Truth or freshness of the source, or server authentication merely because a response echoes scope. |

Do not adapt `PbxEndpoint.activeChannels` directly into `dialogs`. In particular,
an endpoint ID is not currently a protected generation mapping, and zero in that
report is not evidence that every relevant dialog is absent. Contact absence,
device state and expiry of a desired lease likewise do not verify a new-call
fence. No existing reporting account should gain control permissions to bridge
these gaps.

#### Proposed customer-local authority split

The proposed source composes two inputs inside the customer-local boundary:

1. **Protected generation ledger/model authority.** Supplies the enrolled
   customer/epoch, managed namespace, immutable generation-to-runtime-object
   mapping, committed deadline and latched drain intent. It must distinguish a
   healthy, initialized empty inventory from missing/unreadable/restored state.
   The fake database is not a production ledger, and the worker's requested
   extension or current receipt must not select arbitrary PBX object names.
2. **Verified runtime observation authority.** Supplies bounded observations of
   the exact mapped managed objects, relevant new-call routing/authentication
   fence and generation-correlated dialogs. Its concrete access mechanism,
   complete-observation guarantees and privileges are not yet selected.

This is a logical separation, not approval for another service or IPC protocol.
Prefer an existing protected customer-local owner if it can meet the contract.
Do not create a writable snapshot publisher or grant the network worker direct
PBX/database access merely to avoid selecting the actual owner.

Read operations must never load configuration, reload, fence, revoke, repair,
mint credentials or renew a deadline. Evidence collection may fail; failure is
not permission to perform a corrective operation. No query selectors, file
paths, CLI strings, credentials or runtime object names come from broker JSON.

#### Meaning of each current wire result

| Result | Required authority/evidence | Fail-closed outcome |
| --- | --- | --- |
| Inventory item | Ledger-pinned generation UUID and positive committed deadline, with a durable drain state appropriate to the existing expiry contract. Enumerate the complete pinned managed inventory without silently dropping uncertain entries. | Reject the operation if binding, completeness, deadline or inventory validity cannot be established; never return a partial/empty success or truncate at 100. |
| `newCallsBlocked: true` | Runtime verification of the actual generation-specific new-call fence covering the relevant routing/authentication surfaces, not only ledger drain intent. | Reject if fence evidence is absent/contradictory; a known verified open fence may be returned as `false`, which is not permission to activate. |
| Numeric `dialogs` | A complete, current, generation-correlated observation with defined consistency across relevant runtime objects. Zero requires the same completeness as a positive count. | Use `"unknown"` only when scope and the other returned fields remain authoritative but dialog completeness is not established; otherwise reject the observation. Never use zero as a default. |
| `removed: true` | Verified absence of all mapped managed runtime surfaces required by the eventual removal contract, including retained access that could still permit new calls. | A deleted ledger row, absent endpoint report or successful reload is insufficient. Partial or contradictory evidence fails, rather than inventing removal. |
| Generation `state: "missing"` | An authoritative, complete lookup proving no such generation in the pinned namespace, with reconciliation rules excluding untracked runtime remnants. | Until such lookup/reconciliation exists, return an explicit source failure, as the fake source already does for absent rows. |

The production mapping for inventory `draining` remains a required decision:
the fake runtime equates its durable phase with an effective fence, while a real
ledger's drain intent alone cannot prove PBX enforcement. The chosen source must
document whether this field denotes a durable irreversible drain latch or a
verified runtime state, and ensure the expiry consumer cannot mistake intent
for an already verified fence. Do not silently change the wire meaning during
adapter implementation.

#### Consistency and failure rules

- Pin and validate customer, epoch and managed namespace from protected
  configuration on every operation. Authority replacement/restored state needs
  an explicit reconciliation decision; it must not look like an initialized
  empty database.
- Bind ledger evidence to the runtime instance and generation/object revision
  being observed. A PBX restart, concurrent reload, generation replacement,
  partial event list or uncertain correlation invalidates the affected
  observation unless the authority can prove a consistent result.
- Collect within the existing five-second connection budget and retain source
  ownership until actual settlement. Do not cache a prior positive result to
  hide timeout, disconnection or source errors. SQLite lock recovery evidence
  does not establish consistency with a live PBX.
- A wire response is a point-in-time observation, never an execution lease or
  authorisation to mutate. Any future removal must independently reverify the
  fence and zero-dialog condition under its own protected execution boundary;
  a previously returned zero can become stale.
- Preserve fixed safe diagnostics. Do not expose AMI credentials, rendered
  authentication configuration, source exception details or caller-sensitive
  channel metadata in broker replies/logs.

The current response schema carries no runtime-instance, revision or freshness
token. Keep the existing protocol for the synthetic path. Before live
implementation, decide whether consistency can be enforced wholly inside one
source call or needs a separately reviewed protocol version. Do not add optional
fields that the current exact-key clients would reject.

#### Decisions required before live adapter implementation

1. Name the protected customer-local generation ledger/model owner and its
   schema, initialization/restore policy and read-only access boundary.
2. Select the runtime observation mechanism and exact allowed read operations;
   prove their generation mapping and completeness without broadening the
   existing reporting account or exposing control sockets to the worker.
3. Define effective fencing, dialog ownership and managed-object removal
   evidence for the selected Asterisk deployment, including restart and
   concurrent-state-change handling.
4. Resolve inventory drain semantics and whether the current v1 response is
   sufficient for the chosen consistency design.
5. Approve only then a bounded live read-only integration with synthetic
   credentials/state first. Production packaging/supervision and real access
   remain separate approvals; independent expiry and all mutation gates remain
   open.

Acceptance should cover one real generation end to end: exact inventory and
observation, an uncertain dialog result that never becomes zero, explicit
failure for stale/mismatched authority, no unrelated managed/base-object access,
and proof that reads cause no PBX effects. This is the next meaningful source
integration milestone, not a requirement to repeat the closed transport fixture
programme.

### 9.16 Broker-owned metadata ledger foundation (approved local implementation)

The user selected a broker-owned SQLite ledger for a metadata-only local
foundation, rather than an unspecified existing authority. This approves neither
PBX provisioning nor credential storage, deployment or interpretation of ledger
intent as verified runtime truth.

`local/broker/ledger.py` now provides explicit `initialize_ledger`, validated
`LedgerBinding` (customer, epoch, managed namespace) and a `Ledger` interface.
Bootstrap exclusively creates a new database path with mode 0600 on Linux; an
existing file is never automatically initialized, migrated or replaced. A
failed bootstrap remains for explicit investigation. Ordinary opens require an
existing regular single-link database under an absolute canonical parent and
SQLite schema version 1. Every operation rechecks exactly one matching binding
inside its transaction; missing state, mismatched scope, unknown schema and lock
errors propagate rather than becoming an empty inventory.

The only stored generation fields are lowercase generation UUID and positive
safe-integer deadline. Local `record` is immutable and idempotent for the exact
same pair; a changed deadline conflicts. `records` is an internal metadata list,
not protocol inventory. There are no extension, secret, runtime object, phase,
drain, dialog or removal fields. No deadline extension, deletion, PBX effect,
wire mutation or readback `Source` implementation is introduced. A recorded
generation is not evidence that it exists in Asterisk; an empty ledger is not
evidence that runtime remnants are absent.

Transactions use SQLite `synchronous=FULL`, a 250 ms lock timeout and
`BEGIN IMMEDIATE` for binding/record consistency. The foundation uses serialized
local metadata access, not a read-only database role or lock-free reader API.
The database belongs in a protected broker-owned directory; canonical path and
single-link checks do not certify resistance to concurrent path replacement.
Power-loss/filesystem durability, restore detection, schema migration,
operation identity/revisions, live object mapping and production publication
policy remain unimplemented. In particular, a structurally valid restored
database with matching binding is not detected by these checks.

`tests/identity/broker-ledger-proof.py` verifies explicit bootstrap, reopen
persistence, exact idempotence/conflict, customer/epoch/namespace isolation,
per-operation binding revalidation, invalid metadata, uninitialized/unknown
schema rejection and exact SQLite lock failure followed by recovery. The Linux
launcher runs these checks as non-root UID 1101/GID 2100 with zero effective
capabilities before the existing broker/client/source suite; local Windows
checks cover portable SQLite behavior but not Unix file permissions.

Next source-authority decisions remain runtime observation mechanism, protected
generation-to-object mapping, drain semantics and consistency/restart evidence
from section 9.15. This ledger does not bypass those gates.

### 9.17 Dedicated AMI observation contract assessment (design only)

The user approved design and verification of a dedicated customer-local
read-only AMI observation contract. No account, credential, manager permission,
network connection or deployment is created by this assessment. The existing
reporting integration stays unchanged.

#### Version and evidence

The repository's `compose.status-proof.yaml` pins Asterisk **22.11.0**. The
following assessment checks that exact upstream tag, not just current branch
documentation:

- [AMI action registration and authorization](https://github.com/asterisk/asterisk/blob/22.11.0/main/manager.c):
  `process_message` checks the account's action permission mask against an
  action's registered authority, accepting a matching bit. `action_coreshowchannels`
  emits a channel-cache listing and a completion event.
- [PJSIP query registration/implementation](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip/pjsip_configuration.c):
  `PJSIPShowEndpoints` and `PJSIPShowEndpoint` require `system` action authority.
  Endpoint details delegate to associated-object formatters.
- [Version-pinned manager configuration guidance](https://github.com/asterisk/asterisk/blob/22.11.0/configs/samples/manager.conf.sample):
  `read` governs asynchronous events in general; `write` permits actions and
  responses. These names do not divide queries from mutations.
- [Endpoint-detail action documentation](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/AMI_Actions/PJSIPShowEndpoint/)
  and [AuthDetail event documentation](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/AMI_Events/AuthDetail/):
  endpoint details include associated authentication events whose schema contains
  credential-bearing fields. These documentation pages follow branch 22 and are
  not proof of exact field availability/redaction in every 22.11.0 build.
- [CoreShowChannel event fields](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/AMI_Events/CoreShowChannel/):
  channel identity, linked identity and call metadata are not a generation UUID
  or SIP-dialog completeness certificate.

This is source/documentation verification, not a running-PBX acceptance test.
The deployed build, modules and effective permissions would still need separate
verification before any access is approved.

#### Candidate actions and authority limits

| Candidate | 22.11.0 action authority | Possible evidence | Why it is not the live source contract yet |
| --- | --- | --- | --- |
| `CoreStatus` | `system` or `reporting` | Core status/restart hints. | No ledger epoch, generation revision, fence or dialog correlation; a reported start time is not an enrolled runtime-instance identity. |
| `CoreShowChannels` | `system` or `reporting` | Listed channel IDs, linked IDs and related state. | Channels are not automatically SIP dialogs or generation-owned; the list is not an atomic snapshot across ledger, endpoint configuration and routing. |
| `PJSIPShowEndpoints` | `system` | Loaded endpoint summary and active-channel indicators. | Whole-PBX enumeration, not protected generation lookup. No generation deadline, complete dialog ownership or verified fence. In the tagged implementation, no endpoints yields an action error, not an authoritative empty managed inventory. |
| `PJSIPShowEndpoint` | `system` | Endpoint and associated-object details. | May expose authentication material and shared/base objects; cannot be approved as a secret-free read endpoint. Does not verify all routing/authentication fence surfaces. |

No proposed action alone establishes `newCallsBlocked`, authoritative zero
dialogs, managed-object removal or authoritative missing-generation state.
Completion event and matching item count establish framing/list accounting, not
that all relevant runtime state remained unchanged throughout collection.
The tagged channel-list implementation can skip an item when state-string
construction fails; its completion count covers emitted items, so count equality
alone cannot prove a zero-dialog observation is complete.

#### Permission result: direct AMI is not proven read-only

The 22.11.0 registrations grant `system` authority to endpoint queries but also
to control actions such as `Hangup`, `Reload` and `ModuleLoad`. The matching-bit
authorization check means these are not all-bits-required privilege combinations.
Even `reporting` is not an action-level read-only guarantee: `LoggerRotate`
accepts `system` or `reporting`. A new username with these classes would separate
credentials from the reporting account, but would not create an enforced
query-only capability.

Event filters control event selection, not a per-action permission allowlist;
they must not be offered as a fix for this action-authority gap. Likewise,
`Events: off` is not action authorization or a guarantee that action-associated
detail output cannot contain secrets. Restricting our client's code to query
strings limits normal behavior but does not reduce what compromised code with
the same AMI credentials could request.

Therefore **do not implement or configure direct AMI access for the broker under
the current unprivileged read-only approval**. No expansion of the existing
reporting account is proposed. This assessment does not claim that every AMI
query is unsafe; it establishes that the needed permission classes are not the
required least-authority boundary.

#### Proposed boundary requirements, not another approved service

If AMI remains the chosen underlying observer, a separately reviewed
customer-local enforcement mechanism must:

1. Expose only fixed, bounded generation observations derived from protected
   ledger mappings, with no raw AMI action, endpoint selector, channel metadata,
   configuration, credentials or transport access passed to the worker.
2. Enforce the permitted operation set outside the query client's own code.
   Any component holding broader AMI authority remains a higher-trust component
   requiring explicit approval, not a read-only component by naming convention.
3. Avoid credential-bearing endpoint-detail collection in the initial scope.
   Redaction after collection does not mean the collector never accessed secrets.
4. Define complete generation correlation and restart/reload/concurrent-change
   handling. Until verified, dialogs are unknown or the observation fails; no
   count or contact/device-state default becomes a verified zero/fence.
5. Fail closed on authentication failure, unexpected event/action sequence,
   missing completion, truncated/oversized lists, stale runtime binding,
   ambiguous ownership and collection deadline. Preserve safe fixed diagnostics
   and the existing source-slot settlement rule.

This does not select a generic AMI proxy or revive the rejected transport-helper
experiment. A purpose-built PBX-side fixed observation surface, an existing
operator-managed authority, or an explicitly approved higher-trust local
collector are architectural alternatives that require a decision before code.
Whichever is selected must prove actual fence/dialog evidence; permission
isolation alone cannot supply missing runtime semantics.

#### Next decision and bounded acceptance

Choose the enforcement/authority owner before implementing a live observer.
Direct broad-class AMI access is not the default. An operator-managed existing
fixed observation interface should be identified if one exists; otherwise review
the cost and trust boundary of a purpose-built PBX-side surface versus a
higher-trust local collector with enforced downstream fixed operations.

After a choice and access approval, acceptance should use an isolated synthetic
PBX and synthetic credentials: prove the exact allowed actions, denied
out-of-contract operations, no credential-bearing collection or output, complete
generation correlation, uncertain rather than fabricated zero dialogs, and
explicit restart/incomplete-list failure. No production account or customer
traffic is needed for that future proof.

### 9.18 PBX-side observation surface versus isolated collector (recommendation only)

The user requested this comparison and recommendation without access approval.
The runtime facts are those verified in section 9.17; the alternatives below are
design assessments, not claims that either component already exists or has
passed acceptance.

#### Alternatives

**A. Purpose-built PBX-side surface.** Add a narrowly defined observation
interface inside Asterisk, for example a reviewed module exposing only mapped
generation evidence. It would need explicit runtime hooks and consistency
semantics, not merely an AMI query wrapper. A new dialplan endpoint or custom
AMI action is not inherently a complete observation authority.

**B. Isolated higher-trust collector.** A separate customer-local process owns
any approved PBX observation credentials/access and exports fixed, sanitized,
generation-bound evidence to the Python broker. The network worker has no route
or credentials to the collector/PBX. This adds a source-authority boundary behind
the approved Python broker; it does not replace the broker or revisit the
closed socket-identity runtime experiment.

| Criterion | PBX-side surface | Isolated collector |
| --- | --- | --- |
| Authority exposed to the consumer | Can expose only custom fixed operations without giving the consumer generic AMI authority, if authentication/dispatch are implemented correctly. | Can expose only fixed downstream operations, but its own upstream AMI authority remains broader than read-only. |
| Compromise/failure impact | In-process faults can affect Asterisk availability; in-process compromise inherits PBX process authority. A custom API is not an Asterisk sandbox. | Process/resource isolation can protect broker/worker and reduce fault coupling, but collector compromise can exercise all authority of its AMI account. Separate containers do not remove that account's control permissions. |
| Generation ownership | Still requires protected ledger/runtime mapping; Asterisk does not inherently know the application's generation UUID/deadline. | Requires the same mapping and an enrolled runtime identity; cannot infer them from endpoint names or caller input. |
| Fence/dialog evidence | Could instrument relevant internal state, but endpoint, routing, authentication and dialog consistency must still be designed and proved. Proximity is not atomicity. | Limited by selected upstream observations. Current AMI query candidates do not establish the full fence/dialog contract. Must report uncertainty/failure rather than synthesize missing evidence. |
| Secret exposure | Can deliberately omit secret-bearing structures, subject to implementation review. | Must avoid credential-bearing detail queries entirely in the initial scope; downstream redaction does not erase upstream secret access. |
| Deployment/maintenance | Adds Asterisk build/module packaging, compatibility checks, upgrade testing and PBX restart/load policy. Exact ABI/build compatibility needs verification. | Adds one supervised local process, credentials lifecycle and another protected IPC boundary, but can be developed without a custom Asterisk build. |
| Consistency across state changes | Needs generation/model revision and runtime-instance handling across reload/restart even inside the PBX. | Needs explicit invalidation/reconciliation across disconnect, restart and concurrent reload; a sequence of AMI lists is not a transaction. |
| Immediate development value | High implementation commitment before mapping/fence semantics are settled. | A synthetic evidence producer can test authority binding and failure semantics without granting PBX access. It must not be presented as live integration. |

Neither alternative currently meets the live source acceptance contract. Neither
should be selected solely because it can return endpoint counts.

#### Recommendation

Prefer **B, an isolated higher-trust collector, as the next bounded design and
synthetic implementation candidate**, while keeping A as a contingency if the
required runtime evidence cannot be obtained through approved existing
interfaces. This minimizes early coupling to Asterisk internals and preserves
the already-tested worker-to-broker boundary. It does not establish that AMI
will ultimately be sufficient or least-authority enough for deployment.

The recommendation is conditional:

- The collector's broader AMI authority must be explicitly approved before any
  account, connection or synthetic-PBX access is configured. A fixed downstream
  API protects against broker/worker requests outside that API; it does **not**
  enforce query-only behavior after collector compromise.
- If policy requires that no new component hold AMI control-capable credentials,
  this collector design is unsuitable. Choose an existing constrained authority
  or investigate the PBX-side surface instead; do not hide a privileged proxy
  behind the word "read-only".
- Do not implement a generic AMI proxy, accept caller-chosen actions/object names,
  or add an upstream fallback. Missing evidence remains unavailable.
- If a bounded investigation cannot prove generation correlation and fence/
  dialog semantics, stop the AMI path. Evaluate narrowly scoped PBX-side
  instrumentation for the missing evidence rather than adding speculative
  queries or returning default values.

#### Proposed trust and data boundaries

```text
network worker --fixed reads--> Python broker --fixed evidence--> collector
                                  |                                |
                           protected ledger                 approved PBX access
```

The broker retains its customer/epoch/namespace-pinned ledger. The collector
receives only broker-derived, validated generation mapping references through
a separately authenticated local boundary; the wire caller cannot select PBX
objects. The mapping representation and its authoritative enrollment remain
design work. Do not copy a writable ledger into the worker or give the collector
unrestricted ledger mutation merely for convenience.

An internal evidence envelope should distinguish complete observation,
dialog-uncertain observation and unavailable evidence. It should bind scope,
generation/mapping revision, runtime instance and collection lifetime. Exact
fields, authentication, replay handling and cross-process freshness rules need
review before implementation; none are silently added to protocol v1.
An unavailable fence or removal fact cannot be filled from ledger intent, even
when dialog evidence is present. Keep `Source` failure until every required
returned field is justified. Do not add a cache that turns an old zero into a
fresh positive result.

#### Bounded next step and stop conditions

If this recommendation is approved, the next increment is a **synthetic internal
evidence contract only**: define binding/unknown/unavailable semantics and
exercise valid, mismatched, stale and incomplete evidence with no AMI package,
account, credentials, PBX connection or service deployment. Do not begin a second
large transport fixture programme or choose a collector runtime implicitly.

Then review the protected generation-to-object mapping and the precise missing
PBX evidence. Only after those decisions and separate access approval should a
small isolated-PBX feasibility proof be considered. Stop if the collector would
need forbidden secret queries, unapproved permissions, unprovable zero-dialog
assumptions or caller-selected runtime objects. A full deployment plan is not a
prerequisite for this comparison, and this recommendation approves no deployment.

### 9.19 Synthetic broker-side evidence validator (approved bounded implementation)

The user approved a Python broker-side evidence validator with synthetic tests
only. `local/broker/evidence.py` implements that boundary; it does not implement
the recommended collector, choose its runtime, add IPC or connect to a PBX.
There is no change to external broker protocol v1 or the installed source.

`EvidenceBinding` pins a validated ledger customer/epoch/namespace, generation
UUID, positive safe-integer mapping revision and runtime-instance UUID. These
are **broker-owned expectations**, not authority inferred from producer JSON.
Mapping revision and runtime enrollment are not yet persisted/implemented in
the metadata ledger. They must not be fabricated from endpoint names or a
collector echo when a real source is introduced.

Each `EvidenceRequest` generates a fresh UUID and starts a broker-local monotonic
lifetime. Its expected envelope contains exactly:

```text
version, customer, epoch, namespace, generationId,
mappingRevision, runtimeInstance, requestId, outcome
```

Successful outcomes additionally require exactly one `observation` field:

- `complete` requires the existing validated observation shape with numeric
  dialogs, not `"unknown"`.
- `dialogs-unknown` requires `"unknown"` dialogs while fence/removal fields
  remain asserted by the producer. It is never converted to zero.
- `unavailable` carries no observation/details and raises the fixed
  `EvidenceUnavailable` error. It cannot become `MISSING`, empty inventory or
  another success-shaped result.

`removed: true` additionally requires a blocked new-call fence and numeric zero
dialogs; contradictory or malformed results are rejected. A known open fence
can remain `false` with `removed: false`, not an activation permission.
Returned observations are detached from the supplied envelope.

Validation accepts only a locally measured elapsed lifetime in `[0, 5)` seconds,
an unset cancellation event, and a caller-supplied current binding equal to the
original expectation. Exact field sets and correlation IDs reject unexpected,
cross-generation or mismatched evidence. Every validation attempt consumes the
request, including rejected/unavailable/cancelled results; a lock protects this
single-use transition. A response for a different fresh request is rejected.
Lifetime boundary tests use the local clock seam rather than slow sleeps or
producer timestamps.

This is **correlation and structural validation, not authentication or proof of
truth**. A trusted producer that knows the expectation can still lie. No
cross-process clock synchronization, authenticated evidence transport, durable
anti-replay store, global epoch rollback detection or atomic authority-change
fence is implemented. The future caller must obtain/recheck current authority
under its actual ownership rules and fit evidence collection inside the
connection's existing remaining budget; creating a new evidence request must
not renew that budget. The helper itself neither collects nor waits for data.

`tests/identity/broker-evidence-proof.py` exercises complete/unknown/unavailable
results, exact field/schema checks, stale and negative elapsed times, the exact
five-second rejection boundary, changed runtime/mapping/epoch expectations,
cancelled and reused requests, cross-request correlation and contradictory
removal state. The ordinary Linux launcher runs it under non-root UID 1101/GID
2100 with zero effective capabilities, alongside the ledger and existing broker
regression. Portable Windows tests exercise the same pure validation logic.

Next work remains the protected generation-to-runtime-object mapping and
authority lifecycle contract, followed by a separately approved producer/access
decision. These synthetic envelopes do not demonstrate live fence or dialog
completeness and do not authorize a collector service.

### 9.20 Protected generation mapping and authority lifecycle (design only)

The user selected design of broker-derived per-generation runtime-object mapping
and authority lifecycle. This section specifies the intended next model; it
does not change ledger schema, render configuration, enroll a runtime, create
objects or approve PBX access.

#### Identity and deterministic object names

Use the complete validated tuple `(customer, epoch, namespace, generationId)`
as generation identity. A phone extension, device identifier, channel name,
contact address or newest lease lookup must never substitute for that tuple.
The generation UUID is already part of the provisioning command contract; the
broker derives runtime names only after scope/authority validation, not from
caller-supplied object names.

Proposed derivation version **1**:

1. Serialize the ordered string array
   `["agent-runtime-mapping", "1", customer, epoch, namespace, generationId]`
   as compact UTF-8 JSON with no whitespace. Inputs use the existing restricted
   ASCII slug/lowercase UUID formats, so escaping and Unicode normalization are
   not alternative encodings.
2. Compute lowercase full SHA-256 hex of those bytes, without truncation.
3. Derive endpoint `ag1-<digest>-e`, authentication `ag1-<digest>-a` and AOR
   `ag1-<digest>-r`. Each identifier is 70 ASCII bytes. These are proposed logical
   object names, not filenames, dial strings or authorization tokens.

Distinct role suffixes prevent cross-role reuse. Including customer, epoch and
namespace avoids intentional reuse across authorities; the digest does not
authenticate ownership or mathematically rule out collisions. Before enrollment,
the authority must reject duplicate names mapped to different tuples and any
existing object whose ownership cannot be verified. It must not adopt, overwrite
or delete an object merely because its name matches the prefix or digest.
Validate identifier compatibility against the exact selected Asterisk
configuration/rendering path before implementation; this design is not proof
that every deployment accepts these names.

Record the derivation version and exact object-name triple with the protected
generation metadata, then recompute and compare on every mapping load. A retry
must recover the exact same mapping. Object names contain no credentials; auth
secret generation/storage remains separately gated. Operator-owned transports,
base contexts, trunks and shared routing objects are excluded from this triple.
Any future managed routing fence requires its own explicit model and ownership
record, not a suffix silently added during configuration rendering.

#### Revisions and runtime instance are different authorities

| Identity | Intended scope and change rule |
| --- | --- |
| Controller `epoch` | Existing provisioned customer authority. A different epoch cannot adopt an old generation implicitly; replacement/restore requires explicit reconciliation. |
| Mapping derivation version | Naming algorithm compatibility, initially 1. It is not a counter and cannot change object names during a retry. |
| Mapping revision | Positive per-generation revision of the protected observation model, initially 1. Covers exact object associations and any later approved fence-model definition. Changes invalidate outstanding evidence; incompatible identity changes require a new generation rather than an in-place rename. |
| Desired command revision | Existing customer command ordering. Not interchangeable with mapping revision; a deadline-only renewal does not by itself rename objects or prove an observation-model change. |
| Runtime instance | Broker-enrolled identity of the PBX lifetime being observed, not the broker process, AMI connection or collector process. A PBX restart invalidates prior runtime evidence even if object names persist. |
| Evidence request ID | One broker-local collection attempt. Never reused as a generation, runtime identity, revision or execution authority. |

The existing metadata ledger cannot yet persist these additions or renew
deadlines. No migration or renewal is implied by this design. Future mapping
changes must commit atomically with their revision and ownership association;
readers must not combine a new revision with old names. Current mapping
expectations must be checked again when accepting evidence under the same
authority-coordination boundary, not simply echoed from the producer.

#### Enrollment and recovery rules

1. **Unenrolled:** no trusted PBX lifetime/model association. Ledger records may
   exist, but live observations fail unavailable; do not infer an empty runtime.
2. **Enrollment pending:** a separately approved customer-local authority checks
   the runtime identity, managed namespace and exact object ownership/model.
   It cannot bootstrap trust by accepting a collector's self-selected UUID.
   The mechanism for establishing a trustworthy PBX lifetime identity is still
   unresolved; AMI login success or a start-time string alone is insufficient.
3. **Bound for observation:** persist the enrolled runtime association and
   verified mapping revision. Observation requests capture those expectations.
   This state authorizes only evidence collection, not activation or mutation.
4. **Invalidated:** PBX restart, uncertain reconnect continuity, authority/epoch
   change, mapping change, interrupted reconciliation or conflicting runtime
   objects invalidate affected evidence immediately. An ordinary AMI reconnect
   neither proves a PBX restart nor proves continuity. Re-enrollment must resolve
   that uncertainty before fresh positive evidence is accepted.
5. **Broker/collector restart:** recover mappings without renaming objects.
   Discard in-memory evidence requests and cached observations; re-establish
   runtime continuity through the future protected enrollment mechanism. Never
   reset a deadline or erase drain intent as a restart side effect.

A restored ledger with a matching epoch is not detected by the current
foundation. Preventing rollback acceptance requires a separately selected
authority/restore mechanism outside an unverified restored database. Generating
a new local UUID after restore does not repair that trust problem.

#### Mapping is not observation

The triple identifies what to inspect, not whether objects are loaded, whether
new calls are blocked, or which SIP dialogs belong to the generation. Endpoint
name matching alone cannot prove dialog completeness after transfer, Local
channels, bridge changes or cached authentication. Do not count all channels
with a string prefix and label the result authoritative dialogs.

Until a separately approved fence model exists, `newCallsBlocked` cannot be
derived from this mapping or ledger. Unknown/partial ownership fails the
observation; absence of one mapped object is not `removed` or `missing`.
Retain ownership records through draining/removal uncertainty so stale objects
are not abandoned or silently assigned to a replacement generation. Mapping
design does not approve deletion or introduce a tombstone lifecycle.

#### Bounded implementation gate

The next proposed local increment, requiring approval, is a pure mapping
derivation/validation helper with deterministic vectors and collision/conflict
checks against synthetic records. No PBX adapter, new ledger schema, collector
runtime or enrollment mechanism should be smuggled into that helper.
Before persistence integration, specify an explicit schema migration and
transactional mapping ownership/revision rules; preserve rejection of unknown
schemas and never reinterpret an existing metadata database silently.

The live integration blockers remain concrete: runtime enrollment/continuity,
generation-correlated complete dialog evidence, effective fence semantics,
collector authority/access approval and protected publication/supervision.
Finishing deterministic naming will not close any of those gates by itself.

### 9.21 Pure generation mapping helper (synthetic implementation)

The bounded implementation follows the version-1 derivation in section 9.20.
`local/broker/mapping.py` derives the exact endpoint/auth/AOR triple, validates
an exact mapping record by recomputing it, and returns a detached result.
Version must be integer 1, not a boolean or float. Unknown fields, malformed
identity and modified role names are rejected rather than normalized.

`check_mapping_ownership` checks a supplied synthetic ownership-record list
and occupied-name set. Existing records must themselves match their derivation;
an occupied candidate name without an exact ownership record fails unverified.
Conflicting tuples sharing a name fail even in a forced digest-collision test.
An exact ownership record permits idempotent validation, not adoption or mutation
of a runtime object. Inputs are not modified, and unrelated names are not
returned as targets.

The caller must eventually supply complete, trusted, consistently captured
ownership evidence. This helper cannot authenticate records, enumerate a PBX,
detect omitted objects, establish model compatibility or prevent a race after
checking a snapshot. An empty synthetic set is not proof that a live namespace
is empty. Prefix or deterministic-name agreement is not ownership proof.
There is no ledger schema change, persistence, object creation, mapping
revision management, runtime enrollment, collector or PBX access.

`tests/identity/broker-mapping-proof.py` checks a fixed digest independently
computed with Node's SHA-256 over the specified compact JSON bytes, all identity
components, exact 70-byte role names, strict record validation, unverified
ownership rejection and forced digest collisions. The ordinary Linux launcher
runs the five tests as non-root with zero effective capabilities before the
existing broker regression; portable Windows checks cover the same pure logic.
Actual Asterisk object-name compatibility remains unverified.

### 9.22 Explicit ledger mapping migration (local metadata only)

The approved next increment integrates the pure mapping helper with the local
ledger. `migrate_ledger_mappings(path, binding)` explicitly upgrades schema 1 to
2 in one `BEGIN IMMEDIATE` transaction after validating customer/epoch/namespace.
It creates `broker_mappings`, derives a mapping for each valid existing
generation, and updates `user_version` only within the same transaction.
Existing generation UUID/deadline records are preserved. Ordinary opens do not
migrate; new bootstrap still creates schema 1, and mapping access requires the
explicit upgrade. Repeated migration, unknown schemas and mismatched bindings
fail rather than being treated as successful no-ops.

Schema 2 records derivation version 1, immutable mapping revision 1 and the exact
endpoint/auth/AOR triple per generation. Primary-key, role-name uniqueness and
foreign-key constraints protect associations on ledger-owned connections.
Version-2 `record` inserts metadata and mapping atomically; exact metadata retry
remains idempotent and changed deadlines still conflict. Mapping updates,
deadline renewals, deletion and revision advancement are not introduced.

Opening schema 2 and every metadata/mapping read or record operation validates
all existing generation/mapping associations in the transaction. Stored names
are recomputed against the pinned scope; missing mappings, orphan associations,
modified names or unsupported mapping revision fail explicitly. `records`
retains its existing generation/deadline result shape; `mappings` returns
detached exact mapping records with `mappingRevision`. This is an internal
metadata API, not protocol inventory or collector authority.

Nine ledger tests cover both schema versions, reopen persistence, explicit-only
migration, binding and lock rejection, exact mapping reads, corruption/missing
association rejection and atomic failure. A forced synthetic digest collision
must roll back migration DDL, inserted mappings and schema version together;
an insertion conflict after upgrade must leave no orphan generation metadata.
Recovery after those failures is tested. Windows and capability-free non-root
Linux exercise the same SQLite logic through the existing launcher.

This establishes transaction-level rollback/reopen behavior, not power-loss or
filesystem crash durability, safe online upgrades across old/new processes,
backup/restore detection or adversarial concurrent file replacement. There is
no deployed database to upgrade in this increment. Migration requires local
exclusive operational ownership; do not run an older process against a database
being upgraded. Production backup/upgrade policy remains a deployment gate.
Mapping persistence proves only the intended associations. Runtime enrollment,
actual object ownership/compatibility, fence/dialog evidence, collector access
and all PBX effects remain separately gated.

### 9.23 Runtime enrollment and continuity comparison (design only)

The user requested comparison and recommendation before implementation.
Schema-2 mappings establish intended names, not the identity of the running
Asterisk process. `EvidenceBinding.runtime_instance` remains a validated UUID
placeholder, not an implemented enrollment mechanism. No supervisor, lifecycle
control, PBX connection or new schema is introduced here.

| Option | Useful guarantee if correctly implemented | Limitations |
| --- | --- | --- |
| Operator-managed enrollment | Explicit approval of customer, namespace, runtime and managed model; suitable for an externally operated PBX. | A manual approval is not continuous process-lifetime evidence. Restart or uncertain continuity must invalidate it; automatic reconnection cannot silently reuse approval. |
| Trusted local lifecycle supervisor | Can associate an opaque runtime UUID with the actual child lifetime it owns and revoke that association when the child exits. | Requires ownership of the real PBX lifecycle, protected publication and binding of the collector's connection to that child. A watcher of a PID file/container name does not provide this guarantee. |
| AMI connection plus reported start time | Useful diagnostic/restart hint using existing status observations. | Insufficient as authority: login authenticates account access, not the enrolled process lifetime; timestamps do not establish continuity, anti-rollback or observation consistency. Not recommended as enrollment. |

**Recommendation:** use a trusted local lifecycle supervisor as the eventual
runtime identity authority **only for deployments in which this project is
explicitly approved to own the customer PBX lifecycle**. Use operator-managed
enrollment with explicit invalidation/reapproval for externally managed PBXs;
do not install a privileged watcher to simulate ownership. Neither option is
approved for implementation or deployment by this comparison.

The supervisor is a different responsibility from the proposed collector:
the former attests lifecycle/connection association, the latter collects runtime
facts under its approved access. They may eventually share a deployment owner,
but merging their privileges/processes is not assumed. The network worker and
read-only broker must not receive a Docker socket or lifecycle-control API.
The current compose fixtures have customer-separated services but are not an
enrollment authority or proof of production lifecycle ownership.

#### Minimum supervisor-backed contract

1. Establish a protected customer/epoch/namespace enrollment before starting
   observation. Issue an opaque UUID for each actual PBX process lifetime,
   not for each collector connection or container recreation alone. Do not
   reuse an identifier across child exits or uncertain supervisor recovery.
2. Track the real process through an owned process handle/lifetime mechanism
   supported by the eventual deployment. PID, PID-file contents, container
   name/ID, image digest and host start-time diagnostics alone are insufficient.
   A restart inside a container must invalidate the old association too.
3. Bind the collector's authenticated PBX connection to that enrolled child.
   A supervisor's observation of process A plus an AMI connection to process B
   is invalid even if both report the same customer/start time. Protected
   endpoint publication, connection handoff or equivalent association must be
   designed and proved; this comparison does not select one.
4. Supply an authenticated, fresh local continuity assertion for the observation
   interval. A readable file containing a UUID is not a liveness assertion.
   Missing authority, disconnect, child exit or uncertain connection association
   invalidates outstanding observations. Never return prior cached positives.
5. Coordinate validation with a monotonic local invalidation revision so a
   restart during collection cannot pass an old request against a reused
   binding. Bind both the initial and acceptance checks to the same authority
   lifecycle. A newly returned result is still only point-in-time evidence,
   never a mutation lease or a guarantee against a later process exit.

An AMI reconnect may retain the runtime identity only after the authority proves
the same child and the new connection's association. Otherwise enter invalidated
state and require reconciliation. A configuration reload may leave process
identity unchanged while invalidating mapping/model evidence; lifecycle
continuity cannot stand in for model consistency.

#### Recovery and external management

- Broker or collector restart discards requests/observations. Reload persisted
  mappings, then obtain fresh trusted runtime association before collection.
- Supervisor restart loses continuity unless the chosen lifecycle mechanism can
  prove ownership of the existing child and connection association. Otherwise
  mark unavailable; do not kill/restart the PBX as an observation-side repair.
- Host restart invalidates process association. A restored database with matching
  scope still requires independently verified authority enrollment/restore
  reconciliation. A fresh UUID does not detect restored authorization state.
- With operator-managed enrollment, require an explicit trusted enrollment
  record and an approved continuity source. If no such source exists, the
  current system cannot offer continuous authoritative runtime observations.
  Do not manufacture a time-to-live that turns manual approval into proof of
  current process identity.

No identity mechanism resolves complete generation dialogs, effective fencing
or removal evidence by itself. Those remain separate source requirements.
Independent expiry remains open; losing observation does not safely revoke PBX
access or authorize forced call termination.

#### Next decision, not another automatic implementation increment

Confirm whether the target deployment permits ownership of the actual Asterisk
lifecycle or must integrate with an externally managed PBX. That determines the
authority owner before a transport, supervisor runtime or persistence schema is
selected. Then specify the connection-to-process association and invalidation
boundary. A small synthetic lifecycle-state model can follow explicit approval,
but it must not be advertised as supervisor/PBX enrollment proof.

The milestone after that design is one isolated synthetic-PBX feasibility proof
with separately approved access, not more variations of the closed socket
fixture. Stop if lifecycle identity cannot be bound to the observation channel
or if the target deployment cannot supply a trusted continuity owner.

### 9.24 Project-owned lifecycle enrollment boundary (design only)

Proceeding with the recommended deployment-model default, this design targets
project-owned customer Asterisk lifecycles. The selection is a planning
assumption, not permission to start/stop a PBX, replace an entrypoint, grant
Docker access or deploy a supervisor. Externally managed PBXs are not supported
by automatic fallback; they require the separate authority integration in
section 9.23.

#### Existing launch path and proposed owner

`local/asterisk/start.sh` currently performs directory/log setup and then
`exec`s foreground Asterisk. The status fixture runs that entrypoint as
UID 1000/GID 999 with capabilities dropped. There is no supervisor, child
lifetime enrollment or authenticated continuity publisher in that path.
Do not treat the compose service name, image pin or foreground PID as an
implemented authority.

The proposed lifecycle authority lives inside the customer PBX deployment
boundary and owns the actual foreground Asterisk child, not a polling view of
a host Docker service. It would hold an owned child handle and issue a fresh
opaque runtime UUID for each launch attempt that reaches an enrolled lifetime.
Readiness remains separate from process existence. A replacement child always
gets a different UUID even if its PID, container or configuration is reused.
The runtime and process-handle mechanism are not selected by this design.

The authority must not expose start, stop, restart, shell or container-control
operations to the broker, collector or network worker. Lifecycle administration
belongs to a separately approved deployment owner. Observation failure must
never trigger automatic restart or call termination.

#### Connection association is an explicit unimplemented prerequisite

Prefer a customer-private observation listener established under the same
protected deployment authority as the child. Before enrollment, prove exclusive
endpoint ownership, authenticated server identity and that the listener belongs
to that child lifetime. Binding the client only to a host port or matching an
AMI-reported start time is insufficient.

The current published status-proof AMI ports and customer networks are existing
reporting fixtures, not this association proof. No new host publication or
credential scope is proposed. A specific protected listener/credential lifecycle
must be reviewed before code: neither private networking alone nor an otherwise
valid account binds a connection to an enrolled child.

If the chosen Asterisk access mechanism cannot demonstrate this association,
leave enrollment unavailable. Do not claim success by combining an owned child
handle with an independently selected AMI address.

#### Enrollment states and invalidation

| State | Permitted observation behavior | Required transition evidence |
| --- | --- | --- |
| Unenrolled | No positive runtime evidence. | Explicit protected customer/epoch/namespace configuration and lifecycle ownership. |
| Child starting | Process existence only; source remains unavailable. | Actual child handle plus fresh runtime UUID, not readiness by timeout/default. |
| Association pending | No positive generation result. | Proven connection-to-child association and managed mapping/model reconciliation. |
| Observation ready | Fixed evidence collection under the enrolled binding. | Live child, current association, current mapping and trusted continuity owner. |
| Invalidated | Reject pending/new positive evidence; retain metadata. | Child exit, authority loss, uncertain reconnect, mapping/model uncertainty or binding change. |

A child restart enters starting/pending with a new identity; a configuration
reload can invalidate model evidence without changing process identity.
Reconciliation is observation-only unless separately approved effects are
introduced. None of these states grants activation, renewal or revocation.

Use a local authority-session identifier and increasing invalidation revision
to prevent an ABA transition back to the same apparent binding from validating
an old observation. Capture them with the evidence request and compare them
again at acceptance under the authority's coordination lock. The current
`EvidenceRequest` compares `EvidenceBinding` only; it does not implement this
session/revision boundary. Do not claim that its synthetic tests establish
restart-race safety.

An authority-session restart invalidates every prior request even if the child
survives. A stored runtime UUID does not re-establish continuity. Fresh trusted
enrollment is required unless the eventual mechanism proves recovered child
ownership and connection association. Revision/session values must not be read
from an untrusted producer's echo as proof of current state.

#### Next bounded proof and remaining gates

After explicit approval, a synthetic in-process state model could exercise
starting/pending/ready/invalidation, session replacement and revision comparison.
It would take trusted lifecycle/association facts as inputs, never discover
them or grant them itself. No new ledger migration or external wire fields are
needed for that model.

Only a later, separately approved isolated-PBX proof can demonstrate real child
exit detection and connection association. Supervisor deployment, signal
forwarding/reaping policy, startup failure behavior and upgrade operations need
their own implementation review before replacing the current foreground launch
path. Independent expiry, collector permissions, effective fencing and complete
generation-dialog evidence remain open regardless of enrollment progress.

### 9.25 Synthetic authority-state and evidence coordination model

The user accepted the recommended bounded synthetic implementation scope.
`local/broker/authority.py` adds an in-process `ObservationAuthority` for one
generation's `EvidenceBinding`. It does not supervise or attest a process,
establish a connection association, implement collector IPC or change ledger
schema. Lifecycle and association facts are trusted caller assertions.

The model starts unenrolled. Explicit `start(binding)` enters starting;
`child_started()` enters association-pending; `association_verified(binding)`
enters ready only for the expected binding. Out-of-order transitions fail.
`invalidate()` clears the binding and prevents collection until the entire
sequence is performed again. Restarting an already-ready authority without
invalidation is rejected.

Each model instance owns a fresh session UUID and an increasing in-memory
revision. `begin()` is permitted only while ready and captures both alongside
a new `EvidenceRequest`. `accept()` checks the session, one-use collection state,
ready state and exact revision before invoking the existing evidence validator.
The same lock coordinates acceptance and invalidation, so an old collection
cannot survive an invalidation/re-enrollment ABA even when the binding is
identical. Cancellation, unavailable and malformed results consume the local
attempt rather than inviting reuse. Collections from another session are
rejected; tokens are internal trusted-process objects, not transport credentials.

Acceptance is linearized relative to local invalidation: if validation holds
the coordination lock first, it may return a point-in-time result before
invalidation takes effect. That does not prove the child is still alive when
the caller later uses the result, nor authorize mutation. Real exit detection
latency and ordering of trusted lifecycle callbacks remain responsibilities of
the future supervisor integration. The model neither verifies those callbacks
nor identifies which real child emitted them.

Four synthetic tests cover ordered/unavailable states, valid acceptance,
same-binding ABA rejection, replacement-session rejection, one-use failures,
cancellation and lock-coordinated acceptance/invalidation using thread barriers.
They run on Windows and capability-free non-root Linux through the existing
launcher, alongside the unchanged full broker regression.

This closes only the in-process stale-collection coordination gap. There is no
persistent enrollment, cross-process invalidation protocol, runtime liveness
proof or shared multi-generation authority fanout. A future real lifecycle
owner must invalidate every affected generation and supply the verified
connection association; this model does not create that owner. The next
meaningful gate is the separately approved isolated-PBX feasibility design and
access decision, not additional synthetic transition permutations.

### 9.26 Isolated-PBX lifecycle/connection feasibility plan (not execution approval)

The user accepted planning only for the next real-process feasibility question:
can an owned Asterisk child be associated with the exact observation connection,
and can its exit invalidate that association? No fixture is implemented or run
by this plan. No PBX access, credentials, lifecycle operations or accounts are
approved yet.

#### Reuse boundaries and concrete candidate

Reuse the pinned Asterisk 22.11.0 image reference and existing foreground launch
knowledge, not the running status fixture. `Test-PbxStatusProof.ps1` creates
reporting/system accounts, fixed host port publications and persistent customer
state; invoking it would exceed this plan. Do not modify its configurations,
accounts, compose resources or the ordinary `start.sh`.

Candidate: a disposable Linux container with a test-owned supervisor and
foreground Asterisk child in the same PID/network namespace, under the same
non-root UID and with capabilities dropped. The supervisor retains the actual
child process object and, if supported, a Linux pidfd for exit observation.
The pidfd is a lifetime handle, not proof of socket ownership or configuration.
Its acquisition/exit races must fail closed if the child has already exited.

Bind a synthetic AMI listener to literal loopback **inside** this private
namespace, with no host publication and no external network. A dedicated
ephemeral account would permit only the reviewed minimum class for `CoreStatus`,
with events disabled in the client. As section 9.17 establishes, even that class
is not an enforced read-only capability. Future approval must acknowledge the
test collector's broader account authority; the test will not exercise it.
No endpoint-detail query or SIP credential is needed for this question.

Proposed association check, to be verified rather than assumed available:

1. Retain the connected client's actual local/remote TCP tuple and socket
   lifetime. Do not reconnect inside an association attempt.
2. Locate the reverse **established connection**, not merely the listening port,
   in the namespace's kernel socket table. Require an unambiguous matching
   server socket inode.
3. Verify that inode among the owned Asterisk child's open socket descriptors,
   while checking the retained child lifetime handle before and after
   inspection. Do not accept a parent proxy's socket or another same-UID
   process's descriptor as equivalent.
4. Associate only that connection with the fresh runtime UUID, then repeat the
   association/lifetime checks around one bounded `CoreStatus` collection.
   Commit acceptance through the local authority coordination boundary only
   while no observed invalidation has intervened.

Kernel table/descriptor inspection is a candidate feasibility mechanism, not
an atomic socket-owner API or continuous attestation. Descriptor closure, tuple
reuse and process exit can race inspection; ambiguous or changing evidence must
fail. A returned observation remains point-in-time. If the mechanism cannot
reliably reject a wrong process/connection under the bounded tests, reject the
design rather than declare a listener-port match sufficient.

#### Proposed bounded execution scope requiring separate approval

- Resolve existing local images to immutable IDs; no implicit image pull,
  package installation or custom Asterisk build. First inspect whether a
  suitable local image contains both the required test runtime and Asterisk.
  If it does not, propose the explicit build/dependency change before execution.
- Use unique ownership-labelled containers and disposable tmpfs state/config;
  no production/customer volumes, host PID namespace, Docker socket, credentials
  mounts or writable repository. No SIP registration, calls, trunks or routing.
- Keep root filesystem read-only, capabilities dropped, no-new-privileges,
  network disabled except namespace loopback, and explicit memory/task/time
  limits. Parent launch/cleanup runs only against exact owned resources.
- Create only random synthetic AMI credentials in disposable memory/files,
  never logs or repository. A test-specific minimal configuration must disable
  unnecessary listeners/modules; do not copy real accounts or endpoint auth.
- Approved wire operations would be AMI login, `CoreStatus`, optional logoff
  and connection close only. Child start, graceful stop and bounded termination
  of that exact disposable child are fixture lifecycle operations requiring
  explicit approval, not broker protocol actions.
- Use no `Command`, `Originate`, `Hangup`, reload, endpoint-detail collection,
  configuration mutation or access to existing services.

#### Finite acceptance batch

| Case | Required measurable outcome |
| --- | --- |
| Owned child, exact connection | Live retained child handle, established server socket inode found in that child's descriptors, exact connection tuple and successful bounded `CoreStatus`; no ready state before association. |
| Wrong process/connection | A second test-owned process or mismatched tuple cannot satisfy association with the Asterisk child; reject before accepting status as enrolled evidence. |
| Child exit during held collection | Detect owned child exit, invalidate pending collection and reject its late result; report the actual exit rather than substituting a generic timeout. |
| Replacement child | A distinct runtime UUID and complete fresh association are required; the old collection remains rejected even if port/PID values are reused. Do not force PID reuse to claim this case. |
| Connection loss without known restart | Invalidate the old connection; do not assert either restart or continuity. New observation requires fresh association to the retained live child. |
| Cleanup | Stop/reap only owned children, remove exact owned resources, retain no synthetic secrets and leave existing PBXs untouched on success or failure. |

One bounded run of these cases is the intended batch, not an open-ended new
transport programme. It proves neither live generation observations nor
deadline/fence/dialog semantics.

#### Stop and decision rules

Stop if the chosen image/runtime is absent, pidfd/descriptor/kernel-table access
is unsupported or denied, a second process can satisfy the ownership check,
the exact connection cannot be distinguished, or clean owned-child reaping
cannot be established. Do not add root, ptrace capability, host namespace access
or a Docker socket to make the proof pass. Report the limitation and revisit the
mechanism or explicitly request a different trust boundary.

Before implementation/execution, obtain approval for this disposable PBX,
synthetic AMI account and child lifecycle scope. Even a passing proof is not
approval to replace the production entrypoint or deploy the collector.
Next live-source gates remain effective fence verification, complete
generation-dialog correlation and independently reviewed collector authority.

### 9.27 Disposable Asterisk lifecycle association feasibility result

The user explicitly approved implementation and execution of the bounded
disposable PBX proof, including random synthetic AMI credentials and lifecycle
operations on its exact owned children. This is not production access or
deployment approval. `scripts/Test-PbxEnrollmentProof.ps1` and
`tests/identity/pbx-enrollment-proof.py` implement the finite batch in section
9.26 without changing any broker runtime module or existing PBX fixture.

The existing local diagnostics image was inspected before execution: it already
contained Python and Asterisk, so no pull, build or dependency installation was
needed. The launcher resolves it to an immutable image ID; the script requires
the Asterisk binary to report 22.11.0. The successful run used image ID
`sha256:357ca0da95eb7015eb7f8232d77ad1d6ea5038822ec8b46037bdd59d3fdb5e15`.

The entire test runs as UID 1000/GID 999, with zero effective capabilities,
read-only root, no-new-privileges and network disabled except namespace loopback.
It uses a 16 MiB owned tmpfs, 192 MiB memory, one CPU and 64-task limit, plus a
60-second test alarm. Only code is bind-mounted read-only. No ports, SIP objects,
calls, production volumes, Docker socket or host PID namespace are used.

A test-specific minimal configuration disables module autoload and binds AMI
only to namespace loopback. A random synthetic account has `read=none` and
`write=reporting`; its broader action authority is acknowledged, not called an
enforced read-only account. The fixture's allowed actions are Login,
CoreStatus and Logoff only, with total action time/byte bounds. Account material
exists only in disposable memory/configuration, not repository/log output.
The existing image's documentation data remains read-only at its original
path; writable state, logs and configuration are confined to tmpfs.

The passing batch establishes:

- The retained Asterisk child and its pidfd are live; the exact reverse
  established TCP tuple has one server inode present among that child's open
  descriptors. The same check succeeds before and after bounded CoreStatus.
  Zero calls is checked only as synthetic fixture state, not generation-dialog
  completeness.
- An established connection owned by the test supervisor instead of Asterisk
  cannot satisfy the child-descriptor ownership check.
- Closing the original AMI connection invalidates its authority. A new
  connection must be associated with the retained child before becoming ready;
  it does not silently inherit continuity.
- While a local evidence collection is held, graceful termination of the exact
  child produces pidfd readability and authority invalidation within three
  seconds. The child exits cleanly, its AMI connection reaches EOF, and a late
  result is rejected with the exact changed-authority error. This is a held
  **local collection**, not a claim of cancelling a blocked AMI server action.
- A replacement Asterisk child gets a distinct runtime UUID and a complete fresh
  socket association. The original collection remains rejected. The test does
  not force or claim actual PID reuse.
- Both children are reaped, handles/connections are closed, synthetic files are
  removed and the uniquely named/labelled container is cleaned on success or
  failure. No unrelated PBX/container is inspected or modified.

Initial fixture runs exposed missing runtime documentation data when all
data paths were redirected, and the Logoff `Goodbye` response distinction.
Those fixture assumptions were corrected without adding privileges, modules,
accounts to existing services or broader actions.

This is feasibility evidence for same-namespace, same-UID child/socket
inspection, not a deployed supervisor, an atomic kernel ownership API or
continuous attestation. Socket-table/descriptor races, peer compromise,
supervisor crash recovery, multi-generation invalidation and real protected
publication remain unproven. No fabricated generation observation is accepted:
CoreStatus is not a fence/dialog/removal result. The existing runtime entrypoint
is unchanged. Before production integration, design the actual supervised
deployment and connection-publication lifecycle, and resolve effective fencing,
generation-dialog completeness and independent expiry under separate approvals.

### 9.28 Generation fencing and dialog ownership contract (design only)

The user selected this functional design after the lifecycle feasibility proof.
No fence, dialplan, SIP account, call or observation adapter is implemented or
exercised here. The existing expiry consumer in `src/agent-provisioning-expiry.ts`
already orders fence, observation, zero-dialog removal and removal verification.
The live adapter must establish the facts behind that sequence; transport and
process association do not supply them.

#### New-work fence: intended meaning

`newCallsBlocked: true` must mean that all supported admission paths for the
exact generation are effectively closed, including previously queued offers
and requests racing the fence. It is not inferred from a desired drain flag,
deadline, contact absence, endpoint device state or successful configuration
reload. A known open path produces `false`; inability to establish the full
claim makes the observation unavailable, not a partially verified `true`.

| Surface | Required fence property | Existing-call preservation constraint |
| --- | --- | --- |
| Dispatcher/inbound offers | Stop selection of the generation and reject stale, queued or already-selected offers at a final generation-aware PBX admission check. | Do not hang up an already-admitted dialog to implement dispatcher removal. |
| Endpoint-originated initial calls | Deny new initial dialog admission even with cached authentication, an existing registration or reused transport. | Permit required in-dialog signaling for retained calls under the selected drain policy. |
| Queue and other PBX-originated legs | Every supported route checks the same effective generation fence immediately before admission; queue-member removal alone is insufficient. | Preserve already-admitted legs; uncertain pending offers remain owned until settled. |
| Transfer, forwarding and alternate dial paths | Enumerate and gate paths that can create a new generation-owned leg. Unsupported bypass paths must be disabled by verified deployment configuration or block acceptance. | Continuation versus new-work semantics require an explicit transfer policy; do not silently interrupt an existing call or exempt arbitrary new legs as continuation. |
| Expiry and controller loss | Enforce the same final admission decision from locally authoritative state, not only a running worker's next sweep. | Preserve active calls indefinitely while denying new work; independent expiry enforcement is still unimplemented. |

A final admission boundary must serialize the irreversible fence latch with
new generation-owned admissions. Record ownership of an admission before it can
escape that boundary; once fencing returns, there must be no unaccounted
pre-fence admission capable of becoming a call later. A check followed by an
uncoordinated `Dial`/offer is not this guarantee. Pending/early dialogs,
fork branches and deferred offers must either be prevented from creating new
work or remain in the generation's outstanding ownership set until their
terminal outcome is verified. The concrete PBX hook implementing this ordering
is not selected; AMI lists cannot implement it by observation alone.

#### Dialog ownership and completeness

Define `dialogs` as the number of outstanding generation-owned dialog/admission
obligations that must settle before removal, not the PBX's global calls or raw
channel count. This refines the existing drain contract without changing its
wire shape; the eventual producer and consumer must explicitly agree this
definition before live integration. Early/unanswered work can therefore keep
the count above zero. Numeric zero is a safety assertion about complete
ownership, not an estimate of billable or connected calls.

Ownership originates from trusted admission context bound to the protected
generation mapping. Caller-supplied SIP headers, extension text, channel-name
prefixes, `Linkedid` or SIP Call-ID alone are not authority. The eventual owner
must track relevant SIP dialog identities/branches and their channel/bridge
associations, handle retransmissions idempotently, and preserve ownership across
supported transfer/Local-channel/bridge transformations without double-counting
or silently dropping obligations. Identifiers and call metadata remain internal;
broker responses return only the bounded observation.

The producer needs either a proven consistent runtime snapshot of all relevant
obligations or a reconciled baseline plus a loss-detectable, ordered lifecycle
stream. This is a required capability, not a claim that the available AMI
stream supplies it. Reconnect gaps, process restart, incomplete enumeration,
ambiguous attribution or unsupported transformations yield `"unknown"` dialogs
only if fence/removal facts remain authoritative; otherwise the entire
observation fails. Do not decrement to zero because a timeout elapsed or a
channel disappeared from one list.

#### Safe-zero and removal boundary

Removal requires a latched, runtime-verified admission fence, settled pending
admissions and a complete zero-ownership result for the same generation/model/
runtime authority. The future mutation owner must recheck these conditions
under its execution coordination boundary; a prior broker read is not a
removal permit. No new admission may race between the zero check and removal.
Verify removal of the approved managed access surfaces afterward, without
touching shared/base objects or other generations. Failure retains uncertainty
and blocks replacement activation; it never triggers a forced hangup.

Inventory `draining` should denote a **durable irreversible drain latch**,
not verified fence success. This is the recommended semantic resolution of the
open question in section 9.15: the existing expiry loop calls `fence` again for
every draining item and separately verifies `newCallsBlocked`. The latch must
not be cleared by renewal/restart, and a deadline never extends implicitly.
This recommendation adds no drain column or implementation to the current
metadata ledger.

#### Finite future acceptance and decisions

Before any mutation/call proof, choose the final PBX admission mechanism,
complete dialog ownership source and explicit transfer-continuation policy.
Review their privileges and supported route set; a generic collector cannot
substitute for missing PBX enforcement. Then separately approve an isolated
synthetic-call batch covering:

1. An active call survives fencing while inbound, outbound, queue and supported
   alternate new-work paths are denied, including a held pre-fence offer.
2. Early dialogs, retransmissions and fork/transfer transformations retain
   correct ownership; unknown/gapped state never becomes zero.
3. Last-dialog settlement permits a newly verified zero; removal rechecks the
   fence/ownership under coordination and leaves unrelated/base objects intact.
4. Observation disconnect/restart blocks removal and replacement until complete
   reconciliation; worker loss cannot reopen admission or extend deadlines.

If the selected Asterisk interfaces cannot provide a serialized admission hook
and complete ownership evidence, stop the collector-only approach and revisit
PBX-side instrumentation. The next decision is that enforcement/ownership
mechanism, not another AMI query or additional socket fixture variation.

### 9.29 Dialplan-only versus in-process admission/dialog enforcement (recommendation)

The user requested comparison against the pinned Asterisk 22.11.0 behavior.
Sources checked:

- [Dial() documentation](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/Dialplan_Applications/Dial/)
  documents `b()` pre-dial processing on each newly created outbound channel,
  `B()` on the current channel, and call/transfer options.
- [Queue() documentation](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/Dialplan_Applications/Queue/)
  documents `B()` before outbound member calls and transfer options, but queue
  admission itself can precede a member leg.
- [Core transfer feature documentation](https://docs.asterisk.org/Configuration/Features/Feature-Code-Call-Transfers/)
  distinguishes core feature-code transfers from channel-driver native transfer
  capability; application `t`/`T` options gate only that application's feature
  code path, not transfers initiated by other methods.
- [AttendedTransfer()](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/Dialplan_Applications/AttendedTransfer/)
  and [BlindTransfer()](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/Dialplan_Applications/BlindTransfer/)
  can redirect/restart channels into transfer destinations/contexts.
- [Transfer()](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/Dialplan_Applications/Transfer/)
  can request a protocol-level transfer/redirect.

These public docs describe control surfaces; they do not prove the selected
image's effective configuration or a complete generation ownership mechanism.

| Property | Dialplan-only wrappers | Purpose-built in-process Asterisk module/hook |
| --- | --- | --- |
| Centralized fixed routes | Readable and straightforward when every call enters a closed, broker-generated context. | Can expose fixed admission operations while retaining generated dialplan, but must still cover all entry contexts. |
| Final admission race | A dialplan check before `Dial` or `Queue` can race the drain latch. Asterisk 22.11 provides per-callee `b()` Gosubs in both applications; source runs them after the called channel is created and before `ast_call()`. A Gosub alone is not serialization, but it can invoke an in-process admission operation that atomically records a pending-leg claim against the same latch used by drain. A denied Gosub must hang up the callee channel; both applications proceed to `ast_call()`, which refuses an already hung-up channel. | Can own a lock/claim and generation latch inside the PBX at these verified pre-call points, if every relevant path invokes the operation, rejected channels cannot reach their channel driver's call method, and claim/state lifetime is correct. |
| Queues and parallel/forked dialing | Queue can hold work before an outbound member channel; `Dial` can originate multiple branches. `b()` runs per callee after channel datastore inheritance, but the queue-waiting obligation begins earlier and must remain counted separately. Every branch needs its own admission record, and cancellation/failure must settle it. Both applications have forwarding paths that bypass re-running the initial per-callee Gosub; protected routes must intercept or explicitly suppress forwarding and prove the effective option. | Can centralize per-branch admission and outstanding-claim accounting through per-callee hooks while separately owning queue-waiting work; integration must prove all options, retries, forwarding and channel technologies rather than assume the hook is universal. |
| Direct originate APIs | AMI Originate, ARI Stasis channel dialing, and direct `ast_dial`/outgoing-call API users can place calls without entering the generated Dial/Queue route. A predial Gosub exists on some APIs but is optional or absent on other paths. External permissions and every in-process caller must be inventoried. | A per-callee app Gosub is not a universal call boundary. The PBX owner must hook or mediate every supported originate API, or the deployment must disable/restrict each bypass and prove the restriction. |
| Transfers and direct protocol behavior | Application `t`/`T` options and dialplan transfer contexts do not globally govern channel-driver-native transfer methods. Redirect/transfer destinations can enter a different context. A fully closed configuration could disable unsupported transfer paths, but must prove every endpoint/module/channel feature is constrained. | Can mediate only the transfer/admission APIs it explicitly hooks. Native PJSIP and core transfer paths may bypass a custom dialplan app; the module must disable or integrate those paths and prove the coverage. |
| Dialog lifecycle | Dialplan hangup handlers/channel variables can help for a narrow closed path but require correct propagation through bridges, Local channels, queue legs, transfer and failure/early-dialog cases. | Can attach channel/datastore/bridge lifecycle tracking close to PBX events and reconcile outstanding admissions, but implementation is ABI/version coupled and still needs complete semantics/tests. |
| Operational cost | Lower initial code/build cost; high risk of missing a route or future configuration/module change. Strong configuration lint and a closed feature matrix required. | Asterisk build/module packaging and upgrade burden; larger in-process fault blast radius. Easier to make one explicit serialized owner, but not automatically complete or safe. |

#### Recommendation: hybrid closed world plus PBX-owned gate

Do not select either as sufficient alone. Prefer a hybrid in which:

1. A broker-generated closed dialplan/configuration allowlist enumerates every
   supported ingress, dispatch, queue, outbound and transfer path. Unknown
   contexts, unmanaged endpoint routes and unsupported feature modules are
   disabled/rejected by verified configuration.
2. A small version-pinned in-process admission owner provides the atomic
   generation check/claim at the final supported new-leg admission boundary and
   owns outstanding generation-scoped dialog/admission lifecycle records.
3. Every configured `Dial` and `Queue` member leg must invoke that owner from
   its per-callee `b()` hook before `ast_call()`. The owner atomically converts
   trusted inherited operation state into a per-leg pending claim; a denied or
   untrusted callee is hung up so the channel driver cannot signal it. Queue
   waiting and transfer-start work need their own earlier claims. Every internal
   transfer target and supported redirect path must preserve that chain.
   Module hooks alone are not assumed universal; explicit configuration
   disables any path that cannot be interposed.
4. Drain takes the same serialization boundary as admission, latches
   irreversibly, prevents later claims and accounts for every already-claimed
   pending leg. Existing admitted dialogs remain tracked and continue.
5. The module returns only a fixed internal observation snapshot; no generic CLI,
   AMI action, arbitrary dialplan target, path or object selector is exposed.
   Broker readback remains observation-only; fence/removal remain separately
   authorized operations.

This recommendation rejects a plain policy-check Gosub before `Dial` as the
final safety design. The verified per-callee `b()` points are a better
invocation boundary: a Gosub there can call the in-process owner, which must
atomically create a pending claim and hang up the callee on denial. The claim,
not the Gosub's return or a later SIP event, serializes with drain. A config-only
implementation could be reconsidered only if a closed path matrix and synthetic
proof demonstrate equivalent atomic admission and complete lifecycle ownership
without custom in-process code; current evidence does not establish that.

#### Existing Milestone 1 transfer requirement

The current [Milestone 1 scope](./MILESTONE-1.md#3-scope) explicitly includes
browser blind transfer and defers attended transfer. The conservative
disable-transfer recommendation above must not silently remove that agreed
scope. Until the product scope is explicitly changed, blind transfer remains a
required path for design and feasibility; this does not authorize its
implementation or prove it is compatible with generation fencing.

Asterisk 22.11.0 documents `PJSIP_TRANSFER_HANDLING(ari-only)` as a mode that
routes incoming PJSIP REFER handling to ARI rather than the built-in core
attended/blind handler. The pinned
[22.11.0 REFER handler](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1553)
and [dispatch between ARI, attended, and blind handling](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L2057)
show this is an alternate REFER handling path, not evidence of a generation-
atomic admission claim. It requires an ARI application/controller and its
failure, ownership, and lifecycle semantics still need proof. The endpoint
[`allow_transfer`](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/Module_Configuration/res_pjsip/#allow_transfer)
setting controls SIP REFER; disabling it is not a demonstrated way to preserve
the Milestone 1 transfer requirement or to disable every possible transfer
mechanism.

For a permitted blind transfer while a generation is open, ownership must
cover the new target leg before signaling and preserve the existing call if
admission fails. Once the generation is fenced, a transfer that creates a new
generation-owned leg must be rejected while the existing dialog remains
tracked and usable. A pre-fence transfer with an unresolved target offer remains
an outstanding obligation until its outcome is known; transfer progress,
timeouts, and observer gaps must never create a false dialog-zero interval.
Attended transfer, parking, forwarding, external redirection, and arbitrary
expert dialplan remain outside the Milestone 1 path set unless separately
approved and designed.

#### Milestone 1 synthetic-call matrix

Use only the existing Milestone 1 synthetic topology: one customer, one simple
inbound test route, one queue, browser-agent endpoints, and internal synthetic
transfer destinations. The repository pins `sip.js` 0.21.2 in both
`package.json` and `package-lock.json`; the installed package source was checked
for these REFER behaviors. The web `SessionManager.transfer(session, target)`
uses blind REFER for a string target, but its `setupSessionDelegate()` assigns
an `onRefer` handler that accepts an incoming referral and sends a new INVITE
to the referral target. It also overwrites any existing per-session `onRefer`
handler (the implementation has an explicit TODO about clobbering it). Thus,
using this higher-level manager without replacing or wrapping that behavior
can auto-follow incoming in-dialog referrals.

That is not the low-level library's universal default. In SIP.js 0.21.2, an
in-dialog REFER received by a core `SessionDialog` with no session `onRefer`
delegate is rejected by `ReferUserAgentServer.reject()` using its default
status 480. An out-of-dialog REFER with no UserAgent-level delegate is rejected
with 405. The existing `tests/webrtc/client.ts` uses `UserAgent` and `Inviter`,
not `SessionManager`, and exercises no REFER path. Milestone implementation
must choose its SIP.js surface explicitly, install its admission policy after
any manager delegate setup, and prove that no library-managed `onRefer`
silently follows an unapproved target. Do not infer the path from the UI label.

The pinned low-level outgoing API also separates request dispatch from
completion. `Session.refer()` resolves to an `OutgoingReferRequest` after
creating the non-INVITE transaction; it does not wait for the REFER response.
`SessionManager.transfer()` simply awaits that API and returns, so resolving
that promise is not evidence that the peer accepted the REFER. The supplied
`requestDelegate.onAccept` observes a 2xx transaction response, while
`options.onNotify` receives subsequent in-dialog NOTIFY requests separately.
The latter receives a `Notification` wrapper and must explicitly accept or
reject the request; it does not parse or certify target-dialog or bridge
completion for the application.

There is a correlation constraint in the pinned implementation: `Session`
stores the `onNotify` handler in one per-session field, and each `refer()` call
replaces it. A second outstanding REFER on the same dialog can therefore
replace the first REFER's NOTIFY callback. The application must serialize
outstanding REFER operations per source session, or prove an alternative
transaction-correlation layer before allowing overlap. Even with a serialized
request, a missing NOTIFY, a terminated subscription, or a SIP-fragment final
status is not by itself proof that every Asterisk channel/bridge ownership
obligation has settled. Source: the pinned
[Session implementation](https://github.com/onsip/SIP.js/blob/0.21.2/src/api/session.ts),
[SessionManager implementation](https://github.com/onsip/SIP.js/blob/0.21.2/src/platform/web/session-manager/session-manager.ts),
[UAC response dispatch](https://github.com/onsip/SIP.js/blob/0.21.2/src/core/user-agents/user-agent-client.ts),
and [Inviter NOTIFY generation](https://github.com/onsip/SIP.js/blob/0.21.2/src/api/inviter.ts).

The pinned Asterisk 22.11 REFER handler adds a second important distinction.
For its ordinary in-dialog REFER path, unless the request suppresses
`Refer-Sub`, it creates the implicit REFER subscription and attempts to send
**202 Accepted** before the transfer outcome is known. Asterisk ignores the
accept-call return, and the cloned-rdata transaction constraint described
below may prevent either subscription setup or response submission. When
subscription setup and response submission succeed, the terminal transfer
result may later be carried in a `message/sipfrag` NOTIFY.
The endpoint `refer_blind_progress` option defaults to `yes`, but when set to
`no`, the blind-transfer callback emits terminal `200` NOTIFY as soon as the
transfer callback runs; that callback precedes completion of the target call.
Even with progress enabled, Asterisk's source explicitly falls back to a
terminal `200` “assuming success” if it cannot allocate the transferee
identifier, attach its framehook, or subscribe to bridge events. Consequently,
neither the REFER's 202 nor a terminal 200 sipfrag proves the target dialog
answered or every generation-owned obligation settled. Any test or deployment
must record the effective endpoint option and distinguish transfer admission,
progress-monitor health, target answer, and final ownership reconciliation.
The transferee-ID allocation failure has an additional source-level hazard:
`refer_blind_callback()` assigns the `ast_strdup()` result to
`progress->transferee`, queues the assumed-success notification if it is NULL,
but continues to create the bridge subscription; `refer_progress_bridge()`
later passes that field to `strcmp()` without a NULL check
([ID assignment and continued setup](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L838-L885),
[bridge comparison](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L285-L299)).
If a matching bridge-entry callback runs with the missing identifier, the
source can call `strcmp()` with a NULL argument. This is a potential invalid
memory access, not a runtime-confirmed crash. Inject failure of this
identifier allocation and prove the subscription is not left able to compare
NULL (or otherwise demonstrate a safe guarded path); also verify that the
assumed-success NOTIFY cannot settle or mask the transfer claim.

When Asterisk successfully submits the implicit-subscription response, SIP.js
0.21.2's `requestDelegate.onAccept` observes the initial 202, not the terminal
transfer result. With the default
`refer_blind_progress=yes` and a successful monitoring setup, the terminal
NOTIFY sipfrag can represent an answer indication from frames/bridge entry,
but must still be checked against PBX channel/session lifecycle evidence. If
the subscription is suppressed (for example by `Refer-Sub: false`) or absent,
or monitoring degrades to Asterisk's assumed-success fallback, that evidence
is unavailable or explicitly untrustworthy. SIP.js 0.21.2's outgoing REFER
does not add `Refer-Sub: false` by default, but the wire request and effective
Asterisk behavior must still be captured in the test. Source: Asterisk's pinned
[REFER progress setup and 202 response](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L552),
[blind-transfer callback and progress monitor fallbacks](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L805),
[progress-frame handling](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L327),
and [endpoint option default](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip/pjsip_configuration.c#L2397).

The source also clarifies what Asterisk's `transfer_channel_data.completed`
means. Core sets it after the parking attempt and before branching into ordinary
bridge transfer logic; it marks transfer-action preparation complete so deferred
progress can be reported. It is not set by target answer or successful target
dialog settlement. In the two-party path, the REFER callback is invoked on the
transferee before the blind-transfer action is queued; in the multi-party path,
it runs on the new Local channel before `ast_call()` and bridge insertion. With
blind progress enabled, the PJSIP framehook is attached to the channel being
transferred and interprets its ringing/progress/answer control frames or media;
the bridge subscription separately treats that same transferee re-entering a
bridge after the transfer action is marked completed as an answer indication.
This is not a direct identity/lifecycle record for every forked target leg. It
can provide transfer UX progress, but cannot replace per-leg claims, exact
target correlation, or complete dialog ownership tracking. Source: pinned
[transfer completion flag ordering](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge.c#L4700),
[two-party callback before queue](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge_channel.c#L3017),
[multi-party callback before Local call](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge.c#L4336),
[frame and bridge answer signals](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L272).

There is a narrower two-party failure-ordering concern as well. Core sets
`completed` before invoking the callback; that callback attaches the progress
framehook to the transferee, and only afterward does the bridge helper enqueue
the blind-transfer action. If enqueue then fails, the framehook may already
have observed frames on the still-bridged transferee; its existing voice-frame
path can emit terminal `200` without proving a target leg was created. Whether
such a frame wins the timing race is runtime-dependent, but the source ordering
allows the question and the result needs a dedicated failure-injection test.
Record the enqueue failure, any progress NOTIFY ordering, target-channel
signaling, and source bridge state separately; a progress `200` must not
override the failed transfer result or imply admission. The framehook queues
that NOTIFY on the REFER progress serializer, while the REFER handler maps the
bridge return to its final SIP response synchronously
([serialized NOTIFY](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L371-L382),
[synchronous result mapping](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1822-L1830)).
The inspected paths establish no ordering guarantee between the asynchronous
NOTIFY send and the handler's failed REFER response; capture wire order rather
than assuming either response must precede the other. On any non-200 transfer
result, the request handler also queues a terminal NOTIFY carrying that failure
code
([failure NOTIFY enqueue](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L2089-L2098)).
If a framehook has concurrently queued a progress-derived terminal `200`, the
serializer can therefore be asked to send both success-shaped and failed
terminal reports for a core-rejected transfer. Exercise both queue orders and
retain the core return, final REFER response, every NOTIFY, and channel outcome
as separate evidence.

There is also an allocation-failure edge at terminal progress reporting.
`refer_progress_notification_alloc()` returns `NULL` when AO2 allocation fails
([allocator](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L161-L176)).
In the bridge callback, unsubscribe and framehook detach occur only inside the
successful-notification branch; the framehook similarly detaches only when a
terminal notification object exists
([bridge terminal path](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L272-L323),
[framehook terminal path](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L326-L385)).
Thus source inspection shows that allocation failure can skip both terminal
NOTIFY scheduling and the corresponding progress cleanup at these call sites.
This is a source-level failure mode, not proof of a runtime leak or permanent
subscription. Inject failure at terminal-notification allocation and verify
cleanup, observability, and that missing progress cannot settle a transfer
claim or be interpreted as target failure/success. In the framehook's
voice-derived answer branch, `progress->subclass` is set before allocating the
notification; if that allocation fails, later voice frames fail the
`!progress->subclass` condition and do not retry that answer notification
([answer state before allocation](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L343-L348)).
Combined with detach being conditional on a successfully allocated terminal
notification, this leaves the framehook without that retry/cleanup path until
some other lifecycle action removes it. Verify this branch separately from
control-frame answer and bridge-entry completion.

Notification allocation is not the only failure point. In both the terminal
framehook and bridge-entry callbacks, a failed `ast_sip_push_task()` causes the
caller to clean up the notification object rather than retry it; the framehook
has already detached, and the bridge callback unsubscribes after the attempted
push
([framehook enqueue](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L371-L382),
[bridge enqueue and unsubscribe](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L302-L309)).
This is a distinct terminal-report loss path even when notification allocation
succeeds. Inject serializer-task enqueue failure for each callback and prove
that absent NOTIFY delivery leaves the operation unresolved until channel and
claim lifecycle evidence reconciles it; do not infer success, failure, or
zero-count from the lost report.

This is not limited to a framehook timing race. With
`refer_blind_progress=no`, `refer_blind_callback()` itself queues terminal
`200` as soon as it is called; in the two-party path that callback precedes the
bridge-action enqueue
([early success NOTIFY](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L818-L827),
[callback-before-enqueue](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge_channel.c#L3032-L3040)).
If enqueue fails, the handler subsequently maps the core failure to a
non-200 REFER response and queues a terminal failure NOTIFY. Thus the
success-shaped terminal report can be enqueued on a failed operation even
without any progress frame or answer race. Pinning the option is essential,
but neither setting removes the need to test failed-enqueue response/NOTIFY
behavior and to treat only the core result plus channel/claim reconciliation
as outcome authority.

The transfer wrapper has two different lifetime rules. `transfer_channel_cb`
may read its `data` pointer only during the callback; the pinned PJSIP callback
dereferences it there
([callback data access](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L805-L818)).
PJSIP passes the address of its stack-local `refer_blind` object as that data.
In the pinned core paths, the two-party helper invokes the callback before it
queues the bridge action, and the multi-party helper invokes it inline before
calling/imparting its Local channel
([two-party callback before queue](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge_channel.c#L3017-L3040),
[multi-party callback before call/impart](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge.c#L4359-L4371)).
Thus the current synchronous callback use fits the stack object's lifetime;
an asynchronous callback or retained dereference of `.data` would not.
For progress, PJSIP takes an AO2 reference to the wrapper, and parking
subscriptions can retain another reference until their final Stasis message
([PJSIP retain/release](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L853-L855),
[parking retain/release](https://github.com/asterisk/asterisk/blob/22.11.0/res/parking/parking_bridge_features.c#L161-L168)).
Those asynchronous paths use the wrapper's `completed` flag; they do not make
the caller-owned `data` pointer safe to retain or dereference later. More
importantly, `completed` is documented as progress deferral state, not a
generation claim or drain latch. The source exposes it as a plain `int`
updated/read by progress and parking callbacks, not as a synchronized admission
API. The two Stasis callbacks use separate pooled subscription serializers;
that serializes callbacks within each subscription, not across parking and
bridge-progress subscriptions. The framehook also reads the flag from channel
frame processing, while core transfer handling can write it directly
([per-subscription dispatch](https://github.com/asterisk/asterisk/blob/22.11.0/main/stasis.c#L923-L1004),
[framehook read](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L326-L342),
[bridge callback read](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L272-L300),
[parking callback write](https://github.com/asterisk/asterisk/blob/22.11.0/res/parking/parking_bridge_features.c#L140-L157),
[core write](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge.c#L4700-L4706)).
No common synchronization for these accesses is visible in the pinned paths.
This is an unsynchronized-access/race candidate, not a confirmed runtime race:
the precise overlap and resulting progress behavior need focused concurrency
validation. The admission design must keep claim state separate and use its
own explicitly synchronized, lifetime-managed owner; neither the wrapper
reference nor its progress flag is a claim-lifecycle mechanism.

The browser may request a transfer, but it is not an authority for target
allowlisting, generation state, or dialog ownership. Every REFER-created target
leg must pass the PBX-side final admission boundary. The browser must install
explicit incoming-REFER handling on every session so an unsolicited referral
cannot silently create an unreviewed client-side call.

#### Asterisk 22.11 candidate admission hooks (feasibility only)

Pinned source exposes two relevant PJSIP session-supplement callbacks:

- [`session_create`](https://github.com/asterisk/asterisk/blob/22.11.0/include/asterisk/res_pjsip_session.h#L391)
  is called by
  [`ast_sip_session_create_outgoing()`](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_session.c#L3312)
  before it resolves the destination or creates the dialog/invite resources.
  A nonzero callback result blocks creation. Its inputs are the endpoint,
  contact, location, request user, and stream topology; it does not receive a
  trusted generation token or route cause. This is a plausible final gate for
  outgoing PJSIP legs if every generation-owned endpoint is broker-generated,
  resolvable to exactly one generation, and unknown identities fail closed.
- [`incoming_request`](https://github.com/asterisk/asterisk/blob/22.11.0/include/asterisk/res_pjsip_session.h#L319)
  can stop later session supplements: the dispatcher breaks out when the
  callback returns nonzero, but sends no response on its own
  ([dispatch break](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_session.c#L4462-L4476)).
  The supplement contract therefore requires the rejecting callback itself to
  send a SIP response; it runs on a SIP servant thread, and a channel is not
  guaranteed to exist. Its request data is cloned: the callback contract says
  `pjsip_rdata_get_dlg()` and `pjsip_rdata_get_tsx()` do not work properly
  because module data is not copied, and directs dialog access through
  `session->inv_session->dlg`
  ([callback contract](https://github.com/asterisk/asterisk/blob/22.11.0/include/asterisk/res_pjsip_session.h#L319-L335)).
  Therefore, the admission owner must not key a claim from those PJSIP getter
  results; a retransmission-stable REFER transaction key must be derived from
  clone-safe request data or another proven source and tested against wire
  retransmissions. This warning intersects both built-in REFER response modes.
  For the ordinary implicit-subscription path, Asterisk's pinned
  [pjproject version is 2.17](https://github.com/asterisk/asterisk/blob/22.11.0/third-party/versions.mak#L3).
  Its [`pjsip_rx_data_clone()`](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_transport.c#L834-L905)
  zero-initializes the destination and copies transport, packet, and parsed
  message data, but not `endpt_info.mod_data`; consequently the clone's
  `pjsip_rdata_get_tsx()` lookup has no transaction module-data entry.
  [`pjsip_evsub_create_uas()`](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L958-L987)
  requires that transaction and returns `PJSIP_ENOTSX` if it is absent.
  Asterisk's `refer_progress_alloc()` treats `pjsip_xfer_create_uas()` failure
  as an error, and the request handler sends `500` and returns before the
  intended `202` or target validation
  ([setup failure handling](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L599-L629),
  [REFER response path](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L2044-L2049)).
  This is a source-level incompatibility candidate that requires verification
  against the exact callback request object and wire behavior; do not assume
  either successful subscription creation or a runtime failure without that
  proof. The `Refer-Sub: false` branch skips creation but later passes
  `pjsip_rdata_get_tsx(rdata)` to `pjsip_dlg_send_response()`
  ([no-subscription response path](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L2069-L2088)),
  then ignores that function's return. In pjproject 2.17 the dialog-send API
  returns `PJ_EINVAL` when its transaction argument is NULL
  ([argument check](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_dialog.c#L1642-L1654)).
  If the callback clone has no transaction module data, this call does not
  submit the constructed response through that API; any eventual wire response
  or timeout behavior must be captured rather than inferred. This is a
  source-level response-path concern, not a claim about what the peer
  necessarily observes. The built-in REFER supplement is registered at
  [`AST_SIP_SUPPLEMENT_PRIORITY_CHANNEL + 1`](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L2162),
  with `AST_SIP_SUPPLEMENT_PRIORITY_CHANNEL` defined as `1000000`
  ([priority values and ordering](https://github.com/asterisk/asterisk/blob/22.11.0/include/asterisk/res_pjsip.h#L3389-L3398)).
  A narrowly scoped REFER gate must use a strictly earlier priority, claim the
  reservation before returning zero to continue, or send its explicit final
  response and return nonzero to stop the built-in handler. Merely returning
  nonzero without responding is not a reject implementation; returning zero
  after detecting a policy failure allows the built-in path to run, including
  its implicit-subscription `202` behavior.
  A custom gate also cannot assume `pjsip_dlg_respond()` works on the cloned
  request: pjproject 2.17 uses `pjsip_rdata_get_tsx()` and returns
  `PJ_EINVALIDOP` if no dialog transaction is available
  ([dialog response helper](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_dialog.c#L1717-L1764)).
  Asterisk's built-in early rejection branches call this helper and ignore its
  result. `ast_sip_send_stateful_response()` is a different API that creates a
  new UAS transaction from the supplied request
  ([Asterisk stateful response helper](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip.c#L2399-L2441)).
  pjproject derives its transaction key from the request and rejects
  registration with `PJ_EEXISTS` if that key is already present
  ([UAS creation and key registration](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_transaction.c#L1731-L1881),
  [duplicate-key check](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_transaction.c#L595-L617)).
  For an in-dialog request, pjproject creates/registers the UAS transaction
  before dispatching to dialog usages
  ([transaction before usage callbacks](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_dialog.c#L1819-L1865),
  [usage dispatch](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip/sip_dialog.c#L1919-L1933));
  Asterisk runs session supplements from that incoming session callback
  ([supplement dispatch](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_session.c#L4462-L4476)).
  The callback's cloned message retains the request's Via branch, so creating
  a second UAS transaction from it attempts to register the same key and
  returns `PJ_EEXISTS`. Asterisk's helper then returns `-1` before its send
  call. This makes `ast_sip_send_stateful_response()` unsuitable for this
  cloned in-dialog rejection path at the pinned source level; capture the
  deployed callback path and wire behavior, and select a different
  clone-compatible response mechanism.
  Every rejecting gate therefore needs a tested, clone-compatible response
  mechanism; returning nonzero only stops supplement dispatch.

If implicit-subscription setup succeeds, the built-in blind REFER handler
checks the target extension and then calls
[`ast_bridge_transfer_blind()`](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1822).
For REFERs using the implicit subscription, however, the built-in request
handler calls `refer_progress_alloc()` first. That helper attempts
`pjsip_xfer_accept(..., 202, ...)` before dispatching to the blind handler,
which then checks whether the target extension exists
([202 creation](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L599-L624),
[later extension validation](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1776-L1807),
[request ordering](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L2044-L2067)).
The return from `pjsip_xfer_accept()` is ignored by Asterisk. pjproject's
`pjsip_xfer_accept()` delegates to `pjsip_evsub_accept()`, which can return an
error while creating or sending the response
([wrapper](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-ua/sip_xfer.c#L350-L360),
[response creation and send](https://github.com/pjsip/pjproject/blob/2.17/pjsip/src/pjsip-simple/evsub.c#L1240-L1293)).
Consequently, neither successful subscription creation nor reaching target
validation proves that `202` was sent. If response acceptance succeeds, an
unknown extension can still receive `202` and only later a failure NOTIFY;
that status is subscription acceptance, not target validity or reservation
proof. The cloned-rdata transaction lookup described above may prevent
subscription setup in the pinned path; capture actual response behavior before
relying on either ordering. A generation/allowlist gate that must refuse a
request before any
accepted transfer response needs to run before this built-in handler and send
its own final response when it stops supplement dispatch. This earlier gate
must distinguish rejection from ownership of an allowed transfer. Returning
zero after reserving lets the built-in handler continue, but does not replace
its `refer_blind_callback` or prove that the built-in transfer, progress, and
terminal outcomes correlate to the reservation. A custom path that must attach
its own propagation callback needs to perform the transfer itself, own the
SIP response/progress lifecycle, and return nonzero to stop later handling;
the return code alone does not send a response. Alternatively, continuing to
the built-in handler is viable only if a separate, proven mechanism binds and
settles that handler's work against the pre-reserved operation.
The built-in handler has a distinct earlier branch when `session->channel` is
absent: it attempts a `404` via `pjsip_dlg_respond()` and returns before setting
up REFER progress or reaching the implicit-subscription `202` path
([missing-channel branch](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1997-L2005)).
Because the supplement contract does not guarantee a channel, a custom gate
must treat missing channel/generation association as an explicit fail-closed
case, avoid dereferencing channel state, and own its response if it stops
dispatch. This case must be tested separately from an unknown extension,
whose validation occurs later and can follow `202`.
Before progress setup, the built-in parser also attempts `400` for a missing
`Refer-To` header or for a value that does not parse as a SIP/SIPS URI
([header and URI validation](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L2014-L2049)).
Asterisk likewise calls `pjsip_dlg_respond()` for these cases and ignores its
return; with absent transaction data, the wire `400` is not source-proven. A
pre-handler gate must reject unsupported URI forms itself or deliberately
continue only where its parser and policy agree with the built-in parser;
neither malformed input nor a non-SIP scheme may create a transfer operation,
implicit subscription, or target attempt.
The outgoing-session callback may gate resulting PJSIP legs, but it does not by
itself constrain the transfer context, non-PJSIP legs, or arbitrary dialplan
redirection. Initial inbound INVITEs follow a distinct path: Asterisk sends
[`100 Trying`](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_session.c#L4054)
before it invokes incoming-request supplements
([dispatch](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_session.c#L4096)).
Whether that is a safe generation-aware admission boundary, and how initial
INVITEs are distinguished from in-dialog requests, must be proven for the
selected configuration.

The bridge transfer implementation makes the missing obligation concrete.
For a two-party bridge, it queues a blind-transfer task on the transferee before
removing the transferer from the bridge
([queue and removal](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge.c#L4747)).
For a multi-party bridge, it first creates a `Local` channel for the target
context and extension, then calls and imparts that channel into the bridge
([Local-channel path](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge.c#L4336)).
Only if dialplan execution subsequently creates an outbound PJSIP channel does
`chan_pjsip` reach `ast_sip_session_create_outgoing()`
([PJSIP channel request](https://github.com/asterisk/asterisk/blob/22.11.0/channels/chan_pjsip.c#L2819)).
Thus `session_create` can be a useful final veto/claim point for each actual
outgoing PJSIP leg, but it is not the transfer-start reservation: it does not
see the queued two-party transfer or the initial `Local` channel, and it does
not see other channel technologies. The transfer owner must account for that
pending work before a fence can report zero, including transfer failure and
cancellation paths.

For the two-party path, `bridge_channel_internal_queue_blind_transfer()` only
queues a bridge-channel action
([queue implementation](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge_channel.c#L3017)).
`ast_bridge_transfer_blind()` returns success after that enqueue and immediately
publishes the transfer result
([result publication](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge.c#L4757)).
The built-in PJSIP REFER handler maps that return value to SIP `200`
([response mapping](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L711)).
Therefore that immediate `200`/success proves transfer acceptance/queueing at
that API boundary, not that the target leg answered, the transfer completed, or
the generation-owned obligations settled. Transfer progress and the final
dialog lifecycle must remain separate, correlated observations.

The SIP REFER supplement also does not cover every use of the same bridge
transfer API. Asterisk's core DTMF blind-transfer feature calls
`ast_bridge_transfer_blind()` directly
([feature-code path](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge_basic.c#L3563)).
If that feature is enabled for generation-managed calls, it needs equivalent
admission and reservation coverage; alternatively it must be disabled by
verified configuration. The bridge transfer API attempts parking before its
ordinary bridge transfer branches
([parking attempt](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge.c#L4700)),
so parking must also be explicitly disabled or covered rather than assumed to
be excluded by the REFER handler.

The built-in blind REFER route is also context-dependent: it uses the channel's
`TRANSFER_CONTEXT` when set, otherwise the endpoint's configured context
([context selection](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1013)),
then copies the `Refer-To` URI user portion as the extension. If the global
`ignore_uri_user_options` setting is enabled, options beginning at the first
semicolon are truncated; if the resulting user is empty, Asterisk substitutes
`s` before checking whether priority 1 exists in that context
([extension normalization and lookup](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1784-L1806),
[option handling](https://github.com/asterisk/asterisk/blob/22.11.0/include/asterisk/res_pjsip.h#L3553-L3567)).
The user interface must not treat a displayed destination string, URI domain,
or raw Refer-To value as the effective PBX target. Admission must validate the
same context and post-normalization extension Asterisk will use, with the
effective global option setting pinned; it must not admit based on a string
that Asterisk subsequently truncates or maps to `s`. The generated
configuration must control both the selected transfer context and its
complete extension patterns; reject URI forms not explicitly supported and
verify the resolved same-customer destination before any target leg is
signaled. In addition, the REFER dispatcher checks the parsed target URI for a
`Replaces` parameter and selects the attended-transfer handler instead of the
blind handler when one is present
([handler selection](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L2052-L2066)).
Because attended transfer is outside the supported scope, the gate must reject
that branch before continuing to built-in REFER handling; validating only its
URI user as a blind extension does not constrain the attended-transfer path.

The `ari-only` PJSIP mode is not itself a transfer admission controller. In
22.11.0 the REFER handler builds transfer state, attaches a frame hook, then
calls `ast_refer_notify_transfer_request()` to publish a Stasis channel event
([ARI event publication](https://github.com/asterisk/asterisk/blob/22.11.0/main/refer.c#L541)).
That function is notification, not an approval callback: the public API
describes a transfer notification, and the REFER handler returns SIP `200`
after successful notification setup. The ARI application can observe transfer
progress, but this path does not synchronously wait for its policy decision
before authorizing or reserving a target. Therefore `ari-only` may be useful
for a future application-owned transfer protocol, but it does not close the
pre-target claim gap without additional PBX-side interposition.

#### Resulting design gate

Do not treat either the SIP.js REFER response, an ARI transfer-request event,
the bridge transfer result, or the outgoing PJSIP `session_create` callback as
the transfer-start ownership claim. They represent distinct points: request
acceptance/notification, queued bridge work, and later per-leg creation. A
generation-aware transfer mechanism must reserve the operation before any
asynchronous queue/Local-channel step, bind its obligation to each target
branch, and release it only after failure/cancellation/settlement is complete.
The existing source review has not found a supported generic veto callback for
every `ast_bridge_transfer_blind()` caller. Keeping browser blind transfer in
Milestone 1 therefore remains a requirement to solve, not a safe implementation
assumption.

The next design task is to compare two bounded candidates without making calls:

1. Intercept supported SIP REFER in a version-pinned PJSIP supplement, make a
   synchronous generation claim, own the decision/response, and prove how the
   accepted claim follows the later bridge and target legs. Separately disable
   or interpose DTMF blind transfer and parking.
2. Replace browser-originated REFER with an authenticated application-mediated
   transfer operation whose PBX-side implementation can atomically claim and
   create the generation-bound target. This still needs a PBX hook and must
   preserve the existing call on rejection.

For either candidate, define claim identity, duplicate/retransmission behavior,
pre-fence versus post-fence ordering, every failure/cancellation release, and
restart reconciliation before an isolated call proof. Do not build a module or
send synthetic calls until that design is reviewed and separately approved.

#### Refined REFER candidate: bridge transfer callback

The pinned bridge API provides a more concrete propagation point than the
outgoing PJSIP hook alone. `ast_bridge_transfer_blind()` accepts a
`transfer_channel_cb`; its contract explicitly says the callback can set data on
the channel that will run dialplan
([public callback contract](https://github.com/asterisk/asterisk/blob/22.11.0/include/asterisk/bridge.h#L1193)).
In the two-party path, Asterisk invokes it on the transferee before queueing the
blind-transfer action
([callback before enqueue](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge_channel.c#L3032)).
In the multi-party path, Asterisk invokes it on the new Local channel before
`ast_call()` and bridge insertion
([callback before call](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge.c#L4359)).
This gives a custom REFER handler a plausible place to bind a pre-created,
generation-scoped claim to the exact channel that will execute the transfer
dialplan.

The callback's `transfer_channel_data.data` points to caller stack memory and
must not be retained after callback return
([lifetime contract](https://github.com/asterisk/asterisk/blob/22.11.0/include/asterisk/bridge.h#L1180)).
Any propagated claim therefore needs an independently owned/reference-counted
representation attached to the channel, and the resulting PJSIP branch must
inherit or otherwise recover that trusted claim before signaling. On the pinned
source, `ast_channel_datastore_add()` only links the already-allocated
datastore under the channel lock and returns success
([implementation](https://github.com/asterisk/asterisk/blob/22.11.0/main/channel.c#L2374)).
That suggests a callback can avoid allocation by preallocating the refcounted
claim and datastore before starting the transfer, then attaching it while
holding the target channel lock. This is a feasibility lead, not yet a proven
callback implementation or ownership contract.

The pinned implementation sharpens that lead but also exposes an API-contract
trap. `ast_channel_datastore_add()` performs a list insertion and unconditionally
returns zero; it does not allocate, reject a duplicate type/UID, or report an
invalid attachment
([implementation](https://github.com/asterisk/asterisk/blob/22.11.0/main/channel.c#L2374-L2380)).
The public header says nonzero failure is possible and requires the channel to
be locked ([API contract](https://github.com/asterisk/asterisk/blob/22.11.0/include/asterisk/channel.h#L1204-L1221)).
The callback therefore must not treat a zero return as duplicate detection or
proof that it attached exactly one valid claim. Preallocate all fallible memory,
then hold the target channel lock while checking for conflicting state and
linking the uniquely owned datastore; explicitly define ownership if any
precondition fails. A duplicate-UID collision must be prevented or rejected
before entering the void callback, since the insertion helper itself accepts
duplicates.

There is an important failure-semantic limit: `transfer_channel_cb` returns
`void` ([callback type](https://github.com/asterisk/asterisk/blob/22.11.0/include/asterisk/bridge.h#L1193-L1205)),
so it cannot report claim-attachment failure to
`ast_bridge_transfer_blind()`. In the two-party path, Asterisk calls it before
queueing the blind-transfer action, but then proceeds to enqueue regardless of
anything the callback did; enqueue failure is reported only afterward
([callback then queue](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge_channel.c#L3017-L3040)).
In the multi-party path, Asterisk likewise proceeds from the callback to
`ast_call(local, ...)` ([callback then call](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge.c#L4359-L4365)).
Thus a callback-side error flag can inform the caller after the bridge API
returns, but cannot itself prevent the queued/action path or multi-party call
from starting. A target-context guard can prevent an unclaimed downstream dial
but does not by itself roll back a transfer already accepted or preserve the
source call.

The proposed preallocation must therefore establish a stronger invariant than
"allocation is unlikely": before calling the bridge API, the owner must reserve
the transfer operation and prove that the callback can always attach exactly
one valid, preallocated claim to the eventual channel under the required lock,
including duplicate-state and channel-lifecycle cases, or identify a separate
interception point that can abort without changing the existing call. The
helper's unconditional zero return does not supply that proof. If the callback
cannot establish the invariant, the path is not safely supported; fail-closed
target dialplan is necessary but not sufficient. Also settle the reserved
operation idempotently when the bridge API returns an enqueue/originate error
after the callback has attached state.

There is also a callback-ordering bypass before the ordinary bridge-transfer
branches: `ast_bridge_transfer_blind()` tries the parking provider first
([parking attempt before normal transfer](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge.c#L4697-L4706)).
For a multi-party parking transfer, `park_local_transfer()` creates and calls
a Local channel, inherits datastores from the parker, and calls it before the
parking provider invokes the supplied callback
([Local call before callback](https://github.com/asterisk/asterisk/blob/22.11.0/res/parking/parking_bridge_features.c#L247-L293),
[callback and bridge insertion](https://github.com/asterisk/asterisk/blob/22.11.0/res/parking/parking_bridge_features.c#L377-L402)).
The callback is therefore too late to admit the parking-created Local call, but
this ordering does not by itself prove parking unusable: a transfer-operation
claim reserved on the source channel before entering the bridge API could be
inherited to that Local channel and checked by a synchronous core admission
gate at its `ast_call()`. This is only a candidate. Datastore inheritance can
silently omit or corrupt the child payload; if the gate rejects that Local
call, parking reports failure and the bridge API falls through to the ordinary
transfer path, whose callback runs before its own call.

In the parking path there are two inheritance hops before the Local target
PBX starts: the parker's datastore is copied to `parkee` (`;1`) in
`park_local_transfer()`, then `ast_unreal_call_setup()` copies `;1` to `;2`.
If the target route uses `Dial()`/`Queue()`, its callee creation adds another
hop before the per-callee Gosub. A finite-inheritance datastore must survive
the exact supported number of hops (the counter is decremented on each copy);
otherwise use a deliberately shared/refcounted operation object with a
validated inheritance policy. Every duplicate must still be validated for
non-NULL usable payload and bound to the correct generation and logical
operation; an unbounded inheritance setting is not itself proof of ownership
or safe cleanup.

The timing is stricter than merely "callback after `ast_call()`": the Local
driver calls `ast_pbx_start()` on its paired `;2` channel, which starts a
detached PBX thread before returning
([Local dialplan action](https://github.com/asterisk/asterisk/blob/22.11.0/main/core_local.c#L751-L762),
[detached PBX thread creation](https://github.com/asterisk/asterisk/blob/22.11.0/main/pbx.c#L3268-L3292)).
That thread may execute the destination context before the parking function
returns and invokes the transfer callback. Thus the parking Local path cannot
depend on callback-attached state for its initial target-context guard or any
subsequent per-callee `b()` admission. The transfer operation must already be
bound to the source channel, and the core Local-call gate must validate it and
reserve a Local-attempt child before calling the Local driver. However, a gate
at core `ast_call()` sees the Local owner (`;1`) before
`ast_unreal_call_setup()` copies datastores to `;2`. That setup calls
`ast_channel_datastore_inherit()` and ignores its return value before
`ast_pbx_start()` ([inherit then PBX start](https://github.com/asterisk/asterisk/blob/22.11.0/main/core_unreal.c#L870-L929)).
Because inheritance can omit the datastore or leave a NULL duplicate payload,
the `;1` gate does not prove that the detached PBX thread's `;2` channel has a
usable claim.

To admit this path safely, a synchronous validation/claim gate is required
after `ast_unreal_call_setup()` and before `ast_pbx_start()`; it must reject
the Local call if `;2` lacks a valid generation-bound claim, without starting
PBX work. A guard as the first dialplan priority is useful defense in depth,
but is later than the Local driver's PBX-thread creation and does not by itself
preserve the parking/transfer source call on rejection. Callback state added
after the parking Local call is too late to establish that lineage: at that
point the `;1` to `;2` copy has already run, so attaching a datastore to `;1`
in the callback cannot repair `;2` or stop its PBX thread. If the deployed
hook set cannot validate at the post-inheritance/pre-PBX boundary, disable/
exclude this Local parking path.

The pinned `main/core_local.c` path exposes no existing callback at that
boundary: `local_call()` invokes `ast_unreal_call_setup()` and then directly
calls `ast_pbx_start()` for its dialplan action, with no `ast_pre_call()` or
other admission dispatch in between
([Local call action](https://github.com/asterisk/asterisk/blob/22.11.0/main/core_local.c#L691-L762)).
The Local channel-tech initializer does not install a `pre_call` override, and
`ast_pre_call()` is an explicit helper used by its callers, not an automatic
part of `ast_call()` or `ast_pbx_start()`. Therefore a synchronous
post-inheritance/pre-PBX admission check is not available merely by loading a
PJSIP supplement or configuring a dialplan Gosub. Supporting this route appears
to require a version-pinned change to the Local/core call path (or another
demonstrated hook with identical timing); that change must preserve existing
Local dialplan, bridge, and masquerade actions and be re-audited on every
Asterisk upgrade. Without such an approved core change, exclude this parking
Local path from generation-protected transfers.

The failed parking attempt can also invoke the callback before bridge
insertion, then fall through and invoke it again on a different channel. The
owner must model the parking Local attempt as its own child of the reserved
operation, settle that child as failed if the Local is torn down, and create a
fresh child for ordinary-transfer fallback. Callback retry must be idempotent
for operation identity without reusing one datastore node across channels or
counting two channel attempts as one unsettled child. Otherwise parking must be
excluded. The source-level sequence suggests a fail-closed fallback may be
possible; it does not prove source-call preservation, target-PBX race handling,
or exact claim settlement.

Repeated callback handling also needs a REFER-progress ownership check. In the
multi-party parking path, the Local call succeeds and the parking callback runs
before `ast_bridge_impart()`; if that bridge insertion then fails, the parking
provider returns failure and core invokes ordinary transfer with the same
wrapper
([fallback reuses wrapper](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge.c#L4700-L4736)).
By contrast, a rejected Local `ast_call()` returns before the parking callback,
so that specific failure does not initialize progress twice.
When progress monitoring is active, each invocation reassigns the single
progress object's `transfer_data`, `transferee`, `framehook`, and `bridge_sub`
fields. The callback takes new AO2 references to the transfer wrapper and
progress object and creates a framehook and Stasis subscription, but has no
visible prior-state cleanup or already-initialized guard
([progress setup](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L838-L907),
[single-field destructor cleanup](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L522-L548)).
If parking and ordinary fallback both invoke this callback for one REFER, the
second setup can overwrite the first target correlation and resource handles;
the older bridge subscription's handle is then no longer available through
`progress->bridge_sub`. Each subscription has a corresponding explicit progress
reference released by its final-message callback; Stasis sends that final
message on unsubscribe
([subscription reference](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L880-L907),
[final callback release](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L272-L283),
[unsubscribe final-message sequence](https://github.com/asterisk/asterisk/blob/22.11.0/main/stasis.c#L1049-L1086)).
Thus the second setup appears to orphan the first subscription/reference unless
another path retains and unsubscribes that handle; it can continue receiving
events against the overwritten target fields. The overwritten framehook handle
also means progress-state teardown no longer identifies the first channel's
hook (though teardown of that channel may destroy it). These are source-level
lost-reference/resource-cleanup candidates, not runtime-confirmed leaks.
Validate them and require an upstream fix or explicitly exclude the fallback
before relying on it. This is separate from making transfer-attempt claims
independently idempotent and settled.

There is a more specific stale-subscription hazard in that retry scenario:
`refer_progress_bridge()` receives the subscription that delivered the event
as `sub`, but on a matching target event it unsubscribes
`progress->bridge_sub` instead
([callback uses stored handle](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L272-L309)).
After repeated setup, that field points to the newer subscription. The older
subscription can therefore match the newly overwritten `transferee` identity,
send progress for the newer attempt, and unsubscribe the newer subscription
instead of itself. Subsequent events can revisit the still-live old callback;
the exact number/order of notifications and cleanup effects depends on
concurrency and event delivery. The synthetic bridge-insertion-failure case
must observe which subscription handles are live and verify each callback
unsubscribes itself, not merely assert that one terminal notification arrived.

These progress fields are also shared between the synchronous transfer callback,
the bridge subscription callback, and the channel framehook. The callback
assigns `transferee`, `transfer_data`, `framehook`, and `bridge_sub` outside a
common lock; the bridge callback reads the target and completion fields before
locking the channel, and framehook execution is serialized by that channel's
lock only. That per-channel lock does not protect the shared progress object
from callbacks on a different subscription or from reinitialization on another
channel. AO2 references preserve object lifetime, not mutual exclusion. This
makes the repeated-setup concern a potential cross-thread state race as well
as a lost-resource problem; source inspection alone cannot prove the runtime
interleaving or impact. The proof/fix must synchronize progress-state
publication and teardown across all three paths, or exclude the failing-parking
retry while progress monitoring is active.

The bridge-insertion failure is also later than target PBX startup: the parking
Local's successful `ast_call()` invokes `ast_pbx_start()` on its paired channel,
which starts the target dialplan on a detached thread before the callback and
`ast_bridge_impart()`
([Local PBX start](https://github.com/asterisk/asterisk/blob/22.11.0/main/core_local.c#L725-L762),
[parking call/callback/bridge order](https://github.com/asterisk/asterisk/blob/22.11.0/res/parking/parking_bridge_features.c#L257-L293),
[post-callback bridge failure](https://github.com/asterisk/asterisk/blob/22.11.0/res/parking/parking_bridge_features.c#L383-L398)).
Core then tries ordinary transfer to the same destination, which creates and
calls another Local channel
([ordinary fallback Local](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge.c#L4337-L4371)).
Hanging up the first Local after bridge-insertion failure does not, by source
ordering alone, prove its target dialplan was stopped before a call-producing
priority signaled a leg. Thus this fallback can present overlapping attempts
to the same destination, in addition to the REFER progress-state problem. Safe
support must prove the first attempt cannot signal before fallback or that its
signaled work is uniquely claimed and canceled/settled before a replacement is
started; otherwise disable this fallback path.

The ordinary-transfer failure branches provide a bounded source-call
preservation signal, but only for those branches: multi-party handling hangs
up the attempted Local and returns failure when its `ast_call()` fails, before
`ast_bridge_impart()` can replace the transferer
([call-fail branch](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge.c#L4363-L4371)).
For a two-party transfer, a failed bridge-action enqueue returns before
`ast_bridge_remove(bridge, transferer)`
([queue failure before removal](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge.c#L4747-L4754)).
The built-in PJSIP REFER handler maps a core transfer failure to SIP `500` and
cancels deferred session termination for a non-`200` result
([result mapping](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L711-L729),
[deferred termination handling](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1822-L1829)).
This supports a testable expectation that these specific pre-commit failures
do not intentionally remove the original transferer from its bridge. It does
not establish that every parking failure is pre-commit, that no concurrent
hangup/bridge action races the return, or that the operation/attempt claims
settle correctly. The synthetic proof must check the original channel and
bridge state after both parking-Local rejection and normal-fallback rejection,
along with the response and exact claim counts.

For the supported `Dial()` and `Queue()` paths, source confirms that each
application explicitly calls `ast_channel_datastore_inherit()` on every
requested callee before invoking its per-callee `b()` Gosub:
[Dial inheritance and hook](https://github.com/asterisk/asterisk/blob/22.11.0/apps/app_dial.c#L2771),
[Queue inheritance and hook](https://github.com/asterisk/asterisk/blob/22.11.0/apps/app_queue.c#L5063).
The hook is then run before `ast_call()` in both applications
([Dial](https://github.com/asterisk/asterisk/blob/22.11.0/apps/app_dial.c#L2887),
[Queue](https://github.com/asterisk/asterisk/blob/22.11.0/apps/app_queue.c#L5084)).
This resolves the narrow correlation gap left by `session_create`: the latter
still lacks the requestor channel, but the pre-call Gosub runs on the already
created called channel, where trusted inherited state can be examined.

This is not a core-level admission guarantee by itself. `ast_pre_call()` uses a
channel-technology `pre_call` override when present, otherwise it executes the
Gosub ([callback field](https://github.com/asterisk/asterisk/blob/22.11.0/include/asterisk/channel.h#L861),
[dispatch](https://github.com/asterisk/asterisk/blob/22.11.0/main/channel.c#L6461)).
A source scan of Asterisk 22.11.0's in-tree channel-driver locations
(`channels/`, `addons/`, and `main/`) found no driver assigning this override;
the PJSIP driver also has no such initializer. This makes the configured
Gosub path apply to the pinned in-tree drivers, but it is not a contract for
out-of-tree channel modules, vendor patches, or future drivers.
Deployment qualification must inventory loaded channel technologies and
reject any unaudited driver that may install a `pre_call` override, or verify
that the override itself invokes the same serialized admission owner and
fails closed. A static dialplan check cannot establish that property.
The custom Gosub must call the in-process owner synchronously. That operation
must, under the same serialization boundary as drain, verify the inherited
operation claim and open generation, then register a unique per-callee pending
claim before returning. On denial, missing/invalid state, or allocation error,
the Gosub must hang up the callee; both applications call `ast_call()` next,
and core `ast_call()` skips the channel driver's call method for a hung-up
channel ([guard](https://github.com/asterisk/asterisk/blob/22.11.0/main/channel.c#L6478)).
This makes a pre-fence claim remain visible as pending even if signaling starts
after the fence; the fence must wait for that claim to settle. It does not make
the target leg disappear or cancel an already claimed attempt.

There is a confirmed forwarding bypass in the pinned `Dial()` implementation.
The per-callee `b()` Gosub runs for the initially requested channels before
their first `ast_call()` ([hook then call](https://github.com/asterisk/asterisk/blob/22.11.0/apps/app_dial.c#L2904-L2918)).
If a called channel requests forwarding later, `do_forward()` requests a
replacement and inherits datastores from the inbound channel, then calls
`ast_call()` on that replacement directly ([replacement inheritance and call](https://github.com/asterisk/asterisk/blob/22.11.0/apps/app_dial.c#L1000-L1012),
[direct call](https://github.com/asterisk/asterisk/blob/22.11.0/apps/app_dial.c#L1122-L1138)).
That new channel does not pass through the earlier `ast_pre_call()`/`b()` gate.
It may inherit the parent operation marker, but it has no newly registered
unique child-leg claim before signaling. The original child claim is not a
substitute: it is associated with another channel and may settle independently
of the forwarded target. Consequently, the current per-callee hook proposal
does not cover forwarded calls and cannot certify a safe count for that path.

Asterisk documents Dial option `i` as ignoring forwarding requests for that
dial attempt ([option definition](https://github.com/asterisk/asterisk/blob/22.11.0/apps/app_dial.c#L245-L247)).
For a closed route, forcing and validating `i` on every protected `Dial()` is
one possible containment, but it changes forwarding behavior and is not yet
approved as the product policy. Otherwise forwarding needs a separately proven
pre-signal admission hook on every replacement channel. A generated route
guard alone is insufficient because the forwarding replacement is made inside
`Dial()` and is signaled without re-entering that route's `b()` Gosub.

`Queue()` has the same shape when member forwarding is enabled. Its
per-callee Gosub runs on the initially requested member channel before its
first `ast_call()` ([Queue hook and call](https://github.com/asterisk/asterisk/blob/22.11.0/apps/app_queue.c#L5084-L5091)).
Later, `wait_for_answer()` creates a replacement channel for a member forward,
inherits datastore state from the queued caller, and calls `ast_call()` on the
replacement without rerunning that Gosub ([forward replacement](https://github.com/asterisk/asterisk/blob/22.11.0/apps/app_queue.c#L5568-L5617),
[direct call](https://github.com/asterisk/asterisk/blob/22.11.0/apps/app_queue.c#L5678-L5685)).
The inherited parent marker does not create a distinct child-leg claim for the
replacement, so the initial member claim cannot prove its ownership.

Unlike `Dial()`, `Queue()` documents option `i` to ignore member call-forward
requests ([option](https://github.com/asterisk/asterisk/blob/22.11.0/apps/app_queue.c#L186-L189)).
The implementation defaults forwarding to allowed and sets it disallowed when
`i` is present ([default and option handling](https://github.com/asterisk/asterisk/blob/22.11.0/apps/app_queue.c#L7289-L7290),
[flag handling](https://github.com/asterisk/asterisk/blob/22.11.0/apps/app_queue.c#L7344-L7346)).
For a protected route, requiring and validating Queue option `i` is a
candidate containment; if member forwarding must remain supported, a separate
replacement-channel admission hook is required. Queue `i` only addresses this
member-forward path; technology-level redirects and other call-producing
mechanisms remain distinct coverage obligations.

PJSIP endpoint `redirect_method` is an additional effective-configuration
boundary. In Asterisk 22.11 it defaults to `user`; its `user` and `uri_core`
modes set the channel's call-forward target, which re-enters the application
forwarding behavior above. Its `uri_pjsip` mode instead returns
`PJSIP_REDIRECT_ACCEPT` from the PJSIP redirect callback; the documented
behavior is to follow the redirect inside `chan_pjsip`, expose no redirect to
the core, support multiple potential targets, and make redirection impossible
to prevent through core handling ([endpoint setting and limitation](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip/pjsip_config.xml#L671-L686),
[callback](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_session.c#L5517-L5565),
[default](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip/pjsip_configuration.c#L2379)).
That may remain within the same Asterisk channel object, so it is not by itself
proof of an extra PBX channel or a second destruction callback. It does,
however, bypass the application admission hook and destination allowlist, and
one channel-level claim cannot certify each of the multiple potential redirect
targets. Protected endpoints must therefore reject `uri_pjsip` mode unless a
PJSIP-level hook validates and individually accounts for every selected target.
`Dial`/`Queue` option `i` cannot be relied on to stop this mode because it is
not exposed as a core call-forward request.

The pre-call Gosub is also not a universal Asterisk originate hook. In the
pinned source, `pbx_outgoing_attempt()` enables `ast_dial`'s predial routine
only when a nonempty predial Gosub is supplied, then runs `ast_dial_prerun()`
before starting the outgoing call ([optional predial setup and prerun](https://github.com/asterisk/asterisk/blob/22.11.0/main/pbx.c#L6021-L6045)).
The ordinary outgoing APIs pass no Gosub by default; AMI Originate can pass an
optional Gosub for its extension path, but its application path calls the
non-predial outgoing-app function, and the asynchronous originate worker uses
the non-predial extension function ([AMI originate paths](https://github.com/asterisk/asterisk/blob/22.11.0/main/manager.c#L4456-L4468),
[AMI application/extension dispatch](https://github.com/asterisk/asterisk/blob/22.11.0/main/manager.c#L5444-L5455)).
Thus an AMI-originated call can signal its initial destination without the
protected route's `b()` hook.

ARI's channel-create action requests the outbound channel and places it in a
Stasis application; its channel-dial control later calls `ast_call()` directly
on that channel ([ARI channel request](https://github.com/asterisk/asterisk/blob/22.11.0/res/ari/resource_channels.c#L2212-L2228),
[ARI Stasis dial](https://github.com/asterisk/asterisk/blob/22.11.0/res/stasis/control.c#L1701-L1736)).
When an originator is supplied, ARI also inherits its datastore state to the
new channel, but that copy is not a synchronized per-leg admission claim
([inheritance](https://github.com/asterisk/asterisk/blob/22.11.0/res/ari/resource_channels.c#L2324-L2349)).
The generic `ast_dial` API likewise executes the predial callback only when
its caller explicitly enables that optional setting
([option is caller-set](https://github.com/asterisk/asterisk/blob/22.11.0/main/dial.c#L199-L205),
[conditional invocation](https://github.com/asterisk/asterisk/blob/22.11.0/main/dial.c#L418-L426)).
Its forwarding path differs from the `Dial()`/`Queue()` application bypass:
`handle_call_forward()` drops the old owner and re-enters
`begin_dial_channel()`, which requests the replacement and runs the same
configured predial callback before its `ast_call()`
([forward re-entry](https://github.com/asterisk/asterisk/blob/22.11.0/main/dial.c#L498-L547),
[replacement request, inheritance, and predial](https://github.com/asterisk/asterisk/blob/22.11.0/main/dial.c#L330-L426)).
This is still conditional coverage, not a universal guarantee: every
`ast_dial` caller must configure and preserve the admission callback, and the
callback must not rely on inherited parent state when that caller has no
requestor channel. Alternatively, that instance must disable forwarding.
These paths must be included in the supported call matrix: either provide a
PBX-owned serialized gate before every direct `ast_call()`/originate operation,
or disable/restrict the relevant AMI/ARI surfaces and in-process callers.
Dialplan route guards, `Dial()` option `i`, and `Queue()` option `i` do not
contain a direct API call.

A wider `ast_call()` inventory also identifies call-producing paths outside
those APIs and the two dialplan applications:

- `FollowMe()` creates Local destination channels, inherits caller datastores,
  runs its predial Gosub only when configured, and then calls `ast_call()`
  ([channel setup and optional hook](https://github.com/asterisk/asterisk/blob/22.11.0/apps/app_followme.c#L1109-L1149),
  [signal](https://github.com/asterisk/asterisk/blob/22.11.0/apps/app_followme.c#L1173-L1185)).
  It needs an explicit feature policy and per-destination admission; it does
  not inherit `Dial()`'s `b()` guarantee.
- Core `ast_call_forward()` creates and calls a replacement channel directly
  ([replacement setup and signal](https://github.com/asterisk/asterisk/blob/22.11.0/main/channel.c#L5943-L5989)).
  The request-and-dial helper also signals its requested channel and follows
  forwarding responses directly
  ([request-and-dial](https://github.com/asterisk/asterisk/blob/22.11.0/main/channel.c#L5995-L6000),
  [initial signal and forward loop](https://github.com/asterisk/asterisk/blob/22.11.0/main/channel.c#L6079-L6099)).
  Neither boundary guarantees execution of a dialplan callee `b()` hook.
- Bridge transfer helpers create Local/target channels and call them directly.
  The multi-party blind-transfer callback is one specific interception point,
  not coverage of every bridge transfer route
  ([blind-transfer Local call](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge.c#L4336-L4368),
  [other bridge transfer Local call](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge.c#L4454-L4493)).
  Attended-transfer target dialing and recall are separate paths and remain
  outside the initial supported set unless integrated or disabled
  ([attended target](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge_basic.c#L3464-L3484),
  [recall target](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge_basic.c#L2638-L2679)).
- Parking bridge features can create a Local replacement and call it directly
  ([parking target](https://github.com/asterisk/asterisk/blob/22.11.0/res/parking/parking_bridge_features.c#L264-L293)).
  Parking must therefore be blocked or covered at the actual feature path,
  not merely omitted from generated dialplan.
- The DAHDI/PRI idle-dial facility originates its configured destination via
  `ast_call()` ([idle dial](https://github.com/asterisk/asterisk/blob/22.11.0/channels/sig_pri.c#L2007-L2029)).
  If this driver/feature is present, deployment policy must classify and
  restrict it so maintenance traffic cannot become an unclaimed customer leg.

A source-wide scan of the pinned C tree found one invocation of a channel
technology's `->call()` method: the dispatch inside core `ast_call()`
([dispatch and lock scope](https://github.com/asterisk/asterisk/blob/22.11.0/main/channel.c#L6478-L6492)).
That function checks channel state and invokes the technology method while
holding the channel lock; it does not invoke `ast_pre_call()` or any common
admission callback. This makes `ast_call()` the strongest candidate boundary
for a core-level admission hook, not evidence that such a hook already exists.
It also means dialplan Gosubs alone cannot establish complete coverage of the
enumerated source-tree callers.

The channel-tech contract confirms this is not synonymous with "external
INVITE": the Local driver's `call` method can inherit state to its paired
channel and start dialplan, join a bridge, or perform a masquerade
([Local setup and action dispatch](https://github.com/asterisk/asterisk/blob/22.11.0/main/core_local.c#L691-L785)).
The PJSIP driver's `call` method releases the channel lock and synchronously
pushes call setup through the session serializer before reacquiring it
([PJSIP call method](https://github.com/asterisk/asterisk/blob/22.11.0/channels/chan_pjsip.c#L2524-L2547)).
Accordingly, a central gate inserted at the current `ast_call()` dispatch
would run with the channel lock held, before technology-specific lock handoff
and work. The gate must not wait on network/broker operations; any owner lock
or cross-channel acquisition needs an explicit lock-order/deadlock proof.

If that boundary is explored, its contract must distinguish an admitted
Local/control operation from the eventual customer-facing channel-driver leg.
It must avoid both an unclaimed route through a Local channel and
double-counting the same logical leg at Local and terminal channels. It must
also define behavior for calls with no trusted parent claim, re-entrant or
repeated calls on one channel, claim settlement on failed calls, and
non-customer maintenance/diagnostic calls. A core `ast_call()` hook would
still not observe a PJSIP 3xx target followed internally by `chan_pjsip`; that
technology-level redirect needs its own gate or exclusion. Treat a central
hook as a feasibility/design candidate only; no core patch or implementation
is selected.

The boundaries have distinct responsibilities and must not be collapsed into
one generic "call count":

1. A transfer-operation claim is reserved by the transfer owner before
   asynchronous work is queued. The pinned two-party blind-transfer callback
   runs before queueing, while the multi-party callback runs on the newly
   created Local channel before its call starts
   ([two-party ordering](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge_channel.c#L3017-L3035),
   [multi-party ordering](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge.c#L4336-L4368)).
   The bridge callback is a candidate to bind that operation claim, but only a
   purpose-built transfer owner can define rejection, retransmission, and
   failure settlement.
2. A core `ast_call()` admission point, if implemented, can reject an
   unapproved Local/control invocation before its technology method starts,
   and can gate direct channel calls. It cannot replace the earlier transfer
   reservation: the two-party transfer work is already queued by then.
3. Per-callee `b()`/`ast_pre_call()` gates create distinct child-leg claims
   for supported Dial/Queue branches. A transferred operation claim is their
   parent, not a substitute for each fork's child claim.

#### Candidate operation identity and state contract

The serialized owner needs two identities, not one reusable transfer token:

- An **operation identity** is bound to the protected generation, originating
  Asterisk session/dialog, and one incoming REFER transaction. The owner must
  derive the transaction component from verified PJSIP request fields and
  distinguish a retransmission of that request from a new REFER. The
  normalized destination/context is immutable operation data and must be
  validated against policy; it is not a replacement for transaction identity.
  The pinned REFER handler allocates progress state and dispatches each time it
  enters `refer_incoming_refer_request()`; it does not itself record or compare
  a CSeq/transaction key
  ([fresh progress allocation and dispatch](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L1982-L2067)).
  PJSIP's transaction layer may handle wire retransmissions before this point,
  but that behavior must be verified; a custom owner must not assume either
  transaction-level deduplication or safe application-level replay.
- An **attempt identity** is created for each distinct channel execution that
  can start transfer work. Re-entry on the same operation/channel/transfer
  type is idempotent, but parking's failed-insertion fallback uses a different
  Local channel and therefore needs a fresh attempt child. Each actual
  Dial/Queue callee gets its own child-leg identity beneath its attempt.

The candidate state progression is `reserved -> attempting -> queued/active ->
settling -> terminal`. Reservation must occur in the transfer owner before
calling the bridge API and remain a drain obligation while queue outcome or
target execution is unresolved. A successful two-party enqueue advances the
operation but does not mean a target leg exists; the per-callee gate must
create its child before signaling. Every distinct parking or ordinary Local
attempt must be represented before it can start PBX work, and target branches
must remain children until their own final channel/session outcome is
reconciled. Do not decrement the parent merely because a callback returned,
the Local optimized out, a REFER response/NOTIFY arrived, or one fork ended.

A definitive pre-enqueue failure settles only the attempt(s) that did not
start, and settles the operation only when no asynchronous work or child
remains. A rejected child admission settles that child before signaling; if
the result is uncertain (for example, call setup or cancellation has no
authoritative terminal event), retain the obligation and block zero/replacement.
Late events are idempotently applied to the matching operation/attempt/leg and
must not alter a newer transfer's state. Enforce at most one outstanding
operation per source session until a terminal outcome is reconciled; a second
independent REFER is rejected or deferred by explicit policy, never allowed to
overwrite progress or operation correlation.

The REFER supplement's `incoming_request` is called synchronously from
`handle_incoming()` on a SIP servant thread; the pinned REFER handler dispatches
directly into its request parser and transfer owner. This handler path shows no
per-session owner serializer or active-operation latch
([supplement thread contract](https://github.com/asterisk/asterisk/blob/22.11.0/include/asterisk/res_pjsip_session.h#L319-L335),
[session request dispatch](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_session.c#L4462-L4476),
[REFER direct dispatch](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_refer.c#L2104-L2110)).
This does not establish whether PJSIP's dialog/transaction machinery serializes
two distinct in-dialog REFERs before the supplement. Do not infer such a
guarantee from the servant-thread contract or from transaction retransmission
handling. The owner needs an atomic, bounded per-source-session reservation;
it must reject a second distinct operation while one remains unresolved, and
must not block the SIP servant on broker, network, database, or long-running
work. Verify on-wire retransmissions and concurrent distinct CSeq REFERs
separately, including a case where the first transfer is queued but its target
has not yet reached the per-callee admission hook.

The callback's `void` contract makes allocation after entry unsafe as the only
claim-creation strategy. The owner must pre-reserve enough operation/attempt
state for every callback that can run, or provide a separately proven
abortable gate before any action starts. Since the callback cannot signal
failure to Asterisk, missing capacity/state must never be represented by
continuing with an unowned route. This contract is design-only: the exact
operation key, pre-reservation bounds, lock/serializer ownership, channel
handoff, and PJSIP response behavior still need source/API and isolated-test
proof. In particular, the multi-party parking callback occurs after Local PBX
start, so this contract cannot make that path safe without the separately
required post-inheritance/pre-PBX gate.

Handoff must be atomic with drain: retain the operation obligation while
creating/attaching child obligations, then settle the parent only when its
children are durably owned or the operation has definitively failed. For the
multi-party Local route, the claim must remain valid through `;1` to `;2`
inheritance, Local optimization, and the target-context guard. A central
`ast_call()` hook alone cannot prove this lineage or cover technology-internal
redirects. The combined callback/core/per-callee design is still only a
candidate contract; its ownership, lock order, and every terminal path need a
separate proof before implementation.

The blind-transfer callback is not a cancellable admission callback: its
`void` return means attachment failure cannot reject the already-entered bridge
operation. Add explicit proof cases for callback attachment failure and for
bridge enqueue failure after successful attachment. The former must be
impossible by construction or intercepted before changing the existing call;
the latter must settle the reserved transfer claim exactly once. A target-route
guard that merely hangs up after transfer acceptance does not satisfy the
existing-call-preservation requirement.

Inheritance remains fallible. `ast_channel_datastore_inherit()` silently omits
the child datastore if datastore allocation fails, and it can insert a
datastore whose duplicated `data` is NULL if the duplicator fails, while
returning success ([implementation](https://github.com/asterisk/asterisk/blob/22.11.0/main/channel.c#L2357)).
The admission operation must validate both datastore presence and a usable,
generation-bound payload, then fail closed before `ast_call()`. For forked
calls, it must create a distinct child-leg record per callee rather than count
one inherited transfer token as all branches. Queue waiting remains covered by
its parent operation claim independently of these member-leg claims.

The transfer callback can therefore provide the parent claim on the channel
that will execute the target dialplan: the transferee in the two-party case or
the new Local channel in the multi-party case. For the multi-party path, the
pinned implementation is `main/core_local.c` plus `main/core_unreal.c` (not a
`channels/chan_local.c` module). `ast_request("Local", ..., transferer, ...)`
returns the Local owner (`;1`); the bridge transfer callback runs on that
channel, then `ast_call(local, ...)` invokes the Local driver's call method.
That method calls `ast_unreal_call_setup(owner, chan)` to copy channel variables
and inherit datastores from `;1` to its paired `;2`, then starts the target
context on `;2` with `ast_pbx_start()`. The fixed target dialplan therefore
needs its own check before further dialplan work can create legs. Its later
`Dial()`/`Queue()` per-callee hook can validate the copied parent operation and
create distinct pending claims for each target branch.

This closes the *ordering* question for the ordinary multi-party Local path,
not the failure or complete-lifecycle questions. The `;1` to `;2`
`ast_channel_datastore_inherit()` uses the same fallible duplicate behavior:
allocation or duplicate-payload failure can omit usable state without making
the Local call fail. The target context must start in a generated guard that
validates the operation marker and terminates the Local call path before it can
reach any dial, queue, redirect, or other call-producing application if state
is absent or malformed. The Local request in the transfer path has no `/n`
option, so Local optimization is not disabled; the marker and operation/child
claim lifetimes must remain correct through Local optimization/masquerade and
the ultimate channel's terminal events. The fixed target route must retain the
parent operation obligation while running `Dial()`/`Queue()`. Whether
optimization, call forwarding, non-PJSIP technologies, or any other supported
path preserves or invokes the same owner is still an explicit coverage proof,
not an assumption.

The source trace makes the optimization boundary more specific: the Local
driver calls `ast_bridge_unreal_optimize_out()` when it detects an eligible
bridge state ([Local trigger](https://github.com/asterisk/asterisk/blob/22.11.0/main/core_unreal.c#L295-L308)).
The bridge code may swap a bridge channel or merge bridges while kicking the
two unreal/Local channels out ([swap and merge paths](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge.c#L2954-L3013),
[merge path](https://github.com/asterisk/asterisk/blob/22.11.0/main/bridge.c#L3078-L3127)).
These are bridge membership operations, not a general contract that a
datastore attached to `;1` or `;2` is copied to the surviving target channel.
A separate channel masquerade does run datastore `chan_fixup` and
`chan_breakdown` callbacks and moves datastores from the clone channel to the
survivor ([datastore callbacks](https://github.com/asterisk/asterisk/blob/22.11.0/include/asterisk/datastore.h#L36-L60),
[masquerade datastore handling](https://github.com/asterisk/asterisk/blob/22.11.0/main/channel.c#L7111-L7142)),
but that behavior must not be assumed for the Local bridge swap/merge path or
treated as proof of child-leg completion.

Consequently, the channel datastore is an association to a claim in the
in-process owner, not the claim's sole lifetime authority. The owner must keep
the transfer operation open while any child-leg claim remains unsettled; a
Local `;1`/`;2` hangup or optimization-finished callback cannot release that
parent obligation while a target leg is still active. Each real target callee
must acquire its own child claim before signaling, and its own terminal
channel lifecycle must settle that claim exactly once. On Local optimization,
the owner must still correlate the surviving target to that child claim without
depending on the Local datastore being transferred. If the selected Asterisk
hook set cannot observe that surviving channel and its terminal state, the
path is not safely covered and must fail closed or be excluded.

One candidate terminal signal for a child claim is the datastore's `destroy`
callback on the actual callee channel. Asterisk invokes this callback while
destroying the channel's datastores; the channel destructor publishes its final
Stasis snapshot before it frees those datastores
([channel teardown](https://github.com/asterisk/asterisk/blob/22.11.0/main/channel.c#L2179-L2217),
[datastore destroy](https://github.com/asterisk/asterisk/blob/22.11.0/main/datastore.c#L68-L94)).
This is a conservative reclamation point, not a hangup-time notification:
channel references can delay destruction after hangup, leaving the claim
outstanding longer rather than falsely reaching zero. Stasis delivery is
separate and asynchronous; observing its final snapshot must not itself be
treated as the serialized claim-release operation.

The callback is invoked synchronously during teardown with the channel locked.
It must not perform network/database work, wait for another thread, or acquire
locks in an order that can deadlock against channel operations. Any completion
handoff to the claim owner must be bounded and idempotent. If that handoff
cannot be recorded, the claim must remain outstanding (safe over-count) and
raise an operationally visible error; it must never be silently converted to
settled. The owner must also be protected from module unload while callbacks
can still run. The datastore should identify one specific child claim, not
settle a parent operation merely because an inherited Local-channel copy is
destroyed. Masquerade fixup/breakdown must preserve the child association on
the surviving channel and cannot settle it as a side effect.

This makes datastore teardown a source-supported candidate for eventual
per-callee settlement, not yet a complete lifecycle proof. The design must
still prove exactly one settlement across normal hangup, failed `ast_call()`,
fork cancellation, channel masquerade, forwarding/re-dial, Local-to-Local
targets, and unload/restart. If precise call teardown and generation-drain
latency require release at hangup rather than final object destruction, a
separate synchronous hook is needed, with its own lock-order and failure proof.

The callback itself returns `void`, so any callback-side condition that could
leave the transfer queued/executing without a valid claim must fail closed.
Whether preallocation plus locked datastore insertion is sufficient for every
supported path, including teardown races and duplicate datastore prevention,
remains a proof obligation.

This refines—but does not close—the custom REFER candidate. A purpose-built
PJSIP supplement could synchronously reserve the operation, validate the
normalized target/context, call the bridge transfer API with the propagation
callback, and own the SIP response/progress lifecycle. It still must prove the
claim can be atomically attached and followed through early dialogs, each
forked branch, and terminal outcomes. The built-in DTMF transfer path uses its
own callback, so it must remain disabled or be separately intercepted; parking
must likewise be disabled or covered.

This is currently the strongest source-supported candidate to test in a design
review, not a selected implementation. The next design should specify the
transfer-operation claim, per-callee child claims, duplicate/retransmission
behavior, and terminal release protocol. It must also prove that the target
dialplan cannot omit or bypass the admission Gosub and that callback attachment
failure cannot leave queued work unowned. Only after that review should an
isolated proof be proposed for approval.

These APIs make an in-process PJSIP gate technically plausible, but do not
prove coverage of every queue, transfer, redirect, channel technology, or call
direction. `incoming_request` runs on a SIP servant thread, so it must not wait
on the broker, database, or network. All admission hooks need bounded
in-process state, and the caller-thread behavior of `session_create` must be
confirmed before implementation. The exact session mapping, callback ordering,
SIP response behavior, in-flight claim accounting, and unload/restart behavior
remain proof obligations.

The supplement also exposes `session_begin`, `session_end`, and
`session_destroy`. Asterisk calls
[`session_end`](https://github.com/asterisk/asterisk/blob/22.11.0/res/res_pjsip_session.c#L4501)
when the session is marked dead, but its
[callback contract](https://github.com/asterisk/asterisk/blob/22.11.0/include/asterisk/res_pjsip_session.h#L305)
warns it may run outside a SIP servant thread. Treat this as one idempotent
lifecycle input, not a standalone numeric-zero assertion: all forked sessions,
early dialogs, queued work, channel/bridge transitions, and transfer-created
legs still need generation attribution and complete settlement.

| Case | Required result |
| --- | --- |
| Inbound test route to queue to browser agent | New work is admitted only for the exact generation; queue waiting and each outbound member branch are accounted for. |
| Blind transfer to an allowed same-customer internal destination while open | Target admission is generation-bound before signaling; source/target ownership is continuous through success, rejection, cancellation, and timeout. |
| Blind transfer racing the irreversible fence | Admission and fence serialize; either the new leg is claimed before the fence and remains counted, or it is rejected after the fence. |
| Blind transfer requested after fence | No new generation-owned target leg is signaled; the existing call remains intact and tracked. |
| Blind-transfer callback cannot attach its preallocated claim | This must be impossible by a proven invariant or an earlier abortable gate must reject before altering the existing call; a missing claim followed by queued transfer or target-route hangup is a failure. |
| Bridge action enqueue fails after callback attached the transfer claim | The source call remains in a defined safe state and the transfer-operation claim is settled exactly once; no false zero occurs during callback/API return. |
| Two-party blind-transfer enqueue fails after progress hook attachment | Force queue failure while transferee frames are still flowing; capture final REFER response and all terminal NOTIFY sipfrags/order, prove any hook-generated `200` cannot mask the core failure or failure NOTIFY, create a target leg, or settle the transfer claim as successful. |
| Terminal progress NOTIFY allocation fails after voice-derived answer | Inject allocation failure after `subclass` is set; prove repeated voice frames do not leave progress permanently unreported or the hook/resources stranded, and verify no missing terminal notification is treated as transfer/claim settlement. Test separately from explicit answer-control frames and bridge-entry notification. |
| Terminal progress task enqueue fails after notification allocation | Force `ast_sip_push_task()` failure for terminal framehook and bridge-entry reports; verify notification loss is observable/recoverable through independent channel and claim lifecycle evidence, monitor cleanup does not imply transfer completion, and the operation remains unresolved rather than being settled from an absent NOTIFY. |
| Two-party enqueue failure with `refer_blind_progress=no` | Force the callback's early terminal `200` NOTIFY followed by enqueue failure; record that NOTIFY, the final non-200 REFER response, and the queued failure NOTIFY independently, and prove no success is inferred or claim settled from the first sipfrag. |
| Multi-party blind transfer through parking where any inheritance hop fails or bridge insertion fails | Validate source-to-`;1` and `;1`-to-`;2` payloads, then gate `;2` after `ast_unreal_call_setup()` and before `ast_pbx_start()`; prove inheritance depth through each target branch and make fallback create/settle a distinct attempt claim. Callback attachment to `;1` after Local setup must not be treated as repairing `;2`. |
| Parking Local admission rejected, then ordinary-transfer fallback rejected | Confirm both attempted Locals are torn down, the original transferer remains in its original bridge absent a concurrent hangup, the final REFER failure response is observed, and parking/fallback attempt plus parent claims settle exactly once. The failed parking Local must not run its callback or start an unowned target PBX. |
| Multi-party parking Local succeeds, callback runs, then bridge insertion fails into ordinary-transfer fallback | Force the `ast_bridge_impart()` failure after the parking callback; verify stale and current bridge subscriptions correlate only their own target and unsubscribe themselves; confirm exactly one terminal outcome is reported for the correct target, all framehooks/subscriptions/references are cleaned, the original call remains safe on any later fallback rejection, and parking/fallback/parent claims settle exactly once. |
| Multi-party parking Local target PBX races bridge-insertion fallback | Hold the first Local target route at each call-producing boundary while forcing bridge insertion failure; prove no target leg can signal unclaimed or overlap the ordinary fallback leg, and prove any already-signaled first-attempt children remain counted and settle before the parent operation closes. Otherwise exclude this fallback. |
| Invalid, unknown, or other-customer target | Earlier admission supplement sends a final rejection before built-in progress/subscription handling; no transfer operation, target INVITE, or success-shaped NOTIFY is created, and the target cannot escape the generated allowlist or change ownership attribution. If built-in handling continues, capture whether cloned-rdata transaction lookup causes setup to return `500` before the intended `202`/target validation or whether the selected runtime path supplies a usable transaction. With `Refer-Sub: false`, also capture the ignored dialog-send return, actual wire response/timeout behavior, and retransmissions. |
| REFER implicit-subscription setup succeeds but `202` creation or send fails | Fault-inject response creation/send failure; record the final wire response and verify the built-in handler's subsequent target-validation/transfer work, progress subscription state, and claim correlation. Asterisk ignores `pjsip_xfer_accept()`'s return, so do not infer that 202 was submitted from subscription allocation or continued handling. |
| REFER arrives after its session channel is absent or detached | Fail closed without dereferencing a missing channel or fabricating a generation claim; capture the actual wire response and prove no progress subscription, `202`, target attempt, or operation reservation is created. Verify the rejection API works with cloned request data; keep distinct from unknown-target handling, which occurs after implicit-subscription setup if its transaction is available. |
| Missing `Refer-To`, malformed URI, or unsupported non-SIP/SIPS scheme | Reject before progress setup; no operation claim, implicit subscription/`202`, target channel, or INVITE is created. Verify the actual wire rejection and that the custom gate's response API works on cloned data; confirm agreement with built-in URI eligibility. |
| Custom rejection uses `ast_sip_send_stateful_response()` on cloned in-dialog REFER | Source order predicts that the session callback's cloned request reuses the already-registered UAS transaction key, causing helper transaction creation to return `PJ_EEXISTS` before response send. Confirm on the exact deployed path, capture wire behavior and retransmissions, and reject this helper if the expected collision occurs; test an alternative response mechanism. |
| Progress setup cannot allocate the transferee unique ID | Inject the `ast_strdup()` failure; prove bridge progress cannot call `strcmp()` with a NULL transferee ID, progress resources are safely handled, and any assumed-success `200` is not treated as transfer or claim completion. |
| Allowed blind REFER with a pre-handler reservation | If the supplement returns zero, prove the built-in transfer callback, progress, and all terminal outcomes correlate to that reservation; if it handles and returns nonzero, prove it owns the bridge propagation callback and SIP response/progress lifecycle. No reservation-only path may leave built-in work uncorrelated. |
| `TRANSFER_CONTEXT` override or Refer-To URI with unexpected domain/parameters, `Replaces`, empty user, or URI user options | Effective context and post-normalization extension are explicitly verified, including the deployed `ignore_uri_user_options` value, semicolon truncation, and empty-user fallback to `s`; the out-of-scope attended-transfer branch selected by `Replaces` is rejected before built-in handling. No display-name/domain spoof or unreviewed context reroute is admitted. |
| SIP.js incoming REFER | The pinned client version's default and `onRefer` behavior are verified; all supported sessions use explicit handling, and unsupported referrals do not auto-follow. |
| Queue offer/member leg pending at fence | No unclaimed post-fence branch appears; pre-fence pending work remains counted until settled. |
| SIP.js REFER promise resolves without waiting for response; Asterisk successfully submits 202 before target failure/timeout, final or missing NOTIFY, retransmission, or controller/observer restart | Promise resolution and a submitted REFER 202 are not treated as transfer completion; terminal NOTIFY is correlated to a serialized source-session operation and is not treated as complete ownership evidence, especially if `refer_blind_progress=no`, monitor setup fell back to assumed success, or frame/bridge progress does not identify all forked legs. Processing is idempotent, and incomplete or unknown outcomes block removal/replacement rather than becoming zero. |
| Same REFER transaction retransmitted versus a new REFER with a later CSeq | Verify which retransmissions reach the pinned supplement; the same transaction must not reserve or start duplicate operation work, while a new transaction must follow the one-outstanding-operation policy and cannot overwrite unresolved progress correlation. |
| Two distinct in-dialog REFER transactions arrive while the first operation is queued but no target leg has reached `b()` admission | Verify PJSIP dialog/transaction dispatch behavior and enforce an atomic per-source-session active-operation latch; accept at most one, explicitly reject the other, and prove no progress state or operation claim is overwritten and no work is queued twice. |
| Last transferred/queued dialog ends | A complete reconciled snapshot reaches zero only after all old, target, and pending obligations settle; unrelated/base objects remain intact. |

The protocol-specific matrix must add packet-level expected responses and
channel/bridge lifecycle observations for the pinned SIP.js package and actual
Asterisk REFER mode, including `Refer-Sub` behavior, effective
`refer_blind_progress` configuration, monitoring-failure outcomes, and the
relationship (not equivalence) between transferee progress and per-target-leg
lifecycle.
`Session.refer()` promise resolution, Asterisk 202 acceptance, terminal 200
sipfrag, an implicit-subscription NOTIFY, or a transfer event alone does not
establish the ownership or serialization assertions above.

#### Next gate

Keep the checked SIP.js 0.21.2 version pinned and verify the chosen browser API
surface's blind- and incoming-REFER behavior in an isolated test. Then specify
the transfer-operation claim created before the two-party transfer is
queued or a multi-party `Local` channel is started, and how per-callee `b()`
admission creates and settles a unique child claim before each supported
`Dial()`/`Queue()` leg can be signaled. `session_create` alone is too early to
inspect the requestor's claim and too late to represent the transfer-start
obligation; the per-callee hook is a candidate final boundary, subject to
proving queue-wait accounting, fail-closed denial, inheritance, and every
channel/redirect path. The isolated test must include the selected API's
incoming REFER delegate installation order and demonstrate rejection of an
unapproved target without originating a new INVITE. Verify that a second
transfer on the same session cannot overwrite progress correlation; the
baseline design should permit at most one outstanding REFER per source session.
Include endpoint/member-forwarding attempts in every protected `Dial()` and
`Queue()` test. For `Dial()`, prove the fixed route applies `i` and receives no
replacement call, or prove a separate replacement-channel gate registers its
own child claim before `ast_call()`. For `Queue()`, prove option `i` is
effective and suppresses member forwarding, or prove equivalent replacement
admission. Include a PJSIP INVITE 3xx case for each allowed `redirect_method`:
prove `user`/`uri_core` forwarding is suppressed or separately admitted, and
prove `uri_pjsip` is rejected for protected endpoints unless every redirected
target is validated and accounted for in the PJSIP layer. Exercise AMI
Originate in app, extension, synchronous and asynchronous modes, ARI
channel-create plus Stasis dial, and every in-process `ast_dial` user. Prove
each invokes the same serialized admission owner before signaling or is
unavailable to the protected call path. A passing initial-channel `b()` test
alone does not cover these paths.
The synthetic proof must distinguish API promise resolution, Asterisk 202
acceptance, NOTIFY contents/state, progress-monitor health, and PBX
channel/bridge settlement. Assert that target answer and every forked leg are
independently correlated; a transferee frame or bridge-entry signal alone is
not the per-leg proof. Pin and assert the effective `refer_blind_progress`
setting; the permissive 200 fallbacks must not satisfy the success threshold.
For multi-party transfer, test claim presence on the callback's Local `;1`
channel, paired `;2` after `ast_unreal_call_setup()`, guarded target dialplan,
and each real target callee; inject duplicate-datastore/payload failure and
prove that no unowned target call is signaled. Exercise both Local optimization
outcomes; keep a target active after the Local pair is optimized out and prove
the parent operation remains open until every child claim reaches one terminal
outcome. Verify that masquerade fixup/breakdown, when used, cannot duplicate,
lose, or prematurely settle a child claim. Verify datastore-destroy settlement
occurs exactly once after final channel teardown, remains safe if channel
destruction is delayed after hangup, and cannot deadlock or lose its owner
handoff; inject handoff failure and prove the claim remains outstanding.
The design must also prove that DTMF blind transfer and parking are either
interposed or disabled. Only then design the finite synthetic proof around the matrix above.
If the chosen path cannot be interposed without a zero-count gap or bypass,
stop and return to the product scope rather than claim the existing Milestone 1
behavior is safely generation-managed.

This is a design recommendation and feasibility gate, not PBX module selection
or implementation approval. Exact Asterisk API coverage, build compatibility,
event ordering, controller failure behavior, and isolated tests remain
unproven. No real mutation, call or deployment is approved.
