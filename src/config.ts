export interface AppConfig {
  readonly port: number;
  readonly microsoftAppId: string;
  readonly microsoftAppPassword: string;
  readonly microsoftAppType: string;
  readonly microsoftAppTenantId: string;
  readonly sreAgentEndpoint: string;
  readonly sreAgentScope: string;
  readonly threadTableEndpoint: string;
  readonly threadTableName: string;
  readonly sreOauthConnectionName: string;
  readonly appInsightsConnectionString?: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

export function loadConfig(): AppConfig {
  const portValue = process.env.PORT ?? "3978";
  const port = Number.parseInt(portValue, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535. Received: ${portValue}`);
  }

  return {
    port,
    microsoftAppId: required("MicrosoftAppId"),
    microsoftAppPassword: required("MicrosoftAppPassword"),
    microsoftAppType: process.env.MicrosoftAppType?.trim() || "SingleTenant",
    microsoftAppTenantId: required("MicrosoftAppTenantId"),
    sreAgentEndpoint: required("SRE_AGENT_ENDPOINT").replace(/\/+$/, ""),
    sreAgentScope: process.env.SRE_AGENT_SCOPE?.trim() || "https://azuresre.dev/.default",
    threadTableEndpoint: required("THREAD_TABLE_ENDPOINT").replace(/\/+$/, ""),
    threadTableName: process.env.THREAD_TABLE_NAME?.trim() || "TeamsSreThreads",
    sreOauthConnectionName: process.env.SRE_OAUTH_CONNECTION_NAME?.trim() || "sre-obo",
    appInsightsConnectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim()
  };
}
