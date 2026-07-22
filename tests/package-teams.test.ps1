$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $repositoryRoot "scripts\package-teams.ps1"
$templatePath = Join-Path $repositoryRoot "appPackage\manifest.template.json"
$parseErrors = $null
[void] [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref] $null, [ref] $parseErrors)
if ($parseErrors.Count -ne 0) {
  throw "package-teams.ps1 has parse errors: $($parseErrors.Message -join '; ')"
}

function Assert-True {
  param([bool] $Condition, [string] $Message)
  if (-not $Condition) { throw $Message }
}

function Assert-Throws {
  param([scriptblock] $Action, [string] $Message)
  try {
    & $Action
  }
  catch {
    return
  }
  throw $Message
}

$testDirectory = Join-Path ([IO.Path]::GetTempPath()) ("package-teams-test-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $testDirectory | Out-Null
try {
  $botId = "11111111-2222-3333-4444-555555555555"
  $teamsId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  $packagePath = Join-Path $testDirectory "teams-app.zip"
  $metadata = & $scriptPath -BotMicrosoftAppId $botId -AppServiceHostname "HTTPS://SRE-APP.azurewebsites.net/" -DeveloperName "SRE Engineering" -TeamsAppId $teamsId -DeveloperWebsiteUrl "https://sre-app.azurewebsites.net/" -OutputPath $packagePath -SkipEndpointVerification

  Assert-True (Test-Path -LiteralPath $packagePath -PathType Leaf) "The package was not created."
   Assert-True ($metadata.TeamsAppId -eq $teamsId) "Package metadata did not return the Teams app ID."
   Assert-True ($metadata.AppServiceHostname -eq "sre-app.azurewebsites.net") "Hostname normalization failed."
   Assert-True ($metadata.UploadInstruction -match "Developer Portal") "Package metadata did not include an upload instruction."

   $secondPackagePath = Join-Path $testDirectory "teams-app-repeat.zip"
   [void] (& $scriptPath -BotMicrosoftAppId $botId -AppServiceHostname "HTTPS://SRE-APP.azurewebsites.net/" -DeveloperName "SRE Engineering" -TeamsAppId $teamsId -DeveloperWebsiteUrl "https://sre-app.azurewebsites.net/" -OutputPath $secondPackagePath -SkipEndpointVerification)
   Assert-True ((Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $secondPackagePath -Algorithm SHA256).Hash) "Equivalent package inputs did not produce the same ZIP hash."

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($packagePath)
  try {
    $entryNames = @($archive.Entries | ForEach-Object { $_.FullName } | Sort-Object)
    Assert-True (($entryNames -join ",") -eq "color.png,manifest.json,outline.png") "Package root entries are incorrect."
    Assert-True (@($entryNames | Where-Object { $_ -match "[\\/]" }).Count -eq 0) "Package contains non-root entries."
    $reader = New-Object IO.StreamReader(($archive.GetEntry("manifest.json")).Open())
    try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    Assert-True ($manifest.id -eq $teamsId) "Manifest Teams app ID is incorrect."
    Assert-True ($manifest.bots[0].botId -eq $botId) "Manifest bot ID is incorrect."
    Assert-True ($manifest.webApplicationInfo.resource -eq "api://botid-$botId") "Manifest resource is incorrect."
    Assert-True ($manifest.developer.privacyUrl -eq "https://sre-app.azurewebsites.net/privacy") "Privacy URL is incorrect."
    Assert-True ($manifest.developer.termsOfUseUrl -eq "https://sre-app.azurewebsites.net/terms") "Terms URL is incorrect."
  }
  finally { $archive.Dispose() }

   Assert-Throws { & $scriptPath -BotMicrosoftAppId "not-a-guid" -AppServiceHostname "sre-app.azurewebsites.net" -DeveloperName "SRE" -TeamsAppId $teamsId -OutputPath (Join-Path $testDirectory "bad-guid.zip") -SkipEndpointVerification } "Bad bot GUID was accepted."
   Assert-Throws { & $scriptPath -BotMicrosoftAppId $botId -AppServiceHostname "https://sre-app.azurewebsites.net/not-a-hostname" -DeveloperName "SRE" -TeamsAppId $teamsId -OutputPath (Join-Path $testDirectory "bad-host.zip") -SkipEndpointVerification } "Bad hostname was accepted."
   Assert-Throws { & $scriptPath -BotMicrosoftAppId $botId -AppServiceHostname "127.0.0.1" -DeveloperName "SRE" -TeamsAppId $teamsId -OutputPath (Join-Path $testDirectory "ip-address.zip") -SkipEndpointVerification } "IP address was accepted as a hostname."
   Assert-Throws { & $scriptPath -BotMicrosoftAppId $botId -AppServiceHostname "sre-app.azurewebsites.net" -DeveloperName "SRE" -TeamsAppId $teamsId -DeveloperWebsiteUrl "http://sre-app.azurewebsites.net/" -OutputPath (Join-Path $testDirectory "bad-url.zip") -SkipEndpointVerification } "Non-HTTPS website URL was accepted."
   Assert-Throws { & $scriptPath -BotMicrosoftAppId $botId -AppServiceHostname "sre-app.azurewebsites.net" -DeveloperName '${UNRESOLVED}' -TeamsAppId $teamsId -OutputPath (Join-Path $testDirectory "token.zip") -SkipEndpointVerification } "Template placeholder input was accepted."
   Assert-Throws { & $scriptPath -BotMicrosoftAppId $botId -AppServiceHostname "sre-app.azurewebsites.net" -DeveloperName "SRE" -OutputPath (Join-Path $testDirectory "missing-teams-id.zip") -SkipEndpointVerification } "Missing Teams app ID was accepted."

   $originalTemplate = [IO.File]::ReadAllText($templatePath)
   try {
     [IO.File]::WriteAllText($templatePath, $originalTemplate.Replace('"manifestVersion": "1.19"', '"manifestVersion": "1.18"'))
     Assert-Throws { & $scriptPath -BotMicrosoftAppId $botId -AppServiceHostname "sre-app.azurewebsites.net" -DeveloperName "SRE" -TeamsAppId $teamsId -OutputPath (Join-Path $testDirectory "bad-version.zip") -SkipEndpointVerification } "An unsupported manifest version was accepted."

     [IO.File]::WriteAllText($templatePath, $originalTemplate.Replace('"groupChat"', '"unsupportedScope"'))
     Assert-Throws { & $scriptPath -BotMicrosoftAppId $botId -AppServiceHostname "sre-app.azurewebsites.net" -DeveloperName "SRE" -TeamsAppId $teamsId -OutputPath (Join-Path $testDirectory "bad-scope.zip") -SkipEndpointVerification } "An unsupported bot scope was accepted."

     [IO.File]::WriteAllText($templatePath, $originalTemplate.Replace('"validDomains": ["${APP_SERVICE_HOSTNAME}", "token.botframework.com"]', '"validDomains": ["token.botframework.com", "${APP_SERVICE_HOSTNAME}"]'))
     Assert-Throws { & $scriptPath -BotMicrosoftAppId $botId -AppServiceHostname "sre-app.azurewebsites.net" -DeveloperName "SRE" -TeamsAppId $teamsId -OutputPath (Join-Path $testDirectory "bad-domains.zip") -SkipEndpointVerification } "Invalid validDomains ordering was accepted."
   }
   finally {
     [IO.File]::WriteAllText($templatePath, $originalTemplate)
   }

   $global:packageTeamsMockStatusCode = 200
   $global:packageTeamsMockMethods = @()
   function global:Invoke-WebRequest {
     param([string] $Uri, [string] $Method, [switch] $UseBasicParsing, [int] $MaximumRedirection, [int] $TimeoutSec)
     $global:packageTeamsMockMethods += "$Method/$MaximumRedirection"
     return [pscustomobject]@{ StatusCode = $global:packageTeamsMockStatusCode }
   }
   try {
     [void] (& $scriptPath -BotMicrosoftAppId $botId -AppServiceHostname "sre-app.azurewebsites.net" -DeveloperName "SRE" -TeamsAppId $teamsId -OutputPath (Join-Path $testDirectory "http-200.zip"))
     Assert-True (@($global:packageTeamsMockMethods | Where-Object { $_ -ne "Get/0" }).Count -eq 0) "Endpoint verification did not use GET with redirects disabled."
     $global:packageTeamsMockStatusCode = 204
     Assert-Throws { & $scriptPath -BotMicrosoftAppId $botId -AppServiceHostname "sre-app.azurewebsites.net" -DeveloperName "SRE" -TeamsAppId $teamsId -OutputPath (Join-Path $testDirectory "http-204.zip") } "HTTP 204 was accepted."
     $global:packageTeamsMockStatusCode = 302
     Assert-Throws { & $scriptPath -BotMicrosoftAppId $botId -AppServiceHostname "sre-app.azurewebsites.net" -DeveloperName "SRE" -TeamsAppId $teamsId -OutputPath (Join-Path $testDirectory "http-redirect.zip") } "HTTP redirect was accepted."
   }
   finally {
     Remove-Item -LiteralPath Function:\global:Invoke-WebRequest -Force
     Remove-Variable -Name packageTeamsMockStatusCode, packageTeamsMockMethods -Scope Global -Force
   }

  "package-teams.tests.ps1: PASS"
}
finally {
  if (Test-Path -LiteralPath $testDirectory) {
    Remove-Item -LiteralPath $testDirectory -Recurse -Force
  }
}
