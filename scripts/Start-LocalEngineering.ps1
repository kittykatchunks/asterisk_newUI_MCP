[CmdletBinding()]
param([switch]$StageCapturedReports, [switch]$WithAgents, [switch]$WithSimulation, [switch]$WithHistory)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Test-IdentityProof.ps1') -Interactive -StageCapturedReports:$StageCapturedReports -WithAgents:$WithAgents -WithSimulation:$WithSimulation -WithHistory:$WithHistory
