<#
.SYNOPSIS
Builds and deploys the tracked TypeScript source for the Linux App Service.

.DESCRIPTION
This script deliberately creates a source-only ZIP so App Service's Oryx remote
build installs the production dependencies and compiles the application. It
validates the requested Azure tenant and subscription before making changes.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $TenantId,
  [Parameter(Mandatory)] [string] $SubscriptionId,
  [Parameter(Mandatory)] [string] $ResourceGroup,
  [Parameter(Mandatory)] [string] $AppName,
  [string] $SourcePath,
  [string] $ArchivePath,
  [ValidateRange(1, 3600)] [int] $HealthTimeoutSeconds = 300,
  [ValidateRange(1, 60)] [int] $HealthPollIntervalSeconds = 5,
  [switch] $CreateArchiveOnly
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($SourcePath)) {
  $SourcePath = Split-Path -Parent $PSScriptRoot
}

function Require-Command([string] $Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found on PATH."
  }
}

function Invoke-Az([string[]] $Arguments) {
  # Windows PowerShell 5.1 turns native stderr into error records when the
  # caller uses Stop. Capture it separately and inspect LASTEXITCODE first.
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

function Invoke-Git([string[]] $Arguments) {
  $stderrFile = [System.IO.Path]::GetTempFileName()
  $previousPreference = $ErrorActionPreference
  $output = @()
  $exitCode = 1
  try {
    $ErrorActionPreference = 'Continue'
    $LASTEXITCODE = 0
    $output = & git @Arguments 2> $stderrFile
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousPreference
    Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
  }
  if ($exitCode -ne 0) {
    throw 'Unable to enumerate tracked application files with git.'
  }
  return (($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine)
}

function Test-ExcludedArchiveEntry([string] $EntryName) {
  return $EntryName -match '(^|/)(node_modules|dist|deploy|state)(/|$)' -or
    $EntryName -match '(^|/)\.env($|\.)'
}

function Get-TrackedSourceEntries([string] $ProjectRoot) {
  $listed = Invoke-Git @('-C', $ProjectRoot, 'ls-files', '--', 'package.json', 'package-lock.json', 'tsconfig.json', 'src')
  $entries = @($listed -split "`r?`n" | Where-Object { $_ })
  $required = @('package.json', 'package-lock.json', 'tsconfig.json')

  foreach ($requiredEntry in $required) {
    if ($entries -notcontains $requiredEntry) {
      throw "Required tracked source file '$requiredEntry' was not found."
    }
  }
  if (-not (@($entries | Where-Object { $_ -match '^src/' }).Count -gt 0)) {
    throw "No tracked files were found below 'src/'."
  }

  foreach ($entry in $entries) {
    $normalized = $entry.Replace('\', '/')
    if ($normalized -ne $entry -or $normalized.StartsWith('/') -or $normalized -match '(^|/)\.\.(/|$)') {
      throw "Unsafe tracked path '$entry' cannot be added to a deployment archive."
    }
    if (Test-ExcludedArchiveEntry $normalized) {
      throw "Excluded path '$normalized' cannot be added to a deployment archive."
    }
    if ($normalized -notmatch '^(package\.json|package-lock\.json|tsconfig\.json|src/.+)$') {
      throw "Tracked path '$normalized' is not an allowed deployment source file."
    }
  }
  return @($entries | Sort-Object)
}

function New-SourceArchive([string] $ProjectRoot, [string[]] $Entries, [string] $Destination) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem

  $parent = Split-Path -Parent $Destination
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    throw "Archive directory '$parent' does not exist."
  }
  if (Test-Path -LiteralPath $Destination) {
    Remove-Item -LiteralPath $Destination -Force
  }

  $fileStream = $null
  $archive = $null
  try {
    $fileStream = [System.IO.File]::Open($Destination, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $archive = New-Object System.IO.Compression.ZipArchive($fileStream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
    foreach ($entryName in $Entries) {
      $sourceFile = Join-Path $ProjectRoot ($entryName.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
      if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
        throw "Tracked source file '$entryName' no longer exists."
      }
      # CreateEntry receives the normalized name, not a Windows file-system path.
      $zipEntry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
      $input = $null
      $output = $null
      try {
        $input = [System.IO.File]::OpenRead($sourceFile)
        $output = $zipEntry.Open()
        $input.CopyTo($output)
      }
      finally {
        if ($output) { $output.Dispose() }
        if ($input) { $input.Dispose() }
      }
    }
  }
  finally {
    if ($archive) { $archive.Dispose() }
    if ($fileStream) { $fileStream.Dispose() }
  }
}

function Test-SourceArchive([string] $ArchiveFile, [string[]] $ExpectedEntries) {
  Add-Type -AssemblyName System.IO.Compression
  $fileStream = $null
  $archive = $null
  try {
    $fileStream = [System.IO.File]::OpenRead($ArchiveFile)
    $archive = New-Object System.IO.Compression.ZipArchive($fileStream, [System.IO.Compression.ZipArchiveMode]::Read, $false)
    $actualEntries = @($archive.Entries | ForEach-Object { $_.FullName } | Sort-Object)
    foreach ($entryName in $actualEntries) {
      if ($entryName.Contains('\') -or $entryName.EndsWith('/') -or (Test-ExcludedArchiveEntry $entryName)) {
        throw "Deployment archive contains an invalid entry '$entryName'."
      }
    }
    if (($actualEntries -join "`n") -ne (($ExpectedEntries | Sort-Object) -join "`n")) {
      throw 'Deployment archive contents do not match the tracked application source files.'
    }
  }
  finally {
    if ($archive) { $archive.Dispose() }
    if ($fileStream) { $fileStream.Dispose() }
  }
}

function Assert-AzureContext {
  $accountText = Invoke-Az @('account', 'show', '--subscription', $SubscriptionId, '--output', 'json')
  try { $account = $accountText | ConvertFrom-Json } catch { throw 'Azure CLI returned an invalid account context response.' }
  if ([string]$account.id -ine $SubscriptionId) {
    throw "Azure subscription mismatch: requested '$SubscriptionId'."
  }
  if ([string]$account.tenantId -ine $TenantId) {
    throw "Azure tenant mismatch: requested '$TenantId'."
  }
  if ([string]$account.state -ine 'Enabled') {
    throw "Azure subscription '$SubscriptionId' is not enabled."
  }
}

function Wait-ForHealth([string] $HostName) {
  $healthUri = "https://$HostName/healthz"
  $deadline = [DateTime]::UtcNow.AddSeconds($HealthTimeoutSeconds)
  do {
    try {
      $response = Invoke-WebRequest -Uri $healthUri -UseBasicParsing -TimeoutSec ([Math]::Min(30, $HealthPollIntervalSeconds))
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) { return $healthUri }
    }
    catch {
      # A deployment can briefly return connection and startup failures; retry to the bounded deadline.
    }
    if ([DateTime]::UtcNow -ge $deadline) { break }
    Start-Sleep -Seconds $HealthPollIntervalSeconds
  } while ($true)
  throw "App Service health check did not succeed before the timeout: $healthUri"
}

Require-Command git
$projectRoot = (Resolve-Path -LiteralPath $SourcePath -ErrorAction Stop).Path
$entries = Get-TrackedSourceEntries $projectRoot

if ($ArchivePath) {
  $archiveFile = [System.IO.Path]::GetFullPath($ArchivePath)
  $removeArchiveAfterDeployment = $false
}
else {
  $archiveFile = Join-Path ([System.IO.Path]::GetTempPath()) ("$AppName-" + [Guid]::NewGuid().ToString('N') + '.zip')
  $removeArchiveAfterDeployment = $true
}

try {
  New-SourceArchive $projectRoot $entries $archiveFile
  Test-SourceArchive $archiveFile $entries

  if ($CreateArchiveOnly) {
    [pscustomobject]@{ ArchivePath = $archiveFile; Entries = $entries; Uploaded = $false }
    return
  }

  Require-Command az
  Assert-AzureContext
  Invoke-Az @('webapp', 'config', 'appsettings', 'set', '--resource-group', $ResourceGroup, '--name', $AppName, '--settings', 'SCM_DO_BUILD_DURING_DEPLOYMENT=true', '--subscription', $SubscriptionId, '--output', 'none') | Out-Null
  $remoteBuild = (Invoke-Az @('webapp', 'config', 'appsettings', 'list', '--resource-group', $ResourceGroup, '--name', $AppName, '--subscription', $SubscriptionId, '--query', "[?name=='SCM_DO_BUILD_DURING_DEPLOYMENT'].value | [0]", '--output', 'tsv')).Trim()
  if ($remoteBuild -ine 'true') {
    throw 'SCM_DO_BUILD_DURING_DEPLOYMENT was not read back as true; deployment was not uploaded.'
  }
  $state = (Invoke-Az @('webapp', 'show', '--resource-group', $ResourceGroup, '--name', $AppName, '--subscription', $SubscriptionId, '--query', 'state', '--output', 'tsv')).Trim()
  if ($state -ieq 'Stopped') {
    Invoke-Az @('webapp', 'start', '--resource-group', $ResourceGroup, '--name', $AppName, '--subscription', $SubscriptionId, '--output', 'none') | Out-Null
  }
  $hostName = (Invoke-Az @('webapp', 'show', '--resource-group', $ResourceGroup, '--name', $AppName, '--subscription', $SubscriptionId, '--query', 'defaultHostName', '--output', 'tsv')).Trim()
  if (-not $hostName) { throw 'App Service did not return a default host name.' }
  Invoke-Az @('webapp', 'deploy', '--resource-group', $ResourceGroup, '--name', $AppName, '--src-path', $archiveFile, '--type', 'zip', '--clean', 'true', '--async', 'false', '--subscription', $SubscriptionId, '--output', 'none') | Out-Null
  $healthUri = Wait-ForHealth $hostName
  [pscustomobject]@{ ArchivePath = $archiveFile; Entries = $entries; Uploaded = $true; HealthUrl = $healthUri }
}
finally {
  if ($removeArchiveAfterDeployment -and (Test-Path -LiteralPath $archiveFile)) {
    Remove-Item -LiteralPath $archiveFile -Force
  }
}
