// Drives the running desktop app over the DevTools protocol and saves a window screenshot per
// step. Start the app with `electron . --remote-debugging-port=<port>` first, then:
//   E2E_CDP_PORT=<port> E2E_WINDOW_ID=<CGWindowNumber> node e2e/drive.ts <screenshot dir>
// The flow: new session on the sample stack, run local, each preview tab, a pane drag, a
// window resize, the hidden tab's state, verify, close. After every geometry step it compares
// the renderer's box with the preview view's own `innerWidth`/`innerHeight`: the view is a
// separate CDP target, so the check sees both sides. `E2E_WINDOW_ID` comes from
// `CGWindowListCopyWindowInfo` (see MISSION Log for the helper); without it no screenshots.
import { execFileSync } from "node:child_process";

const [out_dir] = process.argv.slice(2);
if (out_dir === undefined) {
    throw new Error("Usage: drive.ts <screenshot dir>");
}
const CDP_PORT = process.env["E2E_CDP_PORT"] ?? "9345";
const WINDOW_ID = process.env["E2E_WINDOW_ID"];
const DAEMON_URL = process.env["E2E_DAEMON_URL"] ?? "http://127.0.0.1:7777";
/** The `name:` of the spec, `sample` for `examples/sample-stack`. */
const PROJECT = process.env["E2E_PROJECT"] ?? "sample";
const TIMEOUT_MS = 300_000;

interface Target {
    id: string;
    url: string;
    webSocketDebuggerUrl: string;
}

async function targets(): Promise<Target[]> {
    return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as Target[];
}

class Page {
    private next_id = 0;
    private readonly waiting = new Map<number, (value: Record<string, unknown>) => void>();

    private readonly socket: WebSocket;

    private constructor(socket: WebSocket) {
        this.socket = socket;
    }

    static async open(target: Target): Promise<Page> {
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve) => socket.addEventListener("open", resolve));
        const page = new Page(socket);
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data)) as {
                id?: number;
                result?: Record<string, unknown>;
            };
            if (message.id !== undefined) {
                page.waiting.get(message.id)?.(message.result ?? {});
            }
        });
        return page;
    }

    send(method: string, params: object = {}): Promise<Record<string, unknown>> {
        this.next_id += 1;
        const id = this.next_id;
        return new Promise((resolve) => {
            this.waiting.set(id, resolve);
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    async evaluate(expression: string): Promise<unknown> {
        const result = (await this.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
        })) as { result?: { value?: unknown }; exceptionDetails?: { text: string } };
        if (result.exceptionDetails !== undefined) {
            throw new Error(`evaluate failed: ${result.exceptionDetails.text}: ${expression}`);
        }
        return result.result?.value;
    }

    async until(label: string, expression: string, timeout_ms = TIMEOUT_MS): Promise<void> {
        const deadline = Date.now() + timeout_ms;
        while (Date.now() < deadline) {
            if ((await this.evaluate(expression)) === true) {
                return;
            }
            await sleep(200);
        }
        shot("failure");
        throw new Error(`Timed out waiting for: ${label}`);
    }

    click(selector: string, text = ""): Promise<unknown> {
        return this.evaluate(`(() => {
            const items = [...document.querySelectorAll(${JSON.stringify(selector)})];
            const el = items.find((e) => e.textContent.includes(${JSON.stringify(text)}));
            if (!el || el.disabled) return false;
            el.click();
            return true;
        })()`);
    }

    fill(selector: string, value: string): Promise<unknown> {
        return this.evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            const proto = el.constructor.prototype;
            Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
            el.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
        })()`);
    }

    close(): void {
        this.socket.close();
    }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function shot(name: string): void {
    if (WINDOW_ID === undefined) {
        return;
    }
    const path = `${out_dir}/${name}.png`;
    execFileSync("screencapture", ["-x", "-o", "-l", WINDOW_ID, path]);
    console.log(`screenshot ${path}`);
}

const text = (selector: string) =>
    `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? "")`;

interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

async function box(ui: Page): Promise<Box> {
    return (await ui.evaluate(`(() => {
        const r = document.querySelector(".preview-box").getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top),
                 width: Math.round(r.width), height: Math.round(r.height) };
    })()`)) as Box;
}

/** The preview target whose URL starts with `prefix`, opened as a page. */
async function preview_page(prefix: string): Promise<{ page: Page; target: Target }> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        const found = (await targets()).find((t) => t.url.startsWith(prefix));
        if (found !== undefined) {
            return { page: await Page.open(found), target: found };
        }
        await sleep(300);
    }
    throw new Error(`no CDP target for ${prefix}`);
}

/**
 * The view's inner size must equal the renderer's box, within 1 px of rounding. A view whose
 * page is hidden (the window is behind another) does not lay out, so its size is stale; the
 * check is then skipped and the main process's `bounds` debug line is the evidence.
 */
async function check_geometry(ui: Page, label: string, prefix: string): Promise<void> {
    await sleep(400);
    const expected = await box(ui);
    const { page, target } = await preview_page(prefix);
    const inner = (await page.evaluate(
        `({ width: window.innerWidth, height: window.innerHeight,
            visibility: document.visibilityState })`,
    )) as { width: number; height: number; visibility: string };
    page.close();
    const width_ok = Math.abs(inner.width - expected.width) <= 1;
    const height_ok = Math.abs(inner.height - expected.height) <= 1;
    const ok = width_ok && height_ok;
    const verdict = ok ? "ok" : inner.visibility === "hidden" ? "occluded, skipped" : "MISMATCH";
    console.log(
        `${label}: box ${JSON.stringify(expected)} view ${inner.width}x${inner.height}` +
            ` (${target.url}) ${verdict}`,
    );
    if (verdict === "MISMATCH") {
        throw new Error(`${label}: view size does not match the box`);
    }
}

const ui_target = (await targets()).find((t) => t.url.startsWith(DAEMON_URL));
if (ui_target === undefined) {
    throw new Error(`no CDP target at ${DAEMON_URL}; is the app running with the port?`);
}
const ui = await Page.open(ui_target);
await ui.until("sessions pane", `document.querySelector("[aria-label=Sessions]") !== null`);
await ui.until("daemon connected", `${text(".status")}.includes("open")`);
const bridge = await ui.evaluate(`typeof window.spinnerDesktop`);
console.log(`window.spinnerDesktop: ${String(bridge)}`);
if (bridge !== "object") {
    throw new Error("the bridge is not on the page");
}
shot("10-launch");

const title = `Desktop E2E ${Date.now() % 100000}`;
await ui.fill("[aria-label='New session title']", title);
const picked = await ui.evaluate(`(() => {
    const select = document.querySelector("form[aria-label='New session'] select");
    const option = [...select.options].find((o) => o.textContent === ${JSON.stringify(PROJECT)});
    if (!option) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(select, option.value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
})()`);
if (picked !== true) {
    throw new Error(`no project named ${PROJECT} in the new-session form`);
}
await ui.click("form[aria-label='New session'] button");
const quoted = JSON.stringify(title);
await ui.until("new session selected", `${text(".session-selected")}.includes(${quoted})`);
const dir = (await ui.evaluate(
    `document.querySelector(".session-selected")?.innerText.match(/s\\d+-[a-z0-9-]+/)?.[0]`,
)) as string | undefined;
if (dir === undefined) {
    throw new Error("could not read the new session's dir from the pane");
}
const id = dir.split("-")[0];
console.log(`session ${dir}`);
shot("11-new-session");

await ui.until(
    "run local enabled",
    `[...document.querySelectorAll(".actions button")]
        .some((b) => b.textContent === "run local" && !b.disabled)`,
);
await ui.click(".actions button", "run local");
await ui.until("job log shows", `${text(".drawer")}.includes("up")`);
await ui.until(
    "web healthy",
    `[...document.querySelectorAll(".services tbody tr")]
        .some((r) => r.innerText.includes("web") && r.innerText.includes("healthy"))`,
);
await ui.until("job finished", `${text(".drawer")}.includes("ok")`);
await ui.click(".drawer button", "close");

const web_url = `http://web.${id}.localhost`;
await ui.click(".preview-pane .tab", "web");
await ui.until("box rendered", `document.querySelector(".preview-box") !== null`);
await ui.until("no iframe", `document.querySelector("iframe") === null`);
// The proxy picks up a new route a moment after the service is healthy; reload like a user.
await sleep(2500);
await ui.click(".preview-bar button", "reload");
await sleep(2000);
await check_geometry(ui, "web tab", web_url);
shot("12-web");

// Leave a mark in the web page, so the hidden tab's state can be checked after a switch.
{
    const { page, target } = await preview_page(web_url);
    await page.evaluate(`(location.hash = "#kept", true)`);
    page.close();
    console.log(`web view target ${target.id}`);
    (globalThis as { web_target_id?: string }).web_target_id = target.id;
}

await ui.click(".preview-pane .tab", "api");
await check_geometry(ui, "api tab", `http://api.${id}.localhost`);
shot("13-api");

await ui.click(".preview-pane .tab", "temporal");
await sleep(3000);
await check_geometry(ui, "temporal tab", `http://temporal.${id}.localhost`);
shot("14-temporal");

// Drag the preview pane's handle 150 px to the left: the pane widens, the view with it.
const before_drag = await box(ui);
const handle = (await ui.evaluate(`(() => {
    const r = document.querySelectorAll(".handle")[1].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 300 };
})()`)) as { x: number; y: number };
const mouse = (type: string, x: number) =>
    ui.send("Input.dispatchMouseEvent", { type, x, y: handle.y, button: "left", buttons: 1 });
await mouse("mousePressed", handle.x);
for (let step = 1; step <= 10; step += 1) {
    await mouse("mouseMoved", handle.x - step * 15);
    await sleep(30);
}
await mouse("mouseReleased", handle.x - 150);
await ui.until(
    "box wider",
    `document.querySelector(".preview-box").getBoundingClientRect().width` +
        ` > ${before_drag.width + 100}`,
);
await check_geometry(ui, "after drag", `http://temporal.${id}.localhost`);
shot("15-dragged");

// Resize the window through System Events; the renderer's ResizeObserver must follow. Only
// with `E2E_RESIZE=1`: it touches the operator's screen and needs the Accessibility
// permission. The preview pane keeps its width, so the box gets shorter, not narrower.
if (process.env["E2E_RESIZE"] === "1") {
    const before_resize = await box(ui);
    const resize = (width: number, height: number) =>
        execFileSync("osascript", [
            "-e",
            `tell application "System Events" to set size of window 1 of process "Electron"` +
                ` to {${width}, ${height}}`,
        ]);
    resize(1200, 800);
    await ui.until(
        "box shorter",
        `document.querySelector(".preview-box").getBoundingClientRect().height` +
            ` < ${before_resize.height}`,
    );
    await check_geometry(ui, "after window resize", `http://temporal.${id}.localhost`);
    shot("16-window-resized");
    resize(1440, 900);
    await sleep(500);
}

// Back to web: the same view, with the hash still set.
await ui.click(".preview-pane .tab", "web");
await check_geometry(ui, "web again", web_url);
{
    const { page, target } = await preview_page(web_url);
    const hash = await page.evaluate(`location.hash`);
    page.close();
    const same = target.id === (globalThis as { web_target_id?: string }).web_target_id;
    console.log(`web view kept: same target ${String(same)}, hash ${String(hash)}`);
    if (!same || hash !== "#kept") {
        throw new Error("the hidden web view lost its state");
    }
}
shot("17-web-kept");

await ui.until("verify enabled", `document.querySelector(".verified input")?.disabled === false`);
await ui.click(".verified input");
await ui.until("verified ticked", `document.querySelector(".verified input")?.checked === true`);
shot("18-verified");

await ui.click(".actions button", "close");
await ui.until("session gone", `!${text(".sessions-pane")}.includes(${quoted})`);
await sleep(1500);
const leftover = (await targets()).filter((t) => t.url.includes(`.${id}.localhost`));
console.log(`views left for ${id}: ${leftover.length}`);
if (leftover.length !== 0) {
    throw new Error("the closed session's views are still alive");
}
shot("19-closed");
console.log("desktop flow ok");
ui.close();
process.exit(0);
