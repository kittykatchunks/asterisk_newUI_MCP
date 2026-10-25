[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & npm run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'Queue history typecheck failed.' }
    & node --test (Join-Path $root 'tests\queue-history.test.ts') (Join-Path $root 'tests\cel-history.test.ts') (Join-Path $root 'tests\cel-collector.test.ts')
    if ($LASTEXITCODE -ne 0) { throw 'Queue/CEL/collector foundation tests failed.' }
    & node (Join-Path $root 'tests\cel-history\run.ts') --queue
    if ($LASTEXITCODE -ne 0) { throw 'Queue history proof failed; inspect its owned result directory.' }
} finally { Pop-Location }
