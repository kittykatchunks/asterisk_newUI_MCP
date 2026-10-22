# asterisk_newUI_MCP

Planning a containerised, multi-customer Asterisk platform with a multilingual
management UI, roaming-agent console, AI voice handling, and MCP integration.

See the [project plan](./PROJECT-PLAN.md) for agreed requirements, proposed
architecture, open decisions, and the delivery and verification approach.

The [first milestone specification](./MILESTONE-1.md) defines the proposed local
calling, tenant-isolation, and engineering-evidence proof.

The [component evaluation](./COMPONENT-EVALUATION.md) records the foundation
shortlist, upstream sources, and technical proof gates.

Status: planning plus an initial local Asterisk runtime proof. No web application
or production deployment exists yet.

## Local runtime proof

Prerequisites: Docker Desktop with a running Linux engine, Docker Compose v2,
and PowerShell 7. The initial image download requires registry access.

```powershell
docker compose config --quiet
.\scripts\Test-LocalProof.ps1
docker compose stop
```

The test starts two digest-pinned Asterisk 22.11.0 instances and restarts them to
verify persistence. It leaves them running for inspection; stop them afterward
when not needed. It does not stop Docker Desktop or unrelated containers.

Each instance has its own internal network and named data volumes, no published
host ports, a non-root process, and read-only mounted configuration. The shared
configuration is a synthetic fixture, not customer-specific production settings.
HTTP and AMI are disabled; no SIP endpoints or trunk credentials are configured.

The test checks module readiness, generates internal Local-channel tone and empty
queue calls, checks fresh CEL lifecycles and queue timeout events, verifies a WAV
with an audio payload, and verifies database/log/recording persistence after restart.
It also checks separate Docker networks/volumes and absence of published ports.
Tests add synthetic history and recordings on each run; this is not a retention
implementation.

Useful inspection commands:

```powershell
docker compose ps
docker compose exec customer-a asterisk -rx "cel show status"
docker compose exec customer-a asterisk -rx "pjsip show transports"
docker compose logs --tail 50
```

Validated locally on 22 October 2026: both runtime instances passed the automated
proof. This does **not** prove SIP/RTP calls, browser audio, user authentication,
adversarial tenant isolation, diagnostic capture, restore from backup, or the
50-call/10-AI capacity target.

`docker compose stop` preserves data. `docker compose down` removes the project
containers/networks; do not add `--volumes` unless intentionally deleting test
data. No production credentials or real caller data should be used in this proof.

## Authenticated SIP and RTP proof

With the same prerequisites, run:

```powershell
.\scripts\Test-SipProof.ps1
docker compose stop
```

This opts into `compose.sip-proof.yaml`. It generates different random endpoint
passwords per customer in ignored `.local-proof` directories. Keep those files
private; they are local test credentials, not a production secrets implementation.
The default Compose configuration has no endpoint credentials.

The script force-recreates both proof PBXs to load the test settings, interrupting
any active synthetic calls. It starts disposable software clients inside each
customer's private network, using Python already present in the pinned image.
No host ports are published and no third-party SIP account is needed.

Each client verifies:

- An unauthenticated INVITE is challenged.
- Wrong and other-customer credentials are rejected.
- Correct credentials establish a PCMU call to the restricted echo route.
- At least 70 of 100 distinct synthetic RTP payloads return unchanged.
- The dialog ends successfully with BYE.

The runner then verifies a fresh PJSIP CEL lifecycle and a mono, 8-kHz, 16-bit WAV
containing at least one second of audio. Both customers returned 100/100 distinct
RTP frames in the local test on 22 October 2026. The baseline persistence test
also passed after the changes.

This is a bounded UDP/PCMU integration fixture, not a production SIP client or
endpoint-provisioning design. It deliberately uses digest authentication on an
internal test network; TLS/WSS, DTLS-SRTP, browser certificate trust, registration,
WAN networking, and complete tenant isolation remain unverified.

`Test-LocalProof.ps1` uses only the base configuration and recreates the PBXs
without these test endpoint mounts when run afterward. Test data volumes are
shared between these two modes and preserved.

## Browser WSS and encrypted WebRTC proof

Additional prerequisites: Node.js 24, npm, and Docker Compose 2.24.4+ (network
override support). From PowerShell 7:

```powershell
npm ci
npx playwright install chromium
.\scripts\Test-WebRtcProof.ps1
```

The runner creates two-day self-signed localhost certificates and fresh per-customer
credentials under ignored `.local-proof\webrtc`. It does not change Windows trust.
Only the dedicated test Chromium process exempts the exact generated public-key
pins from normal certificate verification. This is not publicly trusted PKI or a
recommendation to bypass certificate verification in the actual agent console.

The optional `compose.webrtc-proof.yaml` replaces the internal-only networks with
separate bridge networks so Docker can publish host-loopback ports:

| Customer | WSS on host loopback | UDP media on host loopback |
|---|---|---|
| A | 18089 | 10000-10019 |
| B | 28089 | 10100-10119 |

These bridge networks can have outbound connectivity. They are not the base
fixture's internal-only networks or a production firewall policy. No ports are
deliberately published on LAN/public addresses. Do not use this local ICE mapping
for cloud deployment.

The script inspects container addresses and creates explicit ICE host mappings to
127.0.0.1, then restarts the PBXs. Each test browser registers with SIP.js over WSS,
calls the echo route, and requires at least 70 sent and received audio packets,
non-zero received audio energy, connected DTLS, and a negotiated SRTP cipher.
It then ends the call and unregisters.

Synthetic microphone input and autoplay permission are enabled in the dedicated
headless browser. mDNS candidate hiding is disabled there because the Docker/WSL
proof otherwise stalled media negotiation. This does not change the user's normal
browser, but it leaves default-browser ICE, TURN, real microphone permissions,
autoplay interaction, and remote-network calling as separate required tests.
No actual microphone is captured. A real agent console is not implemented.

The browser HTTPS server and test browser are closed, and both proof PBXs are
stopped in cleanup, including on test failure. Docker Desktop and unrelated
containers are left running. All three proof modes use the same PBX service names;
do not run them concurrently. Each mode may recreate or restart those services.

Validated on 22 October 2026: both customers passed WSS registration, two-way
synthetic browser media, non-zero decoded energy, and DTLS-SRTP negotiation using
Playwright Chromium. This is not a human listening test, complete audio quality
assessment, tenant-isolation certification, or a capacity benchmark.

## Engineering packet-evidence proof

```powershell
.\scripts\Test-CaptureProof.ps1
```

This runs the SIP proof, builds a local diagnostics image containing tcpdump and
tshark, then activates a 15-second capture in each customer's own network namespace.
It generates new synthetic test calls, snapshots CEL, and creates an incident
directory under ignored `.local-proof\evidence`. The runner stops its PBXs and
collectors and removes the collector containers during cleanup. Do not run proof
modes concurrently.

The collectors have only `NET_RAW` capability, a read-only root filesystem, one
customer-specific writable evidence mount, and no Docker socket or host network.
They run as container root with other capabilities dropped; this is a local
operator fixture, not an authenticated production capture service.

Capture is fixed to non-promiscuous `eth0`, full-snaplen UDP port 5060 signalling.
It does not capture RTP audio, other interfaces, TCP reassembly, or decrypted
TLS/WSS. Collection stops after 15 seconds or a sampled 1-MiB soft size threshold.
The 20-ms polling and buffered writes can overshoot that threshold; hard disk
quotas and the size-trigger path have not been validated. The duration path has.
Unexpected collector failure is an error, not an empty successful report.

Each customer evidence directory contains:

- `signalling.pcap`: original raw packet evidence, including sensitive SIP digest
  authentication material. Never send this to third parties automatically.
- `capture.stderr`: collector diagnostics and loss counters.
- `manifest.json`: incident/customer, capture scope, UTC times, limits, stop reason,
  kernel-drop count, tool version, and original PCAP SHA-256.
- `cel.csv`: a restricted local snapshot of that customer's call events.
- `report.html`: a printable signalling table/ladder and explicit CEL correlations.
- `export-manifest.json`: hashes of packet evidence, CEL, and generated report.

The synthetic echo route emits `PROOF_SIP_DIALOG` containing the received Call-ID.
Report correlation uses that exact value, not temporal proximity. Report output
uses allowlisted fields and pseudonymised endpoint/dialog/channel identifiers,
excluding raw SIP, SDP, authentication headers, names, and raw call identifiers.
It includes no attachments or externally loaded resources. A fixed embedded
script enables dialog/message filters, expandable packet provenance, visible
counts, and reset/empty states. A hash-based Content Security Policy allows only
the bundled script/style and blocks network connections. Packet data never
becomes executable code. Raw evidence remains separately
restricted; hashes detect modification but do not make files immutable.

Validated locally on 22 October 2026: three captured SIP dialogs per customer,
one explicitly correlated accepted call per customer, duration-limit shutdown,
zero reported kernel drops, original hash verification, and readable HTML output.
Five unit tests cover whitelist redaction, missing correlation, incomplete
synthetic call evidence, unsupported input, and HTML escaping of incident metadata.
The capture runner also executes Playwright tests on each generated report:
dialog/message filtering, expanded details, no matches/reset, complete printing
despite active filters, no-JavaScript fallback, and no external requests.

For these browser checks, install the declared npm dependencies and Chromium
using the WebRTC prerequisites above. A report can be rechecked independently:

```powershell
node .\tests\diagnostics\report-ui.mjs "C:\absolute\path\to\report.html"
```

The report's challenge/BYE counts are observed-message counts, not diagnoses.
Retransmissions may contribute to those counts. A 401 can be normal authentication;
a BYE alone does not prove every dialog completed successfully.

Run those tests without network access:

```powershell
docker run --rm --network none --user 1000:999 --cap-drop ALL `
  --entrypoint python3 `
  --mount "type=bind,source=$((Get-Location).Path),target=/work,readonly" `
  -w /work asterisk-local-diagnostics:proof `
  -B -m unittest discover -s tests -p test_diagnostic_report.py
```

This is not the full engineering workspace: cross-incident search/raw-message
inspection, manual/automatic incident controls, audit/authorisation, encrypted
application signalling ingestion, AI diagnosis, PDF export, retention, immutable
storage, and arbitrary-customer-data redaction remain to implement.
No trace data is sent to AI. Do not use this fixture with real caller data.

The base Asterisk digest is fixed, but diagnostics packages currently come from
Debian repositories at build time. Package locking, minimal production packaging,
and dependency review remain deployment gates.

## Customer-scoped access boundary

The initial TypeScript backend foundation validates signed OIDC-style access
tokens using JOSE and a configured JWKS endpoint, then checks provisioned
issuer/subject/customer memberships. A signed `roles` or `customer` claim is not
permission to access another customer.

```powershell
npm ci
npm run typecheck
npm run test:access
```

The integration tests run an ephemeral loopback JWKS issuer and HTTP API and close
them afterward. They use generated RSA signing keys in memory, not production
credentials or real user identities. No services remain running.

The base permission resource is `GET /api/customers/{customer}/diagnostics`.
It reports whether an incident catalog is configured; capture and raw evidence
serving remain disabled. The optional incident resources are described below.

Access checks require RS256 signature, exact configured issuer/audience, subject,
issued-at and expiry claims, and a maximum 15-minute token age. Production identity
URLs require HTTPS; a deliberate test-only option permits loopback HTTP.
Configure the API's own ingress TLS before exposing it; the server factory itself
does not terminate TLS and has no production executable/listener yet.

Support grants require a customer, bounded start/expiry interval, recorded reason,
and contract reference. Active grants authorise diagnostic metadata only; playback,
exports, raw packets, and configuration changes are not implicitly permitted.
An application must separately authorise grant creation and persist/revoke grants;
this initial configuration-backed verifier is not that workflow.

Every evaluated access decision awaits an audit sink. If audit persistence fails,
access returns an explicit 503 and invokes the operational error logger. Tokens
are not written to audit records. The unit fixture uses an in-memory sink; the
real identity proof uses the SQLite adapter described below. Production audit
operations, access reviews, and retention remain unimplemented.

Automated tests cover customer separation, misleading token role claims,
invalid/missing/expired/future/wrong-signature/issuer/audience tokens, required
expiry, bounded support elevation, audit failure, unavailable JWKS, configuration
mutation, and absence of capture mutation routes.

This is an access-control foundation, **not** completed Keycloak integration,
interactive OIDC login, MFA, SAML/Entra federation, session handling, or production
authorisation. JWTs already verified with cached keys can remain usable until
expiry; immediate account/grant revocation and signing-key rotation require
additional lifecycle design and tests.

## Real Keycloak browser-login proof

With Docker, PowerShell 7, Node.js 24, npm dependencies, and Playwright Chromium
installed as above:

```powershell
.\scripts\Test-CaptureProof.ps1 # Generate synthetic reports first, if absent
.\scripts\Test-IdentityProof.ps1
```

This uses Keycloak 26.8.1 pinned by image digest, in a separate Compose project.
The runner generates two synthetic users with different customer memberships and
random credentials under ignored `.local-proof\identity`. The imported realm,
including plaintext test passwords, must stay private; it is not an export
template for real users. Access/ID tokens and signing private keys are not exported.

Keycloak binds only host loopback port 18080; an ephemeral API listener and callback
on loopback 18765 exist for the original browser test. The server-session proof
also uses loopback 18766. If ports are occupied, the proof
must fail rather than repurpose another service. It does not require a bootstrap
administrator account or expose a management console with default credentials.

The original public client permits authorization-code login with S256 PKCE and one exact
callback URL. A separate confidential client is used for the server-session proof
below, with its own exact callback and generated ignored client secret.
Password grants, service accounts, registration, and password reset
are disabled in this synthetic fixture. The API audience mapper applies to access
tokens, not ID tokens.

Verified locally:

- Missing PKCE and an unapproved redirect URI are rejected.
- Both users sign in through the real Keycloak browser form.
- Callback state is checked and a signed ID token's nonce/subject is verified.
- Authorization code is exchanged with its verifier; consumed code replay fails.
- Real access tokens allow the provisioned customer and deny the other customer.
- ID tokens fail API audience validation.
- Password-grant requests fail; API decisions are committed to local SQLite.

The runner closes browsers/HTTP listeners and removes the identity container and
its project network even after failure. Its development database is ephemeral;
the next run imports fresh users. Generated files remain ignored locally.
No Asterisk services need to run for this proof.

**Not production identity:** development mode, loopback HTTP, one test realm,
local-only audit, and configuration-backed membership are deliberate limitations.
Deployment TLS, production database/backup, administrator recovery, secure
production application sessions, MFA, federation, global logout/revocation, key rotation, customer
onboarding, and grant administration remain outstanding. Passing this proof does
not make the management application available or enable capture controls.

## Permission-controlled incident catalog and reports

The API factory optionally accepts a provisioned incident catalog:

| Resource | Required permission |
|---|---|
| `GET /api/customers/{customer}/diagnostics/incidents` | `diagnostics:read` |
| `GET /api/customers/{customer}/diagnostics/incidents/{incident}/report` | `diagnostics:report` |

Incident IDs must match `incident-` followed by 32 lowercase hexadecimal characters.
Metadata access, including diagnostic-only support grants, does not imply report
access. Every successful response waits for the access audit sink. Failure of
audit persistence prevents report delivery. Cross-customer report guesses are
denied, and unknown incidents within an authorised scope return 404.

The catalog interface supports an immutable in-memory snapshot or the local
SQLite adapter below, both provisioned with trusted, approved entries. Neither
is an arbitrary directory browser. Lists return only ID,
title, and creation time. Approved report bytes must match their supplied SHA-256
and fit a 2-MiB size limit. A checksum verifies consistency, not redaction quality
or HTML safety; trusted ingestion must approve the actual report. No HTTP route
imports files or accepts a path from the caller.

HTML reports are served without caching, with a sandboxed Content Security Policy
that does not grant same-origin privileges, blocks network access and forms, and
disallows embedding. The report's own hash-based policy further restricts its
fixed interactive script. Raw PCAP, CEL, manifests, and filesystem paths have no
API resource. Report delivery is a distinct disclosure permission, not a general
right to export all engineering evidence.

The real Keycloak proof now requires captured reports for both customers:

```powershell
.\scripts\Test-CaptureProof.ps1
.\scripts\Test-IdentityProof.ps1
```

The test chooses the latest incident with both export manifests, verifies customer
and incident provenance, and loads the report hashes through the catalog. Missing
or tampered reports fail explicitly. It does not publish the evidence directory.
Alice receives report permission for customer A; Bob has metadata-only access to
customer B. Both can list their own captured incident. Alice can view and filter
her report in Chromium, with sandboxed origin storage denied; Bob cannot view
his report, and neither can access the other customer. Twenty-two API decisions
are audited in the successful identity test.

Twenty access tests cover the original authentication boundary plus incident
metadata, report permission, report/audit failure, unavailable catalogs, tampering,
path-like raw-file requests, and response restrictions.

Outstanding: production storage/backup and ingestion approval, audit operations,
production application session operations, customer/engineer navigation,
grant administration, and authenticated capture controls. Reports are exercised
through test-controlled browser credentials, not a finished user-facing viewer.

## Persistent diagnostic storage proof

`openDiagnosticStore` in [src/diagnostic-store.ts](./src/diagnostic-store.ts)
provides a local SQLite catalog and audit sink using Node 24's built-in,
currently experimental `node:sqlite` module. No database package or service is
added. This is a local adapter evaluation, not a production database selection.

- A trusted absolute database path and an existing, private parent directory are
  required. Do not use shared directories, network filesystems, or caller paths.
  The operator must enforce filesystem ACLs and encryption; this adapter does
  not provision them or encrypt the database.
- Schema version 2 contains customer-keyed published incidents, staged candidate
  snapshots, review receipts, and allowlisted access-audit columns. Unknown
  versions, corrupt files, and nonempty unversioned databases fail explicitly.
  The version-1 migration and its disclosure change are described below.
- `stage` validates and stores a whole candidate batch atomically, without
  publishing it. `review` records approval or rejection of an exact snapshot.
  Existing customer/incident keys cannot be overwritten. These are trusted code
  operations, not HTTP uploads or an automated approval workflow.
- Report hashes and customer/incident provenance are checked again on reads.
  Malformed or tampered entries cause an explicit 503, not empty successful lists.
  Catalog errors are logged and audited when audit storage remains writable.
- Each audit insert commits with `synchronous=FULL` and rollback journalling
  before its promise resolves. Duplicate request IDs, unavailable storage, or
  contention beyond the 250-ms busy timeout reject the write and block delivery.
  Records contain no request headers, tokens, report HTML, or arbitrary extra fields.
- The API still accepts the catalog and audit callback separately; deployment
  code must explicitly wire both from the opened store and close it on shutdown.

```powershell
npm run typecheck
node --test .\tests\access.test.ts .\tests\diagnostic-store.test.ts
```

Fourteen storage tests cover close/reopen persistence, customer isolation, atomic
imports, integrity failures, committed audit visibility, lock/closed-store failures,
invalid databases, staged approvals, migration, and the backup/restore failures below.
The access suite additionally proves that a real database
write lock prevents report bytes being served. The Keycloak proof imports both
synthetic reports, closes/reopens their database before login, and independently
reads back all twenty-two committed access decisions. It also backs up and restores
both captured reports and compares every restored audit, candidate, and review
column. Its temporary SQLite files
are removed after the test; normal adapter databases persist until explicitly
removed by their operator.

Limitations: synchronous operations can block the event loop, metadata listing
currently validates full stored reports, and no paging, retention/deletion,
off-host append-only audit, tamper-evident audit chain, off-host disaster recovery,
multi-process load, or power-loss test exists. A matching hash is not independent
approval evidence if an attacker can rewrite the database and hash together.
Filesystem administrators can alter both evidence and audit; do not treat this
proof as an immutable third-party evidence archive.

### Local diagnostic backup and separate restore

[src/diagnostic-backup.ts](./src/diagnostic-backup.ts) provides two trusted
operator functions, not HTTP resources:

1. `backupDiagnosticStore(sourcePath, parentDirectory)` opens an existing database
   read-only and uses SQLite's online backup API, not a filesystem copy of a live
   database. It returns a newly generated backup directory containing
   `diagnostics.sqlite` and `manifest.json`.
2. `restoreDiagnosticStore(backupDirectory, parentDirectory)` returns the database
   path inside a newly generated, separate restore directory. It never restores
   over the source or an existing application database.

All arguments must be absolute paths in operator-controlled local directories.
The parent directory must already exist and have appropriate private ACLs.
The backup contains **every customer's approved, pending and rejected report,
review receipts, and audit history** in that database; it is not a customer export.
No raw capture files, credentials,
membership configuration, or identity-provider database are included.

The manifest records format version, creation time, database SHA-256, incident
count, and audit count; version 2 also records candidate and review counts.
Backup validation checks SQLite integrity, schema version, required columns,
report hashes, incident/customer provenance, and approval/publication consistency.
Restore copies
into its new directory, checks that exact copy against the manifest, then repeats
database/content validation and verifies counts before returning success.
Failures remove only the newly allocated output directory and propagate the error.
Missing database/manifest files never become empty successful restores.

The automated recovery test takes a backup with the source store still open,
adds a later audit event, removes the closed original database, and restores
reports plus the exact pre-backup audit history. It verifies customer separation,
new audit writes on the restored store, and a second independent restore without
overwriting the first. Negative tests cover incomplete files, malformed manifests,
count/checksum mismatch, invalid reports even with a recomputed database checksum,
unsupported schemas, and missing sources. Run `npm run test:storage` for this proof.
The real Keycloak proof additionally verifies backup/restore of generated packet
reports and its twenty-two access decisions.

Backups are point-in-time copies, so later events require a later backup. The
manifest is a consistency check, not a signature or independent approval record.
Do not promote a restored copy into service until separately checking deployment
identity, permissions, storage protection, and application configuration.
Scheduling, encryption/key custody, off-host copies, retention, restore promotion,
large-database/concurrent-write load, interrupted-process/power-loss recovery,
and full PBX/recording/identity disaster recovery remain unverified. The backup
directory and manifest are not claimed to be crash-atomically published.

### Staged report review

The persistent adapter no longer has a direct `importApproved` operation.
Merely placing evidence on disk, staging it, or knowing its hash does not publish
it. Its local workflow is:

1. A trusted importer validates customer/incident provenance and report content,
   then calls `stage(entries)`. Each new candidate has a generated ID and a SHA-256
   binding its complete stored customer/metadata/report snapshot.
2. An authorised operator uses `pending(customer)` and `candidate(id)` to inspect
   the candidate. These methods return sensitive, **unapproved** content and are
   not connected to HTTP resources or the public incident catalog. Candidate HTML
   must not be rendered as trusted application HTML.
3. After actually reviewing scope, redaction and suitability for disclosure, the
   operator calls `review(id, { decision, reviewer, reason, sha256 })` with
   `decision` set to `approve` or `reject`. A nonempty reviewer/reason and the
   exact reviewed snapshot hash are required.
4. Approval publishes that exact snapshot in the same transaction as its review
   receipt. Rejection records the decision without publishing anything. Failed
   receipt or publication writes roll back both. Decisions are one-shot: this
   proof has no overwrite, corrected resubmission, revocation, or reapproval path.

Pending/rejected candidates are absent from customer incident lists; their report
routes return 404 even to a permitted report reader. Published reads verify the
snapshot against its candidate and approval receipt. Receipt deletion or mismatch
fails explicitly rather than bypassing approval. Read/report permissions do not
expose the operator staging/review methods.

**Trust boundary:** these store methods remain privileged in-process functions.
Direct callers must authenticate the operator and enforce customer-scoped approval
permission; a directly supplied reviewer string is not verified identity. The
authenticated API below provides that boundary for HTTP requests. The Keycloak
test exercises authenticated browser approval of known synthetic fixtures; it does
not certify real redaction or provide a production application/session flow.
The separate in-memory catalog still accepts trusted, already-approved entries;
it is not the persistent ingestion workflow.

**Version-1 migration:** opening a version-1 database transactionally moves its
legacy published entries to pending candidates and clears their published copies,
while preserving access-audit records. Legacy reports consequently disappear
from customer listings until explicitly reviewed. It does not fabricate reviewers
or approvals. Back up before opening an older database. Version-1 backups can
still be validated/restored separately; opening the restored database performs
the same migration. Version-2 backups retain pending/rejected state and validate
approval receipts as well as the published reports.

Tests cover hidden pending/rejected reports, hash-bound review, missing reviewer
or reason, duplicate decisions, transaction rollback, receipt tampering,
version-1 migration, and review-state recovery. Approval receipts are local
records, not signatures or a tamper-proof external audit trail. Production
reviewer provisioning/revocation, rejection correction, approval revocation, production review UI,
and retention remain outstanding.

### Authenticated review API proof

The API factory's optional fifth argument is a review store exposing `pending`,
`candidate`, and `review` from the opened diagnostic store. It is deliberately
separate from the public incident catalog; no staging/upload endpoint exists.
All three routes require the explicit provisioned **`diagnostics:review`**
permission for the customer in the path:

| Resource | Result |
|---|---|
| `GET /api/customers/{customer}/diagnostics/reviews` | Pending candidate IDs and snapshot hashes only |
| `GET /api/customers/{customer}/diagnostics/reviews/{candidate}` | Candidate metadata, snapshot hash, and unapproved report as JSON |
| `POST /api/customers/{customer}/diagnostics/reviews/{candidate}` | Approve or reject the exact candidate |

Candidate IDs are generated UUIDs. A candidate belonging to another customer
returns 404 within an authorised customer scope; trying an unauthorised customer
path returns 403. Metadata/report permissions, token roles, and diagnostic-only
support grants do not imply review authority. Conversely, review permission does
not grant the published-report route.

A decision body contains exactly `decision` (`approve` or `reject`), nonblank
`reason` (at most 2,000 characters), and the candidate's `sha256`. Reviewer identity
is taken from the verified access-token subject; a caller-supplied `reviewer` or
other extra field is rejected. The endpoint requires JSON, accepts at most 8,192
body bytes, rejects encoded bodies, and limits body receipt to five seconds.
Invalid input returns 400/413/415/408 as appropriate; stale hashes or already
decided candidates return 409. No silent overwrite or success-shaped retry exists.

Candidate content is returned as `application/json` with no-store, nosniff and a
restrictive CSP, not as rendered unapproved HTML. Clients must keep it inert or
use a separately sandboxed preview. Successful list/candidate responses await the
configured audit sink. Successful decisions instead commit their access audit,
review receipt and publication together through the same SQLite transaction.
The deployment must wire the real store for review, not an adapter that ignores
the transactional access-audit argument. The ordinary audit callback handles
denials and invalid/conflicting requests; it is not called again after the store
has already committed a successful decision audit.

Tests verify customer separation, permission separation, reviewer spoof rejection,
exact byte boundaries, body timeout, conflicting decisions, and rollback when
either decision audit or publication fails. The real Keycloak proof leaves Alice's
captured report pending across database reopen, then uses her access token to
inspect and approve it; the receipt records her actual subject. Bob's metadata-only
token cannot review. All twenty-two decisions and review receipts survive backup/restore.

This remains a loopback server-factory proof with configuration-backed grants.
The optional server-session layer below adds browser cookie authentication and
CSRF-protected mutation requests. Production ingress/rate limits, approval
revocation, and live grant administration remain absent. Use TLS and complete
session operations before exposing it to real operators.

### Browser engineering-review workspace proof

The API now serves a static shell at `/engineering/reviews/{customer}`, with
fixed JavaScript/CSS resources and a restrictive same-origin CSP. The shell is
public but contains no evidence or token and makes no API requests by itself.
An unrecognised customer name in this shell URL does not grant access: every
evidence request still passes the existing customer/review-permission checks.

The browser module [src/review-workspace.js](./src/review-workspace.js) exposes
`connectReviewWorkspace(accessToken)` for the original bearer-based test and
`connectReviewWorkspace({ csrf })` for the server-session adapter below.
The original Keycloak test supplies its freshly verified access token in memory.
There is deliberately no token entry box, URL token, browser-storage token,
embedded credential, or implicit cookie authentication. The returned disconnect
function aborts pending requests, clears the connection token and removes
evidence from the workspace; reconnecting first disconnects the old connection.
This adapter hook is **not** an end-user login/logout implementation.

The workspace lists pending candidate IDs, loads a selected snapshot, and shows
customer, incident, title, creation time and snapshot hash. It provides the
restricted rendered preview described below plus the exact original HTML through
`textContent` in a collapsible source view. Raw source is never inserted into a
live document or frame. Approved interactive reports remain a separate
permission-controlled route.

Pending reports are displayed as individual cards with title, incident ID,
creation time, candidate ID and snapshot SHA-256, so engineers can identify
evidence before opening it. The review-list API adds an allowlisted `summary`
object (`id`, `title`, `createdAt`) to each candidate reference, derived from the
integrity-checked stored snapshot. It does not return report HTML, arbitrary
snapshot fields or another customer's metadata. The existing review permission
and audit-before-delivery checks still apply. Titles are inserted as text, not
HTML. Opening a candidate checks that its metadata and hash agree with the list;
malformed or changed metadata produces an explicit error and no decision
controls. Existing candidate-ID ordering is unchanged; paging and assignment
remain future work.

**Filter pending reports** applies a trimmed, case-insensitive literal substring
to loaded report titles, incident IDs and candidate IDs. Its count explicitly
shows visible versus loaded candidates; a no-match result is not an empty queue.
**Clear pending filter** restores the full loaded list. Filtering makes no network
request, loads no report content, and sends or persists no filter text. The
200-character filter is retained across list refresh and decisions within the
current connection, but cleared when that connection closes. Filtering does not
close or change the open candidate, review reason, evidence search or approval
hash. The controls are unavailable during requests and hidden until a valid list
has loaded. This is a local convenience, not server-side search or pagination.

**Sort pending reports** offers candidate-ID order (the unchanged default),
oldest-created first and newest-created first. Creation-time ordering compares
parsed instants, including timezone offsets, with ascending candidate ID as a
deterministic tie-breaker. It orders loaded cards only, combines with the current
filter and does not request evidence or change an open review. The chosen order
survives refresh/decisions within the connection but resets on reconnection;
neither it nor the filter is stored in browser storage. Sorting is by incident
creation time, not staging time or urgency. The visible/loaded status announces
the active order, and clearing the filter does not reset it.

**Close review without deciding** removes the selected report's frame, original
source, evidence-search controls, reason and scope check from the workspace.
It sends no request or decision and leaves the candidate pending; list metadata,
filter and ordering remain available. Focus returns to the pending filter.
If any reason text or scope confirmation has been entered, a separate discard
dialog requires **Discard and close**; Cancel or Escape preserves the local
review. Reopening fetches the candidate again and starts with an empty reason
and unchecked scope confirmation. This is screen cleanup, not secure memory
erasure, logout, or a persisted draft workflow.

Refreshing the pending list or opening any candidate (including reopening the
same candidate) uses the same discard protection when a reason or scope check
has been entered. The dialog identifies the requested action; **Discard and
refresh** or **Discard and open** performs it only after confirmation. Cancel
or Escape leaves the reason, scope check and evidence search untouched and sends
no API request. Confirmed navigation sends only the ordinary list/candidate GET,
never a decision POST; the previous candidate remains pending. Blank reviews
navigate without prompting. Successful decisions refresh normally without a
redundant discard prompt. Session expiry, logout and connection replacement are
not guarded; session cleanup still clears evidence immediately. Drafts are not
saved or recovered.

While a reason or scope check is present, a native browser `beforeunload` warning
also requests confirmation for reload or leaving the document. The listener is
attached only while that local review is dirty and removed when fields are
cleared, evidence is closed, a decision completes, or the connection is disposed.
Cancel preserves the review; leaving discards it without submitting a decision.
The browser controls the warning text and whether to show it (usually requiring
prior user interaction). This is best-effort protection, not guaranteed on tab
termination, mobile shutdown, crashes or every browser navigation. It does not
save drafts or prevent logout/session expiry. Browser tests exercise cancelled
and accepted reloads, cleared fields and connection cleanup; the real session
fixture verifies dirty-review logout removes the warning and report evidence.

The session header also warns when the advertised session deadline is two minutes
away (or immediately if less time remains). It explains that unsaved work will
be cleared and no decision is submitted automatically. The warning does not
extend the session, save a draft or trigger sign-in. Successful logout or expiry
removes it; expiry still clears evidence and dirty-review unload protection.
Browser timers can be delayed in suspended/background tabs, so this is advance
guidance, not an exact countdown or a substitute for server-side expiry checks.
The real-login fixture uses a controlled browser clock and shortened advertised
deadline to verify the warning threshold and dirty-review UI cleanup without a
decision POST; server token/session-expiration checks are tested separately.

The session UI rechecks the absolute advertised deadline on `visibilitychange`
and `pageshow`, as well as timer callbacks. Returning from a suspended/background
page therefore catches up the warning or clears expired evidence immediately
when those events run, rather than relying solely on delayed timers. These checks
make no request or decision and do not extend the server session. Expiry/logout
remove the listeners and pending timer; repeated restoration events cannot revive
an ended workspace. Controlled-clock tests advance wall time without firing
timers, then exercise both events before and after expiry. This is not a
cross-tab revocation check: earlier server-side invalidation is still enforced
when the next authenticated request is made.

Bootstrap also rejects an advertised deadline at or before the browser's current
time **before** connecting the review workspace. It displays an explicit expiry
error and keeps sign-in available, without fetching pending metadata or candidate
evidence. Controlled-clock tests cover both the exact deadline and one millisecond
past it, asserting zero review API requests and no decision POST. This browser
check complements, rather than replaces, server-side session enforcement.

Deadline handling is installed while the initial pending-list request is still
loading, rather than after it completes. A session-owned abort signal disposes
the workspace and cancels outstanding review fetches on expiry/logout, including
initial load. An already-aborted connection starts no review request. The
real-login fixture holds a list response across a shortened advertised deadline
and verifies cancellation, evidence cleanup and no late list restoration or
decision POST. Cancellation does not undo a server-side decision that may already
have committed; a lost decision response still requires refreshing after sign-in.

A review API **401** in application-session mode now immediately closes the
workspace, clears loaded list/evidence/local form state and unload protection,
removes expiry timers/listeners and shows an explicit sign-in-again message.
This applies to list, candidate and decision requests, even if the 401 body is
not valid JSON. Decisions are never automatically retried; the message asks the
reviewer to check report state after signing in before retrying. A **403** remains
a permission denial, not a logout: sign-out remains available for that valid
session. The original in-memory bearer-token test adapter retains its existing
error handling. Real-login browser tests inject 401 responses on each review
surface and verify cleanup and no retry; this is reactive to requests, not
cross-tab revocation polling or an identity-provider logout.

Failed sign-out explicitly says **sign-out was not confirmed** and that the
session may still be active, retaining a retry button rather than showing
sign-in as though logout succeeded. Server errors and transport failures both
use this wording; no automatic retry is attempted. A real-login test injects a
logout-audit failure and verifies the cookie/server session, dirty review and
unload warning remain active, with no successful logout receipt. It then aborts
a browser logout request and verifies the same retry behaviour before a manual
retry succeeds, clears evidence and denies session replay. A lost response may
still follow a completed server logout; the message deliberately does not claim
that the session is definitely active.

Session-bootstrap errors provide **Retry session connection** alongside the
explicit error and sign-in link. This manually reloads the current workspace,
rechecks the existing HttpOnly session and fetches the pending list only if
bootstrap succeeds. It does not automatically retry, start an identity login,
submit a review decision, or recover discarded drafts. Normal unauthenticated
401 responses still offer sign-in rather than an error/retry loop. Real-browser
tests cover server errors, malformed JSON and network failure before login, plus
successful recovery with the same application-session cookie after login. No
review requests are made during failed bootstrap.

Keyboard focus follows review actions: a loaded list focuses its filter, opening
a candidate focuses the review heading, and request/validation errors focus the
visible alert. Request-completion focus runs after controls are re-enabled;
disposed workspaces never reclaim focus. Review headings and alerts are
programmatically focusable without adding extra Tab stops, with a visible focus
outline. Confirmation/discard dialogs initially focus **Cancel**, not the
destructive or disclosure action. Browser tests verify Tab from the heading to
evidence search, error/list focus and Enter cancelling a newly opened approval
dialog without a POST. These checks are not a complete accessibility audit.

Session-bootstrap and unconfirmed-logout errors display the response's
`X-Request-Id` for correlation with server logs. Only UUID-shaped references are
shown; missing/invalid headers and network failures explicitly show `unavailable`,
not a fabricated ID. Headers are used even for malformed JSON responses, and
references are rendered as text without exposing session cookies or CSRF values.
The real-login fixture verifies a failed logout's visible reference exactly
matches the HTTP header and server error logger, alongside bootstrap malformed,
missing/invalid-reference and transport-failure cases. An audit failure may leave
no durable audit row; the ID then correlates with the operational error logger,
not a claimed successful logout receipt.

Review-list, candidate and decision responses now use the same validated
`X-Request-Id` helper as session errors. Malformed JSON produces an explicit
error with HTTP status and request reference without displaying raw upstream
content. Valid JSON errors display only bounded identifier-shaped error codes;
body-provided request IDs are not trusted in place of the response header.
Missing/invalid references show `unavailable`. A malformed decision acknowledgement
does not imply rollback: the browser removes the selected evidence/decision
controls and warns that the decision may already have committed, without retrying.
Browser tests cover malformed list/candidate responses, invalid references/codes
and an approval actually committed in storage before its response is damaged.

Review transport failures now explicitly warn that a lost response may follow a
committed decision, rather than displaying only a generic fetch exception.
Failures before headers show `request unavailable`; interruptions while reading
a received body retain its HTTP status and validated request reference. Request
timeouts have an explicit timeout message. Selected evidence/decision controls
are removed and no automatic retry is sent. Cancellation caused by session
cleanup retains the session's own closed/expired message instead of overwriting
it with a transport error. Browser tests disconnect approval requests both before
server delivery and after an actual commit, verifying the differing stored
outcomes and the same conservative browser recovery guidance. Refresh/re-sign-in
and inspect the pending/published state before deciding whether to retry.

The browser regression also exercises the real 15-second request timeout without
mocking browser timers: an approval commits while its acknowledgement is held
back. The test verifies the timeout does not occur before 15 seconds and is
reported within the test's 20-second wait window, with no retry or remaining
decision controls. Releasing the late success cannot overwrite the timeout;
refresh reconciles the pending list against the committed approval without a
second decision POST. This deliberately adds about 15 seconds to the UI test.

After a valid successful decision acknowledgement, the workspace displays a
separate **Last confirmed review** status with the decision, candidate ID and
snapshot hash. It is set before refreshing the list, so a failed follow-up GET
cannot erase the confirmed outcome or imply rollback. It explicitly advises not
to resubmit that decision. The status remains through manual refresh, is replaced
only by another confirmed decision, and disappears when the connection closes or
the page reloads. It is a local acknowledgement, not a new durable receipt API or
history view; SQLite still holds the authoritative review record. Malformed/lost
acknowledgements do not create a confirmation. Browser tests cover both approve
and reject followed by a 503 list refresh, recovery without a second POST, and
preservation of the previous confirmation when another response is damaged.

HTTP success alone does not confirm a review: the response must be a JSON object
with the recognised `incident_review_recorded` code. Null, arrays and unexpected
codes produce an explicit unconfirmed-outcome error with HTTP status and validated
header reference. The browser warns that the decision may already have committed,
clears evidence/decision controls and does not replace the last confirmed outcome
or retry. Tests cover unrecognised JSON both without server delivery and after a
real approval commit; raw response fields are not displayed in the error.

While a review request is in flight, the workspace sets `aria-busy` and disables
its buttons, search/filter/order inputs, reason and scope checkbox. Decision
submission explicitly says it is awaiting confirmation. This prevents local
inputs from drifting from the submitted decision; it does not change the
hash-bound request or make it safe to retry an uncertain outcome. Controls are
re-enabled after completion/failure and busy state is cleared on disposal.
The separate session-header sign-out remains usable during workspace loading.
Browser coverage checks the locked form during a stalled acknowledgement,
recovery after timeout, and busy cleanup on session expiry during initial load.

Approval/rejection requires a reason and an explicit scope/redaction check.
A modal confirmation repeats the customer, incident, snapshot hash and reason.
Cancel sends no decision; confirm submits that exact snapshot once, with controls
disabled while requests are active. A successful decision refreshes pending
reports. Stale/conflicting decisions, expired/unauthorised access, malformed API
responses, network errors and storage outages display an error rather than
success. Errors clear the selected report and require a fresh selection; no
automatic decision retry occurs, since a lost response can follow a committed
decision. Client requests have a 15-second timeout and never forward credentials
through redirects or to external origins.

```powershell
npm run typecheck
npm run test:review-ui
.\scripts\Test-IdentityProof.ps1
```

The Playwright workspace regression covers malicious preview markup without
execution or external requests, cancel/confirm, approval/rejection, conflict
handling, denied/expired tokens, malformed responses, network/storage errors,
disconnect cleanup, and absence of token DOM/storage/cookies. The real Keycloak
test now approves Alice's actual captured synthetic report using the workspace
and checks her verified reviewer subject plus all 22 audited API requests through
backup/restore. Test browsers/listeners and temporary storage are cleaned up.

Remaining: production session operations, full-fidelity interactive review
preview, reviewer navigation/assignment, production localisation/accessibility
validation, and safe deployment operations. No long-running management service
is started by these tests.

#### Restricted rendered report preview

[src/review-preview.js](./src/review-preview.js) rebuilds a simplified preview from
an explicit HTML element allowlist. Raw markup is parsed only in inert template
content, never with a live document or a detached resource-loading document.
Fresh nodes preserve ordinary headings, paragraphs, text, lists, tables and
packet-provenance details. Details are opened so evidence is not hidden behind
collapsed controls. Source attributes are discarded except bounded numeric table
cell spans; report classes, IDs, CSS and event handlers are not retained.

Scripts, styles, images, embedded frames/objects, SVG/MathML, metadata and resource
elements are discarded. Links, forms and unsupported wrappers are unwrapped to
ordinary text rather than preserving URLs, submission or navigation behaviour.
The rebuilt HTML is placed in a sandboxed frame with **no sandbox allowances**,
an opaque origin, no referrer and a restrictive `default-src 'none'` CSP. It
cannot run report scripts or access the parent application/storage. The parent
workspace CSP permits this local frame but does not grant it script privileges.

The preview warns that content has been simplified and reports removed/unwrapped
element counts. The original source remains available for inspection. Approval
still binds the exact original snapshot, not the rebuilt display, and the
published report bytes are unchanged. This renderer does **not** redact evidence,
certify its suitability, reproduce source styling or provide the report's
interactive filters. Reviewers must check original content and intended
disclosure, not treat the simplified preview as proof that the export is safe.

The application-owned **Find evidence text** control highlights case-insensitive
literal matches within individual text nodes of the simplified preview. Enter
or **Highlight matches** applies the search; **Clear highlights** restores the
unmarked view. Search never hides rows or other evidence and does not modify the
original report, source view, review reason or approval hash. Terms spanning
separate inline elements do not match. Queries are limited to 200 characters and
only the first 1,000 occurrences are highlighted, with an explicit notice when
more exist. Searching rebuilds the frame and resets its scroll position; no
script or same-origin sandbox allowance is added. Search text is not sent to the
server or persisted in browser storage.

Input is limited to 2 MiB, 100,000 visited nodes and 128 levels of nesting.
Exceeding limits fails explicitly, clears the selected review and offers no
approval controls for that failed selection. Limits bound the reconstruction;
they are not a browser parsing performance guarantee.

Playwright verifies readable signalling rows, cell spans and expanded packet
details; active markup and resource-loading probes cannot execute or issue
external requests, and the frame cannot access parent DOM or localStorage.
Size/depth/node-limit failures are tested. The real Keycloak proof checks the
captured SIP report's two evidence tables and visible provenance before approving
the original snapshot, including search highlighting without changing evidence
text or table counts. Search tests cover literal punctuation/HTML, Unicode case
matching, text-node boundaries, no matches and the exact 1,000-highlight boundary.
Failure/disconnect paths remove preview, search controls and source.

### Server-managed application login/session proof

**Selected architecture:** server-managed application sessions (confirmed during
planning). Identity access/ID tokens and client credentials stay on the server;
the engineering browser uses an opaque HttpOnly cookie and a per-session CSRF
token, not browser-held Keycloak credentials. The original public-client PKCE
fixture remains a separate API integration regression, not the application login
implementation.

The API factory's optional sixth argument configures the application origin,
issuer, fixed authorization/token/JWKS endpoints, confidential client ID/secret
and API audience. Identity configuration must match the API verifier. HTTPS is
required except for explicitly opted-in loopback-only test HTTP. URLs cannot be
selected by requests, and callback destinations are fixed rather than accepting
arbitrary return URLs. Never expose the generated fixture secret or use it as a
production credential.

| Route | Behaviour |
|---|---|
| `GET /auth/login?customer={customer}` | Starts confidential-client authorization-code/S256 PKCE login for a validated customer slug |
| `GET /auth/callback` | Checks one-use state and browser-binding cookie, exchanges code server-side, verifies signed ID/access tokens and nonce/subject, then rotates the application session |
| `GET /auth/session` | Returns only workspace customer, CSRF token and expiry; no identity credentials |
| `POST /auth/logout` | Requires the session cookie, exact configured Origin and CSRF header; audits and invalidates this local session |

When this layer is configured, the workspace automatically shows **Sign in**,
redirects through Keycloak, restores its connection after page reload, and offers
**Sign out**. No browser test hook or manual token entry is needed for this flow.
The bootstrap module [src/review-session.js](./src/review-session.js) connects
through same-origin cookies. Session expiry disconnects the workspace and clears
its displayed evidence.

Cookies use HttpOnly, SameSite=Lax and Path=/; HTTPS uses Secure `__Host-` cookie
names. The loopback HTTP fixture uses explicitly test-named cookies without
Secure. Pending login state expires after five minutes. Active sessions end at
the earliest ID/access-token expiry or fifteen minutes, without sliding renewal
or refresh-token storage. Both login state and active sessions are in bounded,
process-local maps (1,000 each); expired entries are removed on access. Restarting
the server requires fresh login and does not restore identity tokens from the
diagnostic database.

Cookie-authenticated API mutations require both the exact configured Origin and
the per-session `X-CSRF-Token`; cross-site Fetch Metadata and mixed session/bearer
credentials are rejected. API membership/review/report checks still execute
against the server-held access token on every request. Login to a workspace is
not customer membership: Bob can authenticate but still cannot review reports.
Existing explicit bearer API callers remain supported without cookie sessions;
do not combine their credentials.

Login completion waits for durable access audit before issuing a session.
Logout waits for audit before invalidating it; if audit fails, the browser reports
failure and must retry sign-out. Signing out invalidates the local cookie ID, so
replaying it cannot restore access. This does **not** log out the Keycloak SSO
session or other devices, and valid previously issued bearer tokens are not
globally revoked. Invalid-login/CSRF operational coverage is narrower than a
production identity-event audit; successful login/logout and API decisions are
persisted without credentials.

```powershell
npm run typecheck
npm run test:session
.\scripts\Test-IdentityProof.ps1
```

The identity runner now executes both the original 22-decision browser/API proof
and a separate application-session proof using the generated confidential client
and exact `http://127.0.0.1:18766/auth/callback`. The latter uses normal sign-in
links/forms without injecting access tokens into page code. It verifies Alice's
review, Bob's denial, reload persistence, HttpOnly cookie properties, CSRF rejection,
local logout and cookie replay denial, plus persisted login/logout audits.
The session regression also covers callback binding/replay, nonce mismatch,
exchange rejection, session rotation/expiry, audit failures, secure-cookie flags,
and rejected identity configuration.

Limitations: development-mode Keycloak, loopback HTTP (no real TLS proof), single
process/in-memory sessions, fixed short lifetimes, no session persistence or
cross-instance coordination, no refresh, no MFA/federation proof, no IdP logout or
back-channel revocation, no production secret manager/rate limiting, and no
production application deployment yet. Full managed-session deployment and
recovery remain future work, not implied by passing browser tests.

## Run the local engineering workspace interactively

Requirements: Docker Desktop running, PowerShell 7, Node 24, and the existing npm
dependencies. This is a **local synthetic-data proof**, not a production installer.
Do not expose its HTTP ports or load real customer evidence into it.

From a PowerShell terminal in the repository:

```powershell
.\scripts\Start-LocalEngineering.ps1
```

The launcher generates the ignored test identity fixture, starts its isolated
Keycloak container, checks readiness, type-checks the application, and starts the
engineering server in the foreground. Open:

- Customer A: `http://127.0.0.1:18766/engineering/reviews/customer-a`
- Customer B: `http://127.0.0.1:18766/engineering/reviews/customer-b`

Click **Sign in**, then use the generated credentials in
`.local-proof\identity\accounts.json`. Alice can inspect/approve/reject customer A
reports; Bob has customer B metadata access but is deliberately denied review
authority. Do not share the accounts, realm import, or confidential-client JSON:
they contain plaintext synthetic credentials. No credentials are printed by the
application launcher.

The default start imports **no evidence**. To explicitly stage the latest complete
synthetic captured incident for both customers:

```powershell
.\scripts\Test-CaptureProof.ps1 # Only needed if no completed synthetic capture exists
.\scripts\Start-LocalEngineering.ps1 -StageCapturedReports
```

Staging uses the same captured-incident loader as the identity regression. Both
customer manifests must match their incident/customer scope, and report SHA-256
checks must pass. Incomplete incident directories are skipped; malformed complete
manifests or missing/tampered selected reports fail startup explicitly. All
imported reports start pending: nothing is automatically approved. Reusing the
flag does not restage identical candidates or reset prior approval/rejection;
changed content/metadata under an existing customer/incident key is refused.
Generate a new capture with a new incident ID for another review exercise.

Diagnostic candidates, review receipts, published reports, and access audits are
persisted at `.local-proof\engineering\diagnostics.sqlite`. Restarting preserves
them but invalidates application sessions. The development Keycloak database is
ephemeral: each launcher run generates fresh test credentials and subject IDs.
Historical reviewer IDs remain recorded as originally issued; this is not
production identity continuity. New generated credentials are required after
restart. Sessions currently last at most the fixture's two-minute token lifetime.

**Stop:** type `stop` and press Enter in the launcher terminal (recommended), or
press Ctrl+C. The server closes its listener and database; the PowerShell owner
then removes only its identity Compose container/network. The diagnostic database,
captures and generated credential files remain ignored on disk. A hard terminal
kill, machine crash or forced process termination is not graceful cleanup; inspect
and stop only this fixture's Compose project before restarting. Do not delete
the database just to clear a review decision.

The runner takes an exclusive identity-fixture lock before generating credentials,
refuses existing fixture containers, and preflights loopback ports 18080, 18765 and
18766. A competing launcher or occupied port fails rather than replacing another
service. The Node listener binds only `127.0.0.1`; no container socket, raw capture
control, or unauthorised filesystem API is exposed. The older identity tests now
use the same lock, so do not run them while the interactive fixture is open.

`Test-IdentityProof.ps1` additionally runs the launcher regression: real browser
login/review, database persistence across restart, lost-session rejection, identical
capture reuse, tampered/changed capture refusal, competing launcher/occupied-port
denial, and graceful CLI stop. Temporary regression databases are removed; the
actual local application database is deliberately preserved. The test's CLI
smoke start does not import reports into that application database.

The TypeScript entry point `scripts\Start-LocalEngineering.ts` is also available
when the correct identity fixture is already running; it does **not** own Docker
or generate identity configuration. Prefer the PowerShell launcher for normal use.
No service is automatically left running after validation.