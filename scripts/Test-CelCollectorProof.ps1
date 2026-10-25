[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & npm run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'CEL collector typecheck failed.' }
    & node --test (Join-Path $root 'tests\cel-history.test.ts') (Join-Path $root 'tests\cel-collector.test.ts')
    if ($LASTEXITCODE -ne 0) { throw 'CEL collector/history tests failed.' }
    & node (Join-Path $root 'tests\cel-history\run.ts') --recovery
    if ($LASTEXITCODE -ne 0) { throw 'CEL collector recovery proof failed; inspect its owned result directory.' }
} finally { Pop-Location }
