[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & npm run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'Configuration inspection typecheck failed.' }
    & node --test --test-reporter=dot (Join-Path $root 'tests\configuration-inspector.test.ts') (Join-Path $root 'tests\configuration-foundation.test.ts') (Join-Path $root 'tests\agent-provisioning-store.test.ts') (Join-Path $root 'tests\history-manifest.test.ts') (Join-Path $root 'tests\history-projection.test.ts')
    if ($LASTEXITCODE -ne 0) { throw 'Configuration inspection regressions failed.' }
    & node (Join-Path $root 'tests\configuration-inspection\run.ts')
    if ($LASTEXITCODE -ne 0) { throw 'Owned read-only configuration inspection proof failed; inspect its result directory.' }
} finally { Pop-Location }
