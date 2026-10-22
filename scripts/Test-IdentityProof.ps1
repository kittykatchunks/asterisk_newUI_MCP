[CmdletBinding()]
param([switch]$Interactive, [switch]$StageCapturedReports, [switch]$WithAgents)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$compose = Join-Path $root 'compose.identity-proof.yaml'
$directory = Join-Path $root '.local-proof\identity'
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$lock = [IO.File]::Open((Join-Path $directory 'fixture.lock'), [IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
    if ($StageCapturedReports -and -not $Interactive) { throw 'Captured-report staging requires interactive mode.' }
    if ($WithAgents -and -not $Interactive) { throw 'Agent mode requires interactive mode.' }
    $retainedSubjects = @{}
    if ($WithAgents) {
        $retainedSubjects = & (Join-Path $PSScriptRoot 'Read-ProofAgentSubjects.ps1') -Root $root
    }
    $existing = & docker compose -f $compose ps -a --format json
    if ($LASTEXITCODE -ne 0) { throw 'Could not check identity fixture ownership.' }
    if ($existing) { throw 'An identity fixture already exists; stop its owning launcher before starting another.' }
    foreach ($port in @(18080, 18765, 18766)) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
        try { $listener.Start() }
        finally { $listener.Stop() }
    }
    $applicationSecret = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    $accounts = @(
        @{ username = 'alice'; customer = 'customer-a' },
        @{ username = 'bob'; customer = 'customer-b' }
    )
    $users = @()
    $testAccounts = @()
    foreach ($account in $accounts) {
        $id = if ($WithAgents) { $retainedSubjects[$account.username] } else { [guid]::NewGuid().ToString() }
        $password = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
        $users += @{
            id = $id; username = $account.username; enabled = $true
            email = "$($account.username)@example.invalid"; emailVerified = $true
            firstName = 'Synthetic'; lastName = 'Test'
            credentials = @(@{ type = 'password'; value = $password; temporary = $false })
        }
        $testAccounts += @{ subject = $id; username = $account.username; password = $password; customer = $account.customer }
    }
    $realm = @{
        realm = 'local-proof'; enabled = $true; sslRequired = 'none'
        registrationAllowed = $false; resetPasswordAllowed = $false
        accessTokenLifespan = 120; ssoSessionIdleTimeout = 300
        users = $users
        clients = @(@{
            clientId = 'browser-proof'; protocol = 'openid-connect'; enabled = $true
            publicClient = $true; standardFlowEnabled = $true
            directAccessGrantsEnabled = $false; serviceAccountsEnabled = $false
            redirectUris = @('http://127.0.0.1:18765/callback')
            webOrigins = @('http://127.0.0.1:18765')
            attributes = @{ 'pkce.code.challenge.method' = 'S256' }
            protocolMappers = @(@{
                name = 'diagnostic-api-audience'; protocol = 'openid-connect'
                protocolMapper = 'oidc-audience-mapper'
                config = @{
                    'included.custom.audience' = 'diagnostic-api'
                    'access.token.claim' = 'true'; 'id.token.claim' = 'false'
                }
            })
        }, @{
            clientId = 'engineering-app-proof'; protocol = 'openid-connect'; enabled = $true
            publicClient = $false; secret = $applicationSecret; standardFlowEnabled = $true
            directAccessGrantsEnabled = $false; serviceAccountsEnabled = $false
            redirectUris = @('http://127.0.0.1:18766/auth/callback')
            webOrigins = @()
            attributes = @{ 'pkce.code.challenge.method' = 'S256' }
            protocolMappers = @(@{
                name = 'diagnostic-api-audience'; protocol = 'openid-connect'
                protocolMapper = 'oidc-audience-mapper'
                config = @{
                    'included.custom.audience' = 'diagnostic-api'
                    'access.token.claim' = 'true'; 'id.token.claim' = 'false'
                }
            })
        })
    }
    foreach ($item in @(
        @{ name = 'realm.json'; value = $realm },
        @{ name = 'accounts.json'; value = $testAccounts },
        @{ name = 'application-client.json'; value = @{ clientId = 'engineering-app-proof'; secret = $applicationSecret } }
    )) {
        [IO.File]::WriteAllText((Join-Path $directory $item.name),
            (ConvertTo-Json -InputObject $item.value -Depth 15), [Text.UTF8Encoding]::new($false))
    }

    try {
        & docker compose -f $compose up -d --force-recreate
        if ($LASTEXITCODE -ne 0) { throw 'Identity container startup failed.' }
        $deadline = (Get-Date).AddSeconds(120)
        while ($true) {
            $state = & docker compose -f $compose ps -a --format json | ConvertFrom-Json
            if ($LASTEXITCODE -ne 0) { throw 'Could not inspect identity startup.' }
            if ($state.State -eq 'exited') {
                & docker compose -f $compose logs --tail 50
                throw 'Keycloak exited during startup.'
            }
            # Non-success HTTP and transport errors are retried only during bounded startup.
            $ready = & curl.exe --silent --output NUL --write-out '%{http_code}' --max-time 2 `
                'http://127.0.0.1:18080/realms/local-proof/.well-known/openid-configuration'
            if ($LASTEXITCODE -eq 0 -and $ready -eq '200') { break }
            if ((Get-Date) -ge $deadline) {
                & docker compose -f $compose logs --tail 50
                throw 'Keycloak discovery did not become ready within 120 seconds.'
            }
            Start-Sleep -Seconds 1
        }
        Push-Location $root
        try {
            & npm run typecheck
            if ($LASTEXITCODE -ne 0) { throw 'Identity proof typecheck failed.' }
            if ($Interactive) {
                $arguments = @('.\scripts\Start-LocalEngineering.ts')
                if ($StageCapturedReports) { $arguments += '--stage-captured-reports' }
                if ($WithAgents) { $arguments += '--with-agents' }
                & node @arguments
                if ($LASTEXITCODE -ne 0) { throw 'Interactive engineering application failed.' }
            } else {
                & npm run test:identity
                if ($LASTEXITCODE -ne 0) { throw 'Identity browser proof failed.' }
                & npm run test:app-session
                if ($LASTEXITCODE -ne 0) { throw 'Application session proof failed.' }
                & npm run test:launcher
                if ($LASTEXITCODE -ne 0) { throw 'Local engineering launcher proof failed.' }
            }
        } finally { Pop-Location }
    } finally {
        & docker compose -f $compose down
        if ($LASTEXITCODE -ne 0) { throw 'Identity fixture cleanup failed.' }
    }
} finally { $lock.Dispose() }
