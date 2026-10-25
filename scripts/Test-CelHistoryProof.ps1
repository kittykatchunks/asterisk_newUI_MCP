[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & npm run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'CEL history proof typecheck failed.' }
    & node --test (Join-Path $root 'tests\cel-history.test.ts')
    if ($LASTEXITCODE -ne 0) { throw 'CEL history foundation tests failed.' }
    & node (Join-Path $root 'tests\cel-history\run.ts')
    if ($LASTEXITCODE -ne 0) { throw 'CEL history proof failed; inspect its owned result directory.' }
} finally { Pop-Location }
