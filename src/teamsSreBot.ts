import { Activity, Attachment, CardFactory, InvokeException, MessageFactory, StatusCodes, TeamsActivityHandler, TurnContext } from "botbuilder";
import { ExecutionAction, ExecutionResult, PendingExecution, SreAgentClient, SreAgentHttpError } from "./sreAgentClient.js";
import { SreAgentStream, AgentTurnMessage, AgentTurnResult } from "./sreAgentStream.js";
import { ThreadStore } from "./threadStore.js";
import { decodeTokenClaims, trace } from "./trace.js";

const WORKING_TEXT = "💭 Working on it…";
const TERMINAL_STATUSES = new Set(["Completed", "Failed", "Cancelled"]);
const EXECUTION_POLL_INTERVAL_MS = 2000;
const EXECUTION_POLL_TIMEOUT_MS = 90_000;
const OUTPUT_LIMIT = 1500;
/**
 * Max time to wait for the agent's post-approval narrative continuation to stream
 * in after the command completes. Best-effort: if it does not arrive, the outcome
 * card is still delivered on its own.
 */
const NARRATIVE_CAPTURE_TIMEOUT_MS = 45_000;

/** Minimal surface of botframework's UserTokenClient that the bridge uses. */
interface UserTokenClientLike {
  getUserToken(userId: string, connectionName: string, channelId: string, magicCode: string): Promise<{ token?: string } | undefined>;
  getSignInResource(connectionName: string, activity: Activity, finalRedirect: string): Promise<{
    signInLink?: string;
    tokenExchangeResource?: Parameters<typeof CardFactory.oauthCard>[4];
    tokenPostResource?: Parameters<typeof CardFactory.oauthCard>[5];
  }>;
  exchangeToken(userId: string, connectionName: string, channelId: string, exchangeRequest: { token?: string; uri?: string }): Promise<{ token?: string } | undefined>;
}

export class TeamsSreBot extends TeamsActivityHandler {
  /** Conversations that asked to approve a write but still need to sign in first. */
  private readonly awaitingSignin = new Set<string>();

  /**
   * Per-conversation turn serializer. The SRE backend processes one turn per thread and
   * the shared SignalR stream routes events by threadId only, so two overlapping turns on
   * the same conversation race: the second post hits HTTP 422 "agent busy" and the two
   * turns interleave each other's completion events. Chaining per conversation guarantees
   * a turn finishes (answer delivered) before the next message for that thread starts.
   */
  private readonly turnLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly threadStore: ThreadStore,
    private readonly sreAgentClient: SreAgentClient,
    private readonly sreAgentStream: SreAgentStream,
    private readonly oauthConnectionName: string
  ) {
    super();

    this.onMessage(async (context, next) => {
      const text = TurnContext.removeRecipientMention(context.activity)?.trim() || context.activity.text?.trim();
      if (!text) {
        await context.sendActivity("Send a text question for the SRE Agent.");
        await next();
        return;
      }

      if (!context.activity.from?.id || !context.activity.conversation?.id) {
        throw new Error("Teams activity is missing user or conversation identity.");
      }

      const userId = context.activity.from.id;
      const conversationId = context.activity.conversation.id;

      await this.runExclusive(conversationId, () => this.handleUserTurn(context, userId, conversationId, text));

      await next();
    });

    this.onMembersAdded(async (context, next) => {
      const addedMembers = context.activity.membersAdded ?? [];
      const botId = context.activity.recipient?.id;
      const userJoined = addedMembers.some(member => member.id !== botId);

      if (userJoined) {
        await context.sendActivity("Hi. I can connect you to the Azure SRE Agent. Ask an SRE question to start. Type /new or /reset to begin a fresh conversation.");
      }

      await next();
    });
  }

  /**
   * Serializes async work per key (here, per Teams conversation) by chaining onto the
   * previous task for that key. Failures are isolated: a rejected predecessor does not
   * reject the successor (the stored guard never rejects), and the map entry is cleaned
   * up once the tail settles so idle conversations do not leak promises.
   */
  private runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.turnLocks.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const guard = run.then(() => undefined, () => undefined);
    this.turnLocks.set(key, guard);
    guard.then(() => {
      if (this.turnLocks.get(key) === guard) {
        this.turnLocks.delete(key);
      }
    });
    return run;
  }
  private async handleUserTurn(context: TurnContext, userId: string, conversationId: string, text: string): Promise<void> {
    const command = text.toLowerCase();
    if (command === "/new" || command === "/reset") {
      await this.threadStore.deleteThread(userId, conversationId);
      console.log(JSON.stringify({ event: "sre_thread_reset", conversationId }));
      await context.sendActivity("Started a fresh SRE Agent conversation. Send your next question to begin a new thread.");
      return;
    }

    console.log(JSON.stringify({
      event: "teams_message_received",
      channelId: context.activity.channelId,
      conversationId,
      fromId: userId,
      textLength: text.length
    }));

    await context.sendActivity({ type: "typing" });

    const existingThreadId = await this.threadStore.getThread(userId, conversationId);

    // Approval intent ("approve"/"no") only applies when the agent has a write
    // command waiting. Acting on it calls the execution action API directly;
    // relaying it as a chat message would just cancel and re-propose the command.
    const approvalAction = detectApprovalIntent(text);
    if (existingThreadId && approvalAction) {
      const pending = await this.sreAgentClient.listPendingExecutions(existingThreadId);
      if (pending.length > 0) {
        await this.processApproval(context, existingThreadId, pending, approvalAction);
        return;
      }
    }

    let threadId = existingThreadId;
    let triggeredByCreate = false;
    if (!threadId) {
      threadId = await this.sreAgentClient.createThread(text);
      await this.threadStore.saveThread(userId, conversationId, threadId);
      triggeredByCreate = true;
      console.log(JSON.stringify({ event: "sre_thread_created", conversationId, threadId }));
    } else {
      console.log(JSON.stringify({ event: "sre_thread_resolved", conversationId, threadId }));
    }

    const live = await context.sendActivity(MessageFactory.text(WORKING_TEXT));
    const editor = new LiveMessageEditor(context, live?.id);
    const onUpdate = (result: AgentTurnResult): void => {
      editor.set(CardFactory.adaptiveCard(turnCardContent({ working: true, progress: result.messages })));
    };

    let result: AgentTurnResult;
    try {
      result = await this.sreAgentStream.runTurn(threadId, {
        onUpdate,
        trigger: triggeredByCreate ? undefined : () => this.sreAgentClient.postMessage(threadId!, text)
      });
    } catch (error) {
      if (!(error instanceof SreAgentHttpError) || error.status !== 404) {
        throw error;
      }

      console.log(JSON.stringify({ event: "sre_thread_stale", conversationId, staleThreadId: threadId, status: error.status }));
      const newThreadId = await this.sreAgentClient.createThread(text);
      await this.threadStore.saveThread(userId, conversationId, newThreadId);
      console.log(JSON.stringify({ event: "sre_thread_replaced", conversationId, oldThreadId: threadId, newThreadId }));
      threadId = newThreadId;
      result = await this.sreAgentStream.runTurn(newThreadId, { onUpdate });
    }

    await this.deliver(context, editor, result);

    console.log(JSON.stringify({
      event: "sre_reply_received",
      conversationId,
      threadId,
      completed: result.completed,
      progressCount: result.progress.length,
      answerLength: result.finalAnswer.length
    }));
  }

  /**
   * Routes an approval decision. Rejections (`cancel`) use the bridge managed
   * identity (no Azure action runs, only SRE admin is needed). Approvals (`run`)
   * must execute under the approving user's identity via OBO, so they require the
   * user's delegated SRE token; if the user has not signed in yet, an OAuth card
   * is sent and the approval resumes once sign-in completes.
   */
  private async processApproval(
    context: TurnContext,
    threadId: string,
    pending: readonly PendingExecution[],
    action: ExecutionAction
  ): Promise<void> {
    if (action === "cancel") {
      await this.runApproval(context, threadId, pending, "cancel", undefined);
      return;
    }

    const conversationId = context.activity.conversation?.id;
    const userToken = await this.getUserToken(context);
    console.log(JSON.stringify({
      event: "sre_approval_start",
      conversationId,
      threadId,
      pendingCount: pending.length,
      hasUserToken: Boolean(userToken)
    }));
    if (!userToken) {
      if (conversationId) {
        this.awaitingSignin.add(conversationId);
      }
      await this.sendSigninCard(context);
      return;
    }
    if (conversationId) {
      this.awaitingSignin.delete(conversationId);
    }
    await this.runApproval(context, threadId, pending, "run", userToken);
  }

  private async runApproval(
    context: TurnContext,
    threadId: string,
    pending: readonly PendingExecution[],
    action: ExecutionAction,
    userToken: string | undefined
  ): Promise<void> {
    await context.sendActivity({ type: "typing" });

    const userId = context.activity.from?.aadObjectId || context.activity.from?.id || "sreagent-client";

    if (action === "cancel") {
      const cards: Attachment[] = [];
      for (const exec of pending) {
        try {
          const terminal = await this.sreAgentClient.postExecutionAction(threadId, exec.execId, "cancel");
          cards.push(buildExecutionCard(exec.command, terminal));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(JSON.stringify({ event: "sre_execution_action_error", threadId, execId: exec.execId, action, message }));
          cards.push(buildExecutionCard(exec.command, { id: exec.execId, command: exec.command, status: "Failed", error: `Could not cancel this command: ${message}` }));
        }
      }
      console.log(JSON.stringify({ event: "sre_execution_action", threadId, action, count: pending.length }));
      await context.sendActivity({ attachments: cards });
      return;
    }

    if (!userToken) {
      throw new Error("Sign-in is required to authorize this command.");
    }

    const cards: Attachment[] = [];
    for (const exec of pending) {
      try {
        const terminal = await this.authorizeAndRun(threadId, exec, userToken, userId);
        cards.push(buildExecutionCard(exec.command, terminal));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({ event: "sre_execution_action_error", threadId, execId: exec.execId, action, message }));
        cards.push(buildExecutionCard(exec.command, {
          id: exec.execId,
          command: exec.command,
          status: "Failed",
          error: `Could not run this command: ${message}`
        }));
      }
    }

    console.log(JSON.stringify({ event: "sre_execution_action", threadId, action, count: pending.length }));
    await context.sendActivity({ attachments: cards });

    // The SRE Agent resumes its turn once the write completes and streams a narrative
    // answer (e.g. "The VM start command was approved... booting up now"). That turn is
    // pushed over the SignalR hub; attach a listener now to deliver it to Teams so the
    // conversation matches the portal, which shows that paragraph after the card.
    const narrative = await this.captureNarrative(threadId);
    if (narrative.length > 0) {
      await context.sendActivity(MessageFactory.text(narrative));
    }
  }

  /**
   * Captures the agent's post-approval narrative continuation from the SignalR stream.
   * No trigger is posted: the approval already drove the backend, so we only listen for
   * the resumed turn the backend streams. Best-effort, any failure or timeout yields an
   * empty string so the outcome card is still delivered on its own.
   */
  private async captureNarrative(threadId: string): Promise<string> {
    try {
      const result = await this.sreAgentStream.runTurn(threadId, { timeoutMs: NARRATIVE_CAPTURE_TIMEOUT_MS });
      return result.finalAnswer.trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trace("sre_narrative_capture_error", { threadId, message });
      return "";
    }
  }

  /**
   * Drives an approved write to completion under the user's identity, replicating the SRE
   * portal's `B("run")` handler exactly. The OBO flow is two-phase: the first `run` clears the
   * Review gate (status `Pending`, no scope header); the backend then escalates the command to
   * `PendingAuthorization` and exposes `requiredScopes`. The portal's "Grant permissions" button
   * issues a second `run` carrying `x-sreagent-obo-scope: <requiredScopes>` (proven from the
   * portal bundle: `H = status===PendingAuthorization ? requiredScopes : void 0`), and that
   * header-bearing call is what triggers the server-side OBO and actually runs the command.
   *
   * Each distinct actionable state (`Pending`, then `PendingAuthorization` with its scopes) is
   * actioned exactly once, then we poll. If the command escalates back to the same
   * `PendingAuthorization` state after we already authorized it, we do not re-issue (the
   * authorization genuinely failed); we poll until it terminates or times out so the outcome is
   * reported instead of looping forever.
   */
  private async authorizeAndRun(
    threadId: string,
    exec: PendingExecution,
    userToken: string,
    userId: string
  ): Promise<ExecutionResult> {
    const issuedStates = new Set<string>();
    let current: ExecutionResult = {
      id: exec.execId,
      command: exec.command,
      status: exec.status,
      ...(exec.requiredScopes ? { requiredScopes: exec.requiredScopes } : {})
    };
    const deadline = Date.now() + EXECUTION_POLL_TIMEOUT_MS;
    trace("sre_authorize_run_start", { threadId, execId: exec.execId, status: current.status });

    while (true) {
      if (TERMINAL_STATUSES.has(current.status)) {
        trace("sre_authorize_run_done", { threadId, execId: exec.execId, finalStatus: current.status, terminal: true });
        return current;
      }

      const needsAuth = current.status === "PendingAuthorization";
      const isGate = current.status === "Pending";
      if (needsAuth || isGate) {
        const oboScope = needsAuth ? current.requiredScopes : undefined;
        const stateKey = `${current.status}:${oboScope ?? ""}`;
        if (!issuedStates.has(stateKey)) {
          issuedStates.add(stateKey);
          trace("sre_authorize_run_issue", { threadId, execId: exec.execId, status: current.status, hasOboScope: Boolean(oboScope) });
          const result = await this.sreAgentClient.postExecutionActionObo(
            threadId, exec.execId, "run", userToken, userId, oboScope
          );
          current = {
            ...current,
            status: result.status,
            output: result.output ?? current.output,
            error: result.error ?? current.error,
            requiredScopes: result.requiredScopes ?? current.requiredScopes,
            description: result.description ?? current.description,
            executedBy: result.executedBy ?? current.executedBy,
            startedTimestamp: result.startedTimestamp ?? current.startedTimestamp,
            completedTimestamp: result.completedTimestamp ?? current.completedTimestamp
          };
          continue;
        }
      }

      if (Date.now() >= deadline) {
        trace("sre_authorize_run_done", { threadId, execId: exec.execId, finalStatus: current.status, terminal: false, timedOut: true });
        return current;
      }
      await sleep(EXECUTION_POLL_INTERVAL_MS);
      current = await this.sreAgentClient.getExecutionStatus(threadId, exec.execId);
      trace("sre_authorize_run_poll", { threadId, execId: exec.execId, status: current.status, hasRequiredScopes: Boolean(current.requiredScopes) });
    }
  }

  /** Resolves the approving user's delegated SRE token from the OAuth connection, if signed in. */
  private async getUserToken(context: TurnContext, magicCode = ""): Promise<string | undefined> {
    const userId = context.activity.from?.id;
    if (!userId) {
      return undefined;
    }
    const client = this.userTokenClient(context);
    const response = await client.getUserToken(userId, this.oauthConnectionName, context.activity.channelId, magicCode);
    const token = response?.token || undefined;
    trace("sre_user_token_resolved", {
      connection: this.oauthConnectionName,
      channelId: context.activity.channelId,
      hasMagicCode: Boolean(magicCode),
      hasToken: Boolean(token),
      claims: decodeTokenClaims(token)
    });
    return token;
  }

  private async sendSigninCard(context: TurnContext): Promise<void> {
    const client = this.userTokenClient(context);
    let resource: {
      signInLink?: string;
      tokenExchangeResource?: Parameters<typeof CardFactory.oauthCard>[4];
      tokenPostResource?: Parameters<typeof CardFactory.oauthCard>[5];
    };
    try {
      resource = await client.getSignInResource(this.oauthConnectionName, context.activity as Activity, "");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: "sre_signin_resource_error", connection: this.oauthConnectionName, message }));
      await context.sendActivity(
        "I could not start the sign-in needed to authorize this command. The OAuth connection may be misconfigured. " +
        "Please retry, or check the bridge logs."
      );
      return;
    }

    console.log(JSON.stringify({
      event: "sre_signin_card_sent",
      connection: this.oauthConnectionName,
      hasSignInLink: Boolean(resource.signInLink),
      hasTokenExchangeResource: Boolean(resource.tokenExchangeResource),
      interactive: true
    }));

    // Interactive sign-in only: deliberately omit tokenExchangeResource so Teams renders the
    // "Sign in" button (auth-code flow) rather than attempting a silent SSO token exchange.
    // The silent SSO token is OBO-derived, and Entra forbids using an OBO token as the
    // assertion for another OBO exchange. The SRE backend re-exchanges this token for
    // management.azure.com to actually run the command, which fails for an OBO-derived token
    // and leaves the command stuck at PendingAuthorization. A directly-signed-in (auth-code)
    // token is not OBO-derived, so the backend can elevate it and the command executes.
    const card = CardFactory.oauthCard(
      this.oauthConnectionName,
      "Sign in to authorize",
      "Sign in once to run approved commands under your own Azure permissions.",
      resource.signInLink
    );
    await context.sendActivity({ attachments: [card] });
  }

  /** Re-runs a pending approval after the user completes the Teams sign-in. */
  private async resumeAfterSignin(context: TurnContext, magicCode = ""): Promise<void> {
    const conversationId = context.activity.conversation?.id;
    const userId = context.activity.from?.id;
    if (!conversationId || !userId) {
      return;
    }
    const threadId = await this.threadStore.getThread(userId, conversationId);
    const token = await this.getUserToken(context, magicCode);
    console.log(JSON.stringify({
      event: "sre_signin_resume",
      conversationId,
      hasThread: Boolean(threadId),
      hasToken: Boolean(token),
      wasAwaiting: this.awaitingSignin.has(conversationId)
    }));
    if (!threadId || !token) {
      return;
    }
    this.awaitingSignin.delete(conversationId);
    // Serialize the approval per conversation and re-check pending state inside the lock, so
    // if a sign-in completion is delivered more than once, the second resume sees the
    // execution is no longer Pending and does not issue a second `run` (avoids a 409 race).
    await this.runExclusive(`signin:${conversationId}`, async () => {
      const pending = await this.sreAgentClient.listPendingExecutions(threadId);
      if (pending.length > 0) {
        await this.runApproval(context, threadId, pending, "run", token);
      } else {
        await context.sendActivity({ attachments: [noticeCard("✅ Signed in. There is no command waiting for approval right now.")] });
      }
    });
  }

  private userTokenClient(context: TurnContext): UserTokenClientLike {
    const adapter = context.adapter as unknown as { UserTokenClientKey: symbol };
    const client = context.turnState.get(adapter.UserTokenClientKey);
    if (!client) {
      throw new Error("UserTokenClient is unavailable; the OAuth connection is not configured for this channel.");
    }
    return client as UserTokenClientLike;
  }

  protected async handleTeamsSigninVerifyState(context: TurnContext): Promise<void> {
    const magicCode = (context.activity.value as { state?: string } | undefined)?.state ?? "";
    console.log(JSON.stringify({
      event: "sre_signin_verify_state",
      conversationId: context.activity.conversation?.id,
      hasState: Boolean(magicCode)
    }));
    await this.resumeAfterSignin(context, magicCode);
  }

  protected async handleTeamsSigninTokenExchange(context: TurnContext): Promise<void> {
    const conversationId = context.activity.conversation?.id;
    const value = context.activity.value as { id?: string } | undefined;
    // Decline silent SSO token exchange on purpose. The exchanged token is OBO-derived, and
    // Entra forbids chaining OBO (an OBO token cannot be the assertion for another OBO). The
    // SRE backend re-exchanges this token for management.azure.com to run the command, which
    // fails for an OBO-derived token and leaves the command stuck at PendingAuthorization.
    // Returning 412 makes Teams fall back to the interactive sign-in (auth-code) flow, which
    // yields a directly-delegated token the backend can elevate so the command executes.
    console.log(JSON.stringify({ event: "sre_token_exchange_declined", conversationId, id: value?.id }));
    throw new InvokeException(StatusCodes.PRECONDITION_FAILED, {
      id: value?.id,
      connectionName: this.oauthConnectionName,
      failureDetail: "Silent SSO is disabled; interactive sign-in is required so the SRE backend can elevate the token via OBO."
    });
  }

  private async deliver(context: TurnContext, editor: LiveMessageEditor, result: AgentTurnResult): Promise<void> {
    const hasAnswer = result.finalAnswer.trim().length > 0;
    const hasPending = result.pendingCommands.length > 0;

    let answer: string;
    if (hasAnswer) {
      answer = result.finalAnswer;
    } else if (hasPending) {
      answer = "";
    } else if (result.completed) {
      answer = "The SRE Agent finished but returned no answer text.";
    } else {
      answer = "The SRE Agent is taking longer than expected. Please try again.";
    }

    const card = CardFactory.adaptiveCard(turnCardContent({
      working: false,
      progress: result.progress,
      answer,
      pendingCommands: result.pendingCommands
    }));
    await editor.final(card);
  }
}

const APPROVE_WORDS = new Set([
  "approve", "approved", "yes", "y", "run", "go", "go ahead", "do it", "ok", "okay",
  "confirm", "confirmed", "proceed", "accept", "yep", "yup"
]);
const REJECT_WORDS = new Set([
  "no", "cancel", "reject", "rejected", "deny", "denied", "stop", "abort", "nope", "decline"
]);

/**
 * Classifies a short reply as approval (`run`) or rejection (`cancel`) of a
 * pending write command. Only exact short phrases match so normal questions that
 * happen to contain "yes"/"no" are never hijacked; the pending-command gate is
 * the second safeguard.
 */
function detectApprovalIntent(text: string): ExecutionAction | undefined {
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (APPROVE_WORDS.has(normalized)) {
    return "run";
  }
  if (REJECT_WORDS.has(normalized)) {
    return "cancel";
  }
  return undefined;
}

interface StatusVisual {
  readonly style: "good" | "attention" | "warning" | "accent" | "default";
  readonly label: string;
  readonly icon: string;
}

function statusVisual(status: string): StatusVisual {
  switch (status) {
    case "Completed":
      return { style: "good", label: "Completed", icon: "✅" };
    case "Failed":
      return { style: "attention", label: "Failed", icon: "⚠️" };
    case "Cancelled":
      return { style: "warning", label: "Cancelled", icon: "❌" };
    case "Running":
      return { style: "accent", label: "Running", icon: "…" };
    default:
      return { style: "default", label: status, icon: "" };
  }
}

/** Formats an ISO timestamp as a readable UTC string, tolerating bad/empty input. */
function formatTimestamp(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toUTCString();
}

/**
 * Builds the Adaptive Card body that mirrors the SRE portal's execution card:
 * a bold title (the action description), the command in a monospace block, a
 * colour-coded status row with the OBO attribution line, an optional Timestamps
 * fact set, and any output/error. Returned as a plain object so it is unit
 * testable without the botbuilder CardFactory wrapper. Adaptive Cards 1.4 is the
 * highest schema version Teams renders reliably (1.5 Badge support is flaky), so
 * the status "pill" is approximated with a coloured Container instead.
 */
export function executionCardContent(command: string, exec: ExecutionResult): Record<string, unknown> {
  const visual = statusVisual(exec.status);
  const title = (exec.description ?? "").trim() || "Command execution";
  const body: Array<Record<string, unknown>> = [
    { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", wrap: true },
    {
      type: "Container",
      style: "emphasis",
      items: [{ type: "TextBlock", text: command, fontType: "Monospace", wrap: true, spacing: "None" }]
    }
  ];

  const statusItems: Array<Record<string, unknown>> = [
    { type: "TextBlock", text: `${visual.icon} ${visual.label}`.trim(), weight: "Bolder", wrap: true }
  ];
  const executedBy = (exec.executedBy?.displayName ?? "").trim();
  if (exec.status === "Completed" && executedBy.length > 0) {
    statusItems.push({
      type: "TextBlock",
      text: `The action was completed using temporary permissions granted by ${executedBy}.`,
      wrap: true,
      spacing: "Small"
    });
  }
  body.push({ type: "Container", style: visual.style, items: statusItems });

  const started = formatTimestamp(exec.startedTimestamp);
  const completed = formatTimestamp(exec.completedTimestamp);
  const facts: Array<Record<string, string>> = [];
  if (started) {
    facts.push({ title: "Started", value: started });
  }
  if (completed) {
    facts.push({ title: "Completed", value: completed });
  }
  if (facts.length > 0) {
    body.push({ type: "TextBlock", text: "Timestamps", weight: "Bolder", size: "Small", spacing: "Medium" });
    body.push({ type: "FactSet", facts });
  }

  const output = (exec.output ?? "").trim();
  const error = (exec.error ?? "").trim();
  const detail = exec.status === "Failed" ? error : output;
  if (detail.length > 0) {
    const trimmed = detail.length > OUTPUT_LIMIT ? `${detail.slice(0, OUTPUT_LIMIT)}\n… (truncated)` : detail;
    body.push({ type: "TextBlock", text: exec.status === "Failed" ? "Error" : "Output", weight: "Bolder", size: "Small", spacing: "Medium" });
    body.push({
      type: "Container",
      style: "emphasis",
      items: [{ type: "TextBlock", text: trimmed, fontType: "Monospace", wrap: true, spacing: "None" }]
    });
  }

  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body
  };
}

/** Wraps {@link executionCardContent} as a botbuilder adaptive-card attachment. */
function buildExecutionCard(command: string, exec: ExecutionResult): ReturnType<typeof CardFactory.adaptiveCard> {
  return CardFactory.adaptiveCard(executionCardContent(command, exec));
}

const ADAPTIVE_CARD_BASE = {
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  type: "AdaptiveCard",
  version: "1.4"
} as const;

/** Turns the streamed turn messages into Adaptive Card body blocks (reasoning, tools, commands). */
function progressBlocks(messages: readonly AgentTurnMessage[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const text = message.text.trim();
    if (text.length === 0) {
      continue;
    }
    if (message.kind === "reasoning") {
      blocks.push({ type: "TextBlock", text: `💭 ${text}`, wrap: true, isSubtle: true, spacing: "Small" });
    } else if (message.kind === "tool") {
      blocks.push({ type: "TextBlock", text: `🔧 ${text.split("\n")[0]}`, wrap: true, spacing: "Small" });
    } else if (message.kind === "command") {
      blocks.push({
        type: "Container",
        style: "emphasis",
        spacing: "Small",
        items: [
          { type: "TextBlock", text: message.text, fontType: "Monospace", wrap: true, spacing: "None" },
          ...(commandStatusLabel(message.status) ? [{ type: "TextBlock", text: commandStatusLabel(message.status), wrap: true, spacing: "None", isSubtle: true }] : [])
        ]
      });
    } else {
      blocks.push({ type: "TextBlock", text, wrap: true });
    }
  }
  return blocks;
}

function commandStatusLabel(status?: string): string {
  switch (status) {
    case "Pending": return "⏳ awaiting your approval";
    case "Running": return "… running";
    case "Cancelled": return "❌ cancelled";
    case "Failed": return "⚠️ failed";
    default: return "";
  }
}

/** Card shown while the agent turn streams, and as the final answer + approval card. */
export function turnCardContent(opts: {
  readonly working: boolean;
  readonly progress: readonly AgentTurnMessage[];
  readonly answer?: string;
  readonly pendingCommands?: readonly string[];
}): Record<string, unknown> {
  const body: Array<Record<string, unknown>> = [];
  if (opts.working) {
    body.push({ type: "TextBlock", text: "💭 Working on it…", weight: "Bolder", size: "Medium", wrap: true });
  }
  body.push(...progressBlocks(opts.progress));
  const answer = (opts.answer ?? "").trim();
  if (answer.length > 0) {
    body.push({ type: "TextBlock", text: answer, wrap: true, spacing: "Medium" });
  }
  const pending = opts.pendingCommands ?? [];
  if (pending.length > 0) {
    body.push(...approvalBlocks(pending));
  }
  if (body.length === 0) {
    body.push({ type: "TextBlock", text: "The SRE Agent finished but returned no answer text.", wrap: true });
  }
  return { ...ADAPTIVE_CARD_BASE, body };
}

/** Approval-prompt blocks: a clean title, each command once in monospace, and the reply hint. */
function approvalBlocks(commands: readonly string[]): Array<Record<string, unknown>> {
  const noun = commands.length === 1 ? "this action" : "these actions";
  const blocks: Array<Record<string, unknown>> = [
    { type: "TextBlock", text: "⚠️ Approval needed", weight: "Bolder", size: "Medium", wrap: true, spacing: "Medium" },
    { type: "TextBlock", text: `The SRE Agent is in review mode and wants to run ${noun}:`, wrap: true, spacing: "None" }
  ];
  for (const command of commands) {
    blocks.push({
      type: "Container",
      style: "emphasis",
      items: [{ type: "TextBlock", text: command, fontType: "Monospace", wrap: true, spacing: "None" }]
    });
  }
  blocks.push({ type: "TextBlock", text: "Reply **approve** (or **yes**) to run it, or **no** to cancel.", wrap: true });
  return blocks;
}

/** Single-message agent card (sign-in confirmations, errors, cancel outcome). */
function noticeCard(text: string): ReturnType<typeof CardFactory.adaptiveCard> {
  return CardFactory.adaptiveCard({ ...ADAPTIVE_CARD_BASE, body: [{ type: "TextBlock", text, wrap: true }] });
}

/**
 * Edits a single Teams message in place as the agent turn streams, coalescing and
 * throttling updates so Teams is not flooded. `final` flushes the last content.
 */
class LiveMessageEditor {
  private latest: string | Attachment = "";
  private editing = false;
  private closed = false;
  private lastEditAt = 0;
  private flushTimer?: NodeJS.Timeout;
  private readonly minIntervalMs = 1200;

  constructor(private readonly context: TurnContext, private readonly activityId?: string) {}

  set(content: string | Attachment): void {
    if (this.closed || !this.activityId || sameContent(content, this.latest)) {
      this.latest = content;
      return;
    }
    this.latest = content;
    this.scheduleFlush();
  }

  async final(content: string | Attachment): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.latest = content;
    while (this.editing) {
      await sleep(50);
    }
    // Mark closed before the final edit so no throttled flush fires after the turn
    // ends (the TurnContext proxy is revoked once the handler returns).
    this.closed = true;
    await this.edit(content);
  }

  private scheduleFlush(): void {
    if (this.closed || this.editing || this.flushTimer) {
      return;
    }
    const wait = Math.max(0, this.minIntervalMs - (Date.now() - this.lastEditAt));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, wait);
  }

  private async flush(): Promise<void> {
    if (this.closed || this.editing) {
      return;
    }
    const content = this.latest;
    await this.edit(content);
    if (!this.closed && !sameContent(this.latest, content)) {
      this.scheduleFlush();
    }
  }

  private async edit(content: string | Attachment): Promise<void> {
    if (!this.activityId) {
      return;
    }
    this.editing = true;
    this.lastEditAt = Date.now();
    try {
      const update = typeof content === "string" ? MessageFactory.text(content) : MessageFactory.attachment(content);
      update.id = this.activityId;
      await this.context.updateActivity(update);
    } catch (error) {
      console.error(JSON.stringify({ event: "sre_live_edit_error", message: (error as Error).message }));
    } finally {
      this.editing = false;
    }
  }
}

/** Equality check for live-edit content, comparing cards by serialized form. */
function sameContent(a: string | Attachment, b: string | Attachment): boolean {
  if (typeof a === "string" && typeof b === "string") {
    return a === b;
  }
  if (typeof a === "string" || typeof b === "string") {
    return false;
  }
  return JSON.stringify(a.content) === JSON.stringify(b.content);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
