[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$PlanPath,
    [string]$SchemaPath = "$PSScriptRoot\query-plan.schema.json"
)

$ErrorActionPreference = 'Stop'
function Test-EmptyArrayArtifact($value) {
    if ($null -eq $value) { return $true }
    if ($value -is [array]) { return $true }
    # PowerShell 5.1 parses an empty JSON array as an empty PSCustomObject
    if ($value -is [System.Management.Automation.PSCustomObject] -and @($value.PSObject.Properties).Count -eq 0) { return $true }
    return $false
}
$plan = Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json
$schema = Get-Content -LiteralPath $SchemaPath -Raw | ConvertFrom-Json
$required = @($schema.required)
foreach ($name in $required) {
    if ($null -eq $plan.PSObject.Properties[$name]) { throw "Missing required field: $name" }
}
if ($plan.schemaVersion -ne 1) { throw 'schemaVersion must be 1' }
if ($plan.queryType -notin @('research_only', 'repository_only', 'code_evidence_only', 'integrated_research_and_code')) { throw 'Invalid queryType' }
if ($plan.confidence -lt 0 -or $plan.confidence -gt 1) { throw 'confidence must be between 0 and 1' }
foreach ($name in @('sources', 'repositories', 'engineCandidates', 'reuseCandidates', 'compatibilityRisks', 'verificationPlan')) {
    if (-not (Test-EmptyArrayArtifact $plan.$name)) { throw "$name must be an array" }
}
foreach ($name in @('frameworks', 'versions', 'negations')) {
    if (-not (Test-EmptyArrayArtifact $plan.entities.$name)) { throw "entities.$name must be an array" }
}
Write-Output "VALID query plan: $PlanPath"
