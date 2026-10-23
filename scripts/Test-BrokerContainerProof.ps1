[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$image = & docker image inspect --format '{{.Id}}' 'asterisk-broker-cross-runtime:proof'
if ($LASTEXITCODE -ne 0 -or -not $image) { throw 'Build the approved cross-runtime proof image first.' }
$security = & docker info --format '{{json .SecurityOptions}}'
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect daemon security configuration.' }
Write-Output "Daemon security options: $security"
$owner = 'asterisk-broker-container-' + [guid]::NewGuid().ToString('N')
$volume = "$owner-socket"
$label = "asterisk.broker-container-owner=$owner"
$names = [System.Collections.Generic.List[string]]::new()
$identities = [System.Collections.Generic.List[object]]::new()
$common = @('--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '16', '--memory', '96m', '--cpus', '1')
$mounts = @(
    '--mount', "type=bind,source=$(Join-Path $root 'tests\identity\broker-container-proof.py'),target=/container-proof.py,readonly",
    '--mount', "type=bind,source=$(Join-Path $root 'tests\identity\broker-conformance-proof.py'),target=/fixture.py,readonly",
    '--mount', "type=bind,source=$(Join-Path $root 'tests\identity\broker-conformance.json'),target=/vectors.json,readonly"
)
function Invoke-Client([string]$Mode, [string]$User, [string[]]$Extra = @(), [switch]$Writable) {
    $name = "$owner-$Mode"
    $names.Add($name)
    $access = if ($Writable) { '' } else { ',readonly' }
    $output = & docker run --name $name --label $label @common --user $User @Extra `
        --mount "type=volume,source=$volume,target=/socket$access" @mounts `
        --entrypoint python3 $image -I -B /container-proof.py $Mode
    if ($LASTEXITCODE -ne 0) { throw "Separate-container client failed: $Mode" }
    $events = @($output | ForEach-Object { $_ | ConvertFrom-Json })
    $identities.Add($events[0].identity)
    Write-Output $output
}
try {
    & docker volume create --label $label $volume
    if ($LASTEXITCODE -ne 0) { throw 'Could not create owned socket volume.' }
    $setup = "$owner-setup"
    $names.Add($setup)
    & docker run --name $setup --label $label @common --cap-add CHOWN --user '0:0' `
        --mount "type=volume,source=$volume,target=/socket" --entrypoint python3 $image -I -B -c `
        'import os; os.mkdir("/socket/broker", 0o750); os.chown("/socket/broker",1101,2100); os.mkdir("/socket/staging",0o700); open("/socket/staging/replacement","x").close(); os.chown("/socket/staging/replacement",1102,2100); os.chown("/socket/staging",1102,2100)'
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialise isolated socket volume.' }
    $server = "$owner-server"
    $names.Add($server)
    & docker run -d --name $server --label $label @common --user '1101:2100' `
        --mount "type=volume,source=$volume,target=/socket" @mounts `
        --entrypoint python3 $image -I -B /container-proof.py server
    if ($LASTEXITCODE -ne 0) { throw 'Could not start separate broker fixture.' }
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $logs = @(& docker logs $server 2>&1)
        if ($LASTEXITCODE -ne 0) { throw 'Could not inspect broker readiness.' }
        if ($logs -contains '{"ready": true}') { $ready = $true; break }
        $running = & docker inspect --format '{{.State.Running}}' $server
        if ($LASTEXITCODE -ne 0 -or $running -ne 'true') { throw "Broker stopped before readiness: $logs" }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw 'Broker did not become ready within the bounded readiness checks.' }
    $brokerIdentity = ($logs[0] | ConvertFrom-Json).identity
    $duplicate = "$owner-duplicate"
    $names.Add($duplicate)
    $duplicateOutput = & docker run --name $duplicate --label $label @common --user '1101:2100' `
        --mount "type=volume,source=$volume,target=/socket" @mounts `
        --entrypoint python3 $image -I -B /container-proof.py server 2>&1
    if ($LASTEXITCODE -eq 0 -or "$duplicateOutput" -notmatch 'Address already in use') {
        throw "Duplicate broker did not fail safely: $duplicateOutput"
    }
    Invoke-Client 'inventory' '1102:2100'
    Invoke-Client 'foreign' '1103:2100'
    Invoke-Client 'wrong-gid' '1102:2101' @('--group-add', '2100')
    Invoke-Client 'filesystem-denied' '1104:2101'
    Invoke-Client 'publish-ro' '1102:2100'
    Invoke-Client 'publish-rw' '1102:2100' -Writable
    Invoke-Client 'generation' '1102:2100'
    Invoke-Client 'reconnect' '1102:2100'
    foreach ($identity in $identities) {
        if ($identity.uid_map -ne $brokerIdentity.uid_map -or $identity.gid_map -ne $brokerIdentity.gid_map -or
            $identity.userNamespace -ne $brokerIdentity.userNamespace) {
            throw 'Unsupported namespace mapping: client/broker maps differ.'
        }
        if ($identity.pidNamespace -eq $brokerIdentity.pidNamespace -or
            $identity.mntNamespace -eq $brokerIdentity.mntNamespace) {
            throw 'Expected separate PID and mount namespaces.'
        }
    }
    $exitCode = & docker wait $server
    if ($LASTEXITCODE -ne 0 -or "$exitCode" -ne '0') {
        & docker logs $server
        throw 'Separate broker fixture failed.'
    }
    $events = @((& docker logs $server) | ForEach-Object { $_ | ConvertFrom-Json })
    if ($LASTEXITCODE -ne 0 -or -not $events[-1].complete -or
        $events[-1].sourceEntries -ne 3 -or $events[-1].deniedBeforeRead -ne 2) {
        throw 'Unexpected separate-container source/denial counters.'
    }
    $peers = @($events | Where-Object { $_.peer })
    if ($peers.Count -ne 5 -or @($peers | Where-Object { $_.allowed }).Count -ne 3) {
        throw 'Unexpected kernel peer evidence.'
    }
    $events | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 5 }
    Write-Output 'PASS separate containers: mapped UID/primary GID, namespace separation, pre-read denials, publication protection, duplicate broker exclusion and approved reconnect.'
} finally {
    $cleanupErrors = [System.Collections.Generic.List[string]]::new()
    foreach ($name in $names) {
        $owned = & docker container ls -aq --filter "name=^/$name$" --filter "label=$label"
        if ($LASTEXITCODE -ne 0) { $cleanupErrors.Add("Could not inspect owned container: $name"); continue }
        if ($owned) {
            & docker container rm -f $owned
            if ($LASTEXITCODE -ne 0) { $cleanupErrors.Add("Could not remove owned container: $name") }
        }
    }
    $ownedVolume = & docker volume ls -q --filter "name=^$volume$" --filter "label=$label"
    if ($LASTEXITCODE -ne 0) { $cleanupErrors.Add('Could not inspect owned volume cleanup.') }
    if ($ownedVolume -and $cleanupErrors.Count -eq 0) {
        & docker volume rm $ownedVolume
        if ($LASTEXITCODE -ne 0) { $cleanupErrors.Add('Could not remove owned socket volume.') }
    }
    if ($cleanupErrors.Count -gt 0) { throw ($cleanupErrors -join '; ') }
}
