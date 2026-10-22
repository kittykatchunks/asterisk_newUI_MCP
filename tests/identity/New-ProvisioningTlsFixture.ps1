$ErrorActionPreference = 'Stop'
$rootKey = [Security.Cryptography.RSA]::Create(2048)
$root = $null
try {
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
        'CN=Isolated provisioning test CA', $rootKey, [Security.Cryptography.HashAlgorithmName]::SHA256,
        [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true))
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
        [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign, $true))
    $root = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-3), [DateTimeOffset]::UtcNow.AddDays(3))
    $result = @{ ca = $root.ExportCertificatePem() }
    foreach ($name in @('worker', 'controller', 'foreign', 'mismatch', 'expired', 'untrusted')) {
        $key = [Security.Cryptography.RSA]::Create(2048)
        $certificate = $null
        try {
            $leaf = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
                "CN=Provisioning proof $name", $key, [Security.Cryptography.HashAlgorithmName]::SHA256,
                [Security.Cryptography.RSASignaturePadding]::Pkcs1)
            $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
            $san.AddDnsName($(if ($name -eq 'mismatch') { 'wrong.invalid' } else { 'localhost' }))
            $leaf.CertificateExtensions.Add($san.Build())
            $leaf.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
            $usages = [Security.Cryptography.OidCollection]::new()
            [void]$usages.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
            [void]$usages.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.2'))
            $leaf.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($usages, $true))
            $before = [DateTimeOffset]::UtcNow.AddMinutes(-5)
            $after = [DateTimeOffset]::UtcNow.AddDays(1)
            if ($name -eq 'expired') {
                $before = [DateTimeOffset]::UtcNow.AddDays(-2)
                $after = [DateTimeOffset]::UtcNow.AddDays(-1)
            }
            if ($name -eq 'untrusted') {
                $certificate = $leaf.CreateSelfSigned($before, $after)
            } else {
                $serial = [Security.Cryptography.RandomNumberGenerator]::GetBytes(16)
                $certificate = $leaf.Create($root, $before, $after, $serial)
            }
            $result[$name] = @{ cert = $certificate.ExportCertificatePem(); key = $key.ExportPkcs8PrivateKeyPem() }
        } finally {
            if ($certificate) { $certificate.Dispose() }
            $key.Dispose()
        }
    }
    $result | ConvertTo-Json -Depth 3 -Compress
} finally {
    if ($root) { $root.Dispose() }
    $rootKey.Dispose()
}
