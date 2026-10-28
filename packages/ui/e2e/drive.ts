// Drives the UI in headless Chrome over the DevTools protocol and saves a screenshot per step.
// Usage: node e2e/drive.ts <ui url> <screenshot dir> [flow]. Chrome must already listen on
// port 9333 (`--remote-debugging-port=9333`). The flow `lifecycle` runs: new session, up,
// previews, verify, close. The flow `agents` prompts the first running agent of the first
// session with a pi agent. It works against the fixture server or the real daemon.
import { writeFileSync } from "node:fs";

import { WebSocket } from "ws";

const [uiUrl, outDir, flow = "lifecycle"] = process.argv.slice(2);
if (uiUrl === undefined || outDir === undefined) {
    throw new Error("Usage: drive.ts <ui url> <screenshot dir>");
}
const TIMEOUT_MS = 60_000;

const target = (await (
    await fetch("http://127.0.0.1:9333/json/new?about:blank", { method: "PUT" })
).json()) as { webSocketDebuggerUrl: string };
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => socket.on("open", resolve));

let nextId = 0;
const waiting = new Map<number, (value: Record<string, unknown>) => void>();
socket.on("message", (data) => {
    const text = data.toString();
    const message = JSON.parse(text) as { id?: number; result?: Record<string, unknown> };
    if (message.id !== undefined) {
        waiting.get(message.id)?.(message.result ?? {});
    }
});

function send(method: string, params: object = {}): Promise<Record<string, unknown>> {
    nextId += 1;
    const id = nextId;
    return new Promise((resolve) => {
        waiting.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
    });
}

async function evaluate(expression: string): Promise<unknown> {
    const result = (await send("Runtime.evaluate", { expression, returnByValue: true })) as {
        result?: { value?: unknown };
        exceptionDetails?: { text: string };
    };
    return result.result?.value;
}

async function until(label: string, expression: string): Promise<void> {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
        if ((await evaluate(expression)) === true) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await shot("failure");
    throw new Error(`Timed out waiting for: ${label}`);
}

async function shot(name: string): Promise<void> {
    const result = (await send("Page.captureScreenshot", { format: "png" })) as { data: string };
    writeFileSync(`${outDir}/${name}.png`, Buffer.from(result.data, "base64"));
    console.log(`screenshot ${outDir}/${name}.png`);
}

const click = (selector: string, text = "") =>
    evaluate(`(() => {
        const items = [...document.querySelectorAll(${JSON.stringify(selector)})];
        const el = items.find((e) => e.textContent.includes(${JSON.stringify(text)}));
        if (!el || el.disabled) return false;
        el.click();
        return true;
    })()`);

const fill = (selector: string, value: string) =>
    evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        const proto = el.constructor.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
    })()`);

const text = (selector: string) =>
    `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? "")`;

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
    width: 1500, height: 900, deviceScaleFactor: 1, mobile: false,
});
await send("Page.navigate", { url: uiUrl });
await until("sessions pane", `document.querySelector("[aria-label=Sessions]") !== null`);
await until("daemon connected", `${text(".status")}.includes("open")`);
await shot("01-sessions");

if (flow === "previews") {
    await click(".session", process.env["E2E_SESSION"] ?? "");
    await until("web tab", `document.querySelector(".preview-pane .tab") !== null`);
    await click(".preview-pane .tab", "web");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await shot("04b-web-preview");
    socket.close();
    process.exit(0);
}

if (flow === "history") {
    const session = process.env["E2E_SESSION"] ?? "";
    const listed = text(".session-list");
    await until("session listed", `${listed}.includes(${JSON.stringify(session)})`);
    await click(".session", session);
    await until("history", `document.querySelectorAll(".entry-assistant").length > 0`);
    await shot("12-after-reload");
    const after = await evaluate(`document.querySelector(".transcript").innerText`);
    console.log("transcript after reload:", JSON.stringify(after));
    socket.close();
    process.exit(0);
}

if (flow === "real-agent") {
    // The session must exist and its `agents/scribe/BRIEF.md` must be written first.
    const session = process.env["E2E_SESSION"] ?? "";
    const model = process.env["E2E_MODEL"] ?? "claude-haiku-4-5";
    const prompt = process.env["E2E_PROMPT"] ?? "Read the brief and reply with one line.";
    await click(".session", session);
    const agent = process.env["E2E_AGENT"] ?? "scribe";
    await fill("input[aria-label='Agent name']", agent);
    await evaluate(`(() => {
        const select = document.querySelector("select[aria-label=Model]");
        const wanted = ${JSON.stringify(model)};
        const option = [...select.options].find((o) => o.value.includes(wanted));
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
        setter.call(select, option.value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    })()`);
    const repo = process.env["E2E_REPO"];
    if (repo !== undefined) {
        await evaluate(`(() => {
            const select = document.querySelector("select[aria-label=Repo]");
            const proto = HTMLSelectElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
            setter.call(select, ${JSON.stringify(repo)});
            select.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
        })()`);
    }
    await shot("09-add-agent");
    if (process.env["E2E_SKIP_ADD"] === undefined) {
        await click("form[aria-label='Add agent'] button");
    }
    const tabs = text(".agents-pane .tabs");
    await until("agent tab", `${tabs}.includes(${JSON.stringify(agent)})`);
    await click(".agents-pane .tab", agent);
    await until(
        "prompt enabled",
        `document.querySelector("input[aria-label=Prompt]")?.disabled === false`,
    );
    await fill("input[aria-label=Prompt]", prompt);
    await click(".prompt-form button[type=submit]");
    await until("answer streams", `document.querySelectorAll(".entry-assistant").length > 0`);
    await shot("10-agent-streaming");
    const pane = text(".agent-status");
    await until("agent settled", `${pane}.includes("idle ·")`);
    await shot("11-agent-done");
    const before = await evaluate(`document.querySelector(".transcript").innerText`);
    console.log("transcript before reload:", JSON.stringify(before));
    await send("Page.reload");
    const listed = text(".session-list");
    await until("session listed", `${listed}.includes(${JSON.stringify(session)})`);
    await click(".session", session);
    await until("history", `document.querySelectorAll(".entry-assistant").length > 0`);
    await shot("12-after-reload");
    const after = await evaluate(`document.querySelector(".transcript").innerText`);
    console.log("transcript after reload:", JSON.stringify(after));
    socket.close();
    process.exit(0);
}

if (flow === "agents") {
    await click(".session", "Refund flow");
    await until("agent tab", `document.querySelector(".agents-pane .tab") !== null`);
    await fill("input[aria-label=Prompt]", "say hello");
    await click(".prompt-form button[type=submit]");
    await until("tool call shown", `${text(".transcript")}.includes("bash")`);
    await shot("07-agent-working");
    await until("answer shown", `${text(".transcript")}.includes("Done: say hello")`);
    await until("agent idle", `${text(".agents-pane")}.includes("idle ·")`);
    await shot("08-agent-done");
    console.log("agents ok");
    socket.close();
    process.exit(0);
}

const title = `E2E ${Date.now() % 100000}`;
await fill("[aria-label='New session title']", title);
const project = process.env["E2E_PROJECT"] ?? "sample-stack";
await evaluate(`(() => {
    const select = document.querySelector("form[aria-label='New session'] select");
    const option = [...select.options].find((o) => o.textContent === ${JSON.stringify(project)});
    if (!option) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(select, option.value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
})()`);
await click("form[aria-label='New session'] button");
const quoted = JSON.stringify(title);
await until("new session selected", `${text(".session-selected")}.includes(${quoted})`);
await shot("02-new-session");

await until(
    "run local enabled",
    `[...document.querySelectorAll(".actions button")]
        .some((b) => b.textContent === "run local" && !b.disabled)`,
);
await click(".actions button", "run local");
await until("job log shows", `${text(".drawer")}.includes("up")`);
await shot("03-up-running");
await until(
    "service healthy",
    `[...document.querySelectorAll(".services tbody tr")]
        .some((r) => r.innerText.includes("healthy"))`,
);
await click(".preview-pane .tab", "web");
await new Promise((resolve) => setTimeout(resolve, 1500));
await until("preview frame", `document.querySelector(".preview-frame") !== null`);
await until("job finished", `${text(".drawer")}.includes("ok")`);
await shot("04-previews");

await until("verify enabled", `document.querySelector(".verified input")?.disabled === false`);
await click(".verified input");
await until("verified ticked", `document.querySelector(".verified input")?.checked === true`);
await shot("05-verified");

await click(".actions button", "close");
await until("session gone", `!${text(".sessions-pane")}.includes(${quoted})`);
await shot("06-closed");
console.log("lifecycle ok");
socket.close();
