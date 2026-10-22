[CmdletBinding()]
param([Parameter(Mandatory)][string]$Root)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath (Join-Path $Root '.local-proof\engineering\agents.sqlite') -PathType Leaf)) {
    throw 'Agent mode requires an existing operator-provisioned .local-proof\engineering\agents.sqlite.'
}
$accounts = @(Get-Content -LiteralPath (Join-Path $Root '.local-proof\identity\accounts.json') -Raw | ConvertFrom-Json)
if ($accounts.Count -ne 2) { throw 'Agent mode requires the existing synthetic identity accounts.' }
$subjects = @{}
foreach ($account in $accounts) {
    $expectedCustomer = if ($account.username -ceq 'alice') { 'customer-a' } elseif ($account.username -ceq 'bob') { 'customer-b' } else { '' }
    if (-not $expectedCustomer -or $account.customer -cne $expectedCustomer -or
        $account.subject -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
        $subjects.ContainsKey($account.username) -or $subjects.ContainsValue($account.subject)) {
        throw 'Agent mode refuses invalid or duplicate existing identity accounts.'
    }
    $subjects[$account.username] = $account.subject
}
return $subjects
