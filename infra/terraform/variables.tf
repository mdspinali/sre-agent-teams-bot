variable "subscription_id" {
  type        = string
  description = "Azure subscription that hosts the bridge resources."
}

variable "resource_group_name" {
  type        = string
  description = "Resource group to deploy the bridge into. Created if it does not exist."
  default     = "rg-sre-agent-teams-bridge"
}

variable "location" {
  type        = string
  description = "Azure region for the bridge resources."
  default     = "centralus"
}

variable "app_name" {
  type        = string
  description = "Base name for the App Service, bot, plan, storage, and App Insights. 3-40 chars."
}

variable "bot_display_name" {
  type        = string
  description = "Display name shown for the Azure Bot."
  default     = "SRE Agent Teams Bridge"
}

variable "bot_app_id" {
  type        = string
  description = "Entra app (client) ID for the bot, created by scripts/bootstrap.ps1."
}

variable "bot_app_secret" {
  type        = string
  description = "Entra app client secret for the bot."
  sensitive   = true
}

variable "sre_agent_endpoint" {
  type        = string
  description = "SRE Agent data-plane endpoint, e.g. https://<agent>.<region>.azuresre.ai"
}

variable "sre_agent_scope" {
  type        = string
  description = "Token scope for the SRE Agent data plane."
  default     = "https://azuresre.dev/.default"
}

variable "sre_agent_resource_id" {
  type        = string
  description = "Full ARM resource ID of the existing SRE Agent (Microsoft.App/agents/<name>) for the Standard User role assignment."
}
