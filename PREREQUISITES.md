# Prerequisites

This repository deploys a Teams bridge **to an existing Azure SRE Agent**. It
does not create an SRE Agent or an empty tenant. The bridge and the SRE Agent
may use different Azure subscriptions only when both are in the same Microsoft
Entra tenant; cross-tenant deployment is not supported.

## Workstation and access

- Windows PowerShell **5.1 or later**, Azure CLI **2.87.0 or later**, and Node
  **20**. Use either Bicep or Terraform **1.5 or later**.
- An enabled Azure subscription for the bridge resources, and the subscription,
  resource group, name, and HTTPS endpoint of the pre-existing SRE Agent.
- Permission to create/read/update the bot Entra application and service
  principal, declare its delegated permission, and obtain tenant admin consent
  when required. See [AUTH.md](docs/AUTH.md).
- Azure permissions to create the resource group/resources and assign `Storage
  Table Data Contributor` and `SRE Agent Standard User`. For a cross-subscription
  SRE Agent, the deployer needs the applicable role-assignment permission in its
  subscription as well as the bridge subscription.
- A Teams tenant where a Teams administrator permits custom-app upload
  (sideloading), and an account permitted to upload the package.

## Select and verify the Azure context

Set these values before running a script or IaC command. Do not rely on an
ambient Azure CLI context:

```powershell
$TenantId = '<tenant-guid>'
$SubscriptionId = '<bridge-subscription-guid>'
az login --tenant $TenantId
az account set --subscription $SubscriptionId
az account show --query '{subscription:id, tenant:tenantId, state:state}' --output json
```

Confirm that the returned subscription and tenant equal `$SubscriptionId` and
`$TenantId`, and that the subscription is enabled. The bootstrap and deployment
scripts repeat this validation before making their changes.

## Azure resources and Teams

The IaC provisions a Linux B1 App Service (Node 20, Always On), Azure Bot with
the Teams channel, Storage Table, Application Insights, and a system-assigned
managed identity. It assigns the identity `Storage Table Data Contributor` and
`SRE Agent Standard User`. The latter can target an existing SRE Agent in a
different subscription in the selected tenant.

The generated Teams package has real HTTPS policy URLs at the deployed app's
`/privacy` and `/terms` routes. Do not package or upload the app until those
routes are reachable.

Useful references: [SRE Agent prerequisites](https://learn.microsoft.com/en-us/azure/sre-agent/usage#prerequisites), [Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/abs-quickstart?view=azure-bot-service-4.0), and [Teams custom-app upload](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload).
