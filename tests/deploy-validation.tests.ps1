# Requires -Version 5.1

BeforeAll {
$repoRoot = Split-Path -Parent $PSScriptRoot
$deployScript = Join-Path $repoRoot 'scripts\deploy.ps1'
$validateScript = Join-Path $repoRoot 'scripts\validate-deployment.ps1'
$subscriptionId = '11111111-1111-1111-1111-111111111111'
$tenantId = '22222222-2222-2222-2222-222222222222'
$providerId = '30dd229c-58e3-4a48-bdfd-91ec48eb906c'
$principalId = '33333333-3333-3333-3333-333333333333'
$agentId = "/subscriptions/$subscriptionId/resourceGroups/agent-rg/providers/Microsoft.App/agents/agent"

function Set-FakeAz {
  param(
    [ValidateSet('Success', 'ContextMismatch', 'RemoteBuildFalse')] [string] $Mode = 'Success',
    [switch] $WriteWarning
  )
  $global:FakeAzMode = $Mode
  $global:FakeAzWarning = [bool]$WriteWarning
  $global:FakeAzCommands = New-Object System.Collections.ArrayList
  function global:az {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]] $Arguments)
    [void]$global:FakeAzCommands.Add(($Arguments -join ' '))
    if ($global:FakeAzWarning) { Write-Error 'non-fatal Azure CLI warning' -ErrorAction Continue }
    $global:LASTEXITCODE = 0
    $command = $Arguments -join ' '
    if ($command -match '^account show ') {
      $tenant = if ($global:FakeAzMode -eq 'ContextMismatch') { 'wrong-tenant' } else { $tenantId }
      $subscriptionIndex = [Array]::IndexOf($Arguments, '--subscription')
      $selectedSubscription = if ($subscriptionIndex -ge 0) { $Arguments[$subscriptionIndex + 1] } else { $subscriptionId }
      return (@{ id = $selectedSubscription; tenantId = $tenant; state = 'Enabled' } | ConvertTo-Json -Compress)
    }
    if ($command -match '^webapp config appsettings list ') {
      if ($Arguments -contains '--query') {
        if ($global:FakeAzMode -eq 'RemoteBuildFalse') { return 'false' }
        return 'true'
      }
      return '[{"name":"THREAD_TABLE_ENDPOINT","value":"https://appst.table.core.windows.net"},{"name":"SRE_AGENT_SCOPE","value":"https://azuresre.dev/.default"}]'
    }
    if ($command -match '^webapp show ') {
      if ($command -match 'defaultHostName') { return 'app.example.test' }
      return 'Running'
    }
    if ($command -match '^webapp identity show ') { return '{"principalId":"33333333-3333-3333-3333-333333333333"}' }
    if ($command -match '^bot show ') { return (@{ name = 'app'; properties = @{ endpoint = 'https://app.example.test/api/messages'; msaAppId = '55555555-5555-5555-5555-555555555555'; msaAppTenantId = $tenantId } } | ConvertTo-Json -Depth 4 -Compress) }
    if ($command -match '^bot authsetting show ') {
      return (@{ name = 'app/sre-obo'; properties = @{ name = 'sre-obo'; serviceProviderId = 'Aadv2'; scopes = 'openid https://azuresre.dev/Threads.ReadWrite.All'; provisioningState = 'Succeeded'; clientId = '55555555-5555-5555-5555-555555555555'; parameters = @(@{ key = 'TenantId'; value = $tenantId }, @{ key = 'TokenExchangeUrl'; value = 'api://botid-55555555-5555-5555-5555-555555555555' }) } } | ConvertTo-Json -Depth 6 -Compress)
    }
    if ($command -match '^bot authsetting list-providers ') {
      return (@{ value = @(@{ properties = @{ id = $providerId; serviceProviderName = 'Aadv2'; displayName = 'Azure Active Directory v2' } }) } | ConvertTo-Json -Depth 5 -Compress)
    }
    if ($command -match '^role assignment list ') { return '[{"roleDefinitionName":"assigned"}]' }
    return '{}'
  }
}

function Remove-FakeAz {
  Remove-Item Function:\global:az -ErrorAction SilentlyContinue
  Remove-Variable FakeAzMode, FakeAzWarning, FakeAzCommands -Scope Global -ErrorAction SilentlyContinue
}

function New-TeamsPackage([string] $Path, [switch] $IncludeExtraEntry) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create)
  $archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    $contents = @{
      'manifest.json' = (@{ manifestVersion = '1.19'; bots = @(@{ botId = 'bot' }); validDomains = @('app.example.test') } | ConvertTo-Json -Depth 5 -Compress)
      'color.png' = 'color'
      'outline.png' = 'outline'
    }
    if ($IncludeExtraEntry) { $contents['nested/extra.txt'] = 'extra' }
    foreach ($name in $contents.Keys) {
      $entry = $archive.CreateEntry($name)
      $writer = New-Object System.IO.StreamWriter($entry.Open())
      try { $writer.Write($contents[$name]) } finally { $writer.Dispose() }
    }
  }
  finally { $archive.Dispose(); $stream.Dispose() }
}
}

Describe 'deployment and validation scripts' {
  AfterEach {
    Remove-FakeAz
    Remove-Item Function:\global:Invoke-WebRequest -ErrorAction SilentlyContinue
  }

  It 'parses in Windows PowerShell syntax' {
    foreach ($scriptPath in @($deployScript, $validateScript)) {
      $tokens = $null; $errors = $null
      [void][System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
      $errors.Count | Should -Be 0
    }
  }

  It 'creates a source-only ZIP with root forward-slash entries' {
    $zipPath = Join-Path ([System.IO.Path]::GetTempPath()) ('deploy-test-' + [Guid]::NewGuid().ToString('N') + '.zip')
    try {
      $result = & $deployScript -TenantId $tenantId -SubscriptionId $subscriptionId -ResourceGroup rg -AppName app -ArchivePath $zipPath -CreateArchiveOnly
      $stream = [System.IO.File]::OpenRead($zipPath)
      $zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Read)
      try {
        $entries = @($zip.Entries | ForEach-Object { $_.FullName })
        $entries | Should -Contain 'package.json'
        $entries | Should -Contain 'package-lock.json'
        $entries | Should -Contain 'tsconfig.json'
        @($entries | Where-Object { $_ -match '^src/' }).Count | Should -BeGreaterThan 0
        @($entries | Where-Object { $_ -match '\\|^(node_modules|dist|deploy|state)/|(^|/)\.env' }).Count | Should -Be 0
        $result.Uploaded | Should -BeFalse
      }
      finally { $zip.Dispose(); $stream.Dispose() }
    }
    finally { if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force } }
  }

  It 'resolves the repository root in a fresh PowerShell file process' {
    $zipPath = Join-Path ([System.IO.Path]::GetTempPath()) ('deploy-process-' + [Guid]::NewGuid().ToString('N') + '.zip')
    try {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $deployScript -TenantId $tenantId -SubscriptionId $subscriptionId -ResourceGroup rg -AppName app -ArchivePath $zipPath -CreateArchiveOnly | Out-Null
      $LASTEXITCODE | Should -Be 0
      Test-Path -LiteralPath $zipPath -PathType Leaf | Should -BeTrue
    }
    finally { if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force } }
  }

  It 'fails on a tenant context mismatch before any web app mutation' {
    Set-FakeAz -Mode ContextMismatch
    { & $deployScript -TenantId $tenantId -SubscriptionId $subscriptionId -ResourceGroup rg -AppName app } | Should -Throw
    ($global:FakeAzCommands -join "`n") | Should -Match 'account show'
    ($global:FakeAzCommands -join "`n") | Should -Not -Match 'webapp'
  }

  It 'requires remote build readback before upload' {
    Set-FakeAz -Mode RemoteBuildFalse
    { & $deployScript -TenantId $tenantId -SubscriptionId $subscriptionId -ResourceGroup rg -AppName app } | Should -Throw '*not read back as true*'
    $commands = $global:FakeAzCommands -join "`n"
    $commands | Should -Match 'webapp config appsettings set .*SCM_DO_BUILD_DURING_DEPLOYMENT=true'
    $commands | Should -Match 'webapp config appsettings list .*SCM_DO_BUILD_DURING_DEPLOYMENT'
    $commands | Should -Not -Match 'webapp deploy'
  }

  It 'deploys successfully despite native stderr warnings and retries health' {
    Set-FakeAz -WriteWarning
    $global:HealthCalls = 0
    function global:Invoke-WebRequest {
      $global:HealthCalls++
      if ($global:HealthCalls -eq 1) { throw 'starting' }
      return [pscustomobject]@{ StatusCode = 200 }
    }
    $result = & $deployScript -TenantId $tenantId -SubscriptionId $subscriptionId -ResourceGroup rg -AppName app -HealthTimeoutSeconds 5 -HealthPollIntervalSeconds 1
    $result.Uploaded | Should -BeTrue
    $result.HealthUrl | Should -Be 'https://app.example.test/healthz'
    $global:HealthCalls | Should -Be 2
    $commands = $global:FakeAzCommands -join "`n"
    $commands.IndexOf('webapp config appsettings list') | Should -BeLessThan $commands.IndexOf('webapp deploy')
    $commands | Should -Match 'webapp deploy .*--type zip --clean true --async false'
  }

  It 'completes all mocked validation checks including OAuth, RBAC, Teams ZIP, and health' {
    Set-FakeAz -WriteWarning
    function global:Invoke-WebRequest { return [pscustomobject]@{ StatusCode = 204 } }
    $zipPath = Join-Path ([System.IO.Path]::GetTempPath()) ('teams-test-' + [Guid]::NewGuid().ToString('N') + '.zip')
    try {
      New-TeamsPackage $zipPath
      $result = & $validateScript -TenantId $tenantId -SubscriptionId $subscriptionId -ResourceGroup rg -AppName app -SreAgentResourceId $agentId -TeamsPackagePath $zipPath -NoExitOnFailure
      $failures = @($result.Checks | Where-Object { -not $_.Passed } | ForEach-Object { "$($_.Name): $($_.Details)" })
      $result.Succeeded | Should -BeTrue -Because (($failures + @($global:FakeAzCommands)) -join '; ')
      @($result.Checks).Count | Should -Be 9
      @($result.Checks | Where-Object { -not $_.Passed }).Count | Should -Be 0
      $commands = $global:FakeAzCommands -join "`n"
      $commands | Should -Match 'bot authsetting list-providers'
      @($global:FakeAzCommands | Where-Object { $_ -match '^role assignment list ' }).Count | Should -Be 2
      $commands | Should -Match 'role assignment list --assignee-object-id 33333333-3333-3333-3333-333333333333 --fill-principal-name false'
      $commands | Should -Not -Match 'role assignment list --assignee '
    }
    finally { if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force } }
  }

  It 'reports failed health without terminating when requested' {
    Set-FakeAz
    function global:Invoke-WebRequest { return [pscustomobject]@{ StatusCode = 503 } }
    $result = & $validateScript -TenantId $tenantId -SubscriptionId $subscriptionId -ResourceGroup rg -AppName app -SreAgentResourceId $agentId -NoExitOnFailure
    $result.Succeeded | Should -BeFalse
    @($result.Checks | Where-Object { $_.Name -eq 'AppServiceRunningAndHealth' -and -not $_.Passed }).Count | Should -Be 1
  }

  It 'rejects an inexact SRE Agent ARM ID with a non-GUID subscription' {
    Set-FakeAz
    function global:Invoke-WebRequest { return [pscustomobject]@{ StatusCode = 200 } }
    $result = & $validateScript -TenantId $tenantId -SubscriptionId $subscriptionId -ResourceGroup rg -AppName app -SreAgentResourceId '/subscriptions/not-a-guid/resourceGroups/agent-rg/providers/Microsoft.App/agents/agent' -NoExitOnFailure
    @($result.Checks | Where-Object { $_.Name -eq 'SreAgentStandardUser' -and -not $_.Passed }).Count | Should -Be 1
  }

  It 'uses the SRE Agent subscription for same-tenant cross-subscription RBAC validation' {
    Set-FakeAz
    function global:Invoke-WebRequest { return [pscustomobject]@{ StatusCode = 200 } }
    $agentSubscription = '44444444-4444-4444-4444-444444444444'
    $crossSubscriptionAgent = "/subscriptions/$agentSubscription/resourceGroups/agent-rg/providers/Microsoft.App/agents/agent"
    $result = & $validateScript -TenantId $tenantId -SubscriptionId $subscriptionId -ResourceGroup rg -AppName app -SreAgentResourceId $crossSubscriptionAgent -NoExitOnFailure
    $result.Succeeded | Should -BeTrue
    ($global:FakeAzCommands -join "`n") | Should -Match "role assignment list .*--scope $([Regex]::Escape($crossSubscriptionAgent)) --subscription $agentSubscription"
  }

  It 'rejects a Teams ZIP with entries beyond the three required root files' {
    Set-FakeAz
    function global:Invoke-WebRequest { return [pscustomobject]@{ StatusCode = 200 } }
    $zipPath = Join-Path ([System.IO.Path]::GetTempPath()) ('teams-extra-' + [Guid]::NewGuid().ToString('N') + '.zip')
    try {
      New-TeamsPackage $zipPath -IncludeExtraEntry
      $result = & $validateScript -TenantId $tenantId -SubscriptionId $subscriptionId -ResourceGroup rg -AppName app -SreAgentResourceId $agentId -TeamsPackagePath $zipPath -NoExitOnFailure
      @($result.Checks | Where-Object { $_.Name -eq 'TeamsPackage' -and -not $_.Passed }).Count | Should -Be 1
    }
    finally { if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force } }
  }
}
