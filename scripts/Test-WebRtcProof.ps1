[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$composeArgs = @('compose', '-f', (Join-Path $root 'compose.yaml'),
    '-f', (Join-Path $root 'compose.webrtc-proof.yaml'))

function Write-ProofFile {
    param([string] $Path, [string] $Content)
    [IO.File]::WriteAllText($Path, $Content.Replace("`r`n", "`n"), [Text.UTF8Encoding]::new($false))
}

function Invoke-ProofDocker {
    param([string[]] $DockerArguments)
    & docker @composeArgs @DockerArguments
    if ($LASTEXITCODE -ne 0) { throw "Docker WebRTC command failed: $($DockerArguments -join ' ')" }
}

foreach ($customer in @('customer-a', 'customer-b')) {
    $directory = Join-Path $root ".local-proof\webrtc\$customer"
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $rsa = [Security.Cryptography.RSA]::Create(2048)
    try {
        $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
            "CN=localhost", $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256,
            [Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
        $san.AddDnsName('localhost')
        $san.AddIpAddress([Net.IPAddress]::Parse('127.0.0.1'))
        $request.CertificateExtensions.Add($san.Build())
        $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),
            [DateTimeOffset]::UtcNow.AddDays(2))
        try {
            Write-ProofFile (Join-Path $directory 'cert.pem') $certificate.ExportCertificatePem()
            Write-ProofFile (Join-Path $directory 'key.pem') $rsa.ExportPkcs8PrivateKeyPem()
            $pin = [Convert]::ToBase64String([Security.Cryptography.SHA256]::HashData($rsa.ExportSubjectPublicKeyInfo()))
            Write-ProofFile (Join-Path $directory 'pin.txt') $pin
        } finally { $certificate.Dispose() }
    } finally { $rsa.Dispose() }
    $password = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    Write-ProofFile (Join-Path $directory 'password.txt') $password
    Write-ProofFile (Join-Path $directory 'http.conf') @'
[general](+)
enabled = yes
bindaddr = 0.0.0.0
bindport = 8088
tlsenable = yes
tlsbindaddr = 0.0.0.0:8089
tlscertfile = /run/webrtc/cert.pem
tlsprivatekey = /run/webrtc/key.pem
'@
    Write-ProofFile (Join-Path $directory 'pjsip.conf') @"
[transport-wss]
type = transport
protocol = wss
bind = 0.0.0.0

[browser-proof]
type = endpoint
transport = transport-wss
context = sip-proof
disallow = all
allow = ulaw
auth = browser-proof-auth
aors = browser-proof
use_avpf = yes
media_encryption = dtls
dtls_verify = fingerprint
ice_support = yes
media_use_received_transport = yes
rtcp_mux = yes
dtls_auto_generate_cert = yes
dtls_setup = passive
direct_media = no
force_rport = yes
rewrite_contact = yes
rtp_symmetric = yes

[browser-proof-auth]
type = auth
auth_type = userpass
username = browser-proof
password = $password

[browser-proof]
type = aor
max_contacts = 1
remove_existing = yes
"@
    $start = if ($customer -eq 'customer-a') { 10000 } else { 10100 }
    Write-ProofFile (Join-Path $directory 'rtp.conf') @"
[general]
rtpstart = $start
rtpend = $($start + 19)
icesupport = yes
"@
}

Invoke-ProofDocker -DockerArguments @('config', '--quiet')
try {
    Invoke-ProofDocker -DockerArguments @('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '90')
    foreach ($customer in @('customer-a', 'customer-b')) {
        $id = & docker @composeArgs ps -q $customer
        if ($LASTEXITCODE -ne 0) { throw "Cannot inspect $customer" }
        $details = & docker inspect $id | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0) { throw "Cannot inspect $customer network." }
        $ip = @($details.NetworkSettings.Networks.PSObject.Properties.Value.IPAddress)
        if ($ip.Count -ne 1) { throw 'Expected exactly one customer network.' }
        $path = Join-Path $root ".local-proof\webrtc\$customer\rtp.conf"
        $content = [IO.File]::ReadAllText($path)
        Write-ProofFile $path ($content + "`n[ice_host_candidates]`n$($ip[0]) => 127.0.0.1`n")
    }
    Invoke-ProofDocker -DockerArguments @('restart')
    Invoke-ProofDocker -DockerArguments @('up', '-d', '--wait', '--wait-timeout', '90')
    Push-Location $root
    try {
        & npm run typecheck
        if ($LASTEXITCODE -ne 0) { throw 'Browser proof typecheck failed.' }
        & npm run test:webrtc
        if ($LASTEXITCODE -ne 0) { throw 'Browser proof failed.' }
    } finally { Pop-Location }
} finally {
    Invoke-ProofDocker -DockerArguments @('stop')
}
