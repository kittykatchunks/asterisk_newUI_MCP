[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$directory = Join-Path $root ".local-proof\ami-tls-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $directory | Out-Null
$previousCa = $env:NODE_EXTRA_CA_CERTS
$previousDirectory = $env:ASTERISK_TEST_AMI_TLS_DIRECTORY
$files = @()
try {
    $trusted = ''
    foreach ($name in @('valid', 'mismatch', 'expired')) {
        $rsa = [Security.Cryptography.RSA]::Create(2048)
        try {
            $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
                "CN=AMI TLS synthetic proof $name", $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256,
                [Security.Cryptography.RSASignaturePadding]::Pkcs1)
            $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
            $address = if ($name -eq 'mismatch') { '127.0.0.2' } else { '127.0.0.1' }
            $san.AddIpAddress([Net.IPAddress]::Parse($address))
            $request.CertificateExtensions.Add($san.Build())
            $start = [DateTimeOffset]::UtcNow.AddMinutes(-5)
            $end = [DateTimeOffset]::UtcNow.AddDays(1)
            if ($name -eq 'expired') {
                $start = [DateTimeOffset]::UtcNow.AddDays(-2)
                $end = [DateTimeOffset]::UtcNow.AddDays(-1)
            }
            $certificate = $request.CreateSelfSigned($start, $end)
            try {
                $pem = $certificate.ExportCertificatePem()
                $trusted += "$pem`n"
                foreach ($entry in @(@("$name-cert.pem", $pem), @("$name-key.pem", $rsa.ExportPkcs8PrivateKeyPem()))) {
                    $path = Join-Path $directory $entry[0]
                    $files += $path
                    [IO.File]::WriteAllText($path, $entry[1], [Text.UTF8Encoding]::new($false))
                }
            } finally { $certificate.Dispose() }
        } finally { $rsa.Dispose() }
    }
    $ca = Join-Path $directory 'trusted.pem'
    $files += $ca
    [IO.File]::WriteAllText($ca, $trusted, [Text.UTF8Encoding]::new($false))
    $env:NODE_EXTRA_CA_CERTS = $ca
    $env:ASTERISK_TEST_AMI_TLS_DIRECTORY = $directory
    Push-Location $root
    try {
        & node --test .\tests\ami-tls.test.ts
        if ($LASTEXITCODE -ne 0) { throw 'AMI TLS transport proof failed.' }
    } finally { Pop-Location }
} finally {
    $env:NODE_EXTRA_CA_CERTS = $previousCa
    $env:ASTERISK_TEST_AMI_TLS_DIRECTORY = $previousDirectory
    foreach ($path in $files) { Remove-Item -LiteralPath $path -Force }
    Remove-Item -LiteralPath $directory
}
