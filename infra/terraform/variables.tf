variable "subscription_id" {
  type        = string
  description = "Azure subscription that hosts the bridge resources."

  validation {
    condition     = can(regex("^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$", var.subscription_id))
    error_message = "subscription_id must be a GUID."
  }
}

variable "resource_group_name" {
  type        = string
  description = "Resource group to deploy the bridge into. Created if it does not exist."
  default     = "rg-sre-agent-teams-bridge"

  validation {
    condition     = length(var.resource_group_name) >= 1 && length(var.resource_group_name) <= 90 && can(regex("^[A-Za-z0-9._()-]*[A-Za-z0-9_()-]$", var.resource_group_name))
    error_message = "resource_group_name must be 1-90 valid Azure resource-group name characters and must not end with a period."
  }
}

variable "location" {
  type        = string
  description = "Azure region for the bridge resources."
  default     = "centralus"
}

variable "app_name" {
  type        = string
  description = "Globally unique base name for the app and bot. Use 4-40 lowercase alphanumeric or hyphen characters, starting and ending with alphanumeric."

  validation {
    condition     = length(var.app_name) >= 4 && length(var.app_name) <= 40 && can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", var.app_name))
    error_message = "app_name must be 4-40 lowercase alphanumeric or hyphen characters and must start and end with an alphanumeric character."
  }
}

variable "storage_account_name" {
  type        = string
  description = "Globally unique Storage account name. Use the same explicit value for Bicep and Terraform; 3-24 lowercase letters and numbers."

  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.storage_account_name))
    error_message = "storage_account_name must be 3-24 lowercase letters and numbers."
  }
}

variable "bot_display_name" {
  type        = string
  description = "Display name shown for the Azure Bot."
  default     = "SRE Agent Teams Bridge"
}

variable "bot_app_id" {
  type        = string
  description = "Entra app (client) ID for the bot, created by scripts/bootstrap.ps1."

  validation {
    condition     = can(regex("^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$", var.bot_app_id))
    error_message = "bot_app_id must be a GUID."
  }
}

variable "bot_app_secret" {
  type        = string
  description = "Entra app client secret for the bot. Terraform necessarily stores this App Service setting in state; secure the selected state storage."
  sensitive   = true
}

variable "sre_agent_endpoint" {
  type        = string
  description = "SRE Agent data-plane endpoint, e.g. https://<agent>.<region>.azuresre.ai"

  validation {
    condition     = can(regex("^https://[^/[:space:]]+$", var.sre_agent_endpoint))
    error_message = "sre_agent_endpoint must be an HTTPS origin without a path or trailing slash."
  }
}

variable "sre_agent_scope" {
  type        = string
  description = "Token scope for the SRE Agent data plane."
  default     = "https://azuresre.dev/.default"
}

variable "sre_agent_resource_id" {
  type        = string
  description = "Full ARM resource ID of an existing SRE Agent in the same Microsoft Entra tenant. Same-tenant cross-subscription scopes are supported; cross-tenant role assignment is not supported."

  validation {
    condition     = can(regex("^/subscriptions/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/resourceGroups/[A-Za-z0-9._()-]{0,89}[A-Za-z0-9_()-]/providers/Microsoft\\.App/agents/[A-Za-z][-A-Za-z0-9]{0,30}[A-Za-z0-9]$", var.sre_agent_resource_id))
    error_message = "sre_agent_resource_id must have the exact form /subscriptions/<GUID>/resourceGroups/<resource-group>/providers/Microsoft.App/agents/<agent>."
  }
}
