// The app's own banners for the daemon's `notify` events (#12). A banner the app posts carries
// Spinner's name and bundle icon, and its click brings the main window forward on the
// event's session; the daemon's `osascript` banner showed Script Editor and opened a script
// file. This file is pure so Vitest can drive it: `main.ts` supplies Electron's
// `Notification` and the focus function.
import assert from "node:assert/strict";
import type { NotifyEvent } from "@spinner/protocol";

/** What the poster needs from one Electron `Notification`. */
export interface NotificationLike {
    on(event: "click" | "close", listener: () => void): void;
    show(): void;
}

export type NotificationFactory = (options: { title: string; body: string }) => NotificationLike;

/**
 * Upper bound on banners held at once. Electron drops a click handler when the `Notification`
 * object is garbage collected, so the poster holds each one until it is clicked or closed;
 * past the bound the oldest goes, since Notification Center keeps few banners anyway.
 */
export const NOTIFICATIONS_HELD_MAX = 32;

export class NotificationPoster {
    private readonly held = new Set<NotificationLike>();

    constructor(
        private readonly create: NotificationFactory,
        /** Shows the main window, on `session` when it is not null. */
        private readonly focus_session: (session: string | null) => void,
    ) {}

    post(event: NotifyEvent): void {
        assert.equal(event.type, "notify");
        assert.ok(event.title.length > 0, "a notification needs a title");
        const notification = this.create({ title: event.title, body: event.message });
        const release = () => {
            this.held.delete(notification);
        };
        notification.on("click", () => {
            release();
            this.focus_session(event.session);
        });
        notification.on("close", release);
        if (this.held.size >= NOTIFICATIONS_HELD_MAX) {
            const oldest = this.held.values().next().value;
            assert.ok(oldest !== undefined);
            this.held.delete(oldest);
        }
        this.held.add(notification);
        notification.show();
    }

    /** Banners held for their click; for tests. */
    get size(): number {
        return this.held.size;
    }
}
