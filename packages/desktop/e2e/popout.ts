// Drives the running desktop app through the pop-out flow over the DevTools protocol and the
// bridge itself (`window.spinnerDesktop`), so it does not need the UI's buttons. Start the app
// with `electron . --remote-debugging-port=<port>` first, then:
//   E2E_CDP_PORT=<port> E2E_INSPECT_PORT=<port> E2E_APP_PID=<pid> E2E_WINPID=<helper> \
//       node e2e/popout.ts <shot dir>
// `E2E_INSPECT_PORT` is the app's `--inspect=<port>`: the driver closes the preview's pop-out
// window from the main process, which is the close button's path (`BaseWindow.close()` and
// the button both raise the `close` event). Without it that step is skipped.
// The flow: new session on the sample stack, run local, the web tab, pop the web preview out,
// dock it back, pop it out and close its window, pop the agents pane out as a page and close
// it, dock a second one back by call, and close the session with a pop-out open. The checks:
// the preview's CDP target id and a hash set in the page survive every move (no reload), the
// view's inner size follows the pop-out window, `panes.list()` and the `pane.docked` events
// tell the renderer the truth. `E2E_WINPID` is a helper that prints `<CGWindowNumber>\t<title>`
// per on-screen window of `E2E_APP_PID` (see MISSION Log); without it no screenshots.
import { execFileSync } from "node:child_process";
import { Page, sleep, target_with, targets, text } from "./cdp.ts";

const [out_dir] = process.argv.slice(2);
if (out_dir === undefined) {
    throw new Error("Usage: popout.ts <screenshot dir>");
}
const APP_PID = process.env["E2E_APP_PID"];
const INSPECT_PORT = process.env["E2E_INSPECT_PORT"];
const WINPID = process.env["E2E_WINPID"];
const DAEMON_URL = process.env["E2E_DAEMON_URL"] ?? "http://127.0.0.1:7777";
const PROJECT = process.env["E2E_PROJECT"] ?? "sample";

/** One capture per window of the app, named by step and window title. */
function shot(step: string): void {
    if (APP_PID === undefined || WINPID === undefined) {
        return;
    }
    const lines = execFileSync(WINPID, [APP_PID], { encoding: "utf8" }).trim().split("\n");
    for (const line of lines.filter((l) => l !== "")) {
        const [number, title] = line.split("\t");
        const slug = (title ?? "window").replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
        const path = `${out_dir}/${step}-${slug}.png`;
        execFileSync("screencapture", ["-x", "-o", "-l", String(number), path]);
        console.log(`screenshot ${path}`);
    }
}

function expect(label: string, ok: boolean, detail: string): void {
    console.log(`${label}: ${detail} ${ok ? "ok" : "FAIL"}`);
    if (!ok) {
        shot("failure");
        throw new Error(label);
    }
}

interface Size {
    width: number;
    height: number;
}

/** Runs `expression` in the app's main process over the Node inspector; `electron` is in scope. */
async function in_main(expression: string): Promise<unknown> {
    const list = (await (await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`)).json()) as {
        webSocketDebuggerUrl: string;
    }[];
    const first = list[0];
    if (first === undefined) {
        throw new Error("no inspector target");
    }
    const socket = new WebSocket(first.webSocketDebuggerUrl);
    await new Promise((resolve) => socket.addEventListener("open", resolve));
    const prelude =
        `const require = process.getBuiltinModule("module").createRequire(process.cwd() + "/");` +
        ` const electron = require("electron");`;
    const result = await new Promise<Record<string, unknown>>((resolve) => {
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
            if (message.id === 1) {
                resolve(message.result as Record<string, unknown>);
            }
        });
        socket.send(JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: {
                expression: `(() => { ${prelude} return (${expression}); })()`,
                returnByValue: true,
            },
        }));
    });
    socket.close();
    const value = result["result"] as { value?: unknown } | undefined;
    return value?.value;
}

async function inner_size(prefix: string): Promise<{ id: string; size: Size; hash: string }> {
    const target = await target_with(prefix);
    const page = await Page.open(target);
    const value = (await page.evaluate(
        `({ width: window.innerWidth, height: window.innerHeight, hash: location.hash })`,
    )) as Size & { hash: string };
    page.close();
    return { id: target.id, size: { width: value.width, height: value.height }, hash: value.hash };
}

const ui_target = (await targets()).find((t) => t.url.startsWith(DAEMON_URL));
if (ui_target === undefined) {
    throw new Error(`no CDP target at ${DAEMON_URL}; is the app running with the port?`);
}
const ui = await Page.open(ui_target, () => shot("failure"));
await ui.until("sessions pane", `document.querySelector("[aria-label=Sessions]") !== null`);
await ui.until("daemon connected", `${text(".status")}.includes("open")`);
expect("bridge", (await ui.evaluate(`typeof window.spinnerDesktop`)) === "object", "on page");
await ui.evaluate(`(() => {
    window.__docked = [];
    window.spinnerDesktop.panes.subscribe((event) => window.__docked.push(event));
    return true;
})()`);
const bridge = (call: string) => ui.evaluate(`window.spinnerDesktop.${call}`);
const docked = () => ui.evaluate(`window.__docked`) as Promise<Record<string, unknown>[]>;
const listed = () => bridge("panes.list()") as Promise<Record<string, unknown>[]>;

const title = `Desktop popout ${Date.now() % 100000}`;
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

await ui.until(
    "run local enabled",
    `[...document.querySelectorAll(".actions button")]
        .some((b) => b.textContent === "run local" && !b.disabled)`,
);
await ui.click(".actions button", "run local");
await ui.until(
    "web healthy",
    `[...document.querySelectorAll(".services tbody tr")]
        .some((r) => r.innerText.includes("web") && r.innerText.includes("healthy"))`,
);
await ui.until("job finished", `${text(".drawer")}.includes("ok")`);
await ui.click(".drawer button", "close");

const web_url = `http://web.${id}.localhost`;
const key = `${dir}/web`;
await ui.click(".preview-pane .tab", "web");
await ui.until("box rendered", `document.querySelector(".preview-box") !== null`);
await sleep(2500);
await ui.click(".preview-bar button", "reload");
await sleep(2000);
const before = await inner_size(web_url);
{
    const page = await Page.open(await target_with(web_url));
    await page.evaluate(`(location.hash = "#kept", true)`);
    page.close();
}
shot("20-docked");

// Pop out: same target, same hash, the view fills a window of at least the minimum size.
await bridge(`previews.popOut(${JSON.stringify(key)})`);
await sleep(1500);
const popped = await inner_size(web_url);
expect("pop out keeps the page", popped.id === before.id && popped.hash === "#kept",
    `target ${popped.id} hash ${popped.hash}`);
expect("pop out window size", popped.size.width >= 480 && popped.size.height >= 360,
    `${popped.size.width}x${popped.size.height}` +
        ` (docked ${before.size.width}x${before.size.height})`);
let list = await listed();
expect("panes.list has the preview", JSON.stringify(list) ===
    JSON.stringify([{ pane: "previews", session: dir, key }]), JSON.stringify(list));
shot("21-popped-out");

// Dock back by call: one event, the view goes back hidden; a tab switch places it again.
await bridge(`previews.dockBack(${JSON.stringify(key)})`);
await sleep(1000);
let events = await docked();
expect("dockBack sends pane.docked", JSON.stringify(events) ===
    JSON.stringify([{ type: "docked", pane: "previews", session: dir, key }]),
    JSON.stringify(events));
expect("panes.list empty after dockBack", (await listed()).length === 0, "");
await ui.click(".preview-pane .tab", "api");
await sleep(800);
await ui.click(".preview-pane .tab", "web");
await sleep(1500);
const back = await inner_size(web_url);
const box = (await ui.evaluate(`(() => {
    const r = document.querySelector(".preview-box").getBoundingClientRect();
    return { width: Math.round(r.width), height: Math.round(r.height) };
})()`)) as Size;
expect("docked view keeps the page", back.id === before.id && back.hash === "#kept",
    `target ${back.id} hash ${back.hash}`);
expect("docked view fits the box",
    Math.abs(back.size.width - box.width) <= 1 && Math.abs(back.size.height - box.height) <= 1,
    `view ${back.size.width}x${back.size.height} box ${box.width}x${box.height}`);
shot("22-docked-again");

// The close button's path: the main process closes the pop-out window itself.
await bridge(`previews.popOut(${JSON.stringify(key)})`);
await sleep(1500);
expect("second pop out", (await listed()).length === 1, "");
let closed_by_button = false;
if (INSPECT_PORT !== undefined) {
    const closed = await in_main(`(() => {
        const found = electron.BaseWindow.getAllWindows()
            .find((w) => w.getTitle().startsWith(${JSON.stringify(key)}));
        if (found === undefined) return false;
        found.close();
        return true;
    })()`);
    expect("pop-out window found in main", closed === true, String(closed));
    closed_by_button = true;
} else {
    console.log("close button skipped: no E2E_INSPECT_PORT");
}
if (closed_by_button) {
    await sleep(1000);
    events = await docked();
    expect("close button docks back", events.length === 2 && events[1]?.["key"] === key,
        JSON.stringify(events.at(-1)));
    const after_close = await inner_size(web_url);
    const kept = after_close.id === before.id && after_close.hash === "#kept";
    expect("closed window kept the page", kept, `target ${after_close.id}`);
} else {
    await bridge(`previews.dockBack(${JSON.stringify(key)})`);
    await sleep(500);
}

// The agents pane as a page: its own window on the `?pane=` route, with the bridge.
await bridge(`panes.popOut("agents", ${JSON.stringify(dir)})`);
const pane_url = `${DAEMON_URL}/?pane=agents&session=${dir}`;
const pane_target = await target_with(pane_url);
const pane_page = await Page.open(pane_target);
expect("pane window has the bridge",
    (await pane_page.evaluate(`typeof window.spinnerDesktop`)) === "object", pane_target.url);
list = await listed();
expect("panes.list has the pane", list.some((p) => p["pane"] === "agents" && p["session"] === dir),
    JSON.stringify(list));
await sleep(1500);
shot("23-agents-pane");
// `window.close()` from the page is the close button's path: `closed` fires `on_closed`.
await pane_page.evaluate(`(setTimeout(() => window.close(), 50), true)`);
pane_page.close();
await sleep(1500);
events = await docked();
expect("closed pane window sends pane.docked", JSON.stringify(events.at(-1)) ===
    JSON.stringify({ type: "docked", pane: "agents", session: dir }),
    JSON.stringify(events.at(-1)));
expect("pane target gone", !(await targets()).some((t) => t.url === pane_url), "");

await bridge(`panes.popOut("agents", ${JSON.stringify(dir)})`);
await target_with(pane_url);
const before_dock = (await docked()).length;
await bridge(`panes.dockBack("agents", ${JSON.stringify(dir)})`);
await sleep(1000);
events = await docked();
expect("panes.dockBack sends one event", events.length === before_dock + 1
    && events.at(-1)?.["pane"] === "agents", JSON.stringify(events.at(-1)));
expect("pane target gone after dockBack", !(await targets()).some((t) => t.url === pane_url), "");

// Close the session with the web preview popped out: its window goes, the renderer hears it.
await bridge(`previews.popOut(${JSON.stringify(key)})`);
await sleep(1000);
await ui.click(".actions button", "close");
await ui.until("session gone", `!${text(".sessions-pane")}.includes(${quoted})`);
await sleep(1500);
const leftover = (await targets()).filter((t) => t.url.includes(`.${id}.localhost`));
expect("views gone with the session", leftover.length === 0, `${leftover.length} left`);
events = await docked();
expect("session close sends pane.docked", events.at(-1)?.["key"] === key,
    JSON.stringify(events.at(-1)));
expect("panes.list empty at the end", (await listed()).length === 0, "");
shot("24-closed");
console.log(`pane.docked events: ${events.length}`);
console.log("popout flow ok");
ui.close();
process.exit(0);
