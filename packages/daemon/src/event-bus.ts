// The daemon's in-process event bus. Everything the UI renders passes through here; the
// WebSocket handler is one subscriber, the log is another. The bus holds no history: a client
// that connects late fetches state over REST and then follows events.
import assert from "node:assert/strict";
import type { SpinnerEvent } from "@spinner/protocol";

export type EventListener = (event: SpinnerEvent) => void;

/** Upper bound on subscribers. Each UI tab is one; more than this is a leak. */
const LISTENERS_MAX = 1000;

export class EventBus {
    private readonly listeners = new Set<EventListener>();

    /** Registers a listener and returns the function that removes it. */
    subscribe(listener: EventListener): () => void {
        assert.ok(this.listeners.size < LISTENERS_MAX, "too many event bus listeners");
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Delivers one event to every listener. A throwing listener does not stop the others. */
    publish(event: SpinnerEvent): void {
        assert.ok(typeof event.type === "string", "event needs a type");
        assert.ok(typeof event.ts === "string", "event needs a timestamp");
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (error) {
                // A listener failure is a programmer error in that listener, not a reason to
                // drop the event for everyone else. Report it and continue.
                console.error("event listener failed:", error);
            }
        }
    }

    get size(): number {
        return this.listeners.size;
    }
}
