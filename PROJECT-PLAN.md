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
   processes/transient snapshots are cleaned.
   The user then separately authorized **BE-01 through BE-10** for isolated PBX
   restart/boot-epoch recovery. `run-VntQha` / `asterisk-history-vntqha` passes
   typecheck, 111 focused regressions and all ten BE checks: sequential restarts
   preserve exact log prefixes, observed process changes and stopped-volume byte
   boundaries establish explicit boot ranges, and actual reused uniqueid/linkedid/
   marker/queue identities remain isolated across four customer/boot scopes.
   One source generation spans two boots; no time-based join or automatic epoch
   assignment. Four authenticated HTTP/browser scope cases and replay/overlap/
   foreign revision denials pass. Owned Docker/credential resources are removed,
   independently verified absent; only synthetic SQLite/report files remain.
   **Full M1-06/07 remain open**, including all business outcomes after restart,
   production boot attestation and remote delivery/rotation/retention.
3. **Limited publication: offline foundation and empty-baseline inspector implemented.**
   One isolated synthetic inbound route to one empty queue with timeout/hangup;
   no member/endpoint/credential changes. Same authorized operator may explicitly
   approve the exact immutable draft; apply is a separate deliberate trusted
   operator CLI action against a uniquely owned proof project, not a web Docker
   capability. The [selected contract](#selected-first-publication-slice)
   defines fail-closed ownership, validation, stale/drift checks, exact observed
   runtime verification and conditional verified recovery. CP-01 through CP-10
   remain unverified as full checks. The strict compiler, immutable scoped
   drafts/validation/approval and durable offline operation fencing now have
   CF-01 through CF-15 tests. The separate owned binding/read-only inspector
   passes CI-01 through CI-10 on two fresh pinned PBXs. No executor exists;
   base remains zero and offline approvals do not acquire runtime authority.
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
[executed LR contract](./MILESTONE-1.md#selected-lr-batch-local-process-interruption-and-replay)
and [executed BE contract](./MILESTONE-1.md#selected-be-batch-isolated-pbx-boot-epoch-recovery).
HR/LR/BE do not close any full M1 gate. Limited route/queue publication planning
is now selected below. Its implementation/owned runtime acceptance is the next
scope decision; neither draft approval nor this design authorizes a live apply.
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

### Selected first publication slice

Selected after BE on **25 October 2026**, initially as a documentation-only
contract. The subsequently authorized offline model/compiler and dedicated
draft/approval/operation store, then owned empty-baseline binding/read-only
inspector, are implemented below. No web permission/API, executor or runtime
publication is implemented. M1-09 remains open.

The user selected:

- **Model:** one isolated synthetic inbound route to one empty queue, followed
  by bounded timeout and explicit hangup. No live inbound number, trunk,
  outbound destination, IVR, recording, member, agent assignment, endpoint,
  credential or existing route is editable in this slice.
- **Approval:** same-author approval permitted for the local prototype.
  Approval is explicit and bound to the exact customer/runtime, immutable draft,
  base revision, canonical model/compiler/output hashes and impact summary.
  This is not separation of duties or a four-eyes control.
- **Execution:** trusted operator CLI against a unique owned proof project.
  No web Docker socket, arbitrary command, host/path input or production apply.
  Browser draft/approval surfaces and worker-based execution remain deferred
  until separately scoped; a future UI must reuse the same backend operations,
  not reimplement the state machine.

#### Finite managed model and ownership

Use a strict versioned model (`schemaVersion:1`) with only logical route ID,
queue ID and queue-wait seconds. The initial fixture has exactly one route
and one queue; identifiers are lowercase bounded slugs and never executable
dialplan text. Proposed concrete bounds: slug `[a-z][a-z0-9-]{0,31}` and wait
integer **1 through 30 seconds** inclusive. Reject unknown keys, duplicates,
wrong types, noncanonical numbers and references to absent/foreign objects.
No customer ID inside the model confers authority.

Server/operator provisioning assigns the customer, runtime, owned project,
reserved context/queue namespace and destination paths. The command selects
only a provisioned binding, never arbitrary filesystem paths, Compose files,
container IDs, executable strings or dialplan fragments. Namespace derivation
must be deterministic and collision-checked against unmanaged disk and loaded
runtime objects. A new binding starts only from explicitly inspected empty
reserved ownership, not automatic adoption of matching external objects.

Only two generated artifacts are owned: the reserved dialplan fragment and
queue fragment. Existing fixture baseline files receive only the explicit
include hooks at owned project bootstrap. Those baseline files, hooks and their
relevant dependency hashes are prerequisites, not editable publication payloads.
No wildcard include, general configuration-directory rewrite, global/module
reload, PJSIP/manager secret rewrite or broad expert editor is part of the model.
Actual safe include/reload behavior and scope must be established on the pinned
runtime by CP-05/06 before being described as supported.

The route's fixed semantics are: mark a synthetic entry/visit with fresh
per-call UUIDs and the exact route revision, PBX Answer, enter the selected empty
queue for the bounded configured wait, then Hangup. Entry must precede Answer;
visit must precede Queue. Empty-queue options must preserve the existing proof
behavior. This Answer is not human queue service. Runtime publication does not
register historical evidence manifests automatically; any later history proof
requires its own exact observed source/epoch/range assignment. Static/reused
marker IDs from BE are not a production route-generation pattern.

#### Durable intent, approval and application identity

Use a dedicated customer/runtime-scoped local store following existing SQLite
identity/schema, transaction and bounded-input conventions. Persist immutable
draft revisions with canonical model bytes, compiler version, both output
digests, expected current **verified** publication revision, operator/reason and
timestamps. Validation returns bounded structured errors and the exact
generated diff/impact; it does not mutate disk/runtime or silently correct input.

An approval stores the exact validated identity/hash tuple and approving
operator/reason. An edit creates a new draft; it cannot move an existing approval.
Reapproval never changes the expected base. Same-author permission must be
visible in receipts. Operator attribution comes from trusted local execution
and an explicit bounded operator reference; it is **not authenticated customer
identity**. Do not invent web `config:*` grants in this CLI-only slice.

Apply requires the approved revision/hash, expected verified base and a unique
operation ID. Atomically claim one active operation per customer/runtime before
external effects; competing processes and stale approvals must fail closed.
Retries using the same ID return/inspect that exact operation, never execute a
second apply. Reusing an ID for a different intent conflicts. Approval, CLI
acknowledgement, file write, reload acknowledgement and runtime verification are
separate facts. Persist step intent before each external effect and the observed
result afterward; a SQLite transaction cannot make multiple files plus PBX reload
atomic. Do not hold a database transaction across slow runtime commands.

Proposed finite states:

`draft -> validated -> approved -> applying -> verified`

Other explicit terminal/holding states are `validation-failed`, `stale`,
`drift-blocked`, `failed-before-change`, `recovery-required`, `recovering`,
`rolled-back-verified` and `uncertain`. Preserve per-attempt results as an
append-only operation history; validation/approval do not advance published state.
Only a verified operation advances the last-verified publication pointer.
An uncertain or recovering operation blocks new applies until reconciled.
Resuming is never automatic on application or CLI startup.

#### Preflight, staged apply and independent verification

Preflight must recheck the binding, owned project/container identity and pinned
runtime, current verified revision, approval hashes, compiler version, include/
dependency hashes, both managed disk files and selected loaded runtime objects.
Inspect the exact expected inventory, not only an embedded revision label.
Manual reload or a runtime restart may produce loaded-state drift even when
disk matches. Unexpected/missing/extra objects in the reserved namespace block.
A drift report distinguishes disk, loaded and intended state and is bounded/
customer-scoped. Do not import arbitrary external edits into guided forms.

Stage deterministic artifacts in the same owned filesystem with safe fixed
permissions, complete-write/flush/close and integrity checks. Save the prior
verified exact bytes and observed inventory (including an explicit empty
baseline for first apply). Recheck hashes immediately before each replacement
and reload. Refuse symlinks/unexpected file types or changed ownership bindings.
Atomic per-file replacement is not atomic grouped publication. Fixed ordering,
step receipts and a restrictive lock shared by cooperating executors limit
interleaving; unmanaged editors do not obey that lock. Do not claim compare-and-
swap filesystem safety against a concurrent privileged external writer.

The first proof may apply only while both owned PBXs are quiescent and the target
queue has no members/callers. No active-call-safe publication claim is made.
Apply the queue dependency before the route, reload only the required supported
components, and independently inspect the exact loaded queue policy/member set
and route priorities/destinations/timeout/markers for the approved revision.
An accepted reload or successful file write is never `verified`.
If the pinned runtime cannot expose enough of these facts, stop the runtime
implementation and narrow the claimed contract; do not substitute a green hash.

Require both static observation and a bounded **explicit synthetic canary**:
invoke only the reserved route, correlate its exact marked caller/queue records
to the selected revision, observe the expected timeout/hangup, and prove no queue
member connection. Read-only `inspect`/status must never originate a call.
Canary intent/attempt is durable; if the executor dies after sending it but
before a receipt, flag unknown canary delivery rather than auto-originate again.
A verified canary is not service audio, human availability or production health.
The other customer's files/runtime/owned bindings must remain unchanged.

#### Failure, rollback and restart reconciliation

Before-change failure leaves the verified pointer and disk/runtime untouched.
After any possible external effect, an exception, timeout, lost acknowledgement,
process death or runtime restart yields `recovery-required`/`uncertain`, never a
success-shaped fallback or blind retry. Inspector commands are read-only and
show intended, observed and last-verified states plus the operation reference.
They must work when the PBX is unavailable, displaying observation failure rather
than replacing previous evidence with an empty success.

Recovery is a separate explicit operator command referencing the interrupted
operation and reason. Inspect disk/runtime first. If already exactly at the
approved target, require the missing verification before recording completion.
If rollback is selected, restore exact last-verified bytes **only if** current
files still match bytes attributable to the operation's recorded effects.
Unexpected external edits block automatic restoration; preserve evidence and
require controlled reconciliation, not overwrite. Restore dependencies in a
safe fixed order, scoped reload, then independently inspect and canary a
restored nonempty configuration before `rolled-back-verified`. For the empty
initial baseline, verify absence of every reserved loaded route/queue object
and unchanged unmanaged inventory; do not originate through a removed route.
Failed rollback stays
uncertain and blocks further applies. A rollback receipt references both the
failed target and recovered base; historical attempts remain immutable.
No rollback claims to reverse any call/event already generated.

#### Planned CP acceptance and implementation stop

The exact ten-check [CP acceptance contract](./MILESTONE-1.md#selected-cp-design-limited-routequeue-publication)
remains **unverified as full checks**. Implementation order:

1. **Offline foundation implemented:** strict model/compiler and dedicated durable
   revision/approval/operation store, CF-01 through CF-15; no runtime executor.
2. **Empty-baseline binding/read-only inspector implemented:** CI-01 through CI-10
   on two uniquely owned pinned PBXs; no nonempty published-state inspector.
3. Scoped operator apply/recovery and pinned two-customer quiescent canaries;
   failure injection verifies every external-effect boundary.
4. Only after exact CLI acceptance, separately decide browser permission/audit
   policy, member/endpoint changes and any production worker.

The original design increment stopped after documenting the contract; the
following increments implemented item 1 and the bounded empty-baseline part of
item 2. No apply/reload, runtime permission, new member, ordinary routing change,
phone activation or REFER rerun was performed. The inspector proof boots/restarts
only uniquely owned fixtures and uses pre-boot collision fault configuration.
Runtime surfaces and durable recovery must be verified end-to-end before calling
M1-09 complete.

#### Implemented offline publication foundation

[Compiler](./src/configuration-model.ts), [store](./src/configuration-store.ts),
[CLI](./scripts/Manage-ConfigurationDraft.ts) and
[15 CF acceptance tests](./tests/configuration-foundation.test.ts) now implement:

- Exact flat `schemaVersion:1, routeId, queueId, waitSeconds` JSON, 4096 UTF-8-byte
  input limit, selected slug/wait bounds, duplicate-key detection including
  escaped keys, canonical unsigned integer tokens, bounded structured validation
  errors, no coercion or invalid-input draft insertion.
- Deterministic canonical model/compiler/artifact digests. Namespace is
  `cp-` plus the first 24 hex characters of SHA-256 of the ordered customer/runtime
  tuple; route and queue suffixes are logical IDs. Artifact provenance includes
  compiler generation, scoped draft revision and a model-digest prefix. The
  complete scoped draft hash binds full model, output, compiler, base and
  attribution, avoiding a circular output/revision digest. The separate inspector
  checks empty-baseline collisions; hash derivation alone does not establish
  namespace ownership. Output remains in memory/database, never runtime files.
- Dedicated SQLite identity/schema, DELETE/FULL durability, scoped immutable
  revisions, one validation and approval receipt per revision, exact draft and
  validation hashes, visible same-author policy, explicit operator/reason/time.
  Local operator references are not authentication, approval is not runtime apply
  authority, and checksums detect corruption rather than provide tamper resistance
  against an actor able to rewrite the database and all hashes.
- Atomic per-scope operation reservation, exact-intent ID retries, independent
  scope fencing and append-only operation events. Offline states are `claimed`,
  `cancelled-before-effects` or `uncertain`; these are not runtime `applying` or
  `verified`. Only still-claimed offline reservations can be cancelled. Uncertainty
  cannot be cleared by this API; it persists across process startup.
- Read-only existing-store inspection without creation/migration/runtime access,
  checksum/compiler/receipt-binding checks, and explicit errors for storage failure
  or foreign schemas. Real competing processes and kill inside/after the actual
  claim transaction verify rollback and durable fencing.

Expected base accepts **zero only**, meaning no verified publication exists in
this offline store, not an inspected empty PBX. Labels identify logical offline
scope; they are not provisioned project bindings. Validation's additive diff is
explicitly `empty-uninspected`, not a computed disk/runtime diff. There is no
last-verified pointer, external-effect step API, runtime-bound approval or executor,
canary, rollback, automatic resume, new permission, browser surface or dependency.
Rejected input returns structured errors rather than persisting a draft with a
`validation-failed` lifecycle; the richer runtime lifecycle remains deferred.

The [README workflow](./README.md#limited-publication-offline-foundation-and-read-only-inspection)
documents CLI input/output. CF tests cover offline parts of CP-01/02/03/07/09/10.
The following CI proof adds bounded empty-baseline portions, not full CP passes.

#### Implemented owned empty-baseline inspection

[Inspector/binding](./src/configuration-inspector.ts),
[read-only CLI](./scripts/Inspect-Configuration.ts),
[nine offline tests](./tests/configuration-inspector.test.ts) and the
[owned runtime proof](./tests/configuration-inspection/run.ts) now implement:

- An explicitly trusted bootstrap binding, canonical/checksummed/exclusive on
  local disk, to one customer/runtime/namespace, unique proof project/service,
  exact container and image IDs, pinned repository digest, process start
  observation, fixed read-only mount and all 22 exact config/dependency hashes.
  Managed fragments must be empty. Baseline include hooks and UUID module load
  are installed only in generated fixture copies before first boot.
- Bootstrap compares the expected disk and known loaded inventory before
  persisting a binding. Model labels do not confer authority; the inspection
  command accepts only that binding plus matching scope. It cannot choose
  Docker commands or config paths from a model, mutate offline approvals, adopt
  discovered unmanaged objects or move a verified publication pointer.
- Fixed read-only Docker inspection and bounded Python file/CLI probes. File
  and directory no-follow/regular-file guards, 64 files, 64 KiB per file, 1 MiB
  aggregate bytes, 256 KiB per CLI output and 2,000 dialplan priorities bound
  the read. Unknown/truncated dialplan output, including empty unsupported
  contexts, cannot become evidence of absence.
- Parse and compare every known loaded dialplan context/extension/priority/
  application/argument/source filename. Compare exact queue display, UUID module
  and cold quiescent channel/call counts. Report managed/dependency disk drift
  separately from loaded dialplan/queue drift. Reports contain digests/object
  names, not secret configuration. Identity and disk checks around the sample
  detect observed process/file changes, not every concurrent transient edit.
- Read-only CLI exits 0 for `empty-baseline-observed`, 2 for `blocked`, 1 for
  `unavailable`; all reports keep `executorEnabled:false` and
  `publicationVerified:false`. PBX outage/restart, foreign scope/project/image/
  container/mount, malformed bindings and failed/unsafe reads never reuse a
  successful observation or auto-rebind.

`run-OymB5Y` / `asterisk-inspection-oymb5y` passes typecheck, 77 focused tests
and CI-01 through CI-10. The deliberate negative fixture cold-boots one compiler
route/queue, restores both files to empty **without reload**, and proves that
matching disk cannot hide one loaded reserved context and queue. The previous
binding rejects that boot; even a later clean boot does not replace it. B stays
independently responsive. This is fault-fixture bootstrap, not publication or
rollback; no calls/reloads occur. Owned containers/networks/volumes, generated
config/credential copies and Compose override are removed and independently
checked absent. Repository baseline bytes are unchanged; only result/binding
metadata is retained.

Limits remain explicit: this inspector supports **only a cold empty managed
baseline**, not a verified nonempty revision. It samples rather than atomically
locks runtime state; Docker labels, local actor references and start tokens are
not authenticated customer identity or production boot attestation. Queue
display does not establish all loaded policy fields (timeout/joinempty/etc.).
Symlink no-follow guards exist, but the CI runtime batch specifically measures
nonregular-directory rejection, not every filesystem race or symlink variant.
The original offline approvals did not bind a project or observation. The
following optional immutable inspection review adds those hashes, but is not
runtime apply authorization or atomic preflight-to-effect fencing.
CP-04/05/09/10 gain only bounded partial evidence; all full CP checks
remain unverified. No staging, scoped reload, canary, verified pointer,
conditional recovery/rollback or web surface is implemented.

#### Inspection-bound review and verified capability limit

The next pre-executor increment adds an optional immutable inspection review
through [Review-ConfigurationInspection](./scripts/Review-ConfigurationInspection.ts),
[review comparison](./src/configuration-review.ts) and
[eight CQR tests](./tests/configuration-review.test.ts). Approval still binds
the exact scoped revision/base/model/compiler/output/diff/validation tuple;
the optional review additionally binds full canonical provisioned binding,
exact sampled observation digest/time and stable disk/loaded baseline digest.
It is explicit trusted-local attribution, never authenticated runtime authority.
All current reviews carry `queuePolicyStatus:unsupported` and
`runtimeApplyAuthorized:false`. Existing ordinary approvals cannot be upgraded;
new draft/approval is required. No schema migration or existing receipt rewrite.

The real CLI samples outside the SQLite transaction, then atomically persists
the one approval receipt with the review. The read-only `check` samples again
and compares exact binding/stable baseline while retaining both sample hashes.
It rejects changed boot/project/mount/binding, drift, older samples, foreign
scope and absent review; it never refreshes the approved tuple or clears a
claim. It has no expiry or atomic preflight-to-effect fence, and the digest alone
does not store a full historical observation report. Runtime apply remains
absent and must not consume this as a complete authorized apply preflight.

The same increment reproduces CI-01 through CI-10 plus CQ-01 through CQ-04 on
fresh pinned owned PBXs, with runtime help for `queue show`, `QUEUE_VARIABLES`
and `QUEUE_EXISTS`. The inspected help exposes queue summary/metrics/existence,
not timeout/joinempty/leavewhenempty. Published
[QueueParams](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/AMI_Events/QueueParams/)
and [QUEUE_VARIABLES](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/Dialplan_Functions/QUEUE_VARIABLES/)
documentation likewise does not supply those loaded fields. No AMI is enabled,
channel function evaluated, custom runtime module installed or call generated.
This bounds the examined surfaces, not a claim that all possible APIs are
incapable.

The counterexample explicitly cold-boots A with timeout 2->7, joinempty yes->no
and leavewhenempty no->yes, then restores the original disk without reload.
The same exact queue-display digest and matching disk are still observed;
neither establishes the independent loaded values. All inspector reports now
name these three fields as `queuePolicy.status:unsupported`. A successful
empty-baseline observation or reviewed-baseline match does not erase that
limitation. B remains independent. Explicit test restoration is not a proven
configuration recovery procedure.

`run-k6u3PD` / `asterisk-inspection-k6u3pd`: typecheck, **85 focused tests**,
ten CI and four CQ checks pass; reviewed approvals persist for both customers,
read-only current comparisons leave the DB unchanged and restart checks cannot
rewrite approval. Owned Docker resources and generated configuration/credentials
are removed; only bindings, offline review database and result report remain.
No ordinary/shared PBX, permission/dependency, live phone or REFER change.

**The executor is still blocked by the selected exact-verification requirement.**
The next decision must retain that contract and investigate a suitable independent
read-only policy surface, or explicitly narrow supported policy/verification
claims. No implicit fallback to disk hashes, queue summary or one canary.
Only afterward separately authorize executor/reload/canary/recovery work, with
complete revision/binding/current-base fencing and every external-effect boundary.
A green baseline or optional review alone is never apply readiness or authority.

#### Independent loaded-policy surface investigation

The user continued with the recommended **preserve exact verification** choice.
The next bounded research increment inspects public upstream 22.11.0 handlers
and the pinned runtime's registered metadata without enabling any new API or
evaluating channel functions. There is no decision to narrow the contract.

The [fixed proof helper](./tests/configuration-inspection/capabilities.ts) captures
13 help/metadata commands for each of two owned PBXs, bounded at 64 KiB per
command, normalizes terminal formatting, checks expected version/help shapes
and retains output hashes. [QPU-01 through QPU-04](./tests/configuration-capabilities.test.ts)
verify exact command selection, normalization, explicit shape/size/version
failure and outage propagation. Capture records research only, never an
automatic "no API exists" or policy-verification conclusion. Reproduce with
`.\scripts\Test-ConfigurationInspection.ps1 -WithCapabilities`.

Observed pinned metadata: ten queue CLI registrations, eight queue functions,
registered `QueueStatus`, `QueueSummary`, `QueueRule`, `GetConfig`,
`GetConfigJSON` and `Getvar` help; zero `res_ari` modules loaded and HTTP server
disabled. The proof issues no AMI/ARI requests, function reads/writes, module
loads or reloads and creates no channels/calls.

The reviewed upstream tag sources are:

- [app_queue.c, Asterisk 22.11.0](https://github.com/asterisk/asterisk/blob/22.11.0/apps/app_queue.c):
  internal queue fields at lines 2052/2053, default/config assignment and
  empty-option parsing at 3163/3511/3564/3725, function readers/registrations
  beginning 9289/9813, CLI status printing at 10430/10538/10754, AMI rule/summary/
  status handlers at 10770/10806/10888 and command registrations at 12077/12238.
  Local reviewed SHA-256:
  `46057d05da7e078ffb5228a0eca8414c9d3ea05f1eb0a4f1b664e8a4d2f2e9a8`.
- [ARI dynamic configuration schema](https://github.com/asterisk/asterisk/blob/22.11.0/rest-api/api-docs/asterisk.json):
  GET `/asterisk/config/dynamic/{configClass}/{objectType}/{id}` is dynamic
  configuration-object retrieval. Reviewed SHA-256:
  `89b6cef41cb797a343b165e055ff91f1ec1108dbf00a86f47e918b7a624ad534`.
- [ARI implementation](https://github.com/asterisk/asterisk/blob/22.11.0/res/ari/resource_asterisk.c#L89):
  retrieval obtains the registered Sorcery module/type/object; this is not an
  unrestricted app_queue struct reader. Reviewed SHA-256:
  `214e58778181ddb6b393822ad52ef38b215f09b39c520bb93fd3bdbd8a003aa4`.

Original analysis, not copied source:

| Surface | Verified distinction / reason not to use as exact policy evidence |
|---|---|
| Queue CLI | `queue show` prints status/strategy/counters/member/caller information. `queue show rules` concerns penalty rules; the other registered commands mutate members, statistics, priority or reload state. No registered exact timeout/join/leave getter is established. |
| Queue functions | The eight registered functions concern existence, queue metrics and callers/members. `QUEUE_VARIABLES` can assign channel variables and uses a queue lookup capable of realtime loading; treating generic function evaluation as side-effect-free would be unsafe. It still does not expose the required three fields. |
| AMI QueueStatus | Handler emits QueueParams, QueueMember and QueueEntry data, not independent timeout/joinempty/leavewhenempty values. Source and [documented QueueParams](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/AMI_Events/QueueParams/) support this; no live AMI request is made. |
| AMI QueueSummary | Summary counts/times, not configuration policy. Source and [action documentation](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/AMI_Actions/QueueSummary/) do not establish the missing reader. |
| AMI QueueRule | Penalty-rule list/time adjustments, not queue admission/leave masks or member ring timeout. |
| AMI GetConfig / GetConfigJSON | [File/category retrieval](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/AMI_Actions/GetConfig/), not an independent live queue-object view. Enabling access would add authority without closing the gap. |
| AMI Getvar | Generic variable/function execution, not a new policy getter; not evaluated or enabled by this proof. |
| ARI dynamic config | Sorcery registry/object access; upstream app_queue does not establish the required registered Sorcery queue policy object. ARI is not loaded and HTTP is disabled here. No guessed endpoint or module enablement is attempted. |

Important scope qualification: upstream queue lookups/status paths can load
realtime queues when realtime is configured. "Read-only" in this fixture refers
to these fixed static-config proof PBXs, not a blanket side-effect-free claim
for every production Asterisk configuration. This increment's new commands are
help/metadata only. Upstream tag review is not a binary/source reproducible-build
attestation, and documentation plus registered help does not prove the absence
of all possible third-party or future APIs.

Recorded `run-IB8Tum` / `asterisk-inspection-ib8tum`: typecheck, **89 focused
tests**, ten CI and four CQ checks pass, plus **26** fixed capability metadata
reads. The prior loaded-policy counterexample and immutable review checks remain
passing. Owned resources/generated configuration/credentials are removed,
repository baseline unchanged; only synthetic bindings/review SQLite/report
retained. The report distinguishes capture from `exactPolicyReaderEstablished`,
which remains **false**. No application production code, policy truth,
permission, dependency or runtime apply capability is added by this increment.

**Exact-verification stop:** no suitable independent loaded-policy reader was
established on the examined stock surfaces. Do not keep repeating equivalent
summary probes or proceed to executor/canary as a proxy. The exact contract and
all full CP/M1 gates remain unchanged. Preserving it now requires a separately
designed/authorized observability change, potentially a getter implemented
within app_queue using its own object lookup and locks, with bounded DTOs,
no realtime-load/mutation side effects, queue-scope restrictions and pinned
build/source provenance. This is an option to evaluate, not an assertion that
a standalone module can safely access private fields or an authorization to
patch/build/load anything. Debugger attachment, process memory reads and generic
function evaluation remain excluded. Alternatively defer publication while
leaving this contract intact. Only an explicit later decision may narrow it.

#### Selected design: app_queue-owned read-only policy observation

The user selected **`design-queue-observability`** after the stock-surface stop.
This increment is **design/documentation only**. It authorizes no source patch,
download/build of a custom runtime, image replacement, module installation,
runtime command, reload, call, publication or altered acceptance claim. Exact
verification remains the requirement. The following QO checks are planned, not
executed; the existing stock inspector continues to report unsupported policy.

##### Owner, interface and trust boundary

Design a small versioned getter **inside app_queue**, not a separate module
reading its private struct, a memory/debugger attachment, AMI Getvar expression
or file reader. The getter must observe the queue objects already used by Queue(),
under their existing object-lifetime and locking rules. Public source review
establishes candidate fields, not proof that a proposed patch is correct.

Proposed operator-local CLI syntax:

`queue policy snapshot cp-<24-lowercase-hex-digits>`

This is a **new command proposal**, not an existing runnable feature. Exactly
one namespace argument is accepted; no optional filename, arbitrary queue,
expression, command, wildcard, customer label or output-path argument.
No tab completion enumerating other queues. The existing trusted host adapter
must validate the complete owned binding/container/image/start/mount tuple
before issuing this fixed command and verify it again afterward. The namespace
is derived from the bound scope, never accepted from model-supplied command text.
No browser route, new web permission, Docker socket, AMI/ARI endpoint or exposed
port is introduced.

CLI access itself is powerful existing local operator authority, **not customer
authentication**: anyone already able to run arbitrary Asterisk CLI commands
could choose a different namespace. The getter cannot invent a security boundary
from a caller-supplied prefix. Customer isolation in this slice is separate owned
PBXs plus the trusted binding adapter, not a promise of per-tenant authorization
within a shared PBX. A production/shared-PBX service would need a separately
designed authenticated boundary.

The finite requested inventory is: the exact unmanaged `proof-queue`, plus
**all currently loaded names beginning with `<namespace>-`**. Do not just request
the compiler's expected queue, because unexpected extra reserved objects must
be visible. Queue names are accepted for serialization only when they match
`[a-z0-9][a-z0-9_-]{0,95}`; reserved suffixes must also be valid compiler slugs.
An invalid matching name is a blocking error, not skipped. Do not emit foreign
names, member interfaces, caller identifiers, configuration text or credentials.
Account for the pinned queue container's case-insensitive identity: select
case-folded baseline/prefix matches, then reject noncanonical spelling or
case-colliding duplicates rather than hiding them as outside the namespace.
The existing full known queue/dialplan inventory check is still required to
detect unmanaged drift outside this selected namespace.

##### No-load lookup, lifetime and bounded locking

The implementation must use **only the existing in-memory queue container**,
with the matching AO2 lookup/iteration and reference-release conventions.
The pinned source's direct `ao2_t_find` usage is prior art; its
`find_load_queue_rt_friendly` helper is specifically excluded because even a
static-queue path can invoke realtime-member refresh. Also exclude configuration
loads, realtime queue/member queries, device-state refresh, member creation,
normalization by setters, persistent state updates and mutating statistics.

Required algorithm, to be checked against the actual pinned lock graph before
implementation:

1. Validate argument and capability version before touching queue state.
   Initialize a fixed-size local observation buffer; no caller-controlled
   allocation or output while holding application locks.
2. Enumerate the in-memory container with safe references and a **64 total
   loaded-object** traversal ceiling, retaining at most **8 selected objects**
   (including `proof-queue`). Enforce the ceiling without scanning unbounded
   state. Never load an absent queue in order to enumerate or answer.
3. For each selected referenced object, acquire its queue lock using a supported
   nonblocking/strictly bounded mechanism; copy only the fixed fields and
   safe bounded name. Validate `dead` and `realtime` under that lock.
   A retiring/dead object or any selected realtime object produces a blocking
   result. Take the member-container lock only in the existing supported
   queue-to-member order to obtain its count; never lock an individual member
   or inspect external member/device state. Copy `q->count` and whether `q->head`
   is null; inconsistent empty-state facts block.
4. Release each lock and every retained reference on every path. Do not hold
   the global container lock while waiting for a queue lock, doing JSON/CLI I/O,
   traversing member data, or performing Docker/filesystem operations.
   A live reference keeps memory valid; it does not by itself establish that
   the object is still linked/current.
5. Re-enumerate selected **in-memory object identity and membership**, not just
   equal names; replacement/removal/addition observed during the sample is
   `unstable`. Copy/check selected policy facts again using the same bounded
   lock order; observed changes block. Do not spin/retry until something looks
   green. Serialize only a complete successful DTO after all locks are released.

Container traversal/reference acquisition and member-count locking also need
bounded/nonblocking behavior; a timeout in the host alone must not leave a CLI
worker blocked on PBX locks. If the pinned APIs cannot implement this safely,
**stop the patch design and resolve the lock mechanism** rather than assume
that killing the remote CLI client cancels a server-side handler.
Transient allocation/reference/lock activity is permitted; business configuration,
queue state, counters and database contents must not be modified by the getter.

The result is a bounded **per-object locked sample**, not a transaction across
all queues, disk and dialplan. Rechecking does not detect all ABA/transient edits.
No new reload-generation counter is assumed in v1: adding one correctly would
require instrumenting every mutation path and broadening the patch. The initial
future proof remains quiescent, with the same owned fixture/no unmanaged writer
limits; no active-call-safe or concurrent privileged-editor guarantee.

##### Effective-policy DTO and error protocol

Return exactly one newline-terminated UTF-8 JSON document, at most **8 KiB**,
with no terminal colors, banners, log text, partial rows or trailing documents.
Proposed successful schema (field names normative; values described below):

```text
{
  schemaVersion: 1,
  reader: "app-queue-policy-v1",
  maskMapping: "asterisk-22-empty-v1",
  status: "observed",
  namespace: <exact validated argument>,
  consistency: "bounded-per-object-sample",
  objects: [
    {
      name: <safe selected queue name>,
      origin: "static",
      strategy: <canonical known strategy name>,
      memberTimeoutSeconds: <nonnegative integer q->timeout>,
      joinEmptyMask: <effective q->joinempty unsigned integer>,
      leaveWhenEmptyMask: <effective q->leavewhenempty unsigned integer>,
      memberCount: <bounded nonnegative integer>,
      callerCount: <bounded nonnegative integer>,
      callerListEmpty: <boolean>
    }
  ]
}
```

Sort rows by bytewise queue name; reject duplicates and unknown fields/versions.
Counts outside 0..65535, timeout outside 0..86400, strategy outside the pinned
enum mapping, unknown mask bits or unsafe object names produce a blocking error,
not truncated/clamped values. These are observation protocol bounds, not new
permitted model values. Nonzero counts are observed facts; the host rejects
them for this **empty-queue** slice. It does not hide a nonempty queue or list
members/callers to explain it.

Crucial semantics from the reviewed 22.11.0 source:

- `q->timeout` is the **member answer/ring timeout**, not the model's total
  queue-wait bound. The latter stays independently verified in the loaded
  `Queue(...,<waitSeconds>)` dialplan arguments. Never conflate these timers.
- `joinempty` and `leavewhenempty` become **effective condition bitmasks**, not
  retained original yes/no strings. The reviewed mapping is penalty=1, paused=2,
  inuse=4, ringing=8, unavailable=16, invalid=32, unknown=64, wrapup=128.
  Known mask is 255. Aliases/options can map to the same effective mask; the
  getter must not reconstruct or claim the original source spelling.
- For this compiler's fixed `joinempty=yes` / `leavewhenempty=no`, the expected
  masks are **0 / 0**; fixed member timeout is **2**, strategy `ringall`.
  The negative fixture `joinempty=no` / `leavewhenempty=yes` maps to **35 / 35**;
  with member timeout **7**, it must differ despite restored matching disk.
  These are design expectations from source, **not measured getter results**.
  Tests must independently exercise the parser/effective behavior rather than
  merely duplicate the getter's own conversion helper.

`proof-queue` must be present exactly once. A valid empty reserved namespace is
an observed inventory with just that baseline row; absence of an expected
reserved queue at future nonempty revision is a host comparison failure, not
automatic creation. The getter is state observation, not desired-state input:
it cannot label a result "verified", "approved", "ready" or "published".

Errors use the same schema/reader/maskMapping/namespace envelope with `status:"error"` and
one bounded code, **without `objects`**: `invalid-request`, `busy`, `limit`,
`unsupported-state`, `unstable` or `internal`. Invalid syntax has namespace null;
do not echo unvalidated text. No exception trace, queue/member/caller names or
partial successful inventory in error output. A transport/CLI error can exist
without a JSON document and must still fail explicitly.
Asterisk remote CLI process exit status alone is not a success signal:
the adapter requires the exact complete success envelope and expected fields.

##### Host comparison, availability and old-evidence preservation

Add a future inspector capability distinct from the existing stock reader:
`app-queue-policy-v1` with an explicit effective-mask mapping version.
Old reports/receipts keep `unsupported`; no schema rewrite, automatic upgrade,
stock-image fallback or reinterpretation of prior summaries. Missing command,
unknown version/mask/schema, extra stdout, timeout, lock busy, stale build/image/
boot binding or error envelope is unavailable/blocked, never a policy match.

The host must compare the exact selected object inventory, strategy, member
timeout, both masks and empty member/caller facts against the intended baseline
or compiled revision, separately from disk and loaded dialplan. A cold empty
baseline proves reserved object absence, not the policy of an object that does
not exist. Keep unmanaged baseline and other-customer checks. Getter success
does not bypass UUID/marker/route verification, deliberate canary, immutable
bound approval, current verified base, publication fencing or recovery gates.
No executor, verified pointer or new runtime authorization is part of this design.

Each observation must bind the getter protocol, effective-mask mapping, runtime
image/build manifest/module digests and exact existing project/boot scope.
The getter's self-reported reader string identifies a protocol, **not proof
of which binary is loaded**. A module-file hash alone does not establish that
those bytes are loaded. Future proof must use immutable image-owned binaries,
no shadow mounts/replacement, observed cold process start, expected module
inventory and an audited startup path. If that chain cannot be established,
report build/loaded-module provenance unavailable; do not invent attestation.

##### Separate custom-runtime build gate

Implementing this design needs explicit later approval to create a **new proof
image**; the current upstream image and its binding format remain untouched.
Do not drop a newly built `app_queue.so` into the existing image and assume ABI
compatibility. Plan a pinned full Asterisk build/runtime pair with the patch
in the source owner, retaining required existing proof capabilities. Keep the
custom proof image opt-in; no replacement of default Compose/shared PBXs.

Before any build, record exact upstream commit/tag resolution and source/archive
hash, minimal patch bytes/hash, license/notices/source-availability obligations,
compiler/linker/architecture/flags, configure/menuselect inputs, immutable build
and runtime bases, bounded declared dependency versions and build commands.
No `latest`, unrecorded package resolution, copied credentials or arbitrary
download execution. Dependency availability and build-resource cost must be
checked and approved before installation; no dependencies are installed here.

Retain a manifest binding source+patch+toolchain+configuration to full image ID/
digest and installed Asterisk/module hashes, including getter protocol/mapping.
Record test result hashes separately to avoid a circular image/manifest/test
digest. Preserve the prior stock-image evidence. A repeat build should compare
outputs and explain nondeterminism; **recorded provenance is not a reproducible
build claim** until independently measured. No registry push/public distribution
is implied by approval to build a local proof image.

##### Planned QO acceptance and implementation stop

The following is a proposed bounded batch, **all planned/unexecuted**:

| Check | Required measurable result |
|---|---|
| QO-01 | Getter exists only inside the pinned patched app_queue owner; exact CLI argument/protocol bounds reject unsafe/foreign/wildcard/extra inputs with no namespace or private-data disclosure. Trusted adapter scope checks run before any runtime command; CLI authority is not claimed as customer authentication. |
| QO-02 | Source/patch and instrumented tests demonstrate only in-memory lookup; absent/realtime/dead cases never load/refresh queues/members, invoke database/file readers or modify counters/state. Reference cleanup includes every allocation/failure branch. |
| QO-03 | Lock-order review and contention/replacement fault tests establish bounded container/queue/member-count access, no deadlock, no orphaned blocked handler and no I/O/serialization under locks. Busy/retired/replaced/changed samples fail without green partial output. |
| QO-04 | Independent fixtures cover timeout 2/7, masks 0/35, explicit condition lists/aliases/unknown bits and timer distinction. Exact loaded values differ after disk restoration without reload; original config spelling is not inferred. |
| QO-05 | Inventory tests cover empty reserved namespace, expected queue, extra matching queue, missing baseline/target, duplicate/unsafe names, total/selected traversal bounds, nonzero members/callers and count/list inconsistency. No foreign identifiers or credentials in output/error. |
| QO-06 | Host parser enforces 8 KiB single-document shape, known protocol/mapping, complete success/error distinction and exact values. Truncation, unknown masks, malformed fields, extra stdout and successful CLI exit with error/absent JSON never verify. Stock unsupported reports remain unchanged. |
| QO-07 | Separate source/build/image gate produces an auditable pinned manifest, ABI-compatible full runtime and immutable module startup chain. A mismatched build/module/image/start binding fails; no stock binding auto-upgrade, default Compose change or reproducibility claim without evidence. |
| QO-08 | Two uniquely owned custom-image PBXs show selected static baseline/queue facts and other-customer isolation with no reload, call, apply or production/shared runtime access. Disk-only and loaded-only negative fixtures stay distinguishable; metadata/version alone cannot pass policy comparison. |
| QO-09 | Outage, restart, concurrent getter requests, busy locks, observed object changes and receipt/write failures preserve immutable prior evidence and explicit uncertainty. No automatic retry-to-green/rebind/resume. Getter command does not allocate a publication claim or move a verified pointer. |
| QO-10 | Focused stock regressions plus custom-image build/functional/locking/data-exposure checks pass with exact output facts. Owned resources, generated credentials/config and build helpers are cleaned; named source/patch/image/manifests retained intentionally. No excluded endpoint/member/ordinary-route edits, REFER rerun or new web/AMI/ARI authority. |

Documentation-only validation for this increment is consistency/diff hygiene;
no QO runtime or build result is claimed. **M1-09 and all full CP gates remain
open**, as does exact loaded-policy verification. Next requires a separate
implementation/build authorization after lock feasibility, dependency/image
provenance and these acceptance bounds are agreed. If any of those cannot be
met, stop or explicitly revise the design; do not weaken exact verification
implicitly or expand the getter into a general-purpose queue editor.

##### Read-only feasibility review: implementation not cleared

On 2026-10-25 the user selected **`feasibility-only`**: inspect public pinned
source and local host capacity, with no patch, dependency installation, image
build, module command or PBX startup. This review **does not clear QO-03 or
QO-07**. Supported try-lock primitives exist, but the proposed algorithm above
is not yet a demonstrated bounded, nonmutating reader on every exit path.

The public annotated tag `22.11.0` resolves through tag object
`1789a2b8ef9f52478203b6044be3d5492ed98c8f` to commit
`874768141f94bc03865cc746eee1c7669e3c46d5`. Review used raw files at that commit,
not a moving branch. Source base:
[Asterisk pinned tree](https://github.com/asterisk/asterisk/tree/874768141f94bc03865cc746eee1c7669e3c46d5).
The following SHA-256 values identify the reviewed files, not a runtime binary,
complete build-input manifest or reproducibility result:

| Upstream file | Reviewed SHA-256 |
|---|---|
| `apps/app_queue.c` | `46057d05da7e078ffb5228a0eca8414c9d3ea05f1eb0a4f1b664e8a4d2f2e9a8` |
| `include/asterisk/astobj2.h` | `ea8942491b9e1f83f63f16f7557f3be1bb03fd6e93ddf73a24de8d0731202d8c` |
| `main/astobj2.c` | `4d4f255a00c8409c135a9b33e6147540bd0804c4a3463ed7b84d9a3adcdbfd0a` |
| `main/astobj2_container.c` | `ccf2ae264764df1392b8fb3f57abc1eb741cdeb74232f8dc3a03d333351d8a72` |
| `main/astobj2_hash.c` | `1ed7dc11895a244bb62a4759c8197095fc83652bfdeb509e114975efb6fd77f7` |
| `configure.ac` | `55e16603107d42492352b4ec10d4bb4cad5c132850904054e45e350c5349714c` |
| `build_tools/menuselect-deps.in` | `737ef8819bb6c4609c89b95d23cff258954d6528b1f58716ab6dc65703b99acf` |
| `third-party/versions.mak` | `fe916b7e8afca2d0858e98517fbf88dcb103bbe96377fceafa8cf1512c43060f` |

**Lock/lifetime findings (source evidence, not executed contention tests):**

1. **Supported candidate primitives.** `astobj2.h:738` exposes `ao2_trylock`
   and read/write variants; `astobj2.c:342` dispatches to the object's lock
   kind. The queue container is a 53-bucket mutex hash
   (`app_queue.c:1753,12175`); queue allocation uses the default AO2 mutex
   (`app_queue.c:3949`, `astobj2.h:363,407`); member containers use mutex list/
   hash allocation (`app_queue.c:3206`). This supports a candidate immediate
   `busy` path, not a hard real-time latency claim.
2. **Iteration must not silently reacquire blocking locks.**
   `AO2_ITERATOR_DONTLOCK` requires the caller to hold the container lock
   through iterator operations **and destruction** (`astobj2.h:1836`).
   The implementation calls `__adjust_lock` even with that flag
   (`astobj2_container.c:502,556`). It is a no-adjustment path for the pinned
   mutex kind; it must not be generalized to RW containers, whose read-to-write
   promotion can release and block (`astobj2.c:425`). Ordinary iterator calls
   without this flag use blocking locks. Busy handling must cover iterator
   teardown too; killing a remote CLI client is not a solution.
3. **A live-object ceiling is not an internal traversal ceiling.**
   `ao2_container_count` is an atomic element-count read
   (`astobj2_container.c:34`), not a count of physical hash nodes.
   `hash_ao2_iterator_next` skips empty retained nodes internally
   (`astobj2_hash.c:611`). Other iterators can retain unlinked nodes; counting
   64 returned live objects does not bound that hidden work. The fixed bucket
   count alone does not bound retained nodes either. Strict traversal limits
   require an independently established node bound or a separately reviewed
   bounded API/design; no private-container access is authorized.
4. **Reference cleanup can perform forbidden work.** Last-reference release
   synchronously invokes the destructor (`astobj2.c:613`).
   `destroy_queue` calls `free_members` (`app_queue.c:3918,3934`), which uses
   ordinary member iteration/removal. Removal takes locks, updates device state
   and unlinks members (`app_queue.c:3784`). After concurrent queue retirement,
   the getter's retained reference can become the last one. Thus "release every
   reference" is necessary but not sufficient for bounded/no-mutation cleanup,
   including busy/error paths and references to nonselected queues encountered
   during enumeration. Name/identity rechecks do not eliminate this race; neither
   reference leaks nor an unapproved background cleanup worker are acceptable
   workarounds.
5. **The queue lock alone is not a complete field-ownership proof.**
   Reload holds the global queue-container mutex (`app_queue.c:10334`).
   `kill_if_unfound` writes `q->dead` without taking the individual queue lock
   (`app_queue.c:10292`); existing-queue parameter reload separately takes that
   queue lock (`app_queue.c:10159`). Before implementation, produce a
   field-by-field reader/writer lock matrix and lifetime/unlink analysis.
   Merely taking the queue lock and rechecking `dead` cannot be described as
   protecting every concurrent retirement path.
6. **Build settings affect the bounded-path claim.** AO2 reference-debug
   logging can write/flush during reference operations (`astobj2.c:498`).
   Developer/debug integrity checks can traverse containers
   (`astobj2_hash.c:143`). A future exact build/runtime profile must account for
   these paths rather than claiming no I/O/unbounded work solely because the
   proposed handler contains none. This review did not audit every lower-level
   allocator, mutex wrapper, module-unload or logging path.

The design's current split enumeration/reference/recheck algorithm is therefore
**blocked pending design resolution**, not approved for coding as written.
Quiescent fixture assumptions reduce exposure but do not satisfy planned
retirement/replacement/busy tests. Keeping membership stable under a global
lock could change the analysis, but requires a separate bounded critical-section,
lock-order and cleanup design; it is not selected here. Do not introduce a
mutation-generation mechanism, modify AO2 internals or relax QO-03 implicitly.

**Build prerequisites and resource feasibility:**

- A native Windows compiler is not the proposed runtime target. Available
  Docker reports a Linux `x86_64` engine, version `29.6.2`, 16 CPUs and about
  **7.38 GiB** total daemon memory. The host sample showed about **3.88 GiB**
  free physical memory and **672 GiB** free on C:. Host and daemon figures
  overlap; they must not be added or treated as reserved capacity. Docker VM
  filesystem free space, current competing load and build peak usage were
  **not measured**. No container was created or started.
- Source `configure.ac:716-790,2696` requires libedit development support,
  UUID support, Jansson >=2.11 (unless bundled), libxml2 for menuselect and
  SQLite3 for AstDB. GCC-compatible C/C++ tools, make, pkg-config and the source
  generation/menuselect toolchain must also be pinned. These are prerequisite
  categories, **not an approved/exhaustive package lock or install command**.
  Menuselect build/configure files are present in the pinned source tree.
- Current explicit module loading must be preserved, including PJSIP, crypto/
  SRTP, RTP, WAV, codecs, queue, CEL and the proof's UUID function. This requires
  a transitive module/dependency inventory, not just compiling app_queue.
  PJSIP/TLS/SRTP and codec dependencies remain selection/build gates.
  Source `third-party/versions.mak` declares bundled Jansson **2.15.1**,
  PJPROJECT **2.17** and libjwt **1.15.3**; version strings do not pin fetched
  archive bytes. PJPROJECT bundling defaults on in `configure.ac:470`.
  No configure/make/download helper was executed.
- No immutable builder/runtime base, package snapshot/version/hash closure,
  third-party archive hashes, configure/menuselect profile or license manifest
  has yet been selected and checked as a complete set. The stock image digest
  is a prior runtime reference, **not a matching source/toolchain build recipe**.
  Do not run upstream automatic dependency installers or allow build-time
  downloads to resolve these gaps silently.
- A future budget proposal is **one build at a time, at most 2 CPUs, 2 GiB
  build memory, 20 GiB incremental storage and 30 minutes elapsed**, with
  bounded logs and no registry push. These are proposed stop limits, **not
  measured requirements, reserved resources or user approval**. The selected
  builder must enforce them, including storage accounting; if enforcement
  cannot be established, stop before building. Two future owned proof PBXs
  would retain the existing per-PBX 1 CPU/384 MiB/128-PID limits, and need a
  separate capacity/readiness check after the build. Exceeding limits requires
  an explicit decision, not automatic escalation.

**Outcome:** source-level candidate try-lock support is established, but bounded
traversal, safe retirement cleanup, complete lock ownership and pinned build
closure remain unresolved. No build duration/cost, contention behavior, getter
output or runtime provenance was measured. Exact-policy verification, QO,
full CP gates and M1-09 remain open. Next is a separately agreed **design
resolution** for these blockers (or deferral), not patch/build execution.
Named public-source scratch copies are removed after recording these hashes.

##### Design resolution: membership-stable candidate, traversal stop

The user selected **`resolve-design-only`** following feasibility review:
assess stable membership, lifetime and field locks, and stop if bounds cannot
be established. This increment changes documentation only. It does not authorize
an app_queue/AO2 patch, dependency installation, image build, PBX startup or
weaker acceptance. The four re-read owner/AO2 declaration/container/hash files
match the hashes above at the same immutable commit.

**Disposition of the original algorithm:** do not implement its split
enumeration/retained-queue-reference/recheck sequence. A replacement candidate
can avoid that particular final-reference race by keeping container membership
stable, but cannot yet meet the strict traversal contract. The following is
conditional design reasoning, **not an approved runnable algorithm**.

1. Prepare fixed local storage before locking. Try-lock the global `queues`
   mutex exactly once; contention returns `busy`, with no loop/backoff/retry.
   Verify expected container/lifetime assumptions through the future pinned
   implementation; do not dereference private AO2 structures to test them.
2. While that mutex remains held, use borrowed queue pointers only within a
   synchronous callback, with no queue reference retained or released by the
   getter. The candidate public traversal is
   `ao2_callback(queues, OBJ_NOLOCK | OBJ_NODATA | OBJ_MULTIPLE, ...)`.
   Callbacks return zero to continue or `CMP_STOP` to fail early; they never
   return matches for later retrieval and never unlink. The no-data flag
   avoids both returned queue references and the multiple-result container
   allocation (`astobj2_container.c:257,299-398`). AO2 still manipulates
   **internal node references**; "no returned queue references" does not mean
   reference-free execution or automatically bounded/no-I/O traversal.
3. Validate names using bounded reads (reject if no terminator within 97
   bytes), case-folded matching and canonical spelling rules. Count all live
   callbacks, at most 64, and selected rows, at most 8, without exporting
   foreign names. Try-lock only selected queues, then their member containers,
   once each. Never wait for a queue/member lock while holding the global lock.
   On contention or invalid facts, release any acquired member/queue locks,
   stop traversal, finish AO2 traversal cleanup under the global mutex, then
   release that mutex. No leaked pointer, lock, reference or partial success.
4. Read `realtime` first under the queue lock and reject realtime objects
   **before reading `dead` or other policy/state facts**. For selected static
   queues, hold both the global and queue locks while reading retirement/
   policy/caller facts. Take the member-container mutex for its count; do not
   iterate members or acquire individual member/device/channel locks. Release
   member/queue locks before the next selected object.
5. Copy only bounded facts; do not allocate, format JSON, log success, emit CLI
   output, load realtime state or invoke application callbacks under these
   locks. No raw pointer escapes global unlock. Because linked queues retain
   their container-owned reference throughout this candidate sample, it does
   not need the getter's own queue-reference cleanup and cannot become the last
   queue owner merely by finishing that callback. Module/container lifetime
   must still be established separately.
6. Complete traversal and all internal cleanup before global unlock. Serialize
   the copied DTO afterward. Membership would be stable during this interval;
   policy/caller/member facts would still be **per-object samples**, not a
   simultaneous all-queue/disk/dialplan snapshot. No ABA or active-call-safe
   publication claim follows. The candidate avoids the original identity
   re-enumeration race rather than pretending a second scan solves it.

**Source-derived reader/writer matrix for the requested facts:**

| Fact / ownership | Pinned writers and publication paths | Candidate reader discipline / limit |
|---|---|---|
| Container membership and queue lifetime | Static load/reload links and removes under `queues` (`app_queue.c:10159,10275,10334-10355`); realtime link/unlink uses the container too (`3973-4048`); `leave_queue` unlinks at `4656`. | Hold global mutex throughout borrowed-pointer use and traversal cleanup. No object pointer survives unlock. This is not a module-unload lifetime proof. |
| `name` | Assigned by `alloc_queue` before linking (`3949-3958`); reviewed owner source has no later name setter. | Global membership protection supplies lifetime; bounded name read and canonical/case-collision checks still required. |
| `realtime` / DTO `origin` | New realtime objects set it before linking (`4021-4048`); static AO2 allocation initializes it to zero. Reviewed owner has no post-publication assignment. | Read under selected queue lock; reject true before reading realtime retirement fields. This is source-specific, not a universal AO2 invariant. |
| `dead` | Defaults/reset in `init_queue` (`3156`); static retirement writes under global lock in `kill_if_unfound` (`10292`); realtime refresh writes under queue/global ownership (`4012`), but realtime `leave_queue` writes after releasing the queue lock (`4644-4650`). | For **static only**, hold global plus queue mutex. Queue mutex alone was insufficient. Do not claim these locks fix the existing realtime writer; realtime is rejected before this read. |
| `strategy`, `timeout`, `joinempty`, `leavewhenempty` | `init_queue`, `queue_set_param` and mask parser (`3156,3511,3554,3724-3728`); static existing-object reload holds global then queue (`10159-10232`); realtime parameter setup is in `find_queue_by_name_rt` (`3973-4069`). | Copy static loaded fields under global plus queue mutex; new objects initialize before publication. No setter/parser is invoked by the reader. Exact mapping and range checks remain required. |
| `members` pointer and member count | Member container initialized in `init_queue` (`3206-3212`); add/remove helpers lock that container (`3768-3793`); reload replacement/direct link/unlink locks it too (`10105-10115,10241-10270`). | Under queue lock, try-lock the existing member container and call atomic `ao2_container_count`; no member traversal/ref/device lookup. Destructor paths must be excluded by lifetime, not manually run. |
| `count`, `head` / DTO `callerCount`, `callerListEmpty` | `join_queue` inserts/increments under queue lock (`4281-4362`, helper `2291`); `leave_queue` removes/decrements under queue lock (`4594-4630`); priority reordering changes/reinserts head under queue lock (`7938-8006`). | Copy count and head-nullness under queue mutex; do not traverse caller list. Validate zero/nonzero consistency; no caller identity or channel inspection. |
| Reader/mapping/version/namespace and sorted DTO | Protocol constants and trusted adapter request, not queue configuration. | Validate before locking; derive origin from static check; sort/serialize after unlock. These fields cannot attest the loaded binary. |

This matrix covers the selected owner fields and relevant named writer paths,
not a whole-program concurrency proof. Busy unwinding, lower-level lock wrappers,
AO2 reference logging, module-use lifetime and unload ordering still need review/
tests before implementation. `unload_module` unregisters CLI handlers before
`ao2_cleanup(queues)` (`app_queue.c:12116,12150`), but source order alone does not
prove an executing getter pins the module/container. No debug/ref-logging profile
or source patch is selected here.

**Unresolved hard bound and rejected shortcuts:**

- Both iterator and callback hash traversal skip empty retained nodes internally
  (`astobj2_hash.c:436-465,481-593,611`). `CMP_STOP`, a callback visit counter,
  or a clock check in the callback cannot interrupt work **before** the next
  callback. Holding the mutex prevents new concurrent changes during that
  interval, but does not remove or bound empty nodes retained from earlier
  activity. The new global-lock candidate therefore also lacks a proven maximum
  critical-section duration/work budget.
- `ao2_container_stats` is a printing/debug facility
  (`astobj2_container.c:819`): physical-node counts are conditional on
  `AO2_DEBUG`, it calls a formatter and container-specific statistics, and it
  is not a bounded typed preflight API. Enabling debug and parsing its text
  under the lock is not the selected fix. The atomic live-object count alone
  is still inadequate.
- Exact expected-name lookup would hide unexpected reserved queues and can
  traverse collision/empty-node chains. A host timeout cannot cancel those
  server-side steps safely. Cold-boot/no-writer fixture assumptions alone are
  not the required busy/replacement/traversal proof.

**Stop/result:** membership-stable borrowing addresses the identified
getter-owned last-reference race at design level and provides a more accurate
static-field lock discipline. **It does not clear QO-03 or authorize coding.**
Strict traversal needs a separately scoped owner-supported AO2 budgeted
traversal/typed node-bound design (including internal cleanup and contention
semantics), or this getter must be deferred. That would expand the original
small app_queue-only patch boundary; it requires an explicit decision, not
another assumed loop of stock probes or an unapproved internal-structure read.
QO-07 build closure, all QO execution, exact verification, full CP and M1-09
remain open. Only documentation consistency, source-hash checks and diff hygiene
are validation for this increment; no getter or contention result is claimed.

##### Selected AO2 design: budgeted borrowed traversal

The user selected **`design-ao2-bounded-traversal`**, explicitly expanding the
**design only** boundary into AO2 ownership. No source patch, API implementation,
dependency install, image build or PBX execution is authorized. This proposes
a way to close the hidden-traversal gap; it is **not an implemented or measured
closure of QO-03**. Earlier source findings and stock unsupported reports remain
valid. The ordinary iterator/callback fallback is not acceptable.

Review re-read `astobj2.h`, `astobj2.c`, `astobj2_container.c` and
`astobj2_hash.c` at commit `874768141f94bc03865cc746eee1c7669e3c46d5`;
their hashes match the feasibility table. Additional reviewed owner source:
`main/astobj2_container_private.h`, SHA-256
`8575504472f8058c6ca7de662206d0a978efec80303d2efbdf605087dc485dc0`.
This header defines container/node ownership and the private methods table.
`astobj2_hash.c:35-76` owns physical bucket/node links;
`1002-1089` owns hash type identification and allocation. An AO2 list shares
that hash implementation with one bucket; it is not a separate runtime type.
These are source facts, not build provenance.

**Proposed narrow owner API (names provisional):**

`ao2_container_visit_bounded_v1(container, limits, visitor, context, result)`

- Declaration/types belong in the public AO2 header; the implementation belongs
  inside the hash owner. Identify its own methods table before interpreting
  hash storage. No new generic vtable slot, AO2/node layout change or copied
  private struct in app_queue is needed by this design. Existing API behavior
  remains unchanged. No hash/sort/compare hook, existing traversal method,
  iterator, stats formatter or integrity traversal is called by the new walk.
- Accept only the pinned hash-family container with a **direct mutex**:
  reject RW, no-lock, delegated-lock and other container implementations.
  Check the complete lock-kind mask (`astobj2.h:363-378`), not whether an
  options word is nonzero; the mutex kind's value is zero and other option
  bits can coexist. `ao2_options_get` is the existing owner API.
  A one-bucket list may be supported as the same family, but app_queue's global
  queue container is specifically the known 53-bucket hash.
- The API owns one `ao2_trylock` and matching unlock, with **no retry, blocking
  lock, promotion, recursive traversal or caller-lock flag**. Its precondition
  is that the calling thread does not already hold this container mutex;
  Asterisk mutexes are recursive, so try-lock alone cannot detect violation.
  Only the reviewed top-level getter call site may use this path initially.
  The caller must already guarantee container and containing-module lifetime
  for the entire call. The API does not acquire/release a container reference
  to manufacture that guarantee.
- `limits` is a fixed typed set of three positive integer budgets:
  `maxBuckets`, `maxPhysicalNodes`, `maxObjects`. Proposed v1 hard ceilings are
  **64 / 128 / 64**, respectively, with caller values no greater than those
  ceilings. Zero, overflow/out-of-range values, null required arguments or
  unknown API versions are `invalid` before lock acquisition. No flags,
  predicate, arbitrary search key, resume cursor or output allocation.
  This small fixed ceiling is intentional for the owned proof, not a new
  general-purpose production inventory API.
- `result` is caller-owned fixed storage, initialized before any attempt:
  API version, terminal status, and unsigned counters `bucketsVisited`,
  `physicalNodesVisited`, `objectsVisited`. No pointer, name, object data,
  destructor token or resumable state is returned. Counts are internal test/
  diagnostic facts, not extra fields in the queue CLI protocol.

**Budget charging and completion (normative proposal):**

1. Validate well-formed typed arguments and supported immutable container kind.
   A live AO2 container is a caller precondition, not an arbitrary-pointer
   validator. A well-formed but unsupported kind returns `unsupported`.
   A contended try-lock returns `busy` with zero counters; a non-contention
   lock failure is `internal`, not disguised as busy or empty inventory.
2. Under the mutex, reject destruction/inconsistent owner state, including a
   nonpositive bucket count or negative live count. If declared
   bucket count exceeds `maxBuckets` or atomic live count exceeds `maxObjects`,
   return `limit` without walking. An empty live count **does not permit an
   early complete result**: physical retained nodes still need bounded traversal.
3. Walk buckets forward by index. Charge one bucket **before** reading that
   bucket's head, including an empty bucket. Before dereferencing any non-null
   node cursor, check the remaining physical-node budget, then charge one node.
   Empty retained nodes consume the same unit as live ones. A node unit covers
   a fixed number of owner-field reads, including its next link; no internal
   "skip empty nodes" loop is outside the budget.
4. For a non-null stored object, check/charge `maxObjects` before invoking the
   visitor. For this stable walk the final live-visit count must equal the
   initial live count, or return `internal`; the equality check is not a
   substitute for visiting every physical node. All arithmetic is checked or
   proven below the small fixed ceilings; no counter wraps or clamping.
5. Each visitor returns only `continue` or `abort`. An invalid callback return
   is `internal`. `abort` is always **incomplete**, never successful early
   termination. No `CMP_MATCH`, object return, ownership transfer or unlink.
   On abort stop immediately; do not read the next node to tidy up a cursor.
   The visitor's bounded context can retain a queue-specific failure code,
   but no borrowed object pointer.
6. The raw node cursor remains valid because the mutex is held and the visitor
   is forbidden to mutate container membership or node ownership. The API
   takes **no node/object/container references**, creates no iterator/result
   container and performs no node cleanup, allocation, free or destructor call.
   Pending external iterator cleanup cannot change links until this mutex is
   released. No physical-node count preflight or AO2_DEBUG statistic is needed.
7. Only reaching the actual end of **all** declared buckets, with consistent
   live counts and every visitor continuing, yields `complete`. Budget equality
   alone is not an error: exactly 128 nodes is complete if traversal really ends
   there; a non-null next cursor requires `limit` **before** examining node 129.
   Exactly 64 objects may likewise complete, while any attempted object 65 is
   denied before its visitor. Empty remaining buckets still consume bucket
   budget. No post-limit drain, second pass, resume or retry-to-green.
8. On every acquired-lock path, perform one matching unlock; on busy/invalid/
   unsupported pre-lock paths, none. No deferred cursor/ref cleanup survives
   the return. Unlock failure is `internal` and cannot publish observed output;
   normal argument/contention/limit errors do not require logging under the
   mutex. Repository-standard diagnostics/output belong after normal unlock.
   Catastrophic invalid pointers or broken mutexes are not recoverable safety
   guarantees of this API.

This bounds **AO2 walk work**, not arbitrary callback execution, scheduler
latency, page faults or wall-clock real-time behavior. Even corrupt cyclic links
cannot cause an unbounded loop if every node iteration is charged, but this is
not memory-corruption hardening or permission to dereference invalid storage.
Only valid owner-managed containers and a reviewed conforming visitor are in
scope. Try-lock/unlock wrapper instrumentation remains part of the build review.

**Visitor and queue integration contract:**

The visitor is trusted C code, not a plugin/user callback. AO2 cannot enforce
its behavioral contract from a function pointer. It must not mutate/unlink/
relink the visited container, reenter its APIs, release ownership, retain raw
pointers, block, allocate/free, log, serialize, access files/DB/devices/channels,
or invoke other application operations. The single permitted application
callback is this bounded fact-copy visitor itself; earlier prohibitions on
application callbacks mean **no further application callback invocation**.
It may perform explicitly reviewed try-lock-only access to subordinate objects.
No generic API claim that arbitrary visitors are safe is made.

For app_queue, the candidate passes exactly 64/128/64 budgets and uses the
static-field matrix above. It prepares eight fixed rows, validates at most 97
name bytes per visited queue (at most **6,208** bytes across 64 visitors), selects
case-folded baseline/reserved matches and rejects unsafe/colliding names.
Selected-object overflow aborts before attempting locks for a ninth row.
For at most eight selected queues it checks direct mutex kinds, tries queue
then member-container locks once, rejects realtime before reading retirement
facts, copies the bounded fields and unwinds these locks before returning.
At most **17 acquisition attempts** occur: one global plus two per selected
queue. No member/caller traversal, individual member locks or queue ref changes.
Name comparisons, policy mapping and duplicate checks also need explicit fixed
loop bounds; byte-length limits do not license unbounded library string calls.

Only `complete` plus no queue-specific error permits the existing sorted 8 KiB
DTO after global unlock. AO2 `busy` maps to queue `busy`, budget exhaustion to
`limit`, unsupported container kind to `unsupported-state`, malformed invocation
to `invalid-request`, and consistency/lock/visitor-contract faults to `internal`.
Visitor abort uses its explicit validated queue error; a missing/unknown error
is `internal`. Any partial row buffer is discarded, never serialized as observed.
No extra global inventory counters, foreign names or internal pointers enter
the CLI response. Existing getter schema/mask mapping can remain the proposal;
the build manifest must additionally pin the AO2 API/budget profile. No old
report/binding is upgraded, and no fallback to ordinary AO2 traversal exists.

**Planned AO2 acceptance (all unexecuted, prerequisite to QO-03):**

| Check | Required measurable result |
|---|---|
| AT-01 | Invalid/zero/overflow/over-ceiling limits and null arguments reject before locks; hash/list family and direct-mutex checks reject unsupported kinds without private caller casts or fallback. |
| AT-02 | Cross-thread held container returns busy with zero visits; each acquired path unlocks once, no recursive call-site use or spin. Lock/unlock internal errors never verify. |
| AT-03 | Zero buckets reject as inconsistent; 1/53/64 buckets and empty bucket chains charge exact steps; over-budget bucket count rejects before scanning. Empty live count does not hide retained nodes. |
| AT-04 | Retained-empty-node fixtures at 127/128/129 prove all physical work is counted, exact-boundary completion and refusal before examining node 129; no cleanup scan after limit. |
| AT-05 | Live counts at 63/64/65 and mixed empty/live/collision nodes prove callback ceilings, consistency checks and no implicit comparator/hash callback or unbudgeted skip loop. |
| AT-06 | Visitor abort at first/middle/final object and invalid returns produce incomplete/internal status, discard partial rows and leave no cursor, ref, lock or allocation to clean later. |
| AT-07 | Instrumented node/object/container ref, allocation/free/destructor and mutation counters remain unchanged by traversal; retirement/unlink waits for the bounded-work locked sample and cannot transfer final queue cleanup to the reader. |
| AT-08 | Queue/member contention, eight/nine selected rows, 96/97-byte names, case collisions, realtime/dead and protocol errors enforce exact callback work/lock bounds and no private output. |
| AT-09 | Source/profile plus instrumented tests cover lock wrappers, no debug/reference-log traversal side effects, and module/container use lifetime including handler shutdown; no unproven runtime latency claim. |
| AT-10 | Existing AO2 iterator/callback/list/hash regressions and planned QO tests pass in the separately approved full custom build; ABI/source/image/profile provenance and owned cleanup are verified. |

**Outcome and remaining gates:** a physical-node/bucket charged raw walk inside
the AO2 hash owner offers a concrete design route past the hidden traversal
problem **without weakening its bound**. It changes the proposed source surface
from app_queue-only to AO2 public API plus hash owner plus app_queue; it remains
unimplemented and not accepted upstream. Caller/module lifetime, the restricted
visitor, lower-level instrumentation, the exact source patch and all AT/QO
tests still need implementation review and proof. The candidate supersedes
ordinary `ao2_callback` as the proposed queue integration, not as existing code.
QO-03 is not passed, QO-07 build closure is unresolved, and no full CP/M1-09
gate is closed. Next requires explicit implementation scope and separate pinned
dependency/resource/build approval; this design alone grants none of them.

##### CLI lifetime review: module references are not an unload barrier

After the next scope form was accepted without values, work followed its
recommended **`review-lifetime-only`** default: pinned-source tracing and
documentation, with no patch/install/build/PBX execution. The reviewed commit
remains `874768141f94bc03865cc746eee1c7669e3c46d5`.

| Upstream file | Reviewed SHA-256 |
|---|---|
| `main/cli.c` | `d4f119061d6417770c3f60f3dfe3f29883889f610ac16e9ef00abf77a0193c26` |
| `include/asterisk/cli.h` | `16b5df1e02a86d55d61c9760a6b9aa2a3393c975e4968a0502bf08b9061435f2` |
| `main/loader.c` | `1d0f2e95a961b99a2b51f4cd262f197e0ff19dedb4438e14326e607516c53397` |
| `include/asterisk/module.h` | `3111f521cc5a22ff8f041554f2cfb3d707fb82507d0ba97597d8337812d600e4` |

`apps/app_queue.c` was re-read and matches the earlier recorded hash. Source
analysis identifies existing lifetime mechanisms and their limits; it is not
an executed unload race, a stock-runtime finding of exploitability, or a claim
that the proposed getter already exists.

**Observed source trace:**

| Phase | Pinned behavior | Implication for the proposed getter |
|---|---|---|
| Registration | `ast_cli_register_multiple` passes `AST_MODULE_SELF` (`cli.h:265`); `__ast_cli_register` stores it in `e->module` and calls `CLI_INIT` (`cli.c:2570-2592`). app_queue registers its array at `app_queue.c:12230`. | Keep the getter in the normal module-owned array. Do not bypass registration with a null module pointer or fabricate a second registry. `CLI_INIT` must set constant command/help metadata only, with no queue access. |
| Lookup | `ast_cli_command_full` finds the entry and increments `e->inuse` under the helpers read lock, then releases that lock (`cli.c:3106-3110`). | `inuse` is entry bookkeeping, not a queue/container reference or an exclusive lifetime token held by app_queue. |
| Execution | After shutdown/permission checks, dispatch calls `ast_module_running_ref(e->module)`, executes `CLI_HANDLER` only if allowed, then unrefs (`cli.c:3117-3137`). | Normal handler execution has a module use-count reference. It covers the synchronous visitor, response formatting and output until handler return; the getter should not add a redundant module ref and mistake it for stronger synchronization. |
| Completion | `CLI_GENERATE` also uses a running-module reference (`cli.c:3051-3054`), and generation occurs during helpers traversal. | Return no namespace/queue completions and touch no queue state in this phase. Do not turn completion into another observation path. |
| Reference implementation | `__ast_module_running_ref` tests `flags.running`, then `__ast_module_ref` increments `usecount` (`loader.c:2877-2900`). The viewed running-ref path does not acquire the loader's module-list lock around both operations. | Do not describe this as a demonstrated atomic acquire-versus-unload handshake. A second running check, extra reference, or module metadata read does not by itself close that proof gap. |
| Soft unload | `auto_unload_resource` holds the module-list lock, checks usecount and normally refuses nonzero usecount before calling the module's unload callback (`loader.c:1294,1366-1381`). | A reference already visible at that check supplies the normal refusal mechanism. This source trace does not prove all dispatch/unload interleavings are serialized. |
| Forced unload | Firm/hard modes can proceed despite usecount; hard mode can ignore unload failure (`loader.c:1366-1388`, `module.h:61-65,168-175`). | Existing privileged force-unload authority is outside the safe proof boundary. No getter lock or host timeout is claimed to make it safe. |
| Unregistration | `ast_cli_unregister` checks `inuse`; if nonzero it warns and leaves the entry registered, but still returns zero. Otherwise it removes/frees entry metadata (`cli.c:2547-2568`). | Success-shaped return is **not a drain acknowledgement**. Do not poll it, assume it waited, or free getter state on that basis. This design does not change stock unregistration semantics. |
| Queue teardown | app_queue's unload callback starts unsubscribing/cleaning message types before CLI unregistration, then later cleans `queues` and sets it null (`app_queue.c:12092-12153`). Failed load paths can call that same cleanup (`12271-12319`). | A global queue mutex protects membership, not its own enclosing container destruction or module text. A non-null `queues` check is not a lifetime pin. No getter invocation is valid before successful module startup or during teardown. |
| Shutdown | `modules_shutdown` skips modules with nonzero usecount and may release shutdown-held references later (`loader.c:1181-1229`); dispatch rejects most new commands once shutdown is visible (`cli.c:3117`). | Shutdown gating and ordinary use counts are existing defenses, not proof of all shutdown races or cancellation of a handler already running. Do not register the getter as shutdown-allowed. |

**Refined lifetime contract and explicit stop:**

- The proposed AO2 API remains synchronous and assumes a valid live container
  for the entire call. It cannot safely try-lock freed storage. It must not
  promise to establish lifetime by reading container fields, grabbing a new
  AO2 reference after teardown begins, or retaining borrowed pointers.
- Initial future proof is still an owned, quiescent, cold-start fixture with
  **no module load/unload/refresh, shutdown/restart, registration changes or
  competing privileged lifecycle writer during observation**. No such runtime
  operation is performed in this increment. Before/after image/boot/module
  checks remain necessary evidence binding; they cannot prevent an in-process
  lifecycle race or substitute for synchronization.
- Ordinary runtime outage/restart tests may validate host-side rejection of
  incomplete evidence, but must not be reported as a memory-lifetime test.
  Forced unload is excluded, not silently exercised to "see what happens."
  Source/startup failure and controlled concurrency tests require separately
  approved instrumentation/build scope; no active reader is assumed cancellable
  when the CLI client disconnects.
- AT-09/QO-03 must retain an unresolved **dispatch-versus-teardown lifetime
  proof obligation**, including lookup-to-ref, handler-to-output-return,
  registration failure and unregistration paths. The current trace does not
  establish an atomic normal-unload boundary; it is insufficient to clear
  concurrent module unload/shutdown acceptance.
- A stronger guarantee could require core CLI/loader synchronization or a
  separately designed registration/lifecycle gate. Such a change would expand
  beyond the selected AO2/hash/app_queue design and may introduce lock-order/
  waiting concerns. It is **not selected or authorized here**. Neither adding
  a blocking loader lock to the bounded queue critical section nor polling
  `inuse` is an approved fix. The alternatives are an explicitly agreed proof
  boundary that preserves the required safety contract, separately scoped
  lifecycle design, or deferral; do not silently weaken AT/QO acceptance.

**CLI response detail carried into the proposed protocol:**

The dispatcher appends text for `CLI_SHOWUSAGE` and `CLI_FAILURE`
(`cli.c:3140-3144`). Therefore a handled getter request that successfully emits
its one complete **error JSON envelope** must use transport-level `CLI_SUCCESS`,
just as a complete observed envelope does; logical success is determined solely
by the strict JSON status and facts. This is not an error-to-success fallback:
queue `status:"error"` remains blocking, and the host never verifies from the
CLI exit code. Do not append usage/failure text to a valid envelope.

Pre-handler denial/no-command/shutdown paths may emit ordinary CLI text rather
than JSON; the host must treat that as unavailable/error, never empty inventory.
Actual output/transport failure or truncation cannot promise an intact envelope;
it remains unavailable regardless of exit status. No broad catch, fabricated
empty objects, partial observed output or successful verification fallback is
allowed. CLI parsing/output itself is outside the bounded queue-lock work
contract, but remains under finite host capture limits and the existing 8 KiB
getter response cap.

**Outcome:** normal registration supplies module association and dispatch-time
use-count references; unregistration does not establish a drain barrier and
forced unload bypasses those references. Module/container lifetime is therefore
documented accurately but **not proven for concurrent teardown**. No new API,
getter, runtime test or AT/QO pass exists. QO-03, QO-07, exact loaded-policy
verification, full CP and M1-09 remain open. Next is an explicit lifecycle/
implementation scope decision, not automatic patch/build execution.

##### Consolidated proposal: protected getter implementation and build gates

The user selected **`consolidated-implementation-proposal`**. This is the
single proposed delivery sequence for the getter, replacing further automatic
source-review increments. It **authorizes preparation only**, not implementation,
dependency installation, image build, PBX execution or changed acceptance.
It uses the pinned-source findings above; no new source/runtime evidence was
collected for this proposal.

**Recommended lifecycle mechanism to design and implement first:** an opt-in
**protected CLI execution lease**, owned by the core loader/CLI rather than by
app_queue. This deliberately expands the proposed patch surface. It must be
approved as a behavioral change, not hidden inside the queue handler.

- Associate the new entry with its real module through normal registration,
  plus explicit protected-entry metadata. Do not replace all ordinary running
  references or change unrelated CLI commands by default.
- Under the helpers read lock, locate the entry and obtain a protected module
  lease **before releasing entry protection**. Admission uses one nonblocking
  attempt on the loader's module-list/lifecycle mutex: check module running/
  ready and admission-open state, then increment the protected-reader count
  as one serialized operation against unload. Contention or closing state
  denies dispatch explicitly. No loader callback, allocation, use-count
  notification or queue access occurs while these admission locks are held.
- This helpers-to-loader acquisition is try-only because unload can hold the
  loader lock before acquiring helpers. Never wait in that reverse order.
  Release admission locks before handler execution; the lease, not a held
  loader lock, protects the code/container through the handler and subsequent
  entry metadata/output handling.
- Every teardown path must close admission and check protected readers under
  that same loader synchronization **before any unload callback, subscription
  cleanup, queue-container release or dlclose**. Active protected readers
  cause unload refusal, not waiting/polling or reader cancellation.
  The protected-reader check must also cover shutdown, refresh, recursive
  unload and failed-start cleanup, not merely the public soft-unload command.
- **Intentional opt-in behavior change requiring approval:** firm/hard unload
  must not bypass active protected readers. Existing force semantics remain
  for modules without protected readers. If retaining a hard-unload override
  is required, this safety guarantee cannot be offered; stop and revise scope.
  Later production/runtime proofs still do not authorize force-unload commands.
- CLI dispatch must release the lease only **after its last access** to entry
  metadata, usage text and `inuse`, including permission/shutdown/error exits.
  Completion requires the same lifetime rule even though its getter branch
  returns no suggestions. Release must be nonallocating and nonblocking, with
  an atomic decrement paired with serialized admission/unload checks; no access
  to module/entry state after the final release. Use-count notifications and
  diagnostics must not create a new post-release lifetime dependency.
- Protected unregistration checks/removes under the helpers write lock and
  returns an explicit busy/error outcome, never stock's success-shaped skip.
  No drain loop is introduced. Registration/startup failure cannot admit a
  protected handler; readiness becomes visible only after successful startup.
  Any unload failure must preserve a truthful admission/state invariant; do
  not reopen admission automatically after partial cleanup.

These are **required invariants for the first implementation stage**, not
proven pseudocode. Exact lease types, metadata storage, atomic memory ordering,
all loader exit paths and shutdown integration must be resolved in the patch
review. Do not expose a public bypass, rely on `queues != NULL`, add a permanent
module reference, or place a blocking loader lock in the queue critical section.
If this cannot be implemented without broader lifecycle changes, stop before
AO2/getter work and report the narrower blocker.

**Concrete proposed source and repository boundary:**

| Layer | Proposed files/surface | Required exit before proceeding |
|---|---|---|
| Core lifetime | Upstream `include/asterisk/cli.h`, `include/asterisk/module.h`, `main/cli.c`, `main/loader.c`; opt-in lease metadata/admission/release/unload denial and protected unregister. | Deterministic entry/lease/teardown tests establish the invariants above; ordinary CLI/module behavior remains unchanged except the approved protected-reader force veto. |
| Bounded AO2 walk | Upstream `include/asterisk/astobj2.h`, `main/astobj2_hash.c`; direct-mutex hash-owner API. Private owner header only if a reviewed implementation actually needs it, not as caller struct access. | AT-01 through AT-07 and applicable AT-09 establish 64/128/64 bucket/physical-node/object ceilings, no references/allocation/destructor/cleanup scan and correct incomplete outcomes. |
| Queue owner | Upstream `apps/app_queue.c`; one protected registered command and restricted fact-copy visitor. | AT-08 plus QO policy/name/inventory/error cases establish eight rows, at most 17 global/queue/member acquisition attempts, exact masks/timers, no realtime load and no partial observed output. |
| Source delivery/tests | One repository-owned minimal patch series against commit `874768141f94bc03865cc746eee1c7669e3c46d5`, manifest and native test additions in the matching upstream test framework. Exact repository paths to be agreed at implementation approval; no vendored source tree or temporary downloads committed. | Patch applies to exact recorded bytes; changed surfaces and license/source obligations are explicit. No claim that a mocked loop proves the patched AO2/CLI implementation. |
| Optional custom proof image | Separate opt-in builder/runtime recipe and test-only Compose override, leaving default stock image and old bindings untouched. | Complete dependency/base/archive closure, approved enforced resource budget, full ABI-compatible runtime, module-startup provenance and native tests pass before owned PBXs start. |
| Host observation | Existing `src/configuration-inspector.ts`, related binding/review parsing and `tests/configuration-inspection/` only where required; new custom capability/binding version rather than reinterpretation of old stock evidence. | Strict 8 KiB JSON parser, explicit error/unavailable handling, exact image/start/build/API/mask/budget binding, malformed/partial/error-exit negatives and stock regressions. No executor, approval authority or verified pointer added. |

**Execution order and approvals (all pending):**

1. **Approval A: implementation scope**, explicitly including the four core
   lifecycle files, opt-in force-unload veto, AO2/hash and app_queue changes,
   patch packaging and native tests. Implement lifecycle first; review source
   and lock/state invariants before adding the AO2/getter layers. Source-only
   work is not a tested deliverable. If tests cannot run without a custom
   build, retain that pending status; do not simulate a pass.
2. **Approval B: dependencies and build resources**, after a concrete immutable
   builder/runtime pair, package snapshot with exact versions/hashes, third-party
   archive hashes, configure/menuselect/module closure, license manifest and
   commands are presented. Existing 2 CPU/2 GiB/20 GiB/30-minute figures are
   proposed stop limits, not approval or measured sufficiency. Establish how
   every cap, including storage, is enforced before building; inability means
   stop. No automatic package installer, unrecorded network fetch, registry
   push or escalation.
3. **Native validation**, inside that separately approved build environment:
   run focused actual patched tests, then affected upstream regressions and
   full runtime/module build. Retain command/result hashes and distinguish
   test-hook instrumentation from release binary provenance.
4. **Approval C: owned runtime proof**, after A/B exits: one unique opt-in
   two-customer project with approved image/bindings, no published ports,
   no reload/apply/call/ordinary-route/phone/REFER changes. Run QO-01 through
   QO-10 and host regressions; adversarial lifecycle schedules belong in
   instrumented native tests, not unapproved force operations on running PBXs.
   Verify cleanup and preserve exact evidence before any acceptance update.

**Required deterministic lifecycle tests (part of AT-09/QO-03, unexecuted):**
pause execution at lookup-before-admission, admitted-before-handler,
handler-before-output, output-before-entry-release and final lease decrement;
attempt normal/firm/hard teardown in instrumented test fixtures and prove no
cleanup/dlclose while leased. Reverse the order and prove closed admission never
calls the handler. Include helpers/loader lock contention, permission/shutdown
denial, completion, registration failure, protected unregister busy, refresh/
recursive unload, startup cleanup, unload failure and all lease-release branches.
Use barriers and exact counters, not timing sleeps or crash-free anecdotes.
Slow/disconnected output must not free code/container early; it may keep the
lease active and cause unload refusal. That is explicit behavior, not a promise
that the host timeout cancels a server handler.

**Decision-ready outcome:** the next useful action is approval or rejection of
**A**, not another automatic research/design batch. B and C stay separately
gated even if A is accepted. Declining the core behavioral expansion defers
the exact-policy getter; it does not justify a stock-summary/disk/canary
substitute. No stage is approved or executed by this proposal. All AT/QO
checks, QO-03/QO-07, exact verification, full CP and M1-09 remain open.

##### Gate A source candidate: implemented, not natively verified

The user explicitly selected **`approve-gate-a`**, including the opt-in
protected-reader firm/hard-unload veto. **A is authorized for source work;
B/C remain unapproved.** This increment delivers a source candidate rather
than another design-only step. It performs no package installation, compiler/
configure/make invocation, image build, module load or PBX execution.

Repository delivery:

- [Pinned patch](./local/asterisk-patches/queue-policy-v1.patch), targeting
  upstream commit `874768141f94bc03865cc746eee1c7669e3c46d5`, changes exactly
  seven existing upstream files and adds one native test module.
- [Source manifest](./local/asterisk-patches/queue-policy-v1.json) records the
  patch checksum and exact before/after file hashes, source stage and explicit
  false compilation/test/runtime-authorization flags. This is a **source
  package manifest**, not the still-missing toolchain/dependency/image manifest.
- [Read-only package validator](./scripts/Test-AsteriskQueuePolicyPatch.mjs)
  verifies patch bytes/scope/approval flags. Its optional `--source` verifies
  all seven pristine preimages, absence of the new test path and a `git apply
  --check` dry run. It neither downloads nor applies/builds/runs the patch.
  Exact source bytes are required; use `core.autocrlf=false` for upstream
  checkout/application. Hashes detect drift, not authenticated authorship.
- Six [package tests](./tests/asterisk-queue-policy-package.test.mjs) cover
  honest unverified output and denial of altered bytes, authority flags,
  paths, arguments and missing source. These do **not** execute C or prove
  any AT/QO property. Patch LF attributes preserve its recorded checksum;
  blank/indented context-line markers are excluded from repository whitespace
  checks, while native patch application checks source whitespace strictly.

**Implemented candidate source:**

| Surface | Candidate behavior |
|---|---|
| CLI/module headers and core dispatch | Opt-in `protected_execution` entry field, loader lease acquisition under the registry read lock before entry use, try-only loader admission, completion protection and release after handler/output/usage/`inuse` access. Denied admission never retains an entry pointer after registry unlock. Null-module protected registration fails. Ordinary entries retain their existing dispatch behavior. |
| Loader teardown/start | Dedicated atomic reader count; normal/firm/hard unload refuses active readers before cleanup, including recursive/refresh routes through that function. Shutdown skips active protected readers. Teardown closes admission before cleanup; failed unload does not reopen it. Startup opens it only on successful running transition under loader synchronization. Final release does not notify/call back or touch module state afterward. |
| Protected unregister | Checks/removes under registry write lock, explicitly returns busy for active execution rather than stock's successful skip. Existing nonprotected unregister behavior is unchanged. |
| AO2 hash owner | New typed direct-mutex API charges every bucket and physical node, including empty retained nodes, with 64/128/64 ceilings. No existing iterator/callback/hash/compare traversal, node/object/container refs, allocation, destructor or cursor cleanup. Complete, aborted, busy, unsupported, limit, invalid and internal results remain distinct. |
| app_queue | Protected `queue policy snapshot <namespace>`, no completions, one borrowed fact-copy visitor, static-only fields, bounded/canonical names, eight rows, immediate queue/member try-locks, exact masks/timeouts/counts, sorted 8 KiB JSON and no partial observed output. Handled error envelopes use CLI transport success; actual write failures return failure and remain unavailable to strict readers. |

**Native test source, not results:** the added
`tests/test_bounded_queue_policy.c` defines `bounded_walk`, `retained_nodes`,
`protected_lease` and `protected_dispatch`. These cover basic argument/object/
abort limits, real retained iterator nodes at 128/129, all unload-mode refusal
while explicitly leased, and a barrier-controlled actual CLI handler with busy
unregister/unload refusal. app_queue adds `policy_snapshot_copy`, using an
unlinked private queue fixture for 2/0/0 versus 7/35/35 and realtime/dead denial;
it does not initialize normal queue/device state or read configuration.

The unload-mode tests contain **actual native test calls** to unload their
own leased test module. They are not invoked here and must not be run on a
shared/production PBX. Future native-test approval must explicitly include this
disposable test process and externally enforced timeout; do not mistake them
for permission to issue runtime proof force-unload commands. Their source alone
does not establish all deterministic schedules in the consolidated proposal.

**Validation boundary and remaining work:**

- Checked patch integrity and exact source paths; dry-run application to a
  second clean pinned-source subset and actual source-only application there
  produce all eight exact postimage hashes. A Windows automatic-CRLF conversion
  initially broke postimage byte equality; repeating with explicit LF policy
  produced exact equality. Neither step compiled or executed native code.
- Source review traced lifetime admission/close/release, bounded traversal
  branches and queue output paths. **Compilation, type/ABI correctness,
  concurrency safety and regression preservation are not established.**
  No full clean Asterisk tree/toolchain/dependency closure was prepared.
- Native coverage is **initial, incomplete and unexecuted**: complete
  lookup-before-admission/last-output/shutdown/startup/unload-failure schedules,
  cross-thread lock contention, all malformed/boundary/profile cases and
  affected upstream regression suites remain required before AT/QO acceptance.
  No five-test-source count is substituted for AT-01 through AT-10.
- Existing stock inspector, bindings/reviews, default image/Compose and
  runtime publication authority are unchanged. Host custom-build capability/
  binding/parser wiring is still pending a verified custom build; the source
  manifest cannot authorize it or upgrade old unsupported evidence.

**Status:** Gate A has a persisted implementation candidate, **not a completed
verified exit**. Gates B/C, all AT/QO results, QO-03/QO-07, exact policy
verification, full CP and M1-09 remain open. Next can complete remaining native
test-source coverage within A, or prepare concrete B inputs for explicit
approval; no automatic build/install/PBX action follows.

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
