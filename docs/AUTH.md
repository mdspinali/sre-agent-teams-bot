# Authentication and authorization

## Separate identities and scopes

| Identity | Configuration / permission | Purpose |
| --- | --- | --- |
| Bot Entra application and service principal | Single-tenant app, `api://botid-<BotAppId>`, Bot Framework redirect URI, bot client secret | Authenticates the bot to Bot Framework and is the OAuth client. |
| App Service managed identity | `Storage Table Data Contributor`; `SRE Agent Standard User`; `https://azuresre.dev/.default` | Keyless table access and application-to-SRE-Agent calls. `.default` is an application/managed-identity token scope, not the user OAuth scope. |
| Teams user | `https://azuresre.dev/Threads.ReadWrite.All` through `sre-obo` | Authorizes an approved write as that user. |

`scripts/bootstrap.ps1 -Phase appreg` creates or configures the single-tenant
bot application. It creates/validates the bot service principal, configures the
identifier URI and Bot Framework redirect URI, and declares the Azure SRE Agent
delegated permission `Threads.ReadWrite.All`. Supplying `-BotAppId` configures
that existing application instead of creating one.

Declaring a delegated permission is not consent. The bootstrap result reports
`ConsentRequired` and an `AdminConsentCommand` if no matching tenant-wide grant
exists. A suitably privileged administrator can run that returned command, or
run the app-registration phase with `-GrantAdminConsent`. Do not grant consent
without reviewing the application and requested scope.

## OAuth connection and OBO

The `sre-obo` Azure AD v2 Bot OAuth connection uses the delegated scope
`https://azuresre.dev/Threads.ReadWrite.All`, the bot app ID/secret, its tenant,
and token-exchange URL `api://botid-<BotAppId>`. It is distinct from the App
Service managed identity's `.default` scope.

For a write, the bridge first clears the SRE Agent gate without an OBO header.
When the agent returns `PendingAuthorization` and required scopes, the bridge
runs the action again with `x-sreagent-obo-scope`; the service exchanges the
interactive user token and executes as the approving user. The bridge therefore
does not hold a standing write role for user actions.

The OAuth bootstrap phase reads an existing connection first. If it already
matches, it returns without changing it and no secret is required. If it is
absent, or differs and is intentionally replaced with
`-ReplaceOAuthConnection`, `-BotAppSecret` is required. The script never puts
the secret through `cmd.exe`; on Windows it invokes the Azure CLI Python entry
point directly so secrets containing shell metacharacters are preserved.
