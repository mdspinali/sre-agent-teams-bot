import assert from "node:assert/strict";
import test from "node:test";
import { MessageUpdateArg, TurnAccumulator, SreAgentStream } from "../src/sreAgentStream.js";

const THREAD = "eeee9b23-8aa2-4782-b553-0df9c26be0bc";

function textDelta(messageId: string, text: string, streamMessageType: string | null = null): MessageUpdateArg {
  return {
    role: "assistant",
    contents: [{ $type: "text", text }],
    additionalProperties: { threadId: THREAD, messageId, streamMessageType }
  };
}

function toolCall(messageId: string, userDescription: string): MessageUpdateArg {
  return {
    role: "tool",
    contents: [{ $type: "functionCall", name: "operation", additionalProperties: { userDescription } }],
    additionalProperties: { threadId: THREAD, messageId, actionName: "AppendAgentToolCallMessage" }
  };
}

function complete(): MessageUpdateArg {
  return {
    role: "assistant",
    contents: [],
    additionalProperties: { threadId: THREAD, messageId: "done-id", actionName: "SignalProcessingComplete" },
    finishReason: "stop"
  };
}

// Mirrors the live-captured multi-step turn for "do I have any VMs running, and list
// resource groups with resource counts": reasoning -> narration -> tool -> reasoning ->
// final answer -> SignalProcessingComplete. Text arrives as deltas grouped by messageId.
function multiStepTurn(): MessageUpdateArg[] {
  return [
    { role: "user", contents: [{ $type: "text", text: "do I have any VMs running" }], additionalProperties: { threadId: THREAD, messageId: "user-id", actionName: "AppendUserStreamMessage" } },
    textDelta("r1", "**Listing running virtual machines** ", "Reasoning"),
    textDelta("r1", "Plan: 1. Query VMs across subscriptions ", "Reasoning"),
    textDelta("r1", "2. List resource groups", "Reasoning"),
    textDelta("a1", "I'll query across your subscriptions for "),
    textDelta("a1", "VMs and resource groups with resource counts."),
    { role: "assistant", contents: [], additionalProperties: { threadId: THREAD, messageId: "t1" }, finishReason: "tool_calls" },
    toolCall("t1", "Reading Azure resource information..."),
    textDelta("r2", "**Summarizing query results** ", "Reasoning"),
    textDelta("a2", "## Virtual Machines "),
    textDelta("a2", "You have **1 VM running**: A100Sandbox in demo-rg."),
    complete()
  ];
}

test("multi-step turn returns the final answer, not the reasoning bubble", () => {
  const accumulator = new TurnAccumulator();
  for (const arg of multiStepTurn()) {
    accumulator.apply(arg);
  }

  assert.equal(accumulator.isComplete, true);
  const result = accumulator.result();
  assert.equal(
    result.finalAnswer,
    "## Virtual Machines You have **1 VM running**: A100Sandbox in demo-rg."
  );
  assert.ok(!result.finalAnswer.includes("Listing running virtual machines"));
});

test("progress excludes the final answer and preserves order/classification", () => {
  const accumulator = new TurnAccumulator();
  for (const arg of multiStepTurn()) {
    accumulator.apply(arg);
  }

  const result = accumulator.result();
  assert.deepEqual(
    result.progress.map(message => message.kind),
    ["reasoning", "assistant", "tool", "reasoning"]
  );
  // The final answer is not present in the progress list.
  assert.ok(!result.progress.some(message => message.text.includes("Virtual Machines")));
  // Tool messages surface the friendly userDescription, not a raw command.
  const tool = result.progress.find(message => message.kind === "tool");
  assert.equal(tool?.text, "Reading Azure resource information...");
});

test("reasoning deltas are concatenated and classified as reasoning", () => {
  const accumulator = new TurnAccumulator();
  for (const arg of multiStepTurn()) {
    accumulator.apply(arg);
  }

  const reasoning = accumulator.result().messages.find(message => message.kind === "reasoning");
  assert.equal(
    reasoning?.text,
    "**Listing running virtual machines** Plan: 1. Query VMs across subscriptions 2. List resource groups"
  );
});

test("user echo and empty tool_calls markers do not create messages", () => {
  const accumulator = new TurnAccumulator();
  for (const arg of multiStepTurn()) {
    accumulator.apply(arg);
  }

  const messages = accumulator.result().messages;
  // r1, a1, t1 (tool), r2, a2 = 5 visible messages; user echo + tool_calls marker excluded.
  assert.equal(messages.length, 5);
  assert.ok(!messages.some(message => message.text.includes("do I have any VMs running")));
});

function azCli(messageId: string, command: string, status: string): MessageUpdateArg {
  const json = JSON.stringify({ id: "exec-" + messageId, command, status });
  return {
    role: "assistant",
    contents: [{ $type: "text", text: json }],
    additionalProperties: { threadId: THREAD, messageId, streamMessageType: "AzCli" }
  };
}

function functionResult(messageId: string): MessageUpdateArg {
  return {
    role: "assistant",
    contents: [{ $type: "functionResult" }],
    additionalProperties: { threadId: THREAD, messageId, actionName: "AppendAgentToolCallResult" }
  };
}

const DEALLOCATE = "az vm deallocate -g demo-rg -n A100Sandbox --subscription 00000000 --no-wait";

// Mirrors the live-captured write turn for "can you turn it off?": reasoning -> narration ->
// read tool/command -> narration -> write tool -> pending AzCli command -> complete.
function writeTurn(): MessageUpdateArg[] {
  return [
    textDelta("r1", "**Locating VM for deallocation** Find the VM first.", "Reasoning"),
    textDelta("a1", "Let me first confirm the VM exists."),
    { role: "assistant", contents: [], additionalProperties: { threadId: THREAD, messageId: "t1" }, finishReason: "tool_calls" },
    toolCall("t1", "Reading Azure resource information..."),
    azCli("c1a", "az vm show -g demo-rg -n A100Sandbox", "Completed"),
    azCli("c1b", "az vm show -g demo-rg -n A100Sandbox", "Completed"),
    functionResult("t1"),
    textDelta("a2", "The VM is currently running. I'll deallocate it now."),
    toolCall("t2", "Making changes to Azure resources..."),
    azCli("c2", DEALLOCATE, "Pending"),
    complete()
  ];
}

test("write turn final answer is the agent narration, never the raw command JSON", () => {
  const accumulator = new TurnAccumulator();
  for (const arg of writeTurn()) {
    accumulator.apply(arg);
  }

  const result = accumulator.result();
  assert.equal(result.finalAnswer, "The VM is currently running. I'll deallocate it now.");
  assert.ok(!result.finalAnswer.includes("{"));
  assert.ok(!result.finalAnswer.includes("\"command\""));
});

test("pending write command is surfaced for conversational approval", () => {
  const accumulator = new TurnAccumulator();
  for (const arg of writeTurn()) {
    accumulator.apply(arg);
  }

  const result = accumulator.result();
  assert.deepEqual(result.pendingCommands, [DEALLOCATE]);
});

test("AzCli command messages are classified as command with parsed command text and status", () => {
  const accumulator = new TurnAccumulator();
  for (const arg of writeTurn()) {
    accumulator.apply(arg);
  }

  const commands = accumulator.result().messages.filter(message => message.kind === "command");
  // Duplicate az vm show (c1a/c1b) collapses to one; deallocate is the second.
  assert.deepEqual(commands.map(c => c.text), ["az vm show -g demo-rg -n A100Sandbox", DEALLOCATE]);
  assert.equal(commands[0].status, "Completed");
  assert.equal(commands[1].status, "Pending");
});

// --- Regression guard for the "follow-up message returns empty/slop answer" bug ---
// Live symptom (docker logs, machine 10-30-0-75): after an approval interaction the
// user's next question logged `sre_reply_received ... answerLength:0`, rendered to the
// user as "The SRE Agent finished but returned no answer text."
//
// Root cause: the SRE /agentHub pushes events for every thread on one shared stream and
// they are routed by threadId only. A SignalProcessingComplete that arrives after a turn
// has ended is buffered per thread (TTL 120s). When the user's next message started a new
// turn, drainBuffer replayed that stale complete into the fresh, empty accumulator, which
// resolved the new turn immediately with finalAnswer "" and completed true.
//
// Fix: TurnAccumulator ignores a completion that arrives before the turn produced any
// content, so a replayed stale complete can no longer resolve a brand-new turn empty.
test("a stale SignalProcessingComplete with no preceding content does not complete a turn", () => {
  const accumulator = new TurnAccumulator();
  accumulator.apply(complete());
  assert.equal(accumulator.isComplete, false);
  assert.equal(accumulator.result().finalAnswer, "");
});

test("draining a stale buffered complete no longer resolves a fresh turn empty", () => {
  const stream = new SreAgentStream("https://example.invalid", "scope", {
    getToken: async () => ({ token: "t", expiresOnTimestamp: Date.now() + 3_600_000 })
  } as any);

  // A completion left over from the PREVIOUS turn arrives late and gets buffered.
  (stream as any).bufferEvent(THREAD, complete());

  const accumulator = new TurnAccumulator();
  let resolved: { completed: boolean; finalAnswer: string } | undefined;
  const timer = setTimeout(() => {}, 60_000);
  const session = { accumulator, resolve: (r: any) => { resolved = r; }, timer };
  (stream as any).sessions.set(THREAD, session);
  (stream as any).drainBuffer(THREAD, session);
  clearTimeout(timer);

  // The fresh turn is NOT resolved by the stale completion; it keeps waiting for its
  // own content, so the follow-up question gets a real answer instead of empty slop.
  assert.equal(resolved, undefined);
  assert.equal(session.accumulator.isComplete, false);
});

test("a genuine completion after real content still completes the turn", () => {
  const accumulator = new TurnAccumulator();
  for (const arg of multiStepTurn()) {
    accumulator.apply(arg);
  }
  assert.equal(accumulator.isComplete, true);
  assert.ok(accumulator.result().finalAnswer.length > 0);
});

test("read-only turns report no pending commands", () => {
  const accumulator = new TurnAccumulator();
  for (const arg of multiStepTurn()) {
    accumulator.apply(arg);
  }
  assert.deepEqual(accumulator.result().pendingCommands, []);
});

test("a single-answer turn yields the answer with empty progress", () => {
  const accumulator = new TurnAccumulator();
  accumulator.apply(textDelta("a1", "2 + 2 = "));
  accumulator.apply(textDelta("a1", "4."));
  accumulator.apply(complete());

  const result = accumulator.result();
  assert.equal(result.completed, true);
  assert.equal(result.finalAnswer, "2 + 2 = 4.");
  assert.equal(result.progress.length, 0);
});

test("apply reports completion only on SignalProcessingComplete", () => {
  const accumulator = new TurnAccumulator();
  accumulator.apply(textDelta("a1", "partial"));
  assert.equal(accumulator.isComplete, false);
  accumulator.apply(complete());
  assert.equal(accumulator.isComplete, true);
});

