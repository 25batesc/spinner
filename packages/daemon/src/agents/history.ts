// An agent's past turns, read from its pi transcript, `agents/<name>/pi/*.jsonl` (format:
// pi's `docs/session-format.md`; `SessionMessageEntry` is `{ type: "message", message }`),
// as the `message_end` events the UI folds. The newest file is the transcript
// `--session-id <name>` resumes. `agent_history_tail` seeds the chat's transcript log when an
// agent's pi starts; `agent_history` is the whole file, for `GET …/agents/:name/events` and
// the review swarm.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PiEvent, PiMessage } from "@spinner/protocol";
import { agent_pi_dir } from "./harness.js";

/** Upper bound on transcript entries read; a session past this is compacted by pi anyway. */
const ENTRIES_MAX = 50_000;

/** The agent's past messages as `message_end` events, oldest first; empty without a transcript. */
export function agent_history(session_path: string, name: string): PiEvent[] {
    const dir = join(session_path, agent_pi_dir(name));
    const file = newest_transcript(dir);
    if (file === null) {
        return [];
    }
    return events_of_transcript(readFileSync(file, "utf8"));
}

/** Pure: the `message` entries of a transcript as events. System messages are not turns. */
export function events_of_transcript(text: string): PiEvent[] {
    const events: PiEvent[] = [];
    const lines = text.split("\n").slice(0, ENTRIES_MAX);
    for (const line of lines) {
        if (line.trim().length === 0) {
            continue;
        }
        let entry: unknown;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        const message = message_of(entry);
        if (message !== null && message.role !== "system") {
            events.push({ type: "message_end", message });
        }
    }
    return events;
}

/**
 * The newest `max` messages of the agent's transcript as `message_end` events, oldest first:
 * what the chat's log starts from when the agent's pi starts. Read from the end of the file,
 * so a long transcript costs its last messages and not the whole parse.
 */
export function agent_history_tail(session_path: string, name: string, max: number): PiEvent[] {
    assert.ok(Number.isInteger(max) && max > 0, "the tail bound must be a positive integer");
    const file = newest_transcript(join(session_path, agent_pi_dir(name)));
    if (file === null) {
        return [];
    }
    const lines = readFileSync(file, "utf8").split("\n");
    const events: PiEvent[] = [];
    for (let index = lines.length - 1; index >= 0 && events.length < max; index -= 1) {
        const message = message_of_line(lines[index] ?? "");
        if (message !== null && message.role !== "system") {
            events.push({ type: "message_end", message });
        }
    }
    return events.reverse();
}

function message_of_line(line: string): PiMessage | null {
    if (line.trim().length === 0) {
        return null;
    }
    try {
        return message_of(JSON.parse(line));
    } catch {
        return null;
    }
}

function message_of(entry: unknown): PiMessage | null {
    if (typeof entry !== "object" || entry === null) {
        return null;
    }
    const record = entry as Record<string, unknown>;
    if (record["type"] !== "message") {
        return null;
    }
    const message = record["message"];
    if (typeof message !== "object" || message === null || !("role" in message)) {
        return null;
    }
    return message as PiMessage;
}

function newest_transcript(dir: string): string | null {
    if (!existsSync(dir)) {
        return null;
    }
    const files = readdirSync(dir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => join(dir, name))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files[0] ?? null;
}
