[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'New-ProofTlsIdentity.ps1')
$directory = Join-Path $root ".local-proof\ami-tls-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $directory | Out-Null
$previousCa = $env:NODE_EXTRA_CA_CERTS
$previousDirectory = $env:ASTERISK_TEST_AMI_TLS_DIRECTORY
$files = @()
try {
    $trusted = ''
    foreach ($name in @('valid', 'mismatch', 'expired')) {
        $address = if ($name -eq 'mismatch') { '127.0.0.2' } else { '127.0.0.1' }
        $start = [DateTimeOffset]::UtcNow.AddMinutes(-5)
        $end = [DateTimeOffset]::UtcNow.AddDays(1)
        if ($name -eq 'expired') {
            $start = [DateTimeOffset]::UtcNow.AddDays(-2)
            $end = [DateTimeOffset]::UtcNow.AddDays(-1)
        }
        $identity = New-ProofTlsIdentity -Name $name -Address $address -NotBefore $start -NotAfter $end
        $trusted += "$($identity.Certificate)`n"
        foreach ($entry in @(@("$name-cert.pem", $identity.Certificate), @("$name-key.pem", $identity.PrivateKey))) {
            $path = Join-Path $directory $entry[0]
            $files += $path
            [IO.File]::WriteAllText($path, $entry[1], [Text.UTF8Encoding]::new($false))
        }
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
