[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & npm run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'PBX epoch recovery typecheck failed.' }
    & node --test --test-reporter=dot (Join-Path $root 'tests\history-workspace.test.ts') (Join-Path $root 'tests\history-projection.test.ts') (Join-Path $root 'tests\history-manifest.test.ts') (Join-Path $root 'tests\cel-history.test.ts') (Join-Path $root 'tests\cel-collector.test.ts') (Join-Path $root 'tests\queue-history.test.ts') (Join-Path $root 'tests\queue-collector.test.ts')
    if ($LASTEXITCODE -ne 0) { throw 'PBX epoch recovery regressions failed.' }
    & node (Join-Path $root 'tests\cel-history\run.ts') --epochs
    if ($LASTEXITCODE -ne 0) { throw 'PBX epoch recovery failed; inspect its owned result directory.' }
} finally { Pop-Location }
