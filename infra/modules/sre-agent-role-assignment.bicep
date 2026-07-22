targetScope = 'resourceGroup'

@minLength(2)
@maxLength(32)
param agentName string
@minLength(36)
@maxLength(36)
param principalId string

resource sreAgent 'Microsoft.App/agents@2026-01-01' existing = {
  name: agentName
}

resource sreAgentStandardUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(sreAgent.id, principalId, 'SRE Agent Standard User')
  scope: sreAgent
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2d84a65a-63b2-4343-bbb6-31105d857bc1')
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
