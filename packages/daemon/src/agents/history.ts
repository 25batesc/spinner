// `GET /sessions/:dir/agents/:name/events`: an agent's past turns for a tab that loads after
// the fact. Read from the agent's pi transcript, `agents/<name>/pi/*.jsonl` (format: pi's
// `docs/session-format.md`; `SessionMessageEntry` is `{ type: "message", message }`), and
// returned as the `message_end` events the UI already folds, so a reloaded tab renders the
// same way as a live one. The newest file is the transcript `--session-id <name>` resumes.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentEventsStamp, PiEvent, PiMessage } from "@spinner/protocol";
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

/** When the agent's transcript was last written and its size; nulls without a transcript. */
export function agent_history_stamp(session_path: string, name: string): AgentEventsStamp {
    const file = newest_transcript(join(session_path, agent_pi_dir(name)));
    if (file === null) {
        return { written: null, bytes: 0 };
    }
    const stat = statSync(file);
    return { written: stat.mtime.toISOString(), bytes: stat.size };
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
