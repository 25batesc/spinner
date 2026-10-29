// The daemon's end of the channel into a tty pi (MISSION.md s009, Contracts "tty contract").
// The extension inside pi opens a long-poll on `GET /sessions/:dir/agents/:name/commands`;
// the daemon hands it one command per response (`prompt`, `steer`, `abort`) and the
// extension acknowledges it on its next poll with the disposition pi gave. The extension also
// posts `hello` (pid and slash commands) once pi is up and the lifecycle events as they
// happen. This class holds that state for one agent: the command queue, the acks awaited, the
// waiting poller, the hello, and the event listeners. It knows nothing of HTTP or the pty.
import assert from "node:assert/strict";
import type { AgentExtensionCommand, PiCommandInfo, PiEvent } from "@spinner/protocol";

/** Commands waiting for the extension. More means pi stopped polling. */
const QUEUE_MAX = 50;

/** Time a `prompt` or `steer` waits for the extension's ack before the route answers 504. */
export const ACK_TIMEOUT_MS = 30_000;

/** How long one long-poll is held open without a command. */
export const POLL_HOLD_MS = 30_000;

export interface Ack {
    id: string;
    disposition: string;
}

export interface Hello {
    pid: number;
    commands: PiCommandInfo[];
}

interface Awaiting {
    resolve: (disposition: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

interface Poller {
    resolve: (command: AgentExtensionCommand | null) => void;
    timer: NodeJS.Timeout;
}

export class ExtensionChannel {
    private readonly queue: AgentExtensionCommand[] = [];
    private readonly awaiting = new Map<string, Awaiting>();
    private readonly listeners = new Set<(event: PiEvent) => void>();
    private poller: Poller | null = null;
    private hello_: Hello | null = null;
    private hello_waiters: Array<{ resolve: (hello: Hello) => void; reject: (e: Error) => void }> =
        [];
    private closed: Error | null = null;
    private next_id = 1;

    constructor(private readonly ack_timeout_ms = ACK_TIMEOUT_MS) {}

    /** The last hello the extension posted, or null before the first. */
    get hello(): Hello | null {
        return this.hello_;
    }

    /** Resolves with the hello, at once when one arrived already. Rejects on `close`. */
    wait_hello(): Promise<Hello> {
        if (this.hello_ !== null) {
            return Promise.resolve(this.hello_);
        }
        if (this.closed !== null) {
            return Promise.reject(this.closed);
        }
        return new Promise((resolve, reject) => {
            this.hello_waiters.push({ resolve, reject });
        });
    }

    /** `POST hello` from the extension: once at pi's start, again after `/spinner-reload`. */
    on_hello(hello: Hello): void {
        assert.ok(hello.pid > 0, "hello needs pi's pid");
        this.hello_ = hello;
        const waiters = this.hello_waiters;
        this.hello_waiters = [];
        for (const waiter of waiters) {
            waiter.resolve(hello);
        }
    }

    /**
     * Queues a command for the extension and resolves with the disposition it acks. A waiting
     * poll receives the command at once; otherwise the next poll does. Rejects after
     * `ack_timeout_ms` without an ack, or when the channel closes.
     */
    enqueue(type: AgentExtensionCommand["type"], text?: string): Promise<string> {
        if (this.closed !== null) {
            return Promise.reject(this.closed);
        }
        assert.ok(this.queue.length < QUEUE_MAX, "the extension stopped polling for commands");
        assert.ok(type === "abort" || (text !== undefined && text.length > 0), `${type} needs text`);
        const id = `c-${this.next_id}`;
        this.next_id += 1;
        const command: AgentExtensionCommand = { id, type, ...(text === undefined ? {} : { text }) };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.awaiting.delete(id);
                this.drop_queued(id);
                reject(new Error(`the extension did not acknowledge ${type} ${id} in time`));
            }, this.ack_timeout_ms);
            this.awaiting.set(id, { resolve, reject, timer });
            if (this.poller !== null) {
                const poller = this.poller;
                this.poller = null;
                clearTimeout(poller.timer);
                poller.resolve(command);
                return;
            }
            this.queue.push(command);
        });
    }

    /**
     * One long-poll from the extension. `ack` settles the command the extension just acted on.
     * Resolves with the next queued command, or with null after `hold_ms` without one. A second
     * poll while one waits replaces it: the first resolves with null.
     */
    poll(ack: Ack | null, hold_ms = POLL_HOLD_MS): Promise<AgentExtensionCommand | null> {
        if (ack !== null) {
            const entry = this.awaiting.get(ack.id);
            if (entry !== undefined) {
                this.awaiting.delete(ack.id);
                clearTimeout(entry.timer);
                entry.resolve(ack.disposition);
            }
        }
        if (this.closed !== null) {
            return Promise.resolve(null);
        }
        const next = this.queue.shift();
        if (next !== undefined) {
            return Promise.resolve(next);
        }
        if (this.poller !== null) {
            clearTimeout(this.poller.timer);
            this.poller.resolve(null);
            this.poller = null;
        }
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                if (this.poller !== null && this.poller.resolve === resolve) {
                    this.poller = null;
                }
                resolve(null);
            }, hold_ms);
            this.poller = { resolve, timer };
        });
    }

    /** True while the extension has a long-poll open: pi is up and listening. */
    get polling(): boolean {
        return this.poller !== null;
    }

    /** `POST events` from the extension; each reaches every listener, as a pi record would. */
    push_events(events: PiEvent[]): void {
        for (const event of events) {
            for (const listener of this.listeners) {
                listener(event);
            }
        }
    }

    on_event(listener: (event: PiEvent) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** pi is gone: every awaited ack rejects, the waiting poll ends, later calls reject. */
    close(reason: string): void {
        if (this.closed !== null) {
            return;
        }
        this.closed = new Error(reason);
        for (const entry of this.awaiting.values()) {
            clearTimeout(entry.timer);
            entry.reject(this.closed);
        }
        this.awaiting.clear();
        this.queue.length = 0;
        if (this.poller !== null) {
            clearTimeout(this.poller.timer);
            this.poller.resolve(null);
            this.poller = null;
        }
        const waiters = this.hello_waiters;
        this.hello_waiters = [];
        for (const waiter of waiters) {
            waiter.reject(this.closed);
        }
    }

    private drop_queued(id: string): void {
        const index = this.queue.findIndex((command) => command.id === id);
        if (index >= 0) {
            this.queue.splice(index, 1);
        }
    }
}
