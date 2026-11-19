// Goal: a dialog an extension opens inside an rpc pi (`extension_ui_request`) reaches the
// bus as `ui_prompt_start`, `POST …/agents/:name/answer` writes pi's `extension_ui_response`
// and ends the prompt, two dialogs at once are answered one after the other, an answer for
// no open prompt is a 409 and one of the wrong kind a 400, and a widget is ignored while a
// `notify` is passed on. Method: a real daemon on port 0 with the fake rpc pi
// (test/fixtures/fake-pi.ts), whose `ask <kind>` prompts raise dialogs and echo the answers.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentPrompt, PiEvent, SpinnerEvent } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "../home.js";
import { start_daemon, type Daemon } from "../server.js";
import { create_session } from "../store/session-store.js";
import { parse_ui_request } from "./pi-rpc.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(here, "..", "..", "test", "fixtures", "fake-pi.ts");

let root: string;
let home: SpinnerHome;
let daemon: Daemon;
let events: SpinnerEvent[];
let route: string;

beforeEach(async () => {
    chmodSync(FAKE_PI, 0o755);
    root = mkdtempSync(join(tmpdir(), "spinner-dialog-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
    mkdirSync(home.root, { recursive: true });
    daemon = await start_daemon({
        home,
        port: 0,
        log: () => undefined,
        poll_seconds: 0,
        notify: async () => undefined,
        ui_dir: null,
        observe_interval_ms: 60_000,
        pi: FAKE_PI,
        extension: null,
        cwd: root,
    });
    events = [];
    daemon.bus.subscribe((event) => events.push(event));
    const summary = create_session(home, { title: "Dialogs" });
    mkdirSync(join(summary.path, "agents", "asker"), { recursive: true });
    writeFileSync(join(summary.path, "agents", "asker", "BRIEF.md"), "# asker\n");
    route = `/sessions/${summary.dir}/agents/asker`;
    const added = await call("POST", `/sessions/${summary.dir}/agents`, { name: "asker" });
    expect(added.status).toBe(201);
    await until(() => events.some((event) => event.type === "agent.settled"));
    events.length = 0;
});

afterEach(async () => {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
});

function call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${daemon.port}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

async function until(check: () => boolean): Promise<void> {
    for (let poll = 0; poll < 500; poll += 1) {
        if (check()) {
            return;
        }
        await new Promise((resolve_) => setTimeout(resolve_, 10));
    }
    throw new Error("condition not met in time");
}

function pi_events(): PiEvent[] {
    return events.flatMap((event) => (event.type === "agent.event" ? [event.event] : []));
}

function prompts(): AgentPrompt[] {
    return pi_events().flatMap((event) => (event.type === "ui_prompt_start" ? [event.prompt] : []));
}

/** The text of the fake's last answer: `echo: <prompt> -> <the responses it received>`. */
function echoed(): string {
    const ends = pi_events().filter((event) => event.type === "message_end");
    return JSON.stringify(ends.at(-1));
}

describe("dialogs of an rpc agent", () => {
    it("shows a confirm, answers it, and ends the prompt", async () => {
        await call("POST", `${route}/prompt`, { text: "ask confirm" });
        await until(() => prompts().length === 1);
        expect(prompts()[0]).toEqual({
            id: "ui-confirm-1",
            kind: "confirm",
            title: "damage-control: rm",
            message: "Allow this once?",
        });
        // The wrong id and the wrong kind change nothing: the prompt still waits.
        const stale = await call("POST", `${route}/answer`, { id: "old", kind: "cancel" });
        expect(stale.status).toBe(409);
        const wrong = { id: "ui-confirm-1", kind: "value", value: "yes" };
        expect((await call("POST", `${route}/answer`, wrong)).status).toBe(400);
        const unknown = await call("POST", `${route}/answer`, { id: "x", kind: "maybe" });
        expect(unknown.status).toBe(400);

        const answer = { id: "ui-confirm-1", kind: "confirm", confirmed: true };
        const answered = await call("POST", `${route}/answer`, answer);
        expect(answered.status).toBe(200);
        await until(() => events.some((event) => event.type === "agent.settled"));
        expect(pi_events()).toContainEqual({ type: "ui_prompt_end", id: "ui-confirm-1" });
        expect(echoed()).toContain(String.raw`{\"id\":\"ui-confirm-1\",\"confirmed\":true}`);
        // Answered once: a second answer finds no prompt.
        expect((await call("POST", `${route}/answer`, answer)).status).toBe(409);
    });

    it("answers a select with one of its options only, and an input with text", async () => {
        await call("POST", `${route}/prompt`, { text: "ask select" });
        await until(() => prompts().length === 1);
        expect(prompts()[0]).toMatchObject({ kind: "select", options: ["red", "green"] });
        const blue = { id: "ui-select-1", kind: "value", value: "blue" };
        expect((await call("POST", `${route}/answer`, blue)).status).toBe(400);
        const green = { id: "ui-select-1", kind: "value", value: "green" };
        expect((await call("POST", `${route}/answer`, green)).status).toBe(200);
        await until(() => events.some((event) => event.type === "agent.settled"));
        expect(echoed()).toContain(String.raw`{\"id\":\"ui-select-1\",\"value\":\"green\"}`);

        events.length = 0;
        await call("POST", `${route}/prompt`, { text: "ask input" });
        await until(() => prompts().length === 1);
        expect(prompts()[0]).toMatchObject({ kind: "input", placeholder: "a name" });
        const cancel = { id: "ui-input-1", kind: "cancel" };
        expect((await call("POST", `${route}/answer`, cancel)).status).toBe(200);
        await until(() => events.some((event) => event.type === "agent.settled"));
        expect(echoed()).toContain(String.raw`{\"id\":\"ui-input-1\",\"cancelled\":true}`);
    });

    it("opens two dialogs one after the other, in pi's order", async () => {
        await call("POST", `${route}/prompt`, { text: "ask two" });
        await until(() => prompts().length === 1);
        expect(prompts()[0]?.title).toBe("first");
        // The second is not the open one yet.
        const early = { id: "ui-two-2", kind: "confirm", confirmed: true };
        expect((await call("POST", `${route}/answer`, early)).status).toBe(409);
        const first = { id: "ui-two-1", kind: "confirm", confirmed: false };
        expect((await call("POST", `${route}/answer`, first)).status).toBe(200);
        await until(() => prompts().length === 2);
        expect(prompts()[1]?.title).toBe("second");
        expect((await call("POST", `${route}/answer`, early)).status).toBe(200);
        await until(() => events.some((event) => event.type === "agent.settled"));
        const order = pi_events()
            .filter((event) => event.type.startsWith("ui_prompt"))
            .map((event) => event.type);
        expect(order).toEqual([
            "ui_prompt_start",
            "ui_prompt_end",
            "ui_prompt_start",
            "ui_prompt_end",
        ]);
        expect(echoed()).toContain(String.raw`\"confirmed\":false} {\"id\":\"ui-two-2\"`);
    });

    it("passes a notify on and ignores a widget", async () => {
        await call("POST", `${route}/prompt`, { text: "ask widget" });
        await until(() => events.some((event) => event.type === "agent.settled"));
        const notes = pi_events().filter((event) => event.type === "ui_notify");
        expect(notes).toEqual([{ type: "ui_notify", message: "blocked", level: "warning" }]);
        expect(prompts()).toEqual([]);
    });
});

describe("parse_ui_request", () => {
    it("cancels a select without options and ignores what the chat cannot show", () => {
        const select = { type: "extension_ui_request", id: "s", method: "select", title: "t" };
        expect(parse_ui_request(select)).toEqual({ kind: "cancel", id: "s" });
        expect(parse_ui_request({ id: "w", method: "setWidget" })).toBeNull();
        expect(parse_ui_request({ id: "t", method: "setTitle", title: "x" })).toBeNull();
        expect(parse_ui_request({ method: "confirm" })).toBeNull();
        expect(parse_ui_request({ id: "c", method: "confirm", timeout: 5000 })).toEqual({
            kind: "dialog",
            prompt: { id: "c", kind: "confirm", title: "confirm" },
            timeout_ms: 5000,
        });
    });
});
