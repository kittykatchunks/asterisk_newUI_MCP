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

This is the first implementation slice, not inherited production certification
from fixture tests. Separate-container, terminal-schedule, blocked-write and broader
filesystem-race checks still need implementation-specific evidence before
deployment. The real-process peer-loss and draining-shutdown cases above
are covered, but are not separate-container or arbitrary-schedule proofs.
Existing fixture results do not automatically cover the new
code. Production packaging/supervision and a concrete read-only source adapter
remain next integration work; real-source authority and privileged gates remain
separately approved.
