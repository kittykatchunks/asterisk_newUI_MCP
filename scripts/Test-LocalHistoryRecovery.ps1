[CmdletBinding()]
param([string]$EvidenceDirectory)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $EvidenceDirectory) {
    $EvidenceDirectory = Join-Path $root '.local-proof\queue-abandonment\run-PIl5h8'
}
Push-Location $root
try {
    & npm run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'Local history recovery typecheck failed.' }
    & node --test --test-reporter=dot (Join-Path $root 'tests\history-workspace.test.ts') (Join-Path $root 'tests\history-projection.test.ts') (Join-Path $root 'tests\history-manifest.test.ts') (Join-Path $root 'tests\cel-history.test.ts') (Join-Path $root 'tests\cel-collector.test.ts') (Join-Path $root 'tests\queue-history.test.ts') (Join-Path $root 'tests\queue-collector.test.ts')
    if ($LASTEXITCODE -ne 0) { throw 'Local history recovery regressions failed.' }
    & node (Join-Path $root 'tests\cel-history\local-recovery.ts') $EvidenceDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Local history recovery failed; inspect its owned result directory.' }
} finally { Pop-Location }
