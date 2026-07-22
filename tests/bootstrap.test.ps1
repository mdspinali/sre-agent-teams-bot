#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$scriptPath = (Resolve-Path (Join-Path $PSScriptRoot '..\scripts\bootstrap.ps1')).Path
$source = [IO.File]::ReadAllText($scriptPath)
$tenant = '11111111-1111-1111-1111-111111111111'
$subscription = '22222222-2222-2222-2222-222222222222'
$appId = '33333333-3333-3333-3333-333333333333'
$providerId = '44444444-4444-4444-4444-444444444444'
$global:bootstrapCommands = New-Object Collections.ArrayList
$global:bootstrapConnectionExists = $false
$global:bootstrapFailCreate = $false

function global:az {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]] $Arguments)
  $arguments = @($Arguments | Where-Object { $_ -ne '--only-show-errors' })
  [void] $global:bootstrapCommands.Add(@($arguments))
  $global:LASTEXITCODE = 0
  $command = $arguments -join ' '
  if ($command -match '^account show') { return '{"id":"22222222-2222-2222-2222-222222222222","tenantId":"11111111-1111-1111-1111-111111111111","state":"Enabled"}' }
  if ($command -match '^account set') { return }
  if ($command -match '^group show') { return '{"id":"/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg"}' }
  if ($command -match '^bot show') { return '{"properties":{"msaAppId":"33333333-3333-3333-3333-333333333333","msaAppTenantId":"11111111-1111-1111-1111-111111111111"}}' }
  if ($command -match '^ad app show') { return '{"id":"55555555-5555-5555-5555-555555555555","appId":"33333333-3333-3333-3333-333333333333"}' }
  if ($command -match '^bot authsetting list-providers') { return '{"value":[{"properties":{"id":"44444444-4444-4444-4444-444444444444","serviceProviderName":"Aadv2"}}]}' }
  if ($command -match '^bot authsetting list') {
    if ($global:bootstrapConnectionExists) { return '[{"name":"bot/sre-obo"}]' }
    return '[]'
  }
  if ($command -match '^bot authsetting show') {
    return '{"name":"bot/sre-obo","properties":{"clientId":"33333333-3333-3333-3333-333333333333","serviceProviderId":"44444444-4444-4444-4444-444444444444","scopes":"https://azuresre.dev/Threads.ReadWrite.All","provisioningState":"Succeeded","parameters":[{"key":"TenantId","value":"11111111-1111-1111-1111-111111111111"},{"key":"TokenExchangeUrl","value":"api://botid-33333333-3333-3333-3333-333333333333"}]}}'
  }
  if ($command -match '^bot authsetting create') {
    if ($global:bootstrapFailCreate) { $global:LASTEXITCODE = 2; return }
    $global:bootstrapConnectionExists = $true
    return '{"properties":{"provisioningState":"Succeeded"}}'
  }
  $global:LASTEXITCODE = 2
}

try {
  $tokens = $null; $errors = $null
  [void][Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref] $tokens, [ref] $errors)
  if ($errors.Count) { throw 'bootstrap.ps1 has parse errors.' }
  if ($source.Contains("'--provider'") -or $source.Contains("'--scopes'")) { throw 'Obsolete OAuth flags remain.' }
  if ($source -notmatch "'--service'" -or $source -notmatch "'--provider-scope-string'") { throw 'Current OAuth flags are missing.' }

  $secret = 'value&with|metacharacters'
  $result = & $scriptPath -Phase oauth -TenantId $tenant -SubscriptionId $subscription -ResourceGroup rg -BotName bot -BotAppId $appId -BotAppSecret $secret
  if (-not $result.Changed) { throw 'OAuth creation did not report a change.' }
  $create = @($global:bootstrapCommands | Where-Object { ($_[0..2] -join ' ') -eq 'bot authsetting create' })
  if ($create.Count -ne 1 -or $create[0] -notcontains $secret) { throw 'OAuth secret argument was changed or omitted.' }
  if ($create[0] -notcontains '--service' -or $create[0] -notcontains '--provider-scope-string') { throw 'OAuth command shape is invalid.' }

  $global:bootstrapCommands.Clear(); $result = & $scriptPath -Phase oauth -TenantId $tenant -SubscriptionId $subscription -ResourceGroup rg -BotName bot -BotAppId $appId
  if ($result.Changed -or @($global:bootstrapCommands | Where-Object { $_ -contains 'create' }).Count) { throw 'Matching OAuth rerun mutated the connection.' }

  $global:bootstrapConnectionExists = $false; $global:bootstrapFailCreate = $true
  try { & $scriptPath -Phase oauth -TenantId $tenant -SubscriptionId $subscription -ResourceGroup rg -BotName bot -BotAppId $appId -BotAppSecret secret; throw 'Expected Azure CLI failure.' }
  catch { if ($_.Exception.Message -eq 'Expected Azure CLI failure.') { throw } }
  'bootstrap.test.ps1: PASS'
}
finally {
  Remove-Item Function:\global:az -ErrorAction SilentlyContinue
  Remove-Variable bootstrapCommands, bootstrapConnectionExists, bootstrapFailCreate -Scope Global -ErrorAction SilentlyContinue
}
