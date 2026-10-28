// The payload of `agent.event`: one record of pi's RPC stdout stream, forwarded untouched.
// The shapes mirror pi 1.4.0's `JsonAgentSessionEvent`, defined in
// `@earendil-works/pi-coding-agent/dist/modes/json-event.d.ts` on top of `AgentSessionEvent`
// (`dist/core/agent-session.d.ts`) and `AgentEvent` (`@earendil-works/pi-agent-core`
// `dist/types.d.ts`); the wire format is documented in pi's `docs/json.md`. This package has no
// dependencies, so the union is restated here with the fields the wire carries. Message and
// content shapes come from `@earendil-works/pi-ai` `dist/types.d.ts`; fields the UI does not
// render are kept as `unknown` rather than invented. The daemon's `agents/pi-events.ts` checks
// at compile time that pi's own type is assignable to `PiEvent`, so drift fails the build.

export interface PiUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h?: number;
    reasoning?: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export type PiStopReason =
    | "pending"
    | "stop"
    | "length"
    | "toolUse"
    | "error"
    | "aborted"
    | "deferred";

export interface PiTextContent {
    type: "text";
    text: string;
    textSignature?: string;
}

export interface PiThinkingContent {
    type: "thinking";
    thinking: string;
    thinkingSignature?: string;
    redacted?: boolean;
}

export interface PiImageContent {
    type: "image";
    data: string;
    mimeType: string;
}

export interface PiToolCall {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    thoughtSignature?: string;
    namespace?: string;
}

export interface PiUserMessage {
    role: "user";
    content: string | (PiTextContent | PiImageContent)[];
    timestamp: number;
}

export interface PiAssistantMessage {
    role: "assistant";
    content: (PiTextContent | PiThinkingContent | PiToolCall)[];
    api: string;
    provider: string;
    model: string;
    usage: PiUsage;
    stopReason: PiStopReason;
    errorMessage?: string;
    timestamp: number;
}

export interface PiToolResultMessage {
    role: "toolResult";
    toolCallId: string;
    toolName: string;
    content: (PiTextContent | PiImageContent)[];
    details?: unknown;
    isError: boolean;
    timestamp: number;
}

/** pi's `AgentMessage`: the three core roles, a system message, or a custom extension message. */
export type PiMessage =
    | PiUserMessage
    | PiAssistantMessage
    | PiToolResultMessage
    | { role: string; content: unknown };

/** The nested event of `message_update` on the wire: deltas only, no `partial` snapshot. */
export type PiAssistantMessageEvent =
    | { type: "start" }
    | { type: "text_start"; contentIndex: number }
    | { type: "text_delta"; contentIndex: number; delta: string }
    | { type: "text_end"; contentIndex: number; content: string }
    | { type: "thinking_start"; contentIndex: number }
    | { type: "thinking_delta"; contentIndex: number; delta: string }
    | { type: "thinking_end"; contentIndex: number; content: string }
    | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
    | { type: "toolcall_delta"; contentIndex: number; delta: string }
    | { type: "toolcall_end"; contentIndex: number; toolCall: PiToolCall }
    | { type: "done"; reason: "stop" | "length" | "toolUse" | "deferred"; message: PiAssistantMessage }
    | { type: "error"; reason: "aborted" | "error"; error: PiAssistantMessage };

export type PiCompactionReason = "manual" | "threshold" | "overflow";

export type PiEvent =
    | { type: "agent_start" }
    | { type: "agent_end"; messages: PiMessage[]; willRetry: boolean }
    | { type: "agent_settled"; aborted: boolean }
    | { type: "turn_start" }
    | { type: "turn_end"; message: PiMessage; toolResults: PiToolResultMessage[] }
    | { type: "message_start"; message: PiMessage }
    | { type: "message_update"; usage: PiUsage; assistantMessageEvent: PiAssistantMessageEvent }
    | { type: "message_end"; message: PiMessage }
    | {
          type: "tool_execution_start";
          toolCallId: string;
          toolName: string;
          args: unknown;
          parentToolCallId?: string;
      }
    | {
          type: "tool_execution_update";
          toolCallId: string;
          toolName: string;
          args: unknown;
          partialResult: unknown;
          parentToolCallId?: string;
      }
    | {
          type: "tool_execution_end";
          toolCallId: string;
          toolName: string;
          result: unknown;
          isError: boolean;
          durationMs?: number;
          parentToolCallId?: string;
      }
    | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
    | { type: "entry_appended"; entry: unknown }
    | { type: "session_info_changed"; name: string | undefined }
    | { type: "thinking_level_changed"; level: string }
    | { type: "compaction_start"; reason: PiCompactionReason }
    | {
          type: "compaction_end";
          reason: PiCompactionReason;
          result: unknown;
          aborted: boolean;
          willRetry: boolean;
          errorMessage?: string;
      }
    | {
          type: "auto_retry_start";
          attempt: number;
          maxAttempts: number;
          delayMs: number;
          errorMessage: string;
      }
    | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
    | {
          type: "summarization_retry_scheduled";
          attempt: number;
          maxAttempts: number;
          delayMs: number;
          errorMessage: string;
      }
    | { type: "summarization_retry_attempt_start"; source: "branchSummary" }
    | {
          type: "summarization_retry_attempt_start";
          source: "compaction";
          reason: PiCompactionReason;
      }
    | { type: "summarization_retry_finished" }
    | { type: "bash_execution_update"; id?: string; delta: string };

export type PiEventType = PiEvent["type"];
