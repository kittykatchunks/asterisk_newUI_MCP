[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$image = & docker image inspect --format '{{.Id}}' 'asterisk-broker-cross-runtime:proof'
if ($LASTEXITCODE -ne 0 -or -not $image) { throw 'Build the existing cross-runtime proof image first.' }
$owner = 'asterisk-python-broker-containers-' + [guid]::NewGuid().ToString('N')
$label = "asterisk.python-broker-owner=$owner"
$volume = "$owner-socket"
$names = [System.Collections.Generic.List[string]]::new()
$common = @('--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '16', '--memory', '96m', '--cpus', '1')
$mounts = @(
    '--mount', "type=bind,source=$(Join-Path $root 'local\broker\readback.py'),target=/broker.py,readonly",
    '--mount', "type=bind,source=$(Join-Path $root 'tests\identity\python-broker-proof.py'),target=/proof-test.py,readonly",
    '--mount', "type=bind,source=$(Join-Path $root 'tests\identity\broker-conformance.json'),target=/vectors.json,readonly",
    '--mount', "type=bind,source=$(Join-Path $root 'tests\identity\broker-cross-client.ts'),target=/tests/identity/broker-cross-client.ts,readonly",
    '--mount', "type=bind,source=$(Join-Path $root 'src\agent-broker-frame.ts'),target=/src/agent-broker-frame.ts,readonly"
)
try {
    & docker volume create --label $label $volume
    if ($LASTEXITCODE -ne 0) { throw 'Could not create owned implementation socket volume.' }
    $setup = "$owner-setup"
    $names.Add($setup)
    & docker run --name $setup --label $label @common --cap-add CHOWN --user '0:0' `
        --mount "type=volume,source=$volume,target=/socket" --entrypoint python3 $image -I -B -c `
        'import os; os.mkdir("/socket/broker",0o750); os.chown("/socket/broker",1101,2100)'
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialise owned implementation socket directory.' }
    $server = "$owner-server"
    $names.Add($server)
    & docker run -d --name $server --label $label @common --user '1101:2100' `
        --mount "type=volume,source=$volume,target=/socket" @mounts `
        --entrypoint python3 $image -I -B /proof-test.py container-server
    if ($LASTEXITCODE -ne 0) { throw 'Could not start implementation broker container.' }
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $events = @((& docker logs $server 2>&1) | ForEach-Object { "$_" | ConvertFrom-Json })
        if ($LASTEXITCODE -ne 0) { throw 'Could not read implementation broker readiness.' }
        if (@($events | Where-Object { $_.ready }).Count -eq 1) { $ready = $true; break }
        $running = & docker inspect --format '{{.State.Running}}' $server
        if ($LASTEXITCODE -ne 0 -or $running -ne 'true') { throw 'Implementation broker exited before readiness.' }
        Start-Sleep -Milliseconds 100
    }
    if (-not $ready) { throw 'Implementation broker readiness deadline exceeded.' }
    $serverIdentity = $events[0].identity
    if ($serverIdentity.uid -ne 1101 -or $serverIdentity.gid -ne 2100 -or
        (@($serverIdentity.groups | Sort-Object) -join ',') -ne '2100' -or
        ($serverIdentity.uid_map -join ' ') -ne '0 0 4294967295' -or
        ($serverIdentity.gid_map -join ' ') -ne '0 0 4294967295') {
        throw 'Unexpected implementation broker identity or namespace map.'
    }
    $cases = @(
        @('foreign', 'python', '1103:2100'),
        @('foreign', 'node', '1103:2100'),
        @('wrong-gid', 'python', '1102:2101'),
        @('inventory', 'python', '1102:2100'),
        @('generation', 'node', '1102:2100'),
        @('inventory', 'node', '1102:2100')
    )
    foreach ($case in $cases) {
        $name = "$owner-$($case[0])-$($case[1])"
        $names.Add($name)
        $groups = @()
        if ($case[0] -eq 'wrong-gid') { $groups = @('--group-add', '2100') }
        $output = & docker run --name $name --label $label @common --user $case[2] @groups `
            --mount "type=volume,source=$volume,target=/socket,readonly" @mounts `
            --entrypoint python3 $image -I -B /proof-test.py container-client $case[0] $case[1]
        if ($LASTEXITCODE -ne 0) { throw "Implementation client failed: $case" }
        $clientEvents = @($output | ForEach-Object { $_ | ConvertFrom-Json })
        if ($clientEvents.Count -ne 2 -or -not $clientEvents[-1].complete -or
            $clientEvents[-1].mode -ne $case[0] -or $clientEvents[-1].runtime -ne $case[1]) {
            throw "Missing implementation client completion: $case"
        }
        $identity = $clientEvents[0].identity
        $expectedIds = $case[2].Split(':')
        $expectedGroups = if ($case[0] -eq 'wrong-gid') { @(2100, 2101) } else { @([int]$expectedIds[1]) }
        if ($identity.uid -ne [int]$expectedIds[0] -or $identity.gid -ne [int]$expectedIds[1] -or
            (@($identity.groups | Sort-Object) -join ',') -ne ($expectedGroups -join ',') -or
            ($identity.uid_map -join ' ') -ne ($serverIdentity.uid_map -join ' ') -or
            ($identity.gid_map -join ' ') -ne ($serverIdentity.gid_map -join ' ') -or
            $identity.user -ne $serverIdentity.user -or $identity.pid -eq $serverIdentity.pid -or
            $identity.mnt -eq $serverIdentity.mnt) {
            throw "Unexpected implementation client identity/namespace topology: $case"
        }
    }
    & docker kill --signal USR1 $server
    if ($LASTEXITCODE -ne 0) { throw 'Could not request implementation broker clean stop.' }
    $exitCode = & docker wait $server
    if ($LASTEXITCODE -ne 0 -or "$exitCode" -ne '0') { throw 'Implementation broker clean stop failed.' }
    $events = @((& docker logs $server 2>&1) | ForEach-Object { "$_" | ConvertFrom-Json })
    if ($LASTEXITCODE -ne 0 -or $events.Count -ne 6 -or -not $events[-1].complete -or
        $events[-1].sourceCalls -ne 3 -or $events[-1].peerDenials -ne 3) {
        throw 'Unexpected implementation broker final evidence.'
    }
    $denials = @($events | Where-Object { $_.diagnostic } | ForEach-Object { $_.diagnostic })
    if ($denials.Count -ne 3 -or $denials[0] -ne 'Broker peer denied: pid=0 uid=1103 gid=2100' -or
        $denials[1] -ne $denials[0] -or $denials[2] -ne 'Broker peer denied: pid=0 uid=1102 gid=2101') {
        throw 'Missing exact cross-namespace kernel denial evidence.'
    }
    Write-Output 'PASS implementation separate containers: capability-free broker, mapped UID/primary-GID denial, distinct PID/mount namespaces, Python/Node exact readback, clean shutdown and socket removal.'
} finally {
    $errors = [System.Collections.Generic.List[string]]::new()
    foreach ($name in $names) {
        $owned = & docker container ls -aq --filter "name=^/$name$" --filter "label=$label"
        if ($LASTEXITCODE -ne 0) { $errors.Add("Could not inspect owned container: $name"); continue }
        if ($owned) {
            & docker container rm -f $owned
            if ($LASTEXITCODE -ne 0) { $errors.Add("Could not remove owned container: $name") }
        }
    }
    $ownedVolume = & docker volume ls -q --filter "name=^$volume$" --filter "label=$label"
    if ($LASTEXITCODE -ne 0) { $errors.Add('Could not inspect owned implementation volume.') }
    if ($ownedVolume -and $errors.Count -eq 0) {
        & docker volume rm $ownedVolume
        if ($LASTEXITCODE -ne 0) { $errors.Add('Could not remove owned implementation volume.') }
    }
    if ($errors.Count -gt 0) { throw ($errors -join '; ') }
}
