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
on loopback 18765 exist only for the browser test. If ports are occupied, the proof
must fail rather than repurpose another service. It does not require a bootstrap
administrator account or expose a management console with default credentials.

The public client permits authorization-code login with S256 PKCE and one exact
callback URL. Password grants, service accounts, registration, and password reset
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
application sessions, MFA, federation, logout/revocation, key rotation, customer
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
his report, and neither can access the other customer. Thirteen API decisions
are audited in the successful identity test.

Eighteen access tests cover the original authentication boundary plus incident
metadata, report permission, report/audit failure, unavailable catalogs, tampering,
path-like raw-file requests, and response restrictions.

Outstanding: production storage/backup and ingestion approval, audit operations,
interactive application login/session handling, customer/engineer navigation,
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
reads back all thirteen committed access decisions. It also backs up and restores
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
reports and its thirteen access decisions.

Backups are point-in-time copies, so later events require a later backup. The
manifest is a consistency check, not a signature or independent approval record.
Do not promote a restored copy into service until separately checking deployment
identity, permissions, storage protection, and application configuration.
Scheduling, encryption/key custody, off-host copies, retention, restore promotion,
large-database/concurrent-write load, interrupted-process/power-loss recovery,
and full PBX/recording/identity disaster recovery remain unverified. The backup
directory and manifest are not claimed to be crash-atomically published.

### Staged report review (trusted operator proof)

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

**Trust boundary:** these are privileged in-process functions, not authenticated
reviewer APIs. The calling application must authenticate the operator and enforce
customer-scoped approval permission before calling them; a reviewer string is
not verified identity. No end-user approval UI or approval permission endpoint
exists yet. The Keycloak test explicitly approves only known synthetic fixtures;
it does not prove authenticated engineering approval or certify real redaction.
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
reviewer authorisation, rejection correction, approval revocation, review UI,
and retention remain outstanding.