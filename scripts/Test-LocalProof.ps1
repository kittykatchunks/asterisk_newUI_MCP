[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$compose = Join-Path $root 'compose.yaml'

function Invoke-Compose {
    param([string[]] $DockerArguments)
    $output = & docker compose -f $compose @DockerArguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose $($DockerArguments -join ' ') failed:`n$($output -join "`n")"
    }
    return ($output -join "`n")
}

function Assert-Match {
    param([string] $Actual, [string] $Pattern, [string] $Message)
    if ($Actual -notmatch $Pattern) { throw "$Message`n$Actual" }
}

function Invoke-Cli {
    param([string] $Customer, [string] $Command)
    $result = Invoke-Compose -DockerArguments @('exec', '-T', $Customer, 'asterisk', '-rx', $Command)
    if ($result -match "No such command|Command '.+' failed|Unable to") {
        throw "$customer CLI command failed: $Command`n$result"
    }
    return $result
}

Invoke-Compose -DockerArguments @('config', '--quiet') | Out-Null
Invoke-Compose -DockerArguments @('up', '-d', '--wait', '--wait-timeout', '90') | Out-Null
$marker = 'proof-' + [guid]::NewGuid().ToString('N')
$snapshots = @{}
$previousIds = @{}

foreach ($customer in @('customer-a', 'customer-b')) {
    $version = Invoke-Cli $customer 'core show version'
    Assert-Match $version 'Asterisk 22\.11\.0' "$customer has the wrong Asterisk version."
    Invoke-Compose -DockerArguments @('exec', '-T', $customer, '/bin/sh', '/etc/asterisk/health.sh') | Out-Null
    $transport = Invoke-Cli $customer 'pjsip show transports'
    Assert-Match $transport 'transport-udp' "$customer has no UDP SIP transport."
    $previous = Invoke-Compose -DockerArguments @('exec', '-T', $customer, 'cat', '/var/log/asterisk/cel-custom/Master.csv')
    $previousIds[$customer] = @($previous -split "`n" | Where-Object { $_.Trim() } |
        ConvertFrom-Csv -Header event,time,channel,uniqueid,linkedid,context,extension,extra |
        ForEach-Object { $_.uniqueid })
    Invoke-Cli $customer "database put local-proof marker $marker-$customer" | Out-Null
    Invoke-Cli $customer 'channel originate Local/tone@proof/n application Wait 4' | Out-Null
    Invoke-Cli $customer 'channel originate Local/queue@proof/n application Wait 4' | Out-Null
}

$deadline = (Get-Date).AddSeconds(20)
foreach ($customer in @('customer-a', 'customer-b')) {
    do {
        $channels = Invoke-Cli $customer 'core show channels count'
        if ($channels -match '(?m)^0 active channels') { break }
        if ((Get-Date) -ge $deadline) { throw "$customer test calls did not finish.`n$channels" }
        Start-Sleep -Milliseconds 500
    } while ($true)

    $cel = Invoke-Compose -DockerArguments @('exec', '-T', $customer, 'cat', '/var/log/asterisk/cel-custom/Master.csv')
    $rows = @($cel -split "`n" | Where-Object { $_.Trim() } | ConvertFrom-Csv -Header event,time,channel,uniqueid,linkedid,context,extension,extra)
    $tone = @($rows | Where-Object { $_.event -eq 'CHAN_START' -and $_.extension -eq 'tone' } | Select-Object -Last 1)
    if ($tone.Count -ne 1) { throw "$customer has no tone-call CEL start." }
    $id = $tone[0].uniqueid
    if ($id -in $previousIds[$customer]) { throw "$customer did not produce a fresh tone-call record." }
    foreach ($event in @('ANSWER', 'HANGUP', 'CHAN_END')) {
        if (-not ($rows | Where-Object { $_.uniqueid -eq $id -and $_.event -eq $event })) {
            throw "$customer is missing CEL $event for $id."
        }
    }
    $recording = "/var/spool/asterisk/monitor/$id.wav"
    $size = Invoke-Compose -DockerArguments @('exec', '-T', $customer, 'stat', '-c', '%s', $recording)
    if ([int64]$size -le 44) { throw "$customer recording has no audio payload." }
    $hash = Invoke-Compose -DockerArguments @('exec', '-T', $customer, 'sha256sum', $recording)
    $queue = Invoke-Compose -DockerArguments @('exec', '-T', $customer, 'cat', '/var/log/asterisk/queue_log')
    $queueStart = @($rows | Where-Object { $_.event -eq 'CHAN_START' -and $_.extension -eq 'queue' } | Select-Object -Last 1)
    if ($queueStart.Count -ne 1) { throw "$customer has no queue-call CEL start." }
    if ($queueStart[0].uniqueid -in $previousIds[$customer]) { throw "$customer did not produce a fresh queue-call record." }
    $queueId = [regex]::Escape($queueStart[0].uniqueid)
    Assert-Match $queue "\|$queueId\|proof-queue\|NONE\|ENTERQUEUE\|" "$customer queue entry missing."
    Assert-Match $queue "\|$queueId\|proof-queue\|NONE\|EXITWITHTIMEOUT\|" "$customer queue timeout missing."
    $snapshots[$customer] = @{ Cel = $cel; Queue = $queue; Hash = $hash; Recording = $recording }
}

Invoke-Compose -DockerArguments @('restart') | Out-Null
Invoke-Compose -DockerArguments @('up', '-d', '--wait', '--wait-timeout', '90') | Out-Null
foreach ($customer in @('customer-a', 'customer-b')) {
    $stored = Invoke-Cli $customer 'database get local-proof marker'
    Assert-Match $stored ([regex]::Escape("$marker-$customer")) "$customer state did not persist or crossed customer boundary."
    $cel = Invoke-Compose -DockerArguments @('exec', '-T', $customer, 'cat', '/var/log/asterisk/cel-custom/Master.csv')
    if (-not $cel.StartsWith($snapshots[$customer].Cel)) { throw "$customer CEL history was lost." }
    $queue = Invoke-Compose -DockerArguments @('exec', '-T', $customer, 'cat', '/var/log/asterisk/queue_log')
    if (-not $queue.StartsWith($snapshots[$customer].Queue)) { throw "$customer queue history was lost." }
    $hash = Invoke-Compose -DockerArguments @('exec', '-T', $customer, 'sha256sum', $snapshots[$customer].Recording)
    if ($hash -ne $snapshots[$customer].Hash) { throw "$customer recording changed across restart." }
    Write-Host "PASS $customer : modules, CEL lifecycle, queue timeout, recording payload, and restart persistence."
}

$containers = Invoke-Compose -DockerArguments @('ps', '-q')
$ids = @($containers -split "`n" | Where-Object { $_.Trim() })
$details = (& docker inspect @ids | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect proof containers.' }
if (@($details).Count -ne 2) { throw 'Expected two proof containers.' }
$networks = @()
$volumes = @()
foreach ($item in $details) {
    if ($item.Config.User -ne '1000:999') { throw 'Proof must run as the non-root Asterisk user.' }
    if (@($item.HostConfig.PortBindings.PSObject.Properties).Count -ne 0) { throw 'Unexpected published host ports.' }
    $network = @($item.NetworkSettings.Networks.PSObject.Properties.Name)
    if ($network.Count -ne 1) { throw 'Expected one isolated network per customer.' }
    $networks += $network
    $volumes += @($item.Mounts | Where-Object { $_.Type -eq 'volume' } | ForEach-Object { $_.Name })
}
if (@($networks | Select-Object -Unique).Count -ne 2) { throw 'Customers share a network.' }
if (@($volumes | Select-Object -Unique).Count -ne $volumes.Count) { throw 'Customers share a persistent volume.' }
$networkDetails = (& docker network inspect @networks | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect proof networks.' }
if ($networkDetails | Where-Object { -not $_.Internal }) { throw 'Proof networks must be internal.' }
Write-Host 'PASS separate internal networks/volumes, non-root processes, and no published ports.'
Write-Host 'Not tested: SIP calls, browser/media path, authentication, adversarial isolation, capture UI, or production capacity.'
