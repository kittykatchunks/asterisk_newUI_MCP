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
integrity manifests. Four report failure/redaction unit tests pass. This validates
a narrow evidence path, not an interactive engineering application, encrypted SIP
capture, hard byte quotas, or general customer-data export. No HOMER runtime
evaluation or AI analysis has been performed.

No identity-provider, AI, or provider component has passed runtime testing.
The exact digest is selected for this local experiment only, not approved for
production. Official release support and advisory review remain production gates.

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

Before implementation, decide between a backend-for-frontend cookie session and
a browser public client with authorization-code/PKCE. Do not mix their credential
assumptions. Either requires backend validation and customer membership checks.

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
