<#
.SYNOPSIS
Performs read-only post-deployment checks for the Teams SRE Agent bridge.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $TenantId,
  [Parameter(Mandatory)] [string] $SubscriptionId,
  [Parameter(Mandatory)] [string] $ResourceGroup,
  [Parameter(Mandatory)] [string] $AppName,
  [Parameter(Mandatory)] [string] $SreAgentResourceId,
  [string] $StorageAccountName,
  [string] $OAuthConnectionName = 'sre-obo',
  [string] $SreAgentScope = 'https://azuresre.dev/.default',
  [string] $SreAgentDelegatedScope = 'https://azuresre.dev/Threads.ReadWrite.All',
  [string] $TeamsPackagePath,
  [ValidateRange(1, 120)] [int] $HealthTimeoutSeconds = 30,
  [switch] $NoExitOnFailure
)

$ErrorActionPreference = 'Stop'
$script:checks = New-Object System.Collections.ArrayList

function Require-Command([string] $Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { throw "Required command '$Name' was not found on PATH." }
}

function Invoke-Az([string[]] $Arguments) {
  $stderrFile = [System.IO.Path]::GetTempFileName()
  $previousPreference = $ErrorActionPreference
  $output = @()
  $exitCode = 1
  try {
    $ErrorActionPreference = 'Continue'
    $LASTEXITCODE = 0
    $output = & az @Arguments 2> $stderrFile
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
    Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
  }
  if ($exitCode -ne 0) {
    $verb = if ($Arguments.Length -ge 2) { "$($Arguments[0]) $($Arguments[1])" } else { $Arguments[0] }
    throw "Azure CLI command failed: az $verb."
  }
  return (($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine)
}

function Get-AzScalar([string[]] $Arguments) { return (Invoke-Az $Arguments).Trim() }

function Add-Check([string] $Name, [scriptblock] $Action) {
  try {
    & $Action | Out-Null
    [void]$script:checks.Add([pscustomobject]@{ Name = $Name; Passed = $true; Details = 'Passed' })
  }
  catch {
    # Check implementations use deliberately non-sensitive error messages.
    [void]$script:checks.Add([pscustomobject]@{ Name = $Name; Passed = $false; Details = $_.Exception.Message })
  }
}

function Get-PropertyValue($Object, [string] $Name) {
  $property = $Object.PSObject.Properties[$Name]
  if ($property) { return $property.Value }
  return $null
}

function Get-ExpectedStorageName {
  if ($StorageAccountName) { return $StorageAccountName }
  $name = ($AppName.ToLowerInvariant().Replace('-', '') + 'st')
  return $name.Substring(0, [Math]::Min(24, $name.Length))
}

function Assert-RoleAssignment([string] $PrincipalId, [string] $Scope, [string] $RoleName, [string] $ScopeSubscriptionId = $SubscriptionId) {
  $text = Invoke-Az @('role', 'assignment', 'list', '--assignee-object-id', $PrincipalId, '--fill-principal-name', 'false', '--scope', $Scope, '--subscription', $ScopeSubscriptionId, '--query', "[?roleDefinitionName=='$RoleName']", '--output', 'json')
  try { $assignmentResponse = $text | ConvertFrom-Json; $assignments = @($assignmentResponse | Where-Object { $null -ne $_ }) } catch { throw "Unable to read '$RoleName' role assignments." }
  if ($assignments.Count -lt 1) { throw "Missing '$RoleName' role assignment." }
}

function Get-TeamsManifest([string] $Path) {
  if (Test-Path -LiteralPath $Path -PathType Container) {
    $manifestPath = Join-Path $Path 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Teams package directory has no root manifest.json.' }
    return (([System.IO.File]::ReadAllText($manifestPath)) | ConvertFrom-Json)
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Teams package '$Path' was not found." }
  Add-Type -AssemblyName System.IO.Compression
  $stream = $null; $archive = $null
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    $archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Read, $false)
    $actualEntries = @($archive.Entries | ForEach-Object { $_.FullName } | Sort-Object)
    $expectedEntries = @('color.png', 'manifest.json', 'outline.png')
    if (($actualEntries -join "`n") -ne ($expectedEntries -join "`n")) {
      throw 'Teams package ZIP must contain exactly root manifest.json, color.png, and outline.png.'
    }
    $entry = @($archive.Entries | Where-Object { $_.FullName -eq 'manifest.json' })
    if ($entry.Count -ne 1) { throw 'Teams package must contain manifest.json at its ZIP root.' }
    $reader = New-Object System.IO.StreamReader($entry[0].Open())
    try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
  }
  finally {
    if ($archive) { $archive.Dispose() }
    if ($stream) { $stream.Dispose() }
  }
}

Require-Command az
$contextValid = $false
Add-Check 'AzureContext' {
  $text = Invoke-Az @('account', 'show', '--subscription', $SubscriptionId, '--output', 'json')
  try { $account = $text | ConvertFrom-Json } catch { throw 'Azure CLI returned an invalid account context response.' }
  if ([string]$account.id -ine $SubscriptionId) { throw "Azure subscription mismatch: requested '$SubscriptionId'." }
  if ([string]$account.tenantId -ine $TenantId) { throw "Azure tenant mismatch: requested '$TenantId'." }
  if ([string]$account.state -ine 'Enabled') { throw "Azure subscription '$SubscriptionId' is not enabled." }
  $script:contextValid = $true
}

if ($contextValid) {
  $appHostName = $null
  $principalId = $null
  Add-Check 'AppServiceRunningAndHealth' {
    $state = Get-AzScalar @('webapp', 'show', '--resource-group', $ResourceGroup, '--name', $AppName, '--subscription', $SubscriptionId, '--query', 'state', '--output', 'tsv')
    if ($state -ine 'Running') { throw "App Service state is '$state', not Running." }
    $script:appHostName = Get-AzScalar @('webapp', 'show', '--resource-group', $ResourceGroup, '--name', $AppName, '--subscription', $SubscriptionId, '--query', 'defaultHostName', '--output', 'tsv')
    if (-not $script:appHostName) { throw 'App Service did not return a default host name.' }
    $response = Invoke-WebRequest -Uri "https://$script:appHostName/healthz" -UseBasicParsing -TimeoutSec $HealthTimeoutSeconds
    if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) { throw 'App Service /healthz did not return a success status.' }
  }
  Add-Check 'ManagedIdentity' {
    $identityText = Invoke-Az @('webapp', 'identity', 'show', '--resource-group', $ResourceGroup, '--name', $AppName, '--subscription', $SubscriptionId, '--output', 'json')
    try { $identity = $identityText | ConvertFrom-Json } catch { throw 'App Service managed identity response was invalid.' }
    $script:principalId = [string]$identity.principalId
    if (-not $script:principalId) { throw 'App Service has no system-assigned managed identity.' }
  }
  Add-Check 'BotEndpoint' {
    if (-not $script:appHostName) { $script:appHostName = Get-AzScalar @('webapp', 'show', '--resource-group', $ResourceGroup, '--name', $AppName, '--subscription', $SubscriptionId, '--query', 'defaultHostName', '--output', 'tsv') }
    $botText = Invoke-Az @('bot', 'show', '--resource-group', $ResourceGroup, '--name', $AppName, '--subscription', $SubscriptionId, '--output', 'json')
    try { $bot = $botText | ConvertFrom-Json } catch { throw 'Azure Bot response was invalid.' }
    $botProperties = if ($bot.properties) { $bot.properties } else { $bot }
    $script:botAppId = [string] $botProperties.msaAppId
    if (-not $script:botAppId) { throw 'Azure Bot has no Microsoft application ID.' }
    if ([string] $botProperties.msaAppTenantId -ine $TenantId) { throw 'Azure Bot tenant does not match the requested tenant.' }
    $actual = [string] $botProperties.endpoint
    $expected = "https://$script:appHostName/api/messages"
    if ($actual -ine $expected) { throw 'Bot endpoint does not point to this App Service /api/messages endpoint.' }
  }
  Add-Check 'OAuthConnection' {
    $connectionText = Invoke-Az @('bot', 'authsetting', 'show', '--resource-group', $ResourceGroup, '--name', $AppName, '--setting-name', $OAuthConnectionName, '--subscription', $SubscriptionId, '--output', 'json')
    try { $connection = $connectionText | ConvertFrom-Json } catch { throw 'Bot OAuth connection response was invalid.' }
    $connectionProperties = Get-PropertyValue $connection 'properties'
    if ($connectionProperties) { $connection = $connectionProperties }

    $providersText = Invoke-Az @('bot', 'authsetting', 'list-providers', '--subscription', $SubscriptionId, '--output', 'json')
    try { $providersResponse = $providersText | ConvertFrom-Json } catch { throw 'Bot OAuth provider metadata response was invalid.' }
    $providers = Get-PropertyValue $providersResponse 'value'
    if ($null -eq $providers) { $providers = $providersResponse }
    $aadV2Providers = @($providers | Where-Object {
      $properties = Get-PropertyValue $_ 'properties'
      $properties -and [string](Get-PropertyValue $properties 'serviceProviderName') -ieq 'Aadv2'
    })
    if ($aadV2Providers.Count -ne 1) { throw 'Azure AD v2 OAuth provider metadata was not uniquely available.' }
    $aadV2Properties = Get-PropertyValue $aadV2Providers[0] 'properties'
    $expectedProviderId = [string](Get-PropertyValue $aadV2Properties 'id')
    $expectedProviderName = [string](Get-PropertyValue $aadV2Properties 'serviceProviderName')
    if (-not $expectedProviderId -or -not $expectedProviderName) { throw 'Azure AD v2 OAuth provider metadata is incomplete.' }

    $provider = [string](Get-PropertyValue $connection 'serviceProviderId')
    if (-not $provider) { $provider = [string](Get-PropertyValue $connection 'providerId') }
    if ($provider -ine $expectedProviderId -and $provider -ine $expectedProviderName) { throw 'Bot OAuth connection is not an Azure AD v2 connection.' }
    $connectionName = @(([string] (Get-PropertyValue $connection 'name')) -split '/')[-1]
    if (-not $connectionName) { $connectionName = @(([string] (Get-PropertyValue ($connectionText | ConvertFrom-Json) 'name')) -split '/')[-1] }
    if ($connectionName -cne $OAuthConnectionName) { throw 'Bot OAuth connection name does not match the requested connection.' }
    if ([string](Get-PropertyValue $connection 'provisioningState') -ine 'Succeeded') { throw 'Bot OAuth connection provisioning state is not Succeeded.' }
    if (-not $script:botAppId) { throw 'Cannot validate OAuth client ID without Azure Bot metadata.' }
    if ([string](Get-PropertyValue $connection 'clientId') -ine $script:botAppId) { throw 'Bot OAuth connection client ID does not match the Azure Bot application.' }
    $parameters = @(Get-PropertyValue $connection 'parameters')
    $tenantParameters = @($parameters | Where-Object { [string] $_.key -ieq 'TenantId' })
    $tokenExchangeParameters = @($parameters | Where-Object { [string] $_.key -ieq 'TokenExchangeUrl' })
    if ($tenantParameters.Count -ne 1 -or [string] $tenantParameters[0].value -ine $TenantId) { throw 'Bot OAuth connection tenant parameter is invalid.' }
    if ($tokenExchangeParameters.Count -ne 1 -or [string] $tokenExchangeParameters[0].value -cne "api://botid-$script:botAppId") { throw 'Bot OAuth connection token-exchange URL is invalid.' }
    $configuredScopes = Get-PropertyValue $connection 'scopes'
    $scopes = if ($configuredScopes -is [string]) { @($configuredScopes -split '\s+' | Where-Object { $_ }) } else { @($configuredScopes) }
    if (-not (@($scopes | Where-Object { [string]$_ -ieq $SreAgentDelegatedScope }).Count -gt 0)) { throw 'Bot OAuth connection does not contain the expected delegated SRE Agent scope.' }
    if (@($scopes | Where-Object { [string]$_ -ieq $SreAgentScope }).Count -gt 0) { throw 'Bot OAuth connection incorrectly uses the managed identity .default scope as a delegated scope.' }
  }
  Add-Check 'SreAgentManagedIdentityScope' {
    $settingsText = Invoke-Az @('webapp', 'config', 'appsettings', 'list', '--resource-group', $ResourceGroup, '--name', $AppName, '--subscription', $SubscriptionId, '--output', 'json')
    try { $settingsResponse = $settingsText | ConvertFrom-Json; $settings = @($settingsResponse) } catch { throw 'App Service settings response was invalid.' }
    $configuredScope = [string]((@($settings | Where-Object { $_.name -eq 'SRE_AGENT_SCOPE' }) | Select-Object -First 1).value)
    if ($configuredScope -ine $SreAgentScope) { throw 'SRE_AGENT_SCOPE does not contain the expected managed identity scope.' }
  }
  Add-Check 'StorageTableDataContributor' {
    if (-not $script:principalId) { throw 'Cannot validate storage role without an App Service managed identity.' }
    $settingsText = Invoke-Az @('webapp', 'config', 'appsettings', 'list', '--resource-group', $ResourceGroup, '--name', $AppName, '--subscription', $SubscriptionId, '--output', 'json')
    try { $settingsResponse = $settingsText | ConvertFrom-Json; $settings = @($settingsResponse) } catch { throw 'App Service settings response was invalid.' }
    $tableEndpoint = [string]((@($settings | Where-Object { $_.name -eq 'THREAD_TABLE_ENDPOINT' }) | Select-Object -First 1).value)
    if (-not $tableEndpoint) { throw 'THREAD_TABLE_ENDPOINT is not configured.' }
    try { $configuredStorageName = ([Uri]$tableEndpoint).Host.Split('.')[0] } catch { throw 'THREAD_TABLE_ENDPOINT is not a valid URI.' }
    $expectedStorageName = Get-ExpectedStorageName
    if ($configuredStorageName -ine $expectedStorageName) { throw 'THREAD_TABLE_ENDPOINT does not match the configured storage account.' }
    $storageScope = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Storage/storageAccounts/$expectedStorageName"
    Assert-RoleAssignment $script:principalId $storageScope 'Storage Table Data Contributor'
  }
  Add-Check 'SreAgentStandardUser' {
    $guidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    if ($SreAgentResourceId -notmatch "^/subscriptions/(?<subscription>$guidPattern)/resourceGroups/[^/]+/providers/Microsoft\.App/agents/[^/]+$") { throw 'SreAgentResourceId must be an exact Microsoft.App/agents ARM resource ID with a GUID subscription.' }
    $agentSubscriptionId = [string] $Matches.subscription
    $agentAccountText = Invoke-Az @('account', 'show', '--subscription', $agentSubscriptionId, '--output', 'json')
    try { $agentAccount = $agentAccountText | ConvertFrom-Json } catch { throw 'Azure CLI returned an invalid SRE Agent subscription context response.' }
    if ([string] $agentAccount.id -ine $agentSubscriptionId) { throw 'Azure CLI returned the wrong SRE Agent subscription context.' }
    if ([string] $agentAccount.tenantId -ine $TenantId) { throw 'The SRE Agent subscription is not in the requested tenant; cross-tenant role assignment is unsupported.' }
    if ([string] $agentAccount.state -ine 'Enabled') { throw 'The SRE Agent subscription is not enabled.' }
    if (-not $script:principalId) { throw 'Cannot validate SRE Agent role without an App Service managed identity.' }
    Assert-RoleAssignment $script:principalId $SreAgentResourceId 'SRE Agent Standard User' $agentSubscriptionId
  }
  if ($TeamsPackagePath) {
    Add-Check 'TeamsPackage' {
      $manifest = Get-TeamsManifest $TeamsPackagePath
      if (-not $manifest.manifestVersion -or -not $manifest.bots) { throw 'Teams manifest is missing required bot metadata.' }
      if (-not (@($manifest.validDomains) | Where-Object { [string]$_ -ieq $script:appHostName }).Count) { throw 'Teams manifest validDomains does not include the App Service host name.' }
    }
  }
}
else {
  [void]$script:checks.Add([pscustomobject]@{ Name = 'DeploymentChecks'; Passed = $false; Details = 'Skipped because Azure context validation failed.' })
}

$result = [pscustomobject]@{
  Succeeded = -not (@($script:checks | Where-Object { -not $_.Passed }).Count -gt 0)
  Checks = @($script:checks)
}
Write-Output $result
if (-not $result.Succeeded -and -not $NoExitOnFailure) { exit 1 }
