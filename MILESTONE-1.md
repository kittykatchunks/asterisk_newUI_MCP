# Milestone 1: isolated calling and engineering evidence

Date: 22 October 2026.

Status: proposed specification with the initial runtime foundation implemented.
Acceptance thresholds below remain planning proposals; the milestone is not
complete. See the README for the limited executed proof and exclusions.

Executed so far: runtime/module readiness, Local-channel recording and queue events,
restart persistence, and an optional authenticated UDP/PCMU echo-call proof per
customer with CEL/audio verification. None completes the browser-call acceptance
criteria or production isolation/capacity tests. A subsequent SIP.js/headless
Chromium test also verifies WSS registration and synthetic bidirectional encrypted
media with decoded audio energy. Its test-key trust and mDNS/ICE constraints are
documented in the README; the actual agent console remains unimplemented.

The initial engineering proof also captures local UDP SIP per customer, correlates
an accepted call to CEL through an explicit dialplan event, and exports a redacted
HTML signalling report with hashes. The 15-second duration limit is tested; hard
byte quotas, interactive incident controls, and general export safety are not.
The standalone report now supports dialog/message filtering, expandable provenance,
and complete print output, verified using Playwright. This is not an authenticated
multi-incident engineering workspace or a raw-message viewer.

A backend access-boundary integration proof now checks signed tokens against a
local synthetic JWKS issuer, provisioned customer memberships, bounded support
grants, and an awaited audit sink. It intentionally exposes no incident files or
capture operations. Keycloak login, durable grants/audit, and production sessions
remain outstanding.

A separate Keycloak 26.8.1 fixture now proves real browser authorization-code/PKCE
login for both synthetic customers and API rejection across customer boundaries.
Development-mode identity is removed after each run. Production identity storage,
TLS, MFA/federation, application sessions, and durable permissions/audit remain open.

The API now has customer-scoped incident metadata and separately authorised report
access through a trusted catalog. The Keycloak proof loads generated
packet/CEL reports and verifies actual browser viewing/filtering, sandbox storage
denial, metadata-only report denial, and cross-customer denial. The local SQLite
adapter persists approved incidents and commits access audit records before
delivery; close/reopen, atomic imports, tampering, and write-lock failure paths
are tested. The Keycloak proof uses reopened storage and checks twenty-two committed
audit decisions. A subsequent online SQLite backup and separate restore proof
checks both captured reports and exact audit history. Unit recovery tests also
remove the original database, restore independently, and reject incomplete or
tampered backups. Production ingestion/approval, off-host backup and full-system
recovery, sessions, and capture controls remain outstanding.

The persistent adapter now stages reports outside the public catalog and requires
a hash-bound approve/reject decision with reviewer/reason before publication.
Approval and publication are transactional; pending/rejected evidence remains
hidden. Schema-1 imports migrate to pending review rather than receiving invented
approvals, while access audits are preserved. Review state and receipts survive
backup/restore. Customer-scoped review endpoints now require a separate provisioned
review permission and derive reviewer identity from the verified access token.
Successful decisions commit access audit, review receipt, and publication together.
The Keycloak proof approves Alice's staged report through this boundary and denies
metadata-only Bob. A production review UI, reviewer provisioning/revocation,
production session operations, and ingress protection remain outstanding.

A subsequent browser review workspace proof lists pending candidates, displays
unapproved report source as inert text, and requires a review reason, scope check
and explicit confirm/cancel decision. Browser regressions cover malicious markup,
access/network/storage failures and stale decisions. The real Keycloak test
approves captured synthetic evidence through this workspace. Its session adapter
was initially test-connected in memory; a subsequent user-selected server-session
proof now supports ordinary browser Keycloak sign-in, reload and local sign-out.
The confidential-client exchange retains identity tokens server-side, uses
HttpOnly cookies and requires Origin/CSRF checks for mutations. Tests cover
callback binding, rotation/expiry, audit failure, cookie replay and real-browser
permission denial. Sessions are short-lived and process-local; production session
operations, global logout, full-fidelity interactive review and deployment remain open.

A restricted rendered preview now rebuilds allowlisted text/table content in a
sandboxed opaque-origin frame, without report scripts, source styling, resource
URLs or interactive controls. Packet details are expanded; original source
remains available. Browser tests verify readable evidence, blocked active content,
parent/storage isolation and structure limits. Approval still applies to the exact
original snapshot; preview simplification is not redaction or export approval.

Application-owned evidence search now highlights literal case-insensitive matches
without hiding rows or changing source/approval hashes. The sandbox remains
scriptless and opaque-origin. Browser tests cover matching boundaries, Unicode,
literal markup and the 1,000-highlight limit; the real identity proof searches
captured SIP evidence before approving the unchanged snapshot.

Pending-review cards now show allowlisted titles, incident IDs, timestamps and
snapshot hashes before evidence is opened. Metadata is read from integrity-checked
customer-scoped snapshots behind the existing reviewer permission/audit gate.
Browser checks reject malformed list summaries and metadata mismatches; storage
tests verify unknown fields are omitted and returned summaries cannot mutate
stored evidence. No report content is fetched into the preview until selection.

Pending-card filtering now matches loaded titles and incident/candidate IDs
locally, with visible/loaded counts and explicit no-match guidance. It makes no
API requests, preserves the open review and retains the filter on refresh while
clearing it on disconnect. Browser tests cover multi-candidate selection,
case/literal matching, no-match recovery and unchanged review reasons/hashes.

Loaded pending reports can now be sorted by creation time (oldest/newest) or the
existing default candidate-ID order. Timestamp comparisons account for offsets;
equal instants use candidate ID as a deterministic tie-breaker. Ordering combines
with filtering without changing the open review or fetching reports. Browser
tests cover offsets, ties, refresh persistence and unchanged review state.

Reviewers can explicitly close a candidate without deciding, removing report
source/frame and local form state while retaining the pending list/filter/order.
Entered reason or scope checks require discard confirmation. Browser tests cover
cancel/Escape, confirmed cleanup, focus return, no API traffic/decision and clean
state on reopening. This does not implement saved drafts.

The same discard guard now covers explicit pending-list refresh and candidate
switch/reopen actions. Cancel/Escape preserves local form and evidence-search
state without API traffic; confirmed actions issue only the ordinary GET and
never a review decision. Successful decisions bypass the guard for their normal
refresh. Session termination is deliberately not blocked.

A dirty local review now attaches the browser's native unload warning for
reload/document navigation. Clearing fields or closing/completing/disposing the
review removes it. Tests cover real cancelled/accepted reloads and dirty-session
logout cleanup. This is best-effort browser protection, not saved drafts or a
guarantee against tab/process loss.

A session-header warning now appears two minutes before the advertised deadline,
without extending the session or saving drafts. The real-login fixture checks the
threshold with a controlled browser clock and verifies dirty-review expiry removes
evidence/unload protection without submitting a decision. This UI test shortens
only the advertised deadline; server expiration enforcement remains separately
tested. Background browser timers are best-effort.

Session warning/expiry now rechecks its absolute deadline on page visibility and
page-show events, catching up after delayed timers. Controlled-clock tests skip
timer execution and verify both events show the warning or clear dirty evidence
without requests/decisions. Ended sessions remove timers/listeners and remain
closed on repeated events. This does not add cross-tab revocation polling.

Expired session-bootstrap deadlines are now refused before the workspace connects.
Exact-deadline and already-expired browser tests verify an explicit sign-in error
with no metadata/evidence requests or decision POST.

Session deadlines now run during initial workspace loading. A session abort
signal closes the workspace and cancels pending review fetches on expiry/logout.
Tests hold the initial list response across expiry and verify cancellation and no
late restoration; already-aborted connection tests verify no request is started.
This does not roll back a decision already committed by the server.

Application-session review 401s now terminate the local workspace immediately,
remove evidence/unload protection and offer sign-in again. Browser tests cover
list, candidate and decision rejection, including malformed bodies and no
automatic decision retry. Permission 403s retain the signed-in session.

Sign-out failures now explicitly distinguish unconfirmed logout from success.
Real-login tests inject an audit failure and a transport failure, verify no
automatic retry or false signed-out state, preserve dirty-review/session state
and confirm a subsequent manual retry clears evidence and denies session replay.

Session bootstrap now offers a manual retry-by-reload action on explicit errors.
Browser tests cover server/malformed/network failures without evidence requests,
no automatic retry, unauthenticated recovery to sign-in and authenticated recovery
with the existing session cookie. This does not persist drafts or replay decisions.

Review keyboard focus now follows loaded list, selected heading and visible
errors, with programmatic targets outside the normal Tab order and a visible
outline. Confirmation/discard dialogs default to Cancel; browser tests verify
heading-to-search Tab navigation, request/error focus and Enter cancelling without
a decision. Full accessibility validation remains outstanding.

Session startup/logout errors now display validated HTTP request references for
operational correlation, including malformed responses. Browser tests match a
failed logout's displayed ID to the server logger/header; missing/invalid headers
and transport failures show an explicit unavailable reference.

Review API malformed-JSON errors now preserve HTTP status and validated header
request references while omitting raw upstream content. Browser tests cover
list/candidate failures and a committed approval with a corrupted acknowledgement:
the UI warns of possible commit, clears decision controls and never retries.

Review transport failures/timeouts now carry explicit uncertain-outcome guidance.
Browser tests disconnect approval before server delivery and after commit,
verifying no automatic retry and differing durable outcomes. Session-driven
cancellation preserves the session cleanup message.

The browser regression now tests the real 15-second deadline with a committed
approval and held acknowledgement. It verifies explicit timeout, no automatic
retry or late UI restoration, then reconciles the pending list by refresh without
replaying the decision.

A separate last-confirmed-review status now survives failed follow-up list
refreshes. It records the acknowledged decision/candidate/hash before requesting
the list and advises against resubmission. Browser tests cover approved/rejected
durable outcomes with refresh failure/recovery and no duplicate POST. It is
connection-local acknowledgement, not a persisted review-history screen.

Valid JSON with an unrecognised success acknowledgement now receives the same
explicit uncertain-outcome treatment as damaged responses. Tests cover null,
arrays and wrong codes before/after commit, retained request references, no
automatic retry and preservation of the previous confirmed outcome.

In-flight review requests now expose workspace busy state and lock local form,
search and navigation controls. Submission explicitly awaits confirmation;
completion/failure restores controls and disposal clears busy state. Tests cover
stalled-decision inputs, timeout recovery and expiry during busy initial loading,
while session-header sign-out remains available.

Review reasons now show associated live length feedback and reject over-limit
input before confirmation. The exact encoded decision body is checked against
the existing 8 KiB API cap as well as the 2,000-character reason limit, without
truncation. Browser tests cover character boundaries, whitespace and oversized
escaped JSON while server validation remains unchanged.

Exact encoded-body tests now cover approve/reject at 8,192 versus 8,193 bytes,
including no truncation or POST on local rejection. A real boundary-sized browser
approval verifies the outgoing JSON and exact durable review reason/hash alongside
publication.

Confirmed review statuses now include the validated decision request reference
for correlation with the persisted access audit. Missing/invalid header references
remain explicitly unavailable without undoing a valid acknowledgement; later
refreshes retain the original decision reference.

Pending-list and candidate validation failures now retain validated header request
references too, including snapshot/scope/metadata mismatches. Browser probes cover
safe error text, unavailable references, cleared evidence and no decision POST.

Unicode reason coverage now distinguishes the UTF-16 code-unit limit from the
UTF-8 byte cap. The counter explains two-unit symbols; browser tests cover emoji
at/over the character limit, multibyte exact byte boundaries, and unchanged
durable storage of a maximum-length multilingual rejection reason.

Durable review history is now available through audited, customer-scoped,
GET-only routes and a read-only workspace section under `diagnostics:review`.
The latest 50 decisions are bounded with explicit truncation; exact candidate
lookup can reconcile older outcomes after reload or lost acknowledgements.
Snapshot/receipt integrity is checked and report contents are excluded. Empty
lookups do not prove submission failure or permit automatic retries.

History loading protects local drafts, renders reasons/identities as literal text
and never sends a decision POST. Store/API/browser tests cover persistence,
ordering/limits, exact lookup, customer/permission boundaries, corruption/audit
failures, hostile text and a committed approval after timeout. The real application
session proof verifies history after reload and denies access after logout.
This is a local durable history view, not external tamper-proof auditing,
revocation/correction, pagination or production identity persistence.

An additional source-loss recovery test now compares exact history before and
after backup/restore for 54 candidates and 53 decisions across two customers.
It removes the original test database before restoration, verifies bounded recent
history and every exact lookup (including older outcomes), preserves multiline
Unicode reasons/identities/hashes/timestamps, and rechecks pending/publication
state and restored-database reopening. Offsite disaster recovery remains unproven.

Backup inspection now aligns candidate UUID and receipt length validation with
history reads. Backup/restore tests reject oversized approved/rejected receipts
and malformed pending IDs even with matching artifact checksums, preserve valid
exact-limit Unicode records, and verify failed output cleanup.

History browser lifecycle tests now hold real API responses to verify old-result
clearing, busy control locks, restored controls/status focus on completion, and
late-response isolation after reconnect. No decision POST is sent by either path.

The next selected vertical slice adds read-only customer PBX status via restricted
AMI `CoreStatus`: authenticated/audited `diagnostics:read` access, server-managed
customer connection mappings, bounded reads, explicit unavailable errors and a
manual workspace check. Output is limited to observation time, PBX-local startup
time and active-call count; it is not SIP/RTP/trunk or capacity acceptance.

An isolated two-customer Asterisk 22 fixture verifies real AMI reads and denial
of unauthenticated, CLI-command and origination actions with reporting-only
credentials. Unit/API/browser tests cover framing, limits, concurrency, access
isolation, audit gating and safe output. The local launcher supports optional
ignored AMI configuration and interactive synthetic runtime demonstrations.
Production AMI TLS certificates/networking and continuous monitoring remain open.

A separate synthetic TLS transport proof now generates temporary trusted,
IP-SAN-mismatched and expired identities. Both fixed AMI reads succeed against
the trusted matching simulator; untrusted, wrong-identity and expired peers fail
before any credentials/application bytes are sent, with exact TLS failure causes
verified separately from sanitised adapter errors. Repeated rejection releases
the per-customer busy guard. Generated credentials are cleaned afterward.
The isolated two-customer runtime now additionally enables real Asterisk TLS
listeners on loopback ports 15048/15049 with separate fresh one-day IP-SAN
identities. Dedicated child-process fixture trust permits both fixed AMI reads;
reporting-only enumeration and foreign secrets remain denied. Missing trust fails
with the expected certificate error, no plain fallback, and repeat-safe adapter
rejection. Default local launcher/browser mappings remain plain loopback.
The shared generator preserves simulator coverage; ignored runtime keys/trust
regenerate per fixture run and must be protected. Remote networks, DNS/SNI and
production PKI provisioning/rotation remain unproven.

The opt-in `Test-PbxStatusProof.ps1 -WithIdentity -WithTls` run now joins
authenticated browser sessions and audited core/endpoint reads to real verified
AMI TLS. It checks both source mappings explicitly and retains customer/logout
boundaries; same-source outage/recovery also uses TLS. The owner temporarily
rewrites the ignored mappings, sets child-process trust, then restores exact mapping
text and prior environment in `finally`. Default and interactive modes are
unchanged; `WithTls` requires non-interactive `WithIdentity`. The encrypted hop is
backend-to-PBX only, not browser/identity loopback HTTP or production ingress.

The combined `Test-PbxStatusProof.ps1 -WithIdentity` proof now joins real Keycloak
browser sessions, the audited API and both real isolated AMI runtimes. Alice and
read-only Bob receive own-customer snapshots; request references match persisted
customer/subject audits, foreign scopes are denied and logout prevents replay.
Both fixture lifecycles are cleaned up and ordinary identity runs stay independent
of PBX availability. Remote TLS/production acceptance is still outstanding.

The real AMI fixture now verifies outage isolation and recovery with long-lived
separate core and endpoint sources: stop only customer A, reject both of its reads
while concurrent customer-B core/endpoint reads succeed in two rounds, each bounded
to five seconds. Restart A and recover both sources with unchanged credentials.
No stale healthy or successful empty-list fallback is accepted. Exact endpoint
inventory, customer scope, channel counts and contact-address redaction are checked
before and after restart and for B during outage. Both plain-loopback and combined
verified-TLS runs cover this behaviour. Docker control remains solely in the owned
test fixture, not the application adapter.

Browser outage coverage now verifies stale-success clearing during a held
recheck, busy controls, request-correlated 503 feedback and explicit manual
recovery to a new snapshot. It sends no decision POST or automatic recheck.
This uses injected browser responses alongside the separate real AMI outage proof.

The selected endpoint milestone now has an initial read-only endpoint/contact
visibility slice: audited customer-scoped GET, explicit workspace loading, and
allowlisted endpoint ID/device state/contact-presence/active-channel fields.
Contact URIs/auth details are excluded, completion/counts are checked, and
three-second/64 KiB/200-endpoint bounds fail closed rather than truncate.

Following explicit approval, a separate system+reporting AMI account is used:
upstream endpoint enumeration requires system authority. Core credentials remain
reporting-only. The separate credential has broader power outside this fixed-action
application and is not intrinsically read-only; production provisioning must
account for that risk. Real two-PBX/browser tests distinguish no-contact/static
contact endpoints and verify isolation, audit and logout boundaries. Static
contacts are not labelled registrations; dynamic registration/expiry/reachability
transitions remain distinct from contact-presence reporting.

The isolated fixture now proves real digest-auth REGISTER/unregister contact
transitions for both customers using separate generated SIP secrets and loopback
UDP ports. Foreign secrets are denied, own contacts appear/disappear, other-customer
dynamic contacts stay absent and static contacts remain unchanged. No calls, RTP
or application mutation endpoint are introduced. A second five-second registration
now proves natural contact expiry without refresh/unregister, with bounded
observation, response lifetime checks and unchanged foreign/static contacts.
The shortened lifetime is fixture-only. A third registration now proves real
OPTIONS qualification response, timeout and recovery: reported device state changes
from `Not in use` to `Unavailable` and back without losing the contact or refreshing
registration. A container-local loopback SIP probe avoids host UDP forwarding
limitations; only the exclusive test owner uses Docker, not the application.
Each transition is bounded to fifteen seconds and foreign/static contacts remain
unchanged. A verified registration-state UI and audio health remain outstanding.

An interactive loopback launcher now starts the development identity fixture and
application together, with explicit optional captured-report staging and no
automatic approval. Its local diagnostic database persists across restarts.
Regression tests verify real review, restart persistence, competing-launcher and
occupied-port refusal, unchanged-capture reuse and graceful shutdown. Development
identity subjects/passwords regenerate per run; this is not production identity
continuity or a deployment/recovery acceptance pass.

Parent document: [Project plan](./PROJECT-PLAN.md).

### Authenticated agent-console foundation

The selected next milestone starts with read-only own-assignment metadata, not
phone registration. A provisioned issuer/subject/customer directory and independent
membership-only `agent:access` permission gate `GET .../agent/profile`. Diagnostics
permissions and temporary support grants cannot grant agent-phone identity.
Only extension/display name are returned, after audit; missing assignments,
directory errors and audit failures are explicit. No SIP or AMI secret is exposed.
Focused tests cover scope, permission, mutation, allowlisting and failure boundaries.
The real confidential browser-session proof checks Alice's assignment, durable
audit, diagnostics-only Bob denial, foreign denial and logout replay denial.
Production provisioning workflow and session-bound SIP credential lifecycle
remain open; the default engineering launcher grants no agent access.

Assignment metadata now also has a separate versioned SQLite store and a trusted
operator JSON provisioning CLI. The selected insert-only policy permits identical
reruns but atomically rejects changed extension/display-name values, duplicates,
invalid entries and late-batch conflicts. Stored reads are validated and tested
across reopen; contention, corruption and schema errors fail explicitly.
The confidential browser-session proof now reads from a closed/reopened store.
This does not provision memberships, SIP credentials, device leases or launcher
access. Provisioning history UI and reassignment/conflict policy remain open;
diagnostic backups do not cover this separate store.

Schema version 2 now adds atomic successful provisioning receipts: generated
UUID/time, bounded operator/reason, canonical allowlisted batch JSON and SHA-256,
and inserted/unchanged counts. Identical reruns receive distinct receipts; receipt
failure rolls back new assignments. Migration preserves version-1 rows without
inventing receipts. Tests verify persistence, hash/input preservation, exact
metadata limits and forced receipt failure rollback; real sessions still read the
reopened store. Operator identity is a trusted CLI assertion, not independently
verified identity or tamper-proof history. Failed-attempt logging and history
API/UI remain absent.

Operator-only exact receipt lookup now validates stored metadata, context, counts,
unique assignments, canonical allowlisted JSON and hash before returning detached
receipt data. A read-only CLI refuses missing sources and old schemas without
creating or migrating them. Tests verify exact reopen output, unchanged database
bytes, corruption rejection (including recalculated hashes), invalid/unknown IDs
and readonly write rejection. Retaining a receipt UUID permits exact reconciliation;
unknown IDs do not prove failure and a completely lost UUID is not discoverable
through this command. No browser route, history listing or phone capability is added.

The separate agent database now has SQLite online backup and fresh-path restore
with manifest checksum/counts, SQLite integrity and full assignment/receipt read
validation. Operator CLI tests restore exact two-customer profiles and receipts
after deleting the original test database and exclude later provisioning from
the point-in-time artifact. Corrupt artifacts, recalculated hashes around invalid
content, old schemas and failed outputs are tested explicitly. No live replacement
or identity/PBX/session restoration is implied. Artifacts contain all customers'
identity metadata and require protection; offsite/full-platform recovery remains open.

An authenticated `/agent/{customer}` assignment screen now uses the existing
confidential session, fixed OIDC workspace selection and own-profile permission
boundary. It supports literal assignment display, explicit refresh and CSRF
sign-out, with stale-data clearing, bounded errors, expiry cleanup and no automatic
retry. Browser tests cover hostile text, mismatched scope, errors, 401, expiry and
unconfirmed logout; real sessions verify Alice's profile and Bob's denial.
Fresh browser contexts also prove console-initiated Keycloak PKCE login, fixed
console return, explicit refresh, CSRF sign-out, durable logout audits and rejected
session replay without browser bearer tokens or engineering-data requests.
Phone capability remains explicitly disabled: no SIP credentials, microphone,
registration, queue state or call controls are introduced.

A backend-only device-lease store now implements the selected reject-second-device
policy, scoped by issuer/subject/customer and bound to a backend session plus device
UUID. Separate SQLite transactions enforce exclusivity across processes; explicit
renewals are capped at 60 seconds and verified session expiry. Release/expiry permit
a fresh lease, and old IDs cannot mutate its replacement. This is not wired to
phone activation, logout release or SIP. It neither reserves an extension
nor disconnects an endpoint on expiry, and live leases are not assignment-backup
data. The selected future sign-out policy stops new offers, finishes the current
call and then releases the phone session; call-aware draining and credential
revocation remain unimplemented.

Optional backend acquire/renew/release POST routes now bind leases to a live,
customer-scoped application session, same-origin CSRF, `agent:access` membership
and a valid own assignment. Bearer-only callers are denied. Strict bounded JSON
cannot choose identity or session. A durable intent audit precedes mutation, and
the session is rechecked afterward to fence concurrent logout; the audit is not a
success receipt. Real Keycloak browser sessions prove Alice's lifecycle, Bob's
denial, persisted intent and rejected post-logout renewal. Logout leaves a
reservation to expire within its remaining 60 seconds; explicit release avoids
the wait. The default launcher does not configure this optional store.

The console now offers explicit reserve/renew/release buttons after a valid
assignment loads. Device and lease IDs remain in page memory; reload creates a
new device identity. There is no automatic acquisition, heartbeat, retry or
release. Local expiry and session termination clear stale displays, and held
responses cannot restore them after logout. Uncertain changes remain explicit
with request references and retry guidance. Browser tests cover lifecycle and
failure boundaries; the real Keycloak proof clicks Alice's buttons and verifies
Bob cannot see or use the reservation controls. This is a backend reservation,
not a connected phone, queue availability or a SIP registration.

An explicit `-WithAgents` local launcher mode now grants synthetic Alice only
`agent:access` in addition to her engineering permissions and requires her current
operator-provisioned assignment in a separate existing readonly database. Bob
stays denied. It opens the lease store after assignment validation and closes both
stores on shutdown/startup failure. Agent mode preserves existing validated fixture
subject IDs while rotating credentials; the default launcher/proof still generates
new identities and grants no agent permission. Real launcher acceptance verifies
the console, reservation persistence/session invalidation, stale/missing assignment
refusal, safe defaults and Bob's denial. This remains a local HTTP proof without
SIP or calling, not production identity continuity or membership administration.

The isolated Asterisk fixture now also proves temporary per-lease SIP identities:
a real backend lease supplies the username suffix, each issuance gets a fresh
secret, and only the fixture owner installs/removes PJSIP endpoint/auth/AOR
configuration. Challenged REGISTER verifies pre-provision, wrong-secret,
foreign-PBX and retired-credential denial, plus valid contact appearance.
Explicit release and real 60-second lease expiry trigger fixture-controller
removal/reload; a scheduled expiry task runs without client unregister, rechecks
persisted ownership through a separate SQLite connection and completes within ten
seconds of expiry. One explicit backend renewal extends the real deadline by at
least thirty seconds; registration and ownership survive the old deadline before
eventual revocation at the renewed deadline. SIP refresh alone cannot extend it.
AMI endpoint disappearance and bounded contact cleanup are checked without client
unregister. Reissued credentials differ and cannot revive the previous identity.
This is not a production revocation worker, restart/multi-lease reconciliation, active-call
draining or production provisioning interface. Browser activation remains disabled.

See [component evaluation](./COMPONENT-EVALUATION.md) for the documentation-based
shortlist, proof gates, and limited Asterisk runtime results.

## 1. Objective

Prove a complete local journey:

Create two isolated customer PBXs -> configure a basic queue route -> sign a browser
agent into a device -> receive and transfer a call -> record it -> reconstruct the
journey -> inspect incident-linked SIP evidence -> export an engineering report.

Prioritise reproducibility, clear failure states, and diagnostic visibility over
full administration coverage.

## 2. Confirmed environment and capacity

Read-only inspection on 22 October 2026 found:

| Item | Observation |
|---|---|
| CPU | AMD Ryzen 7 8845HS; 8 cores, 16 logical processors. |
| Usable physical memory | Approximately 15.2 GB. |
| GPU | NVIDIA RTX 4050 Laptop GPU and AMD integrated graphics; VRAM not inspected. |
| Free space on C: | Approximately 694 GB at inspection. |
| WSL | WSL2 distributions installed; all listed distributions stopped. |
| Docker | Client 29.6.2 installed with desktop-linux context; engine connection unavailable. |
| Test telephony | No SIP trunk, inbound number, desk phone, or existing softphone available. |
| IONOS | No product selected. |

No services were started or environment settings changed during inspection.

Production target: **50 concurrent calls per customer, including up to 10 AI calls**.
This milestone is a small functional proof, not validation of that target. It does
not establish aggregate customer capacity or GPU voice-model capacity.

Use browser endpoints and a reproducible software SIP test endpoint/caller.
Internal routes stand in for inbound trunk delivery. Public PSTN, carrier behaviour,
WAN NAT, cloud firewall rules, and internet WebRTC remain unverified.

Before running the stack, measure available memory and WSL resource allocation.
Use component profiles and bounded capture/storage rather than exhaust the shared
machine. Do not install dependencies or start unrelated services speculatively.

## 3. Scope

### Included

- Two customer Asterisk runtimes with separate credentials, configuration, and data.
- Pinned/reproducible container definitions, health checks, and named persistence.
- Minimal authenticated UI with customer administrator, agent, and engineer access.
- Customer-scoped extensions, one queue per customer, and a simple inbound test route.
- Draft/review/publish for that limited configuration model.
- Browser calling: registration, answer, hangup, mute, hold, keypad, and blind transfer.
- Agent queue login/logout and controlled reassignment between browser endpoints.
- Recording of selected synthetic test calls and authorised playback.
- Durable CEL and queue logging, correlated call history, and visible collection gaps.
- Incident creation, explicitly activated bounded capture, SIP ladder/raw-message view.
- Human-authored engineering conclusions and an exportable redacted HTML evidence pack.
- Structured evidence suitable for later AI analysis, without external model access.
- Health, failure, restart, and cross-customer denial tests.

### Deferred

- Autocab, real bookings, voice AI, MCP, and AI-generated fault judgements.
- Full SAML/social/MFA configuration; choose an identity foundation without claiming
  all federation features are delivered in this milestone.
- Native softphones, desk-phone hot-desking, attended transfer, conferences,
  listening/whisper/barge-in, complete IVR/voicemail/outbound administration.
- Full expert editor and automatic provisioning; controlled operator provisioning
  and detection of managed-file drift are sufficient initially.
- Visual flow editor, complete reports, wallboards, and year-long storage validation.
- Automatic diagnostic triggers, pre-trigger packet buffering, PDF generation,
  multi-point capture, and production high availability.
- Full translation coverage; UI strings must be externalised and locale-ready.

These deferrals sequence delivery; they do not remove requirements from the plan.
AI analysis follows once the evidence pipeline produces reliable, isolated inputs.

## 4. Minimal screens and workflows

| Screen | Essential behaviour |
|---|---|
| Customer setup | Engineer selects a provisioned runtime; status exposes incomplete/failed checks. |
| People and devices | Create test agents/endpoints; assign queue membership and inspect active assignment. |
| Route settings | Choose test entry, queue, timeout/fallback, and recording policy; review and publish. |
| Agent console | Show registration/audio readiness, queue availability, call state, and phone controls. |
| Call history | Search by time/outcome/identifier; show legs, queue visits, recording, and evidence links. |
| Engineering incident | Record symptoms/scope, start/stop capture, inspect ladder, annotate, export. |

Customer users cannot choose arbitrary runtime IDs, network interfaces, file paths,
or shell commands. Engineering access follows scoped support authorisation.

An AI handover panel is reserved in the console design but not populated with
fabricated AI content.

### Selected next increment: customer and agent workflow

Scope selected after freezing the synthetic REFER investigation: define a useful
agent workspace around the existing application session, own assignment and device
reservation APIs. This is a workflow specification, not evidence that the new UI
has been implemented or that Milestone 1 is complete. The acceptance checklist
below is the finite exit for the next UI increment; the broader M1 criteria remain
separate.

#### Three screen responsibilities

| Screen | Next-increment behaviour | Explicitly excluded |
|---|---|---|
| Customer entry/sign-in | Open the customer-bound agent URL, identify the selected customer, use the existing fixed agent-workspace login, and show sign-in or session-connection failure with explicit retry. | Customer creation, membership administration, arbitrary runtime selection or switching customer inside an authenticated session. |
| Own agent workspace | Show customer, agent display name and extension; explain the next available action; separate assignment, device reservation and disabled phone capability. Explicit refresh clears stale assignment data before loading. | Other agents' assignments, editable extensions, SIP secrets, registration, microphone requests, queue availability, call controls or invented call/booking data. |
| Reservation and recovery | Within the workspace, expose explicit reserve, renew and release; show confirmed expiry, conflicts, uncertain outcomes and request references; explain reload, expiry and sign-out consequences. | Automatic acquisition, heartbeat, takeover, retry, release-on-close, provisioning, or treating a reservation as a connected phone. |

The third responsibility is a workspace section, not a new route or modal
requirement. Reuse the existing HTML/JavaScript and authenticated endpoints; do not
introduce a frontend framework, database, new service or aggregate status API for
this increment. Customer configuration and insert-only assignment provisioning stay
operator-managed through existing tools. A future management-write UI requires a
separate permission, conflict, validation and audit contract.

#### Happy path and roaming boundary

1. The agent opens `/agent/{customer}` and signs in through the existing
   application-session flow. URL customer selection is not authorisation.
2. The server verifies membership and `agent:access`; the UI loads only the
   signed-in agent's own display name and extension. Identity remains
   issuer + verified subject + customer, not extension or browser storage.
3. The workspace explains that assignment is provisioned but phone capability
   is disabled. The agent explicitly reserves the current page's device identity.
4. A successful response shows the confirmed reservation expiry, capped by the
   current application session and the existing 60-second limit. Renew is explicit.
5. Before moving to another device/page, the agent explicitly releases, waits for
   confirmation, then signs out. The new page gets a new device UUID and must
   authenticate, load its assignment and acquire its own reservation.
6. If release is not confirmed, do not promise that another page can acquire.
   The second page may receive a conflict and must release at the owner or wait
   for expiry. No takeover or automatic recovery is offered.

This proves only reservation-level roaming, not moving an active call, SIP
registration or queue membership. The future live-phone sign-out policy remains
stop new offers, finish the current call, then release; this UI must not implement
that policy by hanging up calls or imply it already exists.

#### State and action contract

Assignment and reservation are independent state dimensions. A failed assignment
refresh must clear displayed profile data and prevent new acquisition, but must
not discard an already-known lease handle needed for an explicit release attempt.
All mutations remain subject to current server authorisation and assignment checks;
the UI cannot guarantee release if those checks now deny it.

| Observed state | User-visible meaning and allowed recovery |
|---|---|
| Session checking / signed out | No assignment or reservation is represented as confirmed. Sign in or explicitly retry session connection. |
| Session unavailable / mismatched | Clear sensitive workspace data, show an actionable error and request reference where available. Do not retry in the background. |
| Assignment loading / unavailable / forbidden / missing | Distinguish checking, connection failure, denied access and no provisioned assignment. Offer explicit refresh where the session permits it; never fabricate a profile. |
| Assignment loaded, no confirmed reservation | Show own profile and explicit reserve. Phone remains disabled. |
| Reservation request pending | Disable reservation actions to prevent duplicate concurrent mutations; retain context without declaring success. |
| Reservation confirmed | Show server-confirmed expiry and explicit renew/release. This is not phone readiness or queue availability. |
| Reservation conflict | Do not acquire or replace another owner; explain owner release or expiry and allow an explicit retry. |
| Reservation change uncertain | Explain that the server may have applied it. Retain the same device identity and any known lease ID for explicit retry; no success-shaped fallback. |
| Reservation expired locally | Remove confirmed reservation state and renewal/release controls for the expired ID. Explain that a new explicit acquisition checks server ownership. Local time alone is not PBX revocation evidence. |
| Released | Show release only after a validated server response. A new acquisition is explicit. |
| Session expired / confirmed sign-out | Clear assignment and local reservation data; late responses cannot restore them. Explain that server reservation release is not confirmed and may await expiry. |
| Sign-out uncertain | Do not claim logout. Retain explicit retry and warn that the application session may still be active; do not extend the original session deadline. |

#### Permissions, evidence and presentation

- Session/customer binding, existing `agent:access`, own-assignment lookup, and
  same-origin CSRF on mutations remain enforced by the backend. Browser controls
  are not an access boundary; bearer-only lease mutations remain denied.
- Display only existing allowlisted profile/lease fields. Use literal text for
  identity and server-derived values; never render them as HTML or expose secrets.
- A request reference helps investigation, not proof of success. Existing lease
  mutation audit records are requested intents, not verified provisioning receipts.
- Use semantic headings, labelled sections, status/alert announcements and
  keyboard-operable controls. Instructions and next actions must not rely on colour.
- Preserve the existing no-storage policy for page device/lease IDs and credentials.
  Reload creates a new page identity; it must not silently restore ownership.

#### Finite acceptance checklist for the next UI increment

The checklist below defines implementation verification for the revised
workflow UI. The executed evidence table following it records the current result.
Use browser tests for presentation and race behaviour, existing backend tests for
authorisation/ownership, and the existing local launcher proof for the real-session
happy path. Add no new SIP scenarios.

| ID | Required evidence |
|---|---|
| AW-01 | Customer entry identifies the customer; valid login returns only to the fixed agent workspace. Wrong-customer/session data is rejected and cleared. |
| AW-02 | Own assignment renders literal hostile-text fixtures safely. Missing assignment, forbidden access and unavailable service have distinct guidance; no foreign profile is disclosed. |
| AW-03 | Workspace separates assignment, reservation and disabled phone capability. No state displays ready/registered/available-to-queue merely because assignment or reservation exists. |
| AW-04 | Landing and refresh cause no lease mutation. Reserve issues one explicit request; valid success displays the confirmed expiry and exposes renew/release. |
| AW-05 | Renew retains device/lease identity and respects server session/60-second bounds. Local expiry clears confirmed state without automatic renewal, release or takeover. |
| AW-06 | Confirmed release clears ownership display. Failed, lost or malformed acquire/renew/release responses show uncertainty and request references without false success; explicit retries retain applicable IDs. |
| AW-07 | A second page/device cannot replace an unexpired owner. Explicit owner release or actual expiry permits a new lease; stale owner IDs cannot mutate its replacement. Cover with existing store/API tests and a browser conflict flow. |
| AW-08 | Assignment refresh failure clears stale profile and blocks acquisition while preserving a known lease handle for attempted release. Backend denial is shown, not bypassed. |
| AW-09 | Session expiry, 401 and confirmed logout clear workspace data. Held responses arriving afterward cannot restore profile/reservation; sign-out failure never claims success or extends session life. |
| AW-10 | Cross-customer, missing-permission, bearer-only mutation and missing/invalid-CSRF cases remain denied by backend tests; the UI exposes no new administrative or PBX authority. |
| AW-11 | Keyboard use can reach and operate visible actions; status/error text is discoverable through semantic roles. No SIP credential delivery, microphone access, registration, queue or calling request occurs. |
| AW-12 | Existing real-session launcher flow demonstrates sign-in, own assignment, explicit reserve/renew/release and sign-out, with denied-user coverage. Record actual commands/results, limitations, and stopped proof services; typecheck and focused regressions pass. |

Stop when AW-01 through AW-12 have recorded evidence or an explicit unresolved
blocker. Fix defects in scope, but do not grow this checklist with unrelated
telephony experiments. The next decision is whether to open the separately gated
phone-activation work or specify the simulated booking workflow; neither is
implicitly approved by completing this UI increment.

#### Executed workflow UI evidence

The bounded workflow increment is implemented using the existing console and
APIs: selected-customer context, a separate next-step section, explicit
reservation-level roaming guidance, and independent assignment/reservation/phone
descriptions. A failed assignment refresh preserves a known lease for release but
hides acquisition; the server can still deny the release. No live phone or
management-write capability was added.

| Check | Recorded evidence |
|---|---|
| AW-01 | Browser tests reject mismatched sessions and display the selected customer. Real Keycloak application-session and launcher proofs verify fixed agent-workspace login/return. |
| AW-02 | Browser tests render hostile names literally and distinguish 403, 404, 503 and malformed/mismatched profile data. Profile API tests deny foreign access. |
| AW-03 | The workspace exposes separate assignment, device and disabled-phone sections; next-step assertions explicitly retain disabled phone capability before and after reservation. |
| AW-04 | Browser tests assert no landing mutation, explicit acquisition and confirmed expiry; real-session tests exercise the controls. |
| AW-05 | Browser local-expiry/no-heartbeat checks and store/API identity/session-bound renewal checks pass. |
| AW-06 | Browser tests cover confirmed release, server/network/malformed response failures, request references and stable retry identity; no uncertainty is represented as release. |
| AW-07 | Store tests verify separate-process exclusivity, replacement/stale-ID denial and expiry. Browser conflict guidance and real launcher restart-conflict checks pass. |
| AW-08 | New browser sequence denies profile refresh with a held lease, verifies stale profile clearing and hidden acquisition, then attempts release and displays server 403 while retaining the lease handle. |
| AW-09 | Browser tests cover expiry, 401, failed/confirmed logout and held responses across logout; backend session tests cover rotation, expiry and audited logout gates. |
| AW-10 | Device HTTP/profile tests verify session/customer/permission/assignment/CSRF boundaries and bearer-only mutation denial. No new endpoint or authority was introduced. |
| AW-11 | Browser tests exercise keyboard activation of reservation controls, semantic status/alert/region selectors, and an explicit allowed-request list; microphone access throws a test failure and WebSocket creation is recorded as unexpected. This is not a comprehensive accessibility audit. |
| AW-12 | Typecheck, the focused agent/session suites, and the existing real Keycloak identity/application-session/launcher proofs passed. Application-session proof exercises reserve/renew/release/logout; launcher proof verifies opt-in, denied user and persistent conflict. Owned identity services were removed afterward. |

Reproduce the focused checks with `npm run typecheck` and
`node --test .\tests\agent-console.test.ts .\tests\agent-profile.test.ts .\tests\agent-device-http.test.ts .\tests\agent-device-lease.test.ts .\tests\local-agent-launcher.test.ts .\tests\application-session.test.ts`.
The real-session run uses `.\scripts\Test-IdentityProof.ps1`; it rotates only
synthetic identity fixture credentials and cleans up its owned identity deployment.
This closes the bounded UI checklist, not the broader M1 acceptance criteria,
production readiness, actual phone roaming or call-aware draining. REFER tests
were not expanded or rerun.

## 5. Proposed acceptance criteria

Tests use synthetic numbers/names and documented expected outcomes. Record actual
results, build versions, environment, and any waived criteria.

| ID | Scenario | Required evidence / proposed pass condition |
|---|---|---|
| M1-01 | Reproducible startup | From documented prerequisites, start two customer runtimes; required services become ready within five minutes or expose an actionable failed check. Image pulls excluded from timing. |
| M1-02 | Basic call path | Ten consecutive local test calls per customer reach the correct queue/agent, with two-way audio checked using test tones or spoken playback, not merely an answered event. |
| M1-03 | Simultaneous isolation | One active call per customer at the same time; no cross-customer signalling, media, history, or recording disclosure. |
| M1-04 | Call controls | Demonstrate mute/unmute, hold/resume, keypad against a test receiver, and blind transfer to a second authorised endpoint; record expected call outcomes. |
| M1-05 | Roaming | Agent logs out of endpoint A and into B; subsequent offer reaches B; historical records still attribute the earlier call to the correct agent/session. Conflicting assignment is rejected explicitly. |
| M1-06 | Durable history | Answered, unanswered, caller-abandoned, and transferred test cases retain expected CEL/queue evidence after restart. Legs and queue visits are not counted as separate inbound journeys. |
| M1-07 | Collector outage | Interrupt ingestion, expose unhealthy/stale status, then replay available durable records without duplicate history. Any unrecoverable interval is visibly marked. |
| M1-08 | Recording | Selected test calls produce playable assets linked to the right journey; unauthorised access is denied; upload failure is shown and retried/reconciled. |
| M1-09 | Publication | Invalid destinations cannot publish; stale revisions conflict; valid publication reports verified state. External edits block affected publication until reconciled. |
| M1-10 | Management outage | During a test call, stop the management backend; call media remains connected for a 60-second observation, and a new conventional call follows the loaded route. Agent UI controls may be unavailable. |
| M1-11 | Scoped capture | Engineer starts capture for one customer/incident; observe a selected call, stop manually, and verify proposed ten-minute/100-MiB limits in separate tests. Stop when either limit is reached. |
| M1-12 | Signalling display | Selected call shows directions, timestamps, requests/responses, raw SIP/SDP, and available leg correlations. Missing messages and capture truncation/drops are not hidden. |
| M1-13 | Encryption visibility | With encrypted signalling, network payload is not represented as plaintext; authorised application signalling records are labelled separately. No disabling encryption to satisfy the test. |
| M1-14 | Known faults | Reproduce an unavailable destination and an unanswered call; export actual observed sequences without inferring unsupported provider blame. Reserve a one-way-media test for the media topology proof. |
| M1-15 | Evidence export | Authorised HTML export includes incident scope, timeline/ladder, evidence references, capture limits, engineer conclusion, and integrity manifest. Redacted output excludes secrets/unrelated customer data. |
| M1-16 | Permission boundaries | Automated negative tests cover customer ID substitution and guessed call/recording/incident/export identifiers; no data disclosure or unauthorised action. Capture agent exposes no arbitrary execution interface. |
| M1-17 | Recovery | Restart services without destroying volumes; restore a backup into a separate test environment and verify configuration, call metadata, and a recording. |
| M1-18 | Agent errors | Microphone denial, endpoint registration failure, and backend disconnection show distinct actionable states; none displays false readiness. |

The capture limits and five-minute readiness threshold are proposed initial defaults.
Agree or revise them before using them as release gates. Packet-size limits must
be enforced without presenting an abruptly truncated capture as complete.

### Evidence-gap review after the synthetic booking workspace

Review date: 25 October 2026. This is a mapping of existing proof code and recorded
results to the exact M1 criteria, not a new acceptance run. Earlier paragraphs
describe historical increments; the completed AW and BS/SW checklists do not make
the live calling milestone complete. At this review, none of M1-01 through M1-18
had a recorded complete end-to-end acceptance pass against its full wording.
The subsequent M1-10 local conventional-route result is recorded below; the other
17 gates remain incomplete.

| Gate | Existing partial evidence | Missing evidence / implementation |
|---|---|---|
| M1-01 | Pinned two-runtime Compose health checks and bounded startup scripts. | Agreed five-minute full-service readiness gate and measured complete startup, not just PBX health. |
| M1-02 | Authenticated UDP echo and separate WSS/encrypted browser media fixture. | Ten consecutive calls per customer through the intended queue and agent, not an echo destination. |
| M1-03 | Separate networks/volumes, cross-customer credentials/API denial. | Concurrent active call/media plus history/recording disclosure checks in one correlated acceptance run. |
| M1-04 | Frozen synthetic REFER transaction/media matrix. | Actual agent mute, hold/resume, receiver-verified keypad and authorised endpoint transfer controls. |
| M1-05 | Session/device exclusivity, release/expiry, provisioning/registration fixtures. | Live queue offers after endpoint move and historical attribution across the move; no phone activation is implied by reservations. |
| M1-06 | Fresh CEL/queue/WAV records and restart checks; transfer correlations in fixtures. HF adds durable CEL import/replay/scoped reads; QF adds separate raw queue import, zero replay duplicates and persisted entry/timeout after owned PBX restart. | Durable application ingestion/history for all four outcomes with journey/leg/queue-visit accounting after restart; HF/QF do not reconstruct journeys or queue visits. |
| M1-07 | Durable source logs and isolated AMI outage tests; subsequent CR operator local-file recovery adds atomic checkpoints/status, exact replay, explicit stale/failure states and permanent unknown-coverage generation gaps. | Production/remote collector lifecycle, automatic segmented/rotated sources, complete history/queue integration and acceptance against full M1-07 wording; local copied-file health is not remote source freshness. |
| M1-08 | Synthetic WAV payload/format checks and unchanged hashes across restart. | Journey-linked authorised playback and recording upload failure/recovery workflow. |
| M1-09 | Revision/approval patterns for diagnostic reports and narrow provisioning. | Route/queue configuration publication, runtime verification and external-edit drift handling; report approval is not PBX publication. |
| M1-10 | Subsequent isolated real outage proof passes MO-01 through MO-06 below: 60-second media continuity and new authenticated echo calls with management stopped. | Local conventional echo-route scope only; no queue/agent, public trunk or production failover claim. |
| M1-11 | Operator-run customer/incident capture, duration-limit path. | Authenticated interactive start/stop and agreed ten-minute/100-MiB hard-limit evidence; sampled soft threshold does not satisfy a hard quota. |
| M1-12 | Correlated packet/CEL reports, provenance and inert review preview. | Complete authenticated selected-call raw SIP/SDP and leg view with missing/truncated/dropped evidence represented explicitly. |
| M1-13 | Encrypted browser media/signalling fixture; packet proof explicitly UDP-only. | Evidence display distinguishing encrypted network payload from authorised application signalling without disabling encryption. |
| M1-14 | Frozen busy/no-answer transfer fixtures with recorded limitations. | Selected unavailable/unanswered incident exports through the intended evidence workflow; no automatic extension of REFER research. |
| M1-15 | Redacted generated reports, hashes and permission-controlled approval/viewing. | Incident conclusions, complete evidence/capture-limit export contract and executed disclosure checks for that export. |
| M1-16 | Automated incident/report/session/agent/simulation customer and owner denial. | Call, recording, export and capture-operation boundaries as those surfaces are implemented; absent surfaces are not passed tests. |
| M1-17 | PBX restart persistence; diagnostic/agent SQLite backup and separate restore. | Separate-environment restore of PBX configuration, call metadata and a playable recording together; database-only restore is insufficient. |
| M1-18 | Session/backend/assignment/reservation failures are distinguished. | Live console microphone denial, SIP registration failure and backend disconnection with no false phone readiness. |

Prioritise a finite independence proof (M1-10) before choosing either the larger
history/collector implementation (M1-06/07) or gated live-phone activation
(M1-02/04/05/18). This ordering does not waive the other gates or enable voice AI.

### Selected next increment: management-outage continuity

Implement an operator-run, isolated local proof of **M1-10**. It must stop only the
management process owned by the proof, not a user's running launcher, identity
service or PBX. Use a uniquely named Compose project with dedicated credentials,
networks and volumes; never restart or rewrite the ordinary shared proof deployment.
Keep Docker control in the test owner, not the application, and remove owned
containers/networks/volumes when finished. No new dependency or service is required.

The conventional route is the existing authenticated synthetic UDP/PCMU `echo`
route in the loaded dialplan. It is not queue/agent delivery, live browser calling,
public trunk behaviour or a production outage/failover claim. Both customers must
be exercised concurrently without revisiting REFER.

| Check | Finite required evidence |
|---|---|
| MO-01 | Actual application HTTP server serves its normal page/session route before interruption; capture its owned PID and verify exit plus HTTP unavailability after stopping it. An invented boolean/mock outage is insufficient. |
| MO-02 | Establish one authenticated call per customer and prove echoed synthetic media before stopping management. Keep the same dialog active across stop. |
| MO-03 | After management exit is confirmed, observe at least 60 monotonic seconds per active call. For every one-second send window, require at least 40 sent frames and at least 70% byte-identical distinct payloads echoed; fail any receive gap over one second during observation. Report actual counts/duration/gap, not just answered state. |
| MO-04 | While management remains down and original dialogs continue, establish a fresh conventional call per customer and require the existing at-least-70-of-100 distinct RTP echo threshold. Verify different Call-IDs and clean teardown. |
| MO-05 | Correlate original and new dialogs to fresh customer-local CEL start/answer/hangup/end records using the existing dialplan Call-ID event. Prove management stayed unavailable throughout and was not restarted to complete calls. |
| MO-06 | Typecheck and focused harness validation pass; execute the real two-customer outage proof, retain non-secret results and exact limitations, clean up owned resources on pass/failure and document reproduction. Leave failures explicitly unverified. |

Stop after MO-01 through MO-06 or an explicit blocker. The 60-second duration is
the existing M1-10 requirement; per-window media thresholds above are selected
proof checks, not production quality-of-service objectives. Success closes only
M1-10's local conventional-route scope; all other M1 gaps remain separate.

### Management-outage continuity evidence

MO-01 through MO-06 are complete for the selected local conventional-route scope.
Reproduce with `.\scripts\Test-ManagementOutageProof.ps1`; run the five focused
threshold/parser/correlation tests with
`python -B -m unittest discover -s tests -p test_management_outage.py`.
The real command includes typecheck and uses a unique Compose project without
touching shared services. Full prerequisites and retained report details are in
the [README](./README.md#isolated-management-outage-continuity-proof).

Final recorded run: `run-2KzA6j`, project `asterisk-outage-2kza6j`.

| Check | Recorded evidence |
|---|---|
| MO-01 | Actual management page returned 200 and session route 401. Owned PID 7572 exited with code 0; 562 HTTP connection-refusal checks covered the outage, with no restart. |
| MO-02 | Both original authenticated dialogs were active concurrently before shutdown; customer-a/b baseline echoes were 106/99 distinct payloads. |
| MO-03 | Controller measured 61.080 seconds down; each customer observed 60.502 monotonic seconds and all 60 one-second windows passed. Each sent/echoed 2,698/2,698 distinct frames, with minimum 44/44 per window. Maximum receive gaps were 0.023204 seconds (a) and 0.023191 seconds (b). |
| MO-04 | A distinct new Call-ID per customer completed while original calls continued and management stayed down. Both default media checks returned 100/100 distinct echoes; all original/new BYEs returned 200. |
| MO-05 | Both dialogs per customer correlated exactly through the named `PROOF_SIP_DIALOG` event and decoded JSON Call-ID to distinct fresh channel identities with one each of CHAN_START, ANSWER, HANGUP and CHAN_END. |
| MO-06 | Typecheck and five focused tests pass; two complete real runs pass after correcting the initial CEL event-label assertion. The final non-secret report includes per-window media and CEL evidence. Independent checks found no owned management PID, containers, networks or volumes; generated credentials/database were removed and only the run report remained. |

The initial real run failed only at the harness's incorrect generic CEL event-name
assertion after its media stage; it was not counted as an acceptance pass. Exact
named-event/JSON correlation now has positive and negative regression coverage.
Completed customer media measurements survive later CEL assertion failures.
Cleanup attempts remaining owned resources after a cleanup error and marks the
run failed rather than reporting success.

This closes only M1-10's selected local conventional echo-route proof. It does not
enable agent phones or establish queue delivery, identity outage resilience,
trunk behaviour, HA/failover or production QoS. All other 17 gates retain their
listed gaps. The frozen REFER matrix was not expanded or rerun. Stop here before
selecting another finite increment.

### Selected next increment: operator-only durable CEL foundation

The user selected `history-foundation`, with the recommended operator-only
boundary. Build the durable evidence substrate for M1-06, not a completed call
history UI or M1-06/07 acceptance. Use a separate SQLite database and trusted
operator import/read commands; no browser, HTTP ingestion endpoint, phone
activation, new permission or automatic collector is authorised in this increment.

| Check | Finite required evidence |
|---|---|
| HF-01 | Persist exact eight-field CEL CSV records, source/customer/generation identity, byte offsets, original source timestamp text, ingestion timestamps and hashes. Explicitly declare source time basis; do not invent UTC conversion. |
| HF-02 | Bound snapshots to 8 MiB, records to 64 KiB, new records per import to 50,000 and source/event pages to 200 entries. Parse quoted CSV, doubled quotes, CRLF and embedded newlines without splitting events incorrectly; reject malformed complete records/UTF-8 explicitly. Report an unfinished trailing record as pending, never as ingested. |
| HF-03 | Commit new records and source prefix checkpoint atomically. Exact replay inserts nothing; identical records at distinct offsets remain separate evidence. Restart/retry and competing writers must not duplicate records or advance checkpoints on failure. |
| HF-04 | Bind each source/generation permanently to one customer and declared time basis. Verify previously consumed bytes by SHA-256; reject changed/truncated prefixes. Require an explicitly new generation for operator-recognised replacement; no silent rewind, rotation adoption or gap-free claim. |
| HF-05 | Customer-scoped, bounded source/event/channel reads never return another customer's records, even when channel/linked identifiers collide. Keep source generation in every correlation. Channel lists are evidence, not business journeys or inferred outcomes. |
| HF-06 | Dedicated database identity/version, strict input/stored-record validation and read-only operator reads fail explicitly on corruption, wrong database, invalid arguments or storage failure. Preserve existing app/storage behaviour. |
| HF-07 | Focused parser/store/CLI tests and typecheck pass, including malformed input, partial-tail append, rollback, concurrency, process restart and cross-customer denial. |
| HF-08 | Generate fresh CEL with short authenticated calls in an isolated two-customer deployment; import, replay and reopen the store, verifying exact lifecycle/correlation records. Retain a non-secret summary and clean owned services/credentials. Do not rerun REFER. |

Stop after HF-01 through HF-08 or a documented blocker. Queue log ingestion,
journey/leg/queue-visit reconstruction, unanswered/abandoned/transferred outcome
classification, authenticated HTTP/UI, retention/backup policy and continuous
collector replay/health/gap reporting remain separate. Linked IDs alone are not
business journey IDs; this foundation must not expose misleading journey counts.
The trusted operator supplies the source/customer association; these CLI reads
are not a user authorisation boundary.

#### Durable CEL foundation evidence

HF-01 through HF-08 pass for the operator-only foundation. Typecheck and 13
focused tests pass. Final run `run-3W2Yk6` (project `asterisk-history-3w2yk6`)
imports six fresh CEL records
(824 bytes) per customer, then separate importer processes replay with zero
inserts and read-only stores reopen the evidence. Two-entry pages reproduce the
complete source bytes exactly. Each call's named Call-ID event correlates one
fresh channel with CHAN_START, ANSWER, HANGUP and CHAN_END. Channel IDs actually
collided between the isolated runtimes; customer/source/generation-scoped reads
kept them separate and foreign-customer requests failed.

Tests cover exact byte/record/page limits, quoted CSV/multibyte pending tails,
malformed records/UTF-8, changed/truncated prefixes, immutable source association,
explicit replacement generations, distinct-offset identical rows, injected SQL
failure with unchanged checkpoint, competing importer processes and process
death during an uncommitted transaction. Reads validate stored raw record hashes,
offset extents, channel indexes and ingestion timestamps; unsupported databases
and invalid/read-only writer operations fail explicitly.

Reproduce using `.\scripts\Test-CelHistoryProof.ps1`; the
[README](./README.md#operator-only-durable-cel-history-foundation) documents
operator command shapes, limits, source declarations and sensitive-data handling.
The proof retains a synthetic history database and non-secret summary; it removes
only its own Compose resources and generated credentials/snapshots.
Independent final-run inspection found no owned containers, networks or volumes;
only the synthetic database/report remained, and a subsequent CLI process read
its persisted source checkpoint successfully.

This is partial evidence toward M1-06, not completion of M1-06/07 or another broad
milestone gate. The 17 remaining M1 gaps are unchanged. Do not use linked-ID or
channel counts as inbound-journey totals. No automatic collector, queue/outcome
reconstruction, HTTP/UI, phone activation or REFER rerun was added.

### Selected next increment: operator collector recovery

The user selected operator-only local-file collection and explicit gap-recorded
replacement. Keep HF limits and source/customer/generation scoping; no HTTP/UI,
phone activation, queue ingestion or journey reconstruction is authorised.

| Check | Finite required evidence |
|---|---|
| CR-01 | Persist operator-configured local absolute source path, customer/source/generation, time basis and freshness threshold in the dedicated CEL store. Migrate schema 1 atomically without changing existing evidence; read-only tools remain able to read schema 1/2. |
| CR-02 | Explicit collection passes read bounded local file bytes and reuse exact-prefix ingestion. Commit checkpoint/evidence and successful collection status atomically; failures never advance checkpoints and fail the command. An optional bounded foreground run repeats passes without leaving a background service. |
| CR-03 | Persist attempt/success timestamps, failure code and pending bytes. Read-only status distinguishes never-collected, collecting (attempt recorded, not process liveness), unhealthy, stale, pending, healthy and clock-skew. Exact freshness expiry is stale; healthy means recently observed source, never completeness. |
| CR-04 | Fence asynchronous attempts with durable revisions; superseded replies, failed writers and old-generation work cannot overwrite newer evidence/status. Process death leaves an unfinished attempt that becomes stale; restart replays retained records without duplicates. |
| CR-05 | Missing/unreadable/oversized/malformed source and changed/truncated consumed prefix are explicit failures. No automatic reset, rotation adoption or success-shaped empty fallback. Earlier evidence stays readable. |
| CR-06 | Operator-only transition requires a fresh generation, operator reference and reason; atomically retain an immutable unknown-coverage gap marker with previous last-success/observation times and both generations. This is not an exact missing-call interval. Future healthy collection never erases gaps. Customer-scoped bounded gap reads and status expose them. |
| CR-07 | Typecheck and focused tests cover migration, freshness boundaries, skew, pending tails, malformed inputs, fail/retry, concurrency fencing, transaction rollback, restart/death and tenant isolation. |
| CR-08 | Isolated real two-customer calls generate additional durable CEL while collection is absent; restarted collection reports staleness then imports retained records exactly once. Missing/replaced source failure and explicit gap-recorded recovery preserve old evidence. Retain measured non-secret results and clean owned services/credentials without REFER reruns. |

The operator supplies source/customer association and supervises local-file
availability. No scheduler, remote collector deployment, production segmentation,
automatic rotation, trustworthy gap-free interval or complete M1-07 acceptance is
claimed. Stop after CR-01 through CR-08 or an explicit blocker.

#### Operator collector recovery evidence

CR-01 through CR-08 pass for the selected operator-run local-file scope.
Typecheck and 25 focused history/collector tests pass, including failed migration
rollback and failed status/gap writes. Process-death evidence leaves a committed
unfinished attempt that reads stale at exact expiry; restarted collection inserts
only new retained records. Separate connections prove older completions/failures
and old-generation work cannot overwrite current evidence/status.

The real two-customer proof stops collection processes between calls. After the
second calls, each source reads stale with six records still persisted; refreshing
local snapshots and restarting collection imports six additional CEL records each.
All twelve original records per customer round-trip exactly and another replay
inserts zero. Both calls have separate named Call-ID correlations and full channel
lifecycles. Missing local files and a deliberately discontinuous replacement fail
without advancing checkpoints. Explicit generation transition allows eleven
replacement records to import with recent healthy status while permanent
unknown-coverage gaps and all twelve old-generation records remain visible.
Foreign-customer gap reads are denied.

The replacement fault is injected into copied local snapshots, not by destroying
PBX logs. Last-success/observation bounds are not exact missing-call intervals.
Healthy means recently read local source, not reliable remote delivery or complete
history. See the [README command/status contract](./README.md#operator-run-cel-collector-recovery)
and reproduce with `.\scripts\Test-CelCollectorProof.ps1`.
The proof retains only a synthetic database/non-secret report while removing its
owned Compose resources and generated credentials/snapshots.
Final recorded run `run-xlF4Kd` (project `asterisk-collector-xlf4kd`) measured
4,423/5,652 ms since last success before restarting a/b collection, against the
1,000-ms proof threshold. Independent inspection found no owned containers,
networks or volumes and only the database/report retained. Separate subsequent
read-only commands verified stale status and persistent customer-scoped gaps.

The CR increment's CEL schema 2 atomically added collector/gap state; QF below
subsequently upgrades to 3. Current read-only history tools read 1/2/3 and collector
reads require 2/3, while writers migrate to the current schema. Other application
stores and permissions are unchanged.
This adds partial evidence toward M1-07, not full milestone acceptance. The 17
remaining broad M1 gates remain incomplete; no phone, HTTP/UI, queue/journey
reconstruction, remote collector deployment or REFER rerun was added.

### Journey design and reconstruction contract

The user selected **documentation only**, explicit trusted inbound-entry markers
and separate outcome facts. The detailed
[journey reconstruction design v1](./PROJECT-PLAN.md#journey-reconstruction-design-v1-not-implemented)
defines source/epoch pairing, entities, instrumentation, queue/CEL relationships,
projection semantics, metric exclusions and staged delivery.
Design recorded 25 October 2026; **no implementation or new acceptance pass** is
claimed here. JD checks below are future implementation exit criteria, not a
completed checklist or authorisation to activate agent phones.

Core invariants:

- An explicit customer/runtime/epoch-scoped entry marker admits one inbound
  journey. A linked ID, caller number, channel, queue visit or bridge cannot.
- Legs, repeated queue visits and parallel offers have independent identities.
  Two confirmed inbound roots joined by consultation remain two journeys.
- PBX answer, human queue service, queue exit, transfer activation and target
  connection are separate facts; evidence quality and source gaps accompany them.
- Keep immutable raw records and stable derived identities across replay/rebuild.
  Unknown, missing and conflicting evidence stays visible rather than becoming
  invented success/failure or a misleading denominator.

| Check | Future finite required evidence |
|---|---|
| JD-01 | Source-kind/runtime/epoch manifest binds CEL/queue streams to one customer, preserves original generations/offsets and explicitly maps restart boundaries. Missing/ambiguous pairing leaves relationships unresolved; legacy HF rows are not silently assigned epochs. |
| JD-02 | Operator-only queue import preserves exact bytes, five fixed fields and variable/empty parameters, including sensitive optional caller-name data. Bounded parse/import/read, atomic checkpoint, partial tail, failure rollback, unknown events and replay/restart proofs match the CEL foundation's discipline without parsing queue logs as CSV. |
| JD-03 | Versioned trusted entry marker on an approved isolated inbound route creates one stable root. Caller-controlled marker spoofing, incompatible duplicate roots and malformed marker payloads are rejected/flagged; unmarked legacy evidence is queryable but absent from confirmed inbound counts. |
| JD-04 | One served fixture yields one root despite caller/member/Local legs and parallel offers. CONNECT/member uniqueid and CEL relationships support service; route Answer alone produces no human-service claim. Media success remains separately measured. |
| JD-05 | One journey visits the same queue twice and/or changes queue: two ENTERQUEUE/visit identities, one root, no nearest-time joining of ambiguous open visits. CONNECT/terminal records attach only with supporting context; unmatched events remain visible. |
| JD-06 | Empty-queue timeout, key exit, member ring-no-answer and caller abandonment have distinct visit facts. Current Answer-before-Queue timeout is never labelled human answered or caller abandoned. A declared unanswered-target fixture proves its own no-service terminal contract. |
| JD-07 | Blind transfer fixture retains source root, source/member/target relationships and separate target service result; failed/unanswered targets do not become served from BLINDTRANSFER or SIP 202 alone. Queue re-entry after transfer remains the same root with a new visit. |
| JD-08 | Attended consultation, Local optimization and two independently marked inbound calls entering a common bridge preserve both roots and stable leg relationships; no linked-ID/bridge transitive merge invents or deletes inbound journeys. Use a separate fixture, not a rerun/expansion of the frozen REFER matrix. |
| JD-09 | Answered/served, unanswered target, pre-service abandoned and transferred M1-06 fixtures have predeclared roots/legs/visits/facts, exact correlated raw evidence and expected unknowns. Repeat after collector/application restart without duplicate roots/visits. A later abandoned visit never erases earlier service. |
| JD-10 | Two customers and two PBX epochs deliberately reuse channel/linked/queue identifiers; all raw/derived reads, references and counts remain isolated. A rotated generation is not treated as a new PBX epoch, and a reused root with contradictory provenance is conflicting rather than auto-merged. |
| JD-11 | Reordered CEL/queue arrival, delayed relationships, equal timestamps, missing terminal/entry/CONNECT and contradictory terminals yield deterministic explicit unresolved/partial/conflicting states. Rebuilds retain stable IDs and evidence; no last-write-wins fabricated outcome. |
| JD-12 | Full replay, different batch sizes, competing rebuilds and injected crash/commit failure preserve exact raw evidence and publish complete atomic projection revisions. Same evidence/manifest/algorithm yields equal entities/facts/counts; failed rebuild leaves prior revision readable with truthful freshness. |
| JD-13 | Collector outage replays retained CEL and queue evidence without duplicate roots/visits. Unknown generation gaps persist on old/new projections, even with healthy collectors. Uncertain time/epoch association cannot silently exclude a gap or become a precise loss interval. |
| JD-14 | Totals disclose confirmed roots separately from legs/visits/offers and unresolved/conflicting evidence; synthetic entry filters do not mix into external totals. Unknown coverage/denominators block unjustified service-level or abandonment rates. No unagreed short-abandon/service-level/occupancy rules are invented. |
| JD-15 | Pinned runtime adapter verifies queue parameter shapes/units, CEL relationships and fields actually available. UTC/time-basis conversion and both UK DST transitions preserve ambiguous/missing times explicitly; cross-source ordering and timestamp subtraction do not invent durations. |
| JD-16 | When authenticated history presentation is separately authorised, explicit scope/read permission, session/audit boundaries, guessed IDs, customer substitution and inert raw-value display pass before exposing caller data. Until then, operator CLI access is not described as tenant authentication. |

Implementation stop boundaries:

1. Select **QF operator queue evidence** next; specify its finite limits, source
   kind and migration contract before coding. No derived totals or live route
   change in QF.
2. Select **JI instrumentation/reconstruction** separately, with new isolated
   routes and an epoch manifest; marker schemas and trust checks are part of that
   contract, not caller-controlled API inputs.
3. Select **JR outcome/recovery acceptance** only after QF/JI evidence. Reassess
   M1-06/07 against their full wording rather than marking them passed because
   individual JD checks exist.
4. Select **HP authenticated presentation** independently before adding a user
   history surface.

Existing evidence remains unchanged: empty Local-channel queue timeout/restart,
synthetic echo CEL lifecycle, HF durable CEL import and CR local-file recovery
are partial foundations. None currently proves all four history outcomes,
queue/member service, full journey reconstruction or production collection.
The 17 broad M1 gaps remain incomplete. No runtime files, dependencies, services
or frozen REFER tests were changed or executed in this design increment.

### Selected next increment: operator queue evidence foundation

The user selected extending the dedicated history database, with separate queue
source/event tables. QF is raw evidence ingestion, not reconstruction or queue
collector deployment. Preserve CEL/collector interfaces and explicit kind scoping.

| Check | Finite required evidence |
|---|---|
| QF-01 | Atomically migrate history schema 1/2 to 3 with separate queue tables; preserve CEL evidence/checkpoints and collector/gaps. Current CEL readers support schemas 1/2/3; queue reads require schema 3. Unsupported/foreign databases fail explicitly. |
| QF-02 | Preserve exact UTF-8 LF/CRLF queue records, original Unix timestamp text, five fixed fields and variable/empty parameter array, source/customer/generation, offsets, hashes and ingestion timestamps. Unknown/admin events and NONE/REALTIME IDs remain raw evidence, not calls/outcomes. |
| QF-03 | Bound full snapshots to 8 MiB, records to 64 KiB, new records/import to 50,000, parameters/record to 256 and source/event pages to 200 entries. No CSV quoting/escaping inference. Reject malformed completed input, UTF-8/BOM/control characters explicitly; unfinished tails remain pending. No event-specific semantic reconstruction in QF. |
| QF-04 | New records and prefix checkpoint commit atomically; identical replay/restart inserts zero, identical rows at different offsets persist separately, competing importers cannot duplicate. Reject changed/truncated consumed prefixes and source/customer rebinding; explicit unused generations are operator decisions, not automatic rotation or gap-free recovery. |
| QF-05 | Queue source/event/call-ID reads are customer/source/generation scoped and bounded; colliding queue/CEL IDs cannot join kinds, tenants or generations. Kind is always explicit in queue responses; runtime/epoch pairing remains unassigned, not inferred from matching names. |
| QF-06 | Read-only operator CLI, stored evidence validation, failed writes/transaction rollback, invalid arguments, process death/restart, migration/failed-migration rollback and original CEL/collector regression tests pass with typecheck. |
| QF-07 | Isolated two-customer real queue timeout fixture produces ENTERQUEUE/EXITWITHTIMEOUT and supporting CEL. Separate importer processes import/replay/reopen, verify exact bytes and scoped evidence after PBX restart. Retain non-secret results and synthetic database; clean owned services/generated files without touching shared deployment or REFER. |

Stop after QF-01 through QF-07. No journey/visit projection, human-service claim,
entry instrumentation, runtime/epoch manifest implementation, queue collector
health/gap adapter, HTTP/UI or phone activation. Existing collector status applies
to CEL only. Upgraded old binaries reject schema 3; no downgrade is supported.
Queue parameters may contain sensitive caller data; this trusted operator tool
is not a tenant authentication boundary or redacted export.

#### Queue foundation evidence

QF-01 through QF-07 pass for the operator-only raw evidence scope. Typecheck and
38 focused tests pass, including 13 new queue tests plus all 25 CEL/collector
regressions. Migration preserves schema-2 CEL evidence, checkpoints, collector
state and gaps; failed queue migration rolls back without advancing schema or
making partial tables visible. Legacy schema-1 CEL read/migration still passes.

Real run `run-hyu0OP` (project `asterisk-queue-hyu0op`) generated an isolated
empty Local-channel queue timeout per customer. Each imported three queue records
(157 bytes): administrative QUEUESTART, ENTERQUEUE and EXITWITHTIMEOUT.
Separate importer replay inserted zero; fresh read-only stores and one-entry
pages reproduced exact original bytes. Queue call identifiers matched fresh
scoped CEL start/answer/hangup/end records. Both runtimes reused the same channel
ID; foreign-customer reads failed and CEL/queue kinds stayed separate.

Only owned PBXs were restarted. Source prefixes and original stored records
persisted unchanged; one new administrative QUEUESTART appended per customer,
giving four queue records (195 bytes). Replayed restarted snapshots inserted
zero duplicates. The real CEL collector recovery regression `run-QZjOc8` also
passes on schema 3. Independent cleanup checks found no owned containers,
networks or volumes, with only synthetic database/report retained.

Reproduce with `.\scripts\Test-QueueHistoryProof.ps1`; the
[README](./README.md#operator-only-queue-evidence-foundation) records CLI shapes,
format/limit rules, migration compatibility and sensitive-data boundaries.
No route, dependency, phone, web/permission surface or REFER matrix changed.
This proves raw queue timeout evidence, not human service, caller abandonment or
business journeys. At QF completion, JD runtime/epoch pairing, instrumentation, reconstruction and
queue collector coverage remained unimplemented; MM below adds only immutable
assignments and isolated markers. M1-06/07 and the 17 remaining broad
M1 gates are still incomplete.

### Selected next increment: runtime/epoch manifests and isolated markers

The user selected immutable record-boundary range assignments plus a new isolated
synthetic entry/visit fixture. No projection, totals or ordinary route changes.

| Check | Finite required evidence |
|---|---|
| MM-01 | History schema 4 atomically adds immutable manifest/range tables, preserving existing CEL, queue and collector/gap state. Current raw readers support legacy schemas; manifest operations require 4. No automatic legacy epoch assignment. |
| MM-02 | Operator supplies customer/runtime/epoch, bounded operator/reason, trusted route declarations and 1-100 CEL/queue ranges. Ranges must cover committed complete records, with exact boundary offsets and source hashes. Bind one runtime/customer per source-kind/generation; multiple epochs or generations are explicit ranges, never inferred. |
| MM-03 | Atomic registration rejects overlapping/reassigned ranges or customer/runtime contradictions; no correction/supersession workflow. Exact identical registration is idempotent. Appended/unmapped evidence stays explicitly unassigned. Customer-scoped manifest pages and per-record resolution fail on foreign/invalid requests. |
| MM-04 | Bounded marker inspection validates versioned JSON, UUIDs, configured context/extension/revision/kind and exact manifest assignment. Return unassigned, untrusted-route, invalid-marker, not-marker or validated-marker observations with provenance; marker validation is not a confirmed journey/projection count. |
| MM-05 | A new isolated synthetic route generates fresh entry and visit UUIDs in dialplan, emits HISTORY_ENTRY before Answer and HISTORY_QUEUE_VISIT before Queue, with fixed synthetic kind/revision. No external headers or arbitrary user JSON supply trusted lineage. Existing routes/REFER fixtures remain unchanged. |
| MM-06 | Focused typecheck/tests prove migration/rollback, raw/collector regressions, byte boundaries, explicit epoch splits, kind/customer collisions, overlaps, concurrency/idempotency, unassigned tails and malformed/spoofed marker provenance. |
| MM-07 | Isolated two-customer real calls produce one valid entry/visit marker each, ordered before Answer/ENTERQUEUE, matching queue caller ID and full CEL lifecycle. Persist/import/replay, explicitly register manifest and reopen/resolve both kinds; retain raw bytes and non-secret report, clean owned resources without REFER reruns. |

Manifests are trusted operator assertions, not automatic runtime discovery or
cryptographic attestation. Wrong operator-supplied epoch/route trust is outside
this tool's authority. Marker observations do not merge roots, assign all legs,
reconstruct visits/outcomes or establish human service/completeness. Source gaps
remain independent; mapping never clears them. Stop after MM-01 through MM-07.

**Result: MM-01 through MM-07 complete for this operator/isolated scope.**
Typecheck and 46 focused tests pass (eight new MM tests plus the 38 raw/
collector regressions). Tests cover schema-3 migration/rollback and earlier
schema-1/2 compatibility, exact record boundaries, atomic failed batches,
overlap/reassignment denial, explicit epoch splits and multi-generation
assignment, kind/customer collisions, unassigned appended bytes, bounded
pages/JSON, concurrent idempotent registrations, read-only persistence,
corrupt inventory/evidence and invalid/untrusted marker payloads.

Real run `run-WYmmSC`, project `asterisk-history-wymmsc`, uses the unchanged
pinned Asterisk image and only owned temporary config/volumes/networks.
It imports **19 CEL records / 3,020 bytes** and **three queue records / 157 bytes
per customer**. Fresh dialplan UUIDs produce one entry/visit pair each.
The caller sequence is CHAN_START, HISTORY_ENTRY, ANSWER, HISTORY_QUEUE_VISIT,
APP_START, APP_END, HANGUP, CHAN_END. The isolated CEL config tracks Queue only,
proving marker-before-Queue invocation without cross-source timestamp sorting.
Actual queue ENTERQUEUE/EXITWITHTIMEOUT match that caller's uniqueid and queue.
Both customers reuse `1792896030.2`; scoped assignments still isolate them.

CEL/queue original bytes round-trip, replay inserts zero and separate CLI
registration replay preserves manifest IDs. Fresh read-only processes resolve
entry/visit and queue assignments to the same explicitly declared customer
runtime/epoch; foreign access fails. Independent checks confirm no owned
containers, networks, volumes, credentials or temporary config remain.
Synthetic database/report are retained locally only.

Reproduce with `.\scripts\Test-HistoryMarkersProof.ps1`; operator JSON/limits
are documented in [README](./README.md#operator-only-runtimeepoch-manifests-and-marker-observations).
The visit payload includes `routeRevision` to validate its route independently
of future journey reconstruction. The fixture loads `func_uuid.so` in a
temporary modules copy and adds Queue tracking in a temporary CEL copy.
No ordinary dialplan, frozen REFER matrix, live phone, web/permission surface or
dependency changes. No root/leg merging, counts, queue coverage, human-service
or four-outcome acceptance is claimed. All 17 remaining broad M1 gates are
still incomplete; stop after this finite increment.

### Selected next increment: conservative operator journey projection

The user selected a bounded first projection and accepted the recommended
durable/conservative policy. Raw history stays schema 4. Derived, immutable
revisions use a separate dedicated operator database, never the diagnostic store.

| Check | Finite required evidence |
|---|---|
| JP-01 | Build one customer/runtime/epoch from a consistent synchronous SQLite history read snapshot. Versioned input vector includes raw source checkpoints, manifest hashes and collector/gap observations. Fail explicitly on missing scope, corrupt inputs or bounds; never publish partial/empty fallback. |
| JP-02 | Stable journey keys require validated entry markers; attach only that explicitly marked caller channel. Duplicate equivalent markers retain evidence without multiplying roots. Contradictory roots, multiple roots on one channel or ambiguous source-generation identity remain conflicting/unresolved. No linkedid/Local/bridge/transfer joins. |
| JP-03 | Stable visit keys require validated visit markers on the same marked caller channel after entry. Associate ENTERQUEUE only for exactly one marked visit and one candidate entry in the same runtime/epoch/caller/queue. Re-entry or cross-stream candidates stay ambiguous, never nearest-timestamp matched. |
| JP-04 | Report PBX ANSWER and caller CHAN_END separately. Support only observed ENTERQUEUE and pinned EXITWITHTIMEOUT shapes; retain unsupported/invalid/contradictory queue evidence as unresolved/conflicting. No human-service, abandonment, journey completion, durations, outcomes, rates or business totals. |
| JP-05 | Atomic immutable publication retains prior revisions and evidence provenance. Exact latest input/output replay reuses a revision; late input creates a new revision without changing entity IDs. Failed/competing rebuilds cannot overwrite newer input or hide the last good revision. Scoped read-only readers expose input-match freshness, publication time and explicit coverage uncertainty. |
| JP-06 | Bound sources/manifests/records/output and page revisions. Tests prove deterministic rebuild, ambiguity/conflicts, raw append, unassigned evidence, source gaps, atomic rollback, corruption, concurrency, snapshot consistency, customer/runtime isolation and CLI persistence. |
| JP-07 | Extend only the isolated two-customer marker proof to publish/reopen projections, verify separate answer/channel-end/queue-timeout facts and exact replay/stable IDs, then clean owned resources. Existing routes, phones and frozen REFER matrix remain untouched. |

At JP completion no queue collector existed; QR below adds it independently.
Collector health remains local-file evidence only.
Gaps retain possibly-applicable/association-unknown status without timestamp
exclusion. These projections are observations, not confirmed journey counts or
completed JD/M1-06/07 acceptance. Stop after JP-01 through JP-07.

**Result: JP-01 through JP-07 complete for the bounded operator scope.**
Typecheck and **62 focused tests** pass: 16 projection tests plus all 46 prior
CEL/queue/manifest/collector regressions. Tests exercise equivalent and
contradictory markers, multiple roots, pre-entry/post-end visits, repeated/
duplicate queue candidates, malformed/unsupported terminals, lifecycle
contradictions, synthetic/external kind preservation, same-generation epoch
splits and cross-customer/runtime collisions. Input and output fanout bounds fail
explicitly; exact 20-source and 2,000-record boundaries pass.

Consistent snapshot tests append raw evidence/checkpoint through a second SQLite
connection while the reader retains its original view (WAL only in that owned
test fixture; normal history retains DELETE journal). Publication tests cover
atomic SQL failure, corrupt history/projections, immutable earlier revisions,
stable late-input entity keys, concurrent operator processes and idempotent
rebuild. Freshness reports changed committed input; explicit offline `stored`
reads retain access to earlier revisions when raw history is unavailable,
without claiming a successful freshness check. Collector recovery to healthy
preserves unknown gaps and never becomes queue coverage.

Real final run **`run-99RbJ4`**, project **`asterisk-history-99rbj4`**, passes
the existing isolated echo/customer-boundary and marker/raw-replay checks before
projection publication. Each customer retains **19 CEL records / 3,020 bytes**
and **three queue records / 157 bytes**. Separate operator CLI processes publish
projection revisions 1/2 for the two distinct customer/runtime/epoch scopes.
Each has exactly one synthetic marked-caller root and one unambiguous visit
under this finite fixture contract: **eight caller-channel CEL references**,
PBX answer observed, caller CHAN_END observed, and queue timeout observed with
**two queue references**. Other Local/echo legs and administrative queue evidence
remain explicitly unattributed/administrative, not extra roots.

Rebuild replay reuses each revision/hash, fresh read-only reopen matches the
deterministic document and entity keys, input freshness reports `inputs-match`,
and foreign scoped reads fail. Quality remains completeness `unverified`,
service `not-classified`, queue coverage `not-collected`; no business totals
or whole-journey outcome is produced.
Independent checks found no owned containers/networks/volumes, credentials or
temporary configs. Only synthetic raw/projection databases and report remain
locally. Offline inspection of the retained revision also passes with explicit
`not-checked` freshness and a nonexistent raw-history path.

Reproduce with `.\scripts\Test-HistoryProjectionProof.ps1`; see
[operator commands and limits](./README.md#conservative-operator-journey-projections).
The bounded builder supports 20 source generations per kind, 200 customer
manifests, 100 selected ranges, 2,000 raw records / 8 MiB total raw input,
20,000 output evidence references and an 8 MiB document. At most 20 configured
CEL sources / 200 gaps per source are included; revision pages are 1-200.
Exceeding a bound fails without publishing/truncating a graph.
Raw history stays schema 4; only derived storage has a separate schema-1 identity.
Ordinary routes, phones, frozen REFER fixtures, dependencies and HTTP/permission
surfaces are unchanged. This does not complete broad JD reconstruction, queue
coverage, human-service/four-outcome acceptance or any additional M1 gate.

### Selected next increment: queue collector recovery and independent coverage

The user selected operator-only local-file queue recovery and projection warnings.
Use the existing explicit generation-replacement policy; no automatic rotation,
remote collection, service daemon, new routes, totals or REFER work.

| Check | Finite required evidence |
|---|---|
| QR-01 | Atomically migrate history 1-4 to 5, adding distinct queue collector/gap tables while preserving raw CEL/queue, manifests and CEL collection/gaps. Read-only legacy readers never migrate; queue collector commands require 5. |
| QR-02 | Immutable customer/source/path/threshold configuration and explicit generation transition. Bounded regular-file snapshots, durable fenced attempt, atomic queue evidence/checkpoint/success status; partial tails remain pending. File/parser/prefix/storage errors fail explicitly and record failure or surface failed failure-recording. |
| QR-03 | Durable local-file freshness/status supports never-collected/collecting/healthy/pending/stale/unhealthy/clock-skew; exact expiry stale. Process death leaves collecting/stale, not false liveness. Superseded attempts/failures cannot overwrite later runs or transitions. |
| QR-04 | Fresh unused replacement generation atomically records permanent unknown gap with operator/reason/observation bounds; preserves all previous evidence and never clears gap after healthy recovery. Failed transitions roll back gap/source/config together. No inferred loss interval or automatic manifest assignment. |
| QR-05 | Projection input version includes independent kind-qualified CEL/queue collector/gap provenance, separate current health and legacy capability warnings. Bump algorithm while retaining read access to earlier revisions and stable entity keys. Queue health never means CEL health, completeness or remote-PBX freshness; unknown gap association cannot be timestamp-excluded. |
| QR-06 | Bounded operator CLI configure/collect/foreground-run/status/transition/gaps; focused migration/rollback, fencing, process-death, corruption, scope, partial input, projection revision/freshness and regression tests. |
| QR-07 | Real isolated two-customer retained queue replay after collection stops, stale/missing/discontinuous-source evidence, explicit replacement recovery retaining gaps, projection/reopen provenance and cleanup. No ordinary routes, live phones, frozen REFER fixtures, HTTP/UI or dependency changes. |

Stop after QR-01 through QR-07. This is partial local-file recovery evidence,
not M1-06/07 completion, production delivery, queue service/outcome acceptance
or expanded journey reconstruction.

**Result: QR-01 through QR-07 complete for the operator/local-file scope.**
Typecheck and **76 focused tests** pass (14 QR plus 62 prior regressions).
Coverage includes schema-4 migration/rollback preserving raw/manifests/CEL
collector state, earlier schema migration tests, exact stale boundaries,
pending/clock-skew states, malformed/missing/oversized/prefix-changed input,
atomic success/failure status errors, superseded workers and transitions,
unknown gap persistence, failed gap rollback, scope/read-only/corruption,
bounded CLI passes, abandoned processes and uncommitted process-exit rollback.
Projection tests retain independent kind-qualified gaps and source association,
old algorithm readability/stable entity keys, and explicit collector/gap caps.

Final real run **`run-XYvtHl`**, project **`asterisk-history-xyvthl`**, first
passes isolated authenticated echo/customer-boundary, trusted marker/raw replay
and baseline projection tests. Queue collectors then stop while the PBXs
produce a second controlled entry/timeout. Stored queue status becomes stale
at **4,803 / 5,185 ms** last-success age against **1,000 ms** proof thresholds.
Resumption imports **two records per customer**, giving **five records /
276 bytes** each, with exact raw round-trip and zero duplicate replay.

Missing files fail with `source-unavailable`; discontinuous replacement fails
with `prefix-discontinuity` without changing the original five-record checkpoint.
Operator transitions explicitly provision fresh replacement generations and
permanent unknown gaps. Recovery imports **four records / 238 bytes** each and
returns healthy while retaining `unknown-gap-recorded`. Old evidence stays
byte-identical; replacement records remain epoch-unassigned. The copied-file CEL
collector state/checkpoint/gaps remain unchanged, independent of queue recovery.
Its 60-second proof threshold is not a production freshness choice.

Published projection revisions **4/6** use `marked-caller-v2`, retain each queue
gap as `possibly-applicable`, preserve stable root keys and retain the original
observed queue timeout. CEL gaps remain empty; completeness and queue coverage
remain `unverified`, never successful/gap-free because a copied file is healthy.
Replay reuses revisions, fresh read-only CLIs report matching committed inputs
and expose independent kind-qualified health; foreign gap reads fail.
An additional read of a real retained `marked-caller-v1` projection against its
schema-4 history succeeds, reports changed current inputs and explicitly warns
`unavailable-legacy-schema` for queue collection capability/current quality.

Independent checks found no owned containers, networks, volumes, credentials or
temporary configs; only synthetic raw/projection databases and the report remain
local. Reproduce with `.\scripts\Test-QueueCollectorRecovery.ps1`; see
[queue operator commands and limits](./README.md#operator-only-queue-collector-recovery).
No automatic rotation, remote delivery, service daemon, epoch discovery or
gap-clearing is added. Raw history is schema 5; derived projection storage remains
schema 1 and v1 revisions remain readable. No new dependency, ordinary route,
live phone, frozen REFER fixture or HTTP/UI/permission change. M1-06/07 and all
17 remaining broad gates are still incomplete; stop after this finite increment.

### Selected next increment: synthetic queue-member service observations

The user selected an isolated automated queue member plus conservative projection
service observations. No human-answer, media, transfer, totals or live-phone claim.

| Check | Finite required evidence |
|---|---|
| QS-01 | New isolated service route/member/queue configuration only; ordinary timeout route and frozen REFER fixtures unchanged. Fresh trusted entry/visit markers precede Answer/Queue. Automated member answers and terminates deterministically. |
| QS-02 | Real pinned queue CONNECT/completion shapes retained with exact raw bytes and caller/member IDs. Verify actual member CEL CHAN_START/ANSWER/CHAN_END, separately from caller answer and channel end. Never infer a human, verified agent identity, two-way media or entire journey outcome. |
| QS-03 | Versioned operator projection adds independent queue connection, exact scoped member-answer correlation and queue completion observations. Unique source/epoch/caller/visit evidence required; missing, malformed, duplicate, conflicting or cross-stream identities remain unresolved/conflicting. Completion is not whole-journey completion; durations remain raw, not metrics. |
| QS-04 | Preserve older algorithm revisions, stable entity keys, immutable replay/late revisions and independent coverage warnings. No raw schema change. Bound evidence references and retain unsupported records; no new inferred Local/bridge/transfer joins or business totals. |
| QS-05 | Focused tests exercise CONNECT/completion shapes/order/member agreement, missing/contradictory/reused member IDs, independent roots, customer/runtime/epoch isolation, late evidence, old revision readability and all existing history regressions. |
| QS-06 | Two-customer real proof verifies exact caller/member/queue evidence, persisted projection/reopen/replay and scope denial; clean owned resources and retain non-secret synthetic evidence. No REFER reruns or live phones. |

Stop after QS-01 through QS-06. Synthetic member-channel answer is not real human
service; M1-06/07, production delivery and four-outcome acceptance remain incomplete.

Implemented and verified for this bounded operator-only scope. The new isolated
route emits trusted service-v1 entry before caller Answer and visit before Queue.
A temporary service-queue has one automated Local `/n` member that answers,
waits two seconds and hangs up; neither ordinary queue configuration nor live
phones are changed. The service caller's wait/queue operations are bounded.

Actual pinned records are CONNECT with exactly `hold|member-uniqueid|ring`, then
COMPLETEAGENT with `hold|call|original-position`, member `synthetic-member`.
V3 validates same-stream queue order, unique entry/connect/terminal, supported
parameter counts and canonical nonnegative safe integers (positive original
position). Exact member uniqueid correlation requires one consistent channel,
one start before one answer and no contradictory end, competing CONNECT/root
identity or source/generation reuse in the selected scope. An open member channel
may have answer observed with end not observed. Missing or cross-stream evidence
cannot supply an answer. At QS completion, unsupported COMPLETECALLER/transfer/
other terminal records stayed unresolved; QC below adds only COMPLETECALLER.
Conflicting candidates retain references.

Caller answer/end, queue connection, member answer/end and queue completion are
separate. A queue connection/completion observation may survive unresolved member
correlation, never promoting that uncertainty to human identity or whole-journey
completion. V3 visit summaries add connection-observed/completion-observed with
separate service fields and explicit issue references. Bridge records are retained
but no peer graph or service audio is inferred. Quality remains unclassified/
unverified; existing source gaps and bounds are unchanged.

`marked-caller-v3` appends revisions while preserving history-entity-v1 keys,
raw schema 5 and projection schema 1. V1/v2 documents remain readable without new
fields or mutation. Late member evidence/replay/old revisions are tested.
Typecheck and **85 focused tests pass**: nine QS additions and all 76 existing
CEL/queue/manifest/collector/projection regressions. Equal IDs in distinct
customer/runtime/epoch scopes, including same-generation epoch ranges, remain
separate. Genuine retained real v1 and v2 stores also read successfully.

Recorded real `run-n7q0gL` (`asterisk-history-n7q0gl`):

| Observation | Customer A | Customer B |
|---|---|---|
| Exact durable CEL | 44 records / 7,497 bytes | 44 records / 7,497 bytes |
| Exact durable queue | 6 records / 370 bytes | 6 records / 370 bytes |
| Service caller uniqueid | `1792898562.4` | `1792898562.4` |
| CONNECT member uniqueid | `1792898562.5` | `1792898563.5` |
| Service queue sequence | ENTERQUEUE, CONNECT, COMPLETEAGENT | ENTERQUEUE, CONNECT, COMPLETEAGENT |
| Member CEL | CHAN_START, ANSWER, BRIDGE_ENTER, BRIDGE_EXIT, HANGUP, CHAN_END | Same six-event lifecycle |
| V3 revision | 3 | 4 |
| New visit | completion-observed; 10 caller / 6 member CEL refs | Same separate observations |

Exact raw round trips, zero-insert import replay, unchanged previous timeout
journey/keys/revisions, exact rebuild reuse, persisted CLI reopen, offline
freshness not-checked and foreign-scope denial pass. Independent resource listing
after Compose down verifies no owned containers/networks/volumes. Temporary
configs/credentials are removed; ignored synthetic databases/reports remain.
Reproduce with `.\scripts\Test-QueueServiceEvidence.ps1`. The separate authenticated
echo baseline is **not** proof of media on the synthetic member call.
No real human, verified agent identity, two-way service audio, journey completion,
caller abandonment, transfer, totals or broad M1 gate is claimed. No REFER rerun.

### Selected next increment: caller-ended synthetic queue service

The user selected isolated caller-ended service evidence after QS completion.
This is post-CONNECT COMPLETECALLER, **not** pre-connection abandonment.

| Check | Bounded required evidence |
|---|---|
| QC-01 | Separate temporary trusted caller-service route/queue/automated member, bounded caller termination while member remains answered; existing timeout/member-ended fixtures and ordinary routes unchanged. No live phones or REFER rerun. |
| QC-02 | Pin actual two-customer ENTERQUEUE/CONNECT/COMPLETECALLER bytes and shapes plus exact caller/member CEL, explicit scoped manifests and trusted entry/visit order. No human, audio, verified agent, abandonment or whole-journey claim. |
| QC-03 | Versioned projection recognizes only the sole ordered same-stream/same-member supported COMPLETECALLER after valid CONNECT, distinct from COMPLETEAGENT. Missing/invalid/mismatched/duplicate/conflicting terminal evidence remains unresolved/conflicting; member correlation remains independent. |
| QC-04 | Preserve immutable v1/v2/v3 documents, stable keys, previous visits, late-evidence revisions, independent gap warnings and existing bounds. No raw or projection schema change. |
| QC-05 | Focused tests cover terminal shapes/order/scope/conflicts, absent/contradictory member evidence, replay/late terminals and actual historical v3 reads; all existing 85 regressions remain covered. |
| QC-06 | Real owned two-customer proof includes old timeout/member-ended cases, exact replay, persisted/offline reads, scope denial and independent resource absence; document measured results, commit/push and stop. |

Implemented and verified within this finite operator-only scope.
The separate trusted caller-service-v1 route emits entry before Answer and
visit before Queue, with a separate caller-service-queue and automated member.
Caller-side Wait ends after three seconds while the member Wait is twenty
seconds and Queue is bounded to ten. Acceptance requires actual post-CONNECT
COMPLETECALLER plus completed owned channel cleanup, not a timing assumption.
Ordinary routes, empty-queue/member-ended fixtures, phones and REFER are unchanged.

Pinned COMPLETECALLER shape is exactly `hold|call|original-position`.
V4 uses the existing shared terminal checks for COMPLETEAGENT/COMPLETECALLER:
unique valid CONNECT followed by a sole same-stream, later, same-member
terminal with three canonical unsigned safe integers and positive original
position. New `caller-ended-queue-service-observed` is distinct from existing
`member-ended-queue-service-observed`. Duplicate/mixed terminals conflict;
malformed, reordered, foreign/missing or wrong-member evidence cannot prove
completion. Separate member correlation can remain unresolved/conflicting and
caller end not observed even when the valid queue completion is observed.
No human identity, service audio, abandonment or whole-journey outcome is inferred.

Raw schema 5, projection schema 1, independent gaps, bounds and stable
history-entity-v1 keys are unchanged. V1/v2/v3 reads preserve their exact
documents; a v4 rebuild appends without rewriting. A genuine discovery v3
revision reads caller completion unresolved under the new reader.
Typecheck and **91 focused tests pass**: six QC additions plus all 85 previous
regressions. Late completion/replay, scope exclusion, malformed/mixed terminals,
partial/conflicting member evidence, independent caller facts, preserved gaps
and old-v3 byte preservation are covered.

Recorded real `run-nOTX5T` (`asterisk-history-notx5t`):

| Observation | Customer A | Customer B |
|---|---|---|
| Exact durable CEL | 69 records / 12,349 bytes | 69 records / 12,349 bytes |
| Exact durable queue | 9 records / 619 bytes | 9 records / 619 bytes |
| New caller uniqueid | `1792920819.8` | `1792920819.8` |
| CONNECT member uniqueid | `1792920819.9` | `1792920820.9` |
| New queue sequence | ENTERQUEUE, CONNECT, COMPLETECALLER | Same sequence |
| COMPLETECALLER raw params | `0|3|1` | `0|2|1` |
| New caller/member CEL refs | 10 / 6 | 10 / 6 |
| V4 revision | 5 | 6 |
| Completion observation | caller-ended-queue-service-observed | Same distinct value |

Each member has CHAN_START, ANSWER, BRIDGE_ENTER, BRIDGE_EXIT, HANGUP, CHAN_END;
bridge records are retained, not interpreted as two-way media. Both earlier
timeout and member-ended journeys/keys/revisions remain unchanged. Exact raw
round trips, zero-insert import replay, immutable rebuild reuse, persisted CLI
reopen, offline freshness not-checked and foreign-scope denial pass.
Independent owned container/network/volume absence is verified after down;
temporary credentials/configs are removed. Only ignored synthetic databases
and reports remain. Reproduce with
`.\scripts\Test-QueueServiceEvidence.ps1 -CallerEnded`.
Stop here: M1-06/07, live/human service, pre-connection abandonment, production
delivery and broad journey/outcome acceptance remain incomplete. No REFER rerun.

### Selected autonomous batch: ten pre-connection hangup acceptance tests

The user authorized the following ten focused tests as one coherent increment,
without pausing between tests. Scope is isolated queue ABANDON observations,
not caller intent, whole-journey abandonment, business outcomes or service media.

| Test | Finite acceptance scope |
|---|---|
| QA-01 | Pin exact real ABANDON shape; recognize only member NONE, positive current/original positions and unsigned safe-integer wait. |
| QA-02 | Require a trusted marked caller/visit, unique visit and unique ENTERQUEUE; orphan/re-entry candidates stay unresolved. |
| QA-03 | Only a sole ordered same-stream ABANDON without CONNECT/COMPLETE/other terminals supplies abandonment observation; retained absence is not complete coverage. |
| QA-04 | Caller PBX answer/end and queue abandonment remain independent; partial caller lifecycle never fabricates negative service/human facts. |
| QA-05 | Exact raw byte replay inserts zero; malformed raw batches cannot advance checkpoints. |
| QA-06 | V5 adds explicit queue abandonment observation with no new root, human intent, totals, metrics or overall outcome; gaps/bounds remain conservative. |
| QA-07 | Malformed parameter counts, placeholders, unsafe/noncanonical integers, bad order and wrong member stay unresolved with references. |
| QA-08 | Duplicate/mixed ABANDON, timeout, CONNECT and completion candidates remain explicit conflicts, preserving independent service facts. |
| QA-09 | Customer/runtime/epoch/source/generation and unassigned evidence cannot cross-attribute; equal IDs in separately manifested epochs remain separate. |
| QA-10 | Late evidence appends immutable revisions with stable keys; earlier v1-v4 reads stay unchanged; persisted/offline scope checks and real owned cleanup pass. |

Real proof must include both customers and prior timeout/member-ended/caller-ended
regressions, marker order, exact caller CEL, raw replay and independently absent
owned resources. No ordinary route changes, live phones or frozen REFER reruns.
Stop after QA-01 through QA-10, document measured limits, commit and push.

Implemented and verified: **all ten QA tests pass**, alongside all 91 previous
focused history/projection/collector regressions (**101 total**) and typecheck.
This does not complete any broader journey, human-service or M1 outcome gate.

The pinned fixture uses a temporary no-member queue and a trusted abandon-v1
route, caller-side Wait 3 and Queue limit 10. Actual records, not elapsed time,
prove ENTERQUEUE then ABANDON with member NONE and no CONNECT in that selected
queue sequence. Caller entry precedes PBX Answer; visit precedes Queue.
Caller ANSWER is not a member answer. The actual nine caller records include
LINKEDID_END; initial discovery incorrectly expected eight and failed. The
assertion now retains an optional final LINKEDID_END without deriving a join,
and fresh acceptance passes after both failed and successful owned cleanups.

V5 supports `visit.abandonment:not-observed|observed|unresolved|conflicting`.
A sole ordered same-stream ABANDON with exact position/original-position/wait
unsigned canonical safe integers and positive positions yields observed and
summary abandonment-observed. Missing/foreign evidence cannot supply it.
Bad member/shape/order stays unresolved; any mixed/duplicate candidates conflict.
Separate service/member facts remain visible if contradictory CONNECT exists.
No inference of human intent, full negative service evidence, whole-journey
outcome, durations, rate or total. Caller answer/end remains independent.

| Test | Verified result |
|---|---|
| QA-01 | Actual pinned three-field ABANDON shape and independent explicit observation; zero wait supported. |
| QA-02 | Orphan/pre-root/post-end/invalid markers, repeated visits and missing/duplicate entries cannot acquire abandonment. |
| QA-03 | Reversed order and foreign source/generation remain unresolved; no CONNECT observation does not establish completeness. |
| QA-04 | Caller answer/end independently observed or absent; no fabricated member identity or outcome. |
| QA-05 | Exact CEL/queue replay inserts zero; malformed appended raw batch atomically preserves evidence/checkpoint. |
| QA-06 | No extra root, human intent, totals or metrics; independent permanent gaps and conservative quality retained. |
| QA-07 | Wrong member, bad field counts, negative/decimal/unsafe/noncanonical/missing numbers retain explicit unresolved evidence. |
| QA-08 | Duplicate ABANDON and mixed timeout/CONNECT/completions/unsupported records conflict; independent valid CONNECT/member facts retained. |
| QA-09 | Unassigned/foreign customer/runtime/epoch evidence excluded; same IDs in separate same-generation epoch ranges remain separate. |
| QA-10 | Late ABANDON creates stable immutable v5 revision, v1-v4 stored bytes retained; replay, reopen/offline and scope denial pass. |

Raw schema 5, projection schema 1, history-entity-v1 keys and bounded input/
reference/document limits remain unchanged. Genuine retained v1-v4 stores were
also read under v5 without migration or rewritten interpretation.

Recorded real `run-PIl5h8` (`asterisk-history-pil5h8`):

| Observation | Customer A | Customer B |
|---|---|---|
| Exact durable CEL | 82 records / 14,583 bytes | 82 records / 14,583 bytes |
| Exact durable queue | 11 records / 736 bytes | 11 records / 736 bytes |
| New caller uniqueid | `1792921291.12` | `1792921292.12` |
| Queue sequence | ENTERQUEUE, ABANDON | Same |
| ABANDON raw params | `1|1|2` | `1|1|3` |
| Caller CEL refs | 9 including LINKEDID_END | Same |
| V5 revision | 7 | 8 |
| Visit abandonment / summary | observed / abandonment-observed | Same |
| Member / service completion | not observed | not observed |

Earlier timeout/member-ended/caller-ended journeys/keys/revisions are unchanged.
Exact raw round trips, zero-insert replay, immutable rebuild reuse, persisted/
offline CLI reads and scope denial pass. Independently list owned resources
after down: no containers/networks/volumes remain for either discovery or final
acceptance. Temporary configurations/credentials are removed; only ignored
synthetic databases/reports remain. Reproduce with
`.\scripts\Test-QueueServiceEvidence.ps1 -Abandonment`.
The autonomous ten-test batch stops here. No live phones, ordinary routing or
frozen REFER changes; no human, whole-journey/business outcome or M1-06/07 claim.

### Milestone checkpoint after the autonomous ten-test batch

Review date: **25 October 2026**. Reviewed implementation/evidence baseline:
`04bb990` (QA completion). This is a documentation checkpoint, **not a new test
run or a declaration of milestone completion**. It supersedes the earlier
evidence-gap table for current priorities; historical increment results remain
valid only within their recorded scopes.

**Gate accounting:** 17 full gates remain open. M1-10 has a recorded pass only
for its explicitly selected local conventional echo-route scope (MO-01 through
MO-06), not production resilience or queue/agent outage behavior. No other full
gate is promoted by the 101 focused history tests or synthetic fixture names.
The original startup/capture thresholds remain proposed, not newly approved.

| Gate | Current recorded evidence | Remaining acceptance gap / status |
|---|---|---|
| M1-01 | Pinned isolated two-PBX startup/health and bounded owned harnesses. | **Open:** complete required-service readiness within the agreed startup threshold; PBX readiness alone is insufficient. |
| M1-02 | Authenticated echo/media fixtures and automated Local queue members. | **Open:** ten consecutive calls/customer through the intended queue/browser agent with measured two-way audio; automated member ANSWER is not this proof. |
| M1-03 | Separate runtime resources, credential/API denials and scoped raw/projection reads; simultaneous echo calls. | **Open:** simultaneous intended calls with signalling, media, history and recording disclosure checks in one correlated run. |
| M1-04 | Frozen REFER transaction/media matrix. | **Open:** actual authorised agent mute, hold/resume, receiver-verified keypad and blind-transfer controls. No REFER rerun is a prerequisite here. |
| M1-05 | Authenticated assignment/reservation exclusivity, expiry/release and provisioning fixtures. | **Open:** live offers move A to B, correct historical agent/session attribution, explicit assignment conflict; reservation is not phone activation. |
| M1-06 | HF/QF durable raw evidence; MM manifests/markers; immutable JP v1-v5; QS/QC/QA exact timeout, member-/caller-ended connection/completion and ABANDON observations. QA retains 82 CEL/11 queue records per customer. Subsequent LR preserves those observations after local process interruption; BE separately verifies real isolated PBX boot boundaries and deliberately reused identities in timeout fixtures. | **Open:** all four required outcomes, including transferred calls, with coherent journey/leg/visit accounting and retained expected evidence after restart. Current synthetic queue observations do not prove human service, whole-journey outcomes or a transfer graph. |
| M1-07 | Independent CEL/queue fenced local-file collectors, stale/failure state, atomic replay/checkpoints, permanent replacement gaps and projection coverage warnings. Subsequent LR adds combined process-recovery/authenticated reads; BE adds isolated PBX restart/epoch isolation and replay. | **Open:** integrated interruption/recovery against full wording with visible gaps in the intended workflow. Current one-shot/bounded copied-file collection is not continuous remote PBX delivery, automated rotation or production collector lifecycle. |
| M1-08 | Synthetic WAV payload/format and restart/hash fixtures. | **Open:** journey-linked authorised playable assets plus visible upload failure/retry/reconciliation. |
| M1-09 | Revision/approval patterns in diagnostics and narrow provisioning. | **Open:** validated route/queue draft, stale-revision conflict, apply/verify and external-edit drift handling. Report approval is not configuration publication. |
| M1-10 | MO real run `run-2KzA6j`: 60.502-second per-customer media observation and fresh conventional calls while the owned management process remained down. | **Selected local scope passed:** conventional echo only; queue/browser-agent, public trunk, identity outage and production failover are not covered. |
| M1-11 | Operator-scoped customer/incident capture and bounded-duration path. | **Open:** authenticated interactive start/stop and agreed ten-minute/100-MiB hard-limit proof; sampled thresholds are not hard quotas. |
| M1-12 | Diagnostic packet/CEL reports, inert review preview and separate operator history CLI. | **Open:** complete authenticated selected-call SIP/SDP/directions/legs and explicit missing/truncated/dropped evidence. A proposed projection reader alone will not close this gate. |
| M1-13 | Encrypted browser signalling/media fixture; packet proof explicitly UDP-only. | **Open:** display encrypted network payload honestly, with separately labelled authorised application signalling. Do not disable encryption. |
| M1-14 | Frozen synthetic unavailable/unanswered transfer evidence with known limits. | **Open:** selected fault incidents exported through the intended workflow, evidence-cited and without unsupported blame; no automatic expansion of REFER. |
| M1-15 | Redacted report generation, integrity hashes and permission-controlled review/viewing. | **Open:** complete scoped incident conclusion/export/capture-limit contract plus executed disclosure checks for that surface. |
| M1-16 | Existing customer/owner/session negative tests; history CLI scope checks. | **Open:** history/call/recording/export/capture boundaries as implemented. Trusted CLI scoping is not HTTP tenant authorisation; absent routes are not passed permission tests. |
| M1-17 | Raw source/PBX restart fixtures and separate SQLite backup/restore proofs. | **Open:** one separate-environment restore of configuration, call metadata and playable recording together; saved projection reopen is not full restoration. |
| M1-18 | Session/backend/assignment/reservation errors distinguished; phone disabled. | **Open:** live microphone denial, registration failure and backend disconnect with no false readiness. Disabled controls do not prove live error handling. |

What is complete locally: bounded AW workspace, BS/SW synthetic booking,
MO local outage proof, raw history/manifests, independent collector recovery and
conservative synthetic queue observations. Latest QA run `run-PIl5h8` and the
101-test result were inspected as **recorded evidence**, not rerun at checkpoint.
The [projection builder](./src/history-projection.ts) still deliberately leaves
repeated same-caller/same-queue entries unresolved and performs no transfer graph.
The [CLI](./scripts/Manage-HistoryProjection.ts) exposes rebuild/current/stored/
revision operations; its filesystem access is a trusted operator boundary.
The [current access model](./src/access.ts) has diagnostic, agent and simulation
permissions but no history-specific grant. Do not repurpose those grants silently.

#### Prioritized next work, not implementation authorization

| Priority | Bounded work package | Why now / dependencies | Exit and non-claims |
|---|---|---|---|
| 1 | Read-only authenticated history-evidence workspace | Subsequently authorized: explicit customer `history:read` members only, no support grants, references-only exposure. Reuses session/audit/customer boundaries, not CLI authority. | HR-01 through HR-10 below pass in the bounded local scope. No collection/rebuild/manifest/config/phone mutations; not M1-06/07/12/16 completion. |
| 2 | Integrated restart/interruption/replay proof | Subsequently selected: LR local process slice, then separately authorized BE isolated PBX boot-epoch slice. Exact ten-check contracts below. | LR-01 through LR-10 and BE-01 through BE-10 pass in their bounded scopes. Full M1-06/07 outcomes, continuous remote delivery and production boot attestation remain open. |
| 3 | Limited route/queue publication foundation | Offline compiler/drafts/approval/fencing (CF-01 through CF-15), plus owned empty-baseline binding/read-only inspector (CI-01 through CI-10). No web apply authority. | Full CP-01 through CP-10 remain unverified. No executor or nonempty published-state verification; base zero alone is not empty-runtime evidence. Exact loaded queue policy, canary and recovery proof still required. No broad editor or web Docker socket. |
| 4 | Gated browser-agent vertical slice | Requires explicit activation approval, queue/session authority, publication and device lifecycle readiness. | Intended queue-agent media/control/roaming/error acceptance; no live calling enabled by this checkpoint. |
| 5 | Recording, engineering/export and combined restore | Requires explicit storage/retention/access/capture-limit contracts and links to durable identities. Can be separately planned where independent. | Close exact M1-08/11-17 requirements through executed scoped workflows, not report/hash proxies. |

No repeated-visit matching, transfer reconstruction, production collector service,
Autocab integration or voice AI is authorized as a side effect. Further history
reconstruction should follow evidence of a required unsupported scenario, not an
automatic sequence of algorithm versions.

#### Selected HR batch: read-only history evidence, ten acceptance checks

**Authorized and implemented after the checkpoint.** The user selected explicit
customer `history:read` membership only, no support access, references-only
exposure, and autonomous execution of the complete ten-check batch. Opt-in
server configuration selects existing absolute raw/projection paths and explicit
local Alice/Bob members; the browser never selects files. No other permission
implicitly grants access. No agent assignment is required.

| Check | Executed finite acceptance (all pass locally) |
|---|---|
| HR-01 | Explicit opt-in and configured existing read-only stores; no store creation, migration, import, rebuild or background collector on page load. |
| HR-02 | Live application session, CSRF and explicit customer `history:read` membership; no support, diagnostic, agent, simulation, token-role or bearer-only authority. Guessed foreign runtime/epoch/revision IDs disclose nothing. |
| HR-03 | Reuse persistent audit and request-reference conventions for allowed/denied/error reads; audit/storage failures surface, not empty success. Test logout/session expiry and no stale protected data after loss of access. |
| HR-04 | Select only authorized customer/runtime/epoch/revision scope; bounded metadata pages with explicit cursors. Never list other customers or accept arbitrary filesystem paths from the browser. |
| HR-05 | Read immutable v1-v5 documents as stored, including absent newer fields; display algorithm/revision and supported legacy limitations without reinterpretation. |
| HR-06 | Separate explicit current-input checking from stored/offline inspection. Show inputs-match/inputs-changed/not-checked and independent coverage/health; failure is never green freshness. |
| HR-07 | Display caller answer/end, queue timeout/CONNECT/member correlation/completion/ABANDON as separate observations. No human-service badge, business total or whole-journey outcome. |
| HR-08 | Show unresolved/conflicting/unassigned evidence and permanent unknown gaps prominently. Do not hide incomplete data behind an empty timeline or join by timestamps/linkedid. |
| HR-09 | Evidence references retain kind/source/generation/offset/hash; no raw record routes or arbitrary file inputs. Allowlisted observation DTOs exclude unexpected/raw/configuration fields. Hostile text is escaped; no recording/export/capture actions. |
| HR-10 | Focused API/browser tests for scope/session/audit/storage/freshness/legacy/error cases plus both-customer persisted synthetic proof. No microphone/WebSocket phone activation, PBX changes or REFER reruns; clean up only owned test resources. |

Measured verification: typecheck and **161 focused tests passed**, comprising
the ten new HR checks plus access/application-session/local-launcher,
diagnostic-audit storage, booking HTTP and the existing 101 history checks.
HR tests cover audit failure and logout during awaited audit, unauthorized scope
and query/method/route rejection, bounded metadata cursors, missing/corrupt stores,
offline reads, immutable legacy bytes, current-input changes and independent
unhealthy/never-collected collector status with permanent gaps. Chromium tests
cover hostile text, explicit retry, access loss, expiry and late logout responses.

Additional retained-evidence proof: authenticated HTTP and Chromium read and
current-check both customers' genuine stored v1-v5 revisions from
`run-99RbJ4`, `run-XYvtHl`, `run-n7q0gL`, `run-nOTX5T`, and `run-PIl5h8`.
All ten customer/version cases pass. Exposed journeys/issues exactly equal the
stored observations, without upgrading missing legacy fields. Current checks
report changed inputs for v1-v4 under v5 and matching inputs for the current v5
revisions, not green collector freshness. Every raw/projection file remains
byte-identical. Owned temporary servers/browser contexts/audit databases are
closed and removed; retained synthetic files are preserved. No Docker/PBX,
ordinary route/queue, live phone or REFER rerun was needed.

The UI displays source document/input checksums, not a checksum of the allowlisted
view. Successful persistent `history_*_view_prepared` audits record preparation
before disclosure, not a receipt; a session lost while audit is awaited receives
no protected result. Denials and storage errors use existing durable audit and
request references; failed auditing prevents disclosure and is logged.

Reproduction and opt-in configuration are in the
[workspace instructions](./README.md#opt-in-read-only-history-workspace).
This completes HR only. The 17 full M1 gates remain open; M1-06/07/12/16 are not
closed wholesale. Integrated restart/interruption/replay is the next recommended
scope at the end of HR; the subsequently authorized local slice is recorded below.
Remote continuous delivery, rotation/
retention, repeated-visit/transfer attribution, recording authorization/export/
restore, production identity and live queue-agent calling remain unproved.

#### Selected LR batch: local process interruption and replay

After HR, the user selected **local-process-recovery**, not the alternative
isolated PBX restart proof, and authorized autonomous execution of all ten checks.
The fixed baseline is an owned byte-for-byte copy of `run-PIl5h8`:
each customer has four synthetic roots (timeout, COMPLETEAGENT, COMPLETECALLER,
ABANDON), 82 CEL records / 14,583 bytes and 11 queue records / 736 bytes.
This is not a new unanswered-target/transfer acceptance fixture and makes no
human-service, service-audio or whole-journey classification.

| Check | Executed acceptance (all pass) |
|---|---|
| LR-01 | Copy existing raw/projection stores to a unique owned run; verify the four original roots/observations for each customer and exact initial bytes. Never write to canonical stores. |
| LR-02 | Configure owned local snapshots, run eight fresh-process CEL/queue replays with zero inserted rows, preserve all original identities/facts and reuse identical published revisions. |
| LR-03 | Terminate four owned collector workers after committed attempt-start barriers. Check unchanged checkpoints, durable collecting state and stale status at the exact configured threshold; restart real collectors with zero duplicate rows. |
| LR-04 | Persist four incomplete CEL/queue tails across separate collector invocations; consume none of the tail until completed, then insert each exactly once with zero pending bytes. No inferred epoch change. |
| LR-05 | A valid new record followed by a malformed row rolls back the whole batch; changed/truncated prefixes explicitly fail. Original checkpoints survive all eight denials; restored exact source replays recover without automatic rotation. |
| LR-06 | Terminate four owned workers immediately after an actual importer raw INSERT, inside its uncommitted transaction. Reopen and verify exact prior raw bytes/checkpoints plus durable collecting state; real restarted collectors insert one new row exactly once per stream. |
| LR-07 | Inject two SQL publication failures and kill two actual rebuild workers after uncommitted projection INSERT. Prior immutable revisions remain unchanged/readable, current checks show changed inputs; retry publishes a complete revision, then exact replay reuses it. |
| LR-08 | Deliver one additional marked synthetic caller per customer, CEL-first for A and queue-first for B, with deliberately reused caller/linked/marker IDs. Missing manifest assignment and partial/unassigned terminal evidence cannot fabricate abandonment. Exact delayed range assignments expose the bounded ABANDON fact; original eight roots/visits/service observations remain unchanged. |
| LR-09 | Missing source files and prefix replacement fail explicitly. Trusted transitions to fresh generations create four permanent unknown gaps; subsequent success never clears them. Generation recovery remains in the original PBX epoch; no new boot is invented. |
| LR-10 | Kill and restart the actual application process on the same owned loopback endpoint with the same audit/evidence stores. Earlier audits survive exactly, two old sessions are rejected, fresh customer-bound HTTP/Chromium reads preserve facts/gaps and deny customer substitution; stored versus checked freshness and logout clearing pass. No microphone/WebSocket/unexpected route requests. |

**Measured run:** `run-aDwuAb`, retained at
`.local-proof\local-history-recovery\run-aDwuAb`.
Typecheck and all **111 focused existing history/workspace regression tests**
pass before the ten integration checks. No production source or algorithm
change was required. The failure injector wraps SQLite statements only inside
dedicated test workers; it pauses after the real INSERT and before the real
writer can commit. It does not simulate the importer/publication by manually
writing substitute rows.

There are four killed attempt-start workers, four killed mid-import workers,
two killed mid-publication workers and two application incarnations (one
restart). Two synthetic late roots are added only in the owned proof. Four
unknown gaps remain. LR-10 audit rows increase from 4 before restart to 22
after new login/read/denial/browser/logout operations; earlier rows match
exactly. Authenticated application reads leave owned evidence bytes unchanged.

Canonical raw SHA-256:
`68d08927e20eb262fa1ed97bfc5855d684b3f38d1c5879424a6888bc062c9989`.
Canonical projection SHA-256:
`edaec9674e22bda966880abb8cfb51c0de11bfcd437ed657d2e598b912ea4669`.
Both canonical files are byte-identical before/after. Owned process exits,
listener/browser closure and transient snapshot cleanup are verified; only
owned history/projection/audit SQLite and result JSON remain. Reproduce with
`.\scripts\Test-LocalHistoryRecovery.ps1`; optional absolute input directory
and retained-output details are in the
[recovery instructions](./README.md#local-process-recovery-proof).

**Stop boundary:** LR local-process recovery is complete, not integrated PBX
restart acceptance as a whole. M1-06/07 are not closed: no PBX restart, new boot
epoch, live unanswered/transfer fixture, transfer/repeated-visit attribution,
remote delivery/rotation/retention, power-loss durability or combined restore
was tested in LR. The PBX restart/epoch slice was subsequently authorized
separately and is recorded below. Phones remain disabled, ordinary routing
unchanged and REFER frozen. The 17 full M1 gates remain open.

#### Selected BE batch: isolated PBX boot-epoch recovery

After LR, the user explicitly authorized **pbx-epoch-recovery** and autonomous
execution of the finite batch. A unique owned two-customer Compose project uses
the existing pinned Asterisk 22.11.0 image, no image pull/build, and no host
published PBX/AMI port. Only the owned test PBXs are stopped/restarted.

The test-only `history-epoch` route emits fixed journey/visit UUIDs and enters
the existing empty proof queue. An ephemeral localhost-only AMI account with
only `originate` write authority supplies `ChannelId`/`OtherChannelId`, deliberately
reusing actual uniqueid/linkedid strings across both customers and both boots.
Raw bytes remain original; reuse is not achieved by editing stored evidence.
This is bounded synthetic timeout evidence, not human service/media, unanswered
target, abandonment, transfer or live agent-console calling.

| Check | Executed acceptance (all pass) |
|---|---|
| BE-01 | Originate one deterministic synthetic caller per customer's first observed boot; validate real marked caller answer/end and a distinct queue timeout observation. Record process start token and explicit runtime/epoch scope. |
| BE-02 | Complete CEL/queue snapshots round-trip byte-for-byte, replays insert zero and identical rebuilds reuse boot-1 revisions. |
| BE-03 | Stop only A; its PBX command fails, B remains responsive with unchanged process/log prefix, and A's stored evidence remains readable with freshness `not-checked`. |
| BE-04 | Read A's stopped persistent volume using a one-off Python container without launching Asterisk. Restart only A, observe changed PID-1 start token, preserve old byte prefixes and record another real call using the same IDs. Before boot-2 assignment, new evidence is unassigned and boot-1 observations cannot change. |
| BE-05 | Register exact disjoint A boot-2 CEL/queue ranges in the same source generation. Marker, caller and queue identities intentionally match boot-1, but stable root/visit keys and references are epoch-scoped. |
| BE-06 | Repeat the independent stop/snapshot/restart/assignment for B; A's process and Asterisk uptime command remain responsive. |
| BE-07 | Four customer/epoch scopes each contain one root/visit with exact selected references. Actual uniqueid `epoch-reused-caller`, linkedid `epoch-reused-originator`, journey/visit marker IDs and `proof-queue` match across all four; stable root/visit keys remain distinct with no cross-epoch join. |
| BE-08 | Separate CLI-process CEL/queue replays insert zero; exact raw snapshots and prior immutable revisions survive. Rebuild current views, then reuse identical revisions. One source generation per customer/kind contains two explicitly assigned boot epochs. |
| BE-09 | Reject overlapping boot ranges, runtime rebinding, foreign raw reads, foreign customer scope and wrong-epoch revision IDs without changing manifests. Never infer a boot or generation from timestamps or reused IDs. |
| BE-10 | Reuse the existing authenticated HTTP/Chromium proof across all four customer/boot scopes. Stored observations match persisted facts, wrong-epoch revisions and customer substitution are denied, offline/checked freshness is explicit, and browser errors/unexpected routes/microphone/WebSockets are prohibited. Raw/projection bytes remain unchanged by reads. |

**Measured run:** `run-VntQha`, Compose project `asterisk-history-vntqha`.
Typecheck and **111 focused history/workspace regression tests** pass before
the ten runtime checks. All ten BE checks pass. A prior owned reproduction
(`run-KzysZz`) also passed; its resources were independently confirmed absent.
No production implementation, algorithm-version or permission change was needed.

Both customers retain 32 CEL records / 5,668 bytes and six queue records /
342 bytes. Each customer's boot-1 ranges are CEL `[0,3246)` and queue `[0,171)`;
boot-2 ranges are CEL `[3246,5668)` and queue `[171,342)`.
PID-1 start ticks change from `12551` to `14917` for A and from `12551` to
`16251` for B in this run. Start ticks are scoped observational test evidence,
not a globally unique or production-attested boot identifier. Equal first-boot
ticks across customers confer no shared identity. Four current projection scopes
have six stored revisions; earlier boot-1 revisions remain unchanged while
current-input coverage hashes incorporate later local manifests/evidence.

Boot assignment uses the observed process restart and complete quiescent stopped
volume byte boundaries, not QUEUESTART or timestamps. Graceful-shutdown bytes,
if any, remain raw evidence; later unassigned data is not silently attributed.
The source generation deliberately stays `asterisk-history-vntqha` across both
boots. This complements LR's inverse case, where explicit source replacement
changes generation without inventing a PBX boot.

Reproduce with `.\scripts\Test-PbxEpochRecovery.ps1`; see
[setup/results](./README.md#isolated-pbx-boot-epoch-recovery-proof).
Owned containers, networks and volumes are removed and their absence is verified
by Compose-project label; generated credentials/configurations are deleted.
Only ignored `history.sqlite`, `projections.sqlite` and `result.json` remain.
Temporary authenticated-proof identity/audit/browser resources are closed and
removed. The result records `ownedResourceAbsenceVerified:true`.

**Stop boundary:** BE completes this isolated restart/epoch slice, not the full
M1-06/07 gates. It does not prove all four business outcomes after restart,
production boot attestation, abrupt host/power failure, active-call survival,
continuous remote delivery/rotation/retention, human queue service/media,
transfer/repeated-visit attribution, recording/export or combined restore.
Existing/shared PBXs and ordinary routing are untouched, live agent phones
remain disabled, and REFER is frozen. All 17 full M1 gates remain open.
Limited route/queue publication planning was next recommended; the subsequent
selected design is recorded below, without implementation authority.

#### Selected CP design: limited route/queue publication

**25 October 2026: design selected; offline foundation and empty-baseline inspector subsequently implemented.** User decisions:
`route-empty-queue`, `same-author-explicit`, `operator-cli`.
One isolated synthetic route points to one empty queue with bounded timeout and
hangup. Existing ordinary routes, endpoint/member/credential management, live
inbound numbers/trunks, recordings and agent calling are excluded.
The same trusted local operator may explicitly approve the exact immutable
validated draft, but apply remains a distinct deliberate action. No four-eyes
or authenticated customer-operator claim. A trusted CLI targets only a provisioned
uniquely owned proof project; web processes receive no Docker socket or runtime
apply authority. Browser draft/approval surfaces are deferred.

The [detailed publication contract](./PROJECT-PLAN.md#selected-first-publication-slice)
defines reserved generated fragments/include prerequisites, desired/published/
observed state, canonical hashes and base-revision binding, durable operation
identity, exact loaded-state inspection, deliberate canary, drift blocking and
conditional verified rollback. Proposed model bounds are one route/queue,
slugs `[a-z][a-z0-9-]{0,31}`, integer wait 1-30 seconds, unknown keys rejected.
These are initial implementation acceptance bounds, not a production taxonomy.

| Check | Full acceptance contract; **not yet verified end-to-end** |
|---|---|
| CP-01 | Strict bounded versioned route/empty-queue model and deterministic compiler. Reject invalid/missing/foreign destinations, unsafe identifiers/text, unknown fields, boundary/type errors, collisions and unsupported configuration without disk/runtime effects. Valid min/max waits and canonical output shapes pass; marker ordering and revision provenance are exact. |
| CP-02 | Immutable scoped drafts, exact validation/impact/output hashes and explicit revision/base-bound approval persist across process restart. Editing cannot reuse approval. Same-author approval is visibly permitted, not represented as four-eyes; unauthenticated local operator references are not customer identity. |
| CP-03 | Expected verified revision and a durable customer/runtime operation claim fence two competing CLI processes. Stale approvals, cross-scope IDs and operation-ID payload reuse conflict before external effects. Exact retry inspects the same attempt; it cannot duplicate apply or automatically repeat a canary. |
| CP-04 | Provisioned owned-project identity, reserved files/include/dependency hashes and exact disk/loaded inventory are rechecked. Missing/extra/changed managed objects, unmanaged collisions, symlinks, disk drift, loaded-only drift and runtime restart during apply block or become explicit uncertainty. Never silently adopt/overwrite external edits. |
| CP-05 | Pinned two-customer owned fixture proves supported include hooks, deterministic artifact staging and fixed queue-before-route/scoped-reload sequence. Require quiescence. Unmanaged baseline and other-customer state remain unchanged. No arbitrary paths/commands, broad directory rewrite, global reload or web Docker authority. |
| CP-06 | Valid explicit apply independently verifies exact loaded route priorities/destination/wait/markers and queue policy/empty member set, then deliberate bounded marked timeout/hangup canary. Reload acknowledgement, source checksum or revision label alone cannot verify. Only full verification advances the published pointer. |
| CP-07 | Inject validation/staging/replacement/reload/inspection/canary/receipt failures and real process death at external-effect boundaries. Prior immutable intent/history survives; no partial grouped write, missing receipt or unknown canary delivery becomes success. Block new applies while recovery is required. |
| CP-08 | Separate explicit recovery first inspects state, conditionally restores only operation-attributable bytes, scoped reloads and independently verifies/canaries a nonempty last-verified base. For the empty initial baseline, verify reserved object absence and unchanged unmanaged inventory, not a call through a removed route. External edits block restoration; failed recovery stays uncertain. No claim to reverse call side effects. |
| CP-09 | Persistent bounded operator/reason/diff/approval/application/recovery receipts distinguish desired, last-verified and independently observed state. Status/inspect is read-only, PBX outage is explicit, audit/receipt failure is not empty success, and application restart never auto-applies or auto-resumes. |
| CP-10 | Focused offline/store/concurrency tests plus owned pinned runtime acceptance cover both customers, malformed/stale/drift/error/restart/rollback paths, measured exact runtime facts and required canary records. Verify owned resource/credential cleanup and unchanged ordinary/shared PBXs; no live agent phone, production deployment, member/credential change or REFER rerun. |

All full CP checks remain **unverified**. The original design increment was
documentation only. The following offline implementation adds
[compiler](./src/configuration-model.ts), [dedicated store](./src/configuration-store.ts),
[operator CLI](./scripts/Manage-ConfigurationDraft.ts) and
[CF-01 through CF-15](./tests/configuration-foundation.test.ts):

- Exact bounded flat model, duplicate/unsafe/noncanonical input rejection,
  deterministic exact artifacts with fresh UUID expressions and ordered markers.
- Immutable scoped drafts, canonical hashes, exact validation/diff/impact and
  same-author-permitted approval. Local operator reference is attribution only;
  runtime apply authorization stays false.
- Real-process contention, exact operation-ID retry/conflict, durable fencing,
  cancellation before any effects and persistent uncertain status. Kill inside
  the actual claim transaction rolls back all operation rows; kill after commit
  retains the claim. Receipt insertion failures cannot produce success.
- Read-only/no-create inspection, restart persistence, corruption/compiler/hash
  binding checks, and a real CLI workflow across separate processes.

These cover **offline portions only** of CP-01/02/03/07/09/10, not complete CP
passes. Base zero means no verified revision, not an inspected empty namespace;
validation diff is additive against `empty-uninspected`. Offline scope labels
are not provisioned runtime bindings. That offline increment added no disk/loaded
inspection, include hook, staging, apply/reload, canary, last-verified pointer,
recovery or rollback. No PBX started/reloaded, existing route changed, permission
or dependency added, phone enabled or REFER test rerun in that increment.

Recorded validation: `npm run typecheck` and **68 focused tests pass**:
15 new CF tests plus 53 existing provisioning-store, history-manifest and
history-projection regressions. No failures, skips or cancelled tests. Test-owned
child processes and temporary stores are cleaned; no runtime proof is claimed.

#### Selected CI batch: owned read-only empty-baseline inspection

The next authorized increment implements the
[owned binding/read-only inspector](./src/configuration-inspector.ts),
[operator CLI](./scripts/Inspect-Configuration.ts),
[CIU-01 through CIU-09 offline tests](./tests/configuration-inspector.test.ts)
and [CI-01 through CI-10 runtime proof](./tests/configuration-inspection/run.ts).
Trusted bootstrap creates binding files only after the exact expected empty
disk and known loaded baseline are observed. Local attribution/checksums are
not authenticated customer permissions or tamper-resistant runtime attestation.
The separate inspector does not upgrade offline draft approvals or claims.

| Check | Measured result |
|---|---|
| CI-01 | Two unique owned pinned PBXs: exact known 18-priority/2-context unmanaged dialplan, empty managed disk files, no reserved loaded context/queue, cold quiescence and UUID module. All 22 bootstrap hashes and identity prerequisites match before binding persistence. |
| CI-02 | Actual operator CLI reads persistent canonical/checksummed bindings for both scopes without changing them; result explicitly says no executor or verified publication. |
| CI-03 | Foreign scope, swapped other-customer container and altered mount source fail closed. Offline CIU checks additionally cover wrong image/project/service, ports, writable/shadow mounts and malformed/arbitrary-command bindings. |
| CI-04 | Disk-only managed-file drift blocks; actual CLI exits 2, loaded baseline remains distinct and B is unaffected. Inspector never repairs it. |
| CI-05 | Changed dependency, missing managed file and extra dependency file block independently. A directory in the bounded file inventory makes inspection unavailable, not success. Explicit test restoration recovers the empty observation. |
| CI-06 | Owned A stop yields unavailable, including actual CLI exit 1 and no success-shaped result; B remains independently responsive. |
| CI-07 | Fault fixture loads one compiler route/queue **at cold bootstrap**, then restores both files to empty without reload. New inspection candidate sees matching disk but one reserved loaded context/queue and blocks both loaded inventories. B stays unchanged. No binding is persisted for that collision. |
| CI-08 | Old binding rejects the changed boot and remains byte-for-byte unchanged. A subsequent clean cold boot can be observed only as a separate test candidate; no automatic rebind, resume or verified publication. |
| CI-09 | All generated bootstrap bytes match their original hashes again, by explicit test restoration, not inspector repair. Persistent bindings remain unchanged. No inspector config mutation, call, reload or credential disclosure. |
| CI-10 | Owned containers/networks/volumes independently absent; generated config/credential copies and Compose override removed. Repository baseline unchanged. Only two synthetic binding metadata files and the result report retained. |

Recorded run **`run-OymB5Y`**, project **`asterisk-inspection-oymb5y`**, passes
all ten runtime checks and the wrapper's typecheck plus **77 focused tests**
(9 CIU, 15 CF, 53 existing store/manifest/projection regressions). Reproduce with
`.\scripts\Test-ConfigurationInspection.ps1`; pinned local image only,
`--pull never --no-build`. No dependency, production permission, phone, ordinary
route/shared PBX mutation or REFER rerun.

Inspection status is sampled `empty-baseline-observed`, `blocked` or `unavailable`,
never `verified`/apply readiness. No-follow/regular-file guards and bounded reads
exist; this batch does not prove every symlink/filesystem race. Exact dialplan
inventory is compared, but `queue show` does **not** reveal every loaded queue
policy (timeout/joinempty/etc.). Empty-baseline include loading at bootstrap does
not prove scoped reload or safe publication. There is no nonempty published-state
inspector, runtime apply-authorization tuple, staging, executor, canary, last-verified
pointer, conditional recovery/rollback or automatic rebind.

CI adds **partial empty-baseline evidence** for CP-04/05/09/10; all full CP checks
remain unverified.

#### Pre-executor CQ batch: bound offline review and queue-policy limit

An optional immutable review now binds a still-unapproved draft's approval to
the exact full binding, exact observation digest/time and stable baseline
fingerprint. Existing ordinary approvals cannot be upgraded or rewritten.
[Review CLI](./scripts/Review-ConfigurationInspection.ts) `approve` inspects
outside the short SQLite receipt transaction; `check` reads the existing DB
read-only and resamples without updating approval. Both remain explicitly offline,
`runtimeApplyAuthorized:false`. Unsupported loaded policy is not approved as fact.

| Check | Measured result |
|---|---|
| CQ-01 | Fixed pinned runtime `queue show`, `QUEUE_VARIABLES`, `QUEUE_EXISTS` help captured read-only. No AMI enabled or channel-function evaluation; no timeout/join/leave field established. |
| CQ-02 | Both customer actual CLI workflows persist exact draft/validation/binding/observation-bound reviews. Fresh read-only checks match stable baseline despite distinct sample times; receipt/database bytes are unchanged by check. Disk drift fails the check without mutating approval. |
| CQ-03 | Restarted bound runtime makes current review check fail; no automatic refresh/rebind of existing reviewed approval. |
| CQ-04 | Different cold-bootstrap inputs (timeout 2->7, joinempty yes->no, leavewhenempty no->yes), followed by disk restoration without reload, yield an identical queue-display digest. Independently loaded values remain unsupported, not inferred from disk or assumed green. B remains responsive. |

All inspector reports explicitly list unobserved `timeout`, `joinempty` and
`leavewhenempty` with `queuePolicy.status:unsupported`. Consult
[QueueParams](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/AMI_Events/QueueParams/)
and [QUEUE_VARIABLES](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/Dialplan_Functions/QUEUE_VARIABLES/)
for the documented summary fields; this proof bounds tested surfaces, not every
possible API. No privileged debugger, custom module, reload, call or apply.

Extended run **`run-k6u3PD`** / **`asterisk-inspection-k6u3pd`** passes typecheck,
**85 focused tests** (eight CQR plus the prior 77), ten CI and four CQ runtime
checks. `.\scripts\Test-ConfigurationInspection.ps1 -WithReviewPolicy` reproduces
it with the local pinned image. Owned resources and generated credential/config
copies are removed; only synthetic bindings, review SQLite and report retained.
No schema migration, dependency/permission change, live phone, shared PBX,
ordinary routing or REFER rerun.

This is partial CP-02/03/04/09/10 evidence, not complete publication acceptance.
There is no inspection expiry policy, atomic inspect-to-effect fence, full
historical report persistence in approval, runtime executor, verification pointer
or recovery. **The exact loaded-policy blocker is not closed.** Next needs an
explicit choice: preserve exact verification and investigate a suitable independent
read-only surface, or deliberately narrow the contract before authorizing any
executor. A matching baseline/review/disk hash or single canary is not a substitute.
If exact loaded-state facts
or safe scoped application cannot be verified on the pinned runtime, implementation
must stop/narrow the contract rather than substitute a green file hash.
M1-09 remains open; the 17 full M1 gates are unchanged.

#### Independent policy research: exact contract preserved, executor stopped

The recommended preserve-exact-verification choice was accepted for the next
investigation. [Fixed capability capture](./tests/configuration-inspection/capabilities.ts)
now records 13 version/queue-registry/function-help/AMI-help/ARI-module/HTTP
metadata reads per customer. [Four QPU tests](./tests/configuration-capabilities.test.ts)
cover finite command identity, bounded normalized output, unsupported/version
failure and explicit outage. No AMI/ARI service is enabled or requested, channel
function evaluated, module loaded, debugger attached or call/reload performed.

Actual pinned metadata records ten queue CLI commands, eight queue functions,
AMI summary/rule/config/Getvar help, zero ARI modules and disabled HTTP.
[Public upstream 22.11.0 source analysis](./PROJECT-PLAN.md#independent-loaded-policy-surface-investigation)
distinguishes summary/member/caller data from the missing loaded timeout/
joinempty/leavewhenempty. GetConfig reads files, QueueRule reads penalty rules,
Getvar evaluates expressions, and ARI dynamic config retrieves registered
Sorcery objects rather than an arbitrary private queue struct. Queue functions
are not assumed side-effect-free; upstream lookups can load realtime queues.
The tested fixed static fixture is not a general production read-only guarantee.

Run **`run-IB8Tum`** / **`asterisk-inspection-ib8tum`** passes typecheck and
**89 focused tests**, ten CI/four CQ runtime checks and **26** captured metadata
reads. Reproduce with `.\scripts\Test-ConfigurationInspection.ps1 -WithCapabilities`
(includes the review-policy checks). Owned resources and generated credentials/
configuration absent, repository baseline unchanged; bindings/review/report only
retained. Capture metadata is research evidence, not an automatically established
reader or a proof that every possible API is absent.

**Result: no acceptable independent reader established; no blocker closed.**
Exact verification is not narrowed, unsupported policy remains explicit, and
all full CP checks/M1-09 remain open. Next requires a separately approved design
for read-only observability within the runtime's queue ownership/locking model,
with bounded scoped output, no realtime-loading side effects and pinned
source/build provenance, or deferral of publication. No custom module/patch/build
is authorized here; a standalone module is not assumed capable of safe access
to private queue fields. Do not repeat summary probes indefinitely or move to
apply/canary as a substitute.

#### Selected QO design: app_queue-owned read-only policy getter

User selected **`design-queue-observability`**, explicitly **design only**.
The [detailed getter design](./PROJECT-PLAN.md#selected-design-app_queue-owned-read-only-policy-observation)
proposes a finite operator-local `queue policy snapshot <bound-namespace>`
command inside app_queue. It reads only existing in-memory static queue objects;
no standalone private-struct reader, realtime lookup/refresh, debugger/memory
access, arbitrary expression, AMI/ARI endpoint or queue mutation.

The trusted adapter checks the exact owned container/image/build/start/mount
binding before/after the read. CLI prefix selection is not customer authentication;
separate owned PBXs remain the isolation boundary. Only `proof-queue` and all
names in the bound reserved prefix may be returned, with no member/caller
identifiers, source text or credentials.

Planned output is one bounded 8 KiB versioned JSON document with canonical
strategy, **member ring timeout**, effective join/leave masks and empty-state
counts. Do not confuse ring timeout with the compiled total queue-wait argument.
Reviewed source maps current yes/no policy to masks **0/0**, and the adverse
no/yes fixture to **35/35**; expected ring timeouts are **2/7**. These are
source-derived design expectations, **not getter measurements**. It reports
effective semantics, not original configuration spelling.

Design requires safe references, bounded container traversal (64 objects),
8 selected rows, nonblocking/bounded queue/member-count locks, no I/O under
locks and identity/membership/fact rechecks. No lifetime reference is mistaken
for current membership, no partial green result, and no all-runtime atomic
snapshot or ABA protection claim. Lock/API feasibility must be verified before
implementation. Error/busy/unsupported/unstable output cannot verify state.

A separately approved pinned **full custom Asterisk build/runtime image** is
required, not a single module dropped into the stock image. Record source/
patch/toolchain/dependency/configuration provenance, license obligations and
image/module digests; a self-reported version or file checksum alone is not
loaded-binary attestation or a reproducible-build result. Default stock runtime,
old bindings and unsupported reports remain unchanged.

| Check | Planned QO acceptance; **not executed** |
|---|---|
| QO-01 | Owner-local API, exact argument/schema bounds, trusted scope gating and no authentication/disclosure overclaim. |
| QO-02 | Instrumented no-load/no-refresh/no-mutation behavior, absent/realtime/dead rejection and reference cleanup. |
| QO-03 | Lock-order/timeout/replacement/contention proof, no deadlock/orphan handler, bounded sampling and no locked I/O. |
| QO-04 | Independent timeout/mask/alias fixtures and timer distinction; changed loaded 2/0/0 versus 7/35/35 despite matching restored disk. |
| QO-05 | Exact reserved/baseline inventory, extra/missing objects, bounds, nonempty/inconsistent counts and no private identifiers. |
| QO-06 | Strict bounded host protocol/value comparison; malformed/truncated/unknown/error/success-exit-without-facts denial; old unsupported evidence preserved. |
| QO-07 | Separate pinned full build/manifest/ABI/startup-provenance gate; mismatched build/binary/binding rejected, stock default untouched. |
| QO-08 | Two uniquely owned custom-image read-only proofs and scoped loaded/disk negatives, no apply/reload/calls or shared PBX access. |
| QO-09 | Outage/restart/concurrency/change/receipt failures preserve history, no retry-to-green/rebind/resume or publication side effects. |
| QO-10 | Stock/custom functional/locking/disclosure regressions and verified owned cleanup; exact retained provenance/evidence and excluded surfaces unchanged. |

**All QO checks are planned/unverified.** This increment edits documentation only:
no patch, custom image build, dependency install, runtime execution, API/permission
change, reload, call, ordinary route/phone/REFER change or publication.
Documentation consistency and diff hygiene are the only validation required.
Next is a separate implementation/build decision; the selected exact-verification
blocker, full CP gates and M1-09 remain open.

#### QO feasibility review: source findings, not acceptance passes

The user next selected **`feasibility-only`**. The
[read-only review](./PROJECT-PLAN.md#read-only-feasibility-review-implementation-not-cleared)
pins upstream 22.11.0 to commit
`874768141f94bc03865cc746eee1c7669e3c46d5` and records eight reviewed source
hashes. Supported AO2 try-locks and mutex container types are confirmed in
source, **not tested in a patched runtime**.

The proposed algorithm is not yet cleared for implementation:

- A 64-live-object ceiling does not bound hash iteration over retained empty
  nodes; ordinary iterator and teardown paths can also take blocking locks.
- A getter's final reference release after queue retirement can invoke queue
  destruction, blocking member cleanup and device-state changes.
- Queue retirement writes `dead` under the global container lock without the
  individual queue lock. Field ownership needs a complete lock matrix.
- AO2 debug/reference logging and integrity checks affect bounded/no-I/O claims.

Host/daemon capacity was sampled read-only; no build benchmark or reservation
was made. Required dependency categories and declared bundled versions were
identified, but immutable builder/runtime/package/archive closure remains
unselected. Proposed resource caps require later approval and enforcement.
No packages, patch, image, module or PBX were installed, built or started.

**QO-01 through QO-10 remain unexecuted; QO-03 and QO-07 are specifically
blocked.** Next is design resolution of traversal/lifetime/locking and pinned
build inputs, or deferral. No implicit build authority, acceptance weakening,
publication executor or M1-09 closure follows from this review.

#### QO design resolution: stable membership does not prove traversal bounds

User authorized **`resolve-design-only`**, with a stop if bounds could not be
established. The [design resolution and field-lock matrix](./PROJECT-PLAN.md#design-resolution-membership-stable-candidate-traversal-stop)
replace the original split reference/recheck approach with a **conditional,
unimplemented candidate**: hold the global queue-container mutex, borrow queue
pointers inside a no-data/no-unlink callback, try-lock selected queue/member
containers without waiting, copy facts and finish traversal cleanup before
global unlock. No queue pointer escapes and the getter owns no queue reference
whose release could become final after concurrent retirement.

The matrix distinguishes static retirement under the global lock, policy/caller
facts under queue locks and member counts under the member-container lock.
Realtime objects must be rejected before reading retirement facts; the candidate
does not fix or claim to protect realtime writes outside those locks. Module/
container lifetime and lower-level logging/cleanup remain proof prerequisites.

**The strict bound is still unresolved:** iterator **and callback** traversal
can skip retained empty hash nodes before the next application callback.
Holding the global lock prevents new changes but does not bound existing nodes.
Callback counters/time checks, debug stats text, exact-name-only lookup and
host timeouts are not accepted substitutes.

**Stop: QO-03 remains blocked; no coding/build is cleared.** A budgeted traversal/
typed physical-node-bound API would expand into AO2 ownership and needs its own
explicit scope decision, or getter work must be deferred. No source patch,
dependency install, image build, PBX command, QO execution or gate closure
occurred. The existing stock unsupported behavior remains unchanged.

#### Selected AO2 bounded-traversal design: not implemented

User selected **`design-ao2-bounded-traversal`**, expanding **design only** into
AO2 ownership. The [owner API contract](./PROJECT-PLAN.md#selected-ao2-design-budgeted-borrowed-traversal)
proposes a new hash-family/direct-mutex visitor API with one try-lock and
explicit bucket, physical-node and live-object budgets, capped at **64/128/64**.
Every empty retained node is charged inside the owner; no ordinary iterator/
callback skipping, returned references, allocation, destructor, resume or retry.
An exactly exhausted budget can succeed only if the actual full traversal ends.
Visitor abort and any limit/error are incomplete, never partial green inventory.

The queue integration uses one restricted borrowed-pointer fact-copy visitor,
at most eight selected rows and 17 global/queue/member acquisition attempts.
Global membership stays stable; static fields use the prior lock matrix.
No queue pointer escapes, and serialization happens after unlock. Callback
behavior, module/container lifetime and lower-level wrappers are explicit proof
obligations, not properties enforced by an arbitrary C function pointer.

**AT-01 through AT-10 are planned/unexecuted prerequisites to QO-03**, covering
exact node/bucket/object boundaries, retained nodes, contention, all abort/cleanup
paths, reference/mutation counters, restricted queue integration, lifetime and
stock regressions. This is a concrete design route past the traversal gap, not
an implemented API, runtime latency measurement or accepted upstream change.
The custom source boundary would now include the public AO2 header/hash owner
and app_queue. No source patch/install/build/PBX was performed. QO-03/QO-07,
all QO execution, publication verification, full CP and M1-09 remain open;
implementation and build/resource approval are still separate decisions.

#### QO CLI lifetime review: no teardown guarantee claimed

The accepted scope form contained no values, so the recommended
**`review-lifetime-only`** default was used. The
[pinned CLI/loader trace](./PROJECT-PLAN.md#cli-lifetime-review-module-references-are-not-an-unload-barrier)
records four additional source hashes and confirms module-owned registration,
normal dispatch-time running-module references, ordinary use-count unload
checks and app_queue teardown ordering.

It also establishes limits: CLI unregistration warns/skips an in-use entry but
returns zero rather than draining; forced unload bypasses use counts; and the
reviewed running-check/reference path does not itself hold the loader lock
across both operations. **Concurrent dispatch versus teardown is not proven.**
The queue mutex, a non-null container check, extra ref or host binding checks
are not substitutes for module/container lifetime synchronization.

The owned quiescent proof excludes lifecycle writers during observation;
AT-09/QO-03 retain their lifecycle proof obligation. Any core CLI/loader gate
would be a separate scope expansion, not a patch authorized here.
The protocol also distinguishes transport success from logical success:
handled error JSON must avoid dispatcher-added failure text, and host parsing
still blocks on `status:"error"`, non-JSON, truncation or missing evidence.

No patch, installation, build, module command, PBX execution or AT/QO pass
occurred. Documentation/source-hash/link/diff checks only; QO-03/QO-07,
publication verification, full CP and M1-09 remain open.

#### Consolidated getter delivery proposal: approvals pending

The user selected **`consolidated-implementation-proposal`**: preparation only.
The [single delivery proposal](./PROJECT-PLAN.md#consolidated-proposal-protected-getter-implementation-and-build-gates)
now combines lifecycle, AO2, getter, native tests, custom-image and host
observation work, rather than authorizing further automatic source reviews.

Recommended lifecycle mechanism is an opt-in protected CLI lease: serialized
try-only admission against teardown, coverage through final entry/output access,
explicit protected-unregister failure and no cleanup/dlclose while leased.
**Refusing even firm/hard unload while a protected reader is active is an
intentional proposed behavior change**, requiring implementation approval.
No generic claim about stock module unload safety is made.

| Gate | Pending approval and exit |
|---|---|
| A: implementation | Explicit core CLI/loader expansion and force-veto agreement; pinned patch/native tests, then AO2/getter layers. Deterministic lifecycle schedules and actual implementation checks, not simulated passes. |
| B: dependencies/build | Immutable complete input/module/license closure and enforceable approved resource caps before installation/build. Prior capacity sample and proposed caps are not authorization. |
| C: owned runtime proof | Approved built image/provenance and native exits before unique two-customer QO tests; no apply/reload/calls/shared PBX changes. Verified cleanup and retained exact evidence. |

All gates are **pending**, all AT/QO tests remain unexecuted, and source-only
work cannot be reported as verified. Next is approval/rejection of A; B/C remain
separate. No patch, dependency install, build or PBX command was performed for
this proposal. Exact-policy verification, full CP and M1-09 remain open.

#### Gate A source candidate: no native acceptance result

The user explicitly approved A, including protected-reader forced-unload veto.
The [source-candidate record](./PROJECT-PLAN.md#gate-a-source-candidate-implemented-not-natively-verified)
links the pinned patch, source hash manifest and read-only package validator.
Seven existing upstream files implement opt-in CLI/loader leases, protected
unregistration, bounded hash-owner traversal and the queue-policy getter;
one new native test module plus an app_queue test define five initial tests.

Source-package integrity, seven preimages, clean dry-run application and all
eight exact applied postimages are checked separately from native behavior.
Six package tests check integrity/denial and honest unverified output only.
**No C compilation, native test, custom image, dependency install or PBX
execution occurred.** All manifest native/runtime success flags remain false.

Native test coverage is initial and incomplete: remaining deterministic
lifecycle schedules, contention, boundary/profile and upstream regressions
still need source/execution work. Tests containing self-module unload attempts
require separately approved disposable native test execution; they are not
ordinary runtime-proof authority. Host custom binding/parser wiring remains
pending; the stock inspector and default runtime are untouched.

A is authorized with a persisted candidate, **not a verified exit**. B/C,
AT-01 through AT-10, QO-01 through QO-10, full CP and M1-09 remain open.

The subsequent [Gate A coverage increment](./PROJECT-PLAN.md#gate-a-coverage-increment-eight-native-definitions-still-unexecuted)
brings native definitions to **eight**, adding AO2 argument/bucket/unsupported
matrix, barrier-controlled cross-thread contention and borrowed-ownership/
abort checks; retained-node source cases now include 127/128/129.
All seven production-source postimages are unchanged. **Ten package tests
pass** and the validator matches native definitions/registration/unregistration
to the manifest. Clean patch application and all eight exact postimages were
rechecked. None of these are native test results: compilation, remaining native
coverage, AT/QO and Gates B/C remain pending; no image/PBX ran.

The next [queue coverage-source increment](./PROJECT-PLAN.md#gate-a-queue-coverage-eleven-native-definitions-still-unexecuted)
brings the inventory to **eleven unexecuted native definitions**. Three private
`app_queue` tests cover canonical/foreign/invalid names, suffix/name/row bounds,
duplicate denial, policy/count/head consistency, empty/one-member counts and
exact malformed-request JSON plus metadata-only init/completion.
Changes are confined to `TEST_FRAMEWORK` fixtures and registration; comparison
with the prior candidate confirms unchanged production queue implementation.
**Ten package tests pass** and exact preimages/application/eight postimages
match. Successful/error-after-sampling protocol, member ceilings, subordinate
contention, lifecycle/profile schedules and native compilation/execution remain
pending. A is not a verified exit; Gates B/C and AT/QO stay open.

The subsequent [subordinate-lock coverage source](./PROJECT-PLAN.md#gate-a-subordinate-locks-twelve-native-definitions-still-unexecuted)
brings the inventory to **twelve uncompiled/unexecuted native definitions**.
One new test defines eight queue/member, selected/foreign and zero/one-prefix
contention schedules, with real cross-thread holders and post-release probes
to detect leaked reader locks without same-thread recursive-lock false
positives. Recovery must append one row without changing the prefix.
**Ten package tests pass**; exact preimages/application/postimages match and
production implementation is unchanged outside test fixtures/registration.
This does not pass native contention acceptance or open Gates B/C. Remaining
protocol/lifecycle/profile coverage, native execution and all AT/QO stay open.

The next [protocol/checked-output increment](./PROJECT-PLAN.md#gate-a-protocol-and-checked-output-fourteen-definitions-still-unexecuted)
fixes an actual candidate defect: pinned `ast_cli` returns void, so the prior
getter's return-value comparisons were invalid C. The private formatter now
constructs complete bounded JSON and uses `ast_carefulwrite` with the stock
100-ms setting. Nonblocking-descriptor assumptions still apply; no hard
transport deadline or atomic-write claim is added. This is a production
correction/extraction, not tests-only work.
Two new native definitions cover exact empty/full/sorted/error JSON, all eight
canonical strategies, no observed document on buffered format failure and
invalid-descriptor transport failure. **Fourteen native definitions remain
uncompiled/unexecuted; eleven package tests pass**, including a narrow source
guard against the void-API misuse. Exact application/postimages match;
request/traversal/locking logic and all other source-file postimages are
unchanged. Actual native compilation/protocol/lifecycle/profile acceptance
and Gates B/C remain pending.

The subsequent [CLI exit coverage source](./PROJECT-PLAN.md#gate-a-cli-exit-coverage-sixteen-definitions-still-unexecuted)
brings the inventory to **sixteen uncompiled/unexecuted native definitions**.
Real dispatch source schedules now cover success/failure/usage returns; two
new definitions cover allocated/null completion callbacks with active unload
veto and null-owner registration/null-module admission rejection. Completion
does not attempt a registry writer while holding its read lock. Entry drain
is checked, but exact private lease-count release and the remaining loader/
shutdown/output-boundary schedules are not established.
**Eleven package tests pass**; exact application/eight postimages match and
all seven production postimages are unchanged. A's verified exit, native
execution, AT/QO and Gates B/C remain open.

The next [rejected-state source increment](./PROJECT-PLAN.md#gate-a-rejected-states-seventeen-definitions-still-unexecuted)
brings the inventory to **seventeen uncompiled/unexecuted native definitions**.
Its eighteen private-fixture schedules combine nine realtime/dead/member/
policy/count rejection states with zero/one prior row. They assert
`unsupported-state`, byte-preserved rows, cross-thread original mutex cleanup
and recovery after supported state is restored. Probes are shared with the
existing contention fixture; no global queues or backends are used.
**Eleven package tests pass**; exact preimages/application/eight postimages
match. Production implementation is unchanged outside native-test fixtures/
registration. Remaining instrumentation, integration, member ceilings and
loader/shutdown coverage, A's verified exit, AT/QO and Gates B/C remain open.

The next [private traversal integration](./PROJECT-PLAN.md#gate-a-private-traversal-integration-eighteen-definitions-still-unexecuted)
brings the inventory to **eighteen uncompiled/unexecuted native definitions**.
It connects the actual bounded AO2 traversal, queue visitor and responder using
a private list: empty success, selected/foreign sorted success, late dead-queue
rejection and ninth-row limit. Exact error envelopes exclude retained rows.
**Eleven package tests pass** and exact application/eight postimages match;
production code is unchanged outside fixtures/registration. Global-handler
mapping/dispatch, concurrent runtime and remaining lifecycle/profile acceptance
remain unproven. A's verified exit, AT/QO and Gates B/C remain open.

The next [owner-boundary increment](./PROJECT-PLAN.md#gate-a-owner-boundaries-twenty-definitions-still-unexecuted)
brings the inventory to **twenty uncompiled/unexecuted native definitions**.
Actual RW/no-lock queue fixtures reject without changing previous rows.
A real private member container accepts 65,535 objects, rejects 65,536,
recovers after unlinking one and accounts for destruction during cleanup.
The large fixture's allocation/teardown/debug cost needs a separately approved
native budget; no measured resource or native pass is claimed.
**Eleven package tests pass**; exact application/eight postimages match and
production code remains unchanged outside test fixtures/registration.
A's verified exit, global-handler/lease/lifecycle/profile acceptance, AT/QO
and Gates B/C remain open.

The subsequent [status-mapping increment](./PROJECT-PLAN.md#gate-a-status-mapping-twenty-one-definitions-still-unexecuted)
extracts the existing handler switch unchanged into a private helper and brings
the inventory to **twenty-one uncompiled/unexecuted native definitions**.
Its 90 injected status/prior-error/retained-row combinations check exact error
selection, unchanged sample data and real responder JSON with no partial
observed output on incomplete traversal. These do not execute the global
handler or demonstrate that actual containers produced every status.
**Eleven package tests pass**; exact extraction comparison, source application
and all eight postimages match. Remaining native/global/lifecycle/profile
acceptance, A's verified exit, AT/QO and Gates B/C remain open.

The [Gate A acceptance reconciliation](./PROJECT-PLAN.md#gate-a-acceptance-reconciliation-source-coverage-is-not-an-exit)
maps all ten AT and ten QO requirements to the current 21 native source
definitions and their missing evidence. No acceptance check is passed by
inventory size or package tests. The critical next A work is safe test-only
lifecycle synchronization/exact counters, with a controller outside the
unloadable target, covering admission versus teardown and final output/release.
No new test execution or patch change accompanies this documentation-only
reconciliation. Gate B still requires pinned dependency/build closure and
enforced resources before compilation; Gate C independently gates PBX proof.

The user then approved the [separate lifecycle target source](./PROJECT-PLAN.md#gate-a-separate-lifecycle-target-twenty-two-definitions-still-unexecuted):
one additional disposable native module plus `TEST_FRAMEWORK`-only core/header
instrumentation. The package now has nine source paths and **22 uncompiled/
unexecuted test definitions**. One new controller test defines 12 admission/
handler-return/entry-cleanup/final-decrement schedules across three handler
outcomes, with actual reader/event counts and separate target unload.
The target must not autoload; tests require a serialized disposable process,
external watchdog and separately approved native resources. Teardown-first,
shutdown/startup/unload-failure, completion instrumentation and slow output
remain uncovered. **Twelve package tests pass**; exact application/nine
postimages match, with lexical test-profile-off core parity only.
No build/native/PBX execution occurred; A's verified exit, AT/QO and B/C remain
open.

The subsequent [instrumented completion source](./PROJECT-PLAN.md#gate-a-instrumented-completion-twenty-three-definitions-still-unexecuted)
brings the inventory to **23 uncompiled/unexecuted native definitions**.
Eight separate-target completion schedules reuse actual reader/event counters
across four pause points and allocated/null results. At post-release completion,
unload is deferred until worker join because the registry read lock still
protects generator traversal; zero reader count does not mean that lock is gone.
**Twelve package tests pass** and exact application/nine postimages match;
only guarded CLI hooks and native fixtures change. Missing teardown-first,
loader/shutdown/profile schedules and all native acceptance remain pending.
A's verified exit, AT/QO and Gates B/C remain open.

The [teardown-first closing source](./PROJECT-PLAN.md#gate-a-teardown-first-closing-twenty-four-definitions-still-unexecuted)
brings the inventory to **24 uncompiled/unexecuted native definitions**.
A one-shot target unload refusal leaves the command registered but admission
closed; one dispatch and two completions must produce exactly three observed
closing denials, zero leases/callbacks and zero readers. Successful cleanup and
a fresh-load admission/release/unload schedule follow. This is sequential
failed-teardown-before-admission coverage, not a lookup/teardown race proof.
**Twelve package tests pass**; exact application/nine postimages match and
test-profile-off header/loader lexical parity passes, not native acceptance.
A's verified exit, AT/QO and Gates B/C remain open; no native/PBX execution.

The [lookup ordering source](./PROJECT-PLAN.md#gate-a-lookup-ordering-twenty-five-definitions-still-unexecuted)
brings the inventory to **25 uncompiled/unexecuted native definitions**.
Three worker schedules pause real dispatch/completion after lookup but before
admission; a failed soft teardown wins, and resumed requests must produce
one closing denial each with zero acquisitions/callbacks/readers. Successful
cleanup waits until worker join. This does not test successful removal while
the registry read lock protects the entry, nor exhaustive concurrency.
**Twelve package tests pass** and exact application/nine postimages match;
header/CLI/loader test-profile-off lexical parity is not native evidence.
A's verified exit, AT/QO and Gates B/C remain open; no native/PBX execution.

The [loader contention source](./PROJECT-PLAN.md#gate-a-loader-contention-twenty-six-definitions-still-unexecuted)
brings the inventory to **26 uncompiled/unexecuted native definitions**.
A separate worker holds the real loader lock while dispatch and two completions
must return denial with three lookups and zero acquisitions/callbacks. After
release/join, the same loaded target must serve all three requests normally,
drain three leases and unload once. This specifies nonwaiting lock refusal,
not measured latency. The test-only helper is disposable-process-only.
**Twelve package tests pass**, exact application/nine postimages match and
header/loader test-profile-off lexical parity passes, not native evidence.
A's verified exit, AT/QO and Gates B/C remain open; no native/PBX execution.

The [permission denial source](./PROJECT-PLAN.md#gate-a-permission-denial-twenty-seven-definitions-still-unexecuted)
brings the inventory to **27 uncompiled/unexecuted native definitions**.
A scoped test-profile deny rule uses the real permission list for a reserved
identity and disposable target prefix, without changing defaults or disk
configuration. Three lifecycle pauses require actual denial, no handler call,
one acquisition/release, correct unload veto and successful post-release
teardown. The controller removes its rule after worker joins. Output remains
`/dev/null`; shutdown, slow output and broader acceptance remain pending.
**Twelve package tests pass**, exact application/nine postimages match and
header/CLI/loader test-profile-off lexical parity passes, not native evidence.
A's verified exit, AT/QO and Gates B/C remain open; no native/PBX execution.

The [nonrecursive refresh source](./PROJECT-PLAN.md#gate-a-nonrecursive-refresh-twenty-eight-definitions-still-unexecuted)
brings the inventory to **28 uncompiled/unexecuted native definitions**.
Existing active-lease lifecycle schedules now require soft/firm/hard refresh
veto. A new test requires failed soft refresh to retain closing admission,
then successful retry to reload the target and serve dispatch plus both
completion branches with exact denial/acquisition/release/teardown counts.
Only the controller postimage changes. Recursive refresh and reload-failure
coverage remain pending. **Twelve package tests pass** and exact application/
nine postimages match; this is not native evidence. A's verified exit, AT/QO
and Gates B/C remain open; no native/PBX execution.

The [current 28-definition acceptance handoff](./PROJECT-PLAN.md#gate-a-current-acceptance-handoff-twenty-eight-definitions-no-native-exit)
reconciles these lifecycle additions against AT/QO without changing the patch
or manifest. All acceptance gates remain open: native execution, shutdown,
recursive/startup/transport failure and exact AO2 work/ref instrumentation
are not established by package checks. The next bounded source priority is
the explicit 63-live/mixed-retained AO2 fixture matrix. Build execution still
needs immutable dependency/profile closure, enforceable resources and explicit
Gate B approval; Gate C separately gates owned runtime proof. This
documentation-only handoff runs no native tests or PBXs.

The [mixed AO2 node source](./PROJECT-PLAN.md#gate-a-mixed-ao2-nodes-twenty-nine-definitions-still-unexecuted)
implements that bounded source priority and brings the inventory to **29
uncompiled/unexecuted native definitions**. A real one-bucket list interleaves
retained-empty/live nodes: 127 nodes/63 live completes; a 127-node budget on
128 nodes limits at 63 visits; 128 nodes/64 live completes; 129 nodes limits
at 128 even after all 64 live objects were visited. Exact borrowed refs,
container counts and fixture destructors are asserted. Only the controller
postimage changes. **Twelve package tests pass** and exact application/nine
postimages match. Native work/ref instrumentation and all AT/QO acceptance
remain pending; Gates B/C stay closed and no native/PBX execution occurs.

The [mixed-node abort/recovery extension](./PROJECT-PLAN.md#gate-a-mixed-node-abort-and-recovery-inventory-unchanged-still-unexecuted)
adds seven walk assertions inside the existing definition; inventory remains
**29 uncompiled/unexecuted native definitions**. Aborts at live positions
1/32/63/64 must charge 2/64/126/128 physical nodes. Releasing the trailing
retained-empty node must restore 128-node completion; releasing the remaining
retained nodes must leave exact 63-budget limit/64-budget completion with
unchanged live/destructor totals. Only the controller postimage changes.
**Twelve package tests pass** and exact application/nine postimages match.
Native instrumentation/acceptance remain pending; Gates B/C stay closed.

The [mixed-node failure-path extension](./PROJECT-PLAN.md#gate-a-mixed-node-failure-paths-inventory-unchanged-still-unexecuted)
adds five walks without changing the **29-definition uncompiled/unexecuted**
inventory: object-budget 63 rejects a 64-live chain before traversal; invalid
visitor returns at live 1/32/64 report internal failure at physical 2/64/128;
a normal visitor then restores the expected physical-limit result. Counts,
borrowed references and destructors must remain unchanged. Only the controller
postimage changes. **Twelve package tests pass** and exact application/nine
postimages match. All native acceptance and Gates B/C remain open.

The [owner callback-work source](./PROJECT-PLAN.md#gate-a-owner-callback-work-thirty-definitions-still-unexecuted)
brings the inventory to **30 uncompiled/unexecuted native definitions**.
A real sorted 53-bucket container places 64 keyed objects in one collision
chain. Positive insertion/find controls calibrate hash/sort/comparison counters;
eight bounded walks across completion, limits, aborts, invalid return and
recovery must leave those counters unchanged, with exact visits/refs and no
destructor until cleanup. Only the controller postimage changes.
**Twelve package tests pass** and exact application/nine postimages match.
Full work/ref/profile instrumentation and native acceptance remain pending;
Gates B/C stay closed with no native/PBX execution.

The [sparse-bucket accounting extension](./PROJECT-PLAN.md#gate-a-sparse-bucket-accounting-inventory-unchanged-still-unexecuted)
runs the existing callback matrix with collision chains in buckets 0/26/52:
**24 source walk schedules**, still **30 uncompiled/unexecuted definitions**.
Partial walks must count 1/27/53 buckets including preceding empty buckets;
complete walks count all 53 and object preflight counts zero. Callback/ref/
destructor assertions remain intact. Only the controller postimage changes.
**Twelve package tests pass** and exact application/nine postimages match.
All native/AT/QO acceptance and Gates B/C remain open; no native/PBX execution.

The [distributed hard-ceiling extension](./PROJECT-PLAN.md#gate-a-distributed-hard-ceilings-inventory-unchanged-still-unexecuted)
adds nine walks on a real 64-bucket container with one live object per bucket;
the callback definition now contains 33 schedules, while inventory remains
**30 uncompiled/unexecuted definitions**. A 63-bucket budget rejects before
traversal; a 63-node budget charges 64 buckets but only 63 nodes/visits.
Complete/abort/invalid-return walks retain exact counts and calibrated
callback/ref/destructor assertions. Only the controller postimage changes.
**Twelve package tests pass** and exact application/nine postimages match.
All native/AT/QO acceptance and Gates B/C remain open; no native/PBX execution.

The [independent lock-exit source probes](./PROJECT-PLAN.md#gate-a-independent-lock-exit-probes-inventory-unchanged-still-unexecuted)
add actual-container foreign-thread try-lock/unlock checks after the 16 mixed
and 33 callback-matrix walks. This detects held recursive mutexes that a
same-thread retry could miss; probes run outside the bounded traversal.
Only the controller postimage changes; inventory remains **30 uncompiled/
unexecuted native definitions**. **Twelve package tests pass** and exact
application/nine postimages match. Exact internal lock instrumentation and
native acceptance remain pending; Gates B/C stay closed, with no native/PBX run.

### First native compile completed

Gate B's explicitly approved locked dependency installation and instrumented/
release compilation now pass. The [build handoff](./PROJECT-PLAN.md#first-native-build-both-profiles-compiled-no-runtime-yet)
and [compile report](./local/asterisk-build/compile-report.json) bind the exact
source patch to 46 instrumented and 44 release SHA256-verified x86-64 ELF
outputs. The inventory remains 30 definitions: now compiled, **not executed**.
One GCC developer-mode warning in the getter was corrected with explicit
boolean parentheses; no warning suppression or semantic change was used.
No Asterisk startup, native test, existing-PBX operation or runtime image
export occurred. Gate A acceptance and Gate C remain open.

### First native runtime batch passed

Following explicit runtime approval, all **30 of 30 native definitions pass**
in fresh per-definition disposable Asterisk processes. See the
[native handoff](./PROJECT-PLAN.md#first-native-test-batch-thirty-of-thirty-pass),
[result record](./local/asterisk-build/native-test-report.json) and
[aggregate XML](./local/asterisk-build/native-test-results.xml).
The 31.066-second serialized batch used the hash-verified instrumented build,
autoload off, only queue/controller startup modules, no SIP drivers and a
private network namespace. All original XML hashes, exact executed inventory
and owned-process cleanup were independently verified. The builder is stopped.
The earlier compiled-but-unexecuted status is superseded for these definitions;
broader lifecycle/output/AO2 acceptance obligations and Gate C remain open.

### Release loaded-state smoke passed

The explicitly approved disposable release smoke now passes twice. Its
[report](./local/asterisk-build/release-smoke-report.json) verifies 44 release
output hashes, 29 resolved shared-library paths/hashes in the builder, absent
test CLI, queue-only startup and five exact loaded-policy observations across
disk edits, reloads and restoration. The final process exited cleanly and the
owned builder is stopped. This does not prove standalone packaging, full
runtime-module startup, SIP/media or Gate C.

### Full 41-module release startup passed after recipe correction

Full startup exposed that the earlier `--disable-all` menuselect recipe also
disabled upstream-default `OPTIONAL_API`. The explicitly approved correction
restores that flag in both profiles, without changing the source patch,
dependencies or 41-module selection. All 30 native definitions and queue-only
release smoke passed again; all 41 release modules now report Running.
The [current validation](./local/asterisk-build/full-startup-validation.json)
binds the corrected binaries and new results; earlier evidence remains
historical. PJSIP has no endpoints/transports; no calls/media or deployment
were authorized or exercised. See the
[full startup handoff](./PROJECT-PLAN.md#full-runtime-startup-restoring-the-upstream-optional-api-default).

### Matching local runtime bundle smoke passed

The approved local staging/smoke produced a private **378-file,
132,821,098-byte** payload from corrected build 4, including 44 release
outputs, resolved libraries/loader, locale/conversion data, notices and
source/build records. All 41 modules ran and all five loaded-policy checks
passed. Every file-backed process mapping at the startup checkpoint was
inside the bundle; all payload hashes, modes, sizes and cleanup were
independently checked. The
[bundle validation](./local/asterisk-build/runtime-bundle-validation.json)
binds its manifest and smoke report; the
[packaging handoff](./PROJECT-PLAN.md#matching-local-runtime-bundle-staged-and-smoke-tested)
records the locale/conversion dependency failures and their fixes.
Only JSON evidence was exported and the dedicated builder is stopped.
This is not a hermetic filesystem/container image, license closure,
redistribution approval, SIP/media proof, deployment or Gate C.

### Container recipe and validation harness prepared only

The user selected **prepare-only**. A
[scratch Dockerfile](./local/asterisk-build/runtime.Dockerfile) and
[opt-in preparation/validation harness](./local/asterisk-build/runtime_image.py)
now target the exact verified bundle. Fourteen offline tests pass, including
mocked smoke success/failure, launch timeout, resource-setting rejection and
ownership-safe cleanup. No real context, image, container, builder restart or
binary export occurred. Actual container compatibility remains untested;
image creation and smoke need separately approved execution/environment scope.
See the [preparation handoff](./PROJECT-PLAN.md#container-recipe-and-validation-harness-prepared-only).

### Local scratch image built and inspected, not started

The user separately approved **build-inspect**, including local binary export
and image creation, but not container runtime. The Linux amd64 image
`asterisk-local-verified:b6eb351-1` is retained locally.
Its [build record](./local/asterisk-build/image-build-validation.json) binds
independent OCI identity/config/layer and exact payload verification:
379 files including the manifest, 41 aliases and numeric ownership/modes.
No container was created or started; no calls, registry push or redistribution
occurred. The builder is stopped and existing containers remain untouched.
See the [image handoff](./PROJECT-PLAN.md#local-scratch-image-built-and-payload-verified-not-started).
The earlier prepare-only and no-host-export records remain historical;
this newer bounded approval supersedes them only for this local build.

### Corrected custom image passes isolated container startup

The separately approved Desktop smoke found a genuine missing dynamic NSS
crypto dependency. After approved correction/rebuild, the current local image
`asterisk-local-verified:nss-1` passes all **41 modules**, five exact policy
observations and graceful exit zero. All owned containers were removed.
The [current validation](./local/asterisk-build/image-startup-validation.json)
binds a new 389-file bundle, native smoke, independently inspected 390-file
image (manifest included), 41 aliases and actual container smoke.
The builder is stopped, existing containers are untouched, and older reports
remain historical. **26 offline image/harness tests and 27 source/evidence
tests pass**. No SIP registration, calls, media, deployment, redistribution,
remaining Gate A acceptance or Gate C is implied. See the
[container startup handoff](./PROJECT-PLAN.md#corrected-image-container-startup-passed-nss-dynamic-dependency-closure).

### Custom image synthetic Local-channel queue timeout passed

One explicitly approved no-network container executed the synthetic private
dialplan. Both Local legs and one queued caller were observed; an empty queue
returned `TIMEOUT` after **3,000 ms**, with zero answered time. The call then
left zero active channels/callers and the container exited zero and was removed.
No rebuild or existing-container changes occurred. The
[functional evidence](./local/asterisk-build/synthetic-local-call-validation.json)
binds the existing image proof. This proves dialplan/empty-queue timeout and
cleanup only, not SIP registration, audio/media, human answering or Gate C.
See the [functional handoff](./PROJECT-PLAN.md#custom-image-synthetic-local-channel-queue-timeout-passed).

### Synthetic answered-member call and caller continuation passed

The custom image now exercises the complementary successful-answer path:
a synthetic Local member answered and held, then hung up; the caller
continued with `QUEUESTATUS=CONTINUE` and **4,505 ms answered time**.
All four Local legs, a queued caller and one completed queue call were
observed. Member removal restored the original empty queue policy, zero
channels remained, and the disposable container exited zero and was removed.
The [functional evidence](./local/asterisk-build/synthetic-answered-call-validation.json)
binds the exact raw report. **43 offline Python tests and 29 source/evidence
tests pass**. No image rebuild, SIP, human answering, media, existing-container
change or Gate C is implied. See the
[answered-member handoff](./PROJECT-PLAN.md#custom-image-synthetic-answered-member-and-caller-continuation-passed).

### Synthetic unanswered-member timeout and cleanup passed

The custom image's third synthetic queue path passes: a Local member signals
ringing but never answers. The proof observes four Local legs, one queued
caller and the member attempt, then `TIMEOUT` with **3,000 ms queue wait /
zero answered time**, zero completed calls and one abandonment. Member
removal restores the empty queue and zero channels before clean container
exit/removal. The [evidence](./local/asterisk-build/synthetic-unanswered-call-validation.json)
binds the successful raw report and preserves the failed initial attempt
separately. **50 offline Python tests and 30 source/evidence tests pass.**
No SIP/media, human behavior, rebuild, existing-container change or Gate C
is implied. See the [handoff](./PROJECT-PLAN.md#custom-image-synthetic-unanswered-member-timeout-and-cleanup-passed).

### Custom-image SIP registration/RTP proof proposed only

Read-only inspection identified reusable Python SIP/RTP and TypeScript
registration probes. The [bounded proposal](./PROJECT-PLAN.md#proposed-custom-image-sip-registration-and-rtp-echo-proof-not-authorized)
selects one custom-image PBX, one pinned Python client carrier and a fresh
internal Docker network with no published ports. It defines authentication,
contact lifecycle, INVITE/BYE, PCMU echo and complete owned-resource cleanup
checks. No existing customer wrapper will run: it recreates named PBXs and
leaves them running. No network/container startup, generated credentials,
dependency changes or SIP/media execution occurred. Separate approval is
required; this is not Gate C or multi-customer isolation proof.

## 6. Proposed implementation backlog

| Order | Work package | Depends on | Exit |
|---|---|---|---|
| 1 | Runtime/tool evaluation | None | Asterisk image provenance/modules, browser SIP library, scoped capture approach, identity foundation, and resource budget selected with reasons. |
| 2 | Local container foundation | 1 | Two isolated Asterisk instances, persistence, certificates, documented software test endpoints, and network/audio smoke tests. |
| 3 | Durable evidence foundation | 2 | CEL/queue ingestion, correlation fixtures, recording storage, health/gap reporting, and basic incident-linked capture. |
| 4 | Management/security foundation | 1 | Customer-scoped authentication, permission checks, schema/migrations, secret handling, and audit events. |
| 5 | Limited configuration publication | 2, 4 | Validated route/queue drafts, revision checks, apply/verify, and drift detection. |
| 6 | Browser agent console | 2, 4, 5 | Calling controls, queue sessions, roaming assignment, and explicit readiness/errors. |
| 7 | History and engineering workspace | 3, 4 | Correlated history, authorised recording access, SIP ladder, incident annotations, and redacted export. |
| 8 | Acceptance and recovery | 3, 5, 6, 7 | Executed acceptance matrix, restore proof, documented limitations, and next-milestone decision. |

Avoid introducing a separate broker/cache/analytics engine until a demonstrated
requirement justifies it. Do not put Docker's socket in the management application.
This table is the original dependency map, not an untouched implementation queue.
Use the [post-QA checkpoint](#milestone-checkpoint-after-the-autonomous-ten-test-batch)
for current gate status and recommended priorities.

## 7. Risks and decisions before implementation

- Select browser signalling/media and capture placement together. Encrypted
  signalling means a packet-only ladder will not always contain readable SIP.
- Validate browser trusted-context/certificate behaviour, codec negotiation, and
  two-way audio under Docker Desktop/WSL before building the full console.
- Choose persistent CEL/queue collection and replay semantics explicitly.
- Decide whether tenant data protection uses separate databases, row-level
  enforcement, or another tested boundary; a tenant-ID column alone is insufficient.
- Keep capture privileges separate from web permissions and ordinary runtime secrets.
- Confirm available RAM under real workload; this machine is not a production
  capacity benchmark and no ten-conversation local AI promise is made.
- Select IONOS only after a Linux VM/network proof; local success does not validate
  carrier access, public media paths, or production fault visibility.

## 8. Completion and next milestone

Milestone completion requires persisted implementation, executed acceptance
evidence, reproducible setup/restore instructions, and explicit limitations.
Unexecuted tests remain unverified, not implicitly passed.

Next milestone: voice AI through a simulated dispatch connector, tested queue/IVR
fallback, evidence-cited diagnostic AI, and initial permission-controlled MCP tools.
Autocab can then be implemented against supplied API documentation and test access.

The selected immediate increment after the bounded agent workspace is the
[deterministic backend booking simulation](./PROJECT-PLAN.md#selected-next-increment-deterministic-booking-simulation),
not live voice integration. BS-01 through BS-10 define its finite exit: synthetic
details, revision-bound confirmation, durable outcomes, duplicate prevention and
explicit uncertain-outcome reconciliation.
[Executed backend evidence](./PROJECT-PLAN.md#executed-booking-simulation-evidence)
now closes this bounded in-process checklist; it does not include voice or UI.
The selected follow-on is the
[authenticated simulation workspace](./PROJECT-PLAN.md#selected-next-increment-authenticated-simulation-workspace).
Its SW-01 through SW-12 checklist is now closed for the synthetic browser contract:
separate simulation permission, verified session/CSRF, persistent per-agent
ownership, explicit confirmation/recovery and synthetic-only browser controls.
Existing `agent:access` alone will not authorise it; phone capabilities stay disabled.
The [backend foundation evidence](./PROJECT-PLAN.md#executed-workspace-foundation-evidence)
now records explicit grants, persistent per-agent ownership, session/CSRF-protected
HTTP operations and revision/recovery/audit checks (60 focused tests and typecheck).
The [executed workspace evidence](./PROJECT-PLAN.md#executed-simulation-workspace-evidence)
adds browser controls, eligible navigation, fixed login return and explicit launcher
opt-in. Typecheck, 75 focused tests and the complete real Keycloak
identity/application-session/launcher proof passed, including restart reconciliation
with one simulated effect. Calling and real dispatch stay disabled, and simulation
is still off by default.
This parallel business-workflow increment does not waive unfinished M1 calling,
isolation, publication or production-readiness gates.

Current checkpoint after QA completion: see the
[gate review and proposed HR batch](#milestone-checkpoint-after-the-autonomous-ten-test-batch).
Historical "selected next" paragraphs above describe completed finite increments;
they are not instructions to repeat simulation or activate phones. The recommended
next work is an explicitly authorized read-only history workspace, not more
synthetic event cases or automatic voice/dispatch activation.
