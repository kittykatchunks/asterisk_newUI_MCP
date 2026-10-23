[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$image = & docker image inspect --format '{{.Id}}' 'asterisk-local-diagnostics:proof'
if ($LASTEXITCODE -ne 0 -or -not $image) { throw 'Existing local diagnostics image is required; no implicit build or pull.' }
$name = 'asterisk-pbx-enrollment-' + [guid]::NewGuid().ToString('N')
$label = "asterisk.enrollment-owner=$name"
try {
    & docker run --rm --name $name --label $label --network none --read-only `
        --cap-drop ALL --security-opt no-new-privileges:true --user '1000:999' `
        --pids-limit 64 --memory 192m --cpus 1 `
        --tmpfs '/proof:rw,noexec,nosuid,size=16m,mode=0700,uid=1000,gid=999' `
        --mount "type=bind,source=$(Join-Path $root 'local\broker'),target=/broker,readonly" `
        --mount "type=bind,source=$(Join-Path $root 'tests\identity\pbx-enrollment-proof.py'),target=/proof-test.py,readonly" `
        --entrypoint python3 $image -I -B /proof-test.py
    if ($LASTEXITCODE -ne 0) { throw 'Disposable PBX enrollment feasibility proof failed; no privilege fallback.' }
} finally {
    $owned = & docker container ls -aq --filter "name=^/$name$" --filter "label=$label"
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect owned enrollment container.' }
    if ($owned) {
        & docker container rm -f $owned
        if ($LASTEXITCODE -ne 0) { throw 'Could not remove owned enrollment container.' }
    }
}
