# SRE Agent Teams Bot

A Microsoft Teams bridge for a **pre-existing Azure SRE Agent**. It keeps one
SRE thread per Teams user, streams responses as Adaptive Cards, and runs
approved writes under the signed-in user's identity. It does not create an SRE
Agent or an empty tenant.

See [PREREQUISITES.md](PREREQUISITES.md), [AUTH.md](docs/AUTH.md), and
[ARCHITECTURE.md](docs/ARCHITECTURE.md) before deployment.

## Deploy

Run these commands from the repository root in Windows PowerShell 5.1+. Set and
verify the intended Azure tenant and bridge subscription explicitly:

```powershell
$TenantId = '<tenant-guid>'
$SubscriptionId = '<bridge-subscription-guid>'
$ResourceGroup = 'rg-sre-agent-teams-bridge'
$AppName = '<globally-unique-app-name>'
$StorageAccountName = '<globally-unique-storage-name>'
$SreAgentSubscriptionId = '<sre-agent-subscription-guid>'
$SreAgentResourceGroupName = '<sre-agent-resource-group>'
$SreAgentName = '<existing-sre-agent-name>'
$SreAgentEndpoint = 'https://<existing-sre-agent>.<region>.azuresre.ai'

az login --tenant $TenantId
az account set --subscription $SubscriptionId
az account show --query '{subscription:id, tenant:tenantId, state:state}' --output json
```

Confirm the returned tenant and subscription. The SRE Agent subscription may
differ from `$SubscriptionId`, but it must be in `$TenantId`; cross-tenant role
assignment is not supported.

### 1. Configure the bot application

Create/configure the app and write its newly created secret once to an
ACL-restricted file. The command does not print the secret:

```powershell
$identity = .\scripts\bootstrap.ps1 -Phase appreg -TenantId $TenantId `
  -SubscriptionId $SubscriptionId -DisplayName 'SRE Agent Teams Bridge' `
  -CreateClientSecret -SecretOutputPath .\bot-secret.txt
```

To configure an application that already exists, add `-BotAppId '<existing-app-guid>'`.
Review `$identity.ConsentRequired`; if it is true, a qualified administrator
must review and run `$identity.AdminConsentCommand` (or use
`-GrantAdminConsent` during the app-registration phase). The app registration
declares delegated `Threads.ReadWrite.All`; consent is a separate operation.

Read the secret into memory without echoing it, and remove the variable after
the deployment steps that need it:

```powershell
$BotAppSecret = [System.IO.File]::ReadAllText('.\bot-secret.txt').Trim()
```

### 2. Deploy infrastructure

Create the bridge resource group, then supply every required Bicep parameter:

```powershell
az group create --name $ResourceGroup --location centralus --subscription $SubscriptionId
az deployment group create --resource-group $ResourceGroup --subscription $SubscriptionId `
  --template-file infra/main.bicep `
  --parameters appName=$AppName storageAccountName=$StorageAccountName `
    botMicrosoftAppId=$identity.BotAppId botMicrosoftAppPassword=@bot-secret.txt `
    sreAgentEndpoint=$SreAgentEndpoint sreAgentSubscriptionId=$SreAgentSubscriptionId `
    sreAgentResourceGroupName=$SreAgentResourceGroupName sreAgentName=$SreAgentName
```

The required Bicep values are `appName`, `storageAccountName`, bot ID/password,
SRE Agent endpoint, and SRE Agent subscription/resource-group/name. Bicep
assigns the App Service managed identity `SRE Agent Standard User` at that
existing agent resource.

Alternatively use Terraform 1.5+. Copy
`infra/terraform/terraform.tfvars.example` to `terraform.tfvars` and populate
only its nonsecret values. Pass the secret ephemerally, not in tfvars:

```powershell
$env:TF_VAR_bot_app_secret = $BotAppSecret
try { terraform -chdir=infra/terraform init; terraform -chdir=infra/terraform apply } finally { Remove-Item Env:TF_VAR_bot_app_secret -ErrorAction SilentlyContinue }
```

Terraform necessarily records the bot secret in state. Use a secured remote
backend with appropriate access controls for team or production use; no backend
is configured by this repository. When finished, remove `$BotAppSecret` and
securely handle/delete `bot-secret.txt` according to your secret-management
policy.

### 3. Create or inspect the OAuth connection

After the Bot exists, use the same in-memory secret only when creating or
replacing its connection:

```powershell
try {
  .\scripts\bootstrap.ps1 -Phase oauth -TenantId $TenantId -SubscriptionId $SubscriptionId `
    -ResourceGroup $ResourceGroup -BotName $AppName -BotAppId $identity.BotAppId `
    -BotAppSecret $BotAppSecret
} finally { Remove-Variable BotAppSecret -ErrorAction SilentlyContinue }
```

The phase reads an existing `sre-obo` connection safely. A matching connection
is left unchanged and does not need a secret. A mismatched connection fails
unless you explicitly add `-ReplaceOAuthConnection`; creating or replacing one
requires `-BotAppSecret`.

### 4. Deploy the application source

Use the source-only deployment command:

```powershell
.\scripts\deploy.ps1 -TenantId $TenantId -SubscriptionId $SubscriptionId -ResourceGroup $ResourceGroup -AppName $AppName
```

It builds an archive from tracked `src/`, `package.json`, `package-lock.json`,
and `tsconfig.json` only. Do **not** add `dist/` or `node_modules/`; WSL is not
needed. Linux App Service Oryx installs production dependencies and compiles the
TypeScript source during remote deployment.

### 5. Package and upload the Teams app

Get the deployed hostname and supply a stable Teams app GUID and developer name:

```powershell
$AppServiceHostname = az webapp show --resource-group $ResourceGroup --name $AppName --subscription $SubscriptionId --query defaultHostName --output tsv
.\scripts\package-teams.ps1 -BotMicrosoftAppId $identity.BotAppId `
  -TeamsAppId '<teams-app-guid>' -AppServiceHostname $AppServiceHostname `
  -DeveloperName '<developer-name>' -OutputPath .\appPackage\teams-app.zip
```

The package is deterministic for the same inputs and includes generated legal
URLs: `https://<hostname>/privacy` and `https://<hostname>/terms` (and the app
root as the default developer website). It verifies those endpoints by default.
Upload `appPackage/teams-app.zip` in **Teams Developer Portal → Apps → Manage
your apps → Import**. Sideloading must be enabled for the tenant.

### 6. Validate

Run the read-only deployment checks:

```powershell
$SreAgentResourceId = "/subscriptions/$SreAgentSubscriptionId/resourceGroups/$SreAgentResourceGroupName/providers/Microsoft.App/agents/$SreAgentName"
.\scripts\validate-deployment.ps1 -TenantId $TenantId -SubscriptionId $SubscriptionId `
  -ResourceGroup $ResourceGroup -AppName $AppName -SreAgentResourceId $SreAgentResourceId `
  -StorageAccountName $StorageAccountName -TeamsPackagePath .\appPackage\teams-app.zip
```

The validator reads the agent subscription from `SreAgentResourceId`, verifies
that it belongs to `$TenantId`, and checks the role assignment at that exact
resource scope.

## Local configuration

Copy `.env.example` to `.env` for local runs. Azure uses the equivalent App
Service settings. `SRE_AGENT_SCOPE` is the managed-identity `.default` scope;
`SRE_OAUTH_CONNECTION_NAME` identifies the separate delegated OAuth connection.

```powershell
npm install
npm run build
npm test
```

## Disclaimer and license

This independent community sample is provided **as is**, without warranty,
support commitment, or SLA. It is not affiliated with or endorsed by Microsoft.
Deploying it creates billable Azure resources and can enable users to perform
approved control-plane actions. Review the code, identities, permissions, and
costs before use. Released under the [MIT License](LICENSE).
