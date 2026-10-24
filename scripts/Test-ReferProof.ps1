[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$composeArgs = @('compose', '-f', (Join-Path $root 'compose.yaml'),
    '-f', (Join-Path $root 'compose.refer-proof.yaml'))

function Invoke-Docker {
    param([string[]] $DockerArguments)
    $output = & docker @composeArgs @DockerArguments
    if ($LASTEXITCODE -ne 0) { throw "Docker REFER proof command failed: $($DockerArguments -join ' ')" }
    return ($output -join "`n")
}

function Assert-Match {
    param([string] $Actual, [string] $Pattern, [string] $Message)
    if ($Actual -notmatch $Pattern) { throw "$Message`n$Actual" }
}

$directory = Join-Path $root '.local-proof\customer-a'
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$path = Join-Path $directory 'pjsip.conf'
if (-not (Test-Path -LiteralPath $path)) {
    $template = Get-Content -Raw -LiteralPath (Join-Path $root 'local\sip\endpoint.conf.template')
    $password = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    [IO.File]::WriteAllText($path, $template.Replace('@PASSWORD@', $password).Replace("`r`n", "`n"),
        [Text.UTF8Encoding]::new($false))
}

Invoke-Docker -DockerArguments @('config', '--quiet') | Out-Null
try {
    Invoke-Docker -DockerArguments @('up', '-d', '--force-recreate', '--wait',
        '--wait-timeout', '90', 'customer-a') | Write-Host
    $version = Invoke-Docker -DockerArguments @('exec', '-T', 'customer-a',
        'asterisk', '-rx', 'core show version')
    Assert-Match $version 'Asterisk 22\.11\.0' 'Unexpected Asterisk version.'
    Invoke-Docker -DockerArguments @('exec', '-T', 'customer-a',
        'asterisk', '-rx', 'module load res_pjsip_refer.so') | Write-Host
    $modules = Invoke-Docker -DockerArguments @('exec', '-T', 'customer-a',
        'asterisk', '-rx', 'module show like res_pjsip_refer.so')
    Assert-Match $modules 'res_pjsip_refer\.so[^\r\n]+Running' 'REFER module is not running.'
    $settings = Invoke-Docker -DockerArguments @('exec', '-T', 'customer-a',
        'asterisk', '-rx', 'pjsip show settings')
    Assert-Match $settings '(?m)^\s*norefersub\s*:\s*yes\s*$' 'Expected default norefersub=yes.'
    Invoke-Docker -DockerArguments @('run', '--rm', '--no-deps', 'refer-test-a') | Write-Host
}
finally {
    Invoke-Docker -DockerArguments @('stop', 'customer-a') | Write-Host
}
Write-Host 'PASS rejected-target REFER matrix. Proof PBX stopped; data preserved.'
