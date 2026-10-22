[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$composeArgs = @('compose', '-f', (Join-Path $root 'compose.yaml'),
    '-f', (Join-Path $root 'compose.sip-proof.yaml'))

function Invoke-Docker {
    param([string[]] $DockerArguments)
    & docker @composeArgs @DockerArguments
    if ($LASTEXITCODE -ne 0) { throw "Docker proof command failed: $($DockerArguments -join ' ')" }
}

$template = Get-Content -Raw -LiteralPath (Join-Path $root 'local\sip\endpoint.conf.template')
foreach ($customer in @('customer-a', 'customer-b')) {
    $directory = Join-Path $root ".local-proof\$customer"
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $path = Join-Path $directory 'pjsip.conf'
    if (-not (Test-Path -LiteralPath $path)) {
        $password = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
        [IO.File]::WriteAllText($path, $template.Replace('@PASSWORD@', $password).Replace("`r`n", "`n"),
            [Text.UTF8Encoding]::new($false))
    }
}

Invoke-Docker -DockerArguments @('config', '--quiet')
$headers = @('event', 'time', 'channel', 'uniqueid', 'linkedid', 'context', 'extension', 'extra')
Invoke-Docker -DockerArguments @('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '90')
foreach ($pair in @(@('customer-a', 'sip-test-a'), @('customer-b', 'sip-test-b'))) {
    $customer, $tester = $pair
    $before = & docker @composeArgs exec -T $customer cat /var/log/asterisk/cel-custom/Master.csv
    if ($LASTEXITCODE -ne 0) { throw "Cannot read $customer CEL before testing." }
    $previousIds = @($before | ConvertFrom-Csv -Header $headers | ForEach-Object { $_.uniqueid })
    Invoke-Docker -DockerArguments @('run', '--rm', '--no-deps', $tester)
    $deadline = (Get-Date).AddSeconds(10)
    do {
        $csv = & docker @composeArgs exec -T $customer cat /var/log/asterisk/cel-custom/Master.csv
        if ($LASTEXITCODE -ne 0) { throw "Cannot read $customer CEL after testing." }
        $events = @($csv | ConvertFrom-Csv -Header $headers)
        $ended = @($events | Where-Object {
            $_.event -eq 'CHAN_END' -and $_.channel -like 'PJSIP/*' -and
            $_.extension -eq 'echo' -and $_.uniqueid -notin $previousIds
        })
        if ($ended.Count -gt 0) { break }
        if ((Get-Date) -ge $deadline) { throw "$customer has no completed fresh SIP call in CEL." }
        Start-Sleep -Milliseconds 250
    } while ($true)
    $id = $ended[-1].uniqueid
    foreach ($event in @('CHAN_START', 'ANSWER', 'HANGUP')) {
        if (-not ($events | Where-Object { $_.uniqueid -eq $id -and $_.event -eq $event })) {
            throw "$customer SIP call $id lacks CEL $event."
        }
    }
    $recording = "/var/spool/asterisk/monitor/sip-$id.wav"
    $check = 'import sys,wave; w=wave.open(sys.argv[1]); assert w.getframerate()==8000; assert w.getnframes()>=8000; assert w.getsampwidth()==2; assert w.getnchannels()==1; print("PASS recorded SIP audio: %d samples" % w.getnframes())'
    Invoke-Docker -DockerArguments @('exec', '-T', $customer, 'python3', '-c', $check, $recording)
    Write-Host "PASS $customer fresh SIP CEL lifecycle and WAV recording."
}
Write-Host 'PASS both customer SIP/RTP probes. PBXs remain running; stop using docker compose stop.'
