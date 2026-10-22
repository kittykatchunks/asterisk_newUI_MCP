function New-ProofTlsIdentity {
    param(
        [string]$Name,
        [string]$Address = '127.0.0.1',
        [DateTimeOffset]$NotBefore = [DateTimeOffset]::UtcNow.AddMinutes(-5),
        [DateTimeOffset]$NotAfter = [DateTimeOffset]::UtcNow.AddDays(1)
    )
    $rsa = [Security.Cryptography.RSA]::Create(2048)
    try {
        $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
            "CN=AMI TLS proof $Name", $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256,
            [Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
        $san.AddIpAddress([Net.IPAddress]::Parse($Address))
        $request.CertificateExtensions.Add($san.Build())
        $certificate = $request.CreateSelfSigned($NotBefore, $NotAfter)
        try {
            return @{ Certificate = $certificate.ExportCertificatePem(); PrivateKey = $rsa.ExportPkcs8PrivateKeyPem() }
        } finally { $certificate.Dispose() }
    } finally { $rsa.Dispose() }
}
