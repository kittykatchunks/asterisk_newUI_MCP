[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$image = & docker image inspect --format '{{.Id}}' 'asterisk-broker-cross-runtime:proof'
if ($LASTEXITCODE -ne 0 -or -not $image) { throw 'Build the existing cross-runtime proof image first.' }
$name = 'asterisk-python-broker-' + [guid]::NewGuid().ToString('N')
$label = "asterisk.python-broker-owner=$name"
try {
    & docker run --rm --name $name --label $label --network none --read-only `
        --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add KILL `
        --security-opt no-new-privileges:true --pids-limit 64 --memory 96m --cpus 1 `
        --user '0:0' --tmpfs '/proof:rw,noexec,nosuid,size=1m,mode=1777' `
        --mount "type=bind,source=$(Join-Path $root 'local\broker\readback.py'),target=/broker.py,readonly" `
        --mount "type=bind,source=$(Join-Path $root 'local\broker\readback.py'),target=/local/broker/readback.py,readonly" `
        --mount "type=bind,source=$(Join-Path $root 'tests\python-broker-source.test.ts'),target=/tests/python-broker-source.test.ts,readonly" `
        --mount "type=bind,source=$(Join-Path $root 'tests\identity\fake-provisioning-runtime.ts'),target=/tests/identity/fake-provisioning-runtime.ts,readonly" `
        --mount "type=bind,source=$(Join-Path $root 'tests\identity\fake-broker-source.py'),target=/tests/identity/fake-broker-source.py,readonly" `
        --mount "type=bind,source=$(Join-Path $root 'tests\identity\fake-broker-source-proof.py'),target=/tests/identity/fake-broker-source-proof.py,readonly" `
        --mount "type=bind,source=$(Join-Path $root 'tests\identity\fake-broker-listener-proof.py'),target=/tests/identity/fake-broker-listener-proof.py,readonly" `
        --mount "type=bind,source=$(Join-Path $root 'tests\identity\fake-broker-socket-client.ts'),target=/tests/identity/fake-broker-socket-client.ts,readonly" `
        --mount "type=bind,source=$(Join-Path $root 'tests\identity\python-broker-proof.py'),target=/proof-test.py,readonly" `
        --mount "type=bind,source=$(Join-Path $root 'tests\identity\broker-conformance.json'),target=/vectors.json,readonly" `
        --mount "type=bind,source=$(Join-Path $root 'tests\identity\broker-cross-client.ts'),target=/tests/identity/broker-cross-client.ts,readonly" `
        --mount "type=bind,source=$(Join-Path $root 'src\agent-broker-frame.ts'),target=/src/agent-broker-frame.ts,readonly" `
        --mount "type=bind,source=$(Join-Path $root 'src\agent-broker-client.ts'),target=/src/agent-broker-client.ts,readonly" `
        --mount "type=bind,source=$(Join-Path $root 'src\agent-broker-readback.ts'),target=/src/agent-broker-readback.ts,readonly" `
        --mount "type=bind,source=$(Join-Path $root 'src\agent-provisioning-expiry.ts'),target=/src/agent-provisioning-expiry.ts,readonly" `
        --mount "type=bind,source=$(Join-Path $root 'tests\agent-broker-client.test.ts'),target=/tests/agent-broker-client.test.ts,readonly" `
        --env TMPDIR=/proof --env ASTERISK_SYNTHETIC_LISTENER_PROOF=1 `
        --entrypoint sh $image -c 'node --test /tests/agent-broker-client.test.ts /tests/python-broker-source.test.ts && exec python3 -I -B /proof-test.py'
    if ($LASTEXITCODE -ne 0) { throw 'Python broker implementation proof failed.' }
} finally {
    $owned = & docker container ls -aq --filter "name=^/$name$" --filter "label=$label"
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect owned Python broker cleanup.' }
    if ($owned) {
        & docker container rm -f $owned
        if ($LASTEXITCODE -ne 0) { throw 'Could not remove owned Python broker proof.' }
    }
}
