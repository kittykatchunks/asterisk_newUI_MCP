[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$composeArgs = @('compose', '-f', (Join-Path $root 'compose.yaml'),
    '-f', (Join-Path $root 'compose.sip-proof.yaml'),
    '-f', (Join-Path $root 'compose.capture-proof.yaml'))
$previousIncident = $env:PROOF_INCIDENT
$env:PROOF_INCIDENT = 'incident-' + [guid]::NewGuid().ToString('N')
$incident = Join-Path $root ".local-proof\evidence\$env:PROOF_INCIDENT"

function Invoke-CaptureDocker {
    param([string[]] $DockerArguments)
    & docker @composeArgs @DockerArguments
    if ($LASTEXITCODE -ne 0) { throw "Capture proof command failed: $($DockerArguments -join ' ')" }
}

try {
    foreach ($customer in @('customer-a', 'customer-b')) {
        New-Item -ItemType Directory -Path (Join-Path $incident $customer) | Out-Null
    }
    & (Join-Path $PSScriptRoot 'Test-SipProof.ps1')
    Invoke-CaptureDocker -DockerArguments @('build', 'capture-a')
    Invoke-CaptureDocker -DockerArguments @('up', '-d', '--no-deps', 'capture-a', 'capture-b')
    $deadline = (Get-Date).AddSeconds(8)
    foreach ($customer in @('customer-a', 'customer-b')) {
        $ready = Join-Path $incident "$customer\ready"
        while (-not (Test-Path -LiteralPath $ready)) {
            if ((Get-Date) -ge $deadline) {
                Invoke-CaptureDocker -DockerArguments @('logs', '--tail', '20', 'capture-a', 'capture-b')
                throw "Capture did not become ready for $customer."
            }
            Start-Sleep -Milliseconds 100
        }
    }
    foreach ($pair in @(@('customer-a', 'sip-test-a', 'capture-a'), @('customer-b', 'sip-test-b', 'capture-b'))) {
        Invoke-CaptureDocker -DockerArguments @('run', '--rm', '--no-deps', $pair[1])
    }
    foreach ($pair in @(@('customer-a', 'capture-a'), @('customer-b', 'capture-b'))) {
        $customer, $collector = $pair
        $id = & docker @composeArgs ps -a -q $collector
        if ($LASTEXITCODE -ne 0 -or -not $id) { throw "Missing collector $collector." }
        $deadline = (Get-Date).AddSeconds(25)
        do {
            $stateJson = & docker inspect $id --format '{{json .State}}'
            if ($LASTEXITCODE -ne 0) { throw "Cannot inspect $collector." }
            $state = $stateJson | ConvertFrom-Json
            if (-not $state.Running) { break }
            if ((Get-Date) -ge $deadline) { throw "$collector exceeded its capture deadline." }
            Start-Sleep -Milliseconds 250
        } while ($true)
        if ($state.ExitCode -ne 0) {
            Invoke-CaptureDocker -DockerArguments @('logs', '--tail', '20', $collector)
            throw "$collector failed."
        }
        $directory = Join-Path $incident $customer
        $cel = & docker @composeArgs exec -T $customer cat /var/log/asterisk/cel-custom/Master.csv
        if ($LASTEXITCODE -ne 0) { throw "Cannot snapshot $customer CEL." }
        [IO.File]::WriteAllText((Join-Path $directory 'cel.csv'), (($cel -join "`n") + "`n"),
            [Text.UTF8Encoding]::new($false))
        Invoke-CaptureDocker -DockerArguments @('run', '--rm', '--no-deps', '--cap-drop', 'ALL',
            '--entrypoint', 'python3', $collector, '-B', '/diagnostics/report.py')
        $manifest = Get-Content -Raw -LiteralPath (Join-Path $directory 'manifest.json') | ConvertFrom-Json
        if ($manifest.customer -ne $customer -or $manifest.incident -ne $env:PROOF_INCIDENT) {
            throw 'Capture provenance mismatch.'
        }
        if ($manifest.kernel_dropped_packets -ne 0) { throw 'Packet loss detected in synthetic proof.' }
        if ($manifest.stop_reason -ne 'duration_limit') { throw 'Unexpected capture stop reason.' }
        Write-Host "PASS $customer incident evidence: $(Join-Path $directory 'report.html')"
    }
} finally {
    try {
        Invoke-CaptureDocker -DockerArguments @('stop', 'capture-a', 'capture-b', 'customer-a', 'customer-b')
        Invoke-CaptureDocker -DockerArguments @('rm', '-f', 'capture-a', 'capture-b')
    } finally { $env:PROOF_INCIDENT = $previousIncident }
}
