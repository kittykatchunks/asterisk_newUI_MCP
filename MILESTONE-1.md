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
Its SW-01 through SW-12 checklist is specified but unimplemented/unverified:
separate simulation permission, verified session/CSRF, persistent per-agent
ownership, explicit confirmation/recovery and synthetic-only browser controls.
Existing `agent:access` alone will not authorise it; phone capabilities stay disabled.
This parallel business-workflow increment does not waive unfinished M1 calling,
isolation, publication or production-readiness gates.
