// Delivers what agents write to each other (docs/SESSION_PROTOCOL.md, "Messages" and
// "Change propagation"). An `inbox/` file for a running agent becomes a steer; for an idle or
// stopped agent it waits for its next prompt in the manager; for `operator` it becomes a Log
// line and an `inbox.message` event. A change to `MISSION.md` or to an agent's `NOTES.md`
// becomes one debounced steer per other agent, at most one per 30 s per agent, that names the
// sections that changed. Every delivery publishes `message.delivered`.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeliveryKind, SessionSummary } from "@spinner/protocol";
import type { EventBus } from "../event-bus.js";
import type { SpinnerHome } from "../home.js";
import { read_session } from "../store/session-store.js";
import type { MissionWriter } from "../store/mission-writer.js";
import { describe_changes, diff_mission } from "../watch/mission-diff.js";
import { parse_inbox_file } from "./inbox.js";
import type { AgentManager } from "./manager.js";

/** The protocol's bound: one change steer per agent per 30 s. */
export const STEER_INTERVAL_MS = 30_000;

/** A write through the mission route within this window is the author of the file change. */
const ATTRIBUTION_WINDOW_MS = 2_000;

/** Upper bound on change lines waiting in one agent's debounce. */
const NOTICES_MAX = 200;

/** Upper bound on delivered file names kept; a daemon restart forgets them, which is fine. */
const DELIVERED_MAX = 100_000;

export interface DelivererOptions {
    now?: () => Date;
    log?: (line: string) => void;
}

interface Debounce {
    last_sent_at: number;
    lines: string[];
    timer: ReturnType<typeof setTimeout> | null;
}

export class Deliverer {
    private readonly snapshots = new Map<string, string>();
    private readonly debounces = new Map<string, Debounce>();
    /** `<dir>/<file>` already delivered: the route delivers at once, the watcher sees it later. */
    private readonly delivered = new Set<string>();
    private readonly now: () => Date;
    private readonly log: (line: string) => void;

    constructor(
        private readonly home: SpinnerHome,
        private readonly agents: AgentManager,
        private readonly writer: MissionWriter,
        private readonly bus: EventBus,
        options: DelivererOptions = {},
    ) {
        this.now = options.now ?? (() => new Date());
        this.log = options.log ?? (() => undefined);
    }

    /** Remembers the current MISSION.md of every session, so the first change has a baseline. */
    prime(dirs: readonly string[]): void {
        for (const dir of dirs) {
            const file = join(this.home.sessions, dir, "MISSION.md");
            if (existsSync(file)) {
                this.snapshots.set(dir, readFileSync(file, "utf8"));
            }
        }
    }

    /** Delivers `inbox/<file>` of session `dir` once. Files that are not messages are skipped. */
    async deliver_inbox(dir: string, file: string): Promise<void> {
        const key = `${dir}/${file}`;
        if (this.delivered.has(key)) {
            return;
        }
        assert.ok(this.delivered.size < DELIVERED_MAX, "too many delivered files remembered");
        this.delivered.add(key);
        const summary = this.summary(dir);
        if (summary === null) {
            return;
        }
        const message = parse_inbox_file(summary.path, file, this.agent_names(summary));
        if (message === null) {
            this.log(`inbox ${dir}/${file}: not a message file, ignored`);
            return;
        }
        const text = [
            `Message from ${message.from} (inbox/${message.file}): ${message.subject}`,
            "",
            message.body,
        ].join("\n");
        if (message.to === "operator") {
            await this.writer.write(dir, {
                section: "log",
                mode: "append",
                text: `→ operator: ${message.subject}`,
                author: message.from,
            });
            const ts = this.now().toISOString();
            const fields = message_fields(message);
            this.bus.publish({ type: "inbox.message", ts, session: dir, ...fields });
            this.published(dir, file, "operator", "log");
            return;
        }
        const recipients =
            message.to === "all"
                ? this.agent_names(summary).filter((name) => name !== message.from)
                : [message.to];
        for (const agent of recipients) {
            const how = await this.send(dir, agent, text);
            this.published(dir, file, agent, how);
        }
    }

    /**
     * `MISSION.md` of `dir` changed on disk: one notice to every agent but the author. The
     * first sight of a file (a new session, or a session that predates the daemon's start)
     * is a baseline, not a change.
     */
    on_mission_change(dir: string): void {
        const summary = this.summary(dir);
        if (summary === null) {
            return;
        }
        const file = join(summary.path, "MISSION.md");
        if (!existsSync(file)) {
            return;
        }
        const after = readFileSync(file, "utf8");
        const before = this.snapshots.get(dir);
        this.snapshots.set(dir, after);
        if (before === undefined) {
            return;
        }
        const changes = diff_mission(before, after);
        if (changes.length === 0) {
            return;
        }
        const last = this.writer.last_write(dir);
        const known =
            last !== null && this.now().getTime() - last.at <= ATTRIBUTION_WINDOW_MS ? last : null;
        const author = known?.author ?? "unknown";
        const described = describe_changes(changes, known !== null);
        const line = `MISSION.md changed by ${author}: ${described}.`;
        if (known === null) {
            // A hand edit: the event tells the UI what changed, as the route does for a tool write.
            this.bus.publish({
                type: "mission.changed",
                ts: this.now().toISOString(),
                session: dir,
                author,
                sections: changes.map((change) => change.section),
            });
        }
        for (const agent of this.agent_names(summary)) {
            if (agent !== author) {
                this.notice(dir, agent, line);
            }
        }
    }

    /** `agents/<agent>/NOTES.md` changed: the other agents hear that the row's long form moved. */
    on_notes_change(dir: string, agent: string): void {
        const summary = this.summary(dir);
        if (summary === null) {
            return;
        }
        for (const other of this.agent_names(summary)) {
            if (other !== agent) {
                this.notice(dir, other, `agents/${agent}/NOTES.md changed.`);
            }
        }
    }

    /** Sends what waits in every debounce and stops the timers, for daemon shutdown. */
    close(): void {
        for (const [key, state] of this.debounces) {
            if (state.timer !== null) {
                clearTimeout(state.timer);
                state.timer = null;
            }
            state.lines = [];
            this.debounces.delete(key);
        }
    }

    /** Queues a change line for the agent and sends when the 30 s window allows. */
    private notice(dir: string, agent: string, line: string): void {
        const key = `${dir}/${agent}`;
        const state = this.debounces.get(key) ?? { last_sent_at: 0, lines: [], timer: null };
        this.debounces.set(key, state);
        assert.ok(state.lines.length < NOTICES_MAX, `${NOTICES_MAX} notices wait for ${agent}`);
        if (!state.lines.includes(line)) {
            state.lines.push(line);
        }
        if (state.timer !== null) {
            return;
        }
        const wait = state.last_sent_at + STEER_INTERVAL_MS - this.now().getTime();
        if (wait <= 0) {
            void this.flush(dir, agent, state);
            return;
        }
        state.timer = setTimeout(() => {
            state.timer = null;
            void this.flush(dir, agent, state);
        }, wait);
    }

    private async flush(dir: string, agent: string, state: Debounce): Promise<void> {
        if (state.lines.length === 0) {
            return;
        }
        const text = [...state.lines, "Re-read `.spinner/MISSION.md` before your next edit."].join(
            "\n",
        );
        state.lines = [];
        state.last_sent_at = this.now().getTime();
        const how = await this.send(dir, agent, text);
        this.published(dir, null, agent, how);
    }

    /** A steer to a busy agent; otherwise the text waits for the agent's next prompt. */
    private async send(dir: string, agent: string, text: string): Promise<DeliveryKind> {
        const handle = this.agents.get(dir, agent);
        if (handle !== null && this.agents.is_busy(dir, agent)) {
            try {
                await handle.steer(text);
                return "steer";
            } catch (error) {
                this.log(`steer to ${agent} failed, queued for its next prompt: ${String(error)}`);
            }
        }
        this.agents.queue_for_next_prompt(dir, agent, text);
        return "prompt";
    }

    private published(dir: string, file: string | null, agent: string, how: DeliveryKind): void {
        this.bus.publish({
            type: "message.delivered",
            ts: this.now().toISOString(),
            session: dir,
            file,
            agent,
            how,
        });
    }

    private summary(dir: string): SessionSummary | null {
        const read = read_session(this.home, dir);
        return read.ok ? read.summary : null;
    }

    /** The agents `session.yaml` lists plus the ones running, sorted. */
    private agent_names(summary: SessionSummary): string[] {
        const names = new Set(Object.keys(summary.session.agents ?? {}));
        for (const name of this.agents.running(summary.dir)) {
            names.add(name);
        }
        return [...names].sort();
    }
}

function message_fields(message: { file: string; from: string; to: string; subject: string }) {
    return { file: message.file, from: message.from, to: message.to, subject: message.subject };
}
