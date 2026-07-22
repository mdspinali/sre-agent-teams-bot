<# .SYNOPSIS Creates a validated Microsoft Teams app package. #>
#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $BotMicrosoftAppId,
  [Parameter(Mandatory)] [string] $TeamsAppId,
  [Parameter(Mandatory)] [string] $AppServiceHostname,
  [Parameter(Mandatory)] [string] $DeveloperName,
  [string] $DeveloperWebsiteUrl,
  [string] $OutputPath,
  [switch] $SkipEndpointVerification,
  [ValidateRange(1, 300)] [int] $EndpointVerificationTimeoutSec = 15
)

$ErrorActionPreference = 'Stop'
if (-not $OutputPath) { $OutputPath = Join-Path $PSScriptRoot '..\appPackage\teams-app.zip' }

function ConvertTo-Guid([string] $Value, [string] $Name) {
  $guid = [Guid]::Empty
  if (-not [Guid]::TryParse($Value, [ref] $guid) -or $guid -eq [Guid]::Empty) { throw "$Name must be a GUID." }
  return $guid.ToString()
}

function ConvertTo-Hostname([string] $Value) {
  $candidate = $Value.Trim()
  if ($candidate -match '://') {
    $uri = [Uri] $candidate
    if ($uri.Scheme -ne 'https' -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment -or -not $uri.IsDefaultPort) { throw 'AppServiceHostname must contain only an HTTPS hostname.' }
    $candidate = $uri.Host
  }
  $candidate = $candidate.TrimEnd('.').ToLowerInvariant()
  $ip = $null
  if ([Net.IPAddress]::TryParse($candidate, [ref] $ip) -or $candidate -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$') {
    throw 'AppServiceHostname must be a DNS hostname.'
  }
  return $candidate
}

function ConvertTo-HttpsUrl([string] $Value, [string] $Name) {
  $uri = $null
  if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref] $uri) -or $uri.Scheme -ne 'https' -or $uri.UserInfo) { throw "$Name must be an absolute HTTPS URL." }
  if ($uri.Host -eq 'example.com' -or $uri.Host.EndsWith('.example.com')) { throw "$Name must not use example.com." }
  return $uri.AbsoluteUri
}

function ConvertTo-JsonString([string] $Value) {
  $json = ConvertTo-Json $Value -Compress
  return $json.Substring(1, $json.Length - 2)
}

function Test-Endpoint([string] $Url) {
  $response = Invoke-WebRequest -Uri $Url -Method Get -UseBasicParsing -MaximumRedirection 0 -TimeoutSec $EndpointVerificationTimeoutSec
  if ($response.StatusCode -ne 200) { throw "Required endpoint '$Url' returned HTTP $($response.StatusCode)." }
}

$botId = ConvertTo-Guid $BotMicrosoftAppId 'BotMicrosoftAppId'
$teamsId = ConvertTo-Guid $TeamsAppId 'TeamsAppId'
if ([string]::IsNullOrWhiteSpace($DeveloperName) -or $DeveloperName.Length -gt 32 -or $DeveloperName -match '\$\{') { throw 'DeveloperName must be 1-32 characters without template tokens.' }
$hostname = ConvertTo-Hostname $AppServiceHostname
$baseUrl = "https://$hostname/"
$websiteUrl = ConvertTo-HttpsUrl $(if ($DeveloperWebsiteUrl) { $DeveloperWebsiteUrl } else { $baseUrl }) 'DeveloperWebsiteUrl'
$privacyUrl = ConvertTo-HttpsUrl "${baseUrl}privacy" 'PrivacyUrl'
$termsUrl = ConvertTo-HttpsUrl "${baseUrl}terms" 'TermsOfUseUrl'

$templatePath = Join-Path $PSScriptRoot '..\appPackage\manifest.template.json'
$manifestText = [IO.File]::ReadAllText($templatePath)
$replacements = @{
  '${TEAMS_APP_ID}' = $teamsId; '${BOT_MICROSOFT_APP_ID}' = $botId
  '${DEVELOPER_NAME}' = $DeveloperName.Trim(); '${DEVELOPER_WEBSITE_URL}' = $websiteUrl
  '${PRIVACY_URL}' = $privacyUrl; '${TERMS_OF_USE_URL}' = $termsUrl
  '${APP_SERVICE_HOSTNAME}' = $hostname
}
foreach ($token in $replacements.Keys) { $manifestText = $manifestText.Replace($token, (ConvertTo-JsonString $replacements[$token])) }
if ($manifestText -match '\$\{' -or $manifestText -match '(?i)example\.com') { throw 'Rendered manifest contains a placeholder.' }
try { $manifest = $manifestText | ConvertFrom-Json } catch { throw 'Rendered manifest is invalid JSON.' }
if ($manifest.'$schema' -ne 'https://developer.microsoft.com/en-us/json-schemas/teams/v1.19/MicrosoftTeams.schema.json' -or
    $manifest.manifestVersion -ne '1.19' -or $manifest.id -ne $teamsId -or
    $manifest.bots.Count -ne 1 -or $manifest.bots[0].botId -ne $botId -or
    @($manifest.bots[0].scopes | Where-Object { $_ -notin @('personal', 'groupChat', 'team', 'meeting') }).Count -or
    $manifest.webApplicationInfo.id -ne $botId -or $manifest.webApplicationInfo.resource -ne "api://botid-$botId" -or
    ($manifest.validDomains -join ',') -ne "$hostname,token.botframework.com") {
  throw 'Rendered manifest does not match the package inputs or Teams schema contract.'
}
if (-not $SkipEndpointVerification) { Test-Endpoint $privacyUrl; Test-Endpoint $termsUrl }

$outputFullPath = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $outputFullPath
if (-not (Test-Path -LiteralPath $outputDirectory)) { New-Item -ItemType Directory -Path $outputDirectory | Out-Null }
$temporaryPath = Join-Path $outputDirectory ('.' + [IO.Path]::GetRandomFileName() + '.zip')
Add-Type -AssemblyName System.IO.Compression
$stream = $null; $archive = $null
try {
  $stream = [IO.File]::Open($temporaryPath, [IO.FileMode]::CreateNew)
  $archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
  foreach ($name in @('manifest.json', 'color.png', 'outline.png')) {
    $entry = $archive.CreateEntry($name, [IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
    $entryStream = $entry.Open()
    try {
      if ($name -eq 'manifest.json') {
        $bytes = [Text.Encoding]::UTF8.GetBytes($manifestText); $entryStream.Write($bytes, 0, $bytes.Length)
      }
      else {
        $fileStream = [IO.File]::OpenRead((Join-Path (Split-Path $templatePath -Parent) $name))
        try { $fileStream.CopyTo($entryStream) } finally { $fileStream.Dispose() }
      }
    }
    finally { $entryStream.Dispose() }
  }
  $archive.Dispose(); $archive = $null; $stream.Dispose(); $stream = $null
  [IO.File]::Copy($temporaryPath, $outputFullPath, $true)
}
finally {
  if ($archive) { $archive.Dispose() }; if ($stream) { $stream.Dispose() }
  Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
}

[pscustomobject]@{
  PackagePath = $outputFullPath; TeamsAppId = $teamsId; BotMicrosoftAppId = $botId
  AppServiceHostname = $hostname; DeveloperWebsiteUrl = $websiteUrl
  PrivacyUrl = $privacyUrl; TermsOfUseUrl = $termsUrl
  EndpointVerificationSkipped = [bool] $SkipEndpointVerification
  Entries = @('manifest.json', 'color.png', 'outline.png')
  UploadInstruction = 'In Teams Developer Portal, import this ZIP from Apps > Manage your apps.'
}
