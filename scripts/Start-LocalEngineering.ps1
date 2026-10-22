[CmdletBinding()]
param([switch]$StageCapturedReports)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Test-IdentityProof.ps1') -Interactive -StageCapturedReports:$StageCapturedReports
