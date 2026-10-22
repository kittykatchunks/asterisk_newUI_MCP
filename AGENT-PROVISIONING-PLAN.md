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

Candidate first adapter: generated PJSIP include files plus a fixed reload
operation through customer-local Asterisk control access. The controller must
generate a complete allowlisted model, never interpolate caller-provided config.
A sidecar's access to Asterisk's control socket is powerful even if its remote
API is narrow; compromise of that worker is a compromise of its customer PBX.
Prove socket permissions and reload behaviour in a separate fixture before
adopting this adapter. Do not expand the existing read-only/reporting AMI accounts.
Realtime PJSIP remains an alternative if file/reload consistency cannot meet gates.

Use one local writer lock across journal reconciliation, include generation and
reload. Fence duplicate worker processes; an expired generation's cleanup must
never overwrite a replacement generation's include. Atomic rename requires a
directory mount, not the current fixture's individual bind-mounted config file.
Neither a reload timeout nor the appearance of a new file proves runtime apply.

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
