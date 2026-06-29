<#
.SYNOPSIS
  Provisions the Entra pieces that ARM/Bicep/Terraform cannot: the bot app
  registration + secret, and the bot's OAuth "sre-obo" connection used for
  on-behalf-of approvals against the Azure SRE Agent.

.DESCRIPTION
  Run in two phases:

    1) -Phase appreg   Creates a single-tenant Entra app + client secret and
                       prints BOT_APP_ID / BOT_APP_SECRET. Feed these into
                       Bicep (botMicrosoftAppId/botMicrosoftAppPassword) or
                       Terraform (bot_app_id/bot_app_secret), then deploy the IaC.

    2) -Phase oauth    After the Azure Bot exists, creates the bot OAuth
                       connection (Azure AD v2, scope azuresre.dev/.default)
                       named "sre-obo" so chat-approved write commands run as
                       the signed-in user.

  Only off-direction: this script creates identities/connections; it never
  starts, stops, or deletes Azure resources.

.EXAMPLE
  ./bootstrap.ps1 -Phase appreg -DisplayName "SRE Agent Teams Bridge"
  ./bootstrap.ps1 -Phase oauth -ResourceGroup rg-sre-agent-teams-bridge -BotName sre-bridge -BotAppId <id> -BotAppSecret <secret>
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [ValidateSet("appreg", "oauth")] [string] $Phase,
  [string] $DisplayName = "SRE Agent Teams Bridge",
  [string] $ResourceGroup,
  [string] $BotName,
  [string] $BotAppId,
  [string] $BotAppSecret,
  [string] $ConnectionName = "sre-obo",
  [string] $SreScope = "https://azuresre.dev/.default"
)

$ErrorActionPreference = "Stop"

function Require-Cmd($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Required command '$name' not found on PATH."
  }
}

Require-Cmd az

if ($Phase -eq "appreg") {
  Write-Host "Creating single-tenant Entra app '$DisplayName'..."
  $appId = az ad app create --display-name $DisplayName --sign-in-audience AzureADMyOrg --query appId -o tsv
  if (-not $appId) { throw "App creation failed." }

  $secret = az ad app credential reset --id $appId --display-name "bot-secret" --query password -o tsv
  $tenantId = az account show --query tenantId -o tsv

  Write-Host ""
  Write-Host "Feed these into your IaC variables, then deploy:"
  Write-Host "  BOT_APP_ID     = $appId"
  Write-Host "  BOT_APP_SECRET = $secret"
  Write-Host "  TENANT_ID      = $tenantId"
  return
}

if ($Phase -eq "oauth") {
  foreach ($p in @("ResourceGroup", "BotName", "BotAppId", "BotAppSecret")) {
    if (-not (Get-Variable $p -ValueOnly)) { throw "-$p is required for phase 'oauth'." }
  }
  $tenantId = az account show --query tenantId -o tsv
  Write-Host "Creating OAuth connection '$ConnectionName' on bot '$BotName'..."
  az bot authsetting create `
    --resource-group $ResourceGroup `
    --name $BotName `
    --setting-name $ConnectionName `
    --provider azuread-v2 `
    --client-id $BotAppId `
    --client-secret $BotAppSecret `
    --parameters tenantId=$tenantId tokenExchangeUrl="api://botid-$BotAppId" `
    --scopes $SreScope | Out-Null
  Write-Host "OAuth connection '$ConnectionName' created. Set SRE_OAUTH_CONNECTION_NAME=$ConnectionName."
  return
}
