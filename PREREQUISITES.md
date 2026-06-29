# Prerequisites: Azure SRE Agent to Teams bridge

Setup has three parts: the **Bot Service**, the **hosted app** (App Service + Storage + RBAC), and the **Teams custom app**. Each prerequisite links to the Microsoft Learn doc it comes from.

## Part 0: Foundation

- Active Azure subscription in your tenant.
- An **SRE Agent already created**. Creating one needs your user account to hold `Microsoft.Authorization/roleAssignments/write` (**RBAC Administrator** or **User Access Administrator**), and `*.azuresre.ai` allow-listed on your firewall. See [Create and use an agent › Prerequisites](https://learn.microsoft.com/en-us/azure/sre-agent/usage#prerequisites) and the [SRE Agent overview](https://learn.microsoft.com/en-us/azure/sre-agent/overview).

## Part 1: Bot Service

- **Entra app registration (single-tenant).** Produces the bot identity: `MicrosoftAppId` + a client secret. Choose *"Single tenant only"*. See [Register an app in Microsoft Entra ID](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app).
- **Azure Bot resource.** App type must be **single-tenant** or **user-assigned managed identity**. Multi-tenant creation was deprecated July 31, 2025. Point its messaging endpoint at `https://<app>/api/messages`. See [Create an Azure Bot resource](https://learn.microsoft.com/en-us/azure/bot-service/abs-quickstart?view=azure-bot-service-4.0).
- **Microsoft Teams channel.** On the Azure Bot, add **Channels → Microsoft Teams**. See [Connect a bot to Microsoft Teams](https://learn.microsoft.com/en-us/azure/bot-service/channel-connect-teams?view=azure-bot-service-4.0).

## Part 2: Hosted app (App Service + Storage + RBAC)

- **App Service (Linux, Node 20)** hosting the relay and exposing `/api/messages`. Must be **B1 or higher with Always On** so it doesn't idle-unload and drop the first Teams message. See [Managed identities for App Service](https://learn.microsoft.com/en-us/azure/app-service/overview-managed-identity).
- **System-assigned managed identity** on that App Service. This is the app's single Azure identity (`DefaultAzureCredential`), no secrets to rotate. Same doc: [Managed identities for App Service](https://learn.microsoft.com/en-us/azure/app-service/overview-managed-identity).
- **Storage account with a Table** (`TeamsSreThreads`) storing the Teams-conversation → SRE-Agent-thread mapping, so each user keeps one continuous thread.
- **RBAC: `Storage Table Data Contributor`** on that storage account, assigned to the App Service managed identity (role id `0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3`). This gives key-less table access. See [Assign an Azure role for storage data access](https://learn.microsoft.com/en-us/azure/storage/blobs/assign-azure-role-data-access) and the [built-in roles list](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles).
- **App settings:** `MicrosoftAppId`, `MicrosoftAppPassword`, `MicrosoftAppType=SingleTenant`, `MicrosoftAppTenantId`, `SRE_AGENT_ENDPOINT`, `SRE_AGENT_SCOPE=https://azuresre.dev/.default`, `THREAD_TABLE_ENDPOINT`, `THREAD_TABLE_NAME`, `APPLICATIONINSIGHTS_CONNECTION_STRING`.
- **RBAC: `SRE Agent Standard User`** on the SRE Agent resource (`Microsoft.App/agents/<agent>`), assigned to the App Service managed identity. This authorizes the bridge to chat with the agent and request actions (token scope `https://azuresre.dev/.default`). See [User roles and permissions in Azure SRE Agent](https://learn.microsoft.com/en-us/azure/sre-agent/user-roles). Note: this assignment is applied directly to the agent today and is not yet in `infra/main.bicep`.

## Part 3: Teams custom app

- **Microsoft 365 tenant with Teams** on a qualifying plan (Business, E1/E3/E5, Developer, or Education). See [Prepare your Microsoft 365 tenant](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/prepare-your-o365-tenant).
- **Custom app upload (sideloading) enabled** by a Teams Administrator: Teams admin center → Teams apps → Setup policies → *Upload custom apps = On*. Not available in GCC High, DoD, or 21Vianet. See [Enable custom app upload](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/prepare-your-o365-tenant#enable-custom-teams-apps-and-configure-custom-app-upload-settings).
- **Teams app package** (manifest + icons) referencing the bot's `MicrosoftAppId`, built in the [Teams Developer Portal](https://dev.teams.microsoft.com/), then uploaded via Teams → Apps → Manage your apps → Upload a custom app. The app must already be running over HTTPS. See [Upload your custom app](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload).
