[CmdletBinding()]
param([switch]$Interactive, [switch]$WithIdentity)
$ErrorActionPreference = 'Stop'
if ($Interactive -and $WithIdentity) { throw 'Choose interactive mode or the combined identity proof, not both.' }
$root = Split-Path -Parent $PSScriptRoot
$compose = Join-Path $root 'compose.status-proof.yaml'
$directory = Join-Path $root '.local-proof\pbx-status'
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$lock = [IO.File]::Open((Join-Path $directory 'fixture.lock'), [IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
    $existing = & docker compose -f $compose ps -a --format json
    if ($LASTEXITCODE -ne 0) { throw 'Could not check PBX status fixture ownership.' }
    if ($existing) { throw 'PBX status fixture already exists; stop its owner first.' }
    foreach ($port in @(15038, 15039)) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
        try { $listener.Start() } finally { $listener.Stop() }
    }
    foreach ($port in @(15060, 15061)) {
        $udp = [Net.Sockets.UdpClient]::new()
        try { $udp.Client.Bind([Net.IPEndPoint]::new([Net.IPAddress]::Loopback, $port)) }
        finally { $udp.Dispose() }
    }
    $connections = @()
    $endpointConnections = @()
    $registrations = @()
    foreach ($index in @(0, 1)) {
        $customer = @('customer-a', 'customer-b')[$index]
        $secret = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
        $endpointSecret = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
        $sipSecret = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
        $manager = @"
[general]
enabled = yes
port = 5038
bindaddr = 0.0.0.0
displayconnects = no

[status-reader]
secret = $secret
read = none
write = reporting

[endpoint-reader]
secret = $endpointSecret
read = none
write = system,reporting
"@
        [IO.File]::WriteAllText((Join-Path $directory "$customer.conf"), $manager, [Text.UTF8Encoding]::new($false))
        $connections += @{ customer = $customer; host = '127.0.0.1'; port = 15038 + $index
            username = 'status-reader'; secret = $secret; tls = $false }
        $endpointConnections += @{ customer = $customer; host = '127.0.0.1'; port = 15038 + $index
            username = 'endpoint-reader'; secret = $endpointSecret; tls = $false }
        $registrations += @{ customer = $customer; username = "$customer-offline"; secret = $sipSecret; port = 15060 + $index }
        $pjsip = @"
[global]
type = global
user_agent = Asterisk-Endpoint-Proof
[transport-udp]
type = transport
protocol = udp
bind = 0.0.0.0:5060
[$customer-offline]
type = endpoint
context = default
disallow = all
allow = ulaw
aors = $customer-offline
auth = $customer-auth
rewrite_contact = yes
[$customer-auth]
type = auth
auth_type = userpass
username = $customer-offline
password = $sipSecret
[$customer-offline]
type = aor
max_contacts = 1
[$customer-static]
type = endpoint
context = default
disallow = all
allow = ulaw
aors = $customer-static
[$customer-static]
type = aor
contact = sip:synthetic@127.0.0.1:5099
"@
        [IO.File]::WriteAllText((Join-Path $directory "$customer-pjsip.conf"), $pjsip, [Text.UTF8Encoding]::new($false))
    }
    [IO.File]::WriteAllText((Join-Path $directory 'connections.json'),
        (ConvertTo-Json -InputObject $connections), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $directory 'endpoint-connections.json'),
        (ConvertTo-Json -InputObject $endpointConnections), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $directory 'registrations.json'),
        (ConvertTo-Json -InputObject $registrations), [Text.UTF8Encoding]::new($false))
    try {
        & docker compose -f $compose up -d
        if ($LASTEXITCODE -ne 0) { throw 'PBX status fixture startup failed.' }
        foreach ($customer in @('customer-a', 'customer-b')) {
            $ready = $false
            for ($attempt = 0; $attempt -lt 30; $attempt++) {
                $state = & docker compose -f $compose ps -a --format json $customer | ConvertFrom-Json
                if ($LASTEXITCODE -ne 0) { throw 'Could not inspect PBX status fixture.' }
                if ($state.State -eq 'exited') {
                    & docker compose -f $compose logs --tail 40 $customer
                    throw "PBX status fixture $customer exited during startup."
                }
                $boot = & docker compose -f $compose exec -T $customer asterisk -rx 'core waitfullybooted'
                if ($LASTEXITCODE -eq 0 -and "$boot" -match 'fully booted') { $ready = $true; break }
                Start-Sleep -Seconds 1
            }
            if (-not $ready) {
                & docker compose -f $compose logs --tail 40 $customer
                throw "PBX status fixture $customer did not boot."
            }
        }
        Push-Location $root
        try {
            & node .\tests\identity\pbx-status-proof.ts
            if ($LASTEXITCODE -ne 0) { throw 'Real AMI status proof failed.' }
            & node .\tests\identity\pbx-registration-proof.ts
            if ($LASTEXITCODE -ne 0) { throw 'Real SIP registration visibility proof failed.' }
            & node .\tests\identity\pbx-status-recovery.ts
            if ($LASTEXITCODE -ne 0) { throw 'Real AMI outage/recovery proof failed.' }
            if ($WithIdentity) {
                $previous = $env:ASTERISK_TEST_REAL_AMI
                try {
                    $env:ASTERISK_TEST_REAL_AMI = '1'
                    & (Join-Path $PSScriptRoot 'Test-IdentityProof.ps1')
                } finally { $env:ASTERISK_TEST_REAL_AMI = $previous }
            }
            if ($Interactive) {
                Write-Host 'Synthetic PBXs are ready. Start the engineering identity launcher in another terminal.'
                Write-Host 'AMI credentials remain in ignored .local-proof\pbx-status; do not share them.'
                do { $answer = Read-Host 'Type stop to remove this isolated status fixture' } while ($answer -ne 'stop')
            }
        } finally { Pop-Location }
    } finally {
        & docker compose -f $compose down --volumes
        if ($LASTEXITCODE -ne 0) { throw 'PBX status fixture cleanup failed.' }
    }
} finally { $lock.Dispose() }
