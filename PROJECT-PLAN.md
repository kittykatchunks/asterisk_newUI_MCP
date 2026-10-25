# Project plan: Asterisk management and AI platform

Planning baseline: 22 October 2026.

Status: planning with local Asterisk/authenticated SIP/RTP proofs and bounded
authenticated prototype workspaces. No complete production management platform,
enabled live agent phone or capacity claim has been validated. See the README
for executed tests and limitations.

## 1. Purpose

Build a self-hostable, containerised platform combining:

1. Vanilla Asterisk 22+ telephony, with an isolated instance for each customer.
2. A stylish, minimal, multilingual management interface and browser agent console.
3. AI voice handling, dispatch integration, contextual assistance, reporting,
   wallboards, and permission-controlled MCP tools.

The initial business use case is UK taxi companies, starting with Autocab.
The management platform should not embed Autocab-specific assumptions throughout
the telephony, conversation, or reporting models.

The project is self-built, with no fixed deadline or budget established. Initial
testing will be local, followed by deployment to an appropriate IONOS offering.
Cloud AI services are acceptable. A separate privately connected AI machine is
also a possible future deployment option.

## 2. Decision status

### Confirmed requirements

| Area | Agreement |
|---|---|
| Tenancy | Multiple customer organisations through one platform; one Asterisk instance per customer. |
| Telephony | Trunks, extensions, inbound/outbound routing, business hours, IVRs, queues, transfers, voicemail, and recording. |
| Roaming agents | Agent identity independent of device; shared SIP phones, browser calling, and existing softphones. |
| Native apps | Building our own desktop/mobile softphones may be a separate project. |
| Interface | Restrained operations dashboard, light/dark themes, clear typography, progressively revealed advanced settings. |
| Configuration UX | Guided forms and ordered routing steps first; visual flow editor later. |
| Agent console | Integrated browser phone, queue controls, caller details, and AI handover summary. |
| Authentication | Username/password, optional MFA, social sign-in, and enterprise SSO including SAML/Entra integration. |
| Expert access | Custom dialplan and direct configuration access for trusted platform specialists only. |
| Customer administration | Controlled UI settings rather than unrestricted expert configuration. |
| Publication | Individual changes and grouped changes. |
| AI configuration actions | Routine changes require explicit confirmation; sensitive changes require stronger approval. |
| AI outage | Automatic fallback to a configured human queue or conventional IVR. |
| Dispatch | Autocab UK first; API YAML will be supplied later. |
| Recording scope | Configurable by customer, queue, and call type; defaults not yet chosen. |
| Support access | Diagnostics by default, with contract-authorised, time-limited, reasoned and audited elevation. |
| Engineering diagnostics | Fault-triggered diagnostic mode, network SIP traces, sngrep-style call flows, AI-assisted fault analysis, and shareable evidence reports. |
| Technology preference | Maintainable, self-hostable components and simple deployment; no fixed framework preference. |
| Capacity target | Per customer: 50 concurrent calls, including up to 10 AI calls. Capacity remains unverified. |

### Provisional recommendations, not final decisions

- Docker Compose and Linux hosts initially; no Kubernetes requirement.
- Separate logical management, calling, and AI/integration paths.
- Shared telephony hosts with isolated customer containers, subject to testing.
- React/TypeScript frontend, TypeScript modular backend, PostgreSQL.
- Evaluate Keycloak for identity and federation.
- Private S3-compatible recording storage.
- Managed static Asterisk settings generated as versioned files, with controlled
  expert include files and runtime operations for live state.
- Controlled retention-policy templates with approved exceptions.
- Initial voice-agent scope: booking, status enquiries where supported, and
  human handover; amendments/cancellations after verification semantics are proven.

### Important unresolved matters

- Total customer count, aggregate platform concurrency, capacity headroom, and
  provider quotas remain to be defined. The per-customer target is confirmed.
- Exact IONOS product, sizing, public IP allocation, firewall and media topology.
- Existing Asterisk image versus a project-maintained reproducible image.
- Retention durations, recording defaults, licensing obligations, and transcript policy.
- Autocab API capabilities, commercial access, authentication, and rate limits.
- Language-country variants, first production languages, and translation validation.
- Performance thresholds, recovery objectives, support policy, and operating costs.
- Diagnostic capture placement/tooling, capture retention and pre-trigger buffering,
  automatic activation rules, and approved AI analysis destinations.

## 3. Languages and localisation

Requested languages: English, Spanish, Canadian French, Latin American/South
American Spanish, and Brazilian Portuguese.

Provisional locale identifiers: `en-GB`, `es-ES`, `fr-CA`, `es-419`, and `pt-BR`.
Confirm the intended Spanish variants and countries; `es-419` is a broad regional
locale, not a substitute for country-specific speech and address testing.

Localisation includes:

- UI text, validation, dates, numbers, and accessible layouts.
- IVR prompts, announcements, voicemail, and fallback languages.
- Speech recognition, voice selection, interruptions, and language switching.
- UK place-name pronunciation and preservation of names and addresses.
- Reports, wallboards, and human-readable AI approval summaries.

Initial working scope is multilingual callers booking UK journeys, not automatic
support for operating dispatch systems internationally.

## 4. Logical architecture

| Component | Responsibility |
|---|---|
| Management application | UI, API, customer configuration, permissions, approvals, revisions, and audit history. |
| Identity provider | Credentials, MFA, social identity, enterprise federation, and tenant-specific policies. |
| Customer Asterisk runtime | Trunks, endpoints, dialplan, queues, voicemail, recordings, and call control. |
| Voice worker | Live conversation, media integration, interruptions, tool execution, and handover. |
| Dispatch connector | Vendor authentication, supported lookups, booking operations, and outcome reconciliation. |
| Reporting pipeline | CEL/queue/application ingestion, reconciliation, metrics, reports, and live displays. |
| MCP interface | Authorised AI tools using the same backend rules as the UI. |
| Object storage | Private recording assets with controlled retrieval and retention. |

These are logical boundaries, not a requirement to create a microservice for each.
Start the management backend as a modular application.

### Proposed agent provisioning boundary

The selected next boundary is a customer-local provisioning worker exposing fixed
authenticated operations; the web application receives no Docker socket, shell or
PBX configuration-file access. See the
[agent provisioning worker plan](./AGENT-PROVISIONING-PLAN.md) for the proposed
protocol, durable intent/receipt reconciliation, per-generation credentials,
call-aware draining and staged acceptance gates. This service is not implemented.
Its storage, mTLS operations, PBX adapter and secret-key lifecycle are provisional;
browser phone activation remains disabled.

MCP does not transport the live telephone audio. Live media uses a separate
Asterisk integration, with ARI/external media as the candidate approach.

Official Asterisk documentation states that `chan_websocket` is available from
22.6.0, among other release branches, and supports TLS. Select and pin a maintained
release when implementing; do not treat every 22.x version as equivalent.

Reference: [Asterisk WebSocket channel driver](https://docs.asterisk.org/Configuration/Channel-Drivers/WebSocket/).

## 5. UK taxi call journey

1. Identify the taxi company from the inbound route/dialled number.
2. Load its greeting, operating rules, language policy, and dispatch connector.
3. Determine caller intent and language.
4. Optionally look up the caller number if supported. Caller ID is not proof of identity.
5. Collect and clarify the required booking details.
6. Read back material details and obtain caller confirmation.
7. Submit to dispatch and establish the actual outcome.
8. Confirm accurately or hand over with structured context.

### Booking data

Potential fields include pickup/entrance, destination, date/time, passenger name,
contact number, passenger count, vehicle/accessibility needs, luggage, extra stops,
account reference, and flight details. Required fields and supported options depend
on company policy and the dispatch contract.

Use authoritative location results where available. An LLM is not the source of
truth for coordinates, fare quotes, availability, or driver arrival estimates.

### Intents

- Book now or in advance.
- Check booking or vehicle status where authorised and supported.
- Amend/cancel after appropriate verification.
- Request a person.
- Lost property, complaints, and account enquiries through configured handling.

### Transaction state

Track booking operations separately from calls:

`collecting -> awaiting confirmation -> submitting -> accepted / rejected / outcome unknown`

Vehicle allocation and arrival are separate dispatch states where available.
One call can produce multiple bookings; multiple calls can concern one booking.

On timeout after submission, reconcile before retrying. Do not claim success or
create another taxi merely because the previous response was lost.

### Handover and failure

- Stop speaking when the caller interrupts.
- Offer human assistance when clarification fails or the caller requests it.
- Include collected details, handover reason, and actual booking state.
- Preserve uncertainty explicitly if submission status is unresolved.
- Define unanswered and out-of-hours fallback.
- Reconcile booking operations even when the caller disconnects.
- Do not claim that an accepted booking means a vehicle has been allocated.

### Selected next increment: deterministic booking simulation

Following completion of the bounded agent workspace, the selected next scope is
a **synthetic backend booking workflow**, before voice AI or any real dispatch
integration. The in-process implementation and its executed evidence are recorded
below. It does not complete the remaining live-phone
or Milestone 1 acceptance gates.

#### Boundary and first deliverable

- Implement a small TypeScript domain module, deterministic in-process connector
  and dedicated local SQLite store, with automated tests. Reuse existing database
  validation/transaction conventions where applicable; do not reuse the agent
  lease or evidence database as booking storage.
- Expose trusted in-process functions only. No HTTP route, MCP tool, browser
  booking form, scheduler, external network call, vendor credentials or deployment
  service is included. A later user-facing surface needs an explicit booking
  permission/CSRF/audit contract; `agent:access` is not booking authority.
- Require a validated customer scope on every operation/read. Test two synthetic
  customers and independent conversations. Caller number is data, not identity.
- Use deterministic test fixtures and injected time/IDs where useful. The
  simulator implements only the contract below, not imagined Autocab operations.
  All output and examples must identify themselves as simulation.

#### Synthetic journey and confirmation

The initial supported intent is one UK "book now" journey per operation:
pickup and destination chosen from fixed, customer-scoped synthetic location IDs,
synthetic passenger name/contact and integer passenger count from one to eight.
Location labels come from the fixture, not a model or arbitrary coordinates.
Use only clearly synthetic data in tests and examples.

Advance bookings, time-zone conversion, fares, vehicle availability/ETA, driver
allocation, payments, accounts, extra stops, amendments/cancellations and real
personal data are excluded. Unsupported requests produce a structured handover
reason, not silently dropped requirements or invented availability.

1. Collect a validated draft, bound to customer and conversation correlation.
2. Produce a canonical material-details summary with a revision identifier.
3. Record explicit confirmation of that exact revision. Changing material details
   invalidates confirmation; an old confirmation cannot authorise a new draft.
4. Commit a unique operation ID, immutable confirmed payload and submitting state
   before invoking the simulator. Operations are distinct from conversations:
   a conversation can have multiple explicitly confirmed operations.
5. Return the actual operation outcome, always labelled simulated. Accepted means
   simulated booking acceptance only, not vehicle allocation or a real booking.

#### Durable outcome and duplicate contract

Use `collecting -> awaiting confirmation -> submitting -> accepted / rejected /
outcome unknown`. The store must retain current state and ordered transition
records with operation/customer/conversation correlation, confirmed revision and
safe reason codes. Reopening the database must preserve those records.

The simulator supports exactly four scripted cases:

| Case | Simulator effect | Application result / recovery |
|---|---|---|
| Accept | Persist one simulated acceptance/reference for the operation. | `accepted`, simulated reference, no allocation/ETA claim. |
| Reject | Persist a stable business rejection for the operation. | `rejected`, safe reason and handover context; no success message. |
| Accept then lose reply | Persist acceptance, then raise a specific uncertain-outcome error. | `outcome unknown`; explicit reconciliation by the same operation ID returns the persisted acceptance without another create. |
| Remain unresolved | Persist no acceptance or authoritative rejection and report uncertainty. | Stay `outcome unknown`; reconciliation cannot infer rejection from absence and must not resubmit automatically. |

Durably key simulator results by customer + operation ID and the canonical
confirmed payload. Repeating the same ID/payload returns its stored outcome
without another booking effect; a changed payload conflicts explicitly. A foreign
customer cannot read or replay another customer's operation. Do not permit unknown
operations to be recreated under a new ID as a retry shortcut.

Serialize state changes and reject concurrent submissions/reconciliations that
would duplicate work. On restart, a persisted `submitting` operation has an uncertain
outcome until reconciled; never automatically create it again. Tests must cover a
crash boundary between simulator effect and application receipt persistence.
Only a defined simulator uncertainty error becomes `outcome unknown`; unexpected
storage/programming errors propagate explicitly rather than becoming success or
a fabricated business rejection. This local protocol is not evidence that Autocab
supports idempotency or lookup by our operation ID.

Handover is a structured result, not an actual queue transfer. It includes customer,
conversation and operation correlation, collected synthetic details, confirmed
revision where present, safe reason and actual booking state/reference. Unknown
must remain unknown in the handover. Caller disconnect does not cancel an operation
or establish failure; reconciliation can continue through an explicit harness call.

#### Finite acceptance checklist

The checklist below defines the finite scope; executed evidence follows it.
Do not expand this checklist with unrelated telephony or vendor research.

| ID | Required evidence |
|---|---|
| BS-01 | Validate customer/conversation scope, fixture location ownership, synthetic field shape and passenger-count boundaries; reject invalid input without a simulator effect. |
| BS-02 | Submission requires explicit current-revision confirmation; material edits invalidate it and stale confirmations fail. |
| BS-03 | Accept records exactly one simulated result and correct correlations; output cannot imply a real booking, allocation, fare or ETA. |
| BS-04 | Stable rejection remains rejected with a safe reason and truthful handover; no acceptance/reference is fabricated. |
| BS-05 | Accept-then-lose-reply becomes unknown; explicit same-ID reconciliation recovers the one stored acceptance without creating again. |
| BS-06 | Unresolved reconciliation stays unknown, including handover after caller disconnect; absence is never treated as permission to resubmit. |
| BS-07 | Same-ID/same-payload replay is idempotent; different payload conflicts; concurrent callers cannot create duplicate effects. |
| BS-08 | Two-customer read/mutation/replay substitution is denied. Two operations in one conversation remain independently correlated. |
| BS-09 | Close/reopen and injected crash-after-effect preserve evidence; submitting state recovers through reconciliation only. Corrupt/unrelated stores and unexpected errors fail explicitly. |
| BS-10 | Typecheck and focused tests pass; document reproducible harness usage, actual results and limitations. No HTTP/MCP/phone/network/vendor credential surface is introduced. |

Stop at recorded evidence for BS-01 through BS-10 or an explicit blocker.
The next decision is a separately authorised simulation UI or voice integration;
real Autocab work remains dependent on supplied API YAML and test access.

#### Executed booking simulation evidence

The trusted harness is implemented in `src/booking-simulation.ts`, with its domain,
SQLite store and deterministic connector kept together because there is no second
connector or transport to abstract. No dependency, endpoint, service or calling
capability was added. See [harness usage and limitations](./README.md#deterministic-synthetic-booking-harness).

| Check | Recorded evidence |
|---|---|
| BS-01 | Invalid/foreign locations, unsupported fields, non-synthetic identity fields, conversation/customer scope and passenger boundaries are tested before any dispatch effect. |
| BS-02 | Tests require review plus exact-revision explicit confirmation; edits clear confirmation and stale revision/submission attempts fail. |
| BS-03 | Acceptance is labelled simulation, correlated with its operation and `SIM-` reference, with no fare/ETA/allocation fields. Detached reads cannot mutate stored payloads. |
| BS-04 | Stable rejection has a safe simulated reason and no reference; handover preserves rejection. Unsupported draft input fails before dispatch; explicit unsupported-request handover is available for a collected draft. |
| BS-05 | Lost reply records unknown while retaining the one committed simulator result; explicit reconciliation recovers acceptance without another effect. |
| BS-06 | Unresolved results and missing simulator receipts stay unknown after reconciliation and caller-disconnected handover. Replacement creation and pre-existing replacement-draft submission in the same conversation are blocked. |
| BS-07 | Submitted edits conflict; replay returns the same immutable outcome without another effect. Two simultaneous processes and a second connection at the crash boundary do not duplicate dispatch. |
| BS-08 | Foreign-customer reads, edits, review, confirmation, submit, reconciliation and handover fail; separate confirmed operations in one conversation retain separate IDs. |
| BS-09 | Close/reopen, thrown crash injection and actual child-process exit after effect commit preserve submitting evidence and one recoverable acceptance. Missing receipts remain unknown; unexpected dispatch storage errors propagate. Corrupt/unrelated stores and payload conflicts fail explicitly. |
| BS-10 | Typecheck and eight booking tests pass, alongside ten existing SQLite lease/assignment regressions (18 tests total). Tests clean up temporary databases; no HTTP/MCP/phone/network/vendor surface or service was started. |

The bounded BS-01 through BS-10 increment is complete for the synthetic in-process
contract, not production booking readiness. The simulator and workflow share one
dedicated local database; separate-system failure semantics and vendor capabilities
remain unproven. Customer/conversation IDs are trusted harness inputs, not user
authentication or a global semantic duplicate detector.
The selected follow-on is the authenticated simulation workspace specified below;
do not automatically extend the frozen REFER matrix.

### Selected next increment: authenticated simulation workspace

The user selected a simulation workspace, starting with this permission/isolation
contract and finite checklist. Executed foundation and browser evidence follow.
Keep the completed BS harness as the domain foundation; do not activate voice,
SIP, microphone access, real dispatch, MCP, background reconciliation or scheduling.

#### Access and ownership contract

- Add an explicit provisioned `booking:simulate` permission. Require both it and
  `agent:access` for the workspace and every booking request. Existing agent or
  diagnostic grants alone confer no simulation access. Neither permission is
  real booking authority; bounded diagnostic support grants must not confer either.
- Reuse the existing application-session login, fixed customer-bound return paths,
  server-side permission verification and same-origin CSRF protections. Require
  an application session for reads and writes; bearer-only access is out of scope.
  Revalidate identity and grants on requests, not merely when rendering navigation.
- Use a separate simulation page linked from the agent workspace only for eligible
  users. Do not make a device reservation, endpoint readiness or microphone
  permission a prerequisite for this non-calling workflow.
- Keep the initial two fixture customers and their fixed synthetic locations.
  Derive customer, issuer and subject from verified server context. Never trust
  body-provided ownership, query-string scope or browser-supplied conversation IDs.
- Persist conversation ownership by issuer + subject + customer in the dedicated
  simulation store. Allocate conversation IDs server-side. Every operation lookup
  must check this ownership before returning details or mutating the domain.
  A guessed ID from another agent in the same customer must fail as well as a
  foreign-customer ID. Customer-level grants do not permit agent-to-agent reads.
- Ownership survives browser/server restart and logout; a newly verified session
  for the same identity may explicitly resume its own conversation. Provide an
  owner-scoped recovery list of conversation/operation IDs and actual states,
  without exposing another user's records or automatically reconciling results.
  Never claim ownership of legacy unowned harness records; retain their existing
  trusted local use and test schema migration/reopen explicitly.

#### Interaction and request contract

1. Display a persistent **SIMULATION ONLY — no taxi will be booked** notice and
   selected customer. Offer only fixed synthetic location/name/contact choices
   and passenger counts 1–8; do not collect real caller details.
2. Explicitly start or resume an owned synthetic conversation. Creating a draft
   must not happen on landing, refresh, login or a recovery-list read.
3. Collect/edit details, then display the server's canonical summary and revision.
   An explicit confirmation action must submit the displayed revision. Editing
   clears confirmation; do not automatically confirm or dispatch after review.
4. Require a separate submit action after confirmation. Clearly label the four
   synthetic scenarios; scenario selection is test control, not predicted vendor
   behaviour. Never allow the browser to set outcome, reference, history or owner.
5. Show accepted, rejected, submitting and outcome-unknown distinctly with the
   simulation label and actual reference/reason. Disable duplicate actions while
   requests are pending, but rely on durable server checks, not button state.
6. A lost HTTP response is not rejection or proof that nothing happened. For a
   known operation, preserve its ID and offer an explicit read/reconcile action.
   If conversation/draft creation lost its reply, use the owner-scoped recovery
   list before retrying; do not automatically create a replacement.
7. Reconciliation is an explicit action only, never polling or resubmission.
   Unknown/submitting operations keep the existing same-conversation replacement
   fence. A deliberately new conversation is a separate synthetic exercise, not
   an advertised way to retry an uncertain booking.
8. Display structured handover context for human request, unsupported request or
   caller disconnect without transferring/cancelling anything. Retain actual
   unknown state. Unsupported draft fields fail explicitly rather than disappear.
9. Refresh/resume reads durable state. Logout, expiry or permission denial clears
   rendered details and disables actions. Do not persist credentials or booking
   details in local/session storage; stale in-flight responses cannot repopulate
   a logged-out or differently scoped page.

All mutations use POST with bounded strict JSON bodies, current session and CSRF
checks. Reads must have no side effects. Return request IDs and explicit invalid,
denied, conflict and unavailable errors; never fabricate a successful domain
receipt after audit/storage failure. Responses containing session or simulation
data must be non-cacheable. Recheck the live session after asynchronous body/audit
work and before mutation, following the device-handler pattern.

Reuse the existing audit infrastructure for access/intent records without calling
an intent a completed result. Record request ID, verified actor/customer, action,
operation correlation when known and safe outcome codes; do not log cookies,
tokens, raw bodies or passenger/contact details. Domain history remains the durable
source of booking state. Explicitly test failure before domain mutation and loss
after a committed result; do not imply the two stores commit atomically.

Implementation includes the permission/configuration/launcher/session surfaces,
ownership persistence, narrow HTTP adapter, page and focused tests. Keep default
startup disabled unless a dedicated simulation database and explicit grants are
configured. Startup misconfiguration must fail clearly rather than silently enable
simulation or create authority. Follow existing HTML/JS and SQLite conventions;
do not add a framework, service or vendor dependency.

#### Finite workspace acceptance checklist

The SW checklist is **complete for the bounded synthetic browser contract**;
executed foundation and browser/launcher/real-identity evidence is recorded below. The completed BS
checks remain required regression coverage, not evidence for this new surface.

| ID | Required evidence |
|---|---|
| SW-01 | Default-off configuration, explicit permission validation, eligible navigation and fixed customer-bound login/return; agent-only, diagnostics-only and support-only grants cannot access simulation. |
| SW-02 | Session-required reads/writes, current grants, customer substitution denial, CSRF/origin denial, bearer-only denial and stale-session rejection after asynchronous request work. |
| SW-03 | Server-created ownership survives reopen; foreign customer and different same-customer subject cannot list/read/mutate/reconcile/handover guessed operations. Legacy harness records are not adopted. |
| SW-04 | Simulation notice, fixed synthetic inputs and strict bounded HTTP validation; no real personal-data entry, network dispatch, microphone or SIP/WebSocket activation. |
| SW-05 | Canonical revision displayed; separate review, confirmation and submit actions; edits and stale confirmations prevent dispatch, including competing browser requests. |
| SW-06 | All four scenarios display truthful state/reference/reason; double-click/replay cannot duplicate effects, and pending/unknown cannot be represented as rejection or retried through replacement creation. |
| SW-07 | Lost submit response and server restart recover through owner-scoped read/reconciliation only; lost creation response is recoverable through the list without automatic creation. Missing receipts stay unknown. |
| SW-08 | Handover retains collected context, correlation, confirmed revision and actual outcome; caller disconnect does not cancel. Unsupported input and handover are explicit. |
| SW-09 | Logout/expiry/denial clears details, blocks actions and fences stale responses; reload explicitly resumes own durable work without mutation, polling or local-storage credentials/details. |
| SW-10 | Audit failure prevents unaudited mutation, domain/storage errors remain explicit, access/intent is not called completion, request references are displayed, and responses/logs do not disclose secrets or other owners' details. |
| SW-11 | Keyboard-operable controls, semantic status/error messages and deterministic browser tests cover pending/conflict/unavailable states and an allowlist of expected requests. No comprehensive accessibility audit is claimed. |
| SW-12 | Typecheck, focused access/session/API/store/browser tests, BS regressions and the existing real-identity launcher/session proof pass with reproducible setup and cleanup instructions; record actual results and limitations. |

Stop after SW-01 through SW-12 evidence or an explicit blocker. This closes only a
synthetic browser exercise, not live calling, real dispatch, Milestone 1 or production
readiness. Voice integration remains a separately authorised next decision.

#### Executed workspace foundation evidence

The first implementation increment added explicit `booking:simulate` membership
validation, persistent issuer/subject/customer-owned conversations and a narrow
session-only HTTP adapter. At that point it did not supply a browser page, eligible
agent navigation, simulation login/return workspace or local-launcher opt-in. The
table below records that initial 60-test checkpoint; the gaps noted there are
closed by the subsequent executed workspace evidence below. Default
startup remains disabled for simulation; embedded-server callers must explicitly
supply a dedicated simulation store and application-session configuration.
See [API contract and reproduction](./README.md#authenticated-simulation-api-foundation).

| Checks | Actual foundation evidence and remaining scope |
|---|---|
| SW-01 | Access tests require explicit membership and deny support/token-role authority. API tests deny agent-only, simulation-only and diagnostics-only users. Missing store is explicitly disabled; store without sessions fails startup. Navigation/login/launcher wiring is pending. |
| SW-02 | HTTP tests deny no-session/bearer-only requests, customer substitution, missing CSRF, foreign origin, cross-site mutations and mixed bearer/session credentials. Logout during an awaited audit fences mutation. Existing application-session regression passes; real-identity workspace proof remains pending. |
| SW-03 | Ownership and HTTP tests deny foreign customers and different same-customer agents across list/read/create/edit/review/confirm/submit/reconcile/handover. Ownership survives reopen and a new login for the same identity. Schema-1 migration preserves unowned harness records without adopting them. |
| SW-04 | HTTP tests enforce strict bodies, no client-supplied owner/customer/conversation, synthetic journey validation and the exact 2,048-byte/2,049-byte boundary. Output is explicitly simulated and non-cacheable. Fixed browser choices/notice and browser traffic assertions are pending. |
| SW-05 | Edit/review/submit require the displayed revision; confirmation remains revision-bound. A submit held at the audit boundary is rejected after another tab edits and confirms a newer revision, with zero effects. Browser controls remain pending. |
| SW-06/07 | HTTP/domain tests cover four outcomes, repeat submission, same-conversation replacement fencing, discarded creation receipts recovered through owner listing, reopen/new-session recovery, and explicit reconciliation. Actual transport-loss browser UX remains pending. |
| SW-08 | HTTP handover preserves unknown outcome after disconnect; domain regressions retain truthful handover semantics. Browser handover presentation remains pending. |
| SW-09/11 | Existing session logout/rotation regressions pass; no new simulation browser has been implemented or tested. UI data clearing, response fencing, explicit resume and keyboard/status/traffic checks remain pending. |
| SW-10 | Persistent audit gates reads and mutation intents; tests inject failed audits, logout during audit, unexpected failure after effect commit and stored-data corruption. Operation correlation survives audit schema-2-to-3 migration and backup/restore. Intent is explicitly not completion; browser error display remains pending. |
| SW-12 | Typecheck and 60 focused tests pass, including all eight BS tests and existing access, session, device HTTP and diagnostic storage/backup regressions. Six new owner/HTTP tests are included. Browser and real Keycloak launcher/session proof for the new surface remain unverified. |

Simulation schema 2 adds ownership without granting access to legacy records.
Diagnostic schema 3 adds nullable booking-operation audit correlation; its backup
reader accepts old schemas as well as the new schema without changing manifest
format 2. Tests clean temporary databases and loopback identity servers. No
dependencies, live vendor calls, phone capabilities or services left running were
introduced; the frozen REFER suite was not expanded or rerun.

#### Executed simulation workspace evidence

The follow-on implements the synthetic browser workflow, fixed `simulation` login
workspace, eligible agent navigation and explicit `-WithSimulation` launcher opt-in.
It does not require agent assignments/device reservations or turn on calling.
Simulation reads additionally require the page's bootstrap CSRF token, so old pages
cannot read through a different newly rotated session cookie.
See [setup, workflow and reproduction](./README.md#synthetic-booking-browser-workspace).

| Check | Executed evidence |
|---|---|
| SW-01 | Focused access/HTTP tests and real Keycloak launcher proof verify fixed simulation login return, eligible agent navigation, explicit opt-in, disabled default restart and Bob denial. Agent-only, diagnostics-only and support grants remain insufficient. Identity preflight preserves exact subjects without requiring an assignment database. |
| SW-02 | Existing session/API checks pass alongside new read-token/rotated-cookie denial. Real application-session/launcher proofs pass with the new login route. Logout held at the audit boundary still fences mutation; browser expiry and denied requests clear controls/data. |
| SW-03 | Foundation owner-isolation/migration/reopen tests pass unchanged. Real launcher restart retains the same subject's conversation and recovers its operation; no legacy harness ownership is inferred. |
| SW-04 | Browser tests assert the persistent simulation notice, select-only inputs, no microphone/WebSocket traffic and an explicit request allowlist. Strict HTTP body/scope/synthetic validation and byte boundaries continue to pass. |
| SW-05 | Browser keyboard sequence proves separate review/confirm/submit and confirmation invalidation after editing. Unsaved changes block dispatch. API's held-submit/newer-confirmed-revision race test proves no stale-tab effect. |
| SW-06 | Browser checks cover accepted/rejected/unknown states with truthful references, disabled pending actions, and all four scenarios. HTTP/domain replay/concurrency checks retain one effect; unknown/submitting never offers a same-conversation replacement. |
| SW-07 | Browser fault injection discards replies after conversation/draft creation or submission; explicit own-list/read recovery does not recreate/resubmit. Real Keycloak server restart recovers one unknown result to acceptance with exactly one simulator effect. Unresolved stays unknown; missing-receipt domain checks still pass. |
| SW-08 | Browser handover displays saved details, correlation, confirmed revision and rejected/unknown state for unsupported/disconnected reasons. Structured domain handover and unsupported input rejection remain covered; no transfer/cancellation occurs. |
| SW-09 | Browser tests clear details before waiting for logout, report failed logout, fence a held reply after logout/expiry, and clear denied data. Reload lists without mutation and requires explicit operation resume; no polling or local/session storage is used. |
| SW-10 | Browser conflict/unavailable/malformed/transport errors display explicit recovery guidance and request references where supplied. Audit failure/corruption/after-effect tests remain passing; audit intent is not represented as completed booking outcome. |
| SW-11 | Five browser tests exercise keyboard activation, labelled selects, semantic status/alerts, pending/conflict/unavailable states, inert malformed content and a request allowlist. This is not a comprehensive accessibility or visual-design audit. |
| SW-12 | Typecheck and 75 focused tests pass, including all BS checks and affected identity/session/agent/storage regressions. The complete existing real Keycloak identity/application-session/launcher runner passes with simulation coverage; it removes its owned container/network afterward. |

The finite SW-01 through SW-12 increment is complete for local synthetic exercises,
not production booking readiness, real dispatch or Milestone 1. Local fixture
passwords/client secrets rotate, but subject IDs are retained while simulation
ownership storage exists (or agent/simulation mode is explicitly selected), without
granting either opt-in by default. Missing/invalid retained identities fail
explicitly rather than orphaning records through silent regeneration.

No dependencies were added; no services are left running. The frozen REFER matrix
was neither expanded nor rerun. External dispatch semantics, live voice and
simulation-store production backup/recovery remain unproven. Stop here rather than
growing the checklist. The subsequent user-selected Milestone 1 evidence-gap review
is recorded in [MILESTONE-1.md](./MILESTONE-1.md#evidence-gap-review-after-the-synthetic-booking-workspace).
The recommended/default selected next target is the isolated
[M1-10 management-outage continuity proof](./MILESTONE-1.md#selected-next-increment-management-outage-continuity),
with six finite MO checks. Live voice/agent-phone activation remains unauthorised.

### Management-outage continuity completion

The selected MO-01 through MO-06 increment now passes for **M1-10's local
conventional echo-route scope**. The isolated proof runs the actual management
HTTP application and two authenticated synthetic calls, stops its owned
management PID, verifies HTTP refusal, measures at least 60 seconds of ongoing
media per customer, and completes a new call per customer during the outage.
Fresh CEL records correlate both dialogs/customer and all four BYEs complete.

Typecheck, five focused Python tests and two complete real outage runs pass after
fixing the initial harness-only CEL event-name assertion. Final run `run-2KzA6j`
recorded 61.080 seconds of controller-observed outage, 562 HTTP-refusal checks,
60.502 seconds of media per customer, 60 passing one-second windows each,
2,698/2,698 distinct echoed frames each and 100/100 echoes on each fresh call.
Maximum receive gaps were below 0.024 seconds for both customers. Owned processes,
containers, networks, volumes and generated credentials were removed; the ignored
non-secret report remains available locally.

Reproduce with `.\scripts\Test-ManagementOutageProof.ps1`; see the
[acceptance evidence and limits](./MILESTONE-1.md#management-outage-continuity-evidence)
and [prerequisites](./README.md#isolated-management-outage-continuity-proof).
No dependencies were added or REFER checks rerun. The other 17 M1 gates remain
incomplete. This does not authorise live voice/agent-phone activation or establish
queue delivery, public-trunk availability, HA or production QoS. Stop after this
verified increment rather than automatically expanding into those work packages.

### Operator-only durable CEL foundation completion

The user selected `history-foundation`, with the recommended operator-only
boundary. HF-01 through HF-08 now provide a dedicated SQLite evidence store,
bounded full-snapshot CEL imports and read-only customer/source/generation-scoped
operator source/event/channel queries. Source/customer/time-basis association is
explicit; original records, byte offsets, hashes and ingestion timestamps persist.
Replay/restart deduplication uses consumed-prefix verification and an atomic
record/checkpoint transaction. Changed/truncated prefixes fail rather than silently
resetting; new generations require operator recognition of replacement.

Typecheck and 13 focused tests pass, including parser/limit boundaries, SQL
rollback, separate-process concurrency, uncommitted process death, persistence,
corruption detection and cross-customer collisions. The isolated real proof
imports six records (824 bytes) per customer, replays with zero inserts, reopens
the database and verifies exact bytes and Call-ID/channel lifecycle evidence.
Both PBXs use declared UTC; original timestamp text is not reinterpreted.
The synthetic database/report remain local while owned services and generated
credentials/snapshots are removed.

Reproduce with `.\scripts\Test-CelHistoryProof.ps1`. See the
[HF acceptance contract/evidence](./MILESTONE-1.md#selected-next-increment-operator-only-durable-cel-foundation)
and [operator commands and limitations](./README.md#operator-only-durable-cel-history-foundation).
No dependencies or web/permission surfaces were added, and REFER was not rerun.
This is an evidence substrate, not a journey/outcome report. Queue ingestion,
journey/leg/visit reconstruction and all four M1-06 outcomes, M1-07 continuous
collector replay/health/gap reporting, authenticated HTTP/UI and production
retention/backup are separate work. Live phones remain disabled.
Stop at this verified foundation rather than automatically growing its scope.

### Operator collector recovery completion

The user selected operator-run local-file collection with explicit gap-recorded
replacement. CR-01 through CR-08 now add durable collector configuration,
attempt/success/failure status, freshness and gap queries alongside atomic CEL
checkpoints. One-shot passes or a bounded foreground run collect local files;
they do not install a service, fetch remote logs, expose HTTP/UI or enable phones.
Source/customer association remains a trusted operator responsibility.

CEL schema 2 migrates the original evidence store atomically. Revision-fenced
attempts prevent late/old-generation writes. New records, checkpoint and success
status commit together; missing/malformed/oversized/discontinuous sources fail
without checkpoint reset. Status exposes stale, unhealthy, pending and clock-skew
rather than presenting an old success as fresh. An explicit fresh-generation
transition records a permanent unknown-coverage gap with operator context and
collection observation bounds; later healthy collection cannot erase it.

Typecheck and 25 focused tests pass, covering migration rollback, exact freshness,
process death/restart, malformed files, fencing, failed status/gap transactions
and customer-scoped reads. The isolated real two-customer proof generates extra
CEL while collection processes are absent, observes staleness, replays six new
records per customer exactly once, and verifies all twelve original records.
Missing/replaced local snapshot faults fail; explicit transition imports eleven
replacement records while keeping old evidence and the unknown gap visible.
The synthetic database/report remain local; owned services and generated
credentials/snapshots are cleaned.

Reproduce with `.\scripts\Test-CelCollectorProof.ps1`; see the
[CR contract/evidence](./MILESTONE-1.md#selected-next-increment-operator-collector-recovery)
and [operator command/status limits](./README.md#operator-run-cel-collector-recovery).
No dependencies, application permissions or shared services were changed.
This is partial M1-07 evidence, not full acceptance: local-file freshness is not
remote PBX freshness, and automatic segmented rotation, production deployment,
queue/journey history, retention/backup and authenticated presentation remain
separate. Live phones remain disabled and REFER was not rerun.
Stop after this finite verified increment.

### Operator queue evidence foundation completion

The user selected extending the dedicated history database with separate queue
tables. QF-01 through QF-07 now provide bounded full-snapshot raw queue imports,
atomic prefix checkpoints, source/event/call-ID pages and an operator-only CLI.
Responses explicitly identify `kind:queue`; equal CEL/queue or cross-customer IDs
do not cause joins. Original Unix timestamp text, LF/CRLF record bytes, empty/
variable parameters, offsets, hashes and ingestion timestamps persist.
Unknown/admin events remain raw evidence, not outcomes or inbound counts.

The QF increment introduced history schema 3, atomically adding
`queue_sources`/`queue_events` while preserving CEL APIs, evidence and
collector/gaps. MM below extends this to schema 4 with legacy read compatibility.
Shared bounded-file/scope/hash helpers avoid separate
CEL/queue policies without conflating their incompatible record formats.

Typecheck and 38 focused queue/CEL/collector tests pass. Real run `run-hyu0OP`
imports three queue records (157 bytes) per customer, correlates entry/timeout
identifiers to scoped CEL and reproduces exact bytes through one-entry pages.
Separate importer replay inserts zero. Owned PBX restart preserves original
prefix/records and appends one administrative record, giving four records
(195 bytes) per customer; replay still inserts zero. The real CEL collector
recovery regression also passes on schema 3. Owned services/generated files are
removed; only synthetic history databases/reports remain local.

Reproduce with `.\scripts\Test-QueueHistoryProof.ps1`; see
[QF acceptance evidence](./MILESTONE-1.md#selected-next-increment-operator-queue-evidence-foundation)
and [operator usage/limits](./README.md#operator-only-queue-evidence-foundation).
No dependencies, loaded routes, phones, web/permission surfaces or REFER checks
changed. This is not completed JD reconstruction or M1-06/07 acceptance.
MM below implements runtime/epoch assertions and isolated entry/visit
instrumentation separately. JP/QR below add bounded marked-caller projections
and independent queue collector health/gaps. Broader leg/visit reconstruction,
human-service/outcome evidence and authenticated presentation remain open.
CEL health never implies queue freshness.

### Runtime/epoch manifest and isolated marker completion

The user selected immutable record-boundary assignments and a new isolated
synthetic fixture, not projection/totals. MM-01 through MM-07 now add operator
registration/list/resolve, schema-4 manifest/range tables and stored-CEL marker
inspection. At MM completion, writers migrated 1/2/3 to 4 atomically with
legacy read compatibility; QR below extends the owning history to schema 5.
Existing raw evidence,
collector/gaps and timestamps are preserved; legacy/appended bytes are unassigned
until explicitly mapped.

Explicit customer/runtime/epoch and trusted route declarations apply only to
committed, exact `[start,end)` byte ranges. Overlaps/reassignment or contradictory
customer/runtime bindings fail. Exact registration replay is idempotent; a
generation can span explicit restart epochs and an epoch can span generations.
Original-byte hashes and manifest provenance accompany per-record resolution.
No correction/supersession or inferred pairing is provided. These are trusted
operator assertions, not runtime attestation or remote epoch discovery.

Entry and visit JSON are versioned and bounded, route/revision checked and loaded
from the real stored source/offset. Visit markers now include `routeRevision`
explicitly so inspection does not need an unimplemented journey join.
Validated observations do not establish unique roots, all legs, actual queue
service, outcomes, completeness or counts. Source gaps remain independent.

Typecheck and 46 focused tests pass, including legacy migrations/rollback,
explicit epoch splits, kind/customer collisions, unassigned append, atomic
overlap rejection, concurrent registration, persisted read-only CLI access and
malformed/spoofed markers. Real `run-WYmmSC` (`asterisk-history-wymmsc`) preserves
19 CEL records/3,020 bytes and three queue records/157 bytes per customer.
One fresh entry/visit pair per customer is observed before Answer/Queue start,
with matching actual ENTERQUEUE/timeout and caller-channel lifecycle.
Both PBXs reused caller ID `1792896030.2` without crossing scopes.
Replay inserts zero, registration replay is idempotent, bytes round-trip exactly
and fresh processes resolve both source kinds. Owned resources/generated files
are removed; only synthetic databases/reports remain local.

Reproduce with `.\scripts\Test-HistoryMarkersProof.ps1`; see
[MM acceptance evidence](./MILESTONE-1.md#selected-next-increment-runtimeepoch-manifests-and-isolated-markers)
and [operator usage](./README.md#operator-only-runtimeepoch-manifests-and-marker-observations).
Temporary isolated config enables UUID and Queue application tracking; ordinary
routes/REFER fixtures, live phones, HTTP/permissions and dependencies are
unchanged. The subsequent JP contract below separately authorizes only the first
conservative marked-caller projection; totals remain out of scope.
M1-06/07 remain incomplete.

### Conservative marked-caller projection completion

The user selected the first bounded projection and accepted durable conservative
revisions. JP-01 through JP-07 build one customer/runtime/epoch from a consistent
schema-4 history snapshot and publish immutable documents atomically in a
separate dedicated schema-1 projection database. Raw history remains unchanged.
The initial algorithm `marked-caller-v1` records raw checkpoint/time-basis vectors, manifest
hashes and collector/gap observations. Stable root/visit keys use a separate
identity namespace and explicit scoped UUIDs, not revision IDs or linkedid.

Validated entry markers attribute only the exact marked caller channel.
Equivalent repeated markers retain provenance without multiplying entities;
contradictory roots, reused channel identities and visit IDs remain conflicts.
Queue entry/timeout association requires one marked visit and one candidate
ENTERQUEUE; repeated/ambiguous candidates stay unresolved. Only pinned entry/
timeout event shapes are supported. Unsupported/invalid/unassigned records
retain issue references. No Local, bridge, consultation or transfer leg is joined.

Caller answer, caller-channel end and queue timeout remain separate observed
facts. None proves human service, caller abandonment, journey completion or a
business count. At JP completion, quality is incomplete/unverified, queue coverage absent
and service unclassified. Existing CEL gaps remain possibly applicable or
association-unknown regardless of timestamps or subsequent healthy recovery.
The operator reader compares current committed input hashes and exposes separate
local collector-health observations, not remote-PBX freshness.

Projection publication serializes before reading inputs; exact latest replay
reuses a revision and late input preserves stable entity keys in a new revision.
Failed builds leave the last good revision intact. Bounds limit source/manifest/
record counts, raw bytes, output references/document and revision pages.
No input truncation, empty-success fallback or partial publication is allowed.

Typecheck and 62 focused tests pass, including deterministic rebuild, duplicate/
conflicting markers, repeated visits, same-generation epoch splits, cross-scope
collisions, exact input limits, bounded ambiguity fanout, preserved recovery
gaps, immutable replay/late revisions, storage failure/corruption, concurrent
operators and a real SQLite read snapshot during a second writer's append.
Final isolated run `run-99RbJ4` (`asterisk-history-99rbj4`) preserves 19 CEL
records/3,020 bytes and three queue records/157 bytes per customer. Separate
CLI processes publish revisions 1/2; each contains one synthetic marked caller
with eight caller-channel references, separate answer/end observations and one
unambiguous queue-timeout visit with two queue references. Unmarked Local/echo
legs and administrative records remain explicit issues, not extra roots.
Replay reuses revisions/hashes; reopen matches entity keys/documents, local
freshness reports input match and foreign scopes fail. Offline prior-revision
inspection reports freshness not checked rather than hiding the last good data.
Owned resources, credentials and temporary configs are removed; only synthetic
raw/projection databases and the report remain local.
Reproduce with `.\scripts\Test-HistoryProjectionProof.ps1`; see
[JP acceptance evidence](./MILESTONE-1.md#selected-next-increment-conservative-operator-journey-projection)
and [operator usage/limits](./README.md#conservative-operator-journey-projections).

No dependencies, ordinary routes, live phones, web/permission surfaces or frozen
REFER fixtures change. This is only a bounded reconstruction subset, not the
full JD graph, four-outcome acceptance, totals or M1-06/07 completion. Stop here
before selecting the next finite increment.

### Independent queue collector recovery completion

The user selected QR-01 through QR-07: operator local-file queue collection,
durable freshness/failure state and explicit permanent replacement gaps.
History schema 5 adds independent queue collector/gap tables atomically, retaining
all CEL/queue raw evidence, manifests and CEL collector state. CEL read support
is 1-5, CEL collectors 2-5, raw queue 3-5, manifests 4-5 and queue collectors 5.
Read-only legacy access never migrates or invents queue health.

The queue collector uses the existing parser and checkpoints, shared file/
threshold/time/health/error helpers, revision-fenced asynchronous attempts and
atomic evidence/checkpoint/success updates. Configuration is immutable except
for explicit fresh-generation transitions. Missing/malformed/oversized,
prefix-discontinuous and storage failures surface; superseded workers cannot
overwrite later state. Collection is one-shot or bounded foreground only.
Stale/pending/failed/dead attempts are not successful remote delivery.

Replacement records a permanent unknown gap with operator/reason and observation
bounds, never a precise event-loss interval. Healthy collection never clears it,
old evidence is retained and new bytes remain epoch-unassigned until explicitly
manifested. Queue config/revisions/gaps are separate even when CEL uses the same
source/generation strings.

Algorithm `marked-caller-v2` adds kind-qualified queue/CEL provenance and separate
health. V1 revisions remain readable, v2 rebuilds append immutable revisions and
the independent entity-key namespace is unchanged. Legacy schema-4 input warns
queue capability unavailable. Configured local queue collection stays coverage
unverified; gaps remain possibly applicable or association unknown, without
timestamp-based exclusion. No completeness, human-service or business-outcome
claim is introduced.

Typecheck and 76 focused tests pass (14 QR plus 62 existing regressions):
migration/rollback and legacy support, exact freshness/pending/clock states,
file failure recovery, atomic status and transition failure, fenced workers,
process death before/inside commit, corruption/scope/bounds, independent
projection provenance and earlier algorithm compatibility.
Real `run-XYvtHl` (`asterisk-history-xyvthl`) observes stale collectors at
4,803/5,185 ms against 1,000 ms; two fresh retained records per customer replay
exactly once, preserving five records/276 bytes. Missing/discontinuous files
fail. Explicit replacements import four records/238 bytes per customer and
return healthy with permanent unknown gaps. CEL collection remains unchanged;
projections retain gap warnings, stable keys and unverified completeness.
Independent owned cleanup and persisted CLI reads pass.

Reproduce with `.\scripts\Test-QueueCollectorRecovery.ps1`; see
[QR evidence](./MILESTONE-1.md#selected-next-increment-queue-collector-recovery-and-independent-coverage)
and [operator commands](./README.md#operator-only-queue-collector-recovery).
No new dependency, ordinary route, live phone, HTTP/UI/permission or frozen
REFER work. Stop after this finite local-file increment; M1-06/07, remote
delivery/retention and broad journey/outcome acceptance remain incomplete.

### Synthetic queue-member service observation completion

The user selected QS-01 through QS-06: isolated automated-member connection/
completion evidence plus conservative projection observations. This is **not**
a human-service or two-way-media proof. The new service route and Local `/n`
member run only through temporary owned configuration. Ordinary routes,
empty-queue timeout behavior, live phones and frozen REFER fixtures are unchanged.

The pinned runtime emitted ENTERQUEUE, CONNECT (`hold|member-uniqueid|ring`) and
COMPLETEAGENT (`hold|call|original-position`). Exact raw records and IDs remain
durable. `marked-caller-v3` separates caller PBX answer/end, queue connection,
exact member-channel answer/end correlation, and queue-member completion.
A unique same-stream queue sequence and supported exact parameter shapes are
required. Member correlation requires one consistent exact uniqueid with an
ordered start/answer in the caller's CEL source/generation and explicit selected
customer/runtime/epoch. Missing, foreign, unassigned, reused/root/caller,
duplicate and contradictory identities stay unresolved/conflicting.
No timestamp, linkedid, Local-half or bridge-peer join is introduced.

Queue connection/completion remains an independent record observation even if
member correlation cannot be established. COMPLETEAGENT is not human identity,
caller abandonment or whole-journey completion. At QS completion, COMPLETECALLER
and transfers remained unsupported; the QC increment below adds only the former.
Numeric parameters stay raw, not metrics. No extra inbound
journey root, business outcome or total is created. Quality remains service
unclassified/completeness unverified, with independent collection/gap warnings.

V1/v2 revisions remain readable as stored, without new service fields. Rebuilds
append v3; entity keys and raw/projection schemas stay unchanged. Late member
evidence creates a new immutable revision, with prior ambiguity still inspectable.
Existing output-reference/document bounds include new service provenance.

Typecheck and **85 focused tests** pass: nine QS additions plus the existing 76
history/collector regressions. Coverage includes supported/invalid/order/duplicate
CONNECT and completion shapes, partial/conflicting/reused member identities,
competing claims, exact scope collisions, late evidence, retained independent
gaps, replay, old-revision byte preservation and historical algorithm reads.
Real `run-n7q0gL` (`asterisk-history-n7q0gl`) retains **44 CEL records / 7,497
bytes and six queue records / 370 bytes per customer**. Both customers emit
the same three-event service sequence. Each member has exact CEL
CHAN_START/ANSWER/BRIDGE_ENTER/BRIDGE_EXIT/HANGUP/CHAN_END. Service caller IDs
are equal (`1792898562.4`) across customers without cross-attribution.
Revisions **3/4** preserve the earlier timeout journey/keys and add separate
service observations with ten caller and six member CEL references. Raw replay,
persisted CLI reopen, offline read, immutable replay and scope denial pass.
Genuine retained v1/v2 projections remain readable using the v3 reader.
Owned containers/networks/volumes are independently checked absent; temporary
configurations/credentials are removed.

Reproduce with `.\scripts\Test-QueueServiceEvidence.ps1`; see
[QS evidence](./MILESTONE-1.md#selected-next-increment-synthetic-queue-member-service-observations)
and [observation semantics](./README.md#synthetic-queue-member-service-observations).
No dependency, production route, UI or permission surface changes. Stop after
this bounded increment: human service, two-way service audio, broader lifecycle/
outcome acceptance, remote evidence delivery/retention and M1-06/07 remain open.

### Caller-ended synthetic queue-service completion

The user selected QC-01 through QC-06: post-CONNECT COMPLETECALLER evidence and
its separate conservative projection observation. A new temporary trusted
caller-service route/queue/automated Local `/n` member leaves the member
answered while the caller-side Wait ends after three seconds. Queue/member
waits are bounded; the proof fails unless CONNECT precedes COMPLETECALLER and
all owned channels finish. No live phone, ordinary route or REFER change.

Actual pinned output has COMPLETECALLER `hold|call|original-position`, the same
shape as COMPLETEAGENT with a distinct terminating-party record. Both require
a valid unique CONNECT, a sole same-stream later terminal, matching member,
canonical nonnegative safe integers and positive original position.
`marked-caller-v4` adds `caller-ended-queue-service-observed`, retaining separate
`member-ended-queue-service-observed` and independent member/caller answer/end.
No human identity, audio, pre-connection abandonment, whole-journey completion,
transfer, duration metric or total is inferred.
Malformed/mismatched/cross-stream terminals stay unresolved; duplicate/mixed
terminals conflict. Unsupported events remain evidence/issues.

V1/v2/v3 documents remain unchanged and readable; v4 rebuilds append immutable
revisions with stable entity keys. A genuine earlier v3 caller-service revision
still reads unresolved under the v4 reader, rather than silently acquiring the
new interpretation. Raw schema 5 and projection schema 1 are unchanged.
Existing coverage/gap warnings and reference/document bounds remain enforced.

Typecheck and **91 focused tests** pass: six QC additions plus all 85 previous
regressions. Tests cover exact shapes/order, terminal disagreement/duplicates,
absent/conflicting member evidence, independent caller end, foreign scopes,
late completion, preserved unknown gaps, replay and byte-preserved v3 history.
Real `run-nOTX5T` (`asterisk-history-notx5t`) retains **69 CEL records / 12,349
bytes and nine queue records / 619 bytes per customer** across baseline,
timeout, member-ended service and caller-ended service. New caller uniqueid
`1792920819.8` is reused across both customers without attribution leakage;
CONNECT member uniqueids are `1792920819.9` / `1792920820.9`.
Each new visit has ten caller and six member CEL references plus the distinct
three-record caller-ended queue sequence. V4 revisions **5/6** preserve both
earlier journeys and all prior revisions. Raw round trips/replay, persisted
CLI reopen, offline reads, scope denial and independent owned-resource absence
checks pass; generated credentials/configurations are removed.

Reproduce with `.\scripts\Test-QueueServiceEvidence.ps1 -CallerEnded`; see
[QC evidence](./MILESTONE-1.md#selected-next-increment-caller-ended-synthetic-queue-service)
and [operator semantics](./README.md#caller-ended-synthetic-queue-service).
Stop after this bounded increment. M1-06/07, human service, service media,
pre-connection abandonment and broader journey/outcome acceptance remain open.

### Autonomous ten-test pre-connection hangup batch completion

The user authorized QA-01 through QA-10 as one batch without pauses between
tests. It adds a temporary trusted no-member abandon-queue route: synthetic
caller Wait ends after three seconds, before the ten-second Queue limit. The
proof requires the actual ENTERQUEUE/ABANDON sequence with no CONNECT for that
queue; it does not infer it from elapsed time. Ordinary routes, live phones
and the frozen REFER matrix are unchanged.

`marked-caller-v5` adds visit abandonment
not-observed/observed/unresolved/conflicting, and abandonment-observed summary.
A trusted marked caller/visit and unique ENTERQUEUE must have a sole later
same-stream ABANDON, member NONE, with exact position/original-position/wait
canonical unsigned safe integers and positive positions. Invalid/order/scope
ambiguities remain unresolved; duplicate/mixed records conflict. A conflicting
CONNECT retains its independent service/member facts. Nothing infers human
intent, complete absence of service, whole-journey abandonment or business
outcomes/metrics. Caller PBX answer/end remains independent; the fixture's
caller is PBX-answered before Queue, not served by a queue member.

Raw/projection schemas and stable keys do not change. Earlier v1-v4 documents
remain readable as stored, without the new field or reinterpretation. Late
ABANDON appends an immutable revision. Existing bounds, independent coverage/
gaps, unclassified service and unverified completeness remain in force.

Typecheck and **101 focused tests** pass: exactly ten new QA tests plus all 91
existing regressions. These cover the pinned shape, trusted attribution,
no competing service/terminal record, independent caller lifecycle, exact raw
replay/atomic malformed-batch rollback, conservative semantics/gaps, malformed
numbers/member/order, duplicate/mixed conflicts, scope isolation and stable
late revisions with byte-preserved v1-v4/offline reads.

Real `run-PIl5h8` (`asterisk-history-pil5h8`) retains **82 CEL records / 14,583
bytes and 11 queue records / 736 bytes per customer**, including all prior
timeout/member-ended/caller-ended regressions. New caller IDs
`1792921291.12` / `1792921292.12` each have nine scoped CEL refs and a two-record
ENTERQUEUE/ABANDON sequence with parameters `1|1|2` / `1|1|3`.
The observed LINKEDID_END is retained, not used to join channels. Initial
discovery exposed that extra caller record; its overstrict assertion was
corrected, failed owned resources cleaned and fresh acceptance passed.

Revisions **7/8** preserve all earlier journeys/keys/revisions; exact raw replay,
persisted/offline CLI reads, foreign denial and independent resource absence
checks pass. Actual historical v1/v2/v3/v4 stores still read under v5.
Generated credentials/configs are removed; ignored synthetic evidence remains.

Reproduce with `.\scripts\Test-QueueServiceEvidence.ps1 -Abandonment`; see
[QA contract/results](./MILESTONE-1.md#selected-autonomous-batch-ten-pre-connection-hangup-acceptance-tests)
and [observation semantics](./README.md#ten-test-batch-pre-connection-queue-abandonment-observations).
The agreed ten-test batch is complete; stop before expanding scope. Human
service, service audio, whole-journey outcomes, totals, remote delivery/retention
and M1-06/07 remain incomplete.

### Milestone checkpoint and current recommendation

Review date: **25 October 2026**, evidence baseline `04bb990`. This documentation
review supersedes historical "selected next" wording for current priorities,
without changing past results or authorizing implementation.

The [current gate matrix](./MILESTONE-1.md#milestone-checkpoint-after-the-autonomous-ten-test-batch)
maps every M1-01 through M1-18 requirement. **17 full gates remain open**;
M1-10 has a pass only for the selected local conventional echo-route outage
scope. No percentage-complete or production-ready claim is justified.
The recent 101 focused tests and real two-customer QA proof establish durable,
conservative synthetic observations, not all four business outcomes after restart,
human service, two-way queue-agent audio, recording access or a transfer graph.
This checkpoint inspects existing evidence; it does not rerun tests or REFER.

The main integration gap is between trusted operator history tools and the
authenticated application. Raw CEL/queue, manifests, collector/gap provenance
and immutable v1-v5 projections exist; current-input versus offline reads are
explicit. At checkpoint time they were not a tenant-authorized workspace.
The subsequently authorized HR batch below now provides bounded member-only
read access, not a complete call-history graph. Existing diagnostic/agent/
simulation grants do not expose history. Repeated same-caller/same-queue entry
stays ambiguous by design.

Recommended sequence:

1. **Bounded read-only history-evidence workspace: implemented and verified.**
   User selected explicit customer `history:read` membership only, no support
   grants, references-only exposure and autonomous HR-01 through HR-10 execution.
   All ten pass, alongside 151 focused existing regressions (161 total) and
   typecheck. Both customers' retained v1-v5 stores additionally pass real
   authenticated HTTP/browser reads and explicit current checks, with raw and
   projection bytes unchanged. Opt-in configured existing read-only stores,
   no inherited permission, scope/revision cursors, audit/session loss boundaries,
   offline versus checked freshness, legacy absence, independent health/gaps,
   separate observations and hostile/error handling are covered. No raw route,
   background collection, database creation/migration, rebuild or phone activation.
2. **Local process restart/interruption/replay slice: implemented and verified.**
   User selected owned copies of retained synthetic evidence, explicitly not
   PBX restart, with autonomous LR-01 through LR-10 execution.
   `run-aDwuAb` passes all ten integration checks plus typecheck and 111 focused
   history/workspace regressions. Actual collector attempts, importer
   transactions, projection publication and the application process are
   interrupted and restarted; replay/partial tails/malformed batches/late
   assignments preserve earlier facts and customer boundaries. Four permanent
   unknown gaps survive successful recovery. Application restart preserves
   durable audit/evidence, invalidates old sessions and supports isolated
   authenticated HTTP/browser reads. Canonical bytes remain unchanged; owned
   processes/transient snapshots are cleaned. **PBX restart/boot-epoch coverage
   and full M1-06/07 remain open**, as do remote delivery/rotation/retention.
3. **Plan limited route/queue publication** with validation, stale revisions,
   managed-file drift and owned apply/verify; this is a critical intended-call
   dependency, not replaced by report approval.
4. **Explicitly gate browser-agent activation**, then intended queue/media/
   controls/roaming/error acceptance. Existing reservations do not enable phones.
5. **Complete recording/engineering/export and combined restore** using agreed
   storage/access/retention/capture contracts and actual negative disclosures.

These are priorities, not a new authorization to build all five packages.
Further event interpretation, repeated-visit or transfer joins should be driven
by an agreed unsupported scenario, not an indefinite synthetic-test cycle.
The original documentation-only checkpoint made no dependency/runtime/permission
change. The subsequently authorized HR batch adds only the explicitly selected
read permission and opt-in workspace; ordinary routing, live phone, production
collection, voice AI and real Autocab integration remain out of scope.

See the [executed ten-check HR batch](./MILESTONE-1.md#selected-hr-batch-read-only-history-evidence-ten-acceptance-checks),
[opt-in setup](./README.md#opt-in-read-only-history-workspace) and
[executed LR contract](./MILESTONE-1.md#selected-lr-batch-local-process-interruption-and-replay).
Neither HR nor LR closes any full M1 gate. The remaining isolated PBX
restart/boot-epoch recovery proof requires its own selected bounded contract;
limited route/queue publication planning remains a separate priority.
M1 startup/capture thresholds, production capacity, retention and deployment
questions remain unresolved.

## 6. Interface and roaming agents

Proposed navigation:

- Overview.
- Live Operations.
- Telephony.
- People & Devices.
- AI & Integrations.
- Reports & Wallboards.
- Administration.

Provide a dedicated Engineering workspace for authorised specialists, linking
incident records and engineering call logs to traces, call flows, and evidence.

Platform provisioning/infrastructure tools are separate from customer workspaces.
Agents land in their console, not PBX administration.

The agent console combines availability controls, phone controls, caller context,
AI handover details, and queue status. It must expose microphone permission,
audio-device selection, and connectivity problems clearly.

Keep these separate:

- Web login.
- Agent session and device assignment.
- Endpoint registration/reachability.
- Queue availability.
- Active call state.

Statistics follow the person and historical assignment, not today's owner of an
extension. Define shared-device conflicts, stale sessions, breaks, after-call work,
browser disconnection, device moves, and logout during a call.

Phone-only agent login requirements are not yet settled.

## 7. Configuration ownership and publication

The database represents intended managed configuration. Asterisk receives a
generated, versioned representation. Preserve three distinct states:

1. Desired configuration.
2. Published configuration.
3. Observed runtime state.

### Ownership modes

| Mode | Behaviour |
|---|---|
| Managed | UI/backend generated; validated and versioned. |
| Expert extensions | Specialist-authored contexts/includes with explicit managed entry points. |
| External edits | Detected drift; reviewed and reconciled rather than silently overwritten. |

Unrestricted custom dialplan cannot reliably be converted back into guided forms.
The interface must identify behaviour it cannot model or validate.

Direct editing uses a customer-scoped maintenance workflow with operator/reason,
diff capture, and reconciliation. Unexpected edits outside that workflow also
trigger drift detection. On-disk configuration can differ from loaded state.

### Publication workflow

`draft -> validate -> impact review -> approval -> apply -> verify`

Validate references, destinations, loops/fallbacks, identifier conflicts, prompts,
outbound policies, and customer boundaries. Bind approval to the exact revision;
detect concurrent edits rather than overwrite newer settings.

Display applying, verified, failed, and uncertain states separately. A file write
or accepted reload request is not enough to prove the intended result is active.

Grouped publication needs ordered application and partial-failure handling;
it is not automatically atomic across all components.

Preserve a last-known-working revision and verify recovery. Configuration rollback
does not reverse calls, bookings, or messages already completed.

## 8. AI assistance, MCP, reports, and wallboards

Examples:

- Explain queue pressure using defined metrics.
- Propose a temporary IVR announcement with start/end time and expiry action.
- Draft routing changes with an impact summary.
- Build a saved report from approved measures and filters.
- Compose a wallboard from approved widgets.

The UI, MCP, and voice tools must reuse permission-enforcing backend operations.
Page context and AI-supplied customer IDs are not authorisation.

Separate read/report permissions from configuration and dispatch actions.
No unrestricted shell access, arbitrary SQL, or executable AI-generated dashboards.

Saved reports/wallboards contain versioned measures, filters, scope, time zone,
layout, refresh rules, and sharing permissions. Show the interpreted definition.
A saved wallboard runs without an ongoing LLM connection.

## 9. Logging and reporting data

| Source | Intended role |
|---|---|
| CEL | Primary durable channel lifecycle/relationship evidence for call reconstruction. |
| Queue log | Durable queue entries, offers/connections, abandonment, completion, and other supported events. |
| CDR | Summary listings and reconciliation; not sufficient for complex journeys. |
| AMI | Live calls, queues, agents, and endpoint updates; not the sole historical record. |
| ARI | Events relevant to application-controlled calls/media, especially AI. |
| Application events | Agent assignments, AI operations, dispatch outcomes, approvals, and platform actions. |
| Diagnostic logs | Troubleshooting, with separate access and retention. |

Configure the required CEL events and persistent backend explicitly. Preserve
source/customer identity and original evidence. Use channel and linked identifiers
as correlation inputs, not an assumption that one identifier always equals one
business journey.

### Proposed entities

Customer; user/agent; endpoint; agent session; availability interval; call journey;
call leg; queue visit; agent offer; AI conversation; booking operation; recording
asset; configuration revision.

Test transfers, Local channels, repeated queue visits, and AI handovers.

### Journey reconstruction design v1 (not implemented)

The full JD acceptance contract below remains unimplemented. QF/MM/JP now provide
raw queue evidence, immutable manifests, isolated markers and conservative
marked-caller/queue-timeout observations only; the remaining propagation,
relationships, outcome/metric and presentation design is not a recorded pass.

The user selected a documentation-only increment and explicitly chose:

1. **Trusted inbound-entry markers**, not inferred linked-ID roots.
2. **Separate outcome facts**, not one overloaded answered/failed label.

This design is a staged implementation contract, not reconstruction acceptance.
HF/CR store CEL channel evidence; the subsequent QF increment adds raw queue
evidence without implementing this journey model or enabling live phones. Use the finite
[JD acceptance matrix](./MILESTONE-1.md#journey-design-and-reconstruction-contract)
before implementing derived reports.

#### Evidence namespace and source pairing

Every reference is scoped by customer, runtime instance, runtime epoch, source
kind, source generation and byte offset. Runtime epoch means an explicitly
provisioned PBX process/incarnation namespace, not a timestamp inferred from an
Asterisk uniqueid. A source generation denotes a particular log stream/segment;
it is **not** a runtime epoch. One epoch may span multiple log generations and
one persistent log generation may contain multiple PBX restarts.

Before cross-source reconstruction, an operator-controlled manifest must map CEL
and queue sources to the same customer/runtime and explicit epoch boundaries.
Queue `QUEUESTART` and CEL IDs are supporting observations, not an automatic
epoch authority. If an event cannot be assigned to an epoch without ambiguity,
keep it unresolved; do not join its identifiers across possible incarnations.
HF source/generation IDs alone do not implement this manifest. MM now supplies
explicit immutable record-boundary assertions, retaining original identities and
leaving legacy epoch associations unassigned until an operator maps them.

Use a source-qualified record key for replay deduplication. Equal payloads at
different offsets are separate evidence; equal uniqueid/linkedid/queue names
across runtimes or epochs cannot join. New generation replay must not quietly
deduplicate overlapping exports or inflate derived entities: explicit overlaps
require evidence references and a conflict/alias decision. Never rewrite raw
records or original identifiers to force a match.

#### Proposed entities and cardinalities

| Entity | Identity and evidence rule |
|---|---|
| Journey | Customer/runtime/epoch plus explicit inbound-entry `journeyId`; one admitted external/test inbound interaction, not one channel or queue entry. |
| Channel leg | Runtime/epoch-qualified CEL uniqueid with start/end and observed channel-name history. One journey may reference many legs; bridge/consultation relationships may touch more than one journey without merging their roots. |
| Relationship | Typed, directed evidence edge (created leg, bridge participation, Local optimization, transfer or explicit continuation); retain supporting record keys and resolved/unresolved/conflicting state. |
| Queue visit | Explicit `visitId` where instrumented, plus caller-channel/queue and ENTERQUEUE record reference. A repeated ENTERQUEUE is a new visit even on the same channel and queue. |
| Agent offer | Attempt within a visit; queue member interface, ring observations and terminal evidence. Multiple members can ring for one visit. A member string is not a verified person. |
| Service segment | A proven queue CONNECT/bridge relationship between caller and member legs; separate from PBX answering or media announcements. |
| Transfer attempt | Source journey/leg plus transfer evidence; requested target, observed runtime transfer, target service and terminal/unknown state are separate. |
| Derived projection | Stable entity IDs, algorithm version, input checkpoint vector, scoped gap/health references, revision and evidence-backed facts. Not a replacement raw log. |

Recording and agent-session references remain optional future associations.
Never join by caller number, display name, time proximity, channel-name prefix,
endpoint extension alone or shared bridge alone. Those values may be shown as
scoped clues only. Human attribution requires the historical provisioned
assignment/session effective at the event, not today's endpoint owner.

#### Proposed trusted instrumentation contract

MM implements entry/visit instrumentation only in a separately approved isolated
synthetic fixture; the broader propagation/graph contract below remains design.
Ordinary echo probes and existing frozen REFER fixtures remain unchanged.

- On each approved inbound entry, before `Answer()`/queue/fallback, generate a
  fresh opaque journey UUID and emit `HISTORY_ENTRY` with a versioned JSON object:
  `{v:1, journeyId, entryKind, routeRevision}`. `entryKind` is a configured
  `external` or `synthetic` value; it is not a caller-supplied header.
- The CEL event supplies the root channel uniqueid and explicit source namespace.
  The dialplan must JSON-escape values and bound fields; missing route revision
  stays explicit rather than substituting the newest configuration revision.
  Marker schema validation, trusted route location and unique root association
  are required. A root key is scoped even when UUIDs are globally random.
- Internal queue retries, Local channels, consultation and transferred
  continuations inherit the existing journey context; they do not emit a new
  inbound root. A new independently arriving call receives a new root.
  Context propagation is evidence to validate, not an assumption about inherited
  variables surviving every channel optimization/transfer.
- Immediately before each Queue invocation, generate a fresh visit UUID and
  emit `HISTORY_QUEUE_VISIT` with `{v:1, journeyId, visitId, queue, routeRevision}` on the caller
  channel. Retain actual ENTERQUEUE as separate evidence; a marker alone does not
  prove entry, and queue application exit does not imply caller abandonment.
- Route-controlled continuation can emit a versioned `HISTORY_CONTINUATION`
  marker referencing the existing journey and source/target leg identities when
  native relationship events cannot unambiguously carry context. Exact event
  shape and provenance checks must be specified with the implementing route.
  Do not accept external JSON as trusted lineage or fabricate target IDs.

Unmarked legacy CEL and queue records remain queryable as **unresolved evidence**,
not silently promoted to business journeys. An identical repeated marker with
the same root is idempotent at the projection layer while retaining every raw
record. One journey ID attached to contradictory roots, or incompatible marker
payloads on a root, is a visible conflict excluded from confirmed totals.
Consultation involving two already marked inbound journeys creates a relationship
between two roots, never a union-find merge of both customers' calls into one.

#### Queue log ingestion and visit assembly

Queue file records have five fixed pipe-separated fields: Unix timestamp,
call/channel identifier, queue, member and event; all remaining fields are
event-specific parameters. Preserve the exact bytes and parameter array (including
empty fields). This format is not CSV: do not reuse CEL quoting, split it into a
fixed six-field object or pretend embedded pipes are escaped automatically.
Recognised event adapters validate required parameters for the pinned runtime.
Ambiguous delimiter-bearing data is flagged, not heuristically reassembled.

Retain `NONE`/`REALTIME` identifiers and administrative events such as QUEUESTART
and CONFIGRELOAD without treating them as caller journeys. Preserve unknown
events/extra parameters as unsupported evidence; never discard them or interpret
them as successful completion. Caller ID/name in ENTERQUEUE are sensitive raw
evidence, not identity keys. A future queue importer needs the same atomic
prefix/replay, byte/record/page bounds and customer-scoped reads as CEL, with its
own source kind and schema/migration tests.

Assemble visits using explicit visit context plus matching caller uniqueid/queue,
source order and the runtime/epoch manifest. Legacy ENTERQUEUE can define a
provisional evidence visit identified by its record key, but cannot create a
confirmed inbound journey. Re-entry creates a new visit, including after transfer
back to the same queue. Events that fit multiple open visits remain ambiguous;
do not assign them to the nearest timestamp or close an earlier visit silently.

| Evidence | Permitted interpretation | Not sufficient for |
|---|---|---|
| ENTERQUEUE | Observed queue entry; retain optional configured caller-name field. | Agent offer, human answer or new inbound journey by itself. |
| CONNECT | Queue service connection; hold time, member leg uniqueid and ring time are separate fields. | Real two-way audio, verified agent identity or a completed journey. |
| RINGNOANSWER / RINGCANCELED | Member offer did not connect / ringing was canceled. | Whole-journey unanswered or caller abandonment without visit evidence. |
| ABANDON | Caller abandoned this queue visit before service. | Every visit/journey was abandoned, especially after earlier service. |
| EXITWITHTIMEOUT | Queue waiting timed out. | Caller hung up, target rang without answer, or the journey ended. |
| EXITEMPTY / EXITWITHKEY | Empty-queue routing exit / explicit key exit. | Abandonment, fault attribution or failed fallback. |
| COMPLETECALLER / COMPLETEAGENT | Queue service ended, with the documented terminating party and durations. | All related legs ended or every subsequent route completed. |
| BLINDTRANSFER / ATTENDEDTRANSFER / legacy TRANSFER | Observed queue transfer evidence using version-specific parameters. | Target answered, successful media, or a new inbound root. |
| SYSCOMPAT / AGENTDUMP | Explicit compatibility/agent-disposition evidence. | A generic successful service or inferred blame for other legs. |

CONNECT's member-leg uniqueid must match CEL in the same namespace when available.
If missing, retain observed queue connection but mark the cross-source leg
relationship unresolved. Multiple offers or repeated visits never increase
confirmed inbound-journey counts.

#### CEL relationships, ordering and transfer interpretation

CEL orders records for a primary channel, not a universal ordering across all
channels. Preserve source offsets as source observation order; timestamps from
different channels/sources may tie, arrive late or disagree. Reconstruct by
explicit IDs/relationships first and timing second. Never claim causal ordering
from a stable display sort alone.

`linkedid` is a changing relationship hint, not an immutable journey key.
`BRIDGE_ENTER`/`BRIDGE_EXIT` and bridge IDs can support service relationships;
`LOCAL_OPTIMIZE` relates Local halves without creating a new inbound journey.
CHAN_END ends a channel, not necessarily a journey; LINKEDID_END can occur after
channel end and does not prove every business outcome. The existing eight-column
CEL mapping omits standard fields such as peer/application; preserve current raw
evidence and identify missing relationship fields instead of inventing them.
Additional mapping fields require a separately versioned source format adapter,
not changing the meaning of already-stored eight-column records.

For a blind transfer, distinguish request/activation from a correlated target
connection. An unanswered/rejected target remains unserved even if the runtime
logged BLINDTRANSFER. For attended transfer, retain the consultation leg, native
transfer relationship and any independent inbound root; do not count consultation
as another inbound call or erase a second existing root after a bridge merge.
SIP REFER/202/NOTIFY is signalling evidence, not by itself human service.
No new SIP transaction investigation or rerun of the frozen REFER matrix is
required by this design.

#### Separate facts, labels and completeness

Store supported facts with evidence references independently:

- `entry`: confirmed root / unresolved / conflicting.
- `callerAnswer`: observed answered / unknown (an answered PBX/IVR channel is not
  human service).
- `service`: observed connected / not observed / conflicting; absence is not a
  negative fact unless the route-specific complete fixture proves it.
- `queueDisposition`: per-visit connected/completed/abandoned/timed-out/empty/
  key-exit/other/open/unknown, retaining all contradictory terminals.
- `transfer`: none observed/requested/runtime-observed/target-connected/
  target-unanswered-or-rejected/unknown, with multiple attempts separately.
- `lifecycle`: open / all currently attributed legs ended / conflicting; an ended
  projection may still revise when late relationship evidence arrives.
- `evidenceQuality`: unresolved/partial/conflicting or validated for a particular
  fixture contract, including source health/gaps and missing markers/fields.

Missing records never become invented hangups or zero-duration successes.
Recent collector health is not completeness. Existing source-level unknown gaps
must be surfaced as applicable/possibly applicable/association-unknown; they are
collection observations, not precise missing-event intervals. Without a defensible
clock/epoch mapping, never claim a journey is outside a gap merely because its
timestamp appears earlier. Missing source manifests or epoch boundaries make
cross-source quality unresolved.

Friendly history labels are derived summaries, not one mutually exclusive stored
outcome. A journey may be "served; transferred; later queue timed out". The M1-06
fixtures must specify:

| Fixture label | Required interpretation |
|---|---|
| Served/answered | Explicit root and queue CONNECT/correlated member connection; caller-answer fact separate. Media acceptance remains a separate proof. |
| Unanswered | Test target/route never establishes service under the specified timeout/terminal contract; caller PBX answer may still be observed. A queue timeout alone is labelled queue timeout, not automatically this outcome. |
| Caller-abandoned | Confirmed pre-service visit ABANDON plus caller lifecycle and scoped root; a later abandoned re-entry must not erase previous service. |
| Transferred | Runtime transfer plus correlated continuation; target connection is reported separately and must be observed before calling that target served. |

#### Deterministic projections and reporting boundaries

Rebuild versioned projections from immutable evidence with an input checkpoint
vector (CEL plus queue and manifest revisions). Publish each projection revision
atomically, retaining previous revision/evidence provenance; a failed rebuild
must not expose a half-updated graph or replace the last projection with empty
success. Late/reordered cross-source evidence can revise facts without changing
stable root/leg/visit IDs. Readers see projection freshness plus contributing
collector status/gaps and algorithm version. Changing an algorithm or manifest
requires an explicit rebuild, not silent reinterpretation of old exports.

Replay must produce equal IDs/facts/counts for equal evidence/manifests even if
import batch sizes or cross-source arrival order differ; ingestion timestamps
and projection revision metadata are not expected to be identical.
New confirmed roots change totals once. Additional legs, offers, repeated
markers/visits or transfer continuations do not create inbound counts. Orphan
evidence is reported separately rather than counted or dropped.

Initial metrics are limited to confirmed inbound roots, distinct observed legs,
queue visits, connections and each evidenced queue terminal, with unknown/
conflicting entities disclosed alongside. They are different units; never add
legs or visits to the inbound denominator. Synthetic and external entry kinds
must be independently filterable and never silently mixed.
Customer-wide rates/totals must disclose excluded unresolved/conflicting roots
and applicable coverage uncertainty; suppress completeness-dependent percentages
where the denominator is not defensible.

Queue event-provided durations retain their native documented units and
provenance; validate nonnegative numeric fields. RINGNOANSWER duration is
milliseconds; CONNECT ring/hold and completion duration fields require pinned
adapter verification rather than assuming all parameters share a unit.
Cross-source timestamp subtraction cannot silently replace these measures.
Time-to-human-service is not PBX answer time or sum of overlapping queue visits.
Service-level thresholds, short-abandon rules, business-day inclusion and
occupancy denominators remain unagreed: do not implement those rates by default.
Unambiguous timestamps can map to UTC with declared source basis, while ambiguous
or nonexistent local times remain explicit. Test both UK DST transitions; business
time-zone bucketing must not collapse repeated local hours.

#### Implementation order and design sources

1. **QF: queue evidence foundation**: operator-only bounded raw ingestion,
   durable checkpoints/replay and scoped reads. This foundation is now implemented
   above with explicit source kind and no journey totals.
2. **JI: isolated instrumentation and reconstruction**: versioned trusted entry/
   visit markers in a new fixture, epoch manifest and deterministic graph with
   explicit ambiguity. MM now completes only immutable manifests and isolated
   marker observations. JP implements only conservative marked-caller/visit
   projection revisions; broader graph/propagation remain unimplemented.
   Prove local/transfer/re-entry cases with synthetic peers,
   without enabling the real agent phone or changing frozen REFER fixtures.
3. **JR: four-outcome acceptance and recovery**: queue/member fixtures, projection
   replay/rebuild/late-input and outage/gap cases, then honest M1-06/07 mapping.
4. **HP: authenticated history presentation**: separately scoped read permission,
   session/customer boundaries, audit and inert/redacted displays before exposing
   raw history or caller identity to users.

Each phase needs its own finite implementation contract and commit/push after
verification; this design does not authorise all phases in one increment.

Public references checked for this design:
[Asterisk queue log event documentation](https://docs.asterisk.org/Operation/Logging/Queue-Logs/)
and [CEL specification](https://docs.asterisk.org/Configuration/Reporting/Channel-Event-Logging-CEL/CEL-Specification/).
These are upstream semantics, not proof of the exact emitted event shape in the
pinned runtime. Confirm consumed adapters against actual
`22.11.0_debian-trixie` fixtures before implementation acceptance.
Repository prior art:
[CEL mapping](./local/asterisk/cel_custom.conf),
[current routes](./local/asterisk/extensions.conf),
[empty queue fixture](./local/asterisk/queues.conf) and
[queue-timeout/restart checks](./scripts/Test-LocalProof.ps1).
The existing proof route calls Answer before Queue; its empty queue only proves
ENTERQUEUE/EXITWITHTIMEOUT and persistence, not human service, abandonment or
transfer. The existing echo history proves lifecycle only. No new acceptance
test was executed for this documentation-only design.

### Metric definitions

Define inbound journeys, queue waiting time, abandoned visits, service level,
handling time, occupancy, AI booking completion, handover reasons, and dispatch
uncertainty before presenting charts.

Document denominators, thresholds, short-abandon rules, exclusions, and time basis.
End-to-end waiting and individual queue waiting are different metrics.

### Collection reliability

Use stable identifiers, duplicate detection, occurrence/ingestion timestamps,
durable buffering where practical, outage detection, and reconciliation.
Do not promise exactly-once delivery or perfect reconstruction.

Historical reports disclose gaps. Live views show freshness and stale states.
Store timestamps consistently; calculate business periods in an explicit time zone
and test daylight-saving transitions. Default wallboards exclude personal details.

## 10. Recording, retention, and support

The user identified approximately one-year retention as a common taxi licensing
requirement. This is not established here as a universal legal rule. Validate
obligations for the relevant licensing authority and customer circumstances.

Compared approaches:

- Fixed 12 months: simple but potentially inappropriate for some customers.
- Fully configurable: flexible but easy to misconfigure.
- Controlled templates with approved exceptions: recommended, not yet agreed.

Define recording scope, duration/rationale, playback/export permissions, expiry,
authorised holds, policy-change impact, and backup expiry.

Recordings, transcripts, AI summaries, metadata, and audit records require separate
retention decisions. Avoid payment-card capture if telephone payments are added.

Use private encrypted storage, tenant-scoped retrieval, audited playback/download,
and detection of missing/incomplete uploads. Estimate storage from measured audio
sizes and call volumes, not concurrent-call counts alone.

Support normally receives redacted diagnostics. Contract-authorised elevation must
be scoped, time-limited, reasoned, and audited. It does not automatically grant
recording, transcript, or caller-content access.

## 11. Authentication and permissions

Evaluate an established identity provider rather than implement identity protocols.
A candidate approach is application OIDC with brokered enterprise SAML/Entra and
social identity connections.

Define tenant-specific policies, account linking, MFA enrolment/recovery, and
platform-administrator recovery. Social sign-in is not inherently an extra factor.

Proposed role templates:

- Platform operator.
- Customer administrator.
- Telephony specialist.
- Supervisor.
- Agent.
- Analyst.
- Narrow integration/service identity.

Use explicit permissions for playback/export, expert configuration, sensitive
routing, and support elevation. Live listening/whisper/barge-in are not agreed
features and would require separate scope and controls.

## 12. Deployment and isolation

### Initial topology to evaluate

- Management host: application, identity integration, database, reports, MCP.
- Telephony hosts: customer Asterisk containers, collectors, recording buffers,
  and narrowly scoped runtime management.
- Voice workers placed according to measured latency and capacity.
- Private object storage for recordings.

Local development can combine roles. Use the same built images across environments,
with environment-specific networking, secrets, and certificates.

Compose does not provide multi-host scheduling or high availability.

### SIP and media topology options

- Per-instance public addresses and explicit media ranges.
- Shared SIP edge routing to private instances.
- Separate customer VMs containing the customer containers.

Multiple instances cannot independently bind the same public IP/port. HTTPS reverse
proxies do not solve SIP/RTP. Browser calling requires secure signalling, media
negotiation, and potentially TURN. Validate IONOS capabilities before selection.

### Isolation controls

Separate credentials, configuration, volumes, resource identifiers, and unnecessary
network access. Enforce tenant scope in APIs, database access, jobs, storage, and AI.

Custom dialplan can invoke powerful operations. Restrict runtime privileges,
modules, mounts, secrets, and network access. Never expose Docker's socket or
host-wide credentials to customer runtimes or the web application.

Provisioning should use defined, authorised operations rather than arbitrary shell
commands. Operator-run provisioning is acceptable for the initial prototype.

### Provisioning lifecycle

Create organisation/admin -> allocate resources -> create credentials/storage/network
-> deploy runtime -> configure logging/monitoring -> establish management access
-> readiness tests -> ready for customer telephony configuration.

Track provisioning, ready, operational, degraded, maintenance, suspended, and
decommissioned states. Retries and cleanup must be explicit.
Suspension, stopping calls, and deleting retained data are different operations.

## 13. Resilience and operational safeguards

- Conventional calling should not depend on a healthy management application.
- AI routes require tested queue/IVR and unanswered/out-of-hours fallbacks.
- Detect failed/stalled AI and avoid repeated routing into an unhealthy service.
- Host failure needs upstream/provider or alternate-host design; AI fallback alone
  does not provide telephony high availability.
- Apply per-customer concurrency, storage, report, and integration limits.
- Restrict outbound destinations and monitor abuse; consider provider spend controls.
- Define emergency-calling behaviour with the provider and service scope.
- Keep secrets out of prompts, logs, ordinary diffs, and support bundles.

Upgrade customer instances incrementally: check drift and compatibility, back up,
drain or schedule maintenance, upgrade, verify calls/media/logging, then continue.
Restarts can interrupt calls. Seamless failover and upgrades are not promised.

Define backup/restore tests and recovery objectives before production.
Private networking reduces exposure but does not remove authentication needs or
eliminate latency.

## 14. Capacity and verification

Confirmed target: per customer, 50 simultaneous calls including up to 10 AI calls.
This is not a verified capacity claim. Separate aggregate multi-customer tests and
resource-isolation tests are required before production sizing.

Measure codecs/transcoding, recording, WebRTC/TURN, media mixing, event ingestion,
report queries, provider limits, and speech/model latency. No host sizing has been
validated.

### First vertical slice

1. Provision customer and configure trunk/inbound route.
2. Log a browser agent into a queue.
3. Receive, transfer, and record a call.
4. Reconstruct history from durable records.
5. Display authorised call details.
6. Add AI booking through a simulated dispatch connector.
7. Confirm dispatch outcome or hand over with context.

### Essential verification scenarios

- Two customers with simultaneous isolated call paths and two-way audio.
- Agent roaming without rewriting historical attribution.
- CEL/queue reconstruction for transfers, Local channels, and repeat visits.
- AI failure before and during calls.
- Dispatch rejection, timeout, uncertain outcome, and duplicate risk.
- Management outage while conventional calling continues.
- External configuration drift and partial publication failure.
- Recording upload interruption, recovery, access control, and expiry.
- Cross-customer denial through UI, API, MCP, jobs, storage, and expert facilities.
- Mixed load at the agreed target and protection from a noisy customer.
- Multilingual speech/address accuracy and daylight-saving boundaries.
- Backup restoration and customer-by-customer upgrade recovery.
- Diagnostic activation, automatic expiry, capture limits, packet-loss reporting,
  encrypted signalling visibility, and isolation on shared capture points.
- Reproduce known SIP/media faults and check that analysis cites evidence,
  distinguishes uncertainty, and does not assign unsupported blame.
- Evidence export redaction, integrity manifests, and recipient access controls.

Set measurable latency, quality, headroom, data-completeness, and recovery thresholds
before declaring these tests passed.

## 15. Delivery sequence and next planning work

1. Refine workflows, permissions, deployment assumptions, and Autocab contract.
2. Prove container/network/media/logging foundations.
   Include basic incident-linked SIP capture and call-flow inspection.
3. Build the management and roaming-agent vertical slice.
4. Add voice AI with a simulated connector, then Autocab.
5. Add trustworthy reports, wallboards, and contextual AI/MCP capabilities.
6. Harden isolation, retention, recovery, multilingual quality, and IONOS deployment.

Next detailed planning work:

**Current priority:** the
[post-QA milestone checkpoint](#milestone-checkpoint-and-current-recommendation)
and its proposed read-only history-evidence batch. The sequence below records
earlier selections/completions, not pending instructions to repeat AW/BS/SW.
No new implementation or phone activation is authorized by this checkpoint.

Current priority after the final synthetic REFER regression: resume step 3,
the management and roaming-agent vertical slice. The
[REFER investigation is frozen](./README.md#refer-investigation-stopping-point);
its deferred instrumentation work is not a prerequisite for another automatic
test-expansion cycle and is not marked complete. Existing phone-activation and
admission safety gates remain in force; this change does not enable live calling.
Define the bounded customer/agent workflow and its acceptance criteria before
adding more low-level SIP scenarios. Simulated booking integration follows that
slice; real Autocab behavior must be based on the supplied API YAML and test access,
not guessed provider operations.

The selected next deliverable is now the
[bounded customer/agent workflow specification](./MILESTONE-1.md#selected-next-increment-customer-and-agent-workflow):
three screen responsibilities, explicit assignment/reservation/recovery states,
and twelve acceptance checks (AW-01 through AW-12). Implement that UI increment
using existing APIs before opening further scope. This specification is not a
claim of production readiness. The
[executed workflow evidence](./MILESTONE-1.md#executed-workflow-ui-evidence)
now closes AW-01 through AW-12 for the bounded existing-API UI increment.
The selected next scope is the
[deterministic booking simulation](#selected-next-increment-deterministic-booking-simulation),
with ten finite backend acceptance checks (BS-01 through BS-10). Phone activation
remains separately gated and disabled; implementing this simulation does not
authorise a real booking or new user-facing mutation surface.

- Customer setup and agent-console screen specifications.
- Aggregate capacity, production sizing, and provider quotas.
- IONOS networking/topology comparison.
- Asterisk image and identity-provider evaluation.
- Autocab YAML review, including call-pop semantics and test-account access.
- Retention-policy comparison and applicable obligations.
- Explicit acceptance criteria and a prioritised implementation backlog.
- Engineering incident workflow, capture topology, export templates, and
  evidence-based AI diagnostic acceptance criteria.

## 16. Engineering diagnostics and evidence

### Requirement and purpose

Engineering fault identification is a first-class product requirement, not an
afterthought to ordinary call reporting. When a fault is detected or reported,
authorised staff must be able to activate diagnostic mode, collate available full
SIP signalling at selected network observation points, inspect sngrep-like call
flows, and use AI to assess likely cause and fault location.

Engineering incident/call logs must link directly to this workspace. Reports must
be exportable in readable formats for providers, customers, and other third parties.
The following workflow and implementation details are proposed, pending refinement.

### Incident workflow

1. Open an incident manually or from a monitored fault.
2. Record customer, symptoms, affected numbers/trunk/devices, example calls, time
   range/time zone, severity, and reproduction steps.
3. Review capture scope, permissions, duration, and resource limits; activate.
4. Reproduce the issue or collect subsequent matching calls.
5. Correlate network traces with Asterisk and application evidence.
6. Inspect the call flow and request AI-assisted analysis.
7. Record the engineer's conclusion and approved evidence for sharing.
8. Stop/expire capture, export the evidence pack, and track remediation/retest.

Automatic detection can create an incident or suggest activation. Automatic
capture activation requires explicit policy, narrow scope, auditing, and expiry;
it is not permission to capture every customer's traffic indefinitely.

### Capture and visibility

- Select observation points such as the SIP edge, host interfaces, and customer
  container network. Capture placement must follow the actual SIP/media topology.
- Collect SIP requests/responses, headers, SDP, timing, addresses, transport, and
  retransmissions where visible; support PCAP/PCAPNG evidence.
- Combine wire evidence with scoped PJSIP logging and CEL/queue/runtime records.
  Application signalling logs are complementary, not a substitute for packets.
- Correlate Call-ID, tags, channel identifiers, and mapped legs. Asterisk can use
  different SIP Call-IDs on different sides of the same business call.
- Label each observation point and clock source; synchronise clocks and report
  known skew, packet drops, truncation, and capture gaps.
- Network captures of TLS/WSS do not expose plaintext SIP. Use authorised
  application-side signalling records or capture at a controlled termination
  boundary; do not disable transport encryption to make diagnostics easier.
- Browser media diagnosis may require ICE/TURN and endpoint statistics in addition
  to SIP. RTP/RTCP metadata and endpoint reports can support quality analysis where
  available. Capturing audio payload is a separate, more sensitive permission.
- Historical packets cannot be recovered after the fact unless already retained.
  Compare an optional bounded pre-trigger ring buffer against its privacy, storage,
  and resource cost before deciding to enable it.

Use a narrowly privileged capture agent with allowlisted interfaces/filters rather
than grant arbitrary host commands or broad packet access to the web application.
Apply time/size limits, rotation, disk-pressure safeguards, and automatic stop.
Shared-interface captures can contain multiple customers: enforce segregation at
collection/storage and before any viewing, AI analysis, or export.

### Interactive engineering display

Provide a searchable call list and a browser-native sngrep-style ladder:

- Filter by incident, customer, time, trunk, endpoint, Call-ID, and outcome.
- Show participants, message direction, timestamp/delta, response codes, and retries.
- Open raw SIP/SDP alongside human-readable annotations.
- Link related call legs, CEL/queue events, configuration revision, and relevant
  registration, DNS, certificate, firewall/NAT, or media observations where available.
- Mark missing evidence and suspected relationships explicitly.

Evaluate sngrep, packet-capture tools, and a SIP capture platform such as
HEP/HOMER before selecting tooling. The requirement is an accessible engineering
experience, not embedding a privileged terminal or claiming an existing browser UI.

### AI diagnostic behaviour

The analysis should produce:

- Observed symptoms and a timestamped evidence timeline.
- Ranked hypotheses, likely fault domain, confidence, and supporting/contradicting
  packet or event references.
- Explicit separation of observed fact, inference, and missing evidence.
- Suggested next measurements and safe remediation proposals.

Potential domains include endpoint, customer LAN, NAT/firewall, platform routing,
SIP provider, media path, AI service, and dispatch integration. A single-sided trace
cannot prove what happened inside a provider or downstream network. A SIP response
code alone does not conclusively identify the party at fault.

AI must be able to conclude "insufficient evidence." Treat SIP headers, caller
content, and external messages as untrusted data, not instructions. Redact and
minimise data before approved model access; do not automatically send raw traces
or media to external AI. Diagnosis does not authorise autonomous configuration
changes or weaken the existing approval workflow.

### Exportable evidence packs

Proposed outputs are readable PDF/HTML reports plus optional restricted technical
attachments such as PCAP/PCAPNG, signalling text, event extracts, and metadata.

Include incident reference, scope, capture points/time zones, relevant software and
configuration revisions, call-flow diagrams, numbered evidence, conclusions,
confidence/limitations, recommended actions, and retest results.

Keep original evidence immutable with an integrity manifest/checksums and capture
provenance. Integrity hashes identify changes; they do not prove fault attribution.
Generate recipient-specific redacted copies, preserving consistent pseudonyms so
call correlation remains useful. Inspect document content, attachments, and export
metadata for caller information, addresses, credentials/authentication material,
and unrelated customer data. Label AI drafts versus engineer-reviewed conclusions.

Audit capture, viewing, AI access, and export. Use authorised downloads or expiring
access links; do not expose public packet URLs. Diagnostic evidence has a separate
retention/hold policy from call recordings and may contain sensitive call content.

This document records the discussion to date. Unresolved recommendations must not
be treated as approved requirements or verified implementation behaviour.

See [Milestone 1 specification](./MILESTONE-1.md) for the proposed local functional
scope, acceptance criteria, implementation sequence, and inspected environment.
