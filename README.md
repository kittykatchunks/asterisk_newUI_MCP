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