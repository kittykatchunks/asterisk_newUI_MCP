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
| M1-06 | HF/QF durable raw evidence; MM manifests/markers; immutable JP v1-v5; QS/QC/QA exact timeout, member-/caller-ended connection/completion and ABANDON observations. Latest real proof retains 82 CEL/11 queue records per customer with replay and prior revisions preserved. | **Open:** all four required outcomes, including transferred calls, with coherent journey/leg/visit accounting and retained expected evidence after restart. Current synthetic queue observations do not prove human service, whole-journey outcomes or a transfer graph. |
| M1-07 | Independent CEL/queue fenced local-file collectors, stale/failure state, atomic replay/checkpoints, permanent replacement gaps and projection coverage warnings. | **Open:** integrated interruption/recovery against full wording with visible gaps in the intended workflow. Current one-shot/bounded copied-file collection is not continuous remote PBX delivery, automated rotation or production collector lifecycle. |
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
| 1 | Read-only authenticated history-evidence workspace | Integrate existing durable facts with visible uncertainty before adding more event interpretations. First agree audience, explicit history read grant/support policy and whether raw records are exposed. Reuse session/audit/customer-boundary patterns, not CLI authority. | Finite HR contract below, then approve implementation. No collection/rebuild/manifest/config/phone mutations; not M1-06/07/12/16 completion. |
| 2 | Integrated restart/interruption/replay proof | Requires fixed scenario/evidence contracts, not completion of the UI; can proceed independently once scoped. Combine existing durable stores/collectors with owned failure injection rather than another isolated event-name case. | Prior observations survive process/PBX restart, late data/replay/unknown gaps remain explicit. Map exact remaining M1-06/07 gaps; remote delivery remains separately designed. |
| 3 | Limited route/queue publication foundation | Critical dependency for intended agent call path (M1-09, then M1-02/04/05/18). Needs agreed managed-file ownership, draft/revision/drift and rollback semantics. | Invalid/stale/drifted publication fails; owned apply/verify proof, no broad admin editor or Docker socket in the web process. |
| 4 | Gated browser-agent vertical slice | Requires explicit activation approval, queue/session authority, publication and device lifecycle readiness. | Intended queue-agent media/control/roaming/error acceptance; no live calling enabled by this checkpoint. |
| 5 | Recording, engineering/export and combined restore | Requires explicit storage/retention/access/capture-limit contracts and links to durable identities. Can be separately planned where independent. | Close exact M1-08/11-17 requirements through executed scoped workflows, not report/hash proxies. |

No repeated-visit matching, transfer reconstruction, production collector service,
Autocab integration or voice AI is authorized as a side effect. Further history
reconstruction should follow evidence of a required unsupported scenario, not an
automatic sequence of algorithm versions.

#### Proposed HR batch: read-only history evidence, ten acceptance checks

**Proposed only.** Audience/access policy, raw evidence exposure and service
integration/storage wiring must be agreed before implementation; this review
does not choose a new permission or grant anyone access.

| Check | Proposed finite acceptance |
|---|---|
| HR-01 | Explicit opt-in and configured existing read-only stores; no store creation, migration, import, rebuild or background collector on page load. |
| HR-02 | Authenticated customer-bound access with an explicitly agreed read permission/support policy; agent or simulation access alone never grants history. Guessed foreign runtime/epoch/revision IDs disclose nothing. |
| HR-03 | Reuse persistent audit and request-reference conventions for allowed/denied/error reads; audit/storage failures surface, not empty success. Test logout/session expiry and no stale protected data after loss of access. |
| HR-04 | Select only authorized customer/runtime/epoch/revision scope; bounded metadata pages with explicit cursors. Never list other customers or accept arbitrary filesystem paths from the browser. |
| HR-05 | Read immutable v1-v5 documents as stored, including absent newer fields; display algorithm/revision and supported legacy limitations without reinterpretation. |
| HR-06 | Separate explicit current-input checking from stored/offline inspection. Show inputs-match/inputs-changed/not-checked and independent coverage/health; failure is never green freshness. |
| HR-07 | Display caller answer/end, queue timeout/CONNECT/member correlation/completion/ABANDON as separate observations. No human-service badge, business total or whole-journey outcome. |
| HR-08 | Show unresolved/conflicting/unassigned evidence and permanent unknown gaps prominently. Do not hide incomplete data behind an empty timeline or join by timestamps/linkedid. |
| HR-09 | Evidence references retain kind/source/generation/offset/hash; raw record viewing only if explicitly approved with bounded access/audit and scope validation. Escape hostile strings; no recording/export/capture actions. |
| HR-10 | Focused API/browser tests for scope/session/audit/storage/freshness/legacy/error cases plus both-customer persisted synthetic proof. No microphone/WebSocket phone activation, PBX changes or REFER reruns; clean up only owned test resources. |

Stop this checkpoint at the updated plan. Selecting/implementing HR, or another
priority, is the next scope decision. No runtime code or acceptance status changes
are made by this documentation-only review.

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
