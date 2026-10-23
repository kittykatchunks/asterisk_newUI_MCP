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
function Invoke-Client([string]$Mode, [string]$User, [string[]]$Extra = @(), [switch]$Writable, [switch]$Detached, [string]$Instance = '') {
    $name = "$owner-$($Mode.Replace(':', '-'))$Instance"
    $names.Add($name)
    $access = if ($Writable) { '' } else { ',readonly' }
    $clientMounts = @()
    $clientArguments = @()
    $nodeLifecycle = $NodeClients -and ($Mode.StartsWith('admission-') -or $Mode.StartsWith('disconnect-') -or $Mode.StartsWith('half-close-') -or $Mode.StartsWith('race-') -or $Mode.StartsWith('completion-') -or $Mode.StartsWith('peer-') -or $Mode.StartsWith('writer-') -or $Mode -in @('crash-wait', 'stale-refused', 'restart-read'))
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
    if ($nodeLifecycle -or $Mode.StartsWith('admission-') -or $Mode.StartsWith('disconnect-') -or $Mode.StartsWith('half-close-') -or $Mode.StartsWith('race-') -or $Mode.StartsWith('completion-') -or $Mode.StartsWith('peer-') -or $Mode.StartsWith('writer-')) {
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
    $disconnect = Start-TestBroker 'server-disconnect'
    $disconnectModes = @('disconnect-empty', 'disconnect-header-1', 'disconnect-header-2',
        'disconnect-header-3', 'disconnect-header-only', 'disconnect-partial',
        'disconnect-body-last', 'disconnect-limit-last')
    $expectedDisconnectBytes = @(0, 1, 2, 3, 4, 7,
        ([System.Text.Encoding]::UTF8.GetByteCount($vectors.cases[0].text) + 3), 8195)
    $disconnectModes += @($disconnectModes | ForEach-Object { $_.Replace('disconnect-', 'half-close-') })
    $expectedDisconnectBytes += $expectedDisconnectBytes
    for ($index = 0; $index -lt $disconnectModes.Count; $index++) {
        Invoke-Client $disconnectModes[$index] '1102:2100'
        Invoke-Client "disconnect-reconnect-$($index + 1)" '1102:2100'
    }
    $disconnectExit = & docker wait $disconnect
    if ($LASTEXITCODE -ne 0 -or "$disconnectExit" -ne '0') { throw 'Request-disconnect broker failed.' }
    $disconnectEvents = @((& docker logs $disconnect 2>&1) | ForEach-Object { "$_" | ConvertFrom-Json })
    if ($LASTEXITCODE -ne 0 -or -not $disconnectEvents[-1].complete) { throw 'Missing disconnect completion.' }
    $disconnectIdentity = $disconnectEvents[0].identity
    foreach ($identity in @($identities | Select-Object -Last ($disconnectModes.Count * 2))) {
        if ($identity.uid_map -ne $disconnectIdentity.uid_map -or $identity.gid_map -ne $disconnectIdentity.gid_map -or
            $identity.userNamespace -ne $disconnectIdentity.userNamespace -or
            $identity.pidNamespace -eq $disconnectIdentity.pidNamespace -or
            $identity.mntNamespace -eq $disconnectIdentity.mntNamespace) {
            throw 'Disconnect client namespace topology differs from approved separation.'
        }
    }
    $disconnectPeers = @($disconnectEvents | Where-Object { $_.peer })
    if ($disconnectPeers.Count -ne ($disconnectModes.Count * 2) -or @($disconnectPeers | Where-Object {
        -not $_.allowed -or $_.peer.uid -ne 1102 -or $_.peer.gid -ne 2100
    }).Count -ne 0) { throw 'Missing authenticated disconnect peer evidence.' }
    $rejections = @($disconnectEvents | Where-Object { $_.requestDisconnected })
    if ($rejections.Count -ne $expectedDisconnectBytes.Count) { throw 'Missing disconnect boundary evidence.' }
    for ($index = 0; $index -lt $rejections.Count; $index++) {
        $rejection = $rejections[$index].requestDisconnected
        if ($rejection.requestBytes -ne $expectedDisconnectBytes[$index] -or
            $rejection.sourceEntries -ne $index -or $rejection.responseAttempts -ne $index) {
            throw "Incomplete disconnect had unexpected bytes or source/response entry at boundary $index"
        }
    }
    $recoveries = @($disconnectEvents | Where-Object { $_.requestRecovered })
    $outcomes = @($disconnectEvents | Where-Object { $_.requestDisconnected -or $_.requestRecovered })
    if ($recoveries.Count -ne $disconnectModes.Count -or $outcomes.Count -ne ($disconnectModes.Count * 2)) {
        throw 'Missing per-boundary recovery evidence.'
    }
    for ($index = 0; $index -lt $recoveries.Count; $index++) {
        if ($recoveries[$index].requestRecovered.sourceEntries -ne ($index + 1) -or
            $recoveries[$index].requestRecovered.responseAttempts -ne ($index + 1) -or
            $recoveries[$index].requestRecovered.notAfter -ne ($vectors.generation.notAfter + $index + 1) -or
            $null -eq $outcomes[$index * 2].requestDisconnected -or
            $null -eq $outcomes[$index * 2 + 1].requestRecovered) {
            throw "Disconnect boundary $index did not recover before the next rejection."
        }
    }
    $disconnectResult = @($disconnectEvents | Where-Object { $_.disconnectComplete })
    if ($disconnectResult.Count -ne 1 -or $disconnectResult[0].disconnects -ne $disconnectModes.Count -or
        $disconnectResult[0].responseAttempts -ne $disconnectModes.Count -or
        $disconnectResult[0].sourceEntries -ne $disconnectModes.Count -or
        $disconnectEvents[-1].deniedBeforeRead -ne 0) { throw 'Unexpected disconnect/recovery counters.' }
    Write-Output "PASS request disconnect ($runtime clients): eight exact truncation boundaries in full-close and write-half-close modes add no source/send entry; half-closed clients require zero-byte EOF and every rejection has immediate authenticated inventory recovery with its own exact fresh expiry."
    foreach ($raceMode in @('server-race', 'server-race-cancel-first')) {
        $race = Start-TestBroker $raceMode
        $raceHeld = Invoke-Client 'race-held' '1102:2100' -Detached -Instance "-$raceMode"
        Wait-AdmissionEvent $race 'source-entered'
        Invoke-Client 'race-capacity-before' '1102:2100' -Instance "-$raceMode"
        Wait-AdmissionEvent $race 'capacity'
        & docker kill --signal USR2 $race
        if ($LASTEXITCODE -ne 0) { throw 'Could not arm test-only competing cancellation callback.' }
        Wait-AdmissionEvent $race 'race-settled'
        $raceHeldExit = & docker wait $raceHeld
        if ($LASTEXITCODE -ne 0 -or "$raceHeldExit" -ne '0') { throw 'Race client did not observe zero-byte EOF.' }
        $raceHeldEvents = @((& docker logs $raceHeld) | ForEach-Object { $_ | ConvertFrom-Json })
        if ($LASTEXITCODE -ne 0 -or $raceHeldEvents[-1].lifecycleCase -ne 'race-held' -or
            $raceHeldEvents[-1].clientRuntime -ne $(if ($NodeClients) { 'node' } else { 'python' })) {
            throw 'Missing race client runtime completion.'
        }
        $identities.Add($raceHeldEvents[0].identity)
        Invoke-Client 'race-capacity-after' '1102:2100' -Instance "-$raceMode"
        Wait-AdmissionEvent $race 'capacity' 2
        & docker kill --signal USR1 $race
        if ($LASTEXITCODE -ne 0) { throw 'Could not release test-only race source.' }
        Wait-AdmissionEvent $race 'source-settled'
        Wait-AdmissionEvent $race 'released'
        Invoke-Client 'race-reconnect' '1102:2100' -Instance "-$raceMode"
        $raceExit = & docker wait $race
        if ($LASTEXITCODE -ne 0 -or "$raceExit" -ne '0') { throw 'Terminal-race broker failed.' }
        $raceEvents = @((& docker logs $race 2>&1) | ForEach-Object { "$_" | ConvertFrom-Json })
        if ($LASTEXITCODE -ne 0 -or $raceEvents[-1].event -ne 'complete') { throw 'Missing terminal-race completion.' }
        $raceIdentity = $raceEvents[0].identity
        foreach ($identity in @($identities | Select-Object -Last 4)) {
            if ($identity.uid_map -ne $raceIdentity.uid_map -or $identity.gid_map -ne $raceIdentity.gid_map -or
                $identity.userNamespace -ne $raceIdentity.userNamespace -or
                $identity.pidNamespace -eq $raceIdentity.pidNamespace -or
                $identity.mntNamespace -eq $raceIdentity.mntNamespace) {
                throw 'Race client namespace topology differs from approved separation.'
            }
        }
        $racePeers = @($raceEvents | Where-Object { $_.peer })
        if ($racePeers.Count -ne 4 -or @($racePeers | Where-Object {
            -not ($_.peer.uid -eq 1102 -and $_.peer.gid -eq 2100)
        }).Count -ne 0) { throw 'Missing authenticated race peer evidence.' }
        $raceAttempts = @($raceEvents | Where-Object { $_.terminalRace } | ForEach-Object { $_.terminalRace })
        $raceWinners = @($raceAttempts | Where-Object { $_.won })
        if ($raceAttempts.Count -ne 2 -or $raceWinners.Count -ne 1 -or
            @($raceAttempts | Where-Object { $_.reason -eq 'timeout' }).Count -ne 1 -or
            @($raceAttempts | Where-Object { $_.reason -eq 'cancelled' }).Count -ne 1 -or
            @($raceAttempts | Where-Object {
                $_.sourceEntries -ne 1 -or $_.responseAttempts -ne 0 -or -not $_.slotLocked -or
                ($_.timeouts + $_.cancellations) -ne 1 -or $_.elapsedSeconds -lt 5 -or $_.elapsedSeconds -ge 8
            }).Count -ne 0) { throw 'Race must record one terminal winner and one unchanged loser at the deadline.' }
        $expectedRaceTimeouts = if ($raceWinners[0].reason -eq 'timeout') { 1 } else { 0 }
        if ($raceMode -eq 'server-race-cancel-first' -and $raceWinners[0].reason -ne 'cancelled') {
            throw 'Controlled cancellation-first schedule did not select cancellation.'
        }
        if (@($raceAttempts | Where-Object {
            $_.timeouts -ne $expectedRaceTimeouts -or $_.cancellations -ne (1 - $expectedRaceTimeouts)
        }).Count -ne 0) { throw 'Race loser must preserve the winner reason and counters.' }
        $raceCounts = @($raceEvents | Where-Object { $_.raceCounts })
        if ($raceCounts.Count -ne 1 -or $raceCounts[0].raceCounts.reads -ne 2 -or
            $raceCounts[0].raceCounts.capacity -ne 2 -or $raceCounts[0].raceCounts.requestTimeouts -ne 0 -or
            $raceCounts[0].raceCounts.sourceFailures -ne 0 -or $raceCounts[0].raceCounts.generationReads -ne 0 -or
            $raceCounts[0].raceCounts.timeouts -ne $expectedRaceTimeouts -or
            $raceCounts[0].raceCounts.cancellations -ne (1 - $expectedRaceTimeouts) -or
            ($raceCounts[0].raceCounts.timeouts + $raceCounts[0].raceCounts.cancellations) -ne 1 -or
            @($raceEvents | Where-Object { $_.event -in @('timeout', 'cancelled') }).Count -ne 1 -or
            @($raceEvents | Where-Object { $_.event -eq 'released' }).Count -ne 2) {
            throw 'Unexpected terminal-race lifecycle totals.'
        }
        $raceDeliveries = @($raceEvents | Where-Object { $_.delivery } | ForEach-Object { $_.delivery })
        if ($raceDeliveries.Count -ne 2 -or $raceDeliveries[0].sourceEntries -ne 1 -or
            $raceDeliveries[0].responseAttempts -ne 0 -or -not $raceDeliveries[0].resultDiscarded -or
            -not $raceDeliveries[0].terminal -or -not $raceDeliveries[0].slotLocked -or
            $raceDeliveries[0].inventoryNotAfter -ne ($vectors.generation.notAfter + 1) -or
            $raceDeliveries[1].sourceEntries -ne 2 -or $raceDeliveries[1].responseAttempts -ne 1 -or
            $raceDeliveries[1].resultDiscarded -or $raceDeliveries[1].terminal -or
            -not $raceDeliveries[1].slotLocked -or
            $raceDeliveries[1].inventoryNotAfter -ne ($vectors.generation.notAfter + 2)) {
            throw 'Race result must be discarded before fresh inventory delivery.'
        }
        $settledIndex = -1
        for ($index = 0; $index -lt $raceEvents.Count; $index++) {
            if ($raceEvents[$index].event -eq 'source-settled') { $settledIndex = $index }
        }
        if ($settledIndex -lt 0 -or $null -eq $raceEvents[$settledIndex + 1].delivery -or
            $raceEvents[$settledIndex + 2].event -ne 'released') {
            throw 'Race source must settle and discard its result before releasing the slot.'
        }
        Write-Output "PASS terminal race ($runtime clients): barrier-released deadline/cancellation callbacks have exactly one winner ($($raceWinners[0].reason)), retain capacity through late-result discard, then deliver distinct fresh inventory."
    }
    foreach ($schedule in @('response-first', 'cancel-first', 'deadline-first', 'completed-deadline')) {
        $completion = Start-TestBroker "server-completion-$schedule"
        $succeeds = $schedule -in @('response-first', 'completed-deadline')
        $expectedTimeouts = if ($schedule -eq 'deadline-first') { 1 } else { 0 }
        $expectedCancellations = if ($schedule -eq 'cancel-first') { 1 } else { 0 }
        $clientMode = if ($succeeds) { 'completion-success' } else { 'completion-rejected' }
        $completionClient = Invoke-Client $clientMode '1102:2100' -Detached -Instance "-$schedule"
        Wait-AdmissionEvent $completion 'response-ready'
        Invoke-Client 'completion-capacity' '1102:2100' -Instance "-$schedule"
        Wait-AdmissionEvent $completion 'capacity'
        & docker kill --signal USR2 $completion
        if ($LASTEXITCODE -ne 0) { throw "Could not arm completion schedule: $schedule" }
        Wait-AdmissionEvent $completion 'completion-race-settled'
        Wait-AdmissionEvent $completion 'released'
        $completionClientExit = & docker wait $completionClient
        if ($LASTEXITCODE -ne 0 -or "$completionClientExit" -ne '0') {
            throw "Completion client failed: $schedule"
        }
        $completionClientEvents = @((& docker logs $completionClient) | ForEach-Object { $_ | ConvertFrom-Json })
        if ($LASTEXITCODE -ne 0 -or $completionClientEvents[-1].lifecycleCase -ne $clientMode -or
            $completionClientEvents[-1].clientRuntime -ne $(if ($NodeClients) { 'node' } else { 'python' })) {
            throw "Missing completion client runtime evidence: $schedule"
        }
        $identities.Add($completionClientEvents[0].identity)
        Invoke-Client 'completion-reconnect' '1102:2100' -Instance "-$schedule"
        $completionExit = & docker wait $completion
        if ($LASTEXITCODE -ne 0 -or "$completionExit" -ne '0') { throw "Completion broker failed: $schedule" }
        $completionEvents = @((& docker logs $completion 2>&1) | ForEach-Object { "$_" | ConvertFrom-Json })
        if ($LASTEXITCODE -ne 0 -or $completionEvents[-1].event -ne 'complete') {
            throw "Missing completion evidence: $schedule"
        }
        $completionIdentity = $completionEvents[0].identity
        foreach ($identity in @($identities | Select-Object -Last 3)) {
            if ($identity.uid_map -ne $completionIdentity.uid_map -or $identity.gid_map -ne $completionIdentity.gid_map -or
                $identity.userNamespace -ne $completionIdentity.userNamespace -or
                $identity.pidNamespace -eq $completionIdentity.pidNamespace -or
                $identity.mntNamespace -eq $completionIdentity.mntNamespace) {
                throw "Unexpected completion namespace topology: $schedule"
            }
        }
        $completionPeers = @($completionEvents | Where-Object { $_.peer })
        if ($completionPeers.Count -ne 3 -or @($completionPeers | Where-Object {
            $_.peer.uid -ne 1102 -or $_.peer.gid -ne 2100
        }).Count -ne 0) { throw "Missing authenticated completion peers: $schedule" }
        $observations = @($completionEvents | Where-Object { $_.completionRace })
        if ($observations.Count -ne 1) { throw "Missing completion race observation: $schedule" }
        $observation = $observations[0].completionRace
        $expectedReason = if ($schedule -in @('deadline-first', 'completed-deadline')) { 'timeout' } else { 'cancelled' }
        $attempts = @($observation.attempts)
        $responseAttempts = @($attempts | Where-Object { $_.reason -eq 'response' })
        $terminalAttempts = @($attempts | Where-Object { $_.reason -eq $expectedReason })
        if ($observation.schedule -ne $schedule -or $attempts.Count -ne 2 -or
            $responseAttempts.Count -ne 1 -or $terminalAttempts.Count -ne 1 -or
            $responseAttempts[0].won -ne $succeeds -or $terminalAttempts[0].won -eq $succeeds -or
            $observation.sourceEntries -ne 1 -or $observation.responseAttempts -ne [int]$succeeds -or
            $observation.timeouts -ne $expectedTimeouts -or $observation.cancellations -ne $expectedCancellations -or
            $observation.completed -ne $succeeds -or $observation.terminal -eq $succeeds -or
            ($succeeds -and $responseAttempts[0].elapsedSeconds -ge 5) -or
            ($expectedReason -eq 'timeout' -and $terminalAttempts[0].elapsedSeconds -lt 5) -or
            -not $observation.slotLocked -or $observation.elapsedSeconds -lt 0 -or
            $observation.elapsedSeconds -ge 8 -or
            ($expectedReason -eq 'timeout' -and $observation.elapsedSeconds -lt 5) -or
            ($expectedReason -eq 'cancelled' -and $observation.elapsedSeconds -ge 5)) {
            throw "Completion schedule had an incorrect winner, delivery or deadline: $schedule"
        }
        $deliveries = @($completionEvents | Where-Object { $_.delivery } | ForEach-Object { $_.delivery })
        if ($deliveries.Count -ne 2 -or $deliveries[0].sourceEntries -ne 1 -or
            $deliveries[0].responseAttempts -ne [int]$succeeds -or $deliveries[0].resultDiscarded -eq $succeeds -or
            $deliveries[0].terminal -eq $succeeds -or -not $deliveries[0].slotLocked -or
            $deliveries[0].inventoryNotAfter -ne ($vectors.generation.notAfter + 1) -or
            $deliveries[1].sourceEntries -ne 2 -or $deliveries[1].responseAttempts -ne 1 -or
            $deliveries[1].resultDiscarded -or $deliveries[1].terminal -or -not $deliveries[1].slotLocked -or
            $deliveries[1].inventoryNotAfter -ne ($vectors.generation.notAfter + 2) -or
            @($completionEvents | Where-Object { $_.event -eq 'released' }).Count -ne 2 -or
            @($completionEvents | Where-Object { $_.event -in @('timeout', 'cancelled') }).Count -ne
                ($expectedTimeouts + $expectedCancellations)) {
            throw "Unexpected completion delivery or release totals: $schedule"
        }
        Write-Output "PASS response/terminal schedule ($runtime clients): $schedule, exact single winner, full fresh inventory or zero-byte EOF, then distinct recovery."
    }
    $peerBroker = Start-TestBroker 'server-peer'
    $peerClient = Invoke-Client 'peer-held' '1102:2100' -Detached
    Wait-AdmissionEvent $peerBroker 'source-entered'
    Wait-AdmissionEvent $peerBroker 'peer-half-close-observed'
    Invoke-Client 'peer-capacity-before' '1102:2100'
    Wait-AdmissionEvent $peerBroker 'capacity'
    $peerClientEvents = @((& docker logs $peerClient) | ForEach-Object { $_ | ConvertFrom-Json })
    $expectedRuntime = if ($NodeClients) { 'node' } else { 'python' }
    if ($LASTEXITCODE -ne 0 -or $peerClientEvents.Count -ne 2 -or
        -not $peerClientEvents[-1].holdingPeer -or $peerClientEvents[-1].clientRuntime -ne $expectedRuntime) {
        throw 'Missing actual runtime evidence from the held peer before killing its container.'
    }
    $identities.Add($peerClientEvents[0].identity)
    $peerKillWatch = [System.Diagnostics.Stopwatch]::StartNew()
    & docker kill --signal KILL $peerClient
    if ($LASTEXITCODE -ne 0) { throw 'Could not kill the owned held-peer container.' }
    $peerClientExit = & docker wait $peerClient
    if ($LASTEXITCODE -ne 0 -or "$peerClientExit" -ne '137') { throw 'Held peer must exit from the explicit parent kill.' }
    Wait-AdmissionEvent $peerBroker 'peer-disconnect-observed'
    $peerKillWatch.Stop()
    if ($peerKillWatch.Elapsed.TotalSeconds -ge 3) { throw 'Full peer loss was not observed within three seconds.' }
    Invoke-Client 'peer-capacity-after' '1102:2100'
    Wait-AdmissionEvent $peerBroker 'capacity' 2
    & docker kill --signal USR1 $peerBroker
    if ($LASTEXITCODE -ne 0) { throw 'Could not release the disconnected fixture source.' }
    Wait-AdmissionEvent $peerBroker 'source-settled'
    Wait-AdmissionEvent $peerBroker 'released'
    Invoke-Client 'peer-reconnect' '1102:2100'
    $peerBrokerExit = & docker wait $peerBroker
    if ($LASTEXITCODE -ne 0 -or "$peerBrokerExit" -ne '0') { throw 'Blocked-source peer-disconnect broker failed.' }
    $peerEvents = @((& docker logs $peerBroker 2>&1) | ForEach-Object { "$_" | ConvertFrom-Json })
    if ($LASTEXITCODE -ne 0 -or $peerEvents[-1].event -ne 'complete') { throw 'Missing peer-disconnect completion.' }
    $peerIdentity = $peerEvents[0].identity
    foreach ($identity in @($identities | Select-Object -Last 4)) {
        if ($identity.uid_map -ne $peerIdentity.uid_map -or $identity.gid_map -ne $peerIdentity.gid_map -or
            $identity.userNamespace -ne $peerIdentity.userNamespace -or
            $identity.pidNamespace -eq $peerIdentity.pidNamespace -or
            $identity.mntNamespace -eq $peerIdentity.mntNamespace) {
            throw 'Unexpected peer-disconnect client namespace topology.'
        }
    }
    $peerPeers = @($peerEvents | Where-Object { $_.peer })
    if ($peerPeers.Count -ne 4 -or @($peerPeers | Where-Object {
        $_.peer.uid -ne 1102 -or $_.peer.gid -ne 2100
    }).Count -ne 0) { throw 'Missing authenticated peer-disconnect clients.' }
    $halfClosed = @($peerEvents | Where-Object { $_.peerHalfClosed } | ForEach-Object { $_.peerHalfClosed })
    $disconnected = @($peerEvents | Where-Object { $_.peerDisconnected } | ForEach-Object { $_.peerDisconnected })
    $linuxPollReadHangup = 8192
    $linuxPollHangup = 16
    if ($halfClosed.Count -ne 1 -or $disconnected.Count -ne 1 -or
        ($halfClosed[0].mask -band $linuxPollReadHangup) -eq 0 -or ($halfClosed[0].mask -band $linuxPollHangup) -ne 0 -or
        $halfClosed[0].terminal -or $halfClosed[0].peerDisconnects -ne 0 -or
        $halfClosed[0].sourceEntries -ne 1 -or $halfClosed[0].responseAttempts -ne 0 -or
        -not $halfClosed[0].slotLocked -or $halfClosed[0].timeouts -ne 0 -or $halfClosed[0].cancellations -ne 0 -or
        ($disconnected[0].mask -band $linuxPollHangup) -eq 0 -or $disconnected[0].peerDisconnects -ne 1 -or
        $disconnected[0].sourceEntries -ne 1 -or $disconnected[0].responseAttempts -ne 0 -or
        -not $disconnected[0].slotLocked -or $disconnected[0].timeouts -ne 0 -or
        $disconnected[0].cancellations -ne 0 -or $disconnected[0].elapsedSeconds -lt 0 -or
        $disconnected[0].elapsedSeconds -ge 5) {
        throw 'Half-close must remain nonterminal; only full peer loss may terminate the held request.'
    }
    $peerCounts = @($peerEvents | Where-Object { $_.peerDisconnectCounts })
    if ($peerCounts.Count -ne 1) { throw 'Missing peer-disconnect final counts.' }
    $counts = $peerCounts[0].peerDisconnectCounts
    if ($counts.reads -ne 2 -or $counts.generationReads -ne 0 -or $counts.capacity -ne 2 -or
        $counts.peerDisconnects -ne 1 -or $counts.timeouts -ne 0 -or $counts.cancellations -ne 0 -or
        $counts.requestTimeouts -ne 0 -or $counts.sourceFailures -ne 0 -or
        @($peerEvents | Where-Object { $_.event -eq 'disconnected' }).Count -ne 1 -or
        @($peerEvents | Where-Object { $_.event -eq 'released' }).Count -ne 2) {
        throw 'Unexpected blocked-source peer-disconnect lifecycle totals.'
    }
    $peerDeliveries = @($peerEvents | Where-Object { $_.delivery } | ForEach-Object { $_.delivery })
    if ($peerDeliveries.Count -ne 2 -or $peerDeliveries[0].sourceEntries -ne 1 -or
        $peerDeliveries[0].responseAttempts -ne 0 -or -not $peerDeliveries[0].resultDiscarded -or
        -not $peerDeliveries[0].terminal -or -not $peerDeliveries[0].slotLocked -or
        $peerDeliveries[0].inventoryNotAfter -ne ($vectors.generation.notAfter + 1) -or
        $peerDeliveries[1].sourceEntries -ne 2 -or $peerDeliveries[1].responseAttempts -ne 1 -or
        $peerDeliveries[1].resultDiscarded -or $peerDeliveries[1].terminal -or
        -not $peerDeliveries[1].slotLocked -or
        $peerDeliveries[1].inventoryNotAfter -ne ($vectors.generation.notAfter + 2)) {
        throw 'Disconnected source result must be discarded before distinct recovery.'
    }
    $peerSettled = -1
    for ($index = 0; $index -lt $peerEvents.Count; $index++) {
        if ($peerEvents[$index].event -eq 'source-settled') { $peerSettled = $index }
    }
    if ($peerSettled -lt 0 -or $null -eq $peerEvents[$peerSettled + 1].delivery -or
        $peerEvents[$peerSettled + 2].event -ne 'released') {
        throw 'Disconnected source must settle, discard and then release.'
    }
    Write-Output "PASS blocked-source peer disconnect ($runtime clients): required write-half-close stays nonterminal; killed client yields full HUP in $($peerKillWatch.Elapsed.TotalSeconds.ToString('F3')) seconds, retains capacity until discard, then fresh inventory succeeds."
    foreach ($writerMode in @('slow', 'nonreading')) {
        $writer = Start-TestBroker "server-writer-$writerMode"
        $writerClientMode = "writer-$writerMode"
        $writerClient = Invoke-Client $writerClientMode '1102:2100' -Detached
        Wait-AdmissionEvent $writer 'write-backpressure'
        Invoke-Client 'writer-capacity' '1102:2100' -Instance "-$writerMode"
        Wait-AdmissionEvent $writer 'capacity'
        Wait-AdmissionEvent $writer 'released'
        Invoke-Client 'writer-reconnect' '1102:2100' -Instance "-$writerMode"
        $writerClientExit = & docker wait $writerClient
        if ($LASTEXITCODE -ne 0 -or "$writerClientExit" -ne '0') { throw "Writer client failed: $writerMode" }
        $writerClientEvents = @((& docker logs $writerClient) | ForEach-Object { $_ | ConvertFrom-Json })
        if ($LASTEXITCODE -ne 0 -or $writerClientEvents[-1].lifecycleCase -ne $writerClientMode -or
            $writerClientEvents[-1].clientRuntime -ne $(if ($NodeClients) { 'node' } else { 'python' })) {
            throw "Missing writer client runtime completion: $writerMode"
        }
        $identities.Add($writerClientEvents[0].identity)
        $writerExit = & docker wait $writer
        if ($LASTEXITCODE -ne 0 -or "$writerExit" -ne '0') { throw "Writer broker failed: $writerMode" }
        $writerEvents = @((& docker logs $writer 2>&1) | ForEach-Object { "$_" | ConvertFrom-Json })
        if ($LASTEXITCODE -ne 0 -or $writerEvents[-1].event -ne 'complete') { throw 'Missing writer completion.' }
        $writerIdentity = $writerEvents[0].identity
        foreach ($identity in @($identities | Select-Object -Last 3)) {
            if ($identity.uid_map -ne $writerIdentity.uid_map -or $identity.gid_map -ne $writerIdentity.gid_map -or
                $identity.userNamespace -ne $writerIdentity.userNamespace -or
                $identity.pidNamespace -eq $writerIdentity.pidNamespace -or
                $identity.mntNamespace -eq $writerIdentity.mntNamespace) { throw 'Unexpected writer namespace topology.' }
        }
        $writerPeers = @($writerEvents | Where-Object { $_.peer })
        if ($writerPeers.Count -ne 3 -or @($writerPeers | Where-Object {
            $_.peer.uid -ne 1102 -or $_.peer.gid -ne 2100
        }).Count -ne 0) { throw 'Missing authenticated writer peers.' }
        $pressure = @($writerEvents | Where-Object { $_.writeBackpressure } | ForEach-Object { $_.writeBackpressure })
        $outcomes = @($writerEvents | Where-Object { $_.writeOutcome } | ForEach-Object { $_.writeOutcome })
        $timedOut = $writerMode -eq 'nonreading'
        if ($pressure.Count -ne 1 -or $outcomes.Count -ne 1 -or $pressure[0].frameBytes -ne 32772 -or
            $pressure[0].initialBytes -le 0 -or $pressure[0].initialBytes -ge 32772 -or
            $pressure[0].sendBuffer -ge 32772 -or $pressure[0].completed -or $pressure[0].timedOut -or
            $outcomes[0].initialBytes -ne $pressure[0].initialBytes -or
            $outcomes[0].completed -eq $timedOut -or $outcomes[0].timedOut -ne $timedOut -or
            $outcomes[0].terminal -ne $timedOut -or -not $outcomes[0].slotLocked -or
            $outcomes[0].elapsedSeconds -ge 8 -or
            ($timedOut -and $outcomes[0].elapsedSeconds -lt 5) -or
            (-not $timedOut -and $outcomes[0].elapsedSeconds -ge 5)) {
            throw "Writer must experience actual backpressure and settle within its deadline: $writerMode"
        }
        $writerDeliveries = @($writerEvents | Where-Object { $_.delivery } | ForEach-Object { $_.delivery })
        if ($writerDeliveries.Count -ne 2 -or $writerDeliveries[0].sourceEntries -ne 1 -or
            $writerDeliveries[0].responseAttempts -ne 1 -or $writerDeliveries[0].resultDiscarded -ne $timedOut -or
            $writerDeliveries[0].terminal -ne $timedOut -or -not $writerDeliveries[0].slotLocked -or
            $writerDeliveries[0].inventoryNotAfter -ne ($vectors.generation.notAfter + 1) -or
            $writerDeliveries[1].sourceEntries -ne 2 -or $writerDeliveries[1].responseAttempts -ne 1 -or
            $writerDeliveries[1].resultDiscarded -or $writerDeliveries[1].terminal -or
            -not $writerDeliveries[1].slotLocked -or
            $writerDeliveries[1].inventoryNotAfter -ne ($vectors.generation.notAfter + 2) -or
            @($writerEvents | Where-Object { $_.event -eq 'released' }).Count -ne 2 -or
            @($writerEvents | Where-Object { $_.event -eq 'timeout' }).Count -ne [int]$timedOut) {
            throw "Unexpected writer delivery/timeout/recovery totals: $writerMode"
        }
        Write-Output "PASS bounded writer ($runtime clients): $writerMode, actual EAGAIN before remaining-deadline send, exact full inventory or rejected partial frame, fresh capacity recovery."
    }
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
