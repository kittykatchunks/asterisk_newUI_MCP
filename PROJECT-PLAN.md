# Project plan: Asterisk management and AI platform

Planning baseline: 22 October 2026.

Status: planning with an initial local Asterisk runtime and authenticated SIP/RTP
proof implemented. No management web application, production deployment, or capacity
claim has been validated. See the README for executed tests and limitations.

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
claim that the revised screens or acceptance checks are complete.

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
