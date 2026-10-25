[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & npm run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'Queue collector typecheck failed.' }
    & node --test --test-reporter=dot (Join-Path $root 'tests\queue-collector.test.ts') (Join-Path $root 'tests\history-projection.test.ts') (Join-Path $root 'tests\history-manifest.test.ts') (Join-Path $root 'tests\queue-history.test.ts') (Join-Path $root 'tests\cel-history.test.ts') (Join-Path $root 'tests\cel-collector.test.ts')
    if ($LASTEXITCODE -ne 0) { throw 'Queue/CEL collector, projection and raw history regressions failed.' }
    & node (Join-Path $root 'tests\cel-history\run.ts') --queue-recovery
    if ($LASTEXITCODE -ne 0) { throw 'Queue collector proof failed; inspect its owned result directory.' }
} finally { Pop-Location }
