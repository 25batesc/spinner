// Local notifications for pipeline transitions. macOS only in M1, through `osascript`; the
// board never posts anywhere else. The poller receives a `Notifier` so tests capture the
// calls instead of showing banners.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type Notifier = (title: string, message: string) => Promise<void>;

const exec_file = promisify(execFile);

/** Upper bound on notification text; macOS truncates long banners anyway. */
const MESSAGE_CHARS_MAX = 200;

export const macos_notifier: Notifier = async (title, message) => {
    assert.ok(title.length > 0, "notification needs a title");
    const text = message.slice(0, MESSAGE_CHARS_MAX);
    const script =
        `display notification ${applescript_string(text)} with title ${applescript_string(title)}`;
    await exec_file("osascript", ["-e", script]);
};

/** Silently drops every notification; for tests and for `--quiet`. */
export const silent_notifier: Notifier = async () => {};

/** AppleScript string literal: double quotes and backslashes escaped. */
export function applescript_string(text: string): string {
    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
