// Goal: a `notify` event becomes one shown banner with the event's title and message, and a
// click on it focuses the event's session, once. The poster holds a banner until it is
// clicked or closed, and never more than the bound. Method: a fake factory that records each
// banner's options and listeners and lets the test click or close it.
import { describe, expect, it } from "vitest";
import type { NotifyEvent } from "@spinner/protocol";
import {
    NOTIFICATIONS_HELD_MAX,
    NotificationPoster,
    type NotificationLike,
} from "./notifications.js";

interface FakeBanner extends NotificationLike {
    options: { title: string; body: string };
    shown: number;
    fire(event: "click" | "close"): void;
}

function fake_factory() {
    const banners: FakeBanner[] = [];
    const create = (options: { title: string; body: string }): FakeBanner => {
        const listeners: Record<string, (() => void)[]> = { click: [], close: [] };
        const banner: FakeBanner = {
            options,
            shown: 0,
            on(event, listener) {
                listeners[event]?.push(listener);
            },
            show() {
                banner.shown += 1;
            },
            fire(event) {
                for (const listener of listeners[event] ?? []) {
                    listener();
                }
            },
        };
        banners.push(banner);
        return banner;
    };
    return { banners, create };
}

function notify_event(session: string | null, message = "s7 pay: verifying → merged") {
    const event: NotifyEvent = {
        type: "notify",
        ts: "2026-11-05T14:30:00.000Z",
        session,
        title: "Spinner",
        message,
    };
    return event;
}

describe("NotificationPoster", () => {
    it("shows the event as a banner and focuses its session on a click", () => {
        const { banners, create } = fake_factory();
        const focused: (string | null)[] = [];
        const poster = new NotificationPoster(create, (session) => focused.push(session));
        poster.post(notify_event("s007-pay"));
        expect(banners).toHaveLength(1);
        expect(banners[0]?.options).toEqual({
            title: "Spinner",
            body: "s7 pay: verifying → merged",
        });
        expect(banners[0]?.shown).toBe(1);
        expect(focused).toEqual([]);
        expect(poster.size).toBe(1);

        banners[0]?.fire("click");
        expect(focused).toEqual(["s007-pay"]);
        expect(poster.size).toBe(0);
    });

    it("focuses the window without a session for a notification that names none", () => {
        const { banners, create } = fake_factory();
        const focused: (string | null)[] = [];
        const poster = new NotificationPoster(create, (session) => focused.push(session));
        poster.post(notify_event(null));
        banners[0]?.fire("click");
        expect(focused).toEqual([null]);
    });

    it("lets a closed banner go and holds at most the bound", () => {
        const { banners, create } = fake_factory();
        const poster = new NotificationPoster(create, () => undefined);
        poster.post(notify_event("s1"));
        banners[0]?.fire("close");
        expect(poster.size).toBe(0);
        for (let index = 0; index < NOTIFICATIONS_HELD_MAX + 5; index += 1) {
            poster.post(notify_event("s1", `message ${index}`));
        }
        expect(poster.size).toBe(NOTIFICATIONS_HELD_MAX);
    });
});
