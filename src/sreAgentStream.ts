import { TokenCredential } from "@azure/identity";
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel
} from "@microsoft/signalr";
import { decodeTokenClaims, trace } from "./trace.js";

export type AgentMessageKind = "reasoning" | "assistant" | "tool" | "command";

export interface AgentTurnMessage {
  readonly messageId: string;
  readonly kind: AgentMessageKind;
  readonly text: string;
  /** For `command` messages: the execution status (e.g. "Completed", "Pending", "Cancelled"). */
  readonly status?: string;
}

export interface AgentTurnResult {
  /** The agent's final answer: the last non-reasoning assistant message of the turn. */
  readonly finalAnswer: string;
  /** Reasoning + tool + command + interim narration messages, in order, excluding the final answer. */
  readonly progress: readonly AgentTurnMessage[];
  /** All rendered messages of the turn, in order. */
  readonly messages: readonly AgentTurnMessage[];
  /** True if a SignalProcessingComplete signal was received; false on timeout. */
  readonly completed: boolean;
  /**
   * Write commands left in "Pending" status because the agent (Review mode) is waiting
   * for the user to approve them. Resolved conversationally: the user's next message
   * ("approve"/"yes" runs them, "no"/"cancel" cancels). Empty when nothing is pending.
   */
  readonly pendingCommands: readonly string[];
}

interface RawContent {
  readonly $type?: string;
  readonly text?: string;
  readonly name?: string;
  readonly additionalProperties?: { readonly userDescription?: string } | null;
}

/** One `MessageUpdate` event argument pushed by the SRE Agent `/agentHub`. */
export interface MessageUpdateArg {
  readonly role?: string;
  readonly contents?: readonly RawContent[];
  readonly additionalProperties?:
    | {
        readonly threadId?: string;
        readonly messageId?: string;
        readonly streamMessageType?: string | null;
        readonly actionName?: string;
      }
    | null;
  readonly finishReason?: string | null;
}

const TURN_COMPLETE_ACTION = "SignalProcessingComplete";
const AZ_CLI_STREAM_TYPE = "AzCli";

interface MutableEntry {
  order: number;
  kind: AgentMessageKind;
  text: string;
  /** For `command` entries: the raw streamed JSON of the azCliExecution object. */
  raw: string;
}

/**
 * Accumulates the SRE Agent's streamed `MessageUpdate` deltas for a single turn.
 *
 * The agent emits text in chunks grouped by `messageId`; this concatenates them,
 * classifies each message (reasoning vs assistant content vs tool call) and
 * detects turn completion via the `SignalProcessingComplete` action. Kept free of
 * any SignalR dependency so it can be unit tested against captured event streams.
 */
export class TurnAccumulator {
  private readonly entries = new Map<string, MutableEntry>();
  private nextOrder = 0;
  private complete = false;
  private sawContent = false;

  /** Applies one event; returns true if the visible message state changed. */
  apply(arg: MessageUpdateArg): boolean {
    if (arg.additionalProperties?.actionName === TURN_COMPLETE_ACTION) {
      // Only honor a completion once this turn has actually produced content. A
      // SignalProcessingComplete that arrives before any content is a stale signal
      // replayed from a previous turn (the hub routes by threadId only); acting on
      // it would resolve a brand-new turn instantly with an empty answer.
      if (this.sawContent) {
        this.complete = true;
      }
      return false;
    }

    if (arg.role === "user") {
      return false;
    }

    const messageId = arg.additionalProperties?.messageId;
    if (!messageId) {
      return false;
    }

    const streamType = arg.additionalProperties?.streamMessageType;
    let changed = false;

    for (const content of arg.contents ?? []) {
      if (content.$type === "functionCall" || arg.role === "tool") {
        const description =
          content.additionalProperties?.userDescription || content.name || "Running a tool";
        const entry = this.ensure(messageId);
        entry.kind = "tool";
        entry.text = description;
        changed = true;
      } else if (content.$type === "functionResult") {
        continue;
      } else if (typeof content.text === "string" && content.text.length > 0) {
        const entry = this.ensure(messageId);
        if (streamType === AZ_CLI_STREAM_TYPE) {
          // AzCli messages stream the raw JSON of the command execution; accumulate
          // and parse it later rather than dumping JSON into the conversation.
          entry.kind = "command";
          entry.raw += content.text;
        } else {
          entry.kind = streamType === "Reasoning" ? "reasoning" : "assistant";
          entry.text += content.text;
        }
        changed = true;
      }
    }

    if (changed) {
      this.sawContent = true;
    }
    return changed;
  }

  get isComplete(): boolean {
    return this.complete;
  }

  get messages(): AgentTurnMessage[] {
    const ordered = [...this.entries.entries()]
      .map(([messageId, entry]) => ({ messageId, ...entry }))
      .sort((a, b) => a.order - b.order);

    const result: AgentTurnMessage[] = [];
    let lastCommand: string | undefined;
    for (const entry of ordered) {
      if (entry.kind === "command") {
        const parsed = parseAzCli(entry.raw);
        if (!parsed.command) {
          continue;
        }
        // The same command streams under multiple messageIds; collapse duplicates.
        if (parsed.command === lastCommand) {
          const previous = result[result.length - 1];
          if (previous && previous.kind === "command") {
            result[result.length - 1] = { ...previous, status: parsed.status };
          }
          continue;
        }
        lastCommand = parsed.command;
        result.push({ messageId: entry.messageId, kind: "command", text: parsed.command, status: parsed.status });
      } else {
        result.push({ messageId: entry.messageId, kind: entry.kind, text: entry.text });
      }
    }
    return result;
  }

  result(): AgentTurnResult {
    const messages = this.messages;
    const finalIndex = messages.findLastIndex(message => message.kind === "assistant");
    const finalAnswer = finalIndex >= 0 ? messages[finalIndex].text : "";
    const progress = messages.filter((_, index) => index !== finalIndex);
    const pendingCommands = messages
      .filter(message => message.kind === "command" && message.status === "Pending")
      .map(message => message.text);
    return { finalAnswer, progress, messages, completed: this.complete, pendingCommands };
  }

  private ensure(messageId: string): MutableEntry {
    let entry = this.entries.get(messageId);
    if (!entry) {
      entry = { order: this.nextOrder++, kind: "assistant", text: "", raw: "" };
      this.entries.set(messageId, entry);
    }
    return entry;
  }
}

/** Parses the streamed azCliExecution JSON, tolerating partial/incomplete chunks. */
function parseAzCli(raw: string): { command?: string; status?: string } {
  try {
    const parsed = JSON.parse(raw) as { command?: string; status?: string };
    return { command: parsed.command, status: parsed.status };
  } catch {
    return {};
  }
}

interface TurnSession {
  readonly accumulator: TurnAccumulator;
  readonly onUpdate?: (result: AgentTurnResult) => void;
  resolve: (result: AgentTurnResult) => void;
  timer: NodeJS.Timeout;
}

interface RunTurnOptions {
  /** Called whenever the streamed state changes, for live UI updates. */
  readonly onUpdate?: (result: AgentTurnResult) => void;
  /**
   * Invoked after the turn listener is registered (and any buffered events are
   * drained) to trigger agent processing, e.g. posting the user message. If it
   * throws, the turn is abandoned and the error is rethrown.
   */
  readonly trigger?: () => Promise<void>;
  /** Max time to await SignalProcessingComplete before resolving as incomplete. */
  readonly timeoutMs?: number;
}

const DEFAULT_TURN_TIMEOUT_MS = 180_000;
const BUFFER_TTL_MS = 120_000;

/**
 * Maintains a persistent SignalR connection to the SRE Agent `/agentHub` and
 * exposes per-thread turn streaming. The hub auto-pushes `MessageUpdate` events
 * for every thread owned by the authenticated identity, so events are routed by
 * `threadId`. Events arriving before a turn is registered (e.g. between thread
 * creation and listener attach) are briefly buffered to avoid races.
 */
export class SreAgentStream {
  private connection?: HubConnection;
  private startPromise?: Promise<void>;
  private readonly sessions = new Map<string, TurnSession>();
  private readonly buffers = new Map<string, { args: MessageUpdateArg[]; expiresAt: number }>();

  constructor(
    private readonly endpoint: string,
    private readonly scope: string,
    private readonly credential: TokenCredential
  ) {}

  async start(): Promise<void> {
    if (this.connection && this.connection.state === HubConnectionState.Connected) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    const connection = new HubConnectionBuilder()
      .withUrl(`${this.endpoint}/agentHub`, {
        accessTokenFactory: async () => {
          const token = await this.credential.getToken(this.scope);
          if (!token) {
            throw new Error(`Failed to acquire token for scope ${this.scope}`);
          }
          trace("sre_stream_token_acquired", { scope: this.scope, claims: decodeTokenClaims(token.token) });
          return token.token;
        }
      })
      .withAutomaticReconnect()
      .configureLogging(LogLevel.Warning)
      .build();

    connection.on("MessageUpdate", (arg: MessageUpdateArg) => this.handleMessageUpdate(arg));
    connection.onclose(error =>
      console.error(JSON.stringify({ event: "sre_stream_closed", message: error?.message }))
    );

    this.connection = connection;
    this.startPromise = connection
      .start()
      .then(() => {
        console.log(JSON.stringify({ event: "sre_stream_connected" }));
      })
      .catch(error => {
        this.startPromise = undefined;
        throw error;
      });

    return this.startPromise;
  }

  async runTurn(threadId: string, options: RunTurnOptions = {}): Promise<AgentTurnResult> {
    await this.start();

    const accumulator = new TurnAccumulator();
    const previous = this.sessions.get(threadId);
    if (previous) {
      clearTimeout(previous.timer);
      this.sessions.delete(threadId);
    }

    const result = await new Promise<AgentTurnResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sessions.delete(threadId);
        resolve(accumulator.result());
      }, options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);

      const session: TurnSession = { accumulator, onUpdate: options.onUpdate, resolve, timer };
      this.sessions.set(threadId, session);

      const trigger = options.trigger;
      // Buffered events belong to THIS turn only when the turn was already triggered
      // before the session attached (the create-thread race, no trigger). For a
      // follow-up message the trigger posts the message AFTER the session registers,
      // so anything buffered is a stale remnant of a previous turn and must be dropped,
      // not replayed (replaying a stale completion resolves this turn with no answer).
      if (trigger) {
        this.clearBuffer(threadId);
      } else {
        this.drainBuffer(threadId, session);
      }

      if (trigger) {
        trigger().catch(error => {
          clearTimeout(timer);
          this.sessions.delete(threadId);
          reject(error);
        });
      }
    });

    return result;
  }

  async stop(): Promise<void> {
    if (this.connection) {
      await this.connection.stop();
      this.connection = undefined;
      this.startPromise = undefined;
    }
  }

  private handleMessageUpdate(arg: MessageUpdateArg): void {
    const threadId = arg.additionalProperties?.threadId;
    if (!threadId) {
      return;
    }

    const session = this.sessions.get(threadId);
    if (session) {
      this.applyToSession(threadId, session, arg);
      return;
    }

    this.bufferEvent(threadId, arg);
  }

  private applyToSession(threadId: string, session: TurnSession, arg: MessageUpdateArg): void {
    const changed = session.accumulator.apply(arg);

    if (changed && session.onUpdate) {
      try {
        session.onUpdate(session.accumulator.result());
      } catch (error) {
        console.error(
          JSON.stringify({ event: "sre_stream_onupdate_error", message: (error as Error).message })
        );
      }
    }

    if (session.accumulator.isComplete) {
      clearTimeout(session.timer);
      this.sessions.delete(threadId);
      session.resolve(session.accumulator.result());
    }
  }

  private bufferEvent(threadId: string, arg: MessageUpdateArg): void {
    this.pruneBuffers();
    const existing = this.buffers.get(threadId);
    if (existing) {
      existing.args.push(arg);
      existing.expiresAt = Date.now() + BUFFER_TTL_MS;
    } else {
      this.buffers.set(threadId, { args: [arg], expiresAt: Date.now() + BUFFER_TTL_MS });
    }
  }

  private clearBuffer(threadId: string): void {
    this.buffers.delete(threadId);
  }

  private drainBuffer(threadId: string, session: TurnSession): void {
    const buffered = this.buffers.get(threadId);
    if (!buffered) {
      return;
    }
    this.buffers.delete(threadId);
    for (const arg of buffered.args) {
      this.applyToSession(threadId, session, arg);
      if (!this.sessions.has(threadId)) {
        return;
      }
    }
  }

  private pruneBuffers(): void {
    const now = Date.now();
    for (const [threadId, buffer] of this.buffers) {
      if (buffer.expiresAt <= now) {
        this.buffers.delete(threadId);
      }
    }
  }
}
