# Authentication and OBO

## Identities

- **Bot Entra app (single-tenant):** authenticates the bot to the Bot Framework. App id + secret only.
- **App Service managed identity:** Azure data-plane access. Holds `Storage Table Data Contributor` (table) and `SRE Agent Standard User` (agent). No secrets.
- **End-user identity:** obtained through the bot OAuth connection `sre-obo` so write commands run as the user.

## OAuth connection

`sre-obo` is an Azure AD v2 connection on the Azure Bot, scope
`https://azuresre.dev/.default`. The user signs in once; the bridge fetches the
user token via `getUserToken` and uses it to authorize escalated commands.

## Two-phase OBO write execution

The SRE Agent gates write commands as an `azCliExecution`. Approving runs it
twice:

1. **First run, no OBO header.** Clears the gate; the command moves to `PendingAuthorization` and returns `requiredScopes`.
2. **Second run with `x-sreagent-obo-scope: <requiredScopes>`.** The data plane exchanges the user token on the server side and executes under the user.

This mirrors the portal's "Grant permissions" behavior. The bridge attaches the
header only for `PendingAuthorization` (`src/teamsSreBot.ts` `authorizeAndRun`,
`src/sreAgentClient.ts` `postExecutionActionObo`). After execution it runs a
no-trigger turn to capture the agent's narrative for the outcome card.

## Tradeoffs

- **Interactive sign-in vs SSO.** SSO is smoother but its token-exchange token cannot be re-exchanged for OBO, so writes stall. Interactive auth-code sign-in yields a re-exchangeable token. We chose interactive.
- **OBO vs standing role.** Granting the bridge a write role would skip OBO but break least-privilege and attribution. OBO keeps writes scoped to the approver: no access for the user means action denied.
- **Public network vs private.** No VNet was provisioned, so table access uses public network + MI RBAC. A private endpoint would harden it at added cost.

## Permissions summary

| Principal | Role / scope | Why |
| --- | --- | --- |
| App MI | Storage Table Data Contributor | Key-less thread map reads/writes |
| App MI | SRE Agent Standard User | Chat with agent, request actions |
| End user | azuresre.dev via sre-obo | Execute approved writes as themselves |
