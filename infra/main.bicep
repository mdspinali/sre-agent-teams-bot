param location string = 'centralus'
@minLength(3)
@maxLength(40)
param appName string
param botDisplayName string = 'SRE Agent Teams Bridge'
param botMicrosoftAppId string
@secure()
param botMicrosoftAppPassword string
param sreAgentEndpoint string
param sreAgentScope string = 'https://azuresre.dev/.default'

var storageName = take(replace(toLower('${appName}st'), '-', ''), 24)
var tableName = 'TeamsSreThreads'
var appServicePlanName = '${appName}-plan'
var appInsightsName = '${appName}-appi'

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
  name: storageName
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

// SRE Agent Standard User role is assigned by scripts/bootstrap.ps1 because the
// agent may live in a different subscription/resource group; cross-scope role
// assignment is handled outside this template.
resource storageTableContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, app.id, 'Storage Table Data Contributor')
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
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
output botMessagingEndpoint string = 'https://${app.properties.defaultHostName}/api/messages'
output tableEndpoint string = storage.properties.primaryEndpoints.table
output appServicePrincipalId string = app.identity.principalId
