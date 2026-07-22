output "app_service_url" {
  value = "https://${azurerm_linux_web_app.app.default_hostname}"
}

output "app_service_hostname" {
  value = azurerm_linux_web_app.app.default_hostname
}

output "app_service_name" {
  value = azurerm_linux_web_app.app.name
}

output "bot_name" {
  value = azurerm_bot_service_azure_bot.bot.name
}

output "resource_group_name" {
  value = azurerm_resource_group.rg.name
}

output "bot_messaging_endpoint" {
  value = "https://${azurerm_linux_web_app.app.default_hostname}/api/messages"
}

output "table_endpoint" {
  value = azurerm_storage_account.storage.primary_table_endpoint
}

output "app_principal_id" {
  value = azurerm_linux_web_app.app.identity[0].principal_id
}
