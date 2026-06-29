import assert from "node:assert/strict";
import test from "node:test";
import { TeamsSreBot } from "../src/teamsSreBot.js";

function makeBot(): TeamsSreBot {
  // runExclusive does not touch any dependency, so empty stubs are sufficient.
  return new TeamsSreBot({} as any, {} as any, {} as any, "sre-obo");
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

test("runExclusive serializes tasks for the same key in submission order", async () => {
  const bot = makeBot();
  const order: string[] = [];

  // First task is slow; second is fast. Without serialization the fast one would finish
  // first. With it, the second must wait for the first, matching the SRE one-turn-per-thread
  // requirement that prevents the 422 "agent busy" / interleaved-completion slop.
  const first = (bot as any).runExclusive("conv-1", async () => {
    await delay(30);
    order.push("first");
  });
  const second = (bot as any).runExclusive("conv-1", async () => {
    await delay(1);
    order.push("second");
  });

  await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "second"]);
});

test("runExclusive runs different keys concurrently", async () => {
  const bot = makeBot();
  const order: string[] = [];

  const slow = (bot as any).runExclusive("conv-a", async () => {
    await delay(30);
    order.push("a");
  });
  const fast = (bot as any).runExclusive("conv-b", async () => {
    await delay(1);
    order.push("b");
  });

  await Promise.all([slow, fast]);
  // Different conversations are independent, so the fast one finishes first.
  assert.deepEqual(order, ["b", "a"]);
});

test("runExclusive isolates failures so the next task still runs", async () => {
  const bot = makeBot();
  const order: string[] = [];

  const failing = (bot as any).runExclusive("conv-1", async () => {
    order.push("failing");
    throw new Error("boom");
  });
  const next = (bot as any).runExclusive("conv-1", async () => {
    order.push("next");
  });

  await assert.rejects(() => failing, /boom/);
  await next;
  assert.deepEqual(order, ["failing", "next"]);
});

test("runExclusive returns the task result and propagates rejection to the caller", async () => {
  const bot = makeBot();

  const value = await (bot as any).runExclusive("k", async () => 42);
  assert.equal(value, 42);

  await assert.rejects(
    () => (bot as any).runExclusive("k", async () => { throw new Error("nope"); }),
    /nope/
  );
});

// --- Interactive sign-in OBO: decline silent SSO, run approval on verifyState ---
// The bridge no longer attempts silent SSO token exchange. A silently-exchanged token is
// OBO-derived, and Entra forbids using an OBO token as the assertion for another OBO; the
// SRE backend re-exchanges the token for management.azure.com to run the command, so an
// OBO-derived token leaves the command stuck at PendingAuthorization. handleTeamsSigninToken-
// Exchange therefore declines (HTTP 412) so Teams falls back to interactive sign-in, and the
// approval is resumed on the signin/verifyState invoke using the directly-delegated token.

// Test A: silent SSO token exchange is declined and never runs an approval.
test("handleTeamsSigninTokenExchange declines silent SSO with 412 and never runs the approval", async () => {
  let oboCalled = false;
  const sreAgentClient = {
    listPendingExecutions: async () => [{ execId: "exec-1", command: "az vm deallocate", status: "PendingAuthorization" }],
    postExecutionActionObo: async () => { oboCalled = true; return { id: "exec-1", command: "az vm deallocate", status: "Completed" }; }
  } as any;
  const bot = new TeamsSreBot({ getThread: async () => "t" } as any, sreAgentClient, {} as any, "sre-obo");
  const context = {
    activity: { channelId: "msteams", conversation: { id: "c" }, from: { id: "u" }, value: { id: "inv-1", token: "sso" } },
    sendActivity: async () => ({ id: "a" })
  } as any;

  await assert.rejects(
    () => (bot as any).handleTeamsSigninTokenExchange(context),
    (error: any) => error?.constructor?.name === "InvokeException"
  );
  // Declining must not run the gated write; that only happens via interactive sign-in.
  assert.equal(oboCalled, false);
});

// Test B: after interactive sign-in, the verifyState invoke runs the approval as the user.
test("handleTeamsSigninVerifyState runs the approval as the user after interactive sign-in", async () => {
  const USER_TOKEN = "interactive-user-token";
  let getTokenArgs: { userId: string; connectionName: string; channelId: string; magicCode: string } | undefined;
  const userTokenClient = {
    getUserToken: async (userId: string, connectionName: string, channelId: string, magicCode: string) => {
      getTokenArgs = { userId, connectionName, channelId, magicCode };
      return { token: USER_TOKEN };
    }
  };
  const threadStore = { getThread: async () => "1d8b0f6a-2c3d-4e5f-8a9b-0c1d2e3f4a5b" } as any;

  let oboCall: { threadId: string; execId: string; action: string; userToken: string; userId: string } | undefined;
  const sreAgentClient = {
    listPendingExecutions: async () => [
      { execId: "exec-1", command: "az vm deallocate -g rg -n vm", status: "PendingAuthorization", requiredScopes: "https://management.azure.com/user_impersonation" }
    ],
    postExecutionActionObo: async (threadId: string, execId: string, action: string, userToken: string, userId: string) => {
      oboCall = { threadId, execId, action, userToken, userId };
      return { id: execId, command: "az vm deallocate -g rg -n vm", status: "Completed", output: "done" };
    }
  } as any;

  const bot = new TeamsSreBot(threadStore, sreAgentClient, {} as any, "sre-obo");
  const tokenClientKey = Symbol("UserTokenClientKey");
  const context = {
    activity: {
      channelId: "msteams",
      conversation: { id: "conv-1" },
      from: { id: "user-1", aadObjectId: "aad-user-1" },
      value: { state: "123456" }
    },
    adapter: { UserTokenClientKey: tokenClientKey },
    turnState: { get: (key: symbol) => (key === tokenClientKey ? userTokenClient : undefined) },
    sendActivity: async () => ({ id: "activity-1" }),
    updateActivity: async () => undefined
  } as any;

  await (bot as any).handleTeamsSigninVerifyState(context);

  // The magic code from value.state is forwarded so the just-completed sign-in resolves a token.
  assert.ok(getTokenArgs, "getUserToken was not called");
  assert.equal(getTokenArgs?.connectionName, "sre-obo");
  assert.equal(getTokenArgs?.channelId, "msteams");
  assert.equal(getTokenArgs?.magicCode, "123456");

  // The pending write was approved under the user's identity with the interactive token.
  assert.ok(oboCall, "postExecutionActionObo was not called");
  assert.equal(oboCall?.action, "run");
  assert.equal(oboCall?.userToken, USER_TOKEN);
  assert.equal(oboCall?.userId, "aad-user-1");
  assert.equal(oboCall?.execId, "exec-1");
});

// Test C: concurrent verifyState completions for the same conversation run the approval once.
// Teams can deliver the sign-in completion more than once; the per-conversation lock plus the
// inside-lock pending re-check must ensure exactly one `run` so the second does not race a 409.
test("concurrent interactive sign-in completions run the approval exactly once", async () => {
  const USER_TOKEN = "user-token";
  const userTokenClient = { getUserToken: async () => ({ token: USER_TOKEN }) };
  const threadStore = { getThread: async () => "1d8b0f6a-2c3d-4e5f-8a9b-0c1d2e3f4a5b" } as any;

  // The backend drops the execution from the pending list once it is actioned, exactly as the
  // real listPendingExecutions filter (status Pending/PendingAuthorization) behaves.
  let pendingActive = true;
  let runCount = 0;
  const sreAgentClient = {
    listPendingExecutions: async () => pendingActive
      ? [{ execId: "exec-1", command: "az vm deallocate -g rg -n vm", status: "PendingAuthorization", requiredScopes: "s" }]
      : [],
    postExecutionActionObo: async () => {
      runCount += 1;
      pendingActive = false;
      return { id: "exec-1", command: "az vm deallocate -g rg -n vm", status: "Completed", output: "done" };
    },
    getExecutionStatus: async () => ({ id: "exec-1", command: "az vm deallocate -g rg -n vm", status: "Completed", output: "done" })
  } as any;

  const bot = new TeamsSreBot(threadStore, sreAgentClient, {} as any, "sre-obo");
  const key = Symbol("UserTokenClientKey");
  const makeCtx = () => ({
    activity: {
      channelId: "msteams",
      conversation: { id: "conv-1" },
      from: { id: "user-1", aadObjectId: "aad-user-1" },
      value: { state: "123456" }
    },
    adapter: { UserTokenClientKey: key },
    turnState: { get: (k: symbol) => (k === key ? userTokenClient : undefined) },
    sendActivity: async () => ({ id: "a" }),
    updateActivity: async () => undefined
  } as any);

  await Promise.all([
    (bot as any).handleTeamsSigninVerifyState(makeCtx()),
    (bot as any).handleTeamsSigninVerifyState(makeCtx())
  ]);

  assert.equal(runCount, 1);
});

// Test D: when the first run only clears the Review gate and the command escalates to
// PendingAuthorization, the bridge must re-issue `run` carrying the requiredScopes as the
// OBO scope (the portal's "Grant permissions" call). Without this second header-bearing call
// the command stays PendingAuthorization forever, which is the observed production bug.
test("escalation to PendingAuthorization re-issues run with the requiredScopes obo scope", async () => {
  const USER_TOKEN = "interactive-user-token";
  const REQ = "https://management.azure.com/.default,https://management.core.windows.net/.default";
  const userTokenClient = { getUserToken: async () => ({ token: USER_TOKEN }) };
  const threadStore = { getThread: async () => "1d8b0f6a-2c3d-4e5f-8a9b-0c1d2e3f4a5b" } as any;

  const calls: Array<{ action: string; oboScope?: string }> = [];
  const sreAgentClient = {
    // Approve arrives while the command is still in the Review gate: status Pending, no scopes.
    listPendingExecutions: async () => [
      { execId: "cc80b03d-09d3-6867-ab38-3fffb673d989", command: "az vm deallocate -g rg -n vm", status: "Pending" }
    ],
    postExecutionActionObo: async (
      _threadId: string, execId: string, action: string, _userToken: string, _userId: string, oboScope?: string
    ) => {
      calls.push({ action, oboScope });
      if (oboScope === undefined) {
        // First (gate) run: backend clears the gate and escalates, exposing requiredScopes.
        return { id: execId, command: "az vm deallocate -g rg -n vm", status: "PendingAuthorization", requiredScopes: REQ };
      }
      // Second run carrying the obo scope header: the backend now runs it under the user.
      return { id: execId, command: "az vm deallocate -g rg -n vm", status: "Completed", output: "ok" };
    },
    getExecutionStatus: async () => ({
      id: "cc80b03d-09d3-6867-ab38-3fffb673d989", command: "az vm deallocate -g rg -n vm", status: "Completed", output: "ok"
    })
  } as any;

  const bot = new TeamsSreBot(threadStore, sreAgentClient, {} as any, "sre-obo");
  const key = Symbol("UserTokenClientKey");
  const context = {
    activity: {
      channelId: "msteams",
      conversation: { id: "conv-1" },
      from: { id: "user-1", aadObjectId: "aad-user-1" },
      value: { state: "123456" }
    },
    adapter: { UserTokenClientKey: key },
    turnState: { get: (k: symbol) => (k === key ? userTokenClient : undefined) },
    sendActivity: async () => ({ id: "a" }),
    updateActivity: async () => undefined
  } as any;

  await (bot as any).handleTeamsSigninVerifyState(context);

  // Exactly two run calls: the gate clear (no scope), then the authorize with requiredScopes.
  assert.equal(calls.length, 2);
  assert.equal(calls[0].action, "run");
  assert.equal(calls[0].oboScope, undefined);
  assert.equal(calls[1].action, "run");
  assert.equal(calls[1].oboScope, REQ);
});

// Display-parity: the approved-write outcome card must mirror the SRE portal card so Teams
// shows the same information (title, status, OBO attribution, timestamps), not a bare command.
import { executionCardContent } from "../src/teamsSreBot.js";

test("executionCardContent renders a completed write with attribution and timestamps", () => {
  const card = executionCardContent(
    "az vm start -g rg -n vm --no-wait",
    {
      id: "e1",
      command: "az vm start -g rg -n vm --no-wait",
      status: "Completed",
      description: "Starting Azure resource",
      executedBy: { role: "User", userId: "u1", displayName: "System Administrator <admin@contoso.com>" },
      startedTimestamp: "2026-06-27T17:54:27.285048Z",
      completedTimestamp: "2026-06-27T17:54:35.584745Z"
    }
  );

  assert.equal(card.version, "1.4");
  assert.equal(card.type, "AdaptiveCard");
  const json = JSON.stringify(card);
  // Title is the action description, command shown verbatim.
  assert.match(json, /Starting Azure resource/);
  assert.match(json, /az vm start -g rg -n vm --no-wait/);
  // Green status container with the Completed label.
  const body = card.body as Array<Record<string, any>>;
  const statusContainer = body.find(b => b.type === "Container" && b.style === "good");
  assert.ok(statusContainer, "expected a good-styled status container");
  assert.match(JSON.stringify(statusContainer), /Completed/);
  // The OBO attribution sentence with the approving user's display name.
  assert.match(json, /The action was completed using temporary permissions granted by System Administrator <admin@contoso\.com>\./);
  // A Timestamps fact set with both timestamps.
  const factSet = body.find(b => b.type === "FactSet");
  assert.ok(factSet, "expected a Timestamps FactSet");
  const facts = (factSet!.facts as Array<{ title: string }>).map(f => f.title);
  assert.deepEqual(facts, ["Started", "Completed"]);
});

test("executionCardContent marks a failed write red with the error and no attribution", () => {
  const card = executionCardContent(
    "az vm deallocate -g rg -n vm",
    { id: "e2", command: "az vm deallocate -g rg -n vm", status: "Failed", description: "Stopping Azure resource", error: "AuthorizationFailed" }
  );
  const body = card.body as Array<Record<string, any>>;
  const statusContainer = body.find(b => b.type === "Container" && b.style === "attention");
  assert.ok(statusContainer, "expected an attention-styled status container");
  assert.match(JSON.stringify(statusContainer), /Failed/);
  assert.match(JSON.stringify(card), /AuthorizationFailed/);
  // No completion attribution on a failed action.
  assert.doesNotMatch(JSON.stringify(card), /temporary permissions/);
});

test("executionCardContent marks a cancelled write amber", () => {
  const card = executionCardContent(
    "az vm deallocate -g rg -n vm",
    { id: "e3", command: "az vm deallocate -g rg -n vm", status: "Cancelled" }
  );
  const body = card.body as Array<Record<string, any>>;
  const statusContainer = body.find(b => b.type === "Container" && b.style === "warning");
  assert.ok(statusContainer, "expected a warning-styled status container");
  assert.match(JSON.stringify(statusContainer), /Cancelled/);
});

import { turnCardContent } from "../src/teamsSreBot.js";

test("turnCardContent shows a clean single-command approval prompt, no fenced block", () => {
  const card = turnCardContent({
    working: false,
    progress: [{ messageId: "m1", kind: "command", text: "az vm deallocate -g rg -n vm", status: "Pending" }],
    answer: "",
    pendingCommands: ["az vm deallocate -g rg -n vm"]
  });
  assert.equal(card.version, "1.4");
  const json = JSON.stringify(card);
  assert.match(json, /Approval needed/);
  assert.match(json, /Reply \*\*approve\*\*/);
  // The command appears in a monospace block, never the old triple-backtick fence.
  assert.doesNotMatch(json, /```/);
  const monospace = (card.body as Array<Record<string, any>>).some(b => b.type === "Container" && JSON.stringify(b).includes("Monospace"));
  assert.ok(monospace, "expected the command in a monospace container");
});

test("turnCardContent renders a final answer as a wrapped text block", () => {
  const card = turnCardContent({ working: false, progress: [], answer: "All A100 VMs are deallocated.", pendingCommands: [] });
  assert.match(JSON.stringify(card), /All A100 VMs are deallocated\./);
});

