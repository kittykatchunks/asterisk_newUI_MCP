[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & npm run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'History marker typecheck failed.' }
    & node --test (Join-Path $root 'tests\history-manifest.test.ts') (Join-Path $root 'tests\queue-history.test.ts') (Join-Path $root 'tests\cel-history.test.ts') (Join-Path $root 'tests\cel-collector.test.ts')
    if ($LASTEXITCODE -ne 0) { throw 'Manifest/marker/CEL/queue/collector tests failed.' }
    & node (Join-Path $root 'tests\cel-history\run.ts') --markers
    if ($LASTEXITCODE -ne 0) { throw 'History marker proof failed; inspect its owned result directory.' }
} finally { Pop-Location }
