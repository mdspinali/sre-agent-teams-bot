targetScope = 'resourceGroup'

param location string = 'centralus'
@description('Globally unique base name for the app and bot. Length is validated here; Azure validates the documented lowercase-alphanumeric-and-hyphen naming rules.')
@minLength(4)
@maxLength(40)
param appName string
@description('Globally unique Storage account name. Provide the same value to Terraform when switching deployment tools. Length is validated here; Azure validates lowercase letters and numbers.')
@minLength(3)
@maxLength(24)
param storageAccountName string
param botDisplayName string = 'SRE Agent Teams Bridge'
param botMicrosoftAppId string
@secure()
param botMicrosoftAppPassword string
param sreAgentEndpoint string
param sreAgentScope string = 'https://azuresre.dev/.default'
@description('Subscription GUID containing the existing SRE Agent. Length is validated here; ARM validates the GUID. Same-tenant cross-subscription deployment is supported; cross-tenant role assignment is not supported for the App Service managed identity.')
@minLength(36)
@maxLength(36)
param sreAgentSubscriptionId string
@description('Resource group containing the existing SRE Agent. Length is validated here; ARM validates resource-group naming rules.')
@minLength(1)
@maxLength(90)
param sreAgentResourceGroupName string
@description('Name of the existing SRE Agent. Length is validated here; Microsoft.App validates the documented naming rules.')
@minLength(2)
@maxLength(32)
param sreAgentName string

var tableName = 'TeamsSreThreads'
var appServicePlanName = '${appName}-plan'
var appInsightsName = '${appName}-appi'
var sreAgentId = resourceId(sreAgentSubscriptionId, sreAgentResourceGroupName, 'Microsoft.App/agents', sreAgentName)

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  sku: {
    name: 'B1'
    tier: 'Basic'
    capacity: 1
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    publicNetworkAccess: 'Enabled'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource threadTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: tableName
}

resource app 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  kind: 'app,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      appCommandLine: 'npm start'
      alwaysOn: true
      appSettings: [
        {
          name: 'PORT'
          value: '8080'
        }
        {
          name: 'MicrosoftAppId'
          value: botMicrosoftAppId
        }
        {
          name: 'MicrosoftAppPassword'
          value: botMicrosoftAppPassword
        }
        {
          name: 'MicrosoftAppType'
          value: 'SingleTenant'
        }
        {
          name: 'MicrosoftAppTenantId'
          value: subscription().tenantId
        }
        {
          name: 'SRE_AGENT_ENDPOINT'
          value: sreAgentEndpoint
        }
        {
          name: 'SRE_AGENT_SCOPE'
          value: sreAgentScope
        }
        {
          name: 'THREAD_TABLE_ENDPOINT'
          value: storage.properties.primaryEndpoints.table
        }
        {
          name: 'THREAD_TABLE_NAME'
          value: tableName
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsights.properties.ConnectionString
        }
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'true'
        }
      ]
    }
  }
}

resource storageTableContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, app.id, 'Storage Table Data Contributor')
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

module sreAgentStandardUser './modules/sre-agent-role-assignment.bicep' = {
  name: 'sre-agent-standard-user-${uniqueString(sreAgentId, app.id)}'
  scope: resourceGroup(sreAgentSubscriptionId, sreAgentResourceGroupName)
  params: {
    agentName: sreAgentName
    principalId: app.identity.principalId
  }
}

resource bot 'Microsoft.BotService/botServices@2022-09-15' = {
  name: appName
  location: 'global'
  kind: 'azurebot'
  sku: {
    name: 'F0'
  }
  properties: {
    displayName: botDisplayName
    endpoint: 'https://${app.properties.defaultHostName}/api/messages'
    msaAppId: botMicrosoftAppId
    msaAppTenantId: subscription().tenantId
    msaAppType: 'SingleTenant'
  }
}

resource teamsChannel 'Microsoft.BotService/botServices/channels@2022-09-15' = {
  parent: bot
  name: 'MsTeamsChannel'
  location: 'global'
  properties: {
    channelName: 'MsTeamsChannel'
  }
}

output appServiceUrl string = 'https://${app.properties.defaultHostName}'
output appServiceHostname string = app.properties.defaultHostName
output appServiceName string = app.name
output botName string = bot.name
output resourceGroupName string = resourceGroup().name
output botMessagingEndpoint string = 'https://${app.properties.defaultHostName}/api/messages'
output tableEndpoint string = storage.properties.primaryEndpoints.table
output appServicePrincipalId string = app.identity.principalId
output sreAgentResourceId string = sreAgentId
