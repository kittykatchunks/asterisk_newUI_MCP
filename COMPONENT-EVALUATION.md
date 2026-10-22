# Foundation component evaluation

Date: 22 October 2026.

Status: upstream-documentation review and proposed shortlist, with a subsequent
limited Asterisk runtime proof recorded below. These are not production approvals,
security assessments, or complete compatibility results.

Related: [Project plan](./PROJECT-PLAN.md) and [Milestone 1](./MILESTONE-1.md).

## 1. Recommended shortlist

| Concern | First candidate to prove | Alternative / contingency |
|---|---|---|
| Asterisk runtime | Pinned Debian-based 22.x image from andrius/asterisk, after recipe/module verification. | Project-owned build from an official Asterisk release if provenance, modules, or runtime behaviour are unsuitable. |
| Browser SIP | SIP.js full API behind a small application adapter. | JsSIP if browser/control tests expose a material limitation. |
| Identity | Keycloak with application OIDC and backend permission checks. | Re-evaluate if measured resource cost or tenant federation behaviour is unsuitable. |
| Network evidence | Bounded packet capture through a narrowly privileged local collector. | Change collector implementation without changing incident/evidence interfaces. |
| Engineer terminal tool | sngrep for operator validation and PCAP inspection. | Not the browser application or a public terminal service. |
| Browser trace backend | Evaluate HOMER against a thin incident-linked viewer. | Build only the required ladder/search/export surface if integration is unsuitable. |

No exact image digest or package version is approved yet. Select those from
verified registry/package artifacts at implementation time and record them.

### Subsequent local runtime results

The local proof uses Asterisk 22.11.0, Debian, index digest
`sha256:d6333b8b331563c5887b98b12da9371ef48317e657d17d81770fe085f335041d`.
Registry inspection included a Linux amd64 manifest. The upstream recipe was
inspected at repository HEAD
`c6e8a0e48cdde322b0c1ba5ad4a6f50185dd6b20`; the official Asterisk repository also
contained tag `22.11.0`. This does not verify binary provenance against that recipe.

The candidate passes the limited automated proof described in the
[README](./README.md). Explicit module dependencies and the CEL output directory
had to be configured in our fixture. Startup now creates the directory and tests
required modules/CEL subscription rather than checking process liveness alone.
The image's root entrypoint is bypassed in favour of a non-root local launcher.

Subsequently, the optional SIP/RTP runner verified digest challenge/rejection,
authenticated UDP/PCMU calls, 100/100 distinct echo payloads per customer, fresh
CEL lifecycles, and valid audio recordings. Wrong and other-customer credentials
were rejected. This is not browser signalling, registration, or adversarial
isolation validation. See the README for reproduction and boundaries.

SIP.js 0.21.2 subsequently passed a local headless Chromium proof of WSS
registration and two-way synthetic DTLS-SRTP audio for both customer instances.
The runner uses exact test-key certificate exemptions, loopback media mappings,
explicit passive DTLS, and disabled mDNS candidate hiding in the test browser.
These are local-fixture constraints, not default-browser or production validation.
The README records reproduction, thresholds, and outstanding tests.

A subsequent tcpdump/tshark proof captures synthetic UDP SIP on each customer's
network namespace with bounded duration. It exports a whitelist-based HTML
signalling table, explicit Call-ID/CEL correlations, packet-loss counters, and
integrity manifests. Five report failure/redaction unit tests and browser report
filter/print/offline checks are implemented. This validates
a narrow evidence path, not an interactive engineering application, encrypted SIP
capture, hard byte quotas, or general customer-data export. No HOMER runtime
evaluation or AI analysis has been performed.

Keycloak 26.8.1 subsequently passed the narrow browser PKCE proof described in
the README: two customer identities, API audience enforcement, state/nonce checks,
cross-customer denial, consumed-code replay rejection, and disabled password grants.
The digest is pinned in the identity-only Compose fixture. Development-mode
loopback HTTP and ephemeral identity state do not validate production deployment,
MFA, or federation. No AI or provider component has passed runtime testing.

The application-side access boundary now has a JOSE/JWKS integration test using
an ephemeral synthetic issuer. This tests token validation and provisioned
customer/support permissions, not Keycloak deployment or federation. RS256 is
the initial allowed algorithm and 15 minutes the maximum accepted token age;
the selected identity-provider configuration must be aligned and tested.
The exact digest is selected for this local experiment only, not approved for
production. Official release support and advisory review remain production gates.

The incident access proof now separates metadata and HTML report permissions,
denies raw evidence routes, and serves approved reports in a browser sandbox.
The real Keycloak fixture checks captured report viewing/filtering and tenant
denial. A subsequent local SQLite adapter uses Node 24's experimental built-in
`node:sqlite` support, with atomic insert-only incident imports, read-time integrity
checks, and audit commits awaited before delivery. Close/reopen, corruption,
lock-contention and API failure tests are included. This is not a production
database decision, immutable audit archive, or retention policy. Subsequent SQLite
online-backup/separate-restore tests validate report hashes, customer provenance,
database integrity, manifest counts, and exact audit preservation. Recovery after
removing the source and rejection of incomplete/tampered backup files are tested.
This excludes off-host/full-platform disaster recovery and power-loss testing;
see the README for reproduction and limitations.

Persistent ingestion now separates staged candidates from published reports.
Hash-bound approve/reject receipts record reviewer and reason; approval and
publication commit atomically. Schema-1 reports move to pending review on
migration, preserving audit history without inventing approval. Backup/restore
also validates and preserves candidates and review decisions. Tests cover hidden
pending/rejected reports and rollback/tampering. The operator methods are trusted
in-process calls. Subsequent customer-scoped HTTP review endpoints require the
separate `diagnostics:review` permission, derive reviewer identity from verified
tokens, and atomically persist decision access audit with publication. The real
Keycloak test exercises approval and permission denial. This still excludes a
production review UI, live reviewer-grant management, and production sessions.

A browser workspace proof now consumes those endpoints with pending selection,
inert unapproved HTML source preview, reason/scope checks, and explicit decision
confirmation. Playwright verifies no script execution/resource loading from
candidate markup and checks denial/conflict/network/storage failure states.
The real Keycloak fixture uses the workspace for synthetic evidence approval.
The original fixture test-connects tokens in memory; a subsequent confidential-client
server-session proof provides normal browser sign-in and local sign-out with
HttpOnly cookies and CSRF-protected decisions. Identity tokens stay server-side.
A subsequent restricted rendered preview reconstructs allowlisted text/table
elements inside a sandboxed opaque-origin frame. Browser tests cover evidence
readability, active-content/resource removal, parent/storage isolation and
size/structure limits. Original source and hash-bound approval are preserved.
Full-fidelity interactive review and production UX/session operations remain open.

The restricted preview also supports application-owned literal text search:
bounded highlights only, no hidden evidence, report scripts or added sandbox
permissions. Source and publication hashes are unaffected. Browser tests verify
Unicode/literal matching and highlight limits; the identity fixture searches the
captured SIP report before approval.

Pending report cards replace ID-only selection with allowlisted snapshot metadata
(title, incident ID and creation time alongside candidate ID/hash). The existing
review permission/audit gate remains unchanged. Integrity checks precede metadata
delivery, unknown fields are omitted, and browser selection rejects list/detail
metadata mismatches. Pagination and reviewer assignment are not implemented.

Application-local pending filters now narrow loaded titles and incident/candidate
IDs with explicit visible/loaded counts. Filtering neither fetches evidence nor
changes the selected review. It preserves the filter within a connection only;
server-side search and pagination remain unimplemented.

Pending-card ordering adds oldest/newest incident creation time while preserving
candidate-ID ordering by default. Offset-aware instant comparison and ID
tie-breaking are browser-tested. Ordering is connection-local, composes with
filtering, and does not alter evidence, selected review or API request counts.

Explicit close-without-decision clears selected evidence from the workspace and
requires confirmation before discarding local reason/scope state. It preserves
the queue/filter/order and makes no API call. Browser coverage verifies discard
and cancel/Escape behavior. Explicit refresh and candidate switch/reopen actions
now share this guard, with tests verifying no request before confirmation and no
decision POST on discard. A native unload warning is now attached only while a
review has reason/scope state, with real reload cancellation/acceptance tests.
It is removed on clear/completion/disposal; expiry/logout cleanup is not delayed.
Browser warnings are best-effort and do not replace saved drafts or recovery.

The session header provides a two-minute advance expiry warning. A controlled-clock
browser test through real sign-in verifies threshold timing and dirty-review
cleanup without automatic decisions. It neither refreshes sessions nor persists
drafts; background timer delivery is not guaranteed.

Absolute-deadline checks on visibility/page-show events now catch up warning and
expiry after suspended timers. Tests advance wall time without running timers
and verify evidence/unload cleanup on both event types. Lifecycle cleanup removes
listeners/timers after expiry/logout; no server polling or session extension is
introduced.

An already-expired bootstrap deadline is checked before review connection, avoiding
unnecessary metadata/evidence requests. Boundary tests cover equality and one
millisecond past expiry while retaining the sign-in path.

Deadline timers/listeners are installed before initial review loading completes.
Session-owned cancellation disposes pending workspace requests, tested with a
held initial list response and an already-aborted connection. Late responses
cannot restore the disposed workspace; cancellation cannot undo committed reviews.

Application-session review 401s now trigger explicit local session cleanup and a
sign-in path across list/candidate/decision requests, including non-JSON bodies.
Browser tests verify cleanup/no automatic retry and retain 403 as permission
denial rather than session termination. This is not revocation polling.

Logout errors explicitly report an unconfirmed outcome with a manual retry path.
Real-login browser coverage injects durable-audit and transport failures, checks
the session/draft remain available without false success or automatic retry, then
verifies successful retry and replay denial.

Bootstrap errors now expose an explicit retry-by-reload control. Browser tests
verify manual recovery from server/malformed/network responses, no review fetches
during failure and reuse of an existing valid session without a new login.

Keyboard focus transitions now target list filter, candidate heading and errors
after requests finish. Dialog autofocus defaults to Cancel, with browser tests
for Tab progression and Enter cancellation without POST. This is focused UX
coverage, not a complete accessibility certification.

Session bootstrap/logout failures expose validated UUID request references from
response headers. Real-login tests correlate logout audit failure with the server
error logger and verify explicit unavailable references for transport or invalid
headers, without introducing successful-looking audit receipts.

Review-response errors share validated header references with session errors.
Malformed JSON preserves status/correlation without rendering upstream bodies;
error codes are bounded identifiers. A committed-approval/corrupted-response test
verifies explicit ambiguity handling and no automatic decision retry.

Transport failures now use the same conservative decision-outcome guidance, with
explicit unavailable references before headers and retained status/reference for
body interruption. Browser tests exercise disconnects before and after server
commit, verifying no retry and preserved durable outcomes.

A real-time timeout regression holds a committed approval's acknowledgement past
the 15-second deadline, verifies the conservative timeout UI and releases the late
success. Refresh then reconciles pending state without a second decision POST.

Confirmed decision acknowledgement is now independent of list-refresh status.
Approve/reject tests verify a following 503 does not erase the known outcome and
manual refresh never replays the decision. The connection-local status is not a
replacement for authoritative stored review records.

Decision acknowledgement validation now occurs while HTTP status/request reference
are available. Unrecognised successful JSON warns of possible commit rather than
claiming success or rollback; browser tests verify pending/committed variants and
no replacement of the last confirmed outcome.

Workspace request state now includes `aria-busy` and disabled form/search controls,
preventing input drift during decision submission. Browser tests check pending
inputs, timeout recovery and expiry cleanup; session-header sign-out is independent
of the workspace lock.

Review reason feedback now exposes the current character count. Local checks
enforce the existing 2,000-character and 8,192-byte encoded-body limits before
confirmation, with explicit errors and no silent truncation. Browser tests cover
character boundaries and control-character JSON expansion.

Browser/API boundary coverage now verifies 8,192-byte acceptance versus 8,193-byte
rejection for both decision shapes, plus a real exact-limit approval with unchanged
transmitted/persisted reason and hash.

Confirmed decision statuses also retain the validated response-header request ID.
Browser tests match approval/rejection references to durable access audits, retain
them through failed/successful list refreshes, and reject missing/invalid header
references without trusting body-supplied IDs.

Successful but invalid list/candidate payloads retain their validated header
reference in explicit validation errors, without echoing upstream content. Browser
tests cover malformed list shapes and snapshot/scope/metadata mismatches, including
missing/invalid references and no remaining evidence or decision controls.

Unicode review reason tests cover supplementary-plane code-unit boundaries and
multibyte UTF-8 exact request boundaries for both decisions. A real rejection
checks exact API/SQLite preservation of accented, CJK, emoji and decomposed
combining-mark text at 2,000 code units; no normalization or truncation is applied.

Durable review history now exposes at most 50 recent decisions and exact
candidate-ID reconciliation through audited read-only customer-scoped routes.
It reuses `diagnostics:review`, returns allowlisted metadata/receipt fields without
report HTML, and checks stored snapshot/receipt integrity. No schema change or
new mutation is introduced. The browser uses literal text, draft-discard guards,
explicit reads and uncertainty warnings for missing outcomes; it never retries a
decision. Tests cover persistence, limits/order, older lookup, access/audit/storage
failure, hostile text and recovery after timeout/reload, including real server
sessions. Pagination, correction/revocation and external audit guarantees remain
outside this increment.

History recovery is additionally tested with the original database removed:
54 candidates/53 decisions across two customers retain exact recent results,
older candidate lookups, receipt fields and publication/pending state through
backup, fresh-path restore and reopening. This validates local SQLite recovery,
not offsite storage durability or production disaster recovery.

Backup/restore inspection now rejects malformed candidate UUIDs and receipt
lengths beyond the history-reader limits. Tests exercise both directions with
valid-checksum corrupted artifacts, approved/rejected receipts, exact-limit
Unicode preservation and cleanup without disturbing existing restores.

Held history response coverage verifies busy-state/control locking, clearing old
results, completion focus and reconnect cancellation. Late data or abort errors
from the disposed connection cannot overwrite the replacement workspace, and
history requests never replay a decision.

The customer operational-status slice now uses AMI `CoreStatus` with
reporting-only accounts, not Docker-daemon privileges. An audited read-only
diagnostics-permission route and explicit workspace check return only observation
time, PBX-local startup time and active-call count. The adapter is time/size bounded,
tenant-mapped server-side, disables events and exposes no arbitrary actions.
Two isolated real Asterisk 22 instances pass core reads while unauthenticated,
Command and Originate probes are denied. Unit/API/browser regressions cover
protocol errors, limits, isolation, audit gating and safe rendering. Remote TLS,
SIP/RTP health, trunk monitoring and production capacity are not claimed.

The separate synthetic AMI TLS transport proof exercises normal certificate
verification using fresh temporary identities and child-process-only extra trust.
Trusted matching TLS supports core and endpoint reads. Untrusted, IP-SAN-mismatched
and expired peers are rejected with the expected underlying TLS verification
causes, no application bytes/credentials sent, sanitised adapter errors and
released in-flight guards on repeat attempts. Test keys/trust files are deleted.
This adds no production trust configuration or verification bypass and does not
establish real Asterisk TLS listener, DNS/SNI or remote-network acceptance.

The real-runtime fixture now separately enables Asterisk AMI TLS for both
customers using distinct one-day self-signed IP-SAN identities from a shared proof
generator. Loopback ports 15048/15049 and read-only key mounts are fixture-owned.
Dedicated child-process trust supports core and endpoint reads; reporting-only
enumeration and foreign secrets stay denied. Without fixture trust, exact
self-signed certificate rejection and sanitised repeat-safe adapter errors occur
without plain fallback. Default launcher/browser mappings remain plain loopback.
Ignored fixture keys/trust regenerate each run and remain credential material.
Remote networks, DNS/SNI, production PKI and rotation still require acceptance.

An opt-in combined `WithIdentity -WithTls` run now verifies the authenticated
browser -> audited API -> real AMI TLS path for both customers, including core and
endpoint snapshots, foreign denial and logout replay denial. Both API source
mappings are asserted TLS-only; real outage/recovery also uses TLS. The exclusive
fixture owner temporarily rewrites mappings and supplies child-process trust,
restoring original file text and environment in `finally`. Defaults stay unchanged
and interactive TLS is not added. Browser/application and identity connections
remain loopback HTTP, so only the backend-to-PBX hop is encrypted in this proof.

Combined real-runtime/identity validation now exercises the complete browser
session -> audited customer status API -> restricted AMI path for both customers,
including the metadata-only user. It verifies durable request/subject/customer
correlation, foreign-customer denial and logout replay denial while retaining the
existing identity/session/launcher proofs and scoped fixture cleanup.

Real AMI outage/recovery checks additionally stop the owned customer-A fixture,
verify bounded core and endpoint failures alongside successful concurrent
customer-B core/endpoint checks, and recover through the same separate source
instances after restart. Two four-query rounds each have a five-second bound;
stale or empty-success endpoint fallbacks are rejected and exact scoped inventory
plus contact-address redaction are checked throughout available snapshots.
Both plain-loopback and verified-TLS fixture runs cover this. This tests tenant-local failure
and in-flight cleanup without introducing Docker privileges into the application
or claiming production failover.

Injected browser outage tests complement the real AMI proof: an old reachable
snapshot clears while a recheck is held, controls lock, 503 feedback retains the
request reference and manual recovery displays only the new snapshot. No decision
POST or automatic recheck is sent.

Endpoint/contact visibility now adds a bounded `PJSIPShowEndpoints` list consumer
over the shared AMI transport. The API/UI disclose only endpoint IDs, device state,
contact presence and active-channel count under audited diagnostics-read access.
Real/runtime/browser tests verify no-contact versus static-contact results and
customer boundaries; protocol tests verify completion counts, limits and Unicode
framing. Dynamic registration status is not inferred from static contacts.

Upstream requires AMI system authority for this action. An explicitly approved,
separate system+reporting account is therefore used while core status remains
reporting-only. Fixed application actions do not remove the credential's broader
system privilege if used elsewhere. Production credential/network controls and
production-network qualification acceptance remain outstanding.

Real dynamic registration transitions are now tested separately: each isolated
PBX challenges REGISTER, rejects the foreign customer's secret, exposes the new
authenticated contact through the AMI adapter and removes it after authenticated
unregister. Static contacts and foreign dynamic endpoints retain their original
states. The probe uses bounded synthetic SIP over loopback UDP without calls/RTP;
it does not change the UI's intentionally limited contact-presence semantics.

The same fixture also proves natural expiry of a separately registered five-second
dynamic contact without refresh or unregister. It validates the remaining Contact
lifetime in the successful response, requires initial visibility, rejects early
disappearance with a whole-second rounding allowance and bounds cleanup observation
to forty seconds. Foreign dynamic endpoints and both static contacts are checked
throughout. This fixture-only shortened lifetime does not establish production
expiry latency, qualification/reachability or general registration classification.

Synthetic qualification is now separately exercised using a third registration
and a container-local loopback SIP client. Real OPTIONS responses, deliberate
silence and renewed responses produce AMI device states `Not in use`,
`Unavailable` and `Not in use`, with contact presence retained and no REGISTER
refresh between transitions. Each phase has a fifteen-second bound and verifies
OPTIONS traffic plus foreign/static contact isolation. A fixed-destination Python
UDP bridge runs only in the owned fixture via test-owner Docker exec, avoiding
host-loopback UDP forwarding limitations without additional ports or application
Docker authority. These signalling tests do not prove RTP/audio, WebRTC, trunk
health or production-network behaviour; the UI semantics stay unchanged.

A foreground PowerShell/Node launcher now makes the loopback workspace usable
outside test-controlled browsers. It reuses the pinned identity fixture and
captured-report loader, keeps local diagnostic data, and stages captures only
when explicitly requested. Regression checks cover real review, restart,
port/fixture ownership and shutdown. This remains a synthetic local fixture with
regenerated development identity, not production deployment or identity storage.

### Agent-console identity boundary

The first authenticated agent-console increment adds a copied, operator-provisioned
issuer/subject/customer assignment directory and an independently permissioned,
audited own-profile API. Only direct membership with `agent:access` is accepted;
diagnostics roles and temporary support grants cannot confer phone identity.
Output is limited to extension/display name, with no SIP/AMI credential or device
lease. API failures deny disclosure rather than inventing an assignment.
Focused tests and real confidential browser sessions verify scope, audit gating,
metadata-only access denial and logout replay. The local launcher has no agent
provisioning yet. Persistent assignments, conflict handling, session-bound SIP
credential provisioning and actual phone controls remain later work.

The directory now has a separate SQLite implementation with validated reads and
atomic operator-only insertions. A JSON provisioning CLI reports inserted/unchanged
counts, permits identical reruns and rejects changed assignments rather than
implicitly moving a person. Tests cover exact reopen persistence, scope, returned
object isolation, batch rollback, conflicts, contention, corruption, schema/path
refusal and CLI outcomes. The real session proof injects a reopened store.
This does not publish PBX config, grant membership, create credentials or enforce
extension/device exclusivity. The separate store is not included in diagnostic
backups; history API/UI and reassignment remain
unimplemented. The ordinary launcher stays unconfigured for agents.

Schema version 2 adds successful provisioning receipts in the same transaction
as assignment inserts. Generated UUID/time, bounded operator/reason, exact
allowlisted batch JSON and its SHA-256 plus counts survive reopening. Receipt-write
failure rolls back inserts; conflicts/invalid batches cannot leave success records.
Version-1 migration preserves existing assignments without invented receipts.
The CLI now requires operator/reason and returns receipt metadata; these are trusted
operator assertions, not verified identities or tamper-proof signatures. There is
no failed-attempt log, history endpoint or additional browser disclosure.

An exact receipt reader and read-only operator CLI now validate timestamp/context,
safe counts, unique assignment identities, canonical allowlisted JSON and SHA-256.
Known UUID lookup survives reopen and returns detached historical snapshots;
invalid/corrupt data fails even if an invalid batch's hash was recalculated.
The CLI neither creates missing databases nor migrates older schemas and is tested
not to change database bytes. This reconciles known references, not unknown UUIDs
lost with an entire response; absence does not establish provisioning failure.
It is an operator-wide metadata tool, not a customer web route or tamper-proof
provenance, and it does not affect profile authority or introduce retries.

Separate agent-store recovery now uses SQLite online backup, a checksum/count
manifest and a newly allocated restore path. Full assignment/receipt read validators
and SQLite integrity checks gate both artifacts and restores; legacy schema
migration is not performed by backup. Tests restore exact scoped profiles and
receipt snapshots after deleting the source, exclude later writes, and exercise
operator CLI, empty stores, tampering with recomputed hashes, unsupported content
and output cleanup. The artifact includes all customers' identity/provisioning
metadata, is not encrypted/signed and is not part of the diagnostic backup.
No automatic live cutover, membership recovery, PBX credential recovery or
full-platform/offsite acceptance is claimed.

The first agent screen is now an authenticated assignment view with scoped session
bootstrap, explicit refresh and CSRF logout. A fixed pending-flow workspace selector
allows the agent destination without arbitrary redirects. Literal rendering and
session lifecycle tests verify stale clearing, request-correlated errors, expiry,
401 and logout uncertainty; real Alice/Bob sessions verify assignment/denial.
The page states phone connection is disabled and does not expose SIP credentials,
request media access or conflate assignment with registration/queue/call state.

## 2. Asterisk container

### Candidates reviewed

**andrius/asterisk**

The upstream README lists Debian and Alpine variants and Asterisk 22.x builds.
It currently lists 22.11.0 among supported versions, while some quick-start examples
refer to an older patch. This is a maintainer statement, not registry verification
or independent confirmation of release suitability.

Fit: an existing vanilla-Asterisk packaging candidate with published build sources.
Prefer evaluating the Debian variant first to reduce initial packaging variation
and simplify familiar operator diagnostics. This is an operational preference,
not a claim that Alpine is unsuitable.

**mlan/docker-asterisk**

Upstream describes mini/base/full/xtra variants. Its mini variant is described as
Asterisk-only; broader variants add services such as AutoBan and WebSMS.

Fit: retain the mini variant as an alternative to inspect if needed. Do not adopt
the bundled stack merely for its firewall features: firewall ownership and
configuration generation must remain explicit in this project. Upstream image
version tags must not be assumed to identify the embedded Asterisk release.

**Project-owned build**

Gives explicit control of release, module selection, user, entrypoint, and filesystem.
Costs include build maintenance, dependency patching, and artifact publication.
Use it if an existing image cannot satisfy the proof, rather than maintain a fork
without a demonstrated need.

### Acceptance gate

Before choosing an image:

1. Verify the official Asterisk release/support status and download provenance.
2. Inspect the exact upstream recipe, base image, entrypoint, user, volumes, and
   configuration-generation behaviour; record source revision and image digest.
3. Verify PJSIP, HTTPS/WebSocket transport, SRTP support, RTP/ICE support, queues,
   MixMonitor, required CEL backend, AMI/ARI, and future external-media modules.
4. Verify codec negotiation and actual browser audio. Do not equate listing a
   codec with supporting every necessary transcoding path.
5. Check permissions on configuration, logs, recordings, certificates, and secrets.
6. Confirm clean termination, restart recovery, health checks, and persistent data.
7. Record dependency/license obligations and a repeatable update procedure.

Do not use floating `latest`/`stable` tags as the reproducibility mechanism.
Source availability and an upstream "production-ready" label are not proof of
hardening or module compatibility.

Sources:
[andrius/asterisk](https://github.com/andrius/asterisk),
[mlan/docker-asterisk](https://github.com/mlan/docker-asterisk).

## 3. Browser calling

SIP.js upstream documents TypeScript, SIP over WebSocket, WebRTC, hold, transfers,
and DTMF. JsSIP upstream also documents WebRTC, SIP over WebSocket, and Asterisk
interoperability. Either remains subject to exact-version testing.

Recommend SIP.js first because it aligns with the proposed TypeScript application.
Use its full API for the agent console rather than assume the simplified helper
supports every session/control requirement.

Application boundaries:

- Wrap session events in explicit registration, call, and media states.
- Keep queue membership and agent availability in backend operations, not library
  state or browser-only variables.
- Provision only that agent/device's scoped SIP credentials; an OIDC session does
  not itself authenticate a SIP registration. Define issuance/revocation separately.
- Never deliver trunk, AMI, or ARI credentials to the browser.
- Define logout, stale assignment, reconnect, and active-call behaviour explicitly.

Proof: trusted HTTPS/WSS, registration, two-way audio, DTMF, hold/resume, blind
transfer, microphone denial, reconnect, and logout. Start with one recorded desktop
browser/version, then repeat in another supported browser; do not claim universal
browser support from an upstream compatibility statement.

Asterisk's WebRTC guide requires WebSocket-related modules and discusses TLS
certificate trust. For local testing, document certificate trust without disabling
browser security checks. DTLS-SRTP/media reachability still needs a separate test.

Sources:
[SIP.js](https://github.com/onsip/SIP.js),
[JsSIP](https://github.com/versatica/JsSIP),
[Asterisk WebRTC configuration](https://docs.asterisk.org/Configuration/WebRTC/Configuring-Asterisk-for-WebRTC-Clients/).

The JsSIP documentation website was unavailable during this review; its repository
README was inspected instead. Detailed API comparison remains incomplete.

## 4. Identity

Recommend Keycloak as the first self-hostable candidate, not a final selection.
Its JavaScript adapter documents OIDC, public-client constraints, restricted
redirect origins, in-memory token handling, and browser tracking-protection limits.

Selected with user confirmation: a backend-for-frontend/server-managed cookie
session for the application, with confidential-client code/S256 PKCE exchange
and identity tokens retained server-side. The initial implementation uses bounded,
short-lived in-memory sessions, HttpOnly cookies and CSRF checks; the earlier
public-client proof remains separate. Production session storage, refresh/revocation
and multi-instance operations remain open. Backend validation and customer
membership checks apply to both proofs; do not mix their credential assumptions.

Tenant federation topology is open: compare realm-per-customer with shared-realm
organisation/broker options against the selected version's supported behaviour.
Do not assume identity-provider organisation features enforce application data
isolation or provide every required customer SAML policy.

Initial proof:

- Platform engineer and two customer identities with explicit memberships.
- Denied cross-customer requests even when identifiers are changed.
- Correct redirect/origin configuration and expired/revoked session behaviour.
- Separate application privileges from identity-provider administration.
- Measure startup and memory use alongside the calling stack.

MFA, social providers, SAML/Entra federation, recovery, and tenant-specific policies
remain required later proofs; this review does not certify them configured.

Source:
[Keycloak JavaScript adapter](https://www.keycloak.org/securing-apps/javascript-adapter).

## 5. Engineering capture and browser presentation

### Packet and signalling collection

Separate three evidence types:

1. Network packets: what crossed a selected observable interface.
2. Application signalling: readable SIP at an authorised application boundary.
3. Operational events: CEL, queue logs, runtime status, and incident annotations.

Preserve provenance and label each source in the ladder. Application log lines
must not be presented as recovered plaintext from encrypted network traffic.

Choose a packet collector after verifying interface visibility in Docker/WSL.
Evaluate standard bounded capture tooling, such as dumpcap/tcpdump, before building
a custom capture engine. Tool version, limits, privilege requirements, and packet
loss reporting must be tested, not inferred.

### sngrep

Upstream describes a terminal SIP-flow viewer supporting live capture and PCAP
inspection. It is useful as an engineering reference for checking the same
unencrypted trace displayed by our UI.

Do not expose a privileged terminal in the web application. Its optional TLS-related
build features do not establish that modern encrypted sessions can be decrypted.

### HOMER

Upstream currently describes Homer 11 as an all-in-one HEP capture/API server with
a built-in UI and DuckDB/DuckLake-based storage. Older deployment tutorials may
describe a different architecture; verify the chosen release's actual requirements.

Evaluate reuse before implementing a larger SIP search/visualisation product.
However, existing UI or MCP support does not establish compatibility with our
tenant permissions, evidence integrity, redaction, or incident workflow.

Decision gate:

- Run a small synthetic trace through a pinned release.
- Inspect authenticated API access, tenant filtering and raw attachment exposure.
- Measure RAM/storage needs on the local machine.
- Verify ladder, export, embedding/deep-link options, and source labels.
- Confirm how HEP messages relate to retained packet evidence; HEP is not itself
  proof of a complete PCAP or observation beyond the collector boundary.
- Check licenses and integration obligations before reuse.

If unsuitable, build a thin viewer for the defined milestone rather than duplicate
HOMER's entire functionality. Keep the UI consuming an application-controlled,
customer-scoped evidence interface regardless of backend.

Sources:
[sngrep](https://github.com/irontec/sngrep),
[HOMER](https://github.com/sipcapture/homer).

## 6. Execution order for the next technical proof

1. Start Docker only as part of an explicit runtime test; confirm engine readiness
   and available memory. Do not change WSL/global allocation without agreement.
2. Inspect/pin the Asterisk image and create two separately addressed local runtimes.
3. Establish trusted browser signalling and prove two-way audio with synthetic calls.
4. Verify recording, CEL, and queue-log persistence before adding presentation.
5. Identify usable capture points and demonstrate wire/application evidence labels.
6. Evaluate HOMER integration and Keycloak resource/permission behaviour against
   the actual small stack.
7. Record measured results, rejected options, and selected versions/digests.

Stop and revise if audio or capture visibility is unreliable. A UI prototype is
not a substitute for these proofs. No public port exposure, paid cloud resources,
SIP provider registration, or external AI trace upload is needed for this stage.
