[CmdletBinding()]
param([switch]$Conformance, [switch]$CrossRuntime)
$ErrorActionPreference = 'Stop'
if ($CrossRuntime) { $Conformance = $true }
$root = Split-Path -Parent $PSScriptRoot
$fixture = Join-Path $root 'tests\identity\broker-peer-proof.py'
if ($Conformance) { $fixture = Join-Path $root 'tests\identity\broker-conformance-proof.py' }
$vectors = Join-Path $root 'tests\identity\broker-conformance.json'
if ($Conformance) {
    & node --test (Join-Path $root 'tests\agent-broker-conformance.test.ts')
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript shared broker conformance vectors failed.' }
}
$imageName = 'asterisk-local-diagnostics:proof'
if ($CrossRuntime) { $imageName = 'asterisk-broker-cross-runtime:proof' }
$image = & docker image inspect --format '{{.Id}}' $imageName
if ($LASTEXITCODE -ne 0 -or -not $image) {
    throw "Build the required local proof image ($imageName) before running the broker peer fixture."
}
$extraMounts = @()
$fixtureArguments = @('-I', '-B', '/fixture.py')
if ($CrossRuntime) {
    $extraMounts = @(
        '--mount', "type=bind,source=$(Join-Path $root 'tests\identity\broker-cross-client.ts'),target=/tests/identity/broker-cross-client.ts,readonly",
        '--mount', "type=bind,source=$(Join-Path $root 'src\agent-broker-frame.ts'),target=/src/agent-broker-frame.ts,readonly"
    )
    $fixtureArguments += 'cross-runtime'
}
$name = 'asterisk-broker-peer-' + [guid]::NewGuid().ToString('N')
$label = "asterisk.broker-peer-owner=$name"
try {
    & docker run --rm --name $name --label $label --network none --read-only `
        --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add KILL `
        --security-opt no-new-privileges:true --pids-limit 32 --memory 96m --cpus 1 `
        --user '0:0' --tmpfs '/proof:rw,noexec,nosuid,size=1m,mode=1777' `
        --mount "type=bind,source=$fixture,target=/fixture.py,readonly" `
        --mount "type=bind,source=$vectors,target=/vectors.json,readonly" `
        @extraMounts --entrypoint python3 $image @fixtureArguments
    if ($LASTEXITCODE -ne 0) { throw 'Linux broker peer-credential proof failed.' }
} finally {
    $owned = & docker container ls -aq --filter "name=^/$name$" --filter "label=$label"
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect owned broker peer fixture cleanup.' }
    if ($owned) {
        & docker container rm -f $owned
        if ($LASTEXITCODE -ne 0) { throw 'Could not remove the owned broker peer fixture.' }
    }
}
