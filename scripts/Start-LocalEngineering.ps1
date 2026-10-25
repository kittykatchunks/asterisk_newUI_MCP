[CmdletBinding()]
param([switch]$StageCapturedReports, [switch]$WithAgents, [switch]$WithSimulation)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Test-IdentityProof.ps1') -Interactive -StageCapturedReports:$StageCapturedReports -WithAgents:$WithAgents -WithSimulation:$WithSimulation
