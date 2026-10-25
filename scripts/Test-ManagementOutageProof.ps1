[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & npm run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'Management outage proof typecheck failed.' }
    & node (Join-Path $root 'tests\management-outage\run.ts')
    if ($LASTEXITCODE -ne 0) { throw 'Management outage continuity proof failed; inspect its owned result directory.' }
} finally { Pop-Location }
