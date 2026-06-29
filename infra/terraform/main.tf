data "azurerm_subscription" "current" {}

locals {
  storage_name = substr(replace(lower("${var.app_name}st"), "-", ""), 0, 24)
  table_name   = "TeamsSreThreads"
}

resource "azurerm_resource_group" "rg" {
  name     = var.resource_group_name
  location = var.location
}

resource "azurerm_service_plan" "plan" {
  name                = "${var.app_name}-plan"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  os_type             = "Linux"
  sku_name            = "B1"
}

resource "azurerm_application_insights" "appi" {
  name                = "${var.app_name}-appi"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  application_type    = "web"
}

resource "azurerm_storage_account" "storage" {
  name                            = local.storage_name
  resource_group_name             = azurerm_resource_group.rg.name
  location                        = azurerm_resource_group.rg.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  public_network_access_enabled   = true
}

resource "azurerm_storage_table" "threads" {
  name                 = local.table_name
  storage_account_name = azurerm_storage_account.storage.name
}

resource "azurerm_linux_web_app" "app" {
  name                = var.app_name
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  service_plan_id     = azurerm_service_plan.plan.id
  https_only          = true

  identity {
    type = "SystemAssigned"
  }

  site_config {
    always_on        = true
    app_command_line = "npm start"
    application_stack {
      node_version = "20-lts"
    }
  }

  app_settings = {
    PORT                                  = "8080"
    MicrosoftAppId                        = var.bot_app_id
    MicrosoftAppPassword                  = var.bot_app_secret
    MicrosoftAppType                      = "SingleTenant"
    MicrosoftAppTenantId                  = data.azurerm_subscription.current.tenant_id
    SRE_AGENT_ENDPOINT                    = var.sre_agent_endpoint
    SRE_AGENT_SCOPE                       = var.sre_agent_scope
    THREAD_TABLE_ENDPOINT                 = azurerm_storage_account.storage.primary_table_endpoint
    THREAD_TABLE_NAME                     = local.table_name
    APPLICATIONINSIGHTS_CONNECTION_STRING = azurerm_application_insights.appi.connection_string
    SCM_DO_BUILD_DURING_DEPLOYMENT        = "true"
  }
}

resource "azurerm_role_assignment" "table_contributor" {
  scope                = azurerm_storage_account.storage.id
  role_definition_name = "Storage Table Data Contributor"
  principal_id         = azurerm_linux_web_app.app.identity[0].principal_id
}

# Standard User on the existing SRE Agent so the bridge can chat and request actions.
resource "azurerm_role_assignment" "sre_standard_user" {
  scope                = var.sre_agent_resource_id
  role_definition_name = "SRE Agent Standard User"
  principal_id         = azurerm_linux_web_app.app.identity[0].principal_id
}

resource "azurerm_bot_service_azure_bot" "bot" {
  name                    = var.app_name
  resource_group_name     = azurerm_resource_group.rg.name
  location                = "global"
  sku                     = "F0"
  microsoft_app_id        = var.bot_app_id
  microsoft_app_type      = "SingleTenant"
  microsoft_app_tenant_id = data.azurerm_subscription.current.tenant_id
  display_name            = var.bot_display_name
  endpoint                = "https://${azurerm_linux_web_app.app.default_hostname}/api/messages"
}

resource "azurerm_bot_channel_ms_teams" "teams" {
  bot_name            = azurerm_bot_service_azure_bot.bot.name
  resource_group_name = azurerm_resource_group.rg.name
  location            = "global"
}
