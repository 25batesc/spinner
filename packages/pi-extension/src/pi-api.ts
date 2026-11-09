// The subset of pi 1.4.0's extension API this extension uses, stated structurally so the
// package type-checks without the pi package in the workspace (pi supplies
// `@earendil-works/pi-coding-agent` and `typebox` to extensions at run time; see pi's
// `docs/packages.md`). The real declarations are in pi's `dist/core/extensions/types.d.ts`;
// a field here has the same name and shape as there. A test drives the factory with a fake
// that satisfies these types.
import type { TSchema } from "typebox";

export interface ToolTextContent {
    type: "text";
    text: string;
}

/** An image in a user message: base64 data, as pi's `ImageContent`. */
export interface ImageContent {
    type: "image";
    data: string;
    mimeType: string;
}

export interface ToolResult {
    content: ToolTextContent[];
    details: unknown;
}

export interface ToolExecuteContext {
    cwd: string;
}

export interface ToolDefinition<TParams = Record<string, unknown>> {
    name: string;
    label: string;
    description: string;
    /** One line for pi's "Available tools" section. */
    promptSnippet?: string;
    parameters: TSchema;
    execute(
        toolCallId: string,
        params: TParams,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: ToolExecuteContext,
    ): Promise<ToolResult>;
}

export interface SystemPromptOptions {
    sections: Record<string, string>;
    cwd: string;
}

export interface BeforeAgentStartEvent {
    messageType: "user" | "custom";
    systemPromptOptions: SystemPromptOptions;
}

export interface ToolCallEvent {
    toolName: string;
    input: Record<string, unknown>;
}

export interface ToolCallResult {
    block: true;
    reason: string;
}

/** One part of a tool result, as pi records it: text, or an image the model sees. */
export type ToolResultContent =
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string };

/** pi's `tool_result` event: the result of one tool call, before pi records it. */
export interface ToolResultEvent {
    type: "tool_result";
    toolName: string;
    toolCallId: string;
    input: Record<string, unknown>;
    content: ToolResultContent[];
    /** Set by a tool with an output schema; replacing `content` alone drops it. */
    structuredContent?: unknown;
    isError: boolean;
}

/** A handler's answer to `tool_result`: the fields that replace the result's own. */
export interface ToolResultPatch {
    content?: ToolResultContent[];
    structuredContent?: unknown;
}

export interface ExtensionContext {
    cwd: string;
    hasUI: boolean;
    ui: { notify(message: string, level: "info" | "warning" | "error"): void };
    /** True when the agent is not streaming. */
    isIdle(): boolean;
    /** Aborts the current agent run, as Escape does. */
    abort(): void;
    /** Starts compaction of the context without waiting for it, as `/compact` does. */
    compact(): void;
}

export interface SessionStartEvent {
    type: "session_start";
}

export interface SessionShutdownEvent {
    type: "session_shutdown";
    reason: "quit" | "reload" | "new" | "resume" | "fork";
}

/** The events the tty channel posts to the daemon; each carries `type` plus pi's fields. */
export interface LifecycleEvent {
    type:
        | "agent_start"
        | "agent_end"
        | "agent_settled"
        | "turn_end"
        | "tool_execution_start"
        | "tool_execution_end";
    [key: string]: unknown;
}

export type LifecycleEventName = LifecycleEvent["type"];

/** pi's `SlashCommandInfo`. */
export interface SlashCommandInfo {
    name: string;
    description?: string;
    source: "extension" | "prompt" | "skill";
    sourceInfo?: { path?: string };
}

export interface ExtensionCommandContext extends ExtensionContext {
    reload(): Promise<void>;
}

export interface RegisteredCommand {
    description: string;
    handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

export interface ExtensionAPI {
    registerTool(tool: ToolDefinition): void;
    registerCommand(name: string, command: RegisteredCommand): void;
    /**
     * Sends a user message; it starts a turn, or queues as a steer or follow-up when busy.
     * The array form carries images with the text.
     */
    sendUserMessage(
        content: string | (ToolTextContent | ImageContent)[],
        options?: { deliverAs?: "steer" | "followUp" },
    ): void;
    /**
     * Sends a custom message (from an extension, not a person). `triggerTurn` starts a run
     * when idle; `deliverAs` queues it into a running one.
     */
    sendMessage(
        message: { customType: string; content: string; display: boolean },
        options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
    ): void;
    /** The slash commands pi loaded. */
    getCommands(): SlashCommandInfo[];
    on(
        event: "session_start",
        handler: (event: SessionStartEvent, ctx: ExtensionContext) => void | Promise<void>,
    ): unknown;
    on(
        event: "session_shutdown",
        handler: (event: SessionShutdownEvent, ctx: ExtensionContext) => void | Promise<void>,
    ): unknown;
    on(
        event: LifecycleEventName,
        handler: (event: LifecycleEvent, ctx: ExtensionContext) => void | Promise<void>,
    ): unknown;
    on(
        event: "before_agent_start",
        handler: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => void | Promise<void>,
    ): unknown;
    on(
        event: "tool_call",
        handler: (
            event: ToolCallEvent,
            ctx: ExtensionContext,
        ) => ToolCallResult | undefined | Promise<ToolCallResult | undefined>,
    ): unknown;
    on(
        event: "tool_result",
        handler: (event: ToolResultEvent, ctx: ExtensionContext) => ToolResultPatch | undefined,
    ): unknown;
}
