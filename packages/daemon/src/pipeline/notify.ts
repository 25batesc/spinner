// Local notifications for pipeline transitions and landed PRs. Every notification is a
// `notify` event on the event stream, carrying the session directory, so the desktop app posts
// it as a Spinner banner whose click opens that session (#12). While no desktop app is
// connected, the daemon shows the banner itself through `osascript`; macOS attributes that one
// to Script Editor, so it is the fallback only. The poller and `land` receive a `Notifier`, so
// tests capture the calls instead of showing banners.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NotifyEvent } from "@spinner/protocol";

/** `session` is the session directory, or null when the notification names no session. */
export type Notifier = (title: string, message: string, session: string | null) => Promise<void>;

/** Runs one program with arguments; the seam a test replaces to capture `osascript`. */
export type ExecFile = (file: string, args: string[]) => Promise<unknown>;

/** Upper bound on notification text; macOS truncates long banners anyway. */
const MESSAGE_CHARS_MAX = 200;

/** The `osascript` banner, run through `exec`. */
export function macos_notifier_with(exec: ExecFile): Notifier {
    return async (title, message) => {
        assert.ok(title.length > 0, "notification needs a title");
        const text = message.slice(0, MESSAGE_CHARS_MAX);
        const script =
            `display notification ${applescript_string(text)} ` +
            `with title ${applescript_string(title)}`;
        await exec("osascript", ["-e", script]);
    };
}

export const macos_notifier: Notifier = macos_notifier_with(promisify(execFile));

/** Silently drops every notification; for tests and for `SPINNER_NOTIFY=off`. */
export const silent_notifier: Notifier = async () => {};

export interface EventNotifierDeps {
    publish: (event: NotifyEvent) => void;
    /** Open `/events` sockets that carry `?client=desktop`. */
    desktop_clients: () => number;
    /** The banner the daemon shows while no desktop app is connected. */
    fallback: Notifier;
    now?: () => Date;
}

/**
 * The daemon's notifier: publishes the `notify` event, then runs the fallback only when no
 * desktop app listens, so the operator never sees two banners for one notification. A daemon
 * whose fallback is `silent_notifier` (`SPINNER_NOTIFY=off`) stays silent: no event either,
 * or a connected app would post the banners that the setting turned off.
 */
export function event_notifier(deps: EventNotifierDeps): Notifier {
    if (deps.fallback === silent_notifier) {
        return silent_notifier;
    }
    const now = deps.now ?? (() => new Date());
    return async (title, message, session) => {
        assert.ok(title.length > 0, "notification needs a title");
        assert.ok(session === null || session.length > 0, "session must be a directory or null");
        const text = message.slice(0, MESSAGE_CHARS_MAX);
        deps.publish({ type: "notify", ts: now().toISOString(), session, title, message: text });
        const clients = deps.desktop_clients();
        assert.ok(clients >= 0, "desktop client count must not be negative");
        if (clients === 0) {
            await deps.fallback(title, text, session);
        }
    };
}

/** AppleScript string literal: double quotes and backslashes escaped. */
export function applescript_string(text: string): string {
    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
