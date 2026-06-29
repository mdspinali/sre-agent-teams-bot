import { TokenCredential } from "@azure/identity";
import { decodeTokenClaims, trace, truncateBody } from "./trace.js";

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Options for {@link SreAgentClient.postMessage}. */
export interface PostMessageOptions {
  /** Max number of retries when the agent reports HTTP 422 "busy". */
  readonly maxRetries?: number;
  /** Base delay between 422 retries, in milliseconds. */
  readonly retryDelayMs?: number;
}

export class SreAgentHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: string
  ) {
    super(message);
    this.name = "SreAgentHttpError";
  }
}

interface CreateThreadResponse {
  readonly id: string;
}

/** A write command the agent left Pending in Review mode, awaiting approval. */
export interface PendingExecution {
  readonly execId: string;
  readonly command: string;
  readonly status: string;
  /**
   * Downstream scope the SRE backend needs for the on-behalf-of token exchange,
   * present only when the agent escalated the command to PendingAuthorization.
   * Sent as the `x-sreagent-obo-scope` header when approving.
   */
  readonly requiredScopes?: string;
}

/** Who executed a command, as reported by the SRE backend. */
export interface ExecutionActor {
  readonly role?: string | null;
  readonly userId?: string | null;
  /** e.g. "System Administrator <admin@contoso.com>" for an OBO user execution. */
  readonly displayName?: string | null;
}

/** The current state of an azCli write command execution. */
export interface ExecutionResult {
  readonly id: string;
  readonly command: string;
  readonly status: string;
  readonly output?: string | null;
  readonly error?: string | null;
  /**
   * Downstream scopes the backend needs for the OBO exchange, populated once the
   * command escalates to `PendingAuthorization`. Normalized to a comma-joined string.
   * Sent back as the `x-sreagent-obo-scope` header to authorize the escalated run.
   */
  readonly requiredScopes?: string;
  /** Short human label the agent assigned the action, e.g. "Starting Azure resource". */
  readonly description?: string | null;
  /** The identity the command ran under; for OBO writes this is the approving user. */
  readonly executedBy?: ExecutionActor | null;
  /** ISO 8601 timestamp when execution started. */
  readonly startedTimestamp?: string | null;
  /** ISO 8601 timestamp when execution completed. */
  readonly completedTimestamp?: string | null;
}

/** The action to take on a pending write command: run (approve) or cancel (reject). */
export type ExecutionAction = "run" | "cancel";

/**
 * Path segment for the azCli write-command execution resource. The data plane
 * routes both `/status` and `/action` under `/api/v1/{kind}/...`; this is the
 * `kind` the portal uses for `az` write commands (case-insensitive).
 */
const AZ_CLI_KIND = "azCliExecution";

interface ThreadMessagesResponse {
  readonly value?: ReadonlyArray<{
    readonly azCliExecution?: {
      readonly id?: string;
      readonly command?: string;
      readonly status?: string;
      readonly expiredByTimeout?: boolean;
      readonly requiredScopes?: string | readonly string[] | null;
    } | null;
  }>;
}

/**
 * REST client for the Azure SRE Agent data plane. Posting a message (or creating
 * a thread with a start message) triggers the agent to process the turn; the
 * streamed response (reasoning, tool calls, final answer) is delivered out of
 * band over the SignalR `/agentHub` and consumed by {@link SreAgentStream}.
 */
export class SreAgentClient {
  constructor(
    private readonly endpoint: string,
    private readonly scope: string,
    private readonly credential: TokenCredential,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async createThread(startMessageText: string): Promise<string> {
    if (!startMessageText || startMessageText.trim().length === 0) {
      throw new Error("Cannot create an SRE Agent thread with an empty start message.");
    }

    const url = `${this.endpoint}/api/v1/threads`;
    trace("sre_create_thread_request", { url });
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({ startMessage: { text: startMessageText } })
    });

    const rawBody = await response.text();
    trace("sre_create_thread_response", { url, status: response.status, ok: response.ok, body: truncateBody(rawBody) });

    if (!response.ok) {
      throw new SreAgentHttpError(
        `SRE Agent thread create failed with HTTP ${response.status}: ${rawBody}`,
        response.status,
        rawBody
      );
    }

    const body = JSON.parse(rawBody) as CreateThreadResponse;
    if (!isUuid(body.id)) {
      throw new Error(`SRE Agent thread create returned an invalid thread ID: ${body.id}`);
    }
    return body.id;
  }

  async postMessage(threadId: string, text: string, options: PostMessageOptions = {}): Promise<void> {
    if (!isUuid(threadId)) {
      throw new Error(`SRE thread ID must be a UUID. Received: ${threadId}`);
    }
    if (!text || text.trim().length === 0) {
      throw new Error("Cannot send an empty message to the SRE Agent.");
    }

    // The SRE backend processes one turn per thread. A message posted while the agent is
    // still working the previous turn returns HTTP 422 "The agent is currently busy...".
    // That used to surface to the user as "The SRE Agent bridge hit an error." Retry the
    // post a bounded number of times so a quick follow-up question lands once the agent
    // frees up instead of failing the whole turn.
    const maxRetries = options.maxRetries ?? 5;
    const retryDelayMs = options.retryDelayMs ?? 1500;

    for (let attempt = 0; ; attempt++) {
      const url = `${this.endpoint}/api/v1/threads/${threadId}/messages`;
      trace("sre_post_message_request", { url, threadId, attempt, textLength: text.length });
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: await this.headers(),
        body: JSON.stringify({ text })
      });

      if (response.ok) {
        trace("sre_post_message_response", { url, threadId, attempt, status: response.status, ok: true });
        return;
      }

      const responseBody = await response.text();
      trace("sre_post_message_response", { url, threadId, attempt, status: response.status, ok: false, body: truncateBody(responseBody) });
      if (response.status === 422 && attempt < maxRetries) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }

      throw new SreAgentHttpError(
        `SRE Agent message send failed with HTTP ${response.status}: ${responseBody}`,
        response.status,
        responseBody
      );
    }
  }

  /**
   * Lists the write commands the agent is currently waiting on the user to
   * approve (azCli executions in `Pending` status, excluding ones that already
   * expired). This is read directly from the thread so approval works correctly
   * even across bridge restarts or instance changes.
   */
  async listPendingExecutions(threadId: string): Promise<PendingExecution[]> {
    if (!isUuid(threadId)) {
      throw new Error(`SRE thread ID must be a UUID. Received: ${threadId}`);
    }

    const body = await this.getJson<ThreadMessagesResponse>(`/api/v1/threads/${threadId}/messages`);
    const pending: PendingExecution[] = [];
    for (const message of body.value ?? []) {
      const execution = message.azCliExecution;
      if (
        execution &&
        (execution.status === "Pending" || execution.status === "PendingAuthorization") &&
        !execution.expiredByTimeout &&
        execution.id &&
        execution.command
      ) {
        const oboScope = oboScopeOf(execution.requiredScopes);
        pending.push({
          execId: execution.id,
          command: execution.command,
          status: execution.status,
          ...(oboScope ? { requiredScopes: oboScope } : {})
        });
      }
    }
    return pending;
  }

  /**
   * Approves (`run`) or rejects (`cancel`) a pending write command. Requires the
   * caller identity to hold the SRE Agent Administrator role; Standard User
   * cannot approve. Returns the updated execution state.
   */
  async postExecutionAction(
    threadId: string,
    execId: string,
    action: ExecutionAction
  ): Promise<ExecutionResult> {
    if (!isUuid(threadId)) {
      throw new Error(`SRE thread ID must be a UUID. Received: ${threadId}`);
    }
    if (!isGuid(execId)) {
      throw new Error(`SRE execution ID must be a GUID. Received: ${execId}`);
    }

    const url = `${this.endpoint}/api/v1/${AZ_CLI_KIND}/${threadId}/${execId}/action`;
    trace("sre_action_request", { url, threadId, execId, action, identity: "managed-identity" });
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({ action, user: "sreagent-client", ApproveScope: "none" })
    });

    const rawBody = await response.text();
    trace("sre_action_response", { url, threadId, execId, action, status: response.status, ok: response.ok, body: truncateBody(rawBody) });

    if (!response.ok) {
      throw new SreAgentHttpError(
        `SRE Agent execution ${action} failed with HTTP ${response.status}: ${rawBody}`,
        response.status,
        rawBody
      );
    }

    return (rawBody ? JSON.parse(rawBody) : {}) as ExecutionResult;
  }

  /**
   * Approves (`run`) a pending write command using the approving user's delegated
   * SRE data-plane token instead of the bridge managed identity. When the bearer
   * is a user token, the SRE backend executes the command under that user's Azure
   * permissions via the on-behalf-of flow (this is how a Reader-level agent runs
   * writes). When `oboScope` is provided (the command's requiredScopes, present
   * for PendingAuthorization), it is forwarded as the `x-sreagent-obo-scope`
   * header so the backend exchanges for the correct downstream scope.
   */
  async postExecutionActionObo(
    threadId: string,
    execId: string,
    action: ExecutionAction,
    userToken: string,
    userId: string,
    oboScope?: string
  ): Promise<ExecutionResult> {
    if (!isUuid(threadId)) {
      throw new Error(`SRE thread ID must be a UUID. Received: ${threadId}`);
    }
    if (!isGuid(execId)) {
      throw new Error(`SRE execution ID must be a GUID. Received: ${execId}`);
    }
    if (!userToken || userToken.trim().length === 0) {
      throw new Error("OBO execution requires a non-empty user token.");
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${userToken}`,
      "content-type": "application/json"
    };
    if (oboScope && oboScope.trim().length > 0) {
      headers["x-sreagent-obo-scope"] = oboScope;
    }

    const url = `${this.endpoint}/api/v1/${AZ_CLI_KIND}/${threadId}/${execId}/action`;
    const requestBody = JSON.stringify({ action, user: userId, ApproveScope: "none" });
    trace("sre_obo_action_request", {
      url,
      threadId,
      execId,
      action,
      user: userId,
      approveScope: "none",
      hasOboScopeHeader: Boolean(headers["x-sreagent-obo-scope"]),
      oboScope: headers["x-sreagent-obo-scope"],
      userTokenClaims: decodeTokenClaims(userToken)
    });

    const response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: requestBody
    });

    const rawBody = await response.text();
    trace("sre_obo_action_response", {
      threadId,
      execId,
      action,
      status: response.status,
      ok: response.ok,
      wwwAuthenticate: response.headers.get("www-authenticate"),
      body: truncateBody(rawBody)
    });

    if (!response.ok) {
      throw new SreAgentHttpError(
        `SRE Agent OBO execution ${action} failed with HTTP ${response.status}: ${rawBody}`,
        response.status,
        rawBody
      );
    }

    const rawParsed = (rawBody ? JSON.parse(rawBody) : {}) as ExecutionResult & {
      requiredScopes?: string | readonly string[] | null;
    };
    const parsed: ExecutionResult = { ...rawParsed, requiredScopes: oboScopeOf(rawParsed.requiredScopes) };
    trace("sre_obo_action_result", {
      threadId,
      execId,
      action,
      resultStatus: parsed.status,
      requiredScopes: parsed.requiredScopes,
      hasOutput: Boolean(parsed.output),
      hasError: Boolean(parsed.error)
    });
    return parsed;
  }

  /** Reads the current state of a write command execution. */
  async getExecutionStatus(threadId: string, execId: string): Promise<ExecutionResult> {
    if (!isUuid(threadId)) {
      throw new Error(`SRE thread ID must be a UUID. Received: ${threadId}`);
    }
    if (!isGuid(execId)) {
      throw new Error(`SRE execution ID must be a GUID. Received: ${execId}`);
    }

    const raw = await this.getJson<ExecutionResult & { requiredScopes?: string | readonly string[] | null }>(
      `/api/v1/${AZ_CLI_KIND}/${threadId}/${execId}/status`
    );
    return { ...raw, requiredScopes: oboScopeOf(raw.requiredScopes) };
  }

  private async getJson<T>(path: string): Promise<T> {
    const url = `${this.endpoint}${path}`;
    trace("sre_get_request", { url });
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: await this.headers()
    });

    const rawBody = await response.text();
    trace("sre_get_response", { url, status: response.status, ok: response.ok, bodyLength: rawBody.length });

    if (!response.ok) {
      throw new SreAgentHttpError(
        `SRE Agent GET ${path} failed with HTTP ${response.status}: ${rawBody}`,
        response.status,
        rawBody
      );
    }

    return (rawBody ? JSON.parse(rawBody) : {}) as T;
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.credential.getToken(this.scope);
    if (!token) {
      throw new Error(`Failed to acquire token for scope ${this.scope}`);
    }
    trace("sre_mi_token_acquired", { scope: this.scope, claims: decodeTokenClaims(token.token) });
    return {
      authorization: `Bearer ${token.token}`,
      "content-type": "application/json"
    };
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// Execution IDs are GUID-shaped but not always RFC-4122 versioned (the agent
// emits values with version/variant nibbles outside the v1-5 range), so they are
// validated with a lenient hex-GUID check rather than the strict UUID check.
function isGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function oboScopeOf(requiredScopes: string | readonly string[] | null | undefined): string | undefined {
  if (!requiredScopes) {
    return undefined;
  }
  const value = Array.isArray(requiredScopes) ? requiredScopes.join(",") : String(requiredScopes);
  return value.trim().length > 0 ? value : undefined;
}

