[CmdletBinding()]
param([switch]$Conformance)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$fixture = Join-Path $root 'tests\identity\broker-peer-proof.py'
if ($Conformance) { $fixture = Join-Path $root 'tests\identity\broker-conformance-proof.py' }
$vectors = Join-Path $root 'tests\identity\broker-conformance.json'
if ($Conformance) {
    & node --test (Join-Path $root 'tests\agent-broker-conformance.test.ts')
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript shared broker conformance vectors failed.' }
}
$image = & docker image inspect --format '{{.Id}}' 'asterisk-local-diagnostics:proof'
if ($LASTEXITCODE -ne 0 -or -not $image) {
    throw 'Build the existing local diagnostics proof image before running the broker peer fixture.'
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
        --entrypoint python3 $image -I -B /fixture.py
    if ($LASTEXITCODE -ne 0) { throw 'Linux broker peer-credential proof failed.' }
} finally {
    $owned = & docker container ls -aq --filter "name=^/$name$" --filter "label=$label"
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect owned broker peer fixture cleanup.' }
    if ($owned) {
        & docker container rm -f $owned
        if ($LASTEXITCODE -ne 0) { throw 'Could not remove the owned broker peer fixture.' }
    }
}
