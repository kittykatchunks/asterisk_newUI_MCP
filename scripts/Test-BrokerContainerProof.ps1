[CmdletBinding()]
param([switch]$NodeClients)
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
function Invoke-Client([string]$Mode, [string]$User, [string[]]$Extra = @(), [switch]$Writable, [switch]$Detached) {
    $name = "$owner-$($Mode.Replace(':', '-'))"
    $names.Add($name)
    $access = if ($Writable) { '' } else { ',readonly' }
    $clientMounts = @()
    $clientArguments = @()
    $nodeLifecycle = $NodeClients -and ($Mode.StartsWith('admission-') -or $Mode -in @('crash-wait', 'stale-refused', 'restart-read'))
    if ($NodeClients -and ($Mode.StartsWith('corpus-') -or $nodeLifecycle)) {
        $clientMounts = @(
            '--mount', "type=bind,source=$(Join-Path $root 'tests\identity\broker-cross-client.ts'),target=/tests/identity/broker-cross-client.ts,readonly",
            '--mount', "type=bind,source=$(Join-Path $root 'src\agent-broker-frame.ts'),target=/src/agent-broker-frame.ts,readonly"
        )
        $clientArguments = @('node-client')
    }
    [string[]]$runOptions = @(if ($Detached) { '-d' })
    $output = & docker run @runOptions --name $name --label $label @common --user $User @Extra `
        --mount "type=volume,source=$volume,target=/socket$access" @mounts @clientMounts `
        --entrypoint python3 $image -I -B /container-proof.py $Mode @clientArguments
    if ($LASTEXITCODE -ne 0) { throw "Separate-container client failed: $Mode" }
    if ($Detached) { return $output }
    $events = @($output | ForEach-Object { $_ | ConvertFrom-Json })
    if ($Mode.StartsWith('corpus-')) {
        $expectedRuntime = if ($NodeClients) { 'node' } else { 'python' }
        if ($events[-1].clientRuntime -ne $expectedRuntime -or
            $events[-1].corpusCase -ne $Mode.Substring(7)) { throw "Unexpected corpus client completion: $Mode" }
    }
    if ($nodeLifecycle -or $Mode.StartsWith('admission-')) {
        $expectedRuntime = if ($NodeClients) { 'node' } else { 'python' }
        if ($events[-1].clientRuntime -ne $expectedRuntime -or $events[-1].lifecycleCase -ne $Mode) {
            throw "Unexpected lifecycle completion: $Mode"
        }
    }
    $identities.Add($events[0].identity)
    Write-Output $output
}
function Start-TestBroker([string]$Mode) {
    $name = "$owner-$Mode"
    $names.Add($name)
    $id = & docker run -d --name $name --label $label @common --user '1101:2100' `
        --mount "type=volume,source=$volume,target=/socket" @mounts `
        --entrypoint python3 $image -I -B /container-proof.py $Mode
    if ($LASTEXITCODE -ne 0) { throw "Could not start broker: $Mode" }
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $logs = @(& docker logs $id 2>&1)
        if ($LASTEXITCODE -ne 0) { throw "Could not read broker logs: $Mode" }
        if ($logs -contains '{"ready": true}' -or $logs -contains '{"event": "ready"}') { return $id }
        $running = & docker inspect --format '{{.State.Running}}' $id
        if ($LASTEXITCODE -ne 0 -or $running -ne 'true') { throw "Broker stopped before readiness: $logs" }
        Start-Sleep -Milliseconds 250
    }
    throw "Broker readiness deadline exceeded: $Mode"
}
function Wait-AdmissionEvent([string]$Id, [string]$Event) {
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $logs = @(& docker logs $Id 2>&1)
        if ($LASTEXITCODE -ne 0) { throw 'Could not read admission broker events.' }
        if ($logs -contains "{`"event`": `"$Event`"}") { return }
        $running = & docker inspect --format '{{.State.Running}}' $Id
        if ($LASTEXITCODE -ne 0 -or $running -ne 'true') { throw "Admission broker stopped before ${Event}: $logs" }
        Start-Sleep -Milliseconds 250
    }
    throw "Admission event deadline exceeded: $Event"
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
    foreach ($mode in @('conflict-file', 'conflict-symlink')) {
        $name = "$owner-$mode"
        $names.Add($name)
        $output = & docker run --name $name --label $label @common --user '1101:2100' `
            --mount "type=volume,source=$volume,target=/socket" @mounts `
            --entrypoint python3 $image -I -B /container-proof.py $mode
        if ($LASTEXITCODE -ne 0) { throw "Publication conflict proof failed: $mode" }
        $conflictEvents = @($output | ForEach-Object { $_ | ConvertFrom-Json })
        if ($conflictEvents[-1].conflictPreserved -ne $mode) { throw "Missing conflict preservation evidence: $mode" }
        Write-Output $output
    }
    Write-Output 'PASS conflicting publication: regular file and symlink block startup without readiness, path replacement or target changes.'
    $crashed = Start-TestBroker 'server-crash'
    $crashEvents = @((& docker logs $crashed) | ForEach-Object { $_ | ConvertFrom-Json })
    if ($LASTEXITCODE -ne 0) { throw 'Could not capture published crash socket identity.' }
    $published = @($crashEvents | Where-Object { $_.published })
    if ($published.Count -ne 1) { throw 'Expected exactly one recorded socket identity.' }
    Invoke-Client 'crash-wait' '1102:2100'
    $crashExit = & docker wait $crashed
    if ($LASTEXITCODE -ne 0 -or "$crashExit" -ne '23') { throw 'Expected controlled broker exit 23.' }
    $state = & docker inspect --format '{{json .State}}' $crashed
    if ($LASTEXITCODE -ne 0 -or ($state | ConvertFrom-Json).Running) { throw 'Old broker must be stopped before cleanup.' }
    $crashEvents = @((& docker logs $crashed) | ForEach-Object { $_ | ConvertFrom-Json })
    if ($LASTEXITCODE -ne 0 -or -not $crashEvents[-1].crashingBeforeSource -or $crashEvents[-1].sourceEntries -ne 0) {
        throw 'Crash did not occur before source entry.'
    }
    $crashPeers = @($crashEvents | Where-Object { $_.peer })
    if ($crashPeers.Count -ne 1 -or -not $crashPeers[0].allowed) { throw 'Missing original authenticated crash connection.' }
    Invoke-Client 'stale-refused' '1102:2100'
    $blocked = "$owner-stale-startup"
    $names.Add($blocked)
    $blockedOutput = @(& docker run --name $blocked --label $label @common --user '1101:2100' `
        --mount "type=volume,source=$volume,target=/socket" @mounts `
        --entrypoint python3 $image -I -B /container-proof.py server 2>&1)
    if ($LASTEXITCODE -eq 0 -or "$blockedOutput" -notmatch 'Address already in use' -or
        $blockedOutput -contains '{"ready": true}') { throw "Stale startup did not fail closed: $blockedOutput" }
    $wrongCleanup = "$owner-wrong-inode"
    $names.Add($wrongCleanup)
    $wrongOutput = @(& docker run --name $wrongCleanup --label $label @common --user '1101:2100' `
        --mount "type=volume,source=$volume,target=/socket" @mounts `
        --entrypoint python3 $image -I -B /container-proof.py remove-stale `
        $published[0].published.device 0 2>&1)
    if ($LASTEXITCODE -eq 0 -or "$wrongOutput" -notmatch 'Stale socket identity mismatch' -or
        "$wrongOutput" -match '"staleRemoved": true') { throw 'Wrong-inode cleanup was not rejected.' }
    $cleanup = "$owner-stale-cleanup"
    $names.Add($cleanup)
    $removed = @(& docker run --name $cleanup --label $label @common --user '1101:2100' `
        --mount "type=volume,source=$volume,target=/socket" @mounts `
        --entrypoint python3 $image -I -B /container-proof.py remove-stale `
        $published[0].published.device $published[0].published.inode)
    if ($LASTEXITCODE -ne 0 -or -not ($removed[-1] | ConvertFrom-Json).staleRemoved) {
        throw 'Verified parent-authorised stale cleanup failed.'
    }
    Write-Output $removed
    $restarted = Start-TestBroker 'server-restarted'
    Invoke-Client 'restart-read' '1102:2100'
    $restartExit = & docker wait $restarted
    if ($LASTEXITCODE -ne 0 -or "$restartExit" -ne '0') { throw 'Explicitly restarted broker failed.' }
    $restartEvents = @((& docker logs $restarted) | ForEach-Object { $_ | ConvertFrom-Json })
    if ($LASTEXITCODE -ne 0 -or -not $restartEvents[-1].complete -or
        $restartEvents[-1].sourceEntries -ne 1 -or $restartEvents[-1].deniedBeforeRead -ne 0) {
        throw 'Restarted broker did not serve exactly one fresh read.'
    }
    $restartPeers = @($restartEvents | Where-Object { $_.peer })
    if ($restartPeers.Count -ne 1 -or -not $restartPeers[0].allowed -or
        $restartPeers[0].peer.uid -ne 1102 -or $restartPeers[0].peer.gid -ne 2100) {
        throw 'Fresh connection was not reauthenticated after restart.'
    }
    Write-Output 'PASS explicit crash/restart: old connection closes without response, stale connect/startup fail, recorded inode removed only after exit, fresh authenticated read succeeds without replay.'
    $corpus = Start-TestBroker 'server-corpus'
    $vectors = Get-Content -Raw (Join-Path $root 'tests\identity\broker-conformance.json') | ConvertFrom-Json
    $corpusModes = @('foreign') + @(0..($vectors.cases.Count - 1) | ForEach-Object { "$_" }) +
        @(0..($vectors.sourceCases.Count - 1) | ForEach-Object { "source:$_" }) + @('reconnect')
    foreach ($mode in $corpusModes) {
        $user = if ($mode -eq 'foreign') { '1103:2100' } else { '1102:2100' }
        Invoke-Client "corpus-$mode" $user
        $identity = $identities[-1]
        $corpusLogs = @(& docker logs $corpus)
        if ($LASTEXITCODE -ne 0) { throw 'Could not read corpus broker identity.' }
        $corpusIdentity = ($corpusLogs[0] | ConvertFrom-Json).identity
        if ($identity.uid_map -ne $corpusIdentity.uid_map -or $identity.gid_map -ne $corpusIdentity.gid_map -or
            $identity.userNamespace -ne $corpusIdentity.userNamespace -or
            $identity.pidNamespace -eq $corpusIdentity.pidNamespace -or
            $identity.mntNamespace -eq $corpusIdentity.mntNamespace) {
            throw 'Corpus client namespace topology differs from approved mapping/separation.'
        }
    }
    $corpusExit = & docker wait $corpus
    if ($LASTEXITCODE -ne 0 -or "$corpusExit" -ne '0') { throw 'Separate-container corpus broker failed.' }
    $corpusEvents = @((& docker logs $corpus) | ForEach-Object { $_ | ConvertFrom-Json })
    if ($LASTEXITCODE -ne 0) { throw 'Could not read final corpus evidence.' }
    $requestsAccepted = @($vectors.cases | Where-Object { $null -ne $_.expected }).Count
    $sourcesAccepted = @($vectors.sourceCases | Where-Object { $_.valid }).Count
    $expectedRejected = $vectors.cases.Count + $vectors.sourceCases.Count - $requestsAccepted - $sourcesAccepted
    $result = $corpusEvents[-1]
    if ($result.reads -ne ($requestsAccepted + $sourcesAccepted + 1) -or
        $result.sourceEntries -ne ($requestsAccepted + $vectors.sourceCases.Count + 1) -or
        $result.rejected -ne $expectedRejected -or $result.denied -ne 1) {
        throw 'Separate-container corpus counters did not match the shared vectors.'
    }
    $corpusPeers = @($corpusEvents | Where-Object { $_.peer })
    if ($corpusPeers.Count -ne $corpusModes.Count) { throw 'Missing per-connection kernel peer evidence.' }
    for ($index = 0; $index -lt $corpusPeers.Count; $index++) {
        $expectedUid = if ($index -eq 0) { 1103 } else { 1102 }
        if ($corpusPeers[$index].peer.uid -ne $expectedUid -or $corpusPeers[$index].peer.gid -ne 2100) {
            throw 'Unexpected kernel identity in corpus connection.'
        }
    }
    $runtime = if ($NodeClients) { 'Node/TypeScript' } else { 'Python' }
    Write-Output "PASS separate-container corpus ($runtime clients): $($vectors.cases.Count) framing/request and $($vectors.sourceCases.Count) source-output cases, foreign denial, per-case source assertions and approved reconnect."
    $admission = Start-TestBroker 'server-admission'
    $idle = Invoke-Client 'admission-idle' '1102:2100' -Detached
    Wait-AdmissionEvent $admission 'admitted'
    Invoke-Client 'admission-capacity' '1102:2100'
    Wait-AdmissionEvent $admission 'capacity'
    Wait-AdmissionEvent $admission 'timeout'
    Wait-AdmissionEvent $admission 'released'
    $idleExit = & docker wait $idle
    if ($LASTEXITCODE -ne 0 -or "$idleExit" -ne '0') { throw 'Idle admission client did not observe clean deadline EOF.' }
    $idleEvents = @((& docker logs $idle) | ForEach-Object { $_ | ConvertFrom-Json })
    if ($LASTEXITCODE -ne 0 -or $idleEvents[-1].lifecycleCase -ne 'admission-idle' -or
        $idleEvents[-1].clientRuntime -ne $(if ($NodeClients) { 'node' } else { 'python' })) {
        throw 'Missing idle admission client runtime completion.'
    }
    $identities.Add($idleEvents[0].identity)
    Invoke-Client 'admission-reconnect' '1102:2100'
    $admissionExit = & docker wait $admission
    if ($LASTEXITCODE -ne 0 -or "$admissionExit" -ne '0') { throw 'Separate-container admission broker failed.' }
    $admissionEvents = @((& docker logs $admission) | ForEach-Object { $_ | ConvertFrom-Json })
    if ($LASTEXITCODE -ne 0 -or $admissionEvents[-1].event -ne 'complete') { throw 'Missing admission completion.' }
    $admissionIdentity = $admissionEvents[0].identity
    foreach ($identity in @($identities | Select-Object -Last 3)) {
        if ($identity.uid_map -ne $admissionIdentity.uid_map -or $identity.gid_map -ne $admissionIdentity.gid_map -or
            $identity.userNamespace -ne $admissionIdentity.userNamespace -or
            $identity.pidNamespace -eq $admissionIdentity.pidNamespace -or
            $identity.mntNamespace -eq $admissionIdentity.mntNamespace) {
            throw 'Admission client namespace topology differs from approved separation.'
        }
    }
    $admissionPeers = @($admissionEvents | Where-Object { $_.peer })
    if ($admissionPeers.Count -ne 3 -or @($admissionPeers | Where-Object {
        $_.peer.uid -ne 1102 -or $_.peer.gid -ne 2100
    }).Count -ne 0) { throw 'Missing exact authenticated admission peer evidence.' }
    $admissionCounts = @($admissionEvents | Where-Object { $_.admissionCounts })
    if ($admissionCounts.Count -ne 1 -or $admissionCounts[0].admissionCounts.reads -ne 1 -or
        $admissionCounts[0].admissionCounts.capacity -ne 1 -or $admissionCounts[0].admissionCounts.timeouts -ne 1 -or
        $admissionCounts[0].admissionCounts.requestTimeouts -ne 1) { throw 'Unexpected admission source/deadline counters.' }
    $admissionTimeouts = @($admissionEvents | Where-Object { $_.admissionTimeout })
    if ($admissionTimeouts.Count -ne 1 -or $admissionTimeouts[0].admissionTimeout.elapsedSeconds -lt 5 -or
        $admissionTimeouts[0].admissionTimeout.elapsedSeconds -ge 8 -or
        $admissionTimeouts[0].admissionTimeout.sourceEntries -ne 0) {
        throw 'Idle deadline was outside the measured five-to-eight-second budget or entered a source.'
    }
    $admissionEvents | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 5 }
    Write-Output "PASS separate-container admission ($runtime clients): idle slot excludes competitor, five-second deadline closes without response/source entry, fresh authenticated read succeeds."
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
