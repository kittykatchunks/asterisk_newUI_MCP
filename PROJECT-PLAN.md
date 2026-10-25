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

##### Gate A coverage increment: eight native definitions, still unexecuted

Continuing within the existing A approval, the pinned patch now defines
**eight** native tests (the prior five plus three AO2 tests). Only the added
native test module changes in the upstream patch; all seven production-source
postimage hashes remain identical to the prior candidate.

| Native source addition | Assertions to execute later, not results |
|---|---|
| `bounded_matrix` | Null arguments, unknown versions, zero/over-ceiling/`UINT_MAX` budgets reset counters and reject; empty 1/53/64 bucket hashes complete with exact bucket counts, 65 buckets deny before visiting; RW/no-lock containers and a valid allocated rbtree reject as unsupported. |
| `bounded_contention` | A separate thread holds the actual container mutex behind condition-variable barriers. The reader returns busy with zero node/object/bucket/callback counts; after release/join the same empty container completes. No sleeps or same-thread recursive-lock false positive. |
| `bounded_ownership` | Container-only object ownership remains at refcount one inside visitors; aborts at objects 1/32/64 stay incomplete; a 63-node budget denies before object 64 and an exact 64-node budget completes. No destructor runs during visits; all linked objects are destroyed during subsequent fixture cleanup. |
| Extended `retained_nodes` | Actual empty retained nodes are checked at 127 as well as 128, then node 129 produces a 128-node limit result without object visits. |

The unsupported-tree fixture uses the pinned allocator's required comparator;
passing a null comparator would fail fixture construction rather than test the
new API. No private container layout access or production test hook was added.
Destructor/refcount assertions cover the observed fixture invariants, **not**
all allocator, node-ref, corruption, teardown or profile instrumentation.

The read-only package validator now requires a unique bounded native-test name
inventory matching every added `AST_TEST_DEFINE`, `REGISTER` and `UNREGISTER`
exactly once. This is lexical source consistency, not C parsing, compiler
validation, branch coverage or proof that a registration is reachable.
**Ten package tests pass**, including duplicate/omitted/invented inventory and
missing-registration denial even when a changed patch checksum is supplied.
The inventory check still does not authenticate a modified source package.

Validation repeated seven exact pristine preimages, application dry run,
source-only application in an independent checkout and all eight exact
postimage hashes. Named scratch checkouts and the inspected rbtree source are
removed afterward. **No dependency install, C build/test, image or PBX ran.**
The native source count is eight; the only executed tests are the ten package
tests. More lifecycle schedules, delegated-lock/profile/instrumentation cases,
queue protocol/selection boundaries and upstream regressions remain required.
A's verified exit, B/C, all AT/QO acceptance, exact publication, full CP and
M1-09 remain open.

##### Gate A queue coverage: eleven native definitions, still unexecuted

The next source-only increment stays within A's approval and adds three
`TEST_FRAMEWORK` tests in `app_queue`. The manifest now lists **eleven native
definitions**, each with matching registration/unregistration. These are source
assertions awaiting a separately approved native build/run, not passed tests.

| Native source addition | Assertions to execute later, not results |
|---|---|
| `policy_snapshot_selection` | Canonical proof/reserved names select; case variants, empty/digit-led suffixes, underscore, quote and slash deny. Foreign and namespace-only names add no row. Reserved suffix length 32 accepts and 33 denies; unrelated name length 96 skips and 97 conservatively denies. Eight unique rows copy, the ninth denies with `limit`; a duplicate denies without appending. |
| `policy_snapshot_values` | Strategy endpoints, timeout 0/86400, masks 0/255 and caller counts 0/65535 copy exactly. Out-of-range strategy/timeout/masks/counts and inconsistent caller-count/head state deny without appending. Empty and one-member containers report their actual count without walking member/device state. |
| `policy_snapshot_invalid_request` | Missing/extra namespace arguments, empty/short/long namespaces, bad prefix, uppercase/nonhex/quote bytes emit exactly the single fixed `invalid-request` JSON line with namespace null, no objects and CLI transport success. Initialization/completion use metadata only. |

The three sampling tests reuse a private AO2 queue/member-container fixture; queues
are never linked globally, caller heads are inert stack fixtures and member
objects have no device/member initialization or cleanup side effects. The
malformed-request test uses a pipe to capture the direct handler's small error
output, without dispatching through the live registry or reading global queues.
Its byte comparison covers malformed requests only: successful JSON ordering/
escaping, failure after partial sampling, output failure and real dispatch
still require native protocol tests. Member-count ceiling cases, subordinate
queue/member contention and broader lifecycle/profile/instrumentation schedules
also remain open. Native tests still require the separately approved disposable
test process and external timeout; pipe capture is not an execution watchdog.

**Ten package tests pass**, with JavaScript syntax and whitespace checks.
Seven exact preimages pass the validator/application dry run; independent
source-only application matches all eight manifest postimages. Six other
production-file postimages and the existing native-test module are unchanged.
An exact comparison against the preceding candidate, excluding the queue
`TEST_FRAMEWORK` fixture block and its registration calls, confirms no
production queue implementation change. This is source/package evidence, not
C preprocessing, compilation, native execution or runtime correctness.

Both named scratch source directories are removed after checks. No dependency
install, native build/test, image build or PBX execution is authorized or
performed. A's verified exit, Gates B/C, AT/QO acceptance, exact publication,
full CP and M1-09 remain open.

##### Gate A subordinate locks: twelve native definitions, still unexecuted

The source candidate adds `policy_snapshot_contention` under `TEST_FRAMEWORK`,
bringing its manifest inventory to **twelve native definitions** with matching
registration pairs. The test is defined, **not compiled or executed**.

Its eight source schedules combine queue/member-container lock targets,
selected/foreign queue names and zero/one previously copied row. A separate
worker holds the actual AO2 mutex and signals acquisition through a
condition-variable barrier; there are no sleeps, same-thread recursive-lock
contention substitutes or changes to queue names while the worker is active.
For selected queues, the visitor must abort with `busy` without appending or
changing any row, including a prior valid row. Foreign names must skip without
attempting the held subordinate lock.

After release, the worker tries both queue and member mutexes from its own
thread and unlocks each successful probe. These cross-thread probes are
intended to catch locks leaked by the reader, especially the queue lock
acquired before a busy member-container lock. A same-thread recovery call
alone would miss recursive-mutex leaks. Following join, a fresh selected visit
must append exactly one row and preserve any prefix row. Queue/member fixtures
stay private and unlinked globally; no member/device/config/channel or PBX
activity is introduced.

These assertions do not establish a wall-clock bound or real executed
contention result. Native execution still requires the separately approved
disposable test process with an external timeout: a regression that blocks
instead of trying a lock can stall the fixture before it releases the holder.
The test covers subordinate busy/release branches, not all unsupported-state/
unlock-error paths, complete CLI protocol after partial sampling, lifecycle
schedules, member-count ceilings or allocation/ref/debug instrumentation.

**Ten package tests pass**, together with JavaScript syntax, whitespace and
added documentation link checks. Seven exact pristine source preimages and
application dry run pass; an independent source-only application matches all
eight postimage hashes. Comparison with the previous candidate confirms
`app_queue` changes only inside the test fixture block and registration calls;
all seven other postimages are unchanged. Both named scratch directories are
removed after checks. No dependency install, native build/test, image build or
PBX execution occurred. A's verified exit, Gates B/C, AT/QO acceptance, exact
publication, full CP and M1-09 remain open.

##### Gate A protocol and checked output: fourteen definitions, still unexecuted

Protocol source work found a real defect in the prior candidate: the pinned
`include/asterisk/cli.h` declares `ast_cli` as **void**, and `main/cli.c` confirms
that it discards `ast_carefulwrite`'s return value. The getter's previous
`ast_cli(...) < 0` expressions were therefore invalid C, not a working checked
transport. Prior package/application checks did not establish C compilation
and did not catch this API misuse. No earlier native-success claim is made.

The getter now delegates response formatting to the private
`policy_snapshot_respond` helper. It preserves the existing wire fields,
sorting, fixed 8192-byte buffer and all-or-error construction, then emits the
completed bytes through existing `ast_carefulwrite(fd, output, written, 100)`.
Negative return means CLI failure; a fully written logical-error envelope
still means CLI transport success. Format failure is logged and fails instead
of reporting successful output. This is an intentional production-source
correction and extraction, **not** another tests-only change. Request
validation, borrowed traversal, namespace/result mapping and lock policy are
unchanged.

The checked writer uses the same 100-ms setting as pinned `ast_cli`, avoiding
its thread-local dynamic formatting buffer for this getter. Pinned
`include/asterisk/utils.h` and `main/utils.c` require a nonblocking descriptor
for the timeout assumptions. This is not a new wall-clock guarantee for
blocking descriptors or a single kernel write/atomic delivery guarantee.
Partial transport failure can leave truncated bytes and returns CLI failure;
the dispatcher may then add ordinary failure text. Only fully emitted
responses are subject to the single-line JSON contract. No descriptor flags,
global CLI API or other commands are changed.

| Added native definition | Assertions to execute later, not results |
|---|---|
| `policy_snapshot_protocol` | Exact empty observed envelope; eight reverse-ordered input rows sort canonically and emit all eight strategy names (including canonical `rrmemory`, not its alias), timeout/mask/member/caller boundary values and both booleans. Every error code with retained rows emits only its exact error envelope. An unmapped strategy discovered after buffering valid rows emits only `internal`, never a partial observed document. |
| `policy_snapshot_output_failure` | Invalid output descriptor returns CLI failure for both observed and logical-error envelopes, not transport success. |

The manifest now lists **fourteen native definitions**, uncompiled/unexecuted.
Private formatter fixtures do not access global queues or the CLI registry.
Both new capture fixtures and the existing malformed-handler fixture use
`ast_pipe_nonblock` to satisfy the checked writer's descriptor precondition.
These tests do not cover live dispatch, actual traversal-to-response mapping,
slow/disconnected-reader/partial-write schedules, all format-failure injection,
member-count ceilings or remaining lifecycle/profile/instrumentation cases.
An externally timed disposable native test process is still required.

**Eleven package tests pass**, including a narrow lexical source regression
guard that the getter calls the shared responder, uses checked output and
does not treat void `ast_cli` as a value. That guard is not a C compiler or
general API/type checker. JavaScript syntax, whitespace and new documentation
links pass. Seven exact preimages/application dry run and an independent
application's eight postimages match. Exact source comparisons preserve the
visitor, pre-response handler logic and production tail outside native-test
registration; all seven other postimages are unchanged.

Both named scratch directories, including the two read-only upstream API
review files, are removed after checks. No dependencies, native build/test,
image build or PBX execution occurred. A's verified exit, Gates B/C, AT/QO,
exact publication, full CP and M1-09 remain open.

##### Gate A CLI exit coverage: sixteen definitions, still unexecuted

The next A-only source increment changes only the added native test module;
all seven production-source postimage hashes remain identical to the preceding
checked-output candidate. The manifest now contains **sixteen native
definitions**, all **uncompiled/unexecuted**.

Pinned CLI/loader source review confirms that protected dispatch acquires
before entry `inuse`, runs permission/shutdown/handler/output paths and releases
after its final entry access. Completion acquires/releases around its callback
while retaining the registry read lock. The admission helper rejects null
module pointers before trying the loader mutex. This review informs the
fixtures; it does not prove all concurrent loader schedules.

| Native source change | Assertions to execute later, not results |
|---|---|
| Extended `protected_dispatch` | Repeats the real barrier-held dispatch for handler `CLI_SUCCESS`, `CLI_FAILURE` and `CLI_SHOWUSAGE`. Each active handler must reject unregister and every soft/firm/hard unload attempt. After join, command result matches the handler outcome, entry `inuse` is zero and unregister succeeds. |
| New `protected_completion` | Uses real `ast_cli_generator` entry lookup and barrier-held `CLI_GENERATE` callbacks for allocated `"xyz"` and null completion returns. Every unload mode must refuse while the callback is active; returned completion bytes/null match and are cleaned up after join. The entry can be unregistered after completion. |
| New `protected_registration` | A protected entry with null owner is rejected before `CLI_INIT`, linking or metadata allocation; its module/command/usage/full-command/inuse fields stay unset. Null module lease admission also rejects. |

Dispatch/completion schedules reuse one fixture and command instead of a second
registry or loader-state mutation. The fixture checks the actual handler
invocation kind and waits for either callback entry or worker completion, so
admission rejection fails rather than waiting forever for an uncalled handler.
No-fixture generation returns null rather than a CLI failure sentinel that the
completion caller might treat as allocated text.

Completion deliberately does **not** attempt busy unregister while its
callback is paused: it still holds the registry read lock, so the writer
attempt would deadlock the fixture itself. Post-join unregister is checked
instead. The tests still invoke real unload APIs on their own module and
therefore require a separately authorized disposable, serialized native test
process with an external timeout; if the lease veto regresses, teardown can
deadlock or unload executing test code.

These assertions are not exact private `cli_readers` counter observations.
Entry `inuse` reaching zero and successful unregister do not prove that the
module lease count drained. Final-output pause points, exact release counts,
permission/shutdown denials, loader-lock contention, startup/declined/closing
admission, unload-failure and shutdown schedules, ordinary-command regressions
and profile/instrumentation coverage remain open. No production test hooks,
global shutdown state edits or extra public inspection API were added.

**Eleven package tests pass**, along with JavaScript syntax, whitespace and
added documentation link checks. Seven exact source preimages/application dry
run pass; independent source-only application matches all eight postimages.
Both named scratch directories are removed after verification. No dependency
install, native build/test, image build or PBX execution occurred. A's verified
exit, Gates B/C, AT/QO, exact publication, full CP and M1-09 remain open.

##### Gate A rejected states: seventeen definitions, still unexecuted

Continuing within A, the source package adds
`policy_snapshot_rejected_state`, for **seventeen native definitions** with
matching registration/unregistration inventory. None have been compiled or
executed.

The new test defines eighteen private-fixture schedules: realtime, dead,
missing member container, RW-locked member container, unlocked member
container, invalid timeout, out-of-range empty mask, inconsistent caller
count/head and invalid strategy, each with zero/one previously copied row.
Every schedule must abort with `unsupported-state`, append nothing and
preserve all row bytes. The fixture then restores supported owner state.
A separate probe thread must acquire/release the original queue and
member-container mutexes, followed by a successful visit that appends exactly
one target row without modifying the prefix.

The existing contention test and new rejected-state test share their
cross-thread probe implementation. This catches original queue/member mutexes
left held by rejection paths without a same-thread recursive-lock false
positive. The RW/no-lock substitute containers are real AO2 fixtures, not
private-layout edits; the test restores the original member container before
probing and cleanup. It does **not** establish that a rejected substitute was
never locked/refcounted or that all allocation/debug instrumentation is absent.
Realtime is a private fixture flag, not a realtime backend lookup, and queues
remain unlinked globally.

These source assertions cover rejection branches before/after member-lock
acquisition. They are not native acceptance results, a complete error-injection
matrix or a watchdog. Unsupported queue-object lock kinds, member-count
ceilings, unlock-error injection, traversal/response integration, remaining
loader/shutdown/release-count schedules and profile/regression execution remain
open. Separately approved disposable native execution with an external timeout
is still required.

**Eleven package tests pass**, with JavaScript syntax, whitespace and added
documentation link checks. Seven exact preimages/application dry run pass;
independent source-only application matches all eight postimages. Exact
comparison confirms production `app_queue` source is unchanged outside the
`TEST_FRAMEWORK` fixture region and registration calls; the other seven
postimages are unchanged. Both named scratch directories are removed after
checks. No dependency install, native build/test, image build or PBX execution
occurred. A's verified exit, Gates B/C, AT/QO, exact publication, full CP and
M1-09 remain open.

##### Gate A private traversal integration: eighteen definitions, still unexecuted

The A-only source candidate adds `policy_snapshot_traversal`, bringing its
inventory to **eighteen uncompiled/unexecuted native definitions**. It calls the
actual bounded AO2 API with the actual queue visitor, then captures the actual
private responder's bytes. No mock visitor, global `queues` substitution,
runtime CLI registration or PBX is used.

The private one-bucket mutex list covers:

- Empty traversal: complete, one bucket, zero nodes/objects/rows and exact empty
  observed JSON.
- Two selected queues plus one foreign queue: complete with three physical
  nodes/objects but two copied rows; exact JSON sorts the reversed selected
  input order and excludes the foreign name.
- A selected dead queue reached after two valid rows: traversal returns
  aborted with three node/object visits and `unsupported-state`; the responder
  emits only the exact error line despite the two retained rows.
- Nine valid selected queues: traversal aborts on object nine with eight copied
  rows and `limit`; only the exact limit envelope is emitted and the private
  container retains all nine objects.

The fixture relies on the pinned list owner's default insertion-at-tail
behavior with no comparator and no insert-begin option; this was checked in
`main/astobj2_hash.c`. It retains its own queue references, cleans the container
before releasing fixture-owned member/string storage and never invokes normal
queue/device initialization or destruction.

This connects traversal/copy/response for complete and visitor-aborted paths,
not the global handler's status mapping, real CLI dispatch, top-level busy/
node/object budgets, subordinate-lock instrumentation or concurrent runtime
reload/unload. Those and remaining member-ceiling, release-count, lifecycle/
profile cases still need native coverage/execution. No AT/QO pass is inferred.

**Eleven package tests pass**, with JavaScript syntax, whitespace and added
documentation link checks. Seven exact source preimages/application dry run
pass; independent source-only application matches all eight postimages.
Production queue code compares unchanged outside the `TEST_FRAMEWORK` region
and registration calls; the seven other postimages are unchanged. Both named
scratch directories are removed after checks. No dependencies, native build/
test, image build or PBX execution occurred. A's verified exit, Gates B/C,
AT/QO, exact publication, full CP and M1-09 remain open.

##### Gate A owner boundaries: twenty definitions, still unexecuted

Two further A-only native source definitions bring the manifest inventory to
**twenty uncompiled/unexecuted tests**:

| Definition | Assertions to execute later, not results |
|---|---|
| `policy_snapshot_queue_lock_kind` | Actual RW/no-lock AO2 queue objects with valid selected names reject as `unsupported-state`, with zero/one previous row byte-preserved and fixture reference count unchanged. Their member pointer stays null. This does not instrument whether an attempted lock or member-field read occurred. |
| `policy_snapshot_member_boundary` | Builds an actual private member list of 65,535 distinct AO2 objects and checks accepted count, zero callers and preserved prefix. Object 65,536 produces `unsupported-state` without appending or changing rows. Unlinking just that object restores acceptance at 65,535. Destructor counters remain zero during reads, become one after unlink/release and equal all created objects after fixture cleanup. |

No atomic count or private container layout is fabricated. The member objects
are small synthetic ownership fixtures, not real queue members: they register
no devices, channels or backend activity. All queue objects remain unlinked
globally. Allocation/link failures explicitly fail the test and clean up
already-created objects; fixture-owned references keep destructor-counter
storage alive until cleanup finishes.

The member-boundary definition intentionally requires up to **65,536 objects
and container nodes** when eventually executed, rather than substituting a
smaller proxy threshold. That allocation, teardown and any debug/ref logging
must be included in the separately approved native process resource/time
budget. No measured memory/time or native correctness result is claimed here.
These definitions do not cover every instrumentation/ref/profile path or
replace the outstanding global-handler, exact lease-drain, startup/shutdown
and regression acceptance work.

**Eleven package tests pass**, with JavaScript syntax, whitespace and added
documentation link checks. Seven exact preimages/application dry run pass;
independent source-only application matches all eight postimages. Comparison
with the prior candidate confirms changes only in queue `TEST_FRAMEWORK`
fixtures/registration; all seven other postimages are unchanged. Both named
scratch directories are removed after checks. No dependency install, native
build/test, image build or PBX execution occurred. A's verified exit, Gates
B/C, AT/QO, exact publication, full CP and M1-09 remain open.

##### Gate A status mapping: twenty-one definitions, still unexecuted

The source candidate extracts the handler's existing traversal-status switch
into private `policy_snapshot_apply_status`, called immediately after the same
bounded traversal. Its case logic is unchanged: complete preserves any prior
error; busy/limit/unsupported replace it with their matching error; aborted
preserves a visitor error or supplies `internal`; invalid/internal/unknown
statuses map to `internal`. The extraction is a production-source refactor,
not a tests-only delta or an intentional wire behavior change.

New `policy_snapshot_status_mapping` brings the inventory to **twenty-one
uncompiled/unexecuted native definitions**. Its 90 source combinations cover
all seven declared statuses plus two unknown enum values, five prior-error
states (none/busy/limit/unsupported/internal) and zero/one copied row.
It checks exact selected error, unchanged namespace/count/row bytes, then
compares output from the real responder against exact JSON. Only complete
with no prior error may produce observed JSON; all incomplete statuses and
complete-with-prior-error emit only an error envelope, never retained rows.

These are explicit injected status inputs to the actual helper, not evidence
that the global container produced every status or that the handler was
dispatched under those conditions. They complement the private actual
traversal integration; they do not replace real global-handler/CLI execution,
concurrent reload/unload, output/lock/ref instrumentation, exact lease-drain
or outstanding lifecycle/profile regressions.

**Eleven package tests pass**, along with JavaScript syntax, whitespace and
added documentation link checks. Seven exact preimages/application dry run
pass; independent source-only application matches all eight postimages.
An exact comparison reconstructing the extraction from the preceding source
confirms the switch body is unchanged apart from argument/pointer spelling,
with no other production delta; all seven other postimages are unchanged.
Both named scratch directories are removed after verification. No dependency
install, native build/test, image build or PBX execution occurred. A's verified
exit, Gates B/C, AT/QO, exact publication, full CP and M1-09 remain open.

##### Gate A acceptance reconciliation: source coverage is not an exit

This reconciliation applies to source candidate commit `4148a3e`, whose
manifest lists **21 native definitions**, with no native compilation/execution.
It adds no patch, test hook, dependency or runtime authority. Earlier sections
record historical increments; the following matrix identifies current
evidence and outstanding obligations, not passed acceptance checks.

| Requirement | Current source assertions/evidence | Remaining before acceptance |
|---|---|---|
| AT-01 | `bounded_matrix`, `bounded_walk`, queue lock-kind/rejected-state fixtures cover argument/limit and actual unsupported container/lock kinds. | Instrument rejection-before-lock and wrapper behavior; compile/run all cases. |
| AT-02 | `bounded_contention` uses a real cross-thread holder; queue contention/rejection fixtures probe original mutexes after reader return. | Exact acquisition/release counters, lock/unlock fault injection and nonrecursive-call/profile proof. |
| AT-03 | `bounded_matrix` covers 1/53/64 buckets and 65-bucket preflight denial; retained-node fixtures deny empty-live shortcuts. | Owner-level zero-bucket inconsistency fixture and instrumented empty-chain step accounting without unsafe caller layout edits. |
| AT-04 | `retained_nodes` defines actual empty retained-node cases at 127/128/129. | Execute with node-access/cleanup instrumentation to prove refusal before node 129 and no hidden cleanup walk. |
| AT-05 | `bounded_walk` covers actual 64-object completion and 65-object preflight denial; `bounded_ownership` covers exact node limits. | Explicit 63-live-object case, mixed retained/live collisions, inconsistent live-count detection and comparator/hash-call instrumentation. |
| AT-06 | `bounded_walk` checks invalid visitor return; `bounded_ownership` checks aborts at 1/32/64; queue protocol/status fixtures reject partial output. | Execute; exact ref/allocation/cursor/lock/mutation accounting on every exit. |
| AT-07 | Ownership/destructor fixtures check selected object refs and fixture cleanup, including member-boundary destruction. | Node/container/object ref hooks, allocator/free/mutation hooks and retirement/unlink barriers. Current checks are not exhaustive instrumentation. |
| AT-08 | Queue fixtures cover contention, selection/names, eight/nine rows, policy/count state, real member ceiling, actual traversal and exact JSON. | Exact 17-acquisition/visitor-work limits, no-backend/no-private-data instrumentation and actual handler/adapter integration. |
| AT-09 | Lease, dispatch and completion definitions attempt all unload modes while callbacks are active; null-owner admission rejects. | All required lifecycle pause points, exact reader counts/release, denied admission, shutdown/start/unload-failure schedules and debug/ref/lock profile checks. |
| AT-10 | Exact patch package/preimages/postimages and 11 JavaScript package tests are checked. | Native compile/link/tests, affected upstream regressions, full ABI-compatible runtime and immutable build/image/profile evidence. Package checks cannot substitute. |
| QO-01 | Private CLI metadata/malformed-request fixtures, canonical name selection and source-owned command. | Real dispatch plus trusted adapter scope/authority checks and protocol negatives; CLI namespaces are not authentication. |
| QO-02 | Private static/realtime/dead fixtures; borrowed visitor source; destructor/ownership assertions. | Instrument absence of loads/refreshes/file/DB/device/counter effects and every failure cleanup path. |
| QO-03 | Lock-order source review, try-lock traversal and subordinate fixtures, active-callback unload veto assertions. | Deterministic retirement/replacement/lifetime schedules, exact lock/work/no-I/O accounting and native proof. |
| QO-04 | `policy_snapshot_copy` uses timeout 2/7 and actual parser masks 0/35; value/protocol fixtures cover effective bounds. | Full condition-list/alias/unknown-bit/timer fixtures and owned loaded-versus-restored-disk proof. |
| QO-05 | Selection, duplicate, foreign, row/count/list and actual member/traversal fixtures. | Expected/missing baseline-target comparison via host adapter; total-inventory bound integration and instrumented exposure checks. |
| QO-06 | Exact responder/status/error bytes are asserted in native source. | Strict host 8 KiB parser/custom binding wiring and truncation/extra-stdout/unknown-field/mask/error-exit negatives with stock regressions. |
| QO-07 | Source manifest pins the upstream commit, patch and file hashes, with honest false execution flags. | Gate B immutable dependency/builder/runtime/archive closure, licenses, ABI/module startup chain and enforced resources. No image/build manifest exists yet. |
| QO-08 | No custom-runtime proof executed. Private fixtures are not two-customer isolation evidence. | Separately approved Gate C owned two-PBX proof and loaded/disk negative cases. |
| QO-09 | Error-only response fixtures and source lifetime mechanisms; no publication authority added. | Outage/restart/concurrent-read/object-change/receipt-write failure schedules preserving prior evidence and uncertainty. |
| QO-10 | Default stock runtime/inspector untouched; named source scratch cleaned after each published increment. | Focused stock regressions, custom full build/native functional/profile checks and owned runtime cleanup evidence. |

**Critical lifecycle gap:** testing a callback while it is active does not
prove the lease remains held through dispatcher usage/failure output and
entry cleanup, nor that its final decrement happens exactly once. Successful
unregister and `inuse == 0` do not measure `cli_readers`. The same tests do not
prove denied admission when unload wins. These are safety prerequisites, not
optional extra coverage to defer until after runtime enablement.

**Next bounded A work:** design and review test-only synchronization and
counters at the existing lookup-before-admission, admitted-before-handler,
handler-before-output, output-before-entry-release and final-release points.
The fixture needs a controller outside the unloadable target, explicit event
ordering, exact admission/release/teardown counts and negative teardown-first
schedules. Cover dispatch and completion without introducing a registry
writer while a paused callback holds its read lock. Hooks must be disabled
outside the native test profile, add no production CLI/public bypass and
never allocate/wait/log inside the production bounded visitor. Define how
the controller fails on missing events, joins workers and uses the external
process watchdog. Do not unload executing test code to demonstrate success.
If safe fixtures require broader source surfaces or changed production
semantics, stop and obtain a scope decision before adding them.

**Execution handoff remains blocked:** Gate B still needs immutable builder/
runtime digests, exact package snapshot/versions/hashes and third-party archive
closure, configure/menuselect/module and license manifests, a no-unrecorded-
fetch command list, and enforceable CPU/memory/storage/time caps. Existing
2 CPU/2 GiB/20 GiB/30-minute figures remain proposals, not approval or measured
sufficiency; include the 65,536-object fixture and instrumented logging cost.
Only an explicitly approved closed build environment may compile/run native
tests. Gate C independently controls PBX proof after prerequisites. No new
approval is inferred from this reconciliation or a plain continuation.

No new tests are executed for this documentation-only increment; the recorded
11 package passes and exact source checks belong to the preceding candidate.
The patch and manifest remain unchanged. All AT/QO checks, A's verified exit,
Gates B/C, exact publication, full CP and M1-09 remain open.

##### Gate A separate lifecycle target: twenty-two definitions, still unexecuted

After an interrupted scope form, the user explicitly selected
**`approve-separate-target-source`**. This expands the approved patch boundary
by exactly one native fixture file, `tests/test_protected_cli_target.c`, plus
test-profile instrumentation in the already approved module header/CLI/loader
files. It does not authorize dependencies, compilation, native execution,
image builds or PBXs. The package now contains **seven changed upstream files
and two new native files**, with **22 uncompiled/unexecuted test definitions**.
The target file is a supporting module, not an additional test definition.

**Implemented source candidate, not executed lifecycle evidence:**

- `TEST_FRAMEWORK`-guarded declarations/state/hooks record admission increments,
  actual reader count, admitted dispatch, target handler invocation, handler
  return, post-output/post-`inuse` entry cleanup, final decrement, target unload
  callback and worker completion. The core owns the fixture state and barrier;
  no callback pointer into the disposable target is retained by the controller.
- The observer recognizes only the exact disposable target resource name.
  It can pause at admitted-before-handler, handler-return-before-dispatcher-
  output, entry-cleanup-before-release or immediately after the atomic release.
  Admission counting under the loader lock and target unload recording never
  pause. Controller wait releases the fixture mutex and never calls loader APIs
  while holding it; no instrumentation enters the bounded AO2/queue visitor.
- In the test profile, release identifies the target while its lease still
  protects the module, then captures the atomic decrement's previous count.
  After decrement, it touches only core-owned fixture state, never the module
  or entry. This permits the controller to unload the target while the dispatch
  worker is paused safely in core after release.
- New `protected_target_lifecycle`, defined in the existing controller test
  module, specifies **12 schedules**: four pause points times success/failure/
  usage outcomes. Before release, soft/firm/hard unload must all refuse and
  no target unload callback may run. After release, soft unload must succeed
  while the worker remains paused; a fresh command lookup must fail, not invoke
  the removed handler.
- After worker join and target cleanup, exact event assertions require one
  acquisition, handler invocation, handler-return/entry-cleanup event, release,
  unload callback and worker completion, with actual recorded reader count
  zero. The controller remains loaded throughout; successful teardown is no
  longer an attempt to unload this test's own code. Older self-module unload
  tests remain separate disposable-only fixtures and are not superseded as
  executed results.

The controller refuses to adopt an already loaded target. The eventual
disposable test configuration must **exclude the target from autoload** and
let this test load/unload it; do not run the fixture on a runtime PBX or
concurrently with other target/observer tests. The observer permits one armed
session. Its missing-pause wait has a five-second timed condition; resume/join
and end follow on cleanup. Session end rejects nonzero readers or a missing
worker completion, rather than clearing evidence of a leaked lease.
Unexpected unload/drain failures explicitly fail and require discarding the
native process. Worker join and teardown are not internally time-bounded;
an external process watchdog/resource cap remains mandatory. A safety
regression may still crash/hang the disposable target process, never justify
force-cleaning or reusing a shared PBX.

This first instrumented source fixture does **not** implement lookup-before-
admission, teardown-wins/closing admission, loader-lock contention, denied
permission/shutdown, startup/unload-failure/recursive/refresh schedules or
instrumented completion. It brackets dispatcher output but uses `/dev/null`;
slow/disconnected/partial output still needs its own schedules. Counts measure
the target handler/unload callback and actual lease increments/decrements, not
all subscription cleanup/destructors or an instrumented `dlclose`. No new
production command, public production bypass or release-profile API is added.

**Twelve package tests pass**, including rejection if the approved new target
is falsely described as an existing upstream preimage. Validator scope is the
exact nine paths, not a wildcard expansion. JavaScript syntax, whitespace and
added documentation links pass. Seven exact preimages/application dry run and
independent application to all **nine postimages** match. A lexical
`TEST_FRAMEWORK`-off comparison, allowing only blank-line-run differences,
matches the previous core/header candidate. That is not a C preprocessing,
linking, build-profile or instrumentation-transparency result. Queue/AO2
implementation postimages are unchanged. The initial new-file CRLF mismatch
was corrected to LF before final hashes/application checks.

Both named scratch directories and the pinned lock-header review download are
removed after checks. The native execution flags remain false; A's verified
exit, Gates B/C, all AT/QO acceptance, exact publication, full CP and M1-09
remain open.

##### Gate A instrumented completion: twenty-three definitions, still unexecuted

Within the separately approved target/instrumentation boundary,
`protected_target_completion` adds **eight native source schedules**: admitted,
callback-returned, entry-done-before-release and released, each with allocated
`"xyz"` or null completion. The existing separate controller/target and
core-owned observer are reused; no new source path or production API is added.
The manifest now lists **23 uncompiled/unexecuted native definitions**.

`TEST_FRAMEWORK` hooks in the real protected CLI generator record admission,
callback return and its final pre-release boundary. The disposable target
records its actual generation callback and returns allocated text only for
word `"x"` at completion index zero, otherwise null. The shared controller
checks exact acquisition/invocation/return/entry/release/unload/worker event
counts, actual reader count one before release and zero afterward, and exact
returned text/null. Paused snapshots must show no worker completion or unload.
Existing dispatch schedules also gain that missing worker-completion check.

Before release, all soft/firm/hard unload attempts must veto without invoking
target teardown. At the released completion pause, the reader count is zero,
but the CLI generator still holds the helpers registry read lock protecting
its remaining entry traversal. The controller therefore **does not attempt
unload or unregister there**: those may acquire a registry writer and deadlock
against the paused generator. It resumes and joins first, then soft-unloads
the target and checks one final release/unload. Unlike the dispatch released
schedule, this does not prove unload can finish before generator return.
`ENTRY_DONE` here denotes callback/lease work finished before release, not that
all generator registry traversal or entry accesses are over.

These are instrumented source assertions, not observed counts or native passes.
The target must remain excluded from autoload; run only a separately approved,
serialized disposable test process with external watchdog/resource caps.
Lookup-before-admission, teardown-wins/closing denial, loader contention,
permission/shutdown/startup/unload-failure/refresh schedules, slow output and
broader ref/cleanup/profile instrumentation remain open.

**Twelve package tests pass**, with JavaScript syntax, whitespace and added
documentation links checked. Seven exact source preimages/application dry run
and all nine independently applied postimages match. Only the guarded CLI
hooks and the two native fixtures change; queue, AO2, loader and header
postimages are unchanged. Lexical `TEST_FRAMEWORK`-off CLI comparison matches
the prior candidate, not a preprocessor/compiler/transparency proof. Both
named scratch directories are removed after verification. No dependency
install, native compile/test, image build or PBX execution occurred. A's
verified exit, Gates B/C, AT/QO, exact publication, full CP and M1-09 remain
open.

##### Gate A teardown-first closing: twenty-four definitions, still unexecuted

Within the approved separate-target/test-profile boundary,
`protected_target_closing` adds a serialized teardown-first source fixture.
The inventory is **24 uncompiled/unexecuted native definitions**, still on
the same nine source paths. No production admission/unload semantics change.

The disposable target gains a one-shot `refuse-unload` fixture command. The
controller arms it before observation, then soft-unloads with no active lease.
The actual target unload callback returns failure before unregistering its CLI
entry. The pinned loader leaves the module running and registered but retains
`cli_closing = 1`. The source test requires that unload to fail and the module
to remain present, then attempts one real dispatch and two real completions
(the words that would otherwise return allocated text or null).

A new core-owned `TEST_FRAMEWORK` event records denial only after obtaining the
loader lock and observing a running, nondeclined, closing target, including its
actual reader count. This distinguishes closing-state refusal from an absent
command, loader-lock contention or ordinary null completion. The controller
requires exactly three closing denials, zero acquisitions/callbacks/returns/
entry-cleanups/releases, zero readers and no pause. It then soft-unloads the
target successfully, requiring two total unload callbacks including the earlier
refusal. A final reused released-dispatch schedule requires a fresh load to
admit, release and unload normally; it does not reopen the retained failed-
unload instance.

The denial checks are synchronous in the separate controller; its completion
event marks controller work done, not a concurrent worker. Its observer is
resumed before requests so an erroneous acquisition cannot pause the controller
on the release barrier; exact event counts still fail that regression. Existing
dispatch/completion schedules now also require no closing-denial event.
Unexpected target/session cleanup fails explicitly and requires discarding the
test process. The target remains excluded from autoload, and native runs still
require a separately approved serialized disposable process and external
watchdog/resource caps.

This covers **source assertions for teardown finishing unsuccessfully before
admission**, not lookup-before-admission races, teardown overlapping lookup,
loader-lock contention, shutdown/permission denial, general unload failures,
refresh/recursive teardown, slow output or full startup/profile acceptance.
All AT/QO gates remain open until the necessary native evidence exists.

**Twelve package tests pass**, as do JavaScript syntax, whitespace and added
documentation links. Seven exact preimages/application dry run and all nine
independently applied postimages match. Only the guarded module-header/loader
observer and two native fixtures change; the other five postimages are
unchanged. Lexical `TEST_FRAMEWORK`-off header/loader parity with the preceding
candidate passes, not C preprocessing, compilation or runtime transparency.
The two named source scratch directories are removed after verification.
No dependency install, native build/test, image build or PBX execution occurred.
A's verified exit, Gates B/C, exact publication, full CP and M1-09 remain open.

##### Gate A lookup ordering: twenty-five definitions, still unexecuted

`protected_target_lookup` adds **three instrumented source schedules** within
the existing nine-path approval: real dispatch, allocated-result-word
completion and null-result-word completion. The inventory is now **25
uncompiled/unexecuted native definitions**. The existing disposable target
and its one-shot unload refusal are unchanged.

Test-profile hooks now record protected entry lookup immediately before lease
admission in dispatch and generation, while the helpers registry read lock is
still held. The core observer permits pausing at this new event. Each schedule
arms target unload refusal before observation, starts the existing worker and
requires exactly one lookup and no acquisition, callback, release, unload or
worker completion at the pause. The separate controller then soft-unloads:
the real callback must refuse before unregistering, leaving the module present
and closing. No fixture mutex is held when calling loader APIs.

After controller resume/join, dispatch must fail or completion must return
null, with exactly one closing-state denial and its actual reader count zero.
The final event matrix requires one lookup/denial/worker completion, two unload
callbacks (refusal and post-join successful cleanup), no acquisitions, handlers,
handler returns, entry cleanup or releases. Existing admitted lifecycle tests
now require one lookup each; the sequential closing test requires three.
All controller/session cleanup failures remain explicit native-test failures.

This specifies **failed teardown winning between lookup and admission**, not
successful removal of an entry still protected by the registry read lock.
The controller must not attempt normal successful teardown while that worker
is paused: unregister requires the registry writer and would block. A broken
one-shot refusal or lock regression can still hang; serialized disposable
execution, target exclusion from autoload and an external watchdog/resource
cap remain mandatory. No shared/runtime PBX is an acceptable test host.
The barrier establishes a controlled ordering, not exhaustive concurrency,
loader-lock-contention, successful-teardown-race, permission/shutdown,
refresh/recursive or slow-output acceptance. All AT/QO gates remain open.

**Twelve package tests pass**, with JavaScript syntax, whitespace and added
documentation links checked. Seven exact preimages/application dry run and
all nine independently applied postimages match. Only guarded header/CLI/loader
instrumentation and the controller fixture change; the other five postimages,
including the separate target, are unchanged. Lexical `TEST_FRAMEWORK`-off
header/CLI/loader parity matches the preceding candidate; that is not
preprocessing, compilation or profile-transparency proof.
Both named source scratch directories are removed after verification.
No dependency install, native compile/test, image build or PBX operation
occurred. A's verified exit, Gates B/C, exact publication, full CP and M1-09
remain open.

##### Gate A loader contention: twenty-six definitions, still unexecuted

`protected_target_loader_busy` adds a foreign-thread loader-contention source
fixture within the same nine-path approval. The inventory is **26
uncompiled/unexecuted native definitions**. Only test-profile module-header/
loader instrumentation and the controller fixture change; the other six
postimages, including production CLI and the disposable target, are unchanged.

A new `TEST_FRAMEWORK`-only core helper acquires the real module-list lock,
records `LOADER_LOCKED` through the existing core observer, waits at that
barrier and unlocks after resume. The holder runs on a separate worker, not
the controller: recursive acquisition on the same thread would not establish
contention. The observer accepts this pause point; it releases its own mutex
while waiting. No target callback, production bypass or substituted lock is
used. The target is loaded before starting the holder.

At the first pause the test requires only one holder event, no request events,
zero readers and no worker completion. While the holder remains paused, the
controller invokes real dispatch and both completion words. Dispatch must fail
and both completions must return null. A second snapshot before resume requires
exactly three target lookups, still one holder event, and **no acquisitions,
admission, callbacks, releases, closing-state denials, teardown or worker
completion**. Returning from all three requests before releasing the foreign
loader owner specifies try-lock refusal rather than waiting for that owner.
This is not an elapsed-time threshold or an observed runtime latency result.

After resume/join, the controller repeats all three requests on the **same
still-loaded target**: dispatch must succeed, text completion must equal
`"xyz"` and the null branch must stay null. Final counters require six lookups,
three acquisitions/admissions/handlers/returns/entry-cleanups/releases, one
holder event, one holder-worker completion, one successful unload callback,
zero closing denials and zero readers. Existing admitted lifecycle schedules
also require no loader-holder event. Cleanup always resumes/joins before
unload; failures explicitly fail and require discarding the test process.

The helper intentionally holds a global loader lock and must never run on a
shared/runtime PBX. The serialized disposable process, excluded-from-autoload
target, separately approved native resources and external watchdog remain
mandatory: an accidental blocking admission could deadlock this source test.
This does not establish shutdown/permission denial, successful-removal races,
refresh/recursive teardown, slow-output, profile or exhaustive concurrency
acceptance. All AT/QO gates remain open.

**Twelve package tests pass**, as do JavaScript syntax, whitespace and added
documentation links. Seven exact preimages/application dry run and all nine
independently applied postimages match. Lexical `TEST_FRAMEWORK`-off header/
loader parity with the preceding candidate passes; it is not preprocessing,
compilation or runtime transparency evidence. Both named source scratch
directories are removed after verification. No dependency installation,
native build/test, image build or PBX operation occurred. A's verified exit,
Gates B/C, exact publication, full CP and M1-09 remain open.

##### Gate A permission denial: twenty-seven definitions, still unexecuted

`protected_target_permission` adds **three source schedules** within the same
nine-path approval. The inventory is **27 uncompiled/unexecuted native
definitions**. The production permission decision is not bypassed, replaced
or given a new exception.

A `TEST_FRAMEWORK`-only core fixture installs one deny rule for UID `INT_MAX`
and the disposable target command prefix in the real CLI permission list.
It refuses an existing matching UID/GID or an active fixture rather than
adopting another rule, and refuses a busy permission-reload mutex. It retains
that mutex on the controller until all workers join and the exact inserted
rule/storage are removed. List changes use the existing permission-list writer
lock; normal permission reads still use their normal reader lock. Allocation
failures clean up without inserting a partial rule. No configuration file,
default permission, existing rule or operating-system identity is changed.
The fixture is serialized and disposable-only; never arm it on a runtime PBX.

The existing lifecycle worker can dispatch through `ast_cli_command_full` with
the reserved UID/GID. Three schedules pause at admitted-before-permission,
post-denial-output/entry-cleanup and final release. A new target-scoped core
event records the **real permission-denied branch**. Each schedule requires
one lookup/acquisition/admission, one permission denial, no target handler or
handler-return event, one entry cleanup/release, zero final readers, one
successful target unload and one worker completion. At admission the denial
has not happened yet; by entry cleanup it must have happened without invoking
the handler. Before release all soft/firm/hard target unloads must veto.
At the released pause soft unload must succeed while the worker is safely
paused in core. A fresh lookup of the removed command must fail.

The shared lifecycle assertions now distinguish ordinary handler outcomes from
permission-denied dispatch and require zero permission-denial events for the
existing success/failure/usage/completion schedules. After removing the scoped
rule, a normal uncredentialed lifecycle schedule checks fresh target load/
admission/release/unload. That uses the existing internal CLI permission bypass,
not evidence that the reserved UID's prior policy was permit. Permission-
denial output is bracketed but still goes to `/dev/null`; exact text, slow or
disconnected output, shutdown denial and broader policy/reload races remain
unproven. All AT/QO/native acceptance gates remain open.

**Twelve package tests pass**, with JavaScript syntax, whitespace and added
documentation links checked. Seven exact preimages/application dry run and
all nine independently applied postimages match. Only test-profile header/
CLI/loader instrumentation and the controller fixture change; the other five
postimages, including the disposable target, are unchanged. Lexical
`TEST_FRAMEWORK`-off header/CLI/loader parity matches the preceding candidate,
not preprocessing, compilation or runtime-transparency proof. Both named
source scratch directories are removed after verification. No dependency
installation, native compile/test, image build or PBX operation occurred.
A's verified exit, Gates B/C, exact publication, full CP and M1-09 remain open.

##### Gate A nonrecursive refresh: twenty-eight definitions, still unexecuted

The inventory is now **28 uncompiled/unexecuted native definitions** within
the same nine source paths. Only the existing controller fixture changes:
all eight other source postimages, including core instrumentation and the
separate target, are byte-for-byte unchanged.

Every existing separate-target lifecycle schedule paused before final release
now attempts `ast_refresh_resource(target, mode, 0)` for soft, firm and hard
modes, as well as direct unload. Each refresh must fail before target teardown
or a new startup. The existing final event assertions still require no extra
handler, acquisition, release or unload callback. This applies to admitted/
handler-return/entry-cleanup dispatch and completion, and admitted/entry-cleanup
permission-denied dispatch. No refresh is attempted while a completion worker
is paused after release with the registry read lock still held.

New `protected_target_refresh` exercises actual **nonrecursive soft refresh**
without active readers. Before observation it arms the existing one-shot target
unload refusal. The first refresh must fail with the target still present.
Dispatch plus text/null-word completion must then deny due to retained closing
state. A second soft refresh must succeed by unloading/reloading the target,
after which all three requests must work normally: successful dispatch, exact
`"xyz"` completion and null completion. Cleanup soft-unloads the fresh target.
The test never resets closing directly or treats the failed instance as open.

The final exact event matrix requires six lookups, three closing denials,
three acquisitions/admissions/handlers/handler-returns/entry-cleanups/releases,
three unload callbacks (initial refusal, successful refresh and final cleanup),
one controller completion and zero readers/permission-denials/loader-holder
events. The core observer is resumed before these synchronous controller calls
so release recording cannot pause the controller. Its completion event is not
a concurrent worker claim. Module presence is checked after each refresh so
cleanup does not assume that reload succeeded. Unexpected cleanup/drain failure
explicitly fails and requires discarding the native process.

This is source coverage for nonrecursive refresh only. It does not establish
recursive dependent traversal, dependency startup ordering, reload failure,
shutdown, slow/disconnected output, successful-removal races or native
acceptance. The target must remain excluded from autoload, tests serialized
in a separately approved disposable process with an external watchdog/resource
cap. No shared/runtime PBX may host these tests. All AT/QO gates remain open.

**Twelve package tests pass**, with JavaScript syntax, whitespace and added
documentation links checked. Seven exact preimages/application dry run and
all nine independently applied postimages match. No profile-off comparison
is needed for this increment because no core/header source postimage changes;
this is not compilation or instrumentation-transparency evidence. Both named
source scratch directories are removed after verification. No dependency
installation, native build/test, image build or PBX operation occurred.
A's verified exit, Gates B/C, exact publication, full CP and M1-09 remain open.

##### Gate A current acceptance handoff: twenty-eight definitions, no native exit

This reconciliation applies to source candidate **`72c5ef0`**, patch SHA-256
`2ae70680493482bd7053f70f172bfa32b348cd5be35b9fefacd2bad8c0adc725`.
The exact nine-path package contains **28 uncompiled/unexecuted native
definitions**, seven modified upstream files and two new native fixtures.
It supersedes the *current-status* reading of the earlier 21-definition
acceptance reconciliation, not its requirements or historical evidence.
No source/package bytes or approval flags change in this documentation-only
increment. Test-definition counts are inventory, not an acceptance score.

**Lifecycle delta since the earlier matrix (AT-09/QO-03):**

| Obligation | Source assertion now defined | Still missing before acceptance |
|---|---|---|
| Dispatch lease through output/entry cleanup/final release | Separate-target controller, four pause points across success/failure/usage, actual reader/event counters and successful soft unload while dispatch is paused safely in core after release. | Compile/run; slow/disconnected transport, actual destructor/dlclose accounting, all failure paths and affected regressions. |
| Completion lifetime | Four pause points across allocated/null results; pre-release unload veto and exact release counts. | Compile/run; registry-lock contention and remaining generator traversal/lifetime instrumentation. Zero readers does not imply registry read-lock exit. |
| Teardown-first and lookup-before-admission | Sequential retained-closing denial and three worker schedules where failed soft teardown wins after lookup. | Compile/run; successful-removal ordering and broader concurrency. A refusal before unregister is not proof of completed removal under a paused registry reader. |
| Loader contention | Real foreign-thread module-list owner; three requests return denied before owner release; same loaded target recovers with exact acquisition/release counts. | Compile/run and validate profiles/watchdog; no measured elapsed-time threshold is asserted. |
| Permission denial | Real scoped deny rule and credentialed dispatch; admitted/entry-done/released pauses require no handler and one final release. | Compile/run; exact transport output, policy/reload races and other denial/error branches. No permission default or disk configuration is changed. |
| Nonrecursive refresh/unload failure | Active-lease soft/firm/hard refresh veto; one-shot soft refusal retains closing, successful retry reloads and serves dispatch/completion. | Compile/run; recursive dependencies, reload/start failure, partial cleanup, declined modules and broader unload failures. |
| Registration and protected unregister | Null-owner registration/admission rejection; older active-dispatch busy-unregister fixture. | Compile/run; full registration/startup failure cleanup and independent helpers-writer contention. Older self-module fixtures are not separate-target removal evidence. |
| Shutdown | Production candidate has shutdown admission checks and leased-module skip logic. | Deterministic actual shutdown-before-admission and shutdown-after-admission schedules, process-exit ordering, cleanup and native evidence. No shutdown fixture exists merely because checks appear in source. |

**Other acceptance requirements remain open:**

| Requirements | Remaining work not discharged by these lifecycle additions |
|---|---|
| AT-01 through AT-07 | Rejection-before-lock/work accounting; zero-bucket inconsistency; explicit 63-live and mixed retained/live collision cases; exact physical-node/ref/allocation/mutation/cleanup instrumentation; retirement/unlink and debug/ref/lock profile proof. Existing real-container fixtures remain unexecuted. |
| AT-08, QO-01 through QO-05 | Exact 17-acquisition and bounded visitor-work accounting; no backend/device/file/DB effects; full policy alias/unknown-bit/timer cases; total inventory/expected-target comparisons; actual handler/adapter and loaded-versus-disk/isolation evidence. |
| QO-06 | Strict 8 KiB host parser and new custom capability/binding, malformed/truncated/extra-stdout/unknown-field/error-exit negatives and stock regressions. None is enabled by the native source package. |
| AT-10, QO-07 | Immutable build/dependency/archive closure, licenses, configure/menuselect/module manifest, full compatible runtime, native tests, affected upstream regressions and profile/image/startup provenance. |
| QO-08 | Separately approved Gate C unique two-customer custom-runtime proof; no substitution with private fixtures or prior stock-runtime proofs. |
| QO-09, QO-10 | Outage/restart/concurrent-read/object-change/receipt-write uncertainty preservation, stock/custom regressions and owned-resource cleanup evidence. No executor or verified publication pointer is added. |

**Next bounded source priority:** extend the existing AO2 fixture matrix for
the explicit 63-live-object and mixed retained/live physical-node boundaries,
with exact expected visitor/destructor counts. Reuse actual owner containers
and existing fixtures; do not add caller-side private-layout mutation or treat
these assertions as runtime work-accounting evidence. This is still within
the approved source-only boundary. After that, remaining shutdown, output and
ref/work instrumentation require a concrete safe fixture design; obtain a
scope decision before changing any source path or production behavior beyond
the existing approval. More definitions alone cannot clear A's verified exit.

**Build handoff remains a separate decision, not the next automatic command:**

1. Select and verify immutable builder/runtime digests and architecture,
   package snapshot with exact versions/hashes, third-party source archive
   hashes and license/source obligations. Version strings and the prior stock
   runtime digest are not a source/toolchain closure.
2. Pin configure/menuselect/module and test/release profile manifests, the
   transitive runtime dependency/startup chain and exact no-unrecorded-fetch
   commands. Distinguish instrumented test artifacts from release artifacts.
3. Present enforceable CPU/memory/storage/time/PID/log/network limits, cleanup
   ownership and stop behavior before approval. The old 2 CPU/2 GiB/20 GiB/
   30-minute proposal is neither measured sufficiency nor approved capacity;
   account for the 65,536-member fixture and debug/ref logging.
4. Obtain explicit Gate B approval for that closed environment before any
   dependency installation, compilation or native test. If storage or another
   required cap cannot be enforced, stop rather than silently weakening it.
5. Retain actual command/results/hashes and native/regression/profile evidence
   before claiming A's verified exit. Only a separate Gate C decision can then
   authorize the owned two-PBX proof; neither stage enables stock fallback,
   automatic binding promotion or publication authority.

The preceding source candidate recorded twelve package passes, seven exact
preimages/application dry run and all nine independent postimages. Those
results are not rerun or promoted by this documentation-only reconciliation.
Documentation links/whitespace and unchanged patch/manifest are checked.
No dependency install, native build/test, image build, module load or PBX
operation occurs. All AT/QO gates, A's verified exit, Gates B/C, exact
publication, full CP and M1-09 remain open.

##### Gate A mixed AO2 nodes: twenty-nine definitions, still unexecuted

The next bounded source task identified in the preceding handoff is now
defined as `bounded_mixed_nodes`. The same nine-path package contains **29
uncompiled/unexecuted native definitions**. Only the existing native controller
fixture changes; all eight other source postimages are unchanged.

The fixture uses a real mutex-protected one-bucket AO2 list, default tail
insertion, and the existing owned-object destructor/borrowed-visitor helpers.
For each retained-empty node it links an object, advances a fresh iterator
until that exact object is returned, unlinks it and releases both object
references while retaining the iterator's physical node. It then appends a
live object. Scanned temporary live-object references are released during
fixture construction. No private layout, forged object count, caller pointer
mutation or production traversal change is introduced.

This creates an interleaved empty/live collision chain with these exact
source assertions:

| Physical chain | Node budget | Expected traversal | Live visits |
|---|---|---|---|
| 64 retained-empty + 63 live = 127 nodes | 128 | Complete; one bucket, 127 nodes | 63 |
| 64 retained-empty + 64 live = 128 nodes | 127 | Limit; one bucket, 127 nodes; last live node not visited | 63 |
| Same 128-node chain | 128 | Complete; one bucket, 128 nodes | 64 |
| 65 retained-empty + 64 live = 129 nodes | 128 | Limit; one bucket, 128 nodes, despite every live object having been visited | 64 |

The final case explicitly rejects a live-count shortcut: reaching all 64 live
objects does not justify completion when physical traversal has not reached
the end. Every measured walk uses the real bounded owner API. The visitor
requires each borrowed live object to have reference count one. Container
counts, exact visited-object counts and unchanged destructor totals are
checked around each walk. Final cleanup destroys every initialized iterator
before releasing the container and requires all 129 allocated object
destructors exactly once on the complete fixture path. Allocation/link failures
also drain initialized storage and compare total allocations/destructions.
Iterator-held container references are intentional fixture ownership, not a
claim that the container has a sole reference during traversal.

These assertions address the previously missing explicit 63-live and mixed
retained/live source cases in AT-04/AT-05/AT-07. They do not establish native
node-dereference/allocator/comparator/hash/lock/ref-work instrumentation,
retirement concurrency or debug-profile behavior. Fixture construction and
teardown may scan; they are not inside the production bounded walk or covered
by its budget. All native acceptance/AT/QO gates remain open.

**Twelve package tests pass**, with JavaScript syntax, whitespace and added
documentation links checked. Seven exact preimages/application dry run and
all nine independently applied postimages match. No core/header source changes
need a new profile-off lexical comparison; this is not native compilation.
Both named scratch directories are removed after verification. No dependency
install, native build/test, image build, module load or PBX operation occurred.
A's verified exit, Gates B/C, exact publication, full CP and M1-09 remain open.

##### Gate A mixed-node abort and recovery: inventory unchanged, still unexecuted

The existing `bounded_mixed_nodes` definition now includes **seven additional
walk assertions**, not seven new test definitions. The inventory stays at
**29 uncompiled/unexecuted native definitions** on the same nine paths.
Only the native controller postimage changes; all eight other source
postimages remain byte-for-byte unchanged.

On the actual 129-node mixed chain, the existing visitor aborts at live
positions **1, 32, 63 and 64**. Each source assertion requires `ABORTED` in
both the API return and result status, one bucket, the exact live count and
**2, 64, 126 and 128 physical nodes**, respectively. These positions include
every preceding retained-empty node. The final-live abort remains `ABORTED`,
not `LIMIT` or `COMPLETE`, even though an unvisited trailing retained-empty
node remains. Every case checks borrowed reference count one, unchanged
65-object destructor total and unchanged 64-live container count.

The fixture then releases only the last iterator holding the trailing empty
node. A walk must recover from the preceding physical-node limit to
`COMPLETE` with **128 nodes/64 live objects**, without relinking objects or
changing budgets. Next it releases the other 64 retained-empty-node iterators.
The same container must limit at **63 nodes/63 visits** with a 63-node budget,
then complete at **64 nodes/64 visits** with a 64-node budget. Both return and
result statuses, one bucket, unchanged live/destructor totals and now-sole
container reference are checked. Released iterator slots are removed from
the initialized count before common cleanup, preventing double destruction.
Final container cleanup still requires all 129 allocated objects destroyed.

This extends AT-04/AT-05/AT-06/AT-07 source assertions for early exits and
retained-node removal recovery. It does not prove concurrent unlink/retirement,
exact internal ref/allocator/lock work or debug-profile behavior. Fixture
iterator destruction is intentionally outside the measured bounded walks.
All native acceptance and AT/QO gates remain open.

**Twelve package tests pass**, with JavaScript syntax, whitespace and added
documentation links checked. Seven exact preimages/application dry run and
all nine independently applied postimages match. No core/header postimage
changes need a new profile-off lexical comparison; no compilation is implied.
Both named scratch directories are removed after verification. No dependency
install, native build/test, image build, module load or PBX operation occurred.
A's verified exit, Gates B/C, exact publication, full CP and M1-09 remain open.

##### Gate A mixed-node failure paths: inventory unchanged, still unexecuted

Five additional walk assertions extend `bounded_mixed_nodes`; the inventory
remains **29 uncompiled/unexecuted native definitions** on the same nine paths.
Only the controller postimage changes. The shared owned-object visitor gains
an optional invalid-return position; zero-initialized existing callers retain
their previous behavior.

On the real 129-physical-node/64-live mixed chain:

- An object budget of 63 must return/result `LIMIT` before traversal: zero
  buckets, nodes, objects and visitor calls. This does not mean no container
  lock was acquired; preflight reads the live count under that lock.
- Restoring the object budget to 64, invalid visitor returns at live positions
  **1/32/64** must return/result `INTERNAL`, with one bucket and exactly
  **2/64/128 physical nodes**, respectively. All preceding empty nodes count.
  The visitor checks borrowed reference count one before returning invalid.
- A subsequent normal visitor must again reach the physical-node limit at
  **128 nodes/64 visits**, not inherit an error, report complete or mutate
  the chain. Existing abort and retained-node-release recovery walks follow.

Each new walk requires unchanged 64-live container count and 65 completed
object destructors; final cleanup still requires all 129 allocated objects
destroyed. These are source assertions for AT-01/AT-05/AT-06/AT-07, not native
failure-path, lock/ref/allocator accounting or concurrency evidence.

**Twelve package tests pass**, with JavaScript syntax, whitespace and added
documentation links checked. Seven exact preimages/application dry run and
all nine independently applied postimages match; the other eight postimages
are unchanged. Both named scratch directories are removed after verification.
No dependency install, native compile/test, image build, module load or PBX
operation occurred. A's verified exit, all AT/QO gates, Gates B/C, exact
publication, full CP and M1-09 remain open.

##### Gate A owner callback work: thirty definitions, still unexecuted

`bounded_callback_work` adds eight walk schedules in one new definition.
The inventory is **30 uncompiled/unexecuted native definitions** on the same
nine source paths. Only the controller fixture postimage changes; production
AO2, queue, CLI, loader, headers and separate target are unchanged.

The real sorted mutex-protected hash container has **53 buckets**, with all
64 distinct keyed objects deliberately hashing to bucket zero. Dedicated
fixture hash, sort and comparison callbacks increment object-owned counters;
the destructor increments its own count. Reverse-key insertion exercises
sorting. A successful ordinary `ao2_find` for key 32 calibrates the lookup
path, and its returned object reference is released before measured walks.
Every callback counter must be nonzero before its baseline is captured,
preventing an unwired zero counter from passing. The pinned container owner
source confirms ordinary find uses its configured comparison callback.

The eight real bounded walks require:

| Schedule | Expected status | Buckets | Nodes/live visits |
|---|---|---|---|
| Full walk | Complete | 53 | 64 |
| Node budget 63 | Limit | 1 | 63 |
| Object budget 63 | Limit before traversal | 0 | 0 |
| Abort at first/middle/final live object | Aborted | 1 each | 1/32/64 |
| Invalid return at live 32 | Internal | 1 | 32 |
| Normal recovery walk | Complete | 53 | 64 |

Each walk checks API return and result status, exact bucket/node/object/
visitor counts, borrowed reference count one, unchanged 64-live container
count and sole container reference. **Hash, sort and comparison counters must
remain exactly at their calibrated baselines**, with no object destructor
during measured traversal. Final cleanup requires one destructor per allocated
object, 64 on the complete fixture path. Setup/find/cleanup are not included
in the bounded-walk callback claim.

This narrows the AT-05 callback-work source gap and complements existing
ownership/error/abort fixtures. It does not instrument every allocator,
internal ref/mutation/lock operation, prove native no-I/O behavior, establish
concurrent retirement or clear debug/ref/profile acceptance. Counts are source
assertions until the actual compiled test executes. All AT/QO gates stay open.

**Twelve package tests pass**, with JavaScript syntax, whitespace and added
documentation links checked. Seven exact preimages/application dry run and
all nine independently applied postimages match; the other eight postimages
are unchanged. Both named scratch directories and the pinned public
container-owner review download are removed after verification. No dependency
install, native compile/test, image build, module load or PBX operation occurs.
A's verified exit, Gates B/C, exact publication, full CP and M1-09 remain open.

##### Gate A sparse bucket accounting: inventory unchanged, still unexecuted

The existing `bounded_callback_work` definition now runs its eight-case matrix
with collision chains in buckets **0, 26 and 52** of real sorted 53-bucket
containers. This makes **24 walk schedules**, not 24 test definitions; the
inventory remains **30 uncompiled/unexecuted native definitions** on the same
nine paths. Only the controller fixture postimage changes.

The original calibrated setup/walk/cleanup is extracted into a private fixture
helper with an explicit collision-bucket input. Each independently allocated
container retains 64 reverse-inserted keyed objects, a successful ordinary
find, positive hash/sort/comparison calibration and exact destructor cleanup.
The fixture hash returns the selected bucket; no internal bucket pointer or
private container layout is manipulated.

Complete/recovery walks must charge all **53 buckets**, regardless of where
the objects are. Object-budget preflight rejection must charge **zero buckets**.
Node-budget limits, first/middle/final aborts and invalid visitor returns must
charge **1, 27 or 53 buckets**, including every preceding empty bucket.
Their existing exact node/object/visitor counts remain unchanged. Every walk
still requires no hash/sort/comparison callback increments, no destructor,
borrowed reference count one, unchanged live count and sole container reference.
Case failures now report both collision bucket and matrix index.

This narrows AT-03/AT-05 source assertions for sparse traversal, but does not
instrument every internal bucket step, establish native bounded latency or
clear debug/ref/lock/concurrency acceptance. Setup/find/cleanup remain outside
the measured bounded walks. All AT/QO/native gates remain open.

**Twelve package tests pass**, with JavaScript syntax, whitespace and added
documentation links checked. Seven exact preimages/application dry run and
all nine independently applied postimages match; the other eight postimages
are unchanged. Both named scratch directories are removed after verification.
No dependency install, native compile/test, image build, module load or PBX
operation occurs. A's verified exit, Gates B/C, exact publication, full CP and
M1-09 remain open.

##### Gate A distributed hard ceilings: inventory unchanged, still unexecuted

The existing `bounded_callback_work` definition now adds a fourth real
container layout: **64 distinct live objects, one in each of 64 buckets**.
The fixture hash returns each object's key rather than a shared collision
bucket for this layout. The inventory remains **30 uncompiled/unexecuted
native definitions**, now with **33 walk schedules** inside this definition:
the preceding 24 sparse-collision walks and nine distributed walks.
Only the controller postimage changes within the same nine approved paths.

The distributed fixture retains positive ordinary find/hash/sort/comparison
calibration, reverse-key construction and exact destructor/reference checks.
It first requires a **63-bucket budget** to return/result `LIMIT` before
traversal, with zero bucket/node/object/visitor counts. The regular eight-case
matrix then runs with the allowed 64-bucket budget:

| Schedule | Expected status | Buckets | Nodes/live visits |
|---|---|---|---|
| Full/recovery walk | Complete | 64 | 64 |
| Node budget 63 | Limit | 64 | 63 |
| Object budget 63 | Limit before traversal | 0 | 0 |
| Abort at live 1/32/64 | Aborted | 1/32/64 | 1/32/64 |
| Invalid return at live 32 | Internal | 32 | 32 |

The node-budget case deliberately expects **64 buckets but 63 nodes**:
the owner enters the final bucket, then refuses its first physical node
before dereferencing it. Charging only the visited objects' buckets would
under-report that traversal. Full walks hit the bucket and live-object hard
ceilings simultaneously. Every schedule requires callback counters unchanged
from their nonzero baselines, borrowed reference count one, unchanged 64-live
container count, sole container reference and zero destructors until cleanup.
The failure diagnostic identifies whether the layout was distributed.

These are additional AT-03/AT-05/AT-06/AT-07 source assertions, not native
execution, exhaustive work/ref instrumentation or concurrency/profile proof.
All AT/QO acceptance gates remain open.

**Twelve package tests pass**, with JavaScript syntax, whitespace and added
documentation links checked. Seven exact preimages/application dry run and
all nine independently applied postimages match; the other eight postimages
are unchanged. Both named scratch directories are removed after verification.
No dependency install, native compile/test, image build, module load or PBX
operation occurs. A's verified exit, Gates B/C, exact publication, full CP and
M1-09 remain open.

##### Gate A independent lock-exit probes: inventory unchanged, still unexecuted

Every successful assertion in the mixed-node fixture's **16 walks** and the
callback-work fixture's **33 walks** now starts a separate lock-probe thread
before the next fixture action. The inventory remains **30 uncompiled/
unexecuted native definitions**; only the existing controller postimage changes
within the same nine-path package.

The private probe performs one `ao2_trylock` on the **actual measured
container**, and unlocks only if acquisition succeeded. The controller joins
that thread and requires both acquisition and unlock success; thread-creation
failure or either lock error is explicitly reported. No sleeping, repeated
polling, blocking container acquisition, replacement mutex or caller-side
unlock is used to make the assertion pass. The container and stack-owned
probe state remain alive until join.

This addresses a limitation of same-thread recovery: AO2 mutexes may be
recursive, so another walk on the original thread could succeed despite an
unbalanced held lock. A foreign thread must instead acquire the mutex before
each asserted exit is considered clean. On the full fixture path this
specifies **49 independent acquisition/unlock probes**, spanning completion,
object/bucket/node limits, abort and invalid-visitor outcomes, mixed retained
nodes and release recovery, sparse collision chains and distributed buckets.
Probes occur after bounded traversal returns, outside its work budget.

These assertions narrow AT-02/AT-06/AT-07 lock-cleanup source gaps; they do not
count all internal lock attempts, cover lock-wrapper failures, prove no other
lock is leaked, or establish native latency/profile/concurrency behavior.
The existing cross-thread busy-container fixture is unchanged. A lock safety
regression can still make later cleanup hang, so separately approved serialized
disposable execution and an external watchdog/resource cap remain mandatory.
All native/AT/QO acceptance remains open.

**Twelve package tests pass**, with JavaScript syntax, whitespace and added
documentation links checked. Seven exact preimages/application dry run and
all nine independently applied postimages match; the other eight postimages
are unchanged. Both named scratch directories are removed after verification.
No dependency install, native compile/test, image build, module load or PBX
operation occurs. A's verified exit, Gates B/C, exact publication, full CP and
M1-09 remain open.

##### Gate B preparation started: resource probe, not compilation

The user requested moving from source test definitions toward actual building,
selected **custom Asterisk build/native-test preparation (Gate B)** and retained
the **2 CPU / 2 GiB RAM / 20 GiB incremental storage / 30-minute** proposal.
This authorizes preparation, not an unspecified dependency installer or build.
The subsequent isolated shell-only resource-probe form was accepted with its
default approval; no PBX or native-test execution was requested by that probe.
The [preparation record](./local/asterisk-patches/build-preparation.json) is
separate from the unchanged source-candidate manifest and is explicitly blocked,
not a complete dependency/build manifest or permission to compile.

Read-only inspection found Docker Desktop's Linux/amd64 engine 29.6.2,
cgroup v2 and the containerd `overlayfs` snapshotter. A uniquely named
create-only probe accepted `--storage-opt size=20G`, 2 CPUs, 2 GiB memory,
zero swap and 128 PIDs; it was removed without starting. A second uniquely
owned shell-only probe used the cached digest-pinned stock image, no network,
no shared mounts/ports, all capabilities dropped, no-new-privileges and
disabled container logging. Its host watchdog was 120 seconds. It started
only a shell, read cgroup/filesystem limits, wrote/deleted exactly 64 MiB
and exited successfully in less than one second. The container and named
temporary stdout/stderr files were removed. Asterisk was not started.

Observed live limits were `cpu.max = 200000 100000`,
`memory.max = 2147483648`, `memory.swap.max = 0` and `pids.max = 128`.
The watchdog did not expire; its forced-stop path is not tested by this
successful short probe. These observations verify configured cgroup limits,
not that compilation or the 65,536-member fixture fits the budget.

**Storage remains a blocking prerequisite.** The engine retained the size
option, but root `df` reported 1,055,762,868 KiB (roughly 1 TiB), not a bounded
20 GiB filesystem, and no quota inspection utility was present. This does not
prove the quota is ignored; it also does not demonstrate an enforced quota.
No 20 GiB fill was attempted. A root-layer option alone would not bound host
downloads, image pulls/build caches, bind mounts, artifact exports or logs.
Do not use host free-space sampling, a size estimate or the accepted option
as a substitute for a hard aggregate incremental-storage cap.

Next preparation must establish a verified quota-backed storage boundary
without changing shared daemon settings or allocating a large disk silently,
then select exact builder/runtime digests, package/archive checksum closure,
license obligations, configure/menuselect/modules and test/release profiles.
The existing diagnostic Dockerfile uses unversioned `apt-get update/install`
and is not an approved reproducible native builder. Preserve the explicit
runtime module list, including PJSIP/SRTP/queue/CEL/media dependencies; compiling
only the getter module is not an ABI-compatible runtime deliverable.

The completed manifest, exact commands, enforceable aggregate resource limits
and cleanup plan still require explicit Gate B approval before installation
or compilation. If storage enforcement needs a dedicated disk/host or broader
privilege, obtain a decision first. Gate C remains separately closed. No image
pull/build, dependency installation, native compile/test or PBX operation
occurred. The source patch/manifest remain unchanged; documentation links,
JSON shape/source binding and whitespace are checked, not native tests.

##### Dedicated WSL build environment proposal

The user selected preparation of a **new dedicated WSL distribution without
changing shared WSL settings**. Read-only investigation found WSL 2.7.3.0
with kernel 6.6.114.1-1. Installed CLI help supports per-install `--name`,
`--location`, `--from-file`, `--version`, `--vhd-size` and `--no-launch`.
No distribution was installed or started during this investigation.

This is a dedicated filesystem/process environment, **not a separate VM**.
Microsoft documents `.wslconfig` resource settings as global across WSL2
distributions. Do not change that file, resize an existing distribution,
enable shared Docker integration, or run `wsl --shutdown` to implement this
proposal. The running Docker Desktop environment and all existing Linux
distributions remain untouched.

The [environment proposal](./local/asterisk-patches/build-preparation.json)
pins Microsoft's distribution manifest at commit
`341f1ddf76f089ff6351590b03f92bad30041725`, the Ubuntu 24.04 amd64 image URL
and SHA256 `bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e`.
A HEAD request returned HTTP 200 and content length 388,975,696 bytes.
No image body was downloaded or hashed; the checksum is the official
manifest's expected value, not a locally verified payload.

Proposed installation, **not yet authorized or executed**, after a bounded
download and successful SHA256 verification:

```powershell
wsl.exe --install --from-file "C:\Users\james\AppData\Local\AsteriskNativeBuild\gate-b-f51968c\ubuntu-24.04.5-wsl-amd64.wsl" --name Asterisk-GateB-f51968c --location "C:\Users\james\AppData\Local\AsteriskNativeBuild\gate-b-f51968c\distro" --version 2 --vhd-size 18GB --no-launch
```

Refuse name/path collisions before provisioning. The proposed guest disk is
18 GiB, leaving 2 GiB of the selected budget for installer/staging/metadata;
the installer must have a streaming 512 MiB maximum, host logs a 16 MiB
maximum, and no host artifact exports are proposed. All package downloads,
sources, outputs and build logs belong inside the new disk. **This allocation
is a design, not proof of an aggregate hard cap**: VHDX metadata, WSL-managed
host writes and shared-VM overhead still need a bounded accounting strategy.
Do not equate a guest capacity with a hard total host-storage limit.

Before any build, configure and verify only the new distribution: disable
Windows-drive automount, fstab mounting, Windows interop and Windows PATH
injection; enable systemd if supported. Configuration only takes effect
after the applicable distribution restart; a first bootstrap launch must
not be represented as already having these protections. Use only targeted
termination of the owned distribution if needed.

An unprivileged build service is proposed with `CPUQuota=200%`,
`MemoryMax=2147483648`, `MemorySwapMax=0`, `TasksMax=128`,
`RuntimeMaxSec=1800`, `KillMode=control-group` and `SendSIGKILL=yes`.
Controller availability and actual limits require live verification;
exercise watchdog termination and a small disposable full-filesystem probe.
These service properties do not cap bootstrap, system services or the
shared WSL VM. Resolve that budget scope explicitly rather than silently
claiming whole-environment enforcement.

Provisioning approval is still required for download, new disk/distribution,
configuration and resource probes. The full compiler/package/runtime closure
and subsequent Gate B build approval remain separate outstanding work.
If WSL cannot enforce the selected budget without shared settings changes,
stop and obtain an environment decision. Preserve a failed owned environment
for explicit cleanup approval rather than automatically unregistering a
distribution or deleting its disk.

References: [Microsoft WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config),
[distribution format and custom names](https://learn.microsoft.com/en-us/windows/wsl/build-custom-distro),
and [disk capacity management](https://learn.microsoft.com/en-us/windows/wsl/disk-space).

##### Dedicated WSL environment provisioned and verified

The user explicitly allowed increased limits as needed to compile properly.
The subsequent form approved the concrete download/new-distribution/configuration
and resource-verification step with **4 CPU-equivalents, 4 GiB RAM, zero
build-process swap, 256 tasks, a 40 GiB guest disk and a proposed 60-minute
build watchdog**. Shared WSL/Windows overhead was explicitly disclosed outside
those process limits. This supersedes the earlier 20 GiB aggregate-storage
blocker; it is not a claim that WSL now enforces a total host budget.

Completed provisioning:

- Streamed exactly 388,975,696 image bytes with a 512 MiB payload cap and
  ten-minute cancellation deadline, verified the pinned official SHA256,
  and refused existing distribution/staging-path collisions.
- Installed only `Asterisk-GateB-f51968c` from that local image with
  `--vhd-size 40GB --no-launch`. The initial distribution was stopped.
  The installer and disk remain in the proposed Windows staging directory.
- Applied the repository's [WSL configuration](./local/asterisk-build/wsl.conf)
  through an explicit root bootstrap, then terminated/restarted only the
  owned distribution. Systemd is active, Windows-drive automount/fstab and
  Windows interop/PATH injection are disabled. This does not make WSL a
  separate VM or a security boundary against the Windows host.
- Ran the one-shot [environment verification script](./local/asterisk-build/verify-environment.sh).
  The disk block device is exactly 42,949,672,960 bytes; usable ext4 capacity
  is smaller (41,956,900,864 bytes) due to filesystem overhead. A separate
  64 MiB loop-backed ext4 fixture rejected a bounded 80 MiB write attempt
  with ENOSPC; it was unmounted, detached and removed. The full guest disk
  was not filled.
- Verified the unprivileged `asterisk-build` service's live
  `cpu.max=400000 100000`, `memory.max=4294967296`,
  `memory.swap.max=0` and `pids.max=256`. The successful short probe used a
  60-second watchdog; the eventual build must explicitly set 3,600 seconds.
- A separate two-second runtime watchdog terminated a 30-second sleep,
  reported `Result=timeout` and left `MainPID=0`. Termination used SIGTERM;
  escalation to SIGKILL was configured but not exercised.

The initial mount assertion rejected WSL's `/usr/lib/wsl/drivers` read-only
9p mount. Inspection confirmed it is not a mounted Windows drive. The check
now permits only that exact read-only driver source/target and rejects other
9p/Windows-drive mounts; the corrected probe passed. This allowance is
explicit, not a claim that no host-provided resources exist.

The new environment's generated package baseline contains 523 rows, SHA256
`a2627305d859bc2c20c48365244040ead2e0c68e340d78d3f8be3d6b58301406`,
stored inside the guest at
`/home/asterisk-build/environment-baseline/packages.tsv`. Neither GCC nor
make is installed. No apt refresh/dependency installation, native compilation,
native test or Asterisk execution occurred.

At stop, the VHDX host length was 1,480,589,312 bytes, installer length
388,975,696 bytes, and install stdout/stderr logs were 406/0 bytes. These
are observations, not enforced host-log/aggregate-storage limits. The proposed
16 MiB host-log cap still needs bounded handling for the actual build.
Only the newly owned distribution was stopped after verification; no global
WSL shutdown, shared settings change or modification of an existing
distribution was performed.

The verification script is intentionally a **one-shot provisioning check**:
it refuses an existing build account rather than silently adopting one.
Do not rerun it against the provisioned environment as a generic health check.
The [preparation record](./local/asterisk-patches/build-preparation.json)
preserves original/revised budgets and observed evidence. Next complete the
exact package/source/runtime/profile closure and present actual installation
and build commands for approval. Provisioning success is not native acceptance
or permission to operate a PBX; Gate C remains closed.

##### First native build: both profiles compiled, no runtime yet

The user approved signed snapshot-index resolution, bounded source staging,
then the explicit locked package installation and both native compile
profiles. Native execution was expressly excluded from that approval.
This is the first actual custom Asterisk compilation, not another source-only
test-definition increment.

The [package resolver](./local/asterisk-build/resolve-packages.sh) used isolated
APT configuration/list/cache paths in the new WSL builder, Ubuntu snapshot
`20261024T000000Z`, Ubuntu archive signature verification, and no system APT
source changes. Expiry checks are disabled only for that immutable historical
snapshot; signatures and archive hashes remain mandatory. Resolution changed
no packages. Its [dependency lock](./local/asterisk-build/dependency-lock.json)
pins 89 package changes and 104,325,594 archive bytes, with versions, URLs,
SHA256 hashes and index-file hashes. This includes explicit upgrades of
existing libc/OpenSSL/SQLite/XML/curl dependencies in the disposable builder.

The approved [installer](./local/asterisk-build/install-locked-packages.py)
requires the exact lock hash and unchanged installed baseline, streams each
package with its locked length/SHA256, then installs exact package versions
with `--no-download --no-remove --no-install-recommends`. All 89 installed
versions verified. Installed baseline SHA256 is
`5fe9798fef7f0231f2765cee933c300ef079318c78971dee9665fd57cb9b0aae`.
Installation took 64.556 seconds; its guest log was 32,215 bytes. No packages
were installed into Windows or an existing distribution.

The [source staging helper](./local/asterisk-build/stage-sources.py) downloaded
the commit-addressed Asterisk archive (8,907,184 bytes) and immutable-mirror
PJPROJECT 2.17 archive (8,975,382 bytes), each bounded to 64 MiB.
The [source lock](./local/asterisk-build/source-lock.json) pins their SHA256
hashes and revisions. PJPROJECT additionally matches the MD5 recorded in
the pinned Asterisk source; SHA256, not MD5 alone, binds subsequent builds.
The Asterisk archive expands under a 512 MiB declared-size ceiling using
Python's data extraction filter.

The [source inspector](./local/asterisk-build/inspect-source.py) verified
seven pristine hashes and two absent new files, found all 41 configured
runtime modules, and followed hard module dependencies into the
[module plan](./local/asterisk-build/module-plan.json). Configure and
menuselect subsequently verified dependency availability. Jansson is the
snapshot's system 2.14 package; PJPROJECT is the staged bundled 2.17 source.
Bundled Jansson/libjwt, XML documentation and all sound packages are disabled.

The [compile recipe](./local/asterisk-build/compile-profiles.py) creates fresh
attempt/profile directories, applies the exact patch with zero fuzz, checks
all nine postimages, configures separate prefixes, selects only required
modules and verifies exact untruncated menuselect names. Instrumented mode
uses `--enable-dev-mode` and `TEST_FRAMEWORK`; release excludes the test
framework and both test modules. Both disable `BUILD_NATIVE`. Builds use
`make -j4 all`, not runtime installation, sound fetching or service startup.

Actual compilation ran as `asterisk-build` in a systemd transient service:
`CPUQuota=400%`, `MemoryMax=4294967296`, `MemorySwapMax=0`, `TasksMax=256`,
`RuntimeMaxSec=3600`, `KillMode=control-group`, `SendSIGKILL=yes`,
`PrivateNetwork=yes`, `NoNewPrivileges=yes`. The package-install service
used a separate 1,200-second deadline and network for approved package URLs.
Shared WSL/Windows overhead remains outside these process limits.
The [log wrapper](./local/asterisk-build/run-logged.py) caps each guest command
log at exactly 16 MiB, terminates the command group on overflow and propagates
failure. Four direct tests passed: success, exit-code propagation, exact
32-byte overflow fixture and refusal to overwrite a log. No native binaries
were exported to Windows; only JSON evidence was copied into the repository.

Two failed attempts are retained honestly:

1. A recipe check misread `--list-options` output, which truncates names at
   30 characters. It now uses full-name `--list-category` output.
2. GCC rejected `(!row.callers != row.caller_list_empty)` with
   `-Werror=logical-not-parentheses`. The source now uses
   `((!row.callers) != row.caller_list_empty)`, preserving the boolean
   comparison. No warning was suppressed. The getter postimage, Git blob
   header and patch checksum were regenerated; the other eight postimages
   remain unchanged. A package regression assertion protects the expression.

The successful third attempt took **171.851 seconds**, log 100,417 bytes.
Patch SHA256 is
`ede18f89a22f717411a6f5dfbb1e6e81db0834245d32fd5b378e19ec308a17f0`.
The [compile report](./local/asterisk-build/compile-report.json) records:

| Profile | Core | Core support libraries | Runtime modules | Test modules | Total verified ELF outputs |
| --- | --- | --- | --- | --- | --- |
| Instrumented | 1 | 2 | 41 | 2 | 46 |
| Release | 1 | 2 | 41 | 0 | 44 |

Both profiles require `libasteriskpj.so` and `libasteriskssl.so`; these are
included in the report, not mistaken for unexpected runtime modules.
Independent reads rechecked all 90 output hashes and ELF64/x86-64 headers,
the exact `.so` sets, and `ast_test_register` being defined only in the
instrumented core. A first evidence check omitted the two core support
libraries; the report/recipe were corrected and the full check passed.
Compile report SHA256 is
`5c0de49e485aadd29215419210917f0fa1dda3681077d40321fb77c6b5e8f881`.

Outputs remain in the guest under
`/home/asterisk-build/native-build-attempt-3/{instrumented,release}` (about
1,003 MiB combined). Source staging and earlier failed attempts remain for
reproduction/failure evidence; the newly owned distribution was stopped.
The [execution record](./local/asterisk-patches/build-preparation.json)
distinguishes compilation success from unexecuted native tests.
The source-candidate manifest/validator deliberately remain integrity-only
and cannot promote their own output to compilation/runtime success; consult
the separate hash-bound compile report for actual native evidence.

**No Asterisk binary was launched, module loaded, native test run or existing
PBX operated.** All 30 test definitions are now compiled but unexecuted.
This does not complete AT/QO acceptance, runtime shared-library verification,
regression coverage or a deployable/redistributable release image. Retain
source/license/copyright material and satisfy dependency source obligations
before any redistribution; no image/export was produced here.

Next obtain explicit approval for a disposable instrumented runtime:
autoload off, no SIP/AMI/ARI/public ports, explicit controller loading,
separate target excluded from autoload, serialized inventory, external
watchdog, bounded logs and owned-resource cleanup. Run native tests and
investigate real failures before claiming Gate A exit. Shutdown/output/
recursive teardown/AO2 instrumentation obligations and Gate C remain open.

##### First native test batch: thirty of thirty pass

The user explicitly approved disposable startup and all 30 serialized native
definitions. The [runner](./local/asterisk-build/run-native-tests.py) verified
every instrumented output against the compile report before execution and
derived exact category/name mappings from the compiled source, requiring
an exact match to the source manifest inventory.

Batch 1 completed successfully: **30 passed, zero failed**, 31.066 seconds.
The [native report](./local/asterisk-build/native-test-report.json) binds
the result to patch SHA256
`ede18f89a22f717411a6f5dfbb1e6e81db0834245d32fd5b378e19ec308a17f0`
and compile-report SHA256
`5c0de49e485aadd29215419210917f0fa1dda3681077d40321fb77c6b5e8f881`.
The native report SHA256 is
`63bbaa625d4664e9930eef8e02e90ffe9f7aee2ef67d7bbed48023dd43e2086e`.
The [aggregate XML](./local/asterisk-build/native-test-results.xml) contains
exactly the 30 executed test cases copied from the original XML reports,
with no skipped/failure/error elements; its SHA256 is
`a2658fd4847b31fd15014f77d7238bfa4d527728524f2d62985be0dc5c55451a`.

Each definition ran in a **fresh Asterisk process** with private configuration,
data/AstDB/spool/log/run directories. Startup `modules.conf` used autoload off,
`require=app_queue.so` and `require=test_bounded_queue_policy.so`; all other
modules stayed unloaded unless a fixture explicitly loaded its disposable
target. The runner checked the target was absent at startup for every test.
No SIP channel driver was loaded; manager/HTTP were disabled and no existing
PBX configuration or process was adopted.

The service ran as the unprivileged build user with 4 CPU-equivalents,
4 GiB memory, zero process swap, 256 tasks, private networking,
no-new-privileges, core dumps disabled and a 1,800-second external watchdog.
Each execute CLI command had a 120-second timeout. Console output had a
2 MiB per-process cap; all 30 console logs totalled 76,412 bytes. The bounded
batch log was 1,326 bytes. A short runtime-control CLI timeout is separate
from each test deadline. None expired in this run.

After each execute, the runner generated XML and required exactly one case
with the requested name, marking actual XML failure elements as failures.
An independent read then verified all 30 original XML hashes, exact unique
inventory/order, no failure/error/skipped elements, no preloaded target,
and console size caps. After shutdown it checked no control sockets/PID files
or owned Asterisk processes remained. Only the newly owned WSL distribution
was stopped. Original per-definition logs/XML remain inside the guest under
`/home/asterisk-build/native-test-attempt-1`; JSON/XML evidence, not binaries
or runtime secrets, was copied to the repository.

Minimal fixture startup emits explicit missing-configuration warnings for
ccss/CDR/CEL/features/indications/ACL/UDPTL; logs retain these. These warnings
did not make tests pass by omission: each required module and named test
executed, and every XML case passed. However this is **not** production
configuration acceptance. Expected protected-reader unload-refusal warnings
also occur during the lifecycle fixtures and remain in console evidence.
No timing or resource peak from this short fixture batch should be represented
as production traffic capacity or complete whole-WSL-VM memory accounting.

This is the first real execution of the 30 definitions; it supersedes their
earlier uncompiled/unexecuted historical statuses. Source-package validation
still reports only integrity and deliberately cannot claim native execution;
the separate hash-bound native report is the execution authority.
The source manifest and compile report retain their original stage-local
flags rather than being rewritten to imply those earlier checks ran tests.

**Gate A verified exit is still not claimed.** Outstanding acceptance includes
shutdown/real exit ordering, recursive dependencies/teardown and startup/
reload failures, slow/disconnected/partial-output schedules, full AO2 internal
node/ref/allocator/lock/mutation/no-I/O instrumentation and retirement
concurrency, plus release-profile/full-regression and matching runtime
packaging. The stock inspector/custom parser/binding/publication authority
are unchanged. No deployment, image export, registry push or Gate C two-PBX
proof occurred. Future runtime changes must remain within explicitly approved
disposable scope; do not turn a passing fixture batch into production approval.

##### Release profile loaded-state smoke passed

The user explicitly approved isolated release smoke and fixture-only reload.
The [runner](./local/asterisk-build/smoke-release.py) verifies the 44 release
outputs against the unchanged compile report, resolves their dynamic-loader
dependencies in the builder, and hashes all 29 distinct resolved shared-library
paths. Custom support libraries must resolve from the release tree, never the
instrumented or stock core. This is a builder-host dependency observation,
not proof of a standalone packaged runtime or resolution of every module's
core-provided symbol at `dlopen` time.

The disposable unprivileged process used only `app_queue.so`, autoload off,
no SIP drivers, disabled manager/HTTP, private networking and the established
4-CPU/4-GiB/zero-swap/256-task limits. An external five-minute watchdog and
bounded 16 MiB command/2 MiB console logs applied. The release test command
was absent. Private fixture queues included the namespace-selected queue,
`proof-queue`, and an unrelated queue which must not appear in the response.
Every response was exactly one bounded JSON line with the full expected
schema, sorted rows, masks, member/caller counts and policy values:

| Observation | Disk timeout/strategy | Observed loaded timeout/strategy |
| --- | --- | --- |
| Initial load | 11 / ringall | 11 / ringall |
| Disk edit without reload | 23 / linear | 11 / ringall |
| Fixture parameters reload | 23 / linear | 23 / linear |
| Disk restoration without reload | 11 / ringall | 23 / linear |
| Fixture restoration reload | 11 / ringall | 11 / ringall |

Two initial runner assumptions failed explicitly, without a false pass:
`ldd` calls dependency-free shared objects "statically linked"; that output
is now accepted only when `readelf` confirms no `NEEDED` entries. Separately,
the private-network remote CLI emits an EID warning before command output.
Rather than stripping warning lines or weakening JSON validation, this fixture
uses the Unix control protocol (`cli quit after` plus NUL), verifies the
greeting contains the owned server PID, and enforces a ten-second absolute
deadline and 8,192-byte response ceiling. This is test-only transport, not an
enabled custom host parser or publication executor. Server console warnings
remain in retained logs.

Attempts 3 and 4 passed. The published final run took 1.792 seconds, with a
566-byte command log and 1,873-byte console log. The process exited with code
zero. Independent verification rehashed all library files, checked the exact
five-stage transition and no remaining process/socket/PID file from any
attempt. The newly owned distribution was stopped; existing PBXs/settings
were not modified. The [release report](./local/asterisk-build/release-smoke-report.json)
SHA256 is `4d91fb167186b06780b2d29a7f1eac1cdab57b33f85b1a9b96abc5ea6f72d379`,
bound to the existing patch and compile-report hashes.

The [persisted-evidence regression suite](./tests/asterisk-native-build-evidence.test.mjs)
checks report/lock/source hash bindings, exact output/test inventory,
release policy transitions and unchanged deployment-authority flags.
All 17 combined source-package/evidence tests pass. These host-side evidence
checks do not rerun native tests or substitute for the recorded runtime smoke.

Only the queue module was actually loaded: full 41-module startup, SIP/media,
runtime-image construction, dependency/source-license redistribution closure,
remaining lifecycle/output/AO2 acceptance and Gate C are not claimed.
The 30-definition native batch and source patch remain unchanged.

##### Full runtime startup: restoring the upstream optional API default

The user approved an isolated all-41-module release startup and fixture checks.
The first run correctly failed: the original recipe's `menuselect --disable-all`
disabled not only unneeded modules but **upstream-default `OPTIONAL_API`**.
With that flag off, optional API providers become hard dependencies during
`dlopen`: PJSIP required absent geolocation/statsd, app_stack required AGI,
and MixMonitor required periodic-hook support. Unresolved PJSIP data symbols
were downstream failures because their exporting `res_pjsip` never loaded;
inspection confirmed they are correctly exported there, not missing from
the bundled PJPROJECT archive. No source or shared-library shim was needed.

The user then approved a corrected rebuild of both profiles and rerunning
all 30 native definitions plus queue-only/full-module release checks.
The [recipe](./local/asterisk-build/compile-profiles.py) now explicitly enables
`OPTIONAL_API` and verifies it survives menuselect. This restores supported
upstream behavior rather than dropping required modules or forcing additional
providers into the 41-module scope. No package or source-patch changes occurred.

Fresh build attempt 4 produced 46 instrumented and 44 release outputs.
The previous attempt-3 artifacts/reports remain unchanged historical evidence;
**the current candidate is build attempt 4**. Its
[compile report](./local/asterisk-build/compile-report-optional-api.json),
[native report](./local/asterisk-build/native-test-report-optional-api.json),
[native XML](./local/asterisk-build/native-test-results-optional-api.xml),
[queue-only smoke](./local/asterisk-build/release-smoke-report-optional-api.json)
and [full-module smoke](./local/asterisk-build/full-module-smoke-report.json)
are hash-bound by the [current validation record](./local/asterisk-build/full-startup-validation.json).
Do not combine older binary hashes with the new runtime results.

All 30 native definitions passed again in 31.115 seconds. The queue-only
release smoke passed in 1.688 seconds. Full-module smoke passed in 1.674
seconds: **all 41 exact configured module names reported Running**, with
PJSIP endpoint/transport queries both returning `No objects found.`.
The release test command remained absent. Both smoke modes passed all five
loaded-policy/disk-edit/reload/restoration observations.

The [shared smoke runner](./local/asterisk-build/smoke-release.py) supports
explicit full-startup approval and build-attempt selection. It waits for the
exact completed-boot response before reading module status; a control socket
existing is not sufficient readiness. It rejects missing, extra or non-Running
module rows. Config remains private: autoload off, all modules explicitly
required, AMI/HTTP disabled, no PJSIP transport/endpoint, no calls. Fixtures
provide disabled CDR/CEL engines, a valid private CEL text mapping, PJPROJECT/
Stasis defaults, UK indications and an empty key directory. Empty CEL mappings
caused a required-module decline in two intermediate runs; this was fixed in
the fixture rather than ignored or removed from startup requirements.

Execution retained the approved resource limits, private network, unprivileged
user, no-new-privileges, disabled core dumps, bounded logs and external
watchdogs. Three failed startups left stale owned socket/PID files, although
their processes had exited. Independent inspection verified no live owner,
removed exactly those six entries in the three failed attempt directories,
and retained their logs/configuration. The runner now explicitly reports and
removes only expected-type runtime entries after its owned process has exited.
Successful final startup/shutdown required exit zero.

The [independent verifier](./local/asterisk-build/verify-full-startup.py)
rechecked all 90 new ELF hashes/architecture, both optional-API selections,
every native XML hash/name/pass state, both smoke library hashes, module
inventory, loaded-state transitions and absence of remaining owned Asterisk
processes or smoke sockets/PID files. All source/package/profile flags remain
honest about their individual evidence stages. The builder was stopped after
verification. Existing PBXs, global WSL settings and runtime publication
authority remain untouched.

This establishes a loadable full module baseline, **not** SIP registration,
calls, media, full production configuration, a standalone deployable runtime,
redistribution/license closure, remaining lifecycle/output/AO2 acceptance or
Gate C. The historical first build remains valid compilation/queue-only
evidence but is superseded as the current binary candidate.

##### Matching local runtime bundle staged and smoke-tested

The user explicitly approved **local staging and isolated bundle smoke**,
not host binary export, container image construction, redistribution or
deployment. The [stager](./local/asterisk-build/stage-runtime.py) creates a
new collision-refusing private directory from corrected build attempt 4,
without `make install`, package installation or source-patch changes.
Bundle attempt 3 contains **378 files, 132,821,098 payload bytes**:
44 release outputs (core, 41 modules and two support libraries), support
SONAME aliases, 27 resolved system libraries/loader, C.UTF-8 locale data,
glibc conversion data, dependency notices, upstream notices/source archives,
the patch and build/package records. No native test modules are included.
The SHA256/size/mode [manifest](./local/asterisk-build/runtime-bundle-manifest.json)
excludes itself and remains an honest stage-time record: its
`packagedRuntimeExecuted=false` is superseded only by separate smoke evidence.

Initial strict smoke attempts exposed host mappings of C.UTF-8 locale data
and glibc's conversion cache. Asterisk explicitly selects C.UTF-8 in its own
startup, so setting `LC_ALL=C` did not solve it. Rather than relaxing checks,
the bundle now includes locale/conversion data, selected using `LOCPATH` and
`GCONV_PATH`. Earlier attempt directories and failure logs remain preserved.
Staging requires a positive `--attempt`; the shared smoke runner accepts
`--approve-release-smoke --approve-full-module-startup --approve-staged-bundle
--bundle-attempt 3 --build-attempt 4 --attempt 4`.

The successful smoke launches the copied dynamic loader explicitly, using
only bundle library directories. All 41 modules report Running; there are
zero PJSIP endpoints/transports, no test CLI and all five exact loaded-state
observations pass. At a post-boot startup checkpoint, `/proc/<pid>/maps`
contains **no absolute file-backed mapping outside the bundle**, and includes
the core, all modules, both support libraries, all 27 system libraries/loader
and locale data. This is a sampled mapping check, **not** evidence that all
file opens or kernel/OS dependencies are contained. `ldd` still reports the
core's original system interpreter path as metadata; actual process maps
prove the byte-identical copied loader is the one running.

The [independent verifier](./local/asterisk-build/verify-runtime.py)
checked every payload hash, size and mode, exact inventory, every release
output against build 4, mapped-file membership, library hashes, module state,
loaded-policy transitions, exit zero and absence of remaining owned bundle
processes/socket/PID files. The
[validation record](./local/asterisk-build/runtime-bundle-validation.json)
hash-binds the manifest and [smoke report](./local/asterisk-build/runtime-bundle-smoke-report.json).
Execution used the approved private network, 4 CPU-equivalents, 4 GiB memory,
zero swap, 256 tasks, unprivileged user, no-new-privileges, bounded logs and
five-minute watchdog. The dedicated distribution is stopped.
The combined source-package/evidence regression suite passes **24 tests**;
all three packaging Python files parse and the whitespace check passes.

Only JSON evidence was copied to the repository; all binary/source payloads
remain in the private guest. Notices and upstream sources are included, but
**complete corresponding-source/license closure for system dependencies is
not established and redistribution remains unapproved**. The bundle is not
a container or standalone OS image; the smoke still uses builder tools and
private fixture configuration. No SIP registration, calls, media, existing
PBX operation, Gate C, runtime publication or remaining Gate A acceptance
is implied. The next packaging scope needs an explicit bounded decision
before producing/exporting an image or exercising calls.

##### Container recipe and validation harness prepared only

The user selected **prepare-only**: implement the recipe and validation
harness, without building an image or exporting binaries. The dedicated
builder remains stopped. No actual build context, image, container or new
runtime evidence has been produced; the successful native bundle smoke
above remains the latest executed runtime result.

The [Dockerfile](./local/asterisk-build/runtime.Dockerfile) uses `FROM scratch`,
no downloads, shell, package installation, exposed ports or mutable tag.
It copies the complete reviewed bundle (including notices/sources/build
records), adds exactly 41 module aliases, sets the locale/conversion paths,
uses numeric non-root identity 10001:10001 and launches the copied loader
directly. Its default command explicitly requires the isolated fixture
configuration; it is **not** a production service configuration. An empty
scratch filesystem can still expose previously unseen runtime dependencies:
neither image construction nor actual container startup has been verified.

The [standard-library Python harness](./local/asterisk-build/runtime_image.py)
provides three explicit commands:

- `prepare --approve-context-preparation --bundle <bundle> --output <new-context>`:
  Linux-only; verify the pinned manifest plus exact file inventory, all SHA256
  hashes/sizes/modes and absence of payload symlinks/special files before
  copying. Refuse source/output overlap and existing output. Copy the recipe,
  an allowlisted build context, all original payload files and exact module
  aliases; then reverify. This **copies binaries**, so running it on the real
  bundle is a future separately approved operation, not part of this step.
- `verify --context <context>`: read-only verification of the prepared
  payload, recipe, aliases and honest preparation flags. No Docker call.
- `smoke --approve-image-smoke --image sha256:<64-hex-local-image-id>
  --work-dir <new-short-path>`: future opt-in integration smoke using only an
  existing immutable image ID. It never builds or pulls. It requires an
  unprivileged Linux caller with Docker access and a same-host Linux amd64
  daemon reachable through a local Unix socket; Docker Desktop/remote
  bind-mount translation and rootless UID mappings are not supported/proven.
  The image metadata must match the reviewed loader/command/user/environment
  and bundle label. These checks **do not independently prove image payload
  contents**; the eventual image result records that limitation explicitly.

The tool directory must retain the harness, recipe, pinned bundle manifest,
module plan and bundle smoke report together. No files were staged into the
guest in this preparation-only step. Future execution must select an approved
Linux Docker environment, its image/build cache/storage budget and external
five-minute watchdog. Image creation must explicitly select `linux/amd64`;
the recipe has no architecture-specific base image to infer that target.
The existing builder has not been provisioned as a
Docker host; no Docker installation or socket exposure is authorized here.
Do not infer an aggregate disk quota from Docker memory/CPU flags.

The future smoke constructs private disabled-AMI/HTTP/PJSIP-object configs
and host-owned state directories. Docker arguments enforce no pulls, no
network, no published ports, read-only root filesystem, all capabilities
dropped, no-new-privileges, 4 CPU-equivalents, 4 GiB RAM with zero additional
swap, 256 tasks, core dumps off and bounded daemon logs. Resource/isolation
settings are checked again through container inspection. Only its private
fixture config is mounted read-only and its state directory read-write;
the harness overrides the numeric user to the calling non-root UID/GID for
bind-mounted socket access.

Readiness requires the exact completed-boot reply over the private control
socket, a PID-1 greeting, exactly 41 Running module rows, zero PJSIP objects
and absent test CLI. The five getter/disk-edit/reload/restoration responses
must exactly equal the previously verified native bundle observations.
Shutdown requires exit zero without OOM. Failures still trigger log capture
and cleanup using a unique ownership label, exact owned name and container
ID; another container is never removed merely because its name matches.
Expected stale socket/PID files are removed only after the owned container
is removed. Failures remain errors and cannot set `passed=true`.
This harness does not yet repeat native `/proc/maps` inspection or establish
image layer provenance, complete filesystem hermeticity or production behavior.

**Fourteen offline Python tests pass**. They use synthetic bytes and mocked
Docker/CLI responses, not the real binary payload or daemon. Coverage includes
the pinned recipe, all 41 aliases, exact inventory/hash/size/mode checks,
manifest tampering/traversal/duplicates, a synthetic context round trip with
modeled Linux aliases, context tampering, fixture paths and listener absence,
Running/missing/duplicate/declined module states, explicit approvals, immutable
image IDs, no-pull/resource flags, 8192-byte output boundary, truncated/wrong-PID
greetings, success, failure, launch-timeout cleanup, isolation-setting rejection
and ownership-mismatch refusal. Run from the repository:

```powershell
python -B tests\asterisk-runtime-image.test.py -v
node --test tests\asterisk-native-build-evidence.test.mjs tests\asterisk-queue-policy-package.test.mjs
```

The existing 24 source/evidence regressions remain the separate executed
evidence checks. No dependency additions, image-build approval, container
runtime approval, redistribution/license closure, calls/media, production
deployment, Gate C or remaining Gate A acceptance is implied.

##### Local scratch image built and payload verified, not started

Read-only availability checks found Docker Desktop's Linux amd64 engine
reachable through the Windows named-pipe context `desktop-linux`. The
prepared runtime smoke harness deliberately requires a same-host Linux Unix
socket and cannot safely be used unchanged in this environment. The user
therefore approved **build-inspect only**: restart the owned builder, verify
and privately export the bundle, build the scratch image, independently
inspect its payload, retain local artifacts and stop the builder. No Docker
installation in WSL, shared-setting changes, existing-container changes or
container runtime were authorized.

The context was prepared in the dedicated guest under the existing
4 CPU-equivalent / 4 GiB / zero-swap / 256-task limits, private network,
unprivileged user and five-minute service watchdog. An initial attempt
failed before context creation because the tool's adjacent pinned manifest
had not yet been staged. After staging that exact manifest, preparation
and full context verification passed. A guest tar preserved executable
modes and absolute module symlinks; binary-safe Windows transport verified
its exact **133,253,120 bytes** and SHA256 before build. The context remains
an archive rather than being extracted onto NTFS.
The Windows working recipe had CRLF bytes while its committed representation
is LF. The build record preserves the **actual exported recipe hash** plus a
separate canonical-LF hash matching Git; only line endings differ. Regression
checks use the canonical hash so a fresh checkout does not invalidate evidence.

Docker built from that tar with `--platform=linux/amd64 --network=none
--pull=false`, a ten-minute subprocess timeout, and a 15-minute approved
overall work budget. There are no `RUN` commands, image downloads or
dependency installations. The local result is:

- Tag: `asterisk-local-verified:b6eb351-1`.
- Immutable OCI index ID:
  `sha256:dd7be33ac549af7758c92a3857d52f06c0967ecbd9b1df6e7875ee9d26adb8dc`.
- Config digest:
  `sha256:a1e2fe59ea552e2f10c83eaeba6eb537176959aad6feb78ed34b40854f210b98`.
- [Build evidence](./local/asterisk-build/image-build-validation.json) and
  [payload evidence](./local/asterisk-build/image-payload-validation.json).

The [independent archive inspector](./local/asterisk-build/inspect-runtime-image.py)
reads a local `docker image save` archive without extracting or running it.
The current Docker engine uses an OCI index ID, not the legacy assumption
that image ID equals config digest. The inspector verifies the saved index's
selected identity, descriptor SHA256/length chain to the unique Linux amd64
manifest/config, compressed layer SHA256/lengths and uncompressed diff IDs.
It checks all **379 payload files** (378 original files plus manifest),
all **41 module aliases**, exact non-directory inventory, hashes, lengths,
modes and UID/GID 10001 ownership. It rejects whiteouts, traversal paths,
special/hardlink entries, duplicate overwritten files and unexpected files.
The three verified filesystem layers include the two copies and working
directory layer. Entrypoint, command, environment, user, working directory,
stop signal and manifest label match the reviewed recipe. BuildKit's
attestation sibling is not treated as a runtime platform or independently
audited provenance claim.

Only evidence JSON is committed. Exported binaries/context, saved image,
logs and metadata remain under the private local attempt directory recorded
in the build evidence; the actual image stays in Docker Desktop. The guest
context/archive and prior failed-attempt log are retained too. No registry
push occurred: Docker's local `docker.io/library/...` naming in its log does
not mean it pushed anything. **No container was created or started**; the
four pre-existing stopped containers were not changed. The dedicated builder
is stopped. Historical preparation-only/no-export flags were not rewritten
to imply those earlier operations had a wider scope.

The **2 GiB incremental-storage stop threshold** was monitored, not enforced
as an aggregate quota. Observed host attempt files were about 199 MB; guest
context plus archive about 267 MB. Docker's rounded total image-size report
changed from 4.025 to 4.224 GB and its build-cache report from 5.302 to
5.768 GB. Even conservatively summing these reported increments remains
below the threshold. These are shared-engine snapshots, not an exact
deduplicated allocation/peak measurement. Docker Desktop overhead remains
outside guest process limits; no other images, caches or volumes were pruned.

Five new synthetic OCI-inspector tests cover identity substitution,
descriptor/layer/diff-ID tampering, altered bytes/modes/owners/aliases,
extra files, traversal, whiteouts, hardlinks and overwrites. They complement
the 14 existing offline recipe/harness tests and 25 source/evidence tests.
The actual saved image also passed the final inspector including recipe
configuration checks. No dependencies were added.

This establishes **an actual locally built image with verified contents,
not a running container**. Docker Desktop-compatible smoke transport still
needs preparation and separate runtime approval. SIP registration, calls,
media, deployment, complete dependency-source/license closure, redistribution,
Gate C and remaining Gate A acceptance remain unclaimed and unauthorized.

##### Corrected image container startup passed: NSS dynamic dependency closure

The user approved Desktop-compatible tooling and isolated image runtime,
then bounded recovery and a specific NSS dependency correction/rebuild.
The original one-container scope was not silently expanded: further runtime
attempts and the new image build were separately presented for approval.
Existing containers, shared WSL settings and production authority remained
unchanged. The [Desktop runner](./local/asterisk-build/smoke-desktop.py)
uses the explicit `desktop-linux` context and immutable verified image ID.
It never builds or pulls, installs packages, exposes ports or enables calls.

Two initial launches failed before Asterisk startup because Docker's local
logging driver rejects its default compression with `max-file=1`. Both owned
containers were removed. Diagnostic handling was corrected so the original
daemon error is retained even when an unstarted container has no readable
logs. Both smoke harnesses now explicitly set `compress=false`, retaining
the 2 MiB single-file log bound. Desktop runtime state is a **64 MiB tmpfs**
owned by UID/GID 10001, not a Windows bind mount: Unix sockets stay inside
Linux. Only private fixture configuration is mounted read-only from Windows.
The disposable fixture uses the same state directory for its data/db/log/
spool/run/cache paths and private read-only empty key directories.

The first actual startup failed its required `res_srtp` initialization.
An approved loader-diagnostic attempt confirmed NSS searches for
`libsoftokn3.so` dynamically and cannot find it. This is a genuine packaging
gap: `ldd` does not expose these runtime loads, and a post-boot native maps
snapshot misses modules loaded and subsequently unloaded during crypto
self-tests. The earlier “all sampled mappings inside bundle” result remains
true, but **was not proof of dynamic dependency closure**. No required module
was removed and the startup requirement was not relaxed.

After explicit correction approval, the dedicated builder's installed
`libnss3:amd64` package inventory and `dpkg -V` output were checked. No package
download/install occurred. The [stager](./local/asterisk-build/stage-runtime.py)
now copies all **13 NSS package `.so`/`.chk` files**, preserving adjacent
integrity files, hashes and the existing dependency notice. Eleven files
were new relative to the original bundle. Bundle attempt 4 has **389 files,
135,344,626 payload bytes**, the same 44 compiled release outputs, no native
test modules and the same original source patch. The
[new manifest](./local/asterisk-build/runtime-bundle-manifest-nss.json)
and [native bundle smoke](./local/asterisk-build/runtime-bundle-smoke-report-nss.json)
are separate from historical reports. Native full startup, all five loaded
policy checks and mapping/cleanup checks passed again under the existing
bounded private-network service limits. Real context preparation then
reverified every file's SHA256, size and mode.

The new context tar was exported byte-exactly with LF-normalized tooling.
Docker rebuilt locally for Linux amd64, no build network/pulls, retaining
`asterisk-local-verified:nss-1`:
`sha256:48cb4a5e45da53fcff3389dfbc2c77ef9c1ad26c40bcb4251b35b76d6f364967`.
The [new image-build record](./local/asterisk-build/image-build-validation-nss.json)
and [payload inspection](./local/asterisk-build/image-payload-validation-nss.json)
bind all **390 files including manifest**, 41 module aliases, ownership,
permissions, exact inventory, recipe configuration and OCI layer/identity
hashes. The original recipe is retained as
[runtime-initial.Dockerfile](./local/asterisk-build/runtime-initial.Dockerfile);
the [current recipe](./local/asterisk-build/runtime.Dockerfile) and preparation
harness pin the new manifest, without invalidating historical evidence.

The first corrected-image attempt passed all boot/module/policy checks but
the shutdown harness treated its remote CLI process being killed during
PID-1 shutdown as a failure. The final attempt instead sends Docker's
SIGTERM stop signal with ten seconds allowed, then requires **exit zero,
not Running and not OOMKilled**. A forced termination would still fail.
The successful [container smoke report](./local/asterisk-build/desktop-image-smoke-report.json)
records all 41 exact module names Running, absent test CLI, no PJSIP
endpoints/transports and all five exact observations. No SIP registration,
calls or media were exercised.

Desktop control uses an exec-based remote CLI, not Windows access to a
Unix socket. Network-isolated remote CLI startup emits one exact no-Ethernet
EID notice on stdout before command output; the runner recognizes only that
literal prefix, records each occurrence as a diagnostic, and validates the
remaining command response. Unknown stderr is an error; unknown stdout is
not generally stripped. The getter payload itself must remain one bounded
JSON line equal to the native baseline. This transport differs intentionally
from the original Linux harness's strict Unix-socket framing.

The [central validation](./local/asterisk-build/image-startup-validation.json)
hash-binds all new reports and retains all six attempt outcomes/report hashes.
Every owned container was removed using a unique label, exact name and ID;
the original four stopped containers are unchanged. The five-minute watchdog
per smoke owns the same bounded cleanup path. Inspection confirmed no network,
ports, capabilities or writable root filesystem, no-new-privileges,
4 CPU-equivalents, 4 GiB memory with zero additional swap and 256 tasks.
The builder is stopped. Contexts, image archives, logs and failed-attempt
reports remain private; only JSON evidence/tooling is committed.

The correction's monitored 2 GiB incremental storage threshold was not an
enforced aggregate quota: host attempt files were about 202 MB; guest context
plus archive about 271 MB; shared Docker image-size reports rose from
4.224 to 4.427 GB and cache reports from 5.768 to 6.243 GB. Conservative
snapshot sums remain below the threshold; shared overhead/peak allocation is
not measured or guaranteed. No unrelated image/cache/volume was pruned.

**26 offline Python image/harness tests and 27 source/evidence tests pass.**
New Desktop tests cover exact EID diagnostic handling, daemon-error retention,
launch restrictions, missing approvals, tampered evidence, mocked success,
startup/module/resource/shutdown failures, the five-minute watchdog setup and
foreign-ownership cleanup refusal. The NSS evidence regressions bind every
new report, all 13 runtime files, unchanged compiled output hashes, exact
policy/module states and honest authority flags.

This is a real, isolated, cleanly exiting **custom-image startup baseline**.
It does not close remaining Gate A lifecycle/output/AO2 acceptance or authorize
Gate C, production deployment, live SIP/media, redistribution or complete
source/license closure. Those remain separate scopes.

##### Custom image synthetic Local-channel queue timeout passed

The user selected **local-call-proof**, explicitly approving preparation and
execution of one no-network synthetic Local-channel test in the verified
custom image. No image rebuild, existing-container changes, SIP endpoints,
published ports, external calls, media or separately gated two-PBX proof were
included. The dedicated builder was not restarted.

The [functional helper](./local/asterisk-build/runtime_local_call.py) extends
the [Desktop smoke harness](./local/asterisk-build/smoke-desktop.py) behind
`--approve-synthetic-local-call` (in addition to the existing image-smoke
approval). With no flag, startup-only behavior remains unchanged. The
private `isolated-local-queue-proof` context contains only `Answer`,
`Queue(proof-queue,r,,,3)`, `Wait(5)` and `Hangup`. Ringback avoids requiring
music-on-hold sound files. No dialplan shell/AGI/external destination is added.
The fixture originates `Local/start@isolated-local-queue-proof/n` with a
bounded `Wait 20` application; `/n` preserves both Local legs for inspection.
The five-second result hold exists only to inspect channel variables after
Queue returns, not to add queue waiting time.

Before origination, the helper requires zero channels and an empty proof
queue. During the call it accepts only private Local channels, observes both
legs and checks the policy envelope/static fields against the native baseline.
The proof queue must expose exactly one caller with a nonempty caller list;
the other selected queue remains unchanged. The result leg must be in `Wait`
with exactly one `QUEUESTATUS=TIMEOUT`, `ANSWEREDTIME_MS=0`, `ABANDONED=TRUE`
and measured `QUEUEWAIT_MS` in the requested 3-second interval
**[3000, 4000) ms**. Cleanup requires zero channels, zero callers, an empty
caller list and unchanged loaded policy before a 25-second call deadline.
No success-shaped result is returned when queue entry was not observed.

The first and only executed attempt passed: both Local legs observed,
one queued caller, **QUEUEWAIT_MS=3000**, zero answered time, `TIMEOUT`,
then no callers/channels. Overall observation duration was **8.985 seconds**,
including the deliberate five-second result hold and CLI polling. That
duration is not claimed as queue timeout or latency. The earlier five
loaded-policy transitions and 41-module/no-PJSIP-object startup checks also
passed within the same process. Docker SIGTERM shutdown exited zero without
OOM or watchdog expiry; the exact owned container was removed.

The [functional validation](./local/asterisk-build/synthetic-local-call-validation.json)
is derived from the retained private raw smoke report and channel details,
and hash-binds the existing image-startup and inspected-payload records.
Its queue result variables were independently rechecked against the actual
channel dump, including the exact timeout threshold and no-answer state.
The raw runner report initially inherited the startup-only combined
`callsOrMediaTested=false` flag; it is retained unmodified privately. The
derived validation explicitly records **syntheticCallsTested=true,
sipTested=false, mediaTested=false**, and notes the correction rather than
silently rewriting runtime history. Future runner reports now set the
combined call flag appropriately while retaining explicit SIP/media flags.
The original successful startup-only report remains unchanged.

Execution retained no network/ports, read-only root, capabilities dropped,
no-new-privileges, UID/GID 10001, 64 MiB state tmpfs, 4 CPU-equivalents,
4 GiB RAM with no extra swap, 256 tasks, core dumps off, 2 MiB daemon logs
and a five-minute container watchdog. The four existing stopped containers
remain unchanged, no owned smoke container remains and the builder is still
stopped. No image/tag/payload changed.

Eight new offline functional tests cover the private bounded dialplan,
channel parsing, exact policy/dynamic caller state, observed queue entry,
both legs, successful timeout/cleanup, pre-existing channels, missing queue
entry, wrong status, absolute deadline, exact 3000/4000-ms threshold edges,
no-answer values and duplicate result-variable rejection. Desktop harness
tests also cover opt-in wiring and startup-only behavior preservation.
Together **34 offline Python tests and 28 source/evidence tests pass**.

This is functional custom-image execution, not live taxi service, successful
member answering, SIP registration, call transfer, audio/media, production
configuration or remaining Gate A lifecycle/output/AO2 acceptance. Gate C,
deployment, redistribution and complete source/license closure remain
separate and unapproved.

##### Custom image synthetic answered-member and caller continuation passed

The user selected **answer-proof**: prepare and execute one synthetic
answered-member call in the same verified no-network custom image. The
[answered helper](./local/asterisk-build/runtime_answer_call.py) is wired
behind `--approve-synthetic-answered-call` in the
[Desktop harness](./local/asterisk-build/smoke-desktop.py), in addition to
the existing image-smoke approval. Timeout and answer call modes are mutually
exclusive; omitted flags preserve startup-only behavior.

The private `isolated-local-answer-proof` context has a caller leg using
`Queue(proof-queue,rc,,,12)`, then a five-second result-inspection hold and
hangup. Queue's `c` option continues the caller dialplan after the member
hangs up. The synthetic member waits two seconds before `Answer`, holds
four seconds and hangs up; this is not a real agent or audio assertion.
The helper adds only `Local/member@isolated-local-answer-proof/n` to the
owned empty proof queue and originates a `/n` caller with bounded `Wait 25`.
No SIP driver configuration, external destination, shell, AGI, image rebuild
or new network/port is introduced.

Preflight requires zero channels and the empty original policy. Adding the
member must yield exactly one loaded member; static policy fields and the
other selected queue remain unchanged. Polling must observe one queued caller,
all four private Local legs and the member's post-answer four-second hold.
The caller's result hold must expose exactly one `QUEUESTATUS=CONTINUE`,
numeric `ANSWEREDTIME_MS` in **[3500, 7000) ms**, and `DIALEDTIME_MS` at least
as large as answered time. The tolerance bounds detect a missing/too-short
answer or an unbounded hold; they are not production latency targets.
After all channels end, queue status must show one completed call and no
callers. Removing the member must restore the original zero-member/caller
policy, followed by another zero-channel check within 25 seconds.

The first attempt reached the answer/completion checks but failed the
harness's assumed quoting in the CLI member-removal reply. Asterisk prints
the removed interface **without** quotes. That owned container was removed;
the user approved one additional attempt. The corrected parser now requires
the exact actual reply rather than accepting a generic success substring.
The second attempt passed with **4,505 ms answered time, 7,009 ms dialed time**,
`CONTINUE`, four Local legs, one completed queue call, member removed and
original empty policy restored. Overall fixture observation was **13.328
seconds**, including pre-answer delay, four-second synthetic answer hold,
five-second inspection hold and CLI polling; it is not queue wait or
service latency. The queue status also reports one call taken by that
synthetic member. Both owned attempt containers were removed.

The [central functional validation](./local/asterisk-build/synthetic-answered-call-validation.json)
hash-binds the **byte-exact successful raw**
[smoke report](./local/asterisk-build/synthetic-answered-call-smoke-report.json),
existing image-startup validation and payload inspection. Independent checks
reparsed actual channel result variables, compared the four-leg and policy
observations, and verified no owned smoke container remains. The failed
attempt report remains private with its hash/error recorded in the summary;
no earlier successful timeout or startup evidence was overwritten.

All 41 modules and the five loaded-policy startup observations passed in
the same successful process. No PJSIP endpoints/transports or test CLI were
present. Docker SIGTERM shutdown exited zero without OOM/watchdog expiry,
then owned-label/name/ID cleanup removed the container. Existing containers
were untouched; the dedicated builder stayed stopped and the image was not
rebuilt. The existing no-network/no-ports/read-only-root/cap-drop/no-new-
privileges, 4 CPU-equivalent, 4 GiB/no-extra-swap, 256-task, 64 MiB tmpfs,
five-minute watchdog and bounded-log controls remained in effect.

Nine new offline answer tests cover bounded fixture contents, exact answer
threshold edges, wrong/duplicate/missing result variables, dialed-vs-answered
consistency, exact member/caller state, foreign channels, four-leg success,
completed-call rejection, initial-channel rejection, absolute deadline and
mutually exclusive fixture flags. Existing Desktop tests cover answered-mode
wiring while preserving startup/timeout behavior. Together **43 offline
Python tests and 29 source/evidence tests pass**.

This demonstrates synthetic queue-member answering and caller continuation,
not human agent service, SIP registration, external calls, sound quality,
audio/media, transfer or production configuration. Gate C, remaining Gate A
lifecycle/output/AO2 acceptance, deployment and redistribution/source-license
closure remain separate scopes.

##### Custom image synthetic unanswered-member timeout and cleanup passed

The user selected **unanswered-proof**, then approved up to two bounded
additional attempts after an initial result-capture failure. The first
recovery succeeded, so no further runtime attempt was made. This used the
same verified image, one owned container at a time, no network/ports, image
rebuild, SIP endpoints or changes to existing containers. The builder stayed
stopped throughout.

The [unanswered helper](./local/asterisk-build/runtime_unanswered_call.py)
reuses the existing member-policy parser and exact timeout-variable checker.
The shared channel parser now takes an optional fixture context, preserving
its original answered-fixture default. The
[Desktop runner](./local/asterisk-build/smoke-desktop.py) requires
`--approve-synthetic-unanswered-call` plus image-smoke approval and rejects
any combination of multiple functional call modes before Docker operations.
Startup-only, empty-queue and answered-member behavior is preserved.

The private `isolated-local-unanswered-proof` caller answers, enters
`Queue(proof-queue,r,,,3)`, holds five seconds for result inspection and
hangs up. The synthetic member calls `Ringing`, `Wait(20)` and `Hangup`,
**never Answer**. After the five existing startup policy observations, the
helper sets private `timeoutpriority=app` and explicitly reloads proof-queue
parameters so Queue's three-second overall timeout takes priority over the
existing seven-second member ring setting. That fixture-only setting is not
part of the bounded getter fields; it is not represented as a getter-verified
configuration attribute. The original getter-visible static policy is
checked unchanged. No production configuration is modified.

The helper starts with zero channels/callers, adds one dynamic Local member,
requires one loaded member, and originates the bounded private Local caller.
It must observe all four caller/member Local legs, the member's pre-answer
`Wait(20)` application and exactly one queued caller. The result uses the
existing **[3000, 4000) ms** queue-wait check, requiring `TIMEOUT`,
`ANSWEREDTIME_MS=0` and `ABANDONED=TRUE`. After all channels end, queue status
must show **C:0, A:1**, no calls taken by the member and no callers.
Exact member removal must restore zero loaded members/callers and the
original getter-visible policy; another zero-channel check closes the path.
The fixture has a 25-second absolute call deadline.

The first attempt failed because a result-channel detail query lacked
`QUEUESTATUS`. Its report did not retain that channel detail, so **the exact
cause is unproven**; a repeated poll near channel disappearance is suspected,
not asserted. The owned container was removed. The helper now stores bounded
per-poll progress/details in the existing bounded-report workflow and captures
the result only once after validation, rather than rereading it until the
channel disappears. No missing variable or unknown state is ignored.
The user approved recovery before another container was launched.

The recovery passed: four Local legs, member attempt and queued caller,
**QUEUEWAIT_MS=3000**, zero answered time, `TIMEOUT`, zero completed calls,
one abandonment and no calls taken by the member. Member removal restored
the empty queue policy and no channels remained. Overall fixture observation
was **9.984 seconds**, including the five-second result hold, member
removal/status checks and CLI polling; it is not queue wait or latency.

The [central validation](./local/asterisk-build/synthetic-unanswered-call-validation.json)
hash-binds the byte-exact successful
[raw report](./local/asterisk-build/synthetic-unanswered-call-smoke-report.json),
image-startup validation and payload inspection. Independent checks reparsed
the actual channel variables and queue completion/abandonment output, verified
the four-leg/member/caller observations and final restored state, and checked
there are no remaining owned smoke containers. The initial failed report is
retained privately with its hash/error and explicit uncertainty recorded.
Earlier successful answer/timeout/startup reports are unchanged.

All 41 modules, no-PJSIP-object checks, absent test CLI and all five startup
policy observations also passed in the successful process. Docker SIGTERM
shutdown exited zero without OOM/watchdog expiry. Both owned attempt
containers were removed; the original four stopped containers remain
unchanged. The same read-only root, no capabilities, no-new-privileges,
UID/GID 10001, 64 MiB state tmpfs, 4 CPU-equivalents, 4 GiB/no-extra-swap,
256 tasks, disabled core dumps, 2 MiB logs and five-minute watchdog applied.

Seven new offline tests cover member dialplan with no Answer, explicit
application timeout priority, four-leg/queued-caller/member-attempt success,
no answered/completed call, restoration, missing attempt/queue entry,
wrong answered/completed state, zero-initial-channel preflight, deadline,
mutually exclusive modes and avoiding repeated validated-result reads.
Desktop mocked tests cover unanswered-mode wiring. Together **50 offline
Python tests and 30 source/evidence tests pass**.

This establishes synthetic member no-answer timeout and cleanup only. It
does not prove real endpoint ringing, SIP registration, agent behavior,
audio/media, production retries/transfer, remaining Gate A acceptance or
Gate C. Deployment and redistribution/source-license closure remain separate.

##### Proposed custom-image SIP registration and RTP echo proof: not authorized

**Historical status at proposal publication: proposal only.** The user requested investigation and a concrete
isolated protocol-test proposal, not network/container execution. This step
read repository fixtures and local image metadata only. It did not start
containers/builders, create a network, generate credentials, install packages,
build/pull images, send SIP/RTP or operate existing PBXs. The latest executed
custom-image result remains the synthetic unanswered-member proof above.

**Reusable prior art and boundaries**

- [Python SIP/RTP probe](./tests/sip_rtp_proof.py): standard-library UDP
  INVITE digest challenge/response, ACK, PCMU SDP negotiation, synthetic RTP
  echo and BYE. It checks Call-ID/CSeq and bounds final-response exchanges
  to five seconds with 500-ms retransmission. The RTP check sends 100 distinct
  160-byte/20-ms PCMU payloads and requires at least 70 distinct matching
  outbound payloads echoed during a three-second observation. It does **not**
  register an endpoint.
- [Registration client](./tests/identity/sip-registration-client.ts) and
  [registration proof](./tests/identity/pbx-registration-proof.ts): prior
  digest REGISTER, contact-expiry and unregistration assertions. They assume
  loopback/custom identity plumbing and two customer fixtures, so cannot
  simply be invoked against this new scratch-image test.
- [SIP Compose overlay](./compose.sip-proof.yaml) proves the already pinned
  Asterisk carrier image contains Python in earlier runs. Local metadata
  confirms that Linux amd64 image remains present; Python availability in
  the selected immutable image must still be checked at future execution.
- [Existing wrapper](./scripts/Test-SipProof.ps1) calls `up --force-recreate`
  for named customer services, checks CEL/WAV recordings and leaves PBXs
  running. **Do not run it for this proposal.** Frozen REFER/browser/identity
  proofs and existing customer configs/credentials must not be changed.

**Proposed topology and prerequisites**

Use one fresh owned PBX from immutable ID
`sha256:48cb4a5e45da53fcff3389dfbc2c77ef9c1ad26c40bcb4251b35b76d6f364967`,
binding the current image-startup/payload evidence before launch. Use one
client container from existing
`andrius/asterisk:22.11.0_debian-trixie@sha256:d6333b8b331563c5887b98b12da9371ef48317e657d17d81770fe085f335041d`
**only as a Python carrier**: override entrypoint, never start its Asterisk.
No new image/dependency build, pull, package install, external trunk or host
SIP client is needed. Missing images/tools must fail explicitly, not trigger
downloads or substitute an unverified image.

Create one unique user-defined bridge with `internal=true`; attach only the
owned PBX and client with per-run ownership labels. Publish **no ports**,
attach no existing networks and do not use host networking or Docker-socket
mounts. Verify network membership and internal flag before protocol traffic.
Resolve the PBX alias on that network and retain the actual peer IP; accept
SIP/RTP only from the selected PBX address and negotiated bounded media port.
An internal bridge reduces external routing but is **not proof of host
inaccessibility, tenant isolation or a security boundary against host admins**.
This is one PBX plus a client, not the separately gated two-PBX Gate C proof.

The scratch PBX has no Python/shell: host orchestration uses the existing
copied-loader remote CLI path. Private read-only fixture configuration enables
one UDP transport on 5060, one `proof-client` endpoint/auth/AOR, PCMU only,
`direct_media=no`, and a private `echo` dialplan using `Answer`, `Echo`,
`Hangup`. No AMI, HTTP/WSS, CEL/recording export, production context, outbound
dialplan, anonymous endpoint, source-IP auth bypass or telephone number is
enabled. RTP is restricted to the existing private 10000–10100 range, ICE
off. This is intentionally unencrypted UDP SIP/RTP for the isolated fixture,
**not a production transport/security recommendation**.

Generate a new 32-byte random secret (64 hex characters) for this run only.
One AOR accepts at most one contact; use explicit 60-second requested lifetime
and bounded minimum/maximum expirations. Qualification is disabled for this
first contact-lifecycle proof; OPTIONS reachability is a separate milestone.
The private PBX config and client's secret-only input are separate mounts;
do not give the client unrelated PBX/build records or other customer secrets.
Never log password, Authorization headers, digest responses or credential
file bytes/hashes. Bind sanitized configuration structure and nonsecret
protocol outcomes in reports; clean up only the exact generated credential
files after both owned containers are gone. Failed-run logs must be sanitized
before export; do not retain secret-bearing fixtures as ordinary evidence.

**Implementation proposed after approval**

Add a bounded custom-image orchestrator reusing existing image/payload
identity checks, Docker Desktop command/error handling, readiness, module
checks, unique-label/name/ID cleanup, tmpfs and watchdog patterns. Extract
shared helpers only where needed; keep current no-network smoke behavior
unchanged rather than silently switching it to an internal network.
Add an isolated Python protocol entrypoint importing the existing `Probe`
and RTP verifier, with method-aware REGISTER digest support and contact
lifecycle checks based on registration prior art. Preserve the existing
INVITE helper API/default semantics and frozen callers; test any shared
change against existing SIP/REFER unit coverage. The current probe's `main`
requires two-customer credential mounts, so **reuse its functions, not main**.
Use a new fixture directory and unique resource names, never the existing
Compose project or customer volumes.

Before runtime, offline tests must verify exact digest method/URI/qop input,
challenge handling, wrong-secret refusal, Call-ID/CSeq matching, expiration
parsing, packet/output limits, malformed SDP/RTP rejection, exact echo
threshold edges (69 fails / 70 passes), deadlines and ownership-safe cleanup.
Do not claim a full RFC SIP implementation from these bounded test clients.

**Proposed ordered acceptance**

1. Inspect image evidence and pre-existing container/network inventory.
   Verify isolation/resource settings and completed boot, exact 41 Running
   module rows, absent test CLI and unchanged loaded queue policy.
2. Require exactly one UDP transport/configured endpoint and zero initial
   dynamic contacts. Unauthenticated REGISTER must be challenged; a random
   wrong secret must never produce SIP 200 or create a contact.
3. Correct digest REGISTER must return 200 with a positive contact lifetime
   no greater than the requested 60 seconds. Correlate the sole PBX contact
   to the client's actual address/port; it is contact presence, **not**
   qualification/reachability proof. Duplicate retransmissions must not create
   extra contacts. Never infer registration success from INVITE success.
4. Unauthenticated INVITE must be challenged. An INVITE with a wrong secret
   must end with an explicit authentication rejection (401/403), no answered
   dialog and zero PBX channels afterward. Timeouts/5xx are failures, not
   accepted negative-auth results.
5. Correct authenticated INVITE to only the private echo extension must
   return 200; ACK it, require SDP PCMU/8000 and the expected peer/media port,
   then require **at least 70 of 100 distinct synthetic PCMU payloads echoed**
   within the existing three-second observation. Report sent/matching frame
   counts and negotiated codec, not human audio quality, latency/jitter/MOS,
   queue/member behavior or production RTP performance.
6. Send BYE, require 200 and poll PBX channels to zero within ten seconds.
   Authenticated REGISTER with expiry zero must return 200 and remove the
   exact dynamic contact; endpoint config remains and no extra contacts exist.
   Do not rely on container teardown to claim unregistration.
7. Send SIGTERM to PBX; require exit zero without OOM/watchdog expiry.
   Client must exit zero. Remove both exact owned containers, then the exact
   owned network only if its label matches and no foreign endpoints remain.
   Compare initial existing-resource inventory; never prune or disconnect
   foreign resources to force cleanup. Delete only generated credential files;
   retain sanitized results and nonsecret failure evidence.

The registration and echo portions produce separate pass/fail results. If
registration passes but media fails, preserve that distinction rather than
claiming end-to-end success. Fail closed on missing observables/credentials,
unexpected auth success, external SDP addresses, extra endpoints/contacts,
nonzero exit or cleanup failures.

**Proposed budget and approval boundary**

One PBX: 4 CPU-equivalents, 4 GiB RAM, zero extra swap, 256 tasks; one client:
0.5 CPU-equivalent, 128 MiB RAM, zero extra swap, 32 tasks. Thus the proposed
aggregate limits are **4.5 CPU-equivalents / 4 GiB + 128 MiB / 288 tasks**,
not the previous single-container total. Read-only roots, all capabilities
dropped, no-new-privileges, non-root numeric identities, core dumps disabled.
PBX state tmpfs 64 MiB; client tmpfs at most 8 MiB if needed, no persistent
volumes. Single-file daemon logs capped at 2 MiB per container with compression
off; protocol reports bounded and credential-free, no default packet capture.
Overall watchdog **five minutes including cleanup**, per exchange five seconds,
client process at most 60 seconds and ten-second graceful-stop limits.
Implementation/preflight budget 15 minutes; monitored incremental storage
stop threshold 256 MiB (not a guaranteed disk quota); shared Docker Desktop
overhead remains outside process limits. No existing image/cache pruning.

**No execution is authorized by this document.** A later approval must cover
the new internal network, both containers, ephemeral credentials, UDP
registration/calls and synthetic RTP, plus the stated aggregate budget and
cleanup. Recommend one initial attempt with an explicit stop/report on
failure; do not automatically expand into retries, more PBXs, real trunks,
WebRTC/TLS/SRTP, production deployment or Gate C. This proposal creates no
new runtime evidence and leaves all previous acceptance/redistribution limits
unchanged.

##### Custom-image SIP attempt 1: stopped at contact verification

The user subsequently approved harness implementation/offline tests and
**one** bounded internal-network SIP/RTP attempt. Approval did not cover
automatic retries. [The new orchestrator](./local/asterisk-build/sip-proof.py)
reuses the Desktop image/fixture checks; the old no-network runner retains its
default behavior. [The isolated client](./tests/sip_candidate_client.py) adds
method-aware REGISTER digest support using the existing INVITE/RTP probe,
with phase acknowledgements for independent PBX observations. The carrier
entrypoint is explicitly Python, not a second PBX. No existing Compose
wrapper, frozen REFER/browser proof or customer fixture was operated.

**Executed attempt:** one custom-image PBX and one pinned Python carrier,
one unique internal bridge, zero published ports. Inspected limits matched
4.5 aggregate CPU-equivalents, 4 GiB + 128 MiB RAM, no extra swap and
288 tasks. Both roots were read-only/non-root with capabilities dropped,
no-new-privileges and bounded logging. The builder remained stopped; no
image rebuild, pull or dependency install occurred.

- All **41** required release modules were Running, the test command absent,
  and initial loaded queue policy matched.
- Wrong-secret REGISTER returned **401**, with host-observed no contacts
  and zero channels.
- The client recorded correct-secret REGISTER **200**, accepted contact
  expiry **59 seconds**, from the expected private client/PBX addresses.
- The next host contact assertion failed before acknowledging registration.
  **The actual contact CLI output was not retained.** A formatting/parser
  mismatch is possible but not established; a genuine contact mismatch cannot
  be excluded. A SIP 200 alone does not complete contact-lifecycle acceptance.
- No INVITE, authenticated unregistration or RTP was executed. Neither the
  registration proof nor end-to-end/media proof passed; no clean graceful
  process exit is claimed for failure-path forced cleanup.

The attempt ended after **13.672 seconds**, without watchdog expiry. Both
owned containers and the owned network were removed, then both generated
credential files deleted. Four pre-existing container IDs/names/states were
identical before/after and remain stopped. Existing named customer networks
retained their IDs. **The built-in Docker `bridge` ID changed** from
`34b57e2693a1b8c16c4aaa95be70486a4e9059a7bc02e89a7fcffc3b3286ac35`
to `ff9770c2e4cc0abac065bbcac3b0d7e720cc5e7012e49a82bdc301536d536097`.
Its cause and attribution are unproven; do not claim that all pre-existing
networks or bridge configuration/attachments were preserved. The orchestrator
issued no bridge recreation/repair command, and no foreign-resource repair was
attempted. The strict final inventory comparison failed rather than silently
ignoring this change.

[Validation summary](./local/asterisk-build/sip-proof-validation.json) binds
the **byte-exact original failed host report** and Linux client registration
phase by SHA-256. The host report's Windows CRLF bytes are intentionally
preserved by a file-specific Git no-normalization attribute; it is not reserialized.
It records both primary contact failure and secondary inventory failure;
the latter superseded the original console traceback. Original tool hashes
describe the executed version; a matching entrypoint snapshot and sanitized
logs remain private, without generated secrets.

**Offline-only follow-up:** preserve bounded PJSIP CLI observations and
last client progress before contact validation, and preserve the primary
exception when inventory/cleanup also fails. Regression tests cover this
dual-failure case, secret-safe output, method/URI/qop digest inputs,
challenge rejection, contact expiry, peer/codec/port validation, malformed
RTP, correlation/deadlines, ownership-safe cleanup and actual synthetic
echo-loop **69 fails / 70 passes / 100 passes** threshold edges.
These improvements were not run against another container.
Final validation passed **60 offline Python tests and 31 source/evidence
tests**, including byte-exact failed-report hashes. This does not replace
the failed runtime acceptance.

**Next boundary:** stop and report, as approved. A further attempt needs
explicit approval, should capture the contact row, and must retain strict
inventory checks until the default-bridge discrepancy is understood. No
Gate A completion, Gate C, production SIP/media quality, redistribution or
deployment authority follows from this partial attempt.

##### Read-only investigation: Docker Desktop woke before bridge replacement

After attempt 1, a separately selected read-only investigation compared
current bridge metadata with bounded Docker Desktop host/VM log entries.
[The retained excerpts and observations](./local/asterisk-build/sip-bridge-investigation.json)
show the following sequence on 25 October 2026 (UTC):

1. **16:28:00.820:** Desktop reports idle-to-busy after 12 minutes idle,
   explicitly citing one `networks/create` request from the Docker client.
2. **16:28:00.821:** its Linux/WSL engine changes stopped to starting.
3. **16:28:07.291:** current default bridge metadata records creation.
4. **16:28:07.758:** daemon initialization completes.
5. **16:28:07.761:** Desktop reports its engine running.

The new bridge ID matches the original attempt's final inventory and remained
the same across two observations in this investigation. It is currently the
default non-internal bridge with zero attached containers. Four pre-existing
containers retain their original IDs/names/stopped states.

This strongly supports engine startup/reinitialization, triggered by the
approved private-network creation, as the explanation for bridge replacement.
It does **not** establish equivalence with the old bridge's settings or
attachments: those were not captured. The original inventory failure is
correct and remains unchanged, as does the failed registration acceptance.
Do not describe the attempt as having no host-engine lifecycle effects.
The missing contact row still prevents attribution of the primary SIP failure.

The historical network-events API request did not finish within the bounded
observation and was terminated; no inference is made from its missing output.
No containers/networks were created or started, no settings were changed,
no foreign resources repaired and no protocol attempt added.

Recommended **separately approved** next preparation: explicitly wake and
verify the engine with a bounded Python-carrier preflight, then capture the
baseline bridge identity/configuration/attachments before creating the proof
network. Retain strict drift checks rather than ignoring the built-in bridge.
Another diagnostic SIP attempt still requires approval and must retain the
actual contact CLI output. This investigation alone grants no runtime retry,
Gate C or deployment authority.

##### Custom-image SIP attempt 2: contact parser failure diagnosed

The user separately approved implementing/offline-testing explicit Python/
engine preflight and **one further diagnostic attempt**, not automatic retries.
The harness first started one owned Python carrier with network `none` and
waited for a file-based readiness response, then stopped/removed it and
captured a warmed-engine baseline. It recreated the client on the fresh
internal network alongside the one custom-image PBX. There were two sequential
client lifetimes, **at most one client and one PBX concurrently**, with the
previous aggregate limits unchanged. The carrier did not run Asterisk.

The preflight woke the idle engine: the default bridge ID changed from
`ff9770c2e4cc0abac065bbcac3b0d7e720cc5e7012e49a82bdc301536d536097` to
`d61f642291e8383d7f9a07d967656436ca32e8a6115f067be131845a2f931a5b`
before the baseline. **After preflight, initial/final inventories matched
exactly**, as did bridge name, ID, creation time, driver, internal flag,
IPAM, options and attached-container map. This is not proof that the old
pre-wake bridge configuration was equivalent.

Runtime again verified 41 Running modules, absent test CLI, initial queue
policy, internal-only two-container membership and no published ports.
Wrong-secret REGISTER returned 401 with no contact; correct-secret REGISTER
returned 200 with 59-second expiry. The diagnostic captured the sole actual
contact, `proof-client/sip:proof-client@172.23.0.3:48219`, matching the client's
reported address/port, with `Objects found: 1`.

**Proven attempt-2 root cause:** the legacy row matcher
`Contact:\s+(?!<)` backtracks its whitespace group on the multi-space column
header, leaving whitespace before `<` and incorrectly counting that header
as a second contact. Offline reproduction on the exact captured output
returns two legacy rows; the fix captures a non-whitespace-starting value
and explicitly excludes values beginning `<`. Tests now accept the exact
single contact while rejecting wrong ports and object counts. Attempt 1's
missing output still prevents retrospective proof of its exact root cause.

**The runtime attempt remained failed.** No INVITE, unregistration or RTP
was reached, and no third attempt was made. It ended after **25.5 seconds**,
without watchdog expiry. Both client lifetimes, PBX, private network and
generated credential files were removed; four existing containers remained
stopped and named existing networks retained their post-preflight identities.

The first network-free Python process required the bounded Docker stop's
forced exit **137**, without OOM. This is recorded, not called graceful
shutdown. An offline-only follow-up replaces it with file-signalled exit zero,
tested with a local Python subprocess that never resolves a host or sends
protocol traffic. Any later runtime preflight must require exit zero. Neither
the parser fix nor new clean-exit path was executed in another container.

[Diagnostic summary](./local/asterisk-build/sip-diagnostic-validation.json)
hash-binds the byte-exact original attempt-2 report, including actual CLI
observations and bridge snapshots. Matching executed orchestrator/client
snapshots remain private; later source revisions must not be substituted for
those execution hashes. Earlier reports/summaries remain historical.
Final validation passed **62 offline Python tests and 33 source/evidence
tests**, including the exact-row parser reproduction and local no-protocol
preflight exit-zero test.

Next runtime boundary remains explicit: a new approval would be needed to
exercise the corrected parser and continue registration/unregistration,
INVITE/BYE and synthetic PCMU echo. No deployment, Gate A/Gate C completion,
production media quality or redistribution authority is granted.

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
