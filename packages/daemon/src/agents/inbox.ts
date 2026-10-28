// `inbox/` messages (docs/SESSION_PROTOCOL.md, "Messages"): one file each, named
// `<HHMMSS>-<from>-<to>.md`, first line the subject. `write_inbox_message` is what
// `POST /sessions/:dir/inbox` and the extension's `message` tool produce; `parse_inbox_file`
// is what the delivery reads back, so a file the operator writes by hand delivers the same
// way. Names are one word each (an agent name, `operator` or `all`), so the file name splits
// without ambiguity.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxMessageRequest } from "@spinner/protocol";

/** Upper bound on a message body. Longer text belongs in a file the message points to. */
const BODY_LENGTH_MAX = 20_000;

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface InboxMessage {
    file: string;
    from: string;
    to: string;
    subject: string;
    body: string;
}

/** Checks a request. Returns the reason when it is refused. */
export function validate_inbox_message(request: InboxMessageRequest): string | null {
    if (!NAME.test(request.from)) {
        return `from must be an agent name or operator, got "${request.from}"`;
    }
    if (!NAME.test(request.to)) {
        return `to must be an agent name, operator or all, got "${request.to}"`;
    }
    if (request.subject.trim().length === 0 || request.subject.includes("\n")) {
        return "subject must be one non-empty line";
    }
    if (request.text.length > BODY_LENGTH_MAX) {
        return `text longer than ${BODY_LENGTH_MAX} characters`;
    }
    return null;
}

/** The file name for a message sent at `now`. A second message in the same second gets a suffix. */
export function inbox_file_name(
    session_path: string,
    request: InboxMessageRequest,
    now: Date,
): string {
    const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map((part) => String(part).padStart(2, "0"))
        .join("");
    const base = `${stamp}-${request.from}-${request.to}`;
    let name = `${base}.md`;
    for (let n = 2; existsSync(join(session_path, "inbox", name)); n += 1) {
        assert.ok(n < 100, "more than 99 messages in one second");
        name = `${base}-${n}.md`;
    }
    return name;
}

/** Writes the message file and returns its name. The caller validated the request. */
export function write_inbox_message(
    session_path: string,
    request: InboxMessageRequest,
    now: Date,
): string {
    assert.equal(validate_inbox_message(request), null, "request must be validated first");
    const file = inbox_file_name(session_path, request, now);
    const body = request.text.replace(/\n+$/, "");
    writeFileSync(join(session_path, "inbox", file), `${request.subject.trim()}\n\n${body}\n`);
    return file;
}

/**
 * Reads a message back from its file. Null for a file that is not a message. `known` lists
 * the session's agent names, which splits `from` and `to` when both have hyphens.
 */
export function parse_inbox_file(
    session_path: string,
    file: string,
    known: readonly string[],
): InboxMessage | null {
    const parsed = parse_inbox_file_name(file, known);
    if (parsed === null) {
        return null;
    }
    const text = readFileSync(join(session_path, "inbox", file), "utf8");
    const newline = text.indexOf("\n");
    const subject = (newline === -1 ? text : text.slice(0, newline)).trim();
    const body = newline === -1 ? "" : text.slice(newline + 1).trim();
    return { file, ...parsed, subject, body };
}

/**
 * `<HHMMSS>-<from>-<to>[-<n>].md`. Names may contain hyphens, so the split tries each known
 * name as `from` first; without a match, `from` is the first word.
 */
export function parse_inbox_file_name(
    file: string,
    known: readonly string[],
): { from: string; to: string } | null {
    const match = /^\d{6}-([a-z0-9][a-z0-9-]*?)(?:-\d+)?\.md$/.exec(file);
    if (match === null || match[1] === undefined) {
        return null;
    }
    const names = match[1];
    const candidates = [...known, "operator"].sort((a, b) => b.length - a.length);
    for (const name of candidates) {
        if (names.startsWith(`${name}-`) && names.length > name.length + 1) {
            return { from: name, to: names.slice(name.length + 1) };
        }
    }
    const hyphen = names.indexOf("-");
    if (hyphen <= 0 || hyphen === names.length - 1) {
        return null;
    }
    return { from: names.slice(0, hyphen), to: names.slice(hyphen + 1) };
}
