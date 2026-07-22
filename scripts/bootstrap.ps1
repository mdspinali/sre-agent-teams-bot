<#
.SYNOPSIS
Creates/configures the bot Entra application or its Bot Service OAuth connection.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [ValidateSet('appreg', 'oauth')] [string] $Phase,
  [Parameter(Mandatory)] [string] $TenantId,
  [Parameter(Mandatory)] [string] $SubscriptionId,
  [string] $DisplayName = 'SRE Agent Teams Bridge',
  [string] $ResourceGroup,
  [string] $BotName,
  [string] $BotAppId,
  [string] $BotAppSecret,
  [string] $ConnectionName = 'sre-obo',
  [switch] $CreateClientSecret,
  [string] $SecretOutputPath,
  [switch] $GrantAdminConsent,
  [switch] $ReplaceOAuthConnection
)

$ErrorActionPreference = 'Stop'
$sreResource = 'https://azuresre.dev'
$sreScopeName = 'Threads.ReadWrite.All'
$sreDelegatedScope = "$sreResource/$sreScopeName"
$redirectUri = 'https://token.botframework.com/.auth/web/redirect'

function Assert-Guid([string] $Value, [string] $Name) {
  $guid = [Guid]::Empty
  if (-not [Guid]::TryParse($Value, [ref] $guid) -or $guid -eq [Guid]::Empty) {
    throw "-$Name must be a GUID."
  }
}

# The Windows Azure CLI launcher is a .cmd file. Invoke its Python entry point
# directly when available so secrets containing cmd.exe metacharacters survive.
$script:azCommand = Get-Command az -ErrorAction Stop
$script:azPrefix = @()
if ($script:azCommand.CommandType -eq 'Application' -and $script:azCommand.Source -like '*.cmd') {
  $python = Join-Path (Split-Path (Split-Path $script:azCommand.Source -Parent) -Parent) 'python.exe'
  if (Test-Path -LiteralPath $python -PathType Leaf) {
    $script:azCommand = $python
    $script:azPrefix = @('-IBm', 'azure.cli')
  }
}

function Invoke-Az([string[]] $Arguments, [string] $Operation) {
  $stderr = [IO.Path]::GetTempFileName()
  $oldPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = 0
    $output = @(& $script:azCommand @script:azPrefix @Arguments --only-show-errors 2> $stderr)
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $oldPreference
    Remove-Item -LiteralPath $stderr -Force -ErrorAction SilentlyContinue
  }
  if ($exitCode -ne 0) { throw "Azure CLI failed while $Operation (exit code $exitCode)." }
  return (($output | ForEach-Object { [string] $_ }) -join [Environment]::NewLine).Trim()
}

function Invoke-AzJson([string[]] $Arguments, [string] $Operation) {
  $text = Invoke-Az $Arguments $Operation
  if (-not $text) { throw "Azure CLI returned no data while $Operation." }
  try { return ,($text | ConvertFrom-Json) }
  catch { throw "Azure CLI returned invalid JSON while $Operation." }
}

function Assert-Context {
  $account = Invoke-AzJson @('account', 'show', '--subscription', $SubscriptionId, '-o', 'json') 'validating Azure context'
  if ([string] $account.id -ine $SubscriptionId -or [string] $account.tenantId -ine $TenantId -or [string] $account.state -ine 'Enabled') {
    throw 'The requested Azure tenant/subscription context is not enabled or does not match.'
  }
  $null = Invoke-Az @('account', 'set', '--subscription', $SubscriptionId) 'selecting the Azure subscription'
}

function Write-SecretFile([string] $Path, [string] $Secret) {
  $fullPath = [IO.Path]::GetFullPath($Path)
  if (Test-Path -LiteralPath $fullPath) { throw "Secret file '$fullPath' already exists." }
  $parent = Split-Path -Parent $fullPath
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw "Secret directory '$parent' does not exist." }
  [IO.File]::WriteAllText($fullPath, $Secret, (New-Object Text.UTF8Encoding($false)))
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = New-Object Security.AccessControl.FileSecurity
  $acl.SetOwner($identity)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')))
  Set-Acl -LiteralPath $fullPath -AclObject $acl
  return $fullPath
}

function Test-Permission($App, [string] $ResourceAppId, [string] $ScopeId) {
  foreach ($resource in @($App.requiredResourceAccess)) {
    if ([string] $resource.resourceAppId -ieq $ResourceAppId) {
      foreach ($access in @($resource.resourceAccess)) {
        if ([string] $access.id -ieq $ScopeId -and [string] $access.type -ieq 'Scope') { return $true }
      }
    }
  }
  return $false
}

function Get-Provider {
  $result = Invoke-AzJson @('bot', 'authsetting', 'list-providers', '--provider-name', 'Aadv2', '--subscription', $SubscriptionId, '-o', 'json') 'resolving the Aadv2 provider'
  $items = if ($result.value) { @($result.value) } else { @($result) }
  $providers = @($items | ForEach-Object { if ($_.properties) { $_.properties } else { $_ } } | Where-Object { $_.serviceProviderName -ieq 'Aadv2' })
  if ($providers.Count -ne 1 -or -not $providers[0].id) { throw 'Aadv2 provider metadata is unavailable.' }
  return $providers[0]
}

function Get-Parameter($Setting, [string] $Name) {
  $matches = @($Setting.parameters | Where-Object { $_.key -ieq $Name })
  if ($matches.Count -ne 1) { return $null }
  return [string] $matches[0].value
}

function Test-Connection($Resource, [string] $ProviderId) {
  if (-not $Resource) { return $false }
  $setting = if ($Resource.properties) { $Resource.properties } else { $Resource }
  $name = @(([string] $Resource.name) -split '/')[-1]
  return $name -ceq $ConnectionName -and
    [string] $setting.serviceProviderId -ieq $ProviderId -and
    [string] $setting.clientId -ieq $BotAppId -and
    [string] $setting.scopes -ceq $sreDelegatedScope -and
    [string] $setting.provisioningState -ieq 'Succeeded' -and
    (Get-Parameter $setting 'TenantId') -ieq $TenantId -and
    (Get-Parameter $setting 'TokenExchangeUrl') -ceq "api://botid-$BotAppId"
}

Assert-Guid $TenantId 'TenantId'
Assert-Guid $SubscriptionId 'SubscriptionId'
if ($BotAppId) { Assert-Guid $BotAppId 'BotAppId' }
Assert-Context

if ($Phase -eq 'appreg') {
  if (-not $BotAppId) {
    $matches = @(Invoke-AzJson @('ad', 'app', 'list', '--display-name', $DisplayName, '-o', 'json') 'checking the application display name' | Where-Object { $_.displayName -ceq $DisplayName })
    if ($matches.Count) { throw "An application named '$DisplayName' already exists; rerun with its explicit -BotAppId." }
    $BotAppId = [string] (Invoke-AzJson @('ad', 'app', 'create', '--display-name', $DisplayName, '--sign-in-audience', 'AzureADMyOrg', '-o', 'json') 'creating the bot application').appId
  }
  $app = Invoke-AzJson @('ad', 'app', 'show', '--id', $BotAppId, '-o', 'json') 'reading the bot application'
  if ([string] $app.appId -ine $BotAppId) { throw 'The bot application ID does not match.' }

  $srePrincipals = @(Invoke-AzJson @('ad', 'sp', 'list', '--spn', $sreResource, '-o', 'json') 'resolving Azure SRE Agent' | Where-Object { @($_.servicePrincipalNames) -contains $sreResource })
  if ($srePrincipals.Count -ne 1) { throw 'Azure SRE Agent service-principal metadata is unavailable.' }
  $srePrincipal = $srePrincipals[0]
  $scope = @($srePrincipal.oauth2PermissionScopes | Where-Object { $_.value -ceq $sreScopeName -and $_.isEnabled -ne $false })
  if ($scope.Count -ne 1) { throw "Azure SRE Agent does not expose $sreScopeName." }

  $identifierUri = "api://botid-$BotAppId"
  $identifierUris = @($app.identifierUris | Where-Object { $_ })
  if ($identifierUris -notcontains $identifierUri) { $identifierUris += $identifierUri }
  $redirectUris = @($app.web.redirectUris | Where-Object { $_ })
  if ($redirectUris -notcontains $redirectUri) { $redirectUris += $redirectUri }
  $null = Invoke-Az (@('ad', 'app', 'update', '--id', $BotAppId, '--sign-in-audience', 'AzureADMyOrg', '--identifier-uris') + $identifierUris + @('--web-redirect-uris') + $redirectUris) 'configuring the bot application'
  if (-not (Test-Permission $app $srePrincipal.appId $scope[0].id)) {
    $null = Invoke-Az @('ad', 'app', 'permission', 'add', '--id', $BotAppId, '--api', $srePrincipal.appId, '--api-permissions', "$($scope[0].id)=Scope") 'declaring the SRE delegated permission'
  }

  $principals = @(Invoke-AzJson @('ad', 'sp', 'list', '--filter', "appId eq '$BotAppId'", '-o', 'json') 'reading the bot service principal')
  if ($principals.Count -eq 0) {
    $null = Invoke-AzJson @('ad', 'sp', 'create', '--id', $BotAppId, '-o', 'json') 'creating the bot service principal'
    $principals = @(Invoke-AzJson @('ad', 'sp', 'list', '--filter', "appId eq '$BotAppId'", '-o', 'json') 'verifying the bot service principal')
  }
  if ($principals.Count -ne 1 -or [string] $principals[0].appId -ine $BotAppId -or $principals[0].accountEnabled -eq $false) { throw 'Bot service-principal verification failed.' }

  if ($GrantAdminConsent) {
    $null = Invoke-Az @('ad', 'app', 'permission', 'admin-consent', '--id', $BotAppId) 'granting admin consent'
  }
  $secretPath = $null
  if ($CreateClientSecret) {
    if (-not $SecretOutputPath) { throw '-SecretOutputPath is required with -CreateClientSecret.' }
    $secret = Invoke-Az @('ad', 'app', 'credential', 'reset', '--id', $BotAppId, '--append', '--display-name', 'bot-secret', '--query', 'password', '-o', 'tsv') 'creating the bot client secret'
    if (-not $secret) { throw 'Azure CLI did not return the bot client secret.' }
    $secretPath = Write-SecretFile $SecretOutputPath $secret
  }
  [pscustomobject]@{
    TenantId = $TenantId; SubscriptionId = $SubscriptionId; BotAppId = $BotAppId
    BotApplicationObjectId = [string] $app.id; BotServicePrincipalId = [string] $principals[0].id
    SecretOutputPath = $secretPath; ConsentRequired = -not $GrantAdminConsent
    AdminConsentCommand = if ($GrantAdminConsent) { $null } else { "az ad app permission admin-consent --id $BotAppId" }
  }
  return
}

foreach ($name in @('ResourceGroup', 'BotName', 'BotAppId')) {
  if ([string]::IsNullOrWhiteSpace([string] (Get-Variable $name -ValueOnly))) { throw "-$name is required for phase oauth." }
}
$group = Invoke-AzJson @('group', 'show', '--name', $ResourceGroup, '--subscription', $SubscriptionId, '-o', 'json') 'reading the resource group'
$bot = Invoke-AzJson @('bot', 'show', '-g', $ResourceGroup, '-n', $BotName, '--subscription', $SubscriptionId, '-o', 'json') 'reading the Azure Bot'
if (-not $group.id -or [string] $bot.properties.msaAppId -ine $BotAppId -or [string] $bot.properties.msaAppTenantId -ine $TenantId) {
  throw 'The resource group, bot application, and tenant association do not match.'
}

$provider = Get-Provider
$connections = @(Invoke-AzJson @('bot', 'authsetting', 'list', '-g', $ResourceGroup, '-n', $BotName, '--subscription', $SubscriptionId, '-o', 'json') 'listing OAuth connections')
$listed = @($connections | Where-Object { @(([string] $_.name) -split '/')[-1] -ceq $ConnectionName })
$existing = if ($listed.Count -eq 1) { Invoke-AzJson @('bot', 'authsetting', 'show', '-g', $ResourceGroup, '-n', $BotName, '-c', $ConnectionName, '--subscription', $SubscriptionId, '-o', 'json') 'reading the OAuth connection' } else { $null }
if (Test-Connection $existing $provider.id) {
  [pscustomobject]@{ ConnectionName = $ConnectionName; ProvisioningState = 'Succeeded'; Changed = $false }
  return
}
if ($existing -and -not $ReplaceOAuthConnection) { throw "OAuth connection '$ConnectionName' differs; use -ReplaceOAuthConnection after review." }
if (-not $BotAppSecret) { throw '-BotAppSecret is required to create or replace the OAuth connection.' }

$null = Invoke-AzJson @(
  'bot', 'authsetting', 'create', '-g', $ResourceGroup, '-n', $BotName, '-c', $ConnectionName,
  '--service', $provider.serviceProviderName, '--client-id', $BotAppId, '--client-secret', $BotAppSecret,
  '--parameters', "TenantId=$TenantId", "TokenExchangeUrl=api://botid-$BotAppId",
  '--provider-scope-string', $sreDelegatedScope, '--subscription', $SubscriptionId, '-o', 'json'
) 'creating the OAuth connection'
$created = Invoke-AzJson @('bot', 'authsetting', 'show', '-g', $ResourceGroup, '-n', $BotName, '-c', $ConnectionName, '--subscription', $SubscriptionId, '-o', 'json') 'verifying the OAuth connection'
if (-not (Test-Connection $created $provider.id)) { throw 'OAuth connection readback did not match the requested configuration.' }
[pscustomobject]@{ ConnectionName = $ConnectionName; ProvisioningState = 'Succeeded'; Changed = $true }
