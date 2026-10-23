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
function Wait-AdmissionEvent([string]$Id, [string]$Event, [int]$Count = 1) {
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $logs = @(& docker logs $Id 2>&1)
        if ($LASTEXITCODE -ne 0) { throw 'Could not read admission broker events.' }
        if (@($logs | Where-Object { $_ -eq "{`"event`": `"$Event`"}" }).Count -ge $Count) { return }
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
    $noEof = Invoke-Client 'admission-no-eof' '1102:2100' -Detached
    Wait-AdmissionEvent $admission 'admitted' 2
    Wait-AdmissionEvent $admission 'request-body-received'
    Invoke-Client 'admission-capacity-no-eof' '1102:2100'
    Wait-AdmissionEvent $admission 'capacity' 2
    Wait-AdmissionEvent $admission 'timeout' 2
    Wait-AdmissionEvent $admission 'released' 2
    $noEofExit = & docker wait $noEof
    if ($LASTEXITCODE -ne 0 -or "$noEofExit" -ne '0') { throw 'Missing-EOF client did not observe clean deadline EOF.' }
    $noEofEvents = @((& docker logs $noEof) | ForEach-Object { $_ | ConvertFrom-Json })
    if ($LASTEXITCODE -ne 0 -or $noEofEvents[-1].lifecycleCase -ne 'admission-no-eof' -or
        $noEofEvents[-1].clientRuntime -ne $(if ($NodeClients) { 'node' } else { 'python' })) {
        throw 'Missing no-EOF admission client runtime completion.'
    }
    $identities.Add($noEofEvents[0].identity)
    Invoke-Client 'admission-failed-source' '1102:2100'
    Wait-AdmissionEvent $admission 'source-failed'
    Wait-AdmissionEvent $admission 'released' 3
    Invoke-Client 'admission-reconnect' '1102:2100'
    Wait-AdmissionEvent $admission 'released' 4
    Invoke-Client 'admission-failed-generation' '1102:2100'
    Wait-AdmissionEvent $admission 'source-failed' 2
    Wait-AdmissionEvent $admission 'released' 5
    Invoke-Client 'admission-generation-reconnect' '1102:2100'
    Wait-AdmissionEvent $admission 'released' 6
    $held = Invoke-Client 'admission-held-source' '1102:2100' -Detached
    Wait-AdmissionEvent $admission 'source-entered'
    Invoke-Client 'admission-capacity-held' '1102:2100'
    Wait-AdmissionEvent $admission 'capacity' 3
    Wait-AdmissionEvent $admission 'timeout' 3
    $heldExit = & docker wait $held
    if ($LASTEXITCODE -ne 0 -or "$heldExit" -ne '0') { throw 'Held-source client did not observe deadline EOF without bytes.' }
    $heldEvents = @((& docker logs $held) | ForEach-Object { $_ | ConvertFrom-Json })
    if ($LASTEXITCODE -ne 0 -or $heldEvents[-1].lifecycleCase -ne 'admission-held-source' -or
        $heldEvents[-1].clientRuntime -ne $(if ($NodeClients) { 'node' } else { 'python' })) {
        throw 'Missing held-source client runtime completion.'
    }
    $identities.Add($heldEvents[0].identity)
    & docker kill --signal USR2 $admission
    if ($LASTEXITCODE -ne 0) { throw 'Could not deliver test-only cancellation after timeout.' }
    Wait-AdmissionEvent $admission 'late-cancellation-observed'
    Invoke-Client 'admission-capacity-expired' '1102:2100'
    Wait-AdmissionEvent $admission 'capacity' 4
    & docker kill --signal USR1 $admission
    if ($LASTEXITCODE -ne 0) { throw 'Could not deliver test-only parent source-release signal.' }
    Wait-AdmissionEvent $admission 'source-settled'
    Wait-AdmissionEvent $admission 'released' 7
    Invoke-Client 'admission-held-reconnect' '1102:2100'
    Wait-AdmissionEvent $admission 'released' 8
    $cancelled = Invoke-Client 'admission-cancel-held' '1102:2100' -Detached
    Wait-AdmissionEvent $admission 'source-entered' 2
    $cancelWatch = [System.Diagnostics.Stopwatch]::StartNew()
    & docker kill --signal USR2 $admission
    if ($LASTEXITCODE -ne 0) { throw 'Could not deliver test-only parent cancellation signal.' }
    $cancelExit = & docker wait $cancelled
    $cancelWatch.Stop()
    if ($LASTEXITCODE -ne 0 -or "$cancelExit" -ne '0' -or $cancelWatch.Elapsed.TotalSeconds -ge 3) {
        throw 'Cancellation must close the held client without bytes within three seconds.'
    }
    $cancelEvents = @((& docker logs $cancelled) | ForEach-Object { $_ | ConvertFrom-Json })
    if ($LASTEXITCODE -ne 0 -or $cancelEvents[-1].lifecycleCase -ne 'admission-cancel-held' -or
        $cancelEvents[-1].clientRuntime -ne $(if ($NodeClients) { 'node' } else { 'python' })) {
        throw 'Missing cancelled client runtime completion.'
    }
    $identities.Add($cancelEvents[0].identity)
    Wait-AdmissionEvent $admission 'cancelled'
    Invoke-Client 'admission-capacity-cancelled' '1102:2100'
    Wait-AdmissionEvent $admission 'capacity' 5
    & docker kill --signal USR2 $admission
    if ($LASTEXITCODE -ne 0) { throw 'Could not deliver test-only repeated cancellation.' }
    Wait-AdmissionEvent $admission 'repeated-cancellation-observed'
    Wait-AdmissionEvent $admission 'cancelled-deadline-observed'
    Invoke-Client 'admission-capacity-cancel-deadline' '1102:2100'
    Wait-AdmissionEvent $admission 'capacity' 6
    & docker kill --signal USR1 $admission
    if ($LASTEXITCODE -ne 0) { throw 'Could not release cancelled fixture source.' }
    Wait-AdmissionEvent $admission 'source-settled' 2
    Wait-AdmissionEvent $admission 'released' 9
    Invoke-Client 'admission-cancel-reconnect' '1102:2100'
    $admissionExit = & docker wait $admission
    if ($LASTEXITCODE -ne 0 -or "$admissionExit" -ne '0') { throw 'Separate-container admission broker failed.' }
    $admissionLogs = @(& docker logs $admission 2>&1 | ForEach-Object { "$_" })
    if ($LASTEXITCODE -ne 0) { throw 'Could not read admission evidence.' }
    $diagnostics = @('Fixture source unavailable', 'Fixture generation source unavailable')
    foreach ($diagnostic in $diagnostics) {
        if (@($admissionLogs | Where-Object { $_ -eq $diagnostic }).Count -ne 1) {
            throw "Missing exact single source-failure diagnostic: $diagnostic"
        }
    }
    $admissionEvents = @($admissionLogs | Where-Object { $_ -notin $diagnostics } |
        ForEach-Object { $_ | ConvertFrom-Json })
    if ($admissionEvents[-1].event -ne 'complete') { throw 'Missing admission completion.' }
    $admissionIdentity = $admissionEvents[0].identity
    foreach ($identity in @($identities | Select-Object -Last 16)) {
        if ($identity.uid_map -ne $admissionIdentity.uid_map -or $identity.gid_map -ne $admissionIdentity.gid_map -or
            $identity.userNamespace -ne $admissionIdentity.userNamespace -or
            $identity.pidNamespace -eq $admissionIdentity.pidNamespace -or
            $identity.mntNamespace -eq $admissionIdentity.mntNamespace) {
            throw 'Admission client namespace topology differs from approved separation.'
        }
    }
    $admissionPeers = @($admissionEvents | Where-Object { $_.peer })
    if ($admissionPeers.Count -ne 16 -or @($admissionPeers | Where-Object {
        $_.peer.uid -ne 1102 -or $_.peer.gid -ne 2100
    }).Count -ne 0) { throw 'Missing exact authenticated admission peer evidence.' }
    $admissionCounts = @($admissionEvents | Where-Object { $_.admissionCounts })
    if ($admissionCounts.Count -ne 1 -or $admissionCounts[0].admissionCounts.reads -ne 8 -or
        $admissionCounts[0].admissionCounts.generationReads -ne 2 -or
        $admissionCounts[0].admissionCounts.capacity -ne 6 -or $admissionCounts[0].admissionCounts.timeouts -ne 3 -or
        $admissionCounts[0].admissionCounts.requestTimeouts -ne 2 -or
        $admissionCounts[0].admissionCounts.sourceFailures -ne 2 -or
        $admissionCounts[0].admissionCounts.cancellations -ne 1) { throw 'Unexpected admission source/deadline counters.' }
    $sourceFailures = @($admissionEvents | Where-Object { $_.admissionSourceFailure })
    if ($sourceFailures.Count -ne 2 -or $sourceFailures[0].admissionSourceFailure.sourceEntries -ne 1 -or
        $sourceFailures[0].admissionSourceFailure.generationReads -ne 0 -or
        $sourceFailures[0].admissionSourceFailure.timeouts -ne 2 -or
        $sourceFailures[1].admissionSourceFailure.sourceEntries -ne 3 -or
        $sourceFailures[1].admissionSourceFailure.generationReads -ne 1 -or
        $sourceFailures[1].admissionSourceFailure.timeouts -ne 2) {
        throw 'Inventory/generation source exceptions did not match the exact source-entry sequence.'
    }
    $admissionTimeouts = @($admissionEvents | Where-Object { $_.admissionTimeout })
    if ($admissionTimeouts.Count -ne 3 -or $admissionTimeouts[0].admissionTimeout.bodyReceived -ne $false -or
        $admissionTimeouts[1].admissionTimeout.bodyReceived -ne $true -or
        $admissionTimeouts[2].admissionTimeout.bodyReceived -ne $true) {
        throw 'Expected idle, complete-body/missing-EOF and held-source timeouts.'
    }
    for ($index = 0; $index -lt $admissionTimeouts.Count; $index++) {
        $timeout = $admissionTimeouts[$index]
        $expectedEntries = if ($index -eq 2) { 5 } else { 0 }
        if ($timeout.admissionTimeout.elapsedSeconds -lt 5 -or $timeout.admissionTimeout.elapsedSeconds -ge 8 -or
            $timeout.admissionTimeout.sourceEntries -ne $expectedEntries) {
            throw 'Deadline was outside the measured five-to-eight-second budget or had unexpected source entries.'
        }
    }
    $heldCapacity = @($admissionEvents | Where-Object { $_.heldCapacity })
    if ($heldCapacity.Count -ne 4 -or $heldCapacity[0].heldCapacity.timeouts -ne 2 -or
        $heldCapacity[1].heldCapacity.timeouts -ne 3 -or @($heldCapacity | Select-Object -First 2 | Where-Object {
            $_.heldCapacity.sourceEntries -ne 5 -or $_.heldCapacity.slotLocked -ne $true
        }).Count -ne 0) { throw 'Held source did not retain the slot before and after connection timeout.' }
    if (@($heldCapacity | Select-Object -Last 2 | Where-Object {
        $_.heldCapacity.sourceEntries -ne 7 -or $_.heldCapacity.timeouts -ne 3 -or
        $_.heldCapacity.cancellations -ne 1 -or $_.heldCapacity.slotLocked -ne $true
    }).Count -ne 0) {
        throw 'Cancelled source did not retain the admission slot without an extra timeout/source entry.'
    }
    $cancelledDeadlines = @($admissionEvents | Where-Object { $_.cancelledDeadline })
    if ($cancelledDeadlines.Count -ne 1 -or $cancelledDeadlines[0].cancelledDeadline.elapsedSeconds -lt 5 -or
        $cancelledDeadlines[0].cancelledDeadline.elapsedSeconds -ge 8 -or
        $cancelledDeadlines[0].cancelledDeadline.sourceEntries -ne 7 -or
        $cancelledDeadlines[0].cancelledDeadline.timeouts -ne 3 -or
        $cancelledDeadlines[0].cancelledDeadline.cancellations -ne 1 -or
        $cancelledDeadlines[0].cancelledDeadline.slotLocked -ne $true) {
        throw 'Original deadline after cancellation changed terminal state or released admission.'
    }
    $lateCancellations = @($admissionEvents | Where-Object { $_.lateCancellation })
    $repeatedCancellations = @($admissionEvents | Where-Object { $_.repeatedCancellation })
    if ($repeatedCancellations.Count -ne 1 -or $repeatedCancellations[0].repeatedCancellation.sourceEntries -ne 7 -or
        $repeatedCancellations[0].repeatedCancellation.timeouts -ne 3 -or
        $repeatedCancellations[0].repeatedCancellation.cancellations -ne 1 -or
        $repeatedCancellations[0].repeatedCancellation.slotLocked -ne $true) {
        throw 'Repeated cancellation changed the original cancellation outcome or released admission.'
    }
    if ($lateCancellations.Count -ne 1 -or $lateCancellations[0].lateCancellation.sourceEntries -ne 5 -or
        $lateCancellations[0].lateCancellation.timeouts -ne 3 -or
        $lateCancellations[0].lateCancellation.cancellations -ne 0 -or
        $lateCancellations[0].lateCancellation.slotLocked -ne $true -or
        @($admissionEvents | Where-Object { $_.event -eq 'timeout' }).Count -ne 3 -or
        @($admissionEvents | Where-Object { $_.event -eq 'cancelled' }).Count -ne 1 -or
        @($admissionEvents | Where-Object { $_.event -eq 'released' }).Count -ne 10) {
        throw 'Late cancellation changed the original timeout outcome or terminal/release event counts.'
    }
    $deliveries = @($admissionEvents | Where-Object { $_.delivery })
    $expectedSources = @(0, 0, 1, 2, 3, 4, 5, 6, 7, 8)
    $expectedAttempts = @(0, 0, 0, 1, 0, 1, 0, 1, 0, 1)
    if ($deliveries.Count -ne $expectedSources.Count) { throw 'Missing per-admission delivery evidence.' }
    for ($index = 0; $index -lt $deliveries.Count; $index++) {
        $delivery = $deliveries[$index].delivery
        $discarded = $index -in @(6, 8)
        $terminal = $index -in @(0, 1, 6, 8)
        if ($delivery.sourceEntries -ne $expectedSources[$index] -or
            $delivery.responseAttempts -ne $expectedAttempts[$index] -or
            $delivery.resultDiscarded -ne $discarded -or $delivery.terminal -ne $terminal -or
            $delivery.slotLocked -ne $true) {
            throw "Unexpected response delivery or terminal state at admission $index"
        }
        if ($index -ge 6 -and $delivery.inventoryNotAfter -ne
            ($vectors.generation.notAfter + $expectedSources[$index])) {
            throw "Recovery inventory did not distinguish fresh and discarded source results at admission $index"
        }
    }
    for ($index = 0; $index -lt $admissionEvents.Count; $index++) {
        if ($admissionEvents[$index].delivery.resultDiscarded -eq $true -and
            ($index -eq 0 -or $index -eq ($admissionEvents.Count - 1) -or
             $admissionEvents[$index - 1].event -ne 'source-settled' -or
             $admissionEvents[$index + 1].event -ne 'released')) {
            throw 'Late source result must be discarded after settlement and before admission release.'
        }
    }
    $admissionEvents | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 5 }
    Write-Output "PASS separate-container admission ($runtime clients): idle and complete-body/missing-EOF slots exclude competitors, five-second deadlines close without response/source entry, fresh authenticated read succeeds."
    Write-Output "PASS separate-container source failure ($runtime clients): exact diagnostic, zero response bytes, slot released, fresh authenticated read succeeds."
    Write-Output "PASS separate-container generation failure ($runtime clients): exact diagnostic, zero response bytes rather than missing, slot released, fresh observed generation succeeds."
    Write-Output "PASS separate-container held source ($runtime clients): deadline EOF, competitors rejected before/after timeout, slot retained until parent release and source settlement, fresh read succeeds."
    Write-Output "PASS separate-container cancellation ($runtime clients): zero-byte EOF in $($cancelWatch.Elapsed.TotalSeconds.ToString('F3')) seconds, slot retained until source settlement, fresh read succeeds."
    Write-Output "PASS cancelled deadline ($runtime clients): original five-second timer observes one cancellation without another timeout, competitor remains excluded until source settlement."
    Write-Output "PASS cancellation after timeout ($runtime clients): original timeout retained without a cancellation outcome or early slot release; competitor excluded until source settlement."
    Write-Output "PASS repeated cancellation ($runtime clients): one cancellation outcome, no extra timeout/source entry or early slot release, fresh read succeeds after settlement."
    Write-Output "PASS terminal delivery ($runtime clients): both late source results discarded without a send attempt before slot release; only four fresh successful reads attempt responses."
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
