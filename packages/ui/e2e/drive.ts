// Drives the UI in headless Chrome over the DevTools protocol and saves a screenshot per step.
// Usage: node e2e/drive.ts <ui url> <screenshot dir> [flow]. Chrome must already listen on
// port 9333 (`--remote-debugging-port=9333`) or on `E2E_CDP_PORT`. The flow `lifecycle` runs:
// new session, up, previews, verify, untick, verify, close. The flow `agents` prompts the first
// running agent of the first session with a pi agent. The flow `panes` collapses, hides,
// restores, expands and opens the `?pane=` route; `bridge-popout` docks the desktop's
// popped-out windows back through a stub of the bridge. The flow `terminal` attaches a tty
// agent's terminal to the fixture's echo pty, types, resizes and opens the pane route; `drawer`
// drags, collapses and restores the job drawer under it; `narrow` shrinks the window to 900, 600
// and 440 px and checks the fold order with the terminal open; `operator` opens the operator
// tab from the activity bar, types into its terminal, stops and resumes it. The flow `diff`
// opens the right pane's `diff` view, starts the viewers, checks the keys reach the frame,
// switches repo, expands the pane, and stops and restarts a viewer from the services view. It
// works against the fixture server or the real daemon.
import { writeFileSync } from "node:fs";

import { WebSocket } from "ws";

const [uiUrl, outDir, flow = "lifecycle"] = process.argv.slice(2);
if (uiUrl === undefined || outDir === undefined) {
    throw new Error("Usage: drive.ts <ui url> <screenshot dir>");
}
const TIMEOUT_MS = 120_000;
const CDP_PORT = process.env["E2E_CDP_PORT"] ?? "9333";

const target = (await (
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })
).json()) as { id: string; webSocketDebuggerUrl: string };
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

async function evaluate(expression: string, userGesture = false): Promise<unknown> {
    const result = (await send("Runtime.evaluate", {
        expression, returnByValue: true, userGesture,
    })) as {
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
    await closeTarget();
    throw new Error(`Timed out waiting for: ${label}`);
}

// A tab left open keeps its sockets (a terminal's pty gets its size again on the next fixture),
// so every flow closes its target: on success through `finish`, on a timeout before the throw.
async function closeTarget(): Promise<void> {
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${target.id}`);
}

// A check that throws outside `until` must not leave the tab open either.
process.on("unhandledRejection", (error) => {
    console.error(error);
    void closeTarget().finally(() => process.exit(1));
});

async function finish(): Promise<never> {
    socket.close();
    await closeTarget();
    process.exit(0);
}

async function shot(name: string): Promise<void> {
    const result = (await send("Page.captureScreenshot", { format: "png" })) as { data: string };
    writeFileSync(`${outDir}/${name}.png`, Buffer.from(result.data, "base64"));
    console.log(`screenshot ${outDir}/${name}.png`);
}

// `gesture` marks the click as a user gesture, which the popup blocker needs for `window.open`.
const click = (selector: string, text = "", gesture = false) =>
    evaluate(`(() => {
        const items = [...document.querySelectorAll(${JSON.stringify(selector)})];
        const el = items.find((e) => e.textContent.includes(${JSON.stringify(text)}));
        if (!el || el.disabled) return false;
        el.click();
        return true;
    })()`, gesture);

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

// `reset` and `close` sit behind the toolbar's `⋯` menu in the context bar.
async function clickEndAction(action: "reset" | "close"): Promise<void> {
    await click(".toolbar-menu .icon-button");
    await until(`${action} in the menu`, `document.querySelector(".toolbar-menu .menu") !== null`);
    await click(".toolbar-menu .menu button", action);
}

await send("Page.enable");
const BRIDGE_FLOWS = ["bridge-stub", "bridge-popout", "bridge-bar", "bridge-diff"];
if (BRIDGE_FLOWS.includes(flow)) {
    // A stand-in for the desktop preload: records every bridge call on `window.bridgeCalls`.
    // `dockBack` answers with the `pane.docked` event the desktop sends; `window.bridgeDock`
    // sends one by hand, as the window's close button would; `panes.list` reads the windows
    // the test put in `sessionStorage` under `e2e-popped`, as a reload would find them.
    // `window.bridgeNavigate` sends a `navigated` event, as the view does after a load.
    await send("Page.addScriptToEvaluateOnNewDocument", {
        source: `window.bridgeCalls = [];
            const record = (method) => (...args) => {
                window.bridgeCalls.push({ method, args });
                return Promise.resolve();
            };
            const listeners = new Set();
            const previewListeners = new Set();
            window.bridgeDock = (event) =>
                listeners.forEach((l) => l({ type: "docked", ...event }));
            window.bridgeNavigate = (event) =>
                previewListeners.forEach((l) => l({ type: "navigated", ...event }));
            const docked = (event) => setTimeout(() => window.bridgeDock(event), 10);
            window.spinnerDesktop = {
                previews: {
                    set: record("set"), show: record("show"), hide: record("hide"),
                    reload: record("reload"), openExternal: record("openExternal"),
                    devtools: record("devtools"),
                    subscribe: (l) => {
                        previewListeners.add(l);
                        return () => previewListeners.delete(l);
                    },
                    navigate: record("navigate"), back: record("back"),
                    forward: record("forward"), zoom: record("zoom"),
                    find: (key, text) => {
                        record("find")(key, text);
                        const found = { matches: 3, active: 1 };
                        return Promise.resolve(text === null ? null : found);
                    },
                    clearStorage: record("clearStorage"),
                    popOut: record("previews.popOut"),
                    dockBack: (key) => {
                        docked({ pane: "previews", session: key.split("/")[0], key });
                        return record("previews.dockBack")(key);
                    },
                },
                panes: {
                    popOut: record("panes.popOut"),
                    dockBack: (pane, session) => {
                        docked({ pane, session });
                        return record("panes.dockBack")(pane, session);
                    },
                    list: () =>
                        Promise.resolve(JSON.parse(sessionStorage.getItem("e2e-popped") ?? "[]")),
                    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
                },
                daemon: { status: () => Promise.resolve({}), subscribe: () => () => {} },
            };`,
    });
}
{
    // Every flow starts from the default layout, once; a flow's own reload keeps what it
    // stored. Chrome keeps localStorage across runs, so a failed run would shape the next.
    await send("Page.addScriptToEvaluateOnNewDocument", {
        source: `if (sessionStorage.getItem("e2e-layout-cleared") === null) {
                localStorage.removeItem("spinner.layout.v2");
                sessionStorage.setItem("e2e-layout-cleared", "1");
            }`,
    });
}
await send("Emulation.setDeviceMetricsOverride", {
    width: 1500, height: 900, deviceScaleFactor: 1, mobile: false,
});
// The fixture's first agent is a tty agent since s009; the chat flow asks for the old view.
await send("Page.navigate", { url: flow === "agents" ? `${uiUrl}?chat=1` : uiUrl });
await until("sessions pane", `document.querySelector("[aria-label=Sessions]") !== null`);
await until("daemon connected", `${text(".status")}.includes("open")`);
await shot("01-sessions");

if (flow === "previews") {
    await click(".session", process.env["E2E_SESSION"] ?? "");
    await until("web tab", `document.querySelector(".preview-pane .tab") !== null`);
    await click(".preview-pane .tab", "web");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await shot("04b-web-preview");
    await finish();
}

if (flow === "top-level-note") {
    // Browser path of M4: a service with `preview: top-level` shows the "open in tab" note above
    // its iframe; a `frame` service shows the iframe alone. Runs against the fixture (session
    // "Refund flow": web is top-level, api is frame) or a daemon with such a stack.
    await click(".session", process.env["E2E_SESSION"] ?? "Refund flow");
    await until("web tab", `document.querySelector(".preview-pane .tab") !== null`);
    await click(".preview-pane .tab", process.env["E2E_TOP_LEVEL"] ?? "web");
    await until("note shown", `${text(".preview-note")}.includes("top-level page")`);
    await until("note offers a tab", `${text(".preview-note a")}.includes("Open it in a tab")`);
    await until("iframe kept", `document.querySelector("iframe.preview-frame") !== null`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await shot("35-top-level-note");
    await click(".preview-pane .tab", process.env["E2E_FRAME"] ?? "api");
    await until("note gone", `document.querySelector(".preview-note") === null`);
    await until("iframe shown", `document.querySelector("iframe.preview-frame") !== null`);
    await shot("36-frame-no-note");
    console.log("top-level note ok");
    await finish();
}

if (flow === "bridge-stub") {
    // Bridge path of M4 without Electron: with the stub above, `Preview` renders an empty box
    // and sends its rectangle; the reload button reloads the view; a tab switch hides the old
    // key and sets the new one; a drag of the pane handle sends a new rectangle.
    const calls = `window.bridgeCalls`;
    const lastCall = (method: string) =>
        `${calls}.filter((c) => c.method === ${JSON.stringify(method)}).at(-1)`;
    await click(".session", process.env["E2E_SESSION"] ?? "Refund flow");
    await until("web tab", `document.querySelector(".preview-pane .tab") !== null`);
    await click(".preview-pane .tab", "web");
    await until("box rendered", `document.querySelector(".preview-box") !== null`);
    await until("no iframe", `document.querySelector("iframe") === null`);
    await until("set called", `${lastCall("set")} !== undefined`);
    const first = (await evaluate(`(() => {
        const box = document.querySelector(".preview-box").getBoundingClientRect();
        const call = ${lastCall("set")};
        const [key, url, rect] = call.args;
        const same = rect.x === Math.round(box.left) && rect.y === Math.round(box.top)
            && rect.width === Math.round(box.width) && rect.height === Math.round(box.height);
        return { key, url, rect, same };
    })()`)) as { key: string; url: string; rect: object; same: boolean };
    console.log("first set:", JSON.stringify(first));
    if (!first.same || !first.key.endsWith("/web")) {
        throw new Error("set() did not carry the box rectangle and the web key");
    }
    await shot("37-bridge-box");
    await click("button[aria-label=Reload]");
    await until("reload called", `${lastCall("reload")}?.args[0] === ${JSON.stringify(first.key)}`);
    // Drag the preview pane's handle 100 px to the left: the pane widens, the box with it.
    const handle = (await evaluate(`(() => {
        const r = document.querySelectorAll(".handle")[1].getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + 300 };
    })()`)) as { x: number; y: number };
    const mouse = (type: string, x: number) =>
        send("Input.dispatchMouseEvent", { type, x, y: handle.y, button: "left", buttons: 1 });
    await mouse("mousePressed", handle.x);
    for (let step = 1; step <= 5; step += 1) {
        await mouse("mouseMoved", handle.x - step * 20);
    }
    await mouse("mouseReleased", handle.x - 100);
    await until(
        "wider rectangle sent",
        `${lastCall("set")}.args[2].width > ${JSON.stringify(first.rect)}.width + 90`,
    );
    const dragged = await evaluate(`${lastCall("set")}.args[2]`);
    console.log("after drag:", JSON.stringify(dragged));
    await shot("38-bridge-dragged");
    const count = (method: string, key: string) =>
        `${calls}.filter((c) => c.method === ${JSON.stringify(method)}` +
        ` && c.args[0] === ${JSON.stringify(key)}).length`;
    const hidden = (await evaluate(count("hide", first.key))) as number;
    await click(".preview-pane .tab", "api");
    await until("web hidden", `${count("hide", first.key)} > ${hidden}`);
    await until("api set", `${lastCall("set")}.args[0].endsWith("/api")`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const order = await evaluate(`${calls}.map((c) => c.method + ":" + c.args[0].split("/")[1])`);
    console.log("calls:", JSON.stringify(order));
    // The reload click above must not reload a tab mounted later (the counter is pane state).
    if ((await evaluate(count("reload", first.key.replace(/web$/, "api")))) !== 0) {
        throw new Error("reload() fired for the api view that was never reloaded");
    }
    console.log("bridge stub ok");
    await finish();
}

if (flow === "expanded") {
    // Expanded is one state with one exit. Expand: the previews are the only pane and fill
    // the window, no drawer, no strips, no handles. The activity bar's sessions icon does
    // nothing. Escape brings the three panes and the drawer back at their earlier widths.
    const widthOf = (selector: string) =>
        `Math.round(document.querySelector(${JSON.stringify(selector)})` +
        `?.getBoundingClientRect().width ?? -1)`;
    const widths = async () =>
        (await evaluate(`({
            sessions: ${widthOf(".sessions-pane")},
            agents: ${widthOf(".agents-pane")},
            previews: ${widthOf(".preview-pane")},
            panes: document.querySelectorAll(".pane").length,
            strips: document.querySelectorAll(".strip").length,
            handles: document.querySelectorAll(".handle").length,
            drawer: document.querySelectorAll(".drawer").length,
            window: window.innerWidth,
        })`)) as Record<string, number>;
    await click(".session", process.env["E2E_SESSION"] ?? "Refund flow");
    await until("three panes", `document.querySelectorAll(".pane").length === 3`);
    await until("drawer shown", `document.querySelectorAll(".drawer").length === 1`);
    const before = await widths();
    console.log("before:", JSON.stringify(before));
    await click("button[aria-label='Expand previews']");
    await until("previews alone", `document.querySelectorAll(".pane").length === 1`);
    const fills = `${widthOf(".preview-pane")} >= window.innerWidth - 40`;
    await until("previews fill the window", fills);
    const during = await widths();
    console.log("expanded:", JSON.stringify(during));
    if (during["drawer"] !== 0 || during["strips"] !== 0 || during["handles"] !== 0) {
        throw new Error("expanded must show the previews alone: no drawer, strips or handles");
    }
    const collapse = `document.querySelector("button[aria-label='Collapse previews']")`;
    if (await evaluate(`${collapse} !== null`)) {
        throw new Error("the previews' collapse control must hide while expanded");
    }
    await shot("45-expanded-alone");
    await click(".activity-bar .icon-button", "");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = await widths();
    if (JSON.stringify(after) !== JSON.stringify(during)) {
        throw new Error("the activity bar changed the expanded layout");
    }
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
    await until("three panes back", `document.querySelectorAll(".pane").length === 3`);
    await until("drawer back", `document.querySelectorAll(".drawer").length === 1`);
    const restored = await widths();
    console.log("restored:", JSON.stringify(restored));
    if (JSON.stringify(restored) !== JSON.stringify(before)) {
        throw new Error("the exit did not bring the earlier layout back");
    }
    await shot("46-expanded-restored");
    console.log("expanded ok");
    await finish();
}

if (flow === "panes") {
    // The workbench layout in a browser: the context bar above names the active session
    // (title, stage, stack, PR badge, needs-you line); the activity bar at the far left has
    // one icon per side-panel view, lit while the panel shows it, and toggles the panel; the
    // panel toggle at the left of the sessions header hides the side panel (no strip) and
    // goes with it; a drag of the panel's divider 60 px past
    // its 140 px minimum arms a hide that lands on release (a shorter drag only parks it at
    // the minimum); the previews collapse to the edge strip the same way (200 px minimum) or
    // by their header toggle, and the strip restores them; the agents pane never folds, its
    // 280 px
    // minimum stops a drag and nothing else caps the previews; expand gives the previews the
    // window and Escape or the same button brings the layout back; widths survive a reload;
    // the `?pane=` route renders one pane alone without strips, dividers or controls.
    const widthOf = (selector: string) =>
        `Math.round(document.querySelector(${JSON.stringify(selector)})` +
        `?.getBoundingClientRect().width ?? -1)`;
    const strip = (pane: string) => `document.querySelector(".strip[data-pane=${pane}]")`;
    const handleAt = async (index: number) =>
        (await evaluate(`(() => {
            const r = document.querySelectorAll(".handle")[${index}].getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + 300 };
        })()`)) as { x: number; y: number };
    const drag = async (index: number, dx: number) => {
        const at = await handleAt(index);
        const mouse = (type: string, x: number, clickCount = 0) =>
            send("Input.dispatchMouseEvent", {
                type, x, y: at.y, button: "left", buttons: 1, clickCount,
            });
        await mouse("mousePressed", at.x, 1);
        const steps = 5;
        for (let step = 1; step <= steps; step += 1) {
            await mouse("mouseMoved", at.x + (dx * step) / steps);
        }
        await mouse("mouseReleased", at.x + dx, 1);
    };
    // A drag held before release, so the armed state can be checked mid-drag.
    const dragHold = async (index: number, dx: number) => {
        const at = await handleAt(index);
        const mouse = (type: string, x: number, clickCount = 0) =>
            send("Input.dispatchMouseEvent", {
                type, x, y: at.y, button: "left", buttons: 1, clickCount,
            });
        await mouse("mousePressed", at.x, 1);
        for (let step = 1; step <= 5; step += 1) {
            await mouse("mouseMoved", at.x + (dx * step) / 5);
        }
        return () => mouse("mouseReleased", at.x + dx, 1);
    };
    const doubleClick = async (index: number) => {
        const at = await handleAt(index);
        for (const type of ["mousePressed", "mouseReleased"]) {
            await send("Input.dispatchMouseEvent", {
                type, x: at.x, y: at.y, button: "left", clickCount: 2,
            });
        }
    };
    // `Page.reload` returns before the old document goes; a marker tells the new one apart.
    const reload = async () => {
        await evaluate(`window.__stale = true`);
        await send("Page.reload");
        await until("reloaded", `window.__stale === undefined`);
        await until("sessions pane", `document.querySelector("[aria-label=Sessions]") !== null`);
    };
    const topToggle = ".pane-head button[aria-label$='side panel']";
    const barButton = ".activity-bar .icon-button";
    const noStrips = `document.querySelectorAll(".strip").length === 0`;
    await click(".session", process.env["E2E_SESSION"] ?? "Refund flow");
    const session = (await evaluate(
        `document.querySelector(".session-selected").dataset.dir`,
    )) as string;
    const chrome = await evaluate(`({
        bar: document.querySelectorAll("${barButton}").length,
        barOn: document.querySelector("${barButton}").ariaPressed,
        popOuts: document.querySelectorAll("button[aria-label^='Pop out']").length,
        top: document.querySelectorAll("${topToggle}").length,
        inSessions: document.querySelectorAll(".sessions-pane ${topToggle}").length,
        context: [...document.querySelector(".context-bar").children]
            .filter((c) => !c.classList.contains("usage-line")
                && !c.classList.contains("machine-line") && !c.classList.contains("toolbar"))
            .map((c) => c.innerText).filter((t) => t !== "").join("\\n"),
        links: document.querySelectorAll(".pane-head a, .pane-head .link, .browser-bar a")
            .length,
        icons: document.querySelectorAll(".preview-pane .icon-button").length,
    })`);
    console.log("chrome:", JSON.stringify(chrome));
    const wanted = {
        bar: 3, barOn: "true", popOuts: 1, top: 0, inSessions: 0,
        // `$3.27` is the fixture session's cost (s013), between the stack and the PR badge.
        context: ["Refund flow", "peer-review", "stack up", "$3.27", "⑂ 2",
            "Approve the refund copy in PR #412"].join("\n"),
        links: 0, icons: 7,
    };
    if (JSON.stringify(chrome) !== JSON.stringify(wanted)) {
        throw new Error("expected the bar (sessions, operator, gear), 1 pop-out, 7 icons");
    }
    const popOutOwner = await evaluate(
        `document.querySelector("button[aria-label^='Pop out']").closest(".pane").className`,
    );
    if (popOutOwner !== "pane preview-pane") {
        throw new Error("the pop-out icon must be on the previews pane only");
    }
    await shot("39-default");
    // 1. A brush: 150 px left parks the panel at its 140 px minimum (260 - 150 = 110 is past
    // the minimum but short of the 60 px snap margin); nothing hides. Then a deliberate pull:
    // 200 px left (next 60 < 140 - 60) arms the hide, the panel fades, and release hides it.
    await drag(0, -150);
    await until("parked at the minimum", `${widthOf(".sessions-pane")} === 140`);
    await until("not armed", `document.querySelector(".layout[data-armed]") === null`);
    await drag(0, 120);
    await until("back to 260", `${widthOf(".sessions-pane")} === 260`);
    const releaseLeft = await dragHold(0, -200);
    await until("armed", `document.querySelector(".layout[data-armed=sessions]") !== null`);
    await until("still at the minimum", `${widthOf(".sessions-pane")} === 140`);
    const faded = `getComputedStyle(document.querySelector(".sessions-pane")).opacity`;
    await until("panel faded", `${faded} === "0.35"`);
    await shot("39b-left-armed");
    await releaseLeft();
    await until("left panel hidden", `document.querySelector(".sessions-pane") === null`);
    await until("no strip", noStrips);
    await until("context bar stays", `${text(".context-title")} === "Refund flow"`);
    // The toggle goes with the panel; the bar never hides: it keeps its place, its icon
    // dimmed, as the way back.
    await until("no toggle anywhere", `document.querySelectorAll("${topToggle}").length === 0`);
    await until("bar icon off", `document.querySelector("${barButton}").ariaPressed === "false"`);
    await until("bar still in place", `${widthOf(".activity-bar")} >= 40`);
    await shot("40-left-hidden");
    // 2. The bar icon shows it again at the width before the drag and lights up; the active
    // icon hides it. There is no toggle in the pane header.
    await click(barButton);
    await until("left panel back at 260", `${widthOf(".sessions-pane")} === 260`);
    await until("bar icon on", `document.querySelector("${barButton}").ariaPressed === "true"`);
    await until("no header toggle", `document.querySelectorAll("${topToggle}").length === 0`);
    await click(barButton);
    await until("hidden by the bar", `document.querySelector(".sessions-pane") === null`);
    await click(barButton);
    await until("shown by the bar", `${widthOf(".sessions-pane")} === 260`);
    // 3. The previews divider dragged 400 px right: 520 - 400 is 60 px past the 200 minimum.
    const releaseRight = await dragHold(1, 400);
    const armedRight = `document.querySelector(".layout[data-armed=previews]") !== null`;
    await until("previews armed", armedRight);
    await until("previews at the minimum", `${widthOf(".preview-pane")} === 200`);
    await releaseRight();
    await until("previews strip", `${strip("previews")} !== null`);
    await until("strip is 24 px", `${widthOf(".strip[data-pane=previews]")} === 24`);
    await shot("41-previews-strip");
    await click(".strip[data-pane=previews]");
    await until("previews back at 520", `${widthOf(".preview-pane")} === 520`);
    // 4. The header toggle collapses too; a double-click on the divider restores.
    await click("button[aria-label='Collapse previews']");
    await until("collapsed by the header", `${strip("previews")} !== null`);
    await doubleClick(1);
    await until("restored by double-click", `${widthOf(".preview-pane")} === 520`);
    // 5. The agents pane never folds and nothing else caps the previews: a 1200 px drag stops
    // exactly where the agents pane is at its 280 px minimum, with the previews at the rest
    // of the width (about 1500 - 40 bar - 260 - 12 - 280 = 908 px, past any fraction of the
    // window).
    await drag(1, -1200);
    await until("agents at their minimum", `${widthOf(".agents-pane")} === 280`);
    const previewsWidth = (await evaluate(widthOf(".preview-pane"))) as number;
    console.log("previews width at the stop:", previewsWidth);
    if (previewsWidth < 900) {
        throw new Error("the previews stopped short of the agents minimum");
    }
    await shot("42-agents-minimum");
    await drag(1, 408);
    await until("previews narrower again", `${widthOf(".preview-pane")} < 520`);
    // 6. Left panel hidden plus previews collapsed: the agents take the window.
    await click(barButton);
    await click("button[aria-label='Collapse previews']");
    await until("agents fill the window", `${widthOf(".agents-pane")} > 1400`);
    await shot("43-agents-whole-window");
    await click(barButton);
    await click(".strip[data-pane=previews]");
    await until("three panes again", `${widthOf(".sessions-pane")} === 260`);
    // 7. Expand: the previews alone; Escape and the same button bring the layout back.
    await click("button[aria-label='Expand previews']");
    await until("previews fill the window", `${widthOf(".preview-pane")} > 1400`);
    await until("other panes gone", `document.querySelectorAll(".pane").length === 1`);
    await until("no drawer while expanded", `document.querySelectorAll(".drawer").length === 0`);
    const shrink = `document.querySelector("button[aria-label='Restore layout']")`;
    await until("shrink icon shown", `${shrink} !== null`);
    await shot("44-expanded");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
    await until("layout back on Escape", `document.querySelectorAll(".pane").length === 3`);
    await click("button[aria-label='Expand previews']");
    await until("expanded again", `document.querySelectorAll(".pane").length === 1`);
    await click("button[aria-label='Restore layout']");
    await until("layout back on click", `document.querySelectorAll(".pane").length === 3`);
    // 8. A resized left panel keeps its width across a reload.
    await drag(0, 140);
    await until("left panel at 400", `${widthOf(".sessions-pane")} === 400`);
    const stored = await evaluate(`localStorage.getItem("spinner.layout.v2")`);
    console.log("stored layout:", stored);
    await reload();
    await until("still 400", `${widthOf(".sessions-pane")} === 400`);
    await click(".session", process.env["E2E_SESSION"] ?? "Refund flow");
    // 9. Stale pop-out windows of an earlier run must not count below.
    const targets = async () =>
        ((await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as {
            id: string; url: string;
        }[]).filter((t) => t.url.includes("pane=") && t.id !== target.id);
    const closeWindow = (id: string) => fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${id}`);
    for (const stale of await targets()) {
        await closeWindow(stale.id);
    }
    // The previews pop out into a window on the `?pane=previews` route; the strip docks it
    // back; a window the operator closes docks itself.
    const popups = async () => {
        // The strip renders before Chrome lists the new window; give the target a moment.
        let found = await targets();
        for (let tries = 0; found.length === 0 && tries < 20; tries += 1) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            found = await targets();
        }
        return found;
    };
    await click("button[aria-label='Pop out previews']", "", true);
    await until("previews popped strip", `${strip("previews")}?.textContent.includes("popped")`);
    let windows = await popups();
    console.log("popped-out windows:", JSON.stringify(windows.map((t) => t.url)));
    if (windows.length !== 1 || !windows[0]?.url.includes(`pane=previews&session=${session}`)) {
        throw new Error("pop out did not open the ?pane=previews route for the session");
    }
    await shot("45-previews-popped");
    await click(".strip[data-pane=previews]");
    await until("previews docked", `document.querySelector(".preview-pane") !== null`);
    for (let tries = 0; (await targets()).length > 0 && tries < 20; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if ((await targets()).length !== 0) {
        throw new Error("dock back left the popped-out window open");
    }
    await click("button[aria-label='Pop out previews']", "", true);
    await until("popped again", `${strip("previews")}?.textContent.includes("popped")`);
    windows = await popups();
    await closeWindow(windows[0]?.id ?? "");
    await until("docked on close", `document.querySelector(".preview-pane") !== null`);
    // 10. The route alone: one pane, no bar, strips, dividers or controls, same session.
    await send("Page.navigate", { url: `${uiUrl}?pane=agents&session=${session}` });
    await until("single pane", `document.querySelector(".layout-single .agents-pane") !== null`);
    const contextTab = `[...document.querySelectorAll(".agents-pane .tab")]`;
    await until("session shown", `${contextTab}.some((t) => t.textContent === "context")`);
    const lone = await evaluate(`({
        strips: document.querySelectorAll(".strip").length,
        handles: document.querySelectorAll(".handle").length,
        controls: document.querySelectorAll(".pane-controls").length,
        bars: document.querySelectorAll(".context-bar, .activity-bar").length,
        panes: document.querySelectorAll(".pane").length,
    })`);
    console.log("pane route:", JSON.stringify(lone));
    const expected = { strips: 0, handles: 0, controls: 0, bars: 0, panes: 1 };
    if (JSON.stringify(lone) !== JSON.stringify(expected)) {
        throw new Error("the pane route rendered more than the one pane");
    }
    await shot("46-pane-route");
    console.log("panes ok");
    await finish();
}

if (flow === "browser-bar") {
    // The iframe path of the browser bar: back and forward stay disabled, there is no menu
    // and no devtools, the URL field shows the URL Spinner set, and Enter reloads the frame
    // at the typed URL.
    await click(".session", process.env["E2E_SESSION"] ?? "Refund flow");
    await until("web tab", `document.querySelector(".preview-pane .tab") !== null`);
    await click(".preview-pane .tab", "web");
    await until("bar shown", `document.querySelector(".browser-bar") !== null`);
    const shape = (await evaluate(`({
        back: document.querySelector("button[aria-label=Back]").disabled,
        forward: document.querySelector("button[aria-label=Forward]").disabled,
        menu: document.querySelectorAll("button[aria-label=More]").length,
        devtools: document.querySelectorAll("button[aria-label='Developer tools']").length,
        url: document.querySelector(".url-field").value,
        src: document.querySelector("iframe.preview-frame").src,
    })`)) as { back: boolean; forward: boolean; menu: number; devtools: number; url: string;
        src: string };
    console.log("browser bar:", JSON.stringify(shape));
    const asBrowser = shape.back && shape.forward && shape.menu === 0 && shape.devtools === 0;
    if (!asBrowser || new URL(shape.url).href !== shape.src) {
        throw new Error("the iframe bar did not have the browser shape");
    }
    await shot("47-browser-bar-iframe");
    const typed = new URL("about", shape.url).href;
    await fill(".url-field", typed);
    await evaluate(`document.querySelector(".url-form").requestSubmit(), true`);
    const src = `document.querySelector("iframe.preview-frame").src`;
    await until("frame at the typed URL", `${src} === ${JSON.stringify(typed)}`);
    await until("field shows it", `document.querySelector(".url-field").value.endsWith("about")`);
    await shot("48-browser-bar-navigated");
    console.log("browser bar ok");
    await finish();
}

if (flow === "bridge-bar") {
    // The desktop path with the stub: a `navigated` event fills the URL field and the title
    // tooltip and enables back; the buttons call `back`, `navigate` (Enter in the field),
    // `zoom` (from the menu), `find` (the inline field, then null on close) and
    // `clearStorage` after the confirm.
    const calls = `window.bridgeCalls`;
    const lastCall = (method: string) =>
        `${calls}.filter((c) => c.method === ${JSON.stringify(method)}).at(-1)`;
    const field = `document.querySelector(".url-field")`;
    const back = `document.querySelector("button[aria-label=Back]")`;
    await click(".session", process.env["E2E_SESSION"] ?? "Refund flow");
    await until("web tab", `document.querySelector(".preview-pane .tab") !== null`);
    await click(".preview-pane .tab", "web");
    await until("set called", `${lastCall("set")} !== undefined`);
    const key = (await evaluate(`${lastCall("set")}.args[0]`)) as string;
    const url = (await evaluate(`${lastCall("set")}.args[1]`)) as string;
    const quotedKey = JSON.stringify(key);
    await until("field at the set URL", `${field}.value === ${JSON.stringify(url)}`);
    await until("back disabled", `${back}.disabled`);
    await evaluate(`window.bridgeNavigate({ key: ${quotedKey}, title: "About us",
        url: ${JSON.stringify(new URL("about", url).href)}, canGoBack: true,
        canGoForward: false, loading: false })`);
    await until("field follows", `${field}.value.endsWith("/about")`);
    await until("title tooltip", `${field}.title === "About us"`);
    await until("back enabled", `!${back}.disabled`);
    await shot("49-bridge-bar-navigated");
    await click("button[aria-label=Back]");
    await until("back called", `${lastCall("back")}?.args[0] === ${quotedKey}`);
    const typed = new URL("pricing", url).href;
    await fill(".url-field", typed);
    await evaluate(`document.querySelector(".url-form").requestSubmit(), true`);
    const quotedTyped = JSON.stringify(typed);
    await until("navigate called", `${lastCall("navigate")}?.args[1] === ${quotedTyped}`);
    await click("button[aria-label=More]");
    await until("menu open", `document.querySelector(".menu") !== null`);
    await shot("50-bridge-bar-menu");
    await click(".menu button", "Zoom in");
    await until("zoom called", `${lastCall("zoom")}?.args[1] === "in"`);
    await click("button[aria-label=More]");
    await click(".menu button", "Find in page");
    await until("find field", `document.querySelector(".find-field") !== null`);
    await fill("input[aria-label='Find text']", "refund");
    await evaluate(`document.querySelector(".find-field").requestSubmit(), true`);
    await until("find called", `${lastCall("find")}?.args[1] === "refund"`);
    await until("count shown", `${text(".find-count")} === "1/3"`);
    await shot("51-bridge-bar-find");
    await click("button[aria-label='Close find']");
    await until("find cleared", `${lastCall("find")}?.args[1] === null`);
    await evaluate(`window.confirm = () => true, true`);
    await click("button[aria-label=More]");
    await click(".menu button", "Clear this app's storage");
    await until("clearStorage called", `${lastCall("clearStorage")}?.args[0] === ${quotedKey}`);
    console.log("calls:", JSON.stringify(await evaluate(`${calls}.map((c) => c.method)`)));
    console.log("bridge bar ok");
    await finish();
}

if (flow === "bridge-popout") {
    // The pop-out handling with the stub: the previews header calls `previews.popOut` with
    // the shown tab's key and the pane becomes a strip; the strip calls `previews.dockBack`
    // and the docked event restores the pane, which places its view again with `set`. After
    // a load the page asks `panes.list` and shows a strip per window the desktop still has
    // (its tray can open pane pages too); `panes.dockBack` docks those, and a docked event
    // alone (the window's close button) restores the pane.
    const calls = `window.bridgeCalls`;
    const lastCall = (method: string) =>
        `${calls}.filter((c) => c.method === ${JSON.stringify(method)}).at(-1)`;
    const strip = (pane: string) => `document.querySelector(".strip[data-pane=${pane}]")`;
    const argsOf = (method: string, args: string[]) =>
        `JSON.stringify(${lastCall(method)}?.args) === ${JSON.stringify(JSON.stringify(args))}`;
    await click(".session", process.env["E2E_SESSION"] ?? "Refund flow");
    const session = (await evaluate(
        `document.querySelector(".session-selected").dataset.dir`,
    )) as string;
    const key = `${session}/web`;
    await until("web tab", `document.querySelector(".preview-pane .tab") !== null`);
    await click(".preview-pane .tab", "web");
    await until("set called", `${lastCall("set")}?.args[0] === ${JSON.stringify(key)}`);
    const sets = (await evaluate(`${calls}.filter((c) => c.method === "set").length`)) as number;
    await click("button[aria-label='Pop out previews']");
    await until("previews.popOut", `${lastCall("previews.popOut")}?.args[0] === "${key}"`);
    await until("previews strip", `${strip("previews")}?.textContent.includes("popped")`);
    await shot("43-bridge-preview-popped");
    await click(".strip[data-pane=previews]");
    await until("previews.dockBack", `${lastCall("previews.dockBack")}?.args[0] === "${key}"`);
    await until("pane back", `document.querySelector(".preview-pane .preview-box") !== null`);
    await until("view placed again", `${calls}.filter((c) => c.method === "set").length > ${sets}`);
    const popped = JSON.stringify([
        { pane: "sessions", session },
        { pane: "agents", session },
        { pane: "previews", session, key },
    ]);
    await evaluate(`sessionStorage.setItem("e2e-popped", ${JSON.stringify(popped)})`);
    await evaluate(`window.__stale = true`);
    await send("Page.reload");
    await until("reloaded", `window.__stale === undefined`);
    for (const pane of ["sessions", "agents", "previews"]) {
        await until(`${pane} strip`, `${strip(pane)}?.textContent.includes("popped")`);
    }
    await shot("43b-bridge-resumed-strips");
    await click(".strip[data-pane=previews]");
    await until("previews.dockBack", `${lastCall("previews.dockBack")}?.args[0] === "${key}"`);
    await until("previews back", `document.querySelector(".preview-pane") !== null`);
    await click(".strip[data-pane=agents]");
    await until("panes.dockBack", argsOf("panes.dockBack", ["agents", session]));
    await until("agents back", `document.querySelector(".agents-pane") !== null`);
    await evaluate(`window.bridgeDock({ pane: "sessions", session: ${JSON.stringify(session)} })`);
    await until("sessions back on close", `document.querySelector(".sessions-pane") !== null`);
    console.log("calls:", JSON.stringify(await evaluate(`${calls}.map((c) => c.method)`)));
    console.log("bridge popout ok");
    await finish();
}

if (flow === "compose") {
    // Chat first (s014): the compose box is one textarea. A paste with a PR URL of a project
    // repo, a short `api#N` reference and a URL of a repo outside the project yields three
    // checkboxes after the typing pause: the first two ticked, the third unticked with its
    // reason. An untick survives a re-extraction. `Start` creates the session, which is
    // selected and opens on the lead's terminal; the compose box is gone.
    await click(".compose-new");
    const form = `document.querySelector(".agents-pane form[aria-label='New session']")`;
    await until("compose box", `${form} !== null`);
    const options = `[...document.querySelectorAll("form[aria-label='New session'] option")]`;
    await until("projects loaded", `${options}.some((o) => o.textContent === "sample-stack")`);
    await evaluate(`(() => {
        const select = document.querySelector("form[aria-label='New session'] select");
        const option = [...select.options].find((o) => o.textContent === "sample-stack");
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
        setter.call(select, option.value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    })()`);
    const stamp = Date.now() % 100000;
    const paste = [
        `E2E compose ${stamp}`,
        "Finish the refund copy: https://github.com/example/web/pull/412 and api#87,",
        "see https://github.com/example/billing/pull/3 for the background.",
    ].join("\n");
    await fill("textarea[aria-label='What this is about']", paste);
    const boxes = `[...document.querySelectorAll(".compose-prs input")]`;
    await until("three PRs found", `${boxes}.length === 3`);
    const ticks = (await evaluate(`${boxes}.map((b) => [b.checked, b.disabled])`)) as
        [boolean, boolean][];
    console.log("ticks:", JSON.stringify(ticks));
    if (JSON.stringify(ticks) !== "[[true,false],[true,false],[false,true]]") {
        throw new Error("the adoptable PRs are not ticked and the foreign one is not refused");
    }
    const reason = text(".compose-pr-reason");
    await until("reason shown", `${reason}.includes("billing is not a repo")`);
    await shot("56-compose-extracted");
    await click("input[aria-label='Adopt api#87']");
    await until("api unticked", `${boxes}[1].checked === false`);
    await fill("textarea[aria-label='What this is about']", `${paste}\nmore words`);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await until("still three PRs", `${boxes}.length === 3`);
    const kept = await evaluate(`${boxes}[1].checked`);
    if (kept !== false) {
        throw new Error("the untick did not survive the re-extraction");
    }
    await click(".compose-actions .primary", "Start");
    const selected = text(".session-selected");
    await until("session selected", `${selected}.includes("E2E compose ${stamp}")`);
    await until("compose box gone", `${form} === null`);
    await until("lead chip", `${text(".agents-pane .chips")}.includes("lead")`);
    await until(
        "lead terminal shown",
        `document.querySelector(".agent-terminal:not([hidden])") !== null`,
    );
    const badge = await evaluate(
        `document.querySelector(".session-selected .pr-badge")?.innerText`,
    );
    console.log("pr badge:", JSON.stringify(badge));
    if (badge !== "⑂ 1") {
        throw new Error("only the ticked PR should be adopted");
    }
    await shot("57-compose-started");
    console.log("compose ok");
    await finish();
}

if (flow === "sessions-panel") {
    // The side panel: the New session card at the top, then one block per session of one
    // height (title clamped to two lines, a badge line with the stage, the stack and the PR
    // count, a needs-you line), the per-PR lines as the card's tooltip and no form in the
    // panel. The top card opens the compose box as the middle pane's view; cancel returns to
    // agents; a created session is selected and the view returns.
    const cards = `[...document.querySelectorAll(".session")]`;
    const shape = (await evaluate(`({
        heights: [...new Set(${cards}.map((c) => c.getBoundingClientRect().height))],
        composeHeight: document.querySelector(".compose-card").getBoundingClientRect().height,
        prLines: document.querySelectorAll(".pr-line").length,
        forms: document.querySelectorAll(".sessions-pane form").length,
        tooltip: document.querySelector(".session").title,
        badge: document.querySelector(".session .pr-badge")?.innerText ?? null,
    })`)) as { heights: number[]; composeHeight: number; prLines: number; forms: number;
        tooltip: string; badge: string | null };
    console.log("cards:", JSON.stringify(shape));
    const uniform = shape.heights.length === 1 && shape.heights[0] === shape.composeHeight;
    if (!uniform || shape.prLines !== 0 || shape.forms !== 0) {
        throw new Error("the cards are not uniform blocks without forms");
    }
    if (!shape.tooltip.includes("web#412") || shape.badge !== "⑂ 2") {
        throw new Error("the PR lines did not move into the tooltip with a count badge");
    }
    await shot("52-session-cards");
    const adoptBlocks = await evaluate(`document.querySelectorAll(".compose-adopt").length`);
    if (adoptBlocks !== 0) {
        throw new Error("the Adopt block should be gone");
    }
    await click(".compose-new");
    const newForm = `document.querySelector(".agents-pane form[aria-label='New session']")`;
    await until("compose box in the middle pane", `${newForm} !== null`);
    const viewTabs = `document.querySelectorAll(".agents-pane .view-tabs").length`;
    await until("no view tabs", `${viewTabs} === 0`);
    await shot("53-compose-open");
    await click(".compose-actions button", "cancel");
    await until("back to agents", `${viewTabs} > 0`);
    await click(".compose-new");
    await until("compose box again", `${newForm} !== null`);
    const name = `E2E card ${Date.now() % 100000}`;
    await fill("textarea[aria-label='What this is about']", name);
    await shot("54-compose-new");
    await click(".compose-actions .primary");
    const picked = text(".session-selected");
    await until("new session selected", `${picked}.includes(${JSON.stringify(name)})`);
    const tabsBack = `document.querySelectorAll(".agents-pane .view-tabs").length > 0`;
    await until("view back to agents", tabsBack);
    await until("form gone", `${newForm} === null`);
    await shot("55-created-and-selected");
    console.log("sessions panel ok");
    await finish();
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
    await finish();
}

if (flow === "real-agent") {
    // The session must exist and its `agents/scribe/BRIEF.md` must be written first.
    const session = process.env["E2E_SESSION"] ?? "";
    const model = process.env["E2E_MODEL"] ?? "claude-haiku-4-5";
    const prompt = process.env["E2E_PROMPT"] ?? "Read the brief and reply with one line.";
    await click(".session", session);
    const agent = process.env["E2E_AGENT"] ?? "scribe";
    await click("button[aria-label='Add agent']");
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
    const tabs = text(".agents-pane .chips");
    await until("agent chip", `${tabs}.includes(${JSON.stringify(agent)})`);
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
    await finish();
}

if (flow === "pipeline") {
    // Mission edit, threads, then pr, fix, post (with its confirm), approve (with its confirm),
    // land and reset, on the first session that has a PR. Runs against the fixture or the daemon.
    await click(".session", process.env["E2E_SESSION"] ?? "Refund flow");
    await click(".agents-pane .tab", "mission");
    await until("mission shown", `${text(".mission")}.includes("Roster")`);
    await click(".mission-section .link", "edit");
    await fill("textarea[aria-label='Edit goal']", "Let a customer ask for a refund. Edited.");
    await click(".section-edit button", "save");
    await until("goal changed", `${text(".mission")}.includes("Edited.")`);
    await shot("13-mission-edited");
    await click(".agents-pane .tab", "threads");
    await until("threads shown", `document.querySelectorAll(".thread").length > 0`);
    await shot("14-threads");
    await fill("input[aria-label='Reply to T1']", "Fixed in the next push.");
    await click(".thread-actions button", "reply");
    await until("reply shown", `${text(".threads")}.includes("Fixed in the next push.")`);
    await click(".thread-actions button", "flag");
    await until("flag shown", `${text(".threads")}.includes("Flag:")`);
    await shot("15-thread-replied-flagged");
    for (const action of ["create PR", "fix"]) {
        await click(".actions button", action);
        await until(`${action} finished`, `${text(".drawer")}.includes("ok")`);
        await click(".drawer button", "close");
    }
    await shot("16-pr-and-fix");
    await click(".actions button", "post");
    await until("post preview", `document.querySelector("[aria-label=Message]") !== null`);
    await shot("17-post-confirm");
    await click(".confirm button", "post this message");
    await until("post finished", `${text(".drawer")}.includes("post · ok")`);
    await click(".drawer button", "close");
    await click(".actions button", "approve");
    await until("approve preview", `${text(".confirm")}.includes("open threads")`);
    await shot("18-approve-confirm");
    await click(".confirm button", "approve");
    await until("approve finished", `${text(".drawer")}.includes("approve · ok")`);
    await click(".drawer button", "close");
    for (const action of ["land", "reset"] as const) {
        if (action === "reset") {
            await clickEndAction(action);
        } else {
            await click(".actions button", action);
        }
        await until(`${action} finished`, `${text(".drawer")}.includes("${action} · ok")`);
        await click(".drawer button", "close");
    }
    await shot("19-landed-reset");
    await click(".agents-pane .tab", "agents");
    await click(".agents-pane .tab", "context");
    await until("context shown", `document.querySelectorAll(".context-file").length > 0`);
    // Every file is a collapsible section, every one closed at first; the chevron toggles
    // one; collapse all and expand all act on all of them.
    const openCount = `document.querySelectorAll(".context-file[data-open=true]").length`;
    const sections = `document.querySelectorAll(".context-file").length`;
    await until("every section closed", `${openCount} === 0 && ${sections} > 2`);
    const size = text(".context-file .context-size");
    await until("sizes shown", `/\\d+ lines? · \\d+ B/.test(${size})`);
    await shot("20-context");
    await click(".context-file:nth-child(2) .disclosure");
    await until("second opened by its chevron", `${openCount} === 1`);
    await until(
        "the second one is the open one",
        `document.querySelector(".context-file:nth-child(2)").dataset.open === "true"`,
    );
    await click(".context-toolbar .link", "collapse all");
    await until("all collapsed", `${openCount} === 0`);
    await click(".context-toolbar .link", "expand all");
    await until("all expanded", `${openCount} === ${sections}`);
    await shot("20b-context-expanded");
    console.log("pipeline ok");
    await finish();
}

if (flow === "real-panels") {
    // Read-only look at the M2 panes on a real daemon: mission, threads, the post preview.
    await click(".session", process.env["E2E_SESSION"] ?? "");
    await click(".agents-pane .tab", "mission");
    await until("mission shown", `${text(".mission")}.includes("Roster")`);
    await shot("21-real-mission");
    await click(".agents-pane .tab", "threads");
    await until("threads shown", `document.querySelector(".threads") !== null`);
    await shot("22-real-threads");
    await click(".actions button", "post");
    await until("post preview", `document.querySelector("[aria-label=Message]") !== null`);
    await shot("23-real-post-blocked");
    console.log("real panels ok");
    await finish();
}

if (flow === "m2-real") {
    // Plan 6 and 7 on the real daemon with the GitHub fixture. E2E_SESSION names the session,
    // E2E_MISSION the path of its MISSION.md, E2E_AGENTS the path of its session AGENTS.md.
    const session = process.env["E2E_SESSION"] ?? "";
    const { readFileSync } = await import("node:fs");
    const finished = async (action: string) => {
        await until(`${action} finished`, `${text(".drawer")}.includes("${action} · ok")`);
        await click(".drawer button", "close");
    };
    await click(".session", session);
    await click(".agents-pane .tab", "mission");
    await until("mission shown", `${text(".mission")}.includes("Roster")`);
    await click(".mission-section .link", "edit");
    await fill("textarea[aria-label='Edit goal']", "Let a customer ask for a refund.");
    await click(".section-edit button", "save");
    await until("goal rendered", `${text(".mission")}.includes("ask for a refund")`);
    const disk = readFileSync(process.env["E2E_MISSION"] ?? "", "utf8");
    if (!disk.includes("Let a customer ask for a refund.")) {
        throw new Error("MISSION.md on disk does not hold the edited Goal");
    }
    console.log("goal on disk ok");
    await shot("24-m2-goal-edited");
    await click(".actions button", "create PR");
    await finished("pr");
    await shot("25-m2-pr");
    await click(".agents-pane .tab", "threads");
    await until("threads shown", `document.querySelectorAll(".thread").length > 1`);
    await shot("26-m2-threads");
    const first = await evaluate(`document.querySelector(".thread-open")?.dataset.thread`);
    const second = await evaluate(`document.querySelectorAll(".thread-open")[1]?.dataset.thread`);
    await fill(`input[aria-label='Reply to ${String(first)}']`, "Fixed in the next push.");
    await click(".thread-actions button", "reply");
    await until("reply shown", `${text(".threads")}.includes("Fixed in the next push.")`);
    await click(`[data-thread='${String(second)}'] .thread-actions button`, "flag");
    await until("flag shown", `${text(".threads")}.includes("Flag:")`);
    await shot("27-m2-reply-flag");
    // The operator answers the flagged thread too, then both are resolved from the UI.
    await fill(`input[aria-label='Reply to ${String(second)}']`, "Agreed, handled.");
    await click(`[data-thread='${String(second)}'] .thread-actions button`, "reply");
    await until("second reply", `${text(".threads")}.includes("Agreed, handled.")`);
    for (const label of [first, second]) {
        await click(`[data-thread='${String(label)}'] .thread-actions button`, "resolve");
        await until(
            `${String(label)} resolved`,
            `document.querySelector("[data-thread='${String(label)}']")` +
                `?.classList.contains("thread-resolved") === true`,
        );
    }
    await click(".actions button", "fix");
    await finished("fix");
    await shot("28-m2-fix");
    if (process.env["E2E_VERIFY_URL"] !== undefined) {
        // The sample session has no running stack, so the tick is disabled; use the same route.
        await fetch(process.env["E2E_VERIFY_URL"], { method: "POST", body: "{}" });
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await click(".actions button", "post");
    await until("post preview", `document.querySelector("[aria-label=Message]") !== null`);
    await shot("29-m2-post-dialog");
    const blocked = await evaluate(`document.querySelector(".confirm .needs-human")?.innerText`);
    console.log("post blocked:", JSON.stringify(blocked));
    if (blocked === undefined) {
        await click(".confirm button", "post this message");
        await finished("post");
    } else {
        await click(".confirm button", "cancel");
    }
    await click(".actions button", "approve");
    await until("approve preview", `${text(".confirm")}.includes("open threads")`);
    await shot("30-m2-approve-dialog");
    const stuck = await evaluate(`document.querySelector(".confirm .needs-human")?.innerText`);
    console.log("approve blocked:", JSON.stringify(stuck));
    if (stuck === undefined) {
        await click(".confirm button", "approve");
        await finished("approve");
    } else {
        await click(".confirm button", "cancel");
    }
    await click(".actions button", "land");
    await finished("land");
    await shot("31-m2-landed");
    await clickEndAction("reset");
    await finished("reset");
    await shot("32-m2-reset");
    await click(".agents-pane .tab", "agents");
    await click("button[aria-label='Add agent']");
    await fill("input[aria-label='Agent name']", "scribe");
    await evaluate(`(() => {
        const select = document.querySelector("select[aria-label=Model]");
        const option = [...select.options].find((o) => o.value.includes("claude-haiku-4-5"));
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
        setter.call(select, option.value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    })()`);
    await click("form[aria-label='Add agent'] button");
    await until(
        "agent tab",
        `[...document.querySelectorAll(".agents-pane .tab")]
            .some((t) => t.textContent === "scribe")`,
    );
    await click(".agents-pane .tab", "scribe");
    await click(".agents-pane .tab", "context");
    await until("context shown", `document.querySelectorAll(".context-file").length > 0`);
    await shot("33-m2-context");
    const agents = process.env["E2E_AGENTS"] ?? "";
    await click(`.context-file[data-scope='session'] .link`, "edit");
    await fill(`textarea[aria-label='Edit ${agents}']`, "# Session rules\nEdited from the UI.\n");
    await click(".section-edit button", "save");
    await until("saved", `${text(".context")}.includes("saved")`);
    const written = readFileSync(agents, "utf8");
    if (!written.includes("Edited from the UI.")) {
        throw new Error("session AGENTS.md on disk does not hold the edit");
    }
    console.log("agents file on disk ok");
    await shot("34-m2-context-edited");
    console.log("m2-real ok");
    await finish();
}

if (flow === "m2-context") {
    // The agent tail of m2-real, for a session whose agent `scribe` already exists.
    const session = process.env["E2E_SESSION"] ?? "";
    const { readFileSync } = await import("node:fs");
    await click(".session", session);
    await click(".agents-pane .tab", "agents");
    await click(".agents-pane .tab", "scribe");
    await click(".agents-pane .tab", "context");
    await until("context shown", `document.querySelectorAll(".context-file").length > 0`);
    await shot("33-m2-context");
    const agents = process.env["E2E_AGENTS"] ?? "";
    await click(`.context-file[data-scope='session'] .link`, "edit");
    await fill(`textarea[aria-label='Edit ${agents}']`, "# Session rules\nEdited from the UI.\n");
    await click(".section-edit button", "save");
    await until("saved", `${text(".context")}.includes("saved")`);
    const written = readFileSync(agents, "utf8");
    if (!written.includes("Edited from the UI.")) {
        throw new Error("session AGENTS.md on disk does not hold the edit");
    }
    console.log("agents file on disk ok");
    await shot("34-m2-context-edited");
    console.log("m2-context ok");
    await finish();
}

if (flow === "settings") {
    // The settings view and the themes, against the fixture: the gear at the bottom of the
    // activity bar opens the view in the side panel; the theme select lists system, light,
    // dark and the valid custom theme, the invalid one is struck through with its missing
    // keys; picking light changes the page's `--bg` and the terminal's background, dark
    // changes them again, system brings the stylesheet's defaults back; each change arrives
    // as the `settings` event, which the select follows.
    const root = `getComputedStyle(document.documentElement)`;
    const bg = `${root}.getPropertyValue("--bg").trim()`;
    // xterm paints its theme's background on the viewport and the foreground on the rows.
    const xterm = `document.querySelector(".agent-terminal:not([hidden]) .xterm")`;
    const xtermBg = `getComputedStyle(${xterm}.querySelector(".xterm-viewport")).backgroundColor`;
    const xtermFg = `getComputedStyle(${xterm}.querySelector(".xterm-rows")).color`;
    const pick = (value: string) =>
        evaluate(`(() => {
            const select = document.querySelector("select[aria-label=Theme]");
            const proto = HTMLSelectElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
            setter.call(select, ${JSON.stringify(value)});
            select.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
        })()`);
    const selectValue = `document.querySelector("select[aria-label=Theme]")?.value`;
    await click(".session", "Refund flow");
    await until("terminal", `${xterm} !== null`);
    const systemBg = (await evaluate(bg)) as string;
    const systemXterm = (await evaluate(xtermBg)) as string;
    const systemFg = (await evaluate(xtermFg)) as string;
    console.log("system:", systemBg, systemXterm, systemFg);
    await click("button[aria-label='Show settings']");
    await until("settings view", `document.querySelector(".settings-pane") !== null`);
    await until("path loaded", `${text(".settings-hint")}.includes("settings.yaml")`);
    const hideGear = `document.querySelector("button[aria-label='Hide settings']")`;
    await until("gear lit", `${hideGear} !== null`);
    const shape = await evaluate(`({
        options: [...document.querySelectorAll("select[aria-label=Theme] option")]
            .map((o) => o.value),
        value: ${selectValue},
        swatches: document.querySelectorAll(".swatch").length,
        invalid: [...document.querySelectorAll(".invalid-themes li")].map((li) => li.textContent),
        hint: document.querySelector(".settings-hint")?.textContent,
        harness: document.querySelector("select[aria-label=Harness]")?.value,
        model: document.querySelector("select[aria-label='Default model']")?.value,
    })`);
    console.log("settings view:", JSON.stringify(shape));
    const wantedShape = {
        options: ["system", "light", "dark", "rainbow", "solar"], value: "system", swatches: 10,
        invalid: ["broken missing terminal.red"],
        hint: "Custom themes live in ~/.spinner/themes/<name>.json" +
            " (settings: /home/fixture/.spinner/settings.yaml). copy dark as a starting point",
        harness: "tty", model: "",
    };
    if (JSON.stringify(shape) !== JSON.stringify(wantedShape)) {
        throw new Error("the settings view is not the theme, model and harness expected");
    }
    await shot("76-settings-view");
    await pick("light");
    await until("select follows the event", `${selectValue} === "light"`);
    await until("light --bg", `${bg} === "#f6f7f9"`);
    await until("light terminal", `${xtermBg} === "rgb(255, 255, 255)"`);
    await until("light terminal text", `${xtermFg} === "rgb(27, 31, 36)"`);
    await until("light scheme", `document.documentElement.dataset.scheme === "light"`);
    await shot("77-settings-light");
    await pick("dark");
    await until("dark --bg", `${bg} === "#0f1216"`);
    await until("dark terminal", `${xtermBg} === "rgb(15, 18, 22)"`);
    await until("dark terminal text", `${xtermFg} === "rgb(230, 233, 238)"`);
    await pick("solar");
    await until("solar accent", `${root}.getPropertyValue("--accent").trim() === "#e0a63a"`);
    await shot("78-settings-solar");
    await pick("system");
    await until("system --bg back", `${bg} === ${JSON.stringify(systemBg)}`);
    await until("system terminal back", `${xtermBg} === ${JSON.stringify(systemXterm)}`);
    await until("system terminal text back", `${xtermFg} === ${JSON.stringify(systemFg)}`);
    await until("no scheme override", `document.documentElement.dataset.scheme === undefined`);
    // The gear again hides the panel; the sessions icon brings the sessions view back.
    await click("button[aria-label='Hide settings']");
    await until("panel hidden", `document.querySelector(".sessions-pane") === null`);
    await click("button[aria-label='Show sessions']");
    await until("sessions view back", `document.querySelector(".session-list") !== null`);
    console.log("settings ok");
    await finish();
}

if (flow === "usage") {
    // Resource usage at a glance, against the fixture's made-up samples: the card of a
    // session with its stack up carries `1.2 GB · 19 %` beside the stack state and a session
    // without a stack carries nothing; the context bar carries the same line and the machine
    // line; the services view has the six columns with the cells per kind of service and the
    // share line above; a `usage` event moves the numbers in place.
    const cardLine = (title: string) =>
        `([...document.querySelectorAll(".session")].find((c) => c.textContent.includes(
            ${JSON.stringify(title)}))?.querySelector(".usage-line")?.textContent ?? null)`;
    const barLine = `(document.querySelector(".context-bar .usage-line")?.textContent ?? null)`;
    const machine = `document.querySelector(".context-bar .machine-line")`;
    await click(".session", "Refund flow");
    await until("card line", `${cardLine("Refund flow")} === "1.2 GB · 19 %"`);
    await until("no line without a stack", `${cardLine("Bootstrap")} === null`);
    await until("context bar line", `${barLine} === "1.2 GB · 19 %"`);
    await until("machine line", `${machine}?.textContent === "machine 9.8 / 32 GB · 1 stack up"`);
    await until("machine line not red", `!${machine}.classList.contains("needs-human")`);
    await shot("73-usage-cards-and-bar");
    await click(".agents-pane .tab", "services");
    await until("table shown", `document.querySelector(".services") !== null`);
    const table = await evaluate(`({
        head: [...document.querySelectorAll("table[aria-label=Services] th")]
            .map((h) => h.textContent),
        rows: [...document.querySelectorAll("table[aria-label=Services] tbody tr")].map((r) =>
            [...r.querySelectorAll("td")].slice(2).map((d) => d.textContent)),
        share: document.querySelector(".usage-share")?.textContent,
    })`);
    console.log("services table:", JSON.stringify(table));
    const wantedTable = {
        head: ["service", "state", "cpu", "memory", "i/o", "process"],
        rows: [
            ["3 %", "180 MB", "—", "pid 44823"],
            ["14 %", "412 MB / 2.0 GB", "net ↓12 kB ↑3.4 MB · disk r 0 B w 1.2 MB", "9f3c2a1b7d6e"],
            ["1 %", "640 MB", "net ↓800 kB ↑2.0 MB · disk r 40 MB w 96 MB", "c1d2e3f4a5b6"],
        ],
        share: "machine 9.8 / 32 GB · 1 stack up · this session 1.2 GB · 19 % (3.8 % of memory)",
    };
    if (JSON.stringify(table) !== JSON.stringify(wantedTable)) {
        throw new Error("the services table does not show the usage columns expected");
    }
    await shot("74-usage-services");
    // A `usage` event (the fixture samples every 2 s and nudges the cpu) updates the lines in
    // place: the table element stays the same node.
    await evaluate(`document.querySelector(".services").dataset.mark = "kept", true`);
    const before = (await evaluate(barLine)) as string;
    await until("a sample moved the line", `${barLine} !== ${JSON.stringify(before)}`);
    await until("card follows", `${cardLine("Refund flow")} === ${barLine}`);
    await until("share line follows", `${text(".usage-share")}.includes(${barLine})`);
    await until("table kept", `document.querySelector(".services").dataset.mark === "kept"`);
    // The sample carries the services too: the api row's cpu follows the stack's nudge.
    const apiCpu = `document.querySelectorAll(".services tbody tr")[1].children[2].textContent`;
    await until("service cell follows the sample", `${apiCpu} !== "14 %"`);
    console.log("api cpu after a sample:", await evaluate(apiCpu));
    console.log("line before and after a sample:", before, await evaluate(barLine));
    await shot("75-usage-updated");
    console.log("usage ok");
    await finish();
}

if (flow === "drawer") {
    // The job drawer under the terminal: `run local` opens it at its remembered height; its
    // divider drags the height (floor 48 px, ceiling the pane minus 200 px) and the terminal
    // refits; the minimize icon collapses it to a one-line bar with the job's name and state;
    // a click on the bar restores the height; a drag under the floor collapses too; the
    // height and the flag survive a reload in the layout record.
    const drawer = `document.querySelector(".drawer")`;
    const bar = `document.querySelector(".drawer-bar")`;
    const heightOf = `Math.round(${drawer}?.getBoundingClientRect().height ?? -1)`;
    const rows = `(document.querySelector(".agent-terminal:not([hidden]) .xterm-rows")
        ?.innerText ?? "")`;
    // The last resize line on the screen: the rows shrink as the drawer grows.
    const lastSize = `(${rows}.match(/\\[resize \\d+x\\d+\\]/g) ?? []).at(-1)`;
    const dragHandle = async (dy: number) => {
        const at = (await evaluate(`(() => {
            const r = document.querySelector(".drawer-handle").getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`)) as { x: number; y: number };
        const mouse = (type: string, y: number) =>
            send("Input.dispatchMouseEvent", { type, x: at.x, y, button: "left", buttons: 1 });
        await mouse("mousePressed", at.y);
        for (let step = 1; step <= 5; step += 1) {
            await mouse("mouseMoved", at.y + (dy * step) / 5);
        }
        await mouse("mouseReleased", at.y + dy);
    };
    const runLocal = `[...document.querySelectorAll(".actions button")]
        .some((b) => b.textContent === "run local" && !b.disabled)`;
    await click(".session", process.env["E2E_SESSION"] ?? "Refund flow");
    await until("terminal attached", `${rows}.includes("[resize ")`);
    await until("run local enabled", runLocal);
    await click(".actions button", "run local");
    await until("drawer open", `${heightOf} === 200`);
    await until("job finished", `${text(".drawer")}.includes("up · ok")`);
    // One drawer: the Activity header with the job's line at the right, the job log as the
    // first section, the events as the second; nothing else under the terminal.
    const sections = await evaluate(`({
        head: document.querySelector(".drawer-head h2")?.textContent,
        line: document.querySelector(".drawer-head .drawer-job-line")?.textContent,
        order: [...document.querySelectorAll(".drawer .drawer-section")]
            .map((s) => s.getAttribute("aria-label")),
        events: document.querySelectorAll(".drawer .feed li").length > 0,
        feedsOutside: document.querySelectorAll(".agents-pane > .feed").length,
        after: document.querySelector(".agents-pane .drawer")?.nextElementSibling?.className
            ?? null,
    })`);
    console.log("drawer sections:", JSON.stringify(sections));
    const wantedSections = {
        head: "Activity", line: "up · ok", order: ["Job log", "Events"], events: true,
        feedsOutside: 0, after: null,
    };
    if (JSON.stringify(sections) !== JSON.stringify(wantedSections)) {
        throw new Error("the drawer is not the merged Activity drawer");
    }
    const before = (await evaluate(lastSize)) as string;
    await shot("67-drawer-default");
    await dragHandle(-100);
    await until("drawer at 300", `${heightOf} === 300`);
    await until("terminal refitted", `${lastSize} !== ${JSON.stringify(before)}`);
    console.log("terminal size before and after the drag:", before, await evaluate(lastSize));
    await shot("68-drawer-dragged");
    const ceiling = (await evaluate(`(() => {
        const pane = document.querySelector(".agents-pane").getBoundingClientRect().height;
        return Math.round(pane - 200);
    })()`)) as number;
    await dragHandle(-2000);
    await until("drawer at the ceiling", `${heightOf} === ${ceiling}`);
    console.log("ceiling:", ceiling);
    await dragHandle(ceiling - 300);
    await until("back at 300", `${heightOf} === 300`);
    await click("button[aria-label='Minimize activity']");
    await until("bar shown", `${bar} !== null && ${drawer} === null`);
    await until("bar names the job", `${text(".drawer-bar")}.includes("up · ok")`);
    await shot("69-drawer-bar");
    await click(".drawer-bar");
    await until("restored at 300", `${heightOf} === 300`);
    await dragHandle(400);
    await until("collapsed by the drag", `${bar} !== null && ${drawer} === null`);
    const stored = JSON.parse((await evaluate(`localStorage.getItem("spinner.layout.v2")`)) as
        string) as { drawer: unknown };
    console.log("stored drawer:", JSON.stringify(stored.drawer));
    if (JSON.stringify(stored.drawer) !== JSON.stringify({ height: 300, collapsed: true })) {
        throw new Error("the layout record does not hold the drawer's height and flag");
    }
    await evaluate(`window.__stale = true`);
    await send("Page.reload");
    await until("reloaded", `window.__stale === undefined`);
    await until("sessions pane", `document.querySelector("[aria-label=Sessions]") !== null`);
    await click(".session", process.env["E2E_SESSION"] ?? "Refund flow");
    await until("run local enabled again", runLocal);
    await click(".actions button", "run local");
    await until("bar after the reload", `${bar} !== null`);
    await until("job finished", `${text(".drawer-bar")}.includes("up · ok")`);
    await click(".drawer-bar");
    await until("height after the reload", `${heightOf} === 300`);
    await shot("70-drawer-after-reload");
    console.log("drawer ok");
    await finish();
}

if (flow === "narrow") {
    // A narrow window keeps the terminal usable. At 900 px (860 px for the grid) the previews
    // give up width so the agents pane keeps its 280 px minimum and the terminal opens; at
    // 600 px the previews are a strip and the side panel is at its 140 px minimum; at 440 px
    // the side panel is gone too. None of it is stored: back at 1500 px the defaults show.
    // A click on the width-made previews strip folds the side panel instead, the one way to
    // see the previews at that width.
    const widthOf = (selector: string) =>
        `Math.round(document.querySelector(${JSON.stringify(selector)})` +
        `?.getBoundingClientRect().width ?? -1)`;
    const strip = (pane: string) => `document.querySelector(".strip[data-pane=${pane}]")`;
    const shown = `document.querySelector(".agent-terminal:not([hidden])")`;
    const rows = `(${shown}?.querySelector(".xterm-rows")?.innerText ?? "")`;
    const resize = (width: number) =>
        send("Emulation.setDeviceMetricsOverride", {
            width, height: 900, deviceScaleFactor: 1, mobile: false,
        });
    const widths = async () =>
        (await evaluate(`({
            sessions: ${widthOf(".sessions-pane")}, agents: ${widthOf(".agents-pane")},
            previews: ${widthOf(".preview-pane")}, strips: document.querySelectorAll(".strip")
                .length, window: window.innerWidth,
        })`)) as Record<string, number>;
    await resize(900);
    await click(".session", process.env["E2E_SESSION"] ?? "Refund flow");
    await until("agents at the minimum", `${widthOf(".agents-pane")} === 280`);
    // 860 px less the bar's border, 260, two handles and 280: about 307 px.
    await until("previews shrunk", `${widthOf(".preview-pane")} < 320`);
    await until("previews over their minimum", `${widthOf(".preview-pane")} > 200`);
    await until("xterm mounted", `${shown}?.querySelector(".xterm") !== null`);
    await until("banner", `${rows}.includes("Spinner fixture pty for")`);
    await until("terminal has columns", `${rows}.includes("[resize ")`);
    const at900 = await widths();
    console.log("900 px:", JSON.stringify(at900));
    if (at900["sessions"] !== 260 || at900["strips"] !== 0) {
        throw new Error("at 900 px the side panel must keep 260 px and nothing may fold");
    }
    await shot("60-narrow-900");
    await resize(600);
    await until("previews strip", `${strip("previews")} !== null`);
    await until("side panel at the minimum", `${widthOf(".sessions-pane")} === 140`);
    const at600 = await widths();
    console.log("600 px:", JSON.stringify(at600));
    if (at600["agents"] < 280 || at600["strips"] !== 1) {
        throw new Error("at 600 px the previews strip and the agents keep 280 px");
    }
    await until("terminal still shown", `${shown}?.querySelector(".xterm") !== null`);
    await shot("61-narrow-600");
    await resize(440);
    await until("side panel folded", `document.querySelector(".sessions-pane") === null`);
    const at440 = await widths();
    console.log("440 px:", JSON.stringify(at440));
    if (at440["agents"] < 280 || at440["strips"] !== 1) {
        throw new Error("at 440 px only the agents pane and the previews strip remain");
    }
    await shot("62-narrow-440");
    await resize(1500);
    await until("side panel back", `${widthOf(".sessions-pane")} === 260`);
    await until("previews back", `${widthOf(".preview-pane")} === 520`);
    const stored = await evaluate(`localStorage.getItem("spinner.layout.v2")`);
    console.log("stored layout:", stored);
    const saved = JSON.parse(String(stored)) as {
        panes: Record<string, { width: number; collapsed: boolean; hidden: boolean }>;
    };
    if (saved.panes["previews"]?.collapsed !== false || saved.panes["sessions"]?.hidden !== false) {
        throw new Error("the narrow window must not change the stored layout");
    }
    await shot("63-narrow-back-to-1500");
    // The strip the width made: a click folds the side panel, and the previews come back.
    await resize(600);
    await until("previews strip again", `${strip("previews")} !== null`);
    await click(".strip[data-pane=previews]");
    await until("side panel hidden", `document.querySelector(".sessions-pane") === null`);
    await until("previews open at 600", `${widthOf(".preview-pane")} >= 200`);
    await until("agents keep 280", `${widthOf(".agents-pane")} >= 280`);
    await shot("64-narrow-strip-click");
    console.log("600 px after the strip click:", JSON.stringify(await widths()));
    console.log("narrow ok");
    await finish();
}

if (flow === "terminal") {
    // The tty agent's tab is xterm over the pty socket. Against the fixture: the banner on
    // attach, the echo of `hello` and Enter, a resize line after the pane's divider moves, the
    // terminal kept (not remounted) across a switch to the context tab and back, and the
    // `?pane=agents` route with the scrollback replayed. Against a daemon the banner is pi's
    // own screen: set E2E_BANNER to a string pi prints, E2E_TYPED to the keys (` /sp` passes
    // pi's start notice and opens its command list), E2E_ENTER=0 to send no Enter (no model
    // call) and E2E_EXPECT to what the keys make pi draw (`spinner-reload`).
    const banner = process.env["E2E_BANNER"] ?? "Spinner fixture pty for";
    const typed = process.env["E2E_TYPED"] ?? "hello";
    const expected = process.env["E2E_EXPECT"] ?? "hello";
    const shown = `document.querySelector(".agent-terminal:not([hidden])")`;
    const rows = `(${shown}?.querySelector(".xterm-rows")?.innerText ?? "")`;
    const key = (key: string, code: string, keyCode: number, text: string) =>
        [
            send("Input.dispatchKeyEvent", {
                type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, text,
            }),
            send("Input.dispatchKeyEvent", { type: "keyUp", key, code }),
        ];
    const type = async (text: string) => {
        for (const char of text) {
            const upper = char.toUpperCase();
            await Promise.all(key(char, `Key${upper}`, upper.charCodeAt(0), char));
        }
    };
    await click(".session", process.env["E2E_SESSION"] ?? "Refund flow");
    const session = (await evaluate(
        `document.querySelector(".session-selected").dataset.dir`,
    )) as string;
    await until(
        "terminal tab selected",
        `[...document.querySelectorAll(".tab-selected")].some((t) => t.textContent === "terminal")`,
    );
    await until("xterm mounted", `${shown}?.querySelector(".xterm") !== null`);
    await until("banner", `${rows}.includes(${JSON.stringify(banner)})`);
    await until("status line gone", `${shown}.querySelector(".tty-status") === null`);
    const resizeLine = /\[resize (\d+)x(\d+)\]/g;
    const sizes = async () => [...((await evaluate(rows)) as string).matchAll(resizeLine)]
        .map((m) => `${m[1]}x${m[2]}`);
    if (process.env["E2E_BANNER"] === undefined) {
        await until("first resize line", `${rows}.includes("[resize ")`);
    }
    const first = await sizes();
    console.log("sizes after attach:", JSON.stringify(first));
    await shot("56-terminal-attached");
    await type(typed);
    if (process.env["E2E_ENTER"] !== "0") {
        await Promise.all(key("Enter", "Enter", 13, "\r"));
    }
    await until("echo", `${rows}.includes(${JSON.stringify(expected)})`);
    if (process.env["E2E_BANNER"] === undefined) {
        await until("new prompt after Enter", `/hello\\n[$] /.test(${rows})`);
    }
    await shot("57-terminal-typed");
    // The divider between the agents pane and the previews, 200 px to the right.
    const handle = (await evaluate(`(() => {
        const r = document.querySelectorAll(".handle")[1].getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + 300 };
    })()`)) as { x: number; y: number };
    const mouse = (type: string, x: number) =>
        send("Input.dispatchMouseEvent", { type, x, y: handle.y, button: "left", buttons: 1 });
    await mouse("mousePressed", handle.x);
    for (let step = 1; step <= 5; step += 1) {
        await mouse("mouseMoved", handle.x + step * 40);
    }
    await mouse("mouseReleased", handle.x + 200);
    if (process.env["E2E_BANNER"] === undefined) {
        const lines = `${rows}.split("[resize ").length`;
        await until("a second resize line", `${lines} > ${first.length + 1}`);
    }
    const after = await sizes();
    console.log("sizes after the drag:", JSON.stringify(after));
    const widened = Number(after.at(-1)?.split("x")[0]) > Number(first.at(-1)?.split("x")[0]);
    if (process.env["E2E_BANNER"] === undefined && !widened) {
        throw new Error("the drag did not send a wider resize frame");
    }
    await shot("58-terminal-resized");
    // The Context tab hides the terminal; back on the terminal tab the same xterm shows
    // with the typed line still there (no remount, no second banner).
    const xtermCount = `document.querySelectorAll(".agent-terminal .xterm").length`;
    await click(".agents-pane .tab", "context");
    await until("terminal hidden", `${shown} === null`);
    await until("still mounted", `${xtermCount} === 1`);
    await click(".agents-pane .tab", "terminal");
    await until("terminal shown again", `${shown} !== null`);
    await until("typed line kept", `${rows}.includes(${JSON.stringify(expected)})`);
    const banners = ((await evaluate(rows)) as string).split(banner).length - 1;
    if (banners !== 1) {
        throw new Error(`expected one banner after the tab switch, saw ${banners}`);
    }
    await shot("59-terminal-after-tab-switch");
    // The add-agent form hides behind the `+` tab: it opens as the pane's view with the
    // terminal hidden, cancel brings the terminal back, and an added agent gets its tab.
    const form = `document.querySelector("form[aria-label='Add agent']")`;
    await until("no form on the terminal", `${form} === null`);
    await click("button[aria-label='Add agent']");
    await until("form opened", `${form} !== null`);
    await until("terminal hidden behind the form", `${shown} === null`);
    await shot("59b-add-agent-view");
    await click(".add-agent .compose-actions button", "cancel");
    await until("form closed", `${form} === null`);
    await until("terminal back", `${shown} !== null`);
    if (process.env["E2E_BANNER"] === undefined) {
        await click("button[aria-label='Add agent']");
        await fill("input[aria-label='Agent name']", "scout");
        await click(".add-agent .compose-actions .primary");
        const tabs = `[...document.querySelectorAll(".agents-pane .tab")]`;
        await until("new agent's tab selected", `${tabs}.some((t) =>
            t.textContent === "scout" && t.classList.contains("tab-selected"))`);
        await until("form closed after add", `${form} === null`);
        await until("new agent's terminal", `${rows}.includes("fixture pty for scout")`);
        await shot("59c-added-agent-selected");
        await click(".agents-pane .tab", "backend");
        await until("back on backend", `${rows}.includes("hello")`);
        // The pane's chrome: view tabs underlined with no title, the toolbar in the context
        // bar in three groups (the last one the `⋯` menu, opened here) with a tooltip per
        // button and the irreversible ones marked, the agents as chips with a state dot and a
        // tooltip, the × only on the selected hosted chip, and the sub-tabs.
        await click(".toolbar-menu .icon-button");
        await until("end menu open", `document.querySelector(".toolbar-menu .menu") !== null`);
        const chrome = await evaluate(`({
            toolbarInPane: document.querySelectorAll(".agents-pane .toolbar").length,
            toolbarInBar: document.querySelectorAll(".context-bar .toolbar").length,
            title: document.querySelectorAll(".agents-pane .pane-head").length,
            views: [...document.querySelectorAll(".agents-pane .view-tabs .view-tab")]
                .map((t) => t.textContent),
            viewSelected: document.querySelector(".agents-pane .view-tabs .tab-selected")
                ?.textContent,
            groups: [...document.querySelectorAll(".toolbar > .toolbar-group")]
                .map((g) => [...g.querySelectorAll("button")].map((b) => b.textContent)),
            seps: document.querySelectorAll(".toolbar .toolbar-sep").length,
            untitled: [...document.querySelectorAll(".toolbar button:not(.icon-button)")]
                .filter((b) => !b.title.endsWith(".")).map((b) => b.textContent),
            danger: [...document.querySelectorAll(".toolbar .danger")].map((b) => b.textContent),
            chips: [...document.querySelectorAll(".chip")].map((c) => ({
                name: c.querySelector(".chip-name").textContent,
                state: c.querySelector(".chip-dot").className.replace(/.*dot-/, ""),
                tip: c.querySelector(".chip-name").title,
                selected: c.classList.contains("chip-selected"),
                stop: c.querySelector(".chip-stop")?.getAttribute("aria-label") ?? null,
            })),
            statusLine: [...document.querySelectorAll(".agents-view p.muted")]
                .filter((p) => p.textContent.includes(" · ")).length,
            sub: [...document.querySelectorAll(".tabs-sub .tab")].map((t) => t.textContent),
            corner: document.querySelectorAll(".tty-controls").length,
        })`);
        console.log("chrome:", JSON.stringify(chrome));
        const wantedChrome = {
            toolbarInPane: 0,
            toolbarInBar: 1,
            title: 0,
            views: ["agents", "mission", "threads", "services"],
            viewSelected: "agents",
            groups: [["run local", "stop local"], ["create PR", "fix", "post", "approve", "land"],
                ["", "reset", "close"]],
            seps: 2,
            untitled: [],
            danger: ["land", "reset", "close"],
            chips: [
                { name: "backend", state: "working",
                  tip: "tty · anthropic/claude-fable-5-1 · working · $1.23 · " +
                      "anthropic/claude-fable-5-1",
                  selected: true, stop: "Stop backend" },
                { name: "frontend", state: "off",
                  tip: "rpc · anthropic/claude-sonnet-5-5 · off · $2.04 · " +
                      "anthropic/claude-sonnet-5-5",
                  selected: false, stop: null },
                { name: "scout", state: "idle", tip: "tty · fixture/default · idle",
                  selected: false, stop: null },
            ],
            statusLine: 0,
            sub: ["terminal", "context"],
            corner: 0,
        };
        if (JSON.stringify(chrome) !== JSON.stringify(wantedChrome)) {
            throw new Error("the pane's chrome is not the tabs, toolbar and chips expected");
        }
        await shot("71-pane-chrome");
        // The × on the selected chip stops the agent: the fixture drops it from the running
        // list, the chip dims, the × goes, and the terminal's status line offers resume.
        await click(".agents-pane .tab", "scout");
        await click("button[aria-label='Stop scout']");
        const scoutChip = `document.querySelector(".chip-off .chip-name[data-name=scout]")`;
        await until("scout stopped", `${scoutChip} !== null`);
        const scoutStop = `document.querySelector("button[aria-label='Stop scout']")`;
        await until("no × on a stopped agent", `${scoutStop} === null`);
        const resume = `${shown}?.querySelector(".tty-status button")?.textContent`;
        await until("resume offered", `${resume} === "resume"`);
        await shot("72-chip-stopped");
        await click(".agents-pane .tab", "backend");
    }
    // The pane route, as a pop-out window loads it: a second attachment, the scrollback
    // replayed, so the typed line is there before any keystroke.
    await send("Page.navigate", { url: `${uiUrl}?pane=agents&session=${session}` });
    await until("single pane", `document.querySelector(".layout-single .agents-pane") !== null`);
    await until("xterm in the pane route", `${shown}?.querySelector(".xterm") !== null`);
    await until("scrollback replayed", `${rows}.includes(${JSON.stringify(expected)})`);
    await shot("60-terminal-pane-route");
    console.log("terminal ok");
    await finish();
}

if (flow === "operator") {
    // The operator tab, against the fixture (or a scratch daemon with E2E_BANNER set to a
    // string pi prints): the headset icon sits above the gear; a click swaps the middle pane
    // for the operator's terminal while the side panel and the previews stay; the line under
    // the tab names the last notice; the banner shows on attach and keystrokes echo; `stop`
    // closes the pty, offers `resume` in the tab and puts the notice with its `resume` link in
    // the context bar; `resume` from either place hosts the agent again; the icon again
    // brings the session back.
    const banner = process.env["E2E_BANNER"] ?? "Spinner fixture pty for operator";
    const shown = `document.querySelector(".operator-pane .agent-terminal:not([hidden])")`;
    const rows = `(${shown}?.querySelector(".xterm-rows")?.innerText ?? "")`;
    const notice = `document.querySelector(".context-bar .operator-notice")`;
    const key = (key: string, code: string, keyCode: number, text: string) =>
        [
            send("Input.dispatchKeyEvent", {
                type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, text,
            }),
            send("Input.dispatchKeyEvent", { type: "keyUp", key, code }),
        ];
    await click(".session", process.env["E2E_SESSION"] ?? "Refund flow");
    const bar = await evaluate(`[...document.querySelectorAll(".activity-bar .icon-button")]
        .map((b) => b.getAttribute("aria-label"))`);
    console.log("activity bar:", JSON.stringify(bar));
    const wantedBar = ["Hide sessions", "Show operator", "Show settings"];
    if (JSON.stringify(bar) !== JSON.stringify(wantedBar)) {
        throw new Error("the operator icon must sit between the views and the gear");
    }
    await until("no notice while running", `${notice} === null`);
    await click("button[aria-label='Show operator']");
    await until("operator pane", `document.querySelector(".operator-pane") !== null`);
    const sessionPane = `document.querySelector(".agents-pane:not(.operator-pane)")`;
    await until("agents pane swapped out", `${sessionPane} === null`);
    const around = await evaluate(`({
        panes: [...document.querySelectorAll(".pane")].map((p) => p.getAttribute("aria-label")),
        tab: document.querySelector(".operator-pane .view-tab")?.textContent,
        waiting: document.querySelector(".operator-waiting")?.textContent,
        iconOn: document.querySelector("button[aria-label='Hide operator']")?.ariaPressed,
        context: document.querySelector(".context-title")?.textContent,
    })`);
    console.log("operator tab:", JSON.stringify(around));
    const wantedAround = {
        panes: ["Sessions", "Operator", "Previews"], tab: "operator",
        waiting: process.env["E2E_WAITING"] ??
            "waiting on: s17-refund-flow: needs_human set: Approve the refund copy in PR #412",
        iconOn: "true", context: "Refund flow",
    };
    if (JSON.stringify(around) !== JSON.stringify(wantedAround)) {
        throw new Error("the operator tab did not take the middle with the panes around it");
    }
    await until("xterm mounted", `${shown}?.querySelector(".xterm") !== null`);
    await until("banner", `${rows}.includes(${JSON.stringify(banner)})`);
    await until("status line gone", `${shown}.querySelector(".tty-status") === null`);
    await shot("80-operator-tab");
    const typed = process.env["E2E_TYPED"] ?? "hello";
    for (const char of typed) {
        const upper = char.toUpperCase();
        await Promise.all(key(char, `Key${upper}`, upper.charCodeAt(0), char));
    }
    if (process.env["E2E_ENTER"] !== "0") {
        await Promise.all(key("Enter", "Enter", 13, "\r"));
    }
    await until("echo", `${rows}.includes(${JSON.stringify(process.env["E2E_EXPECT"] ?? typed)})`);
    await shot("81-operator-typed");
    await click(".operator-toolbar button", "stop");
    // One resume in the tab, on the toolbar; the status line only says it is not running.
    await until("toolbar offers resume", `${text(".operator-toolbar button")} === "resume"`);
    await until("status line", `${text(".operator-pane .tty-status")}.includes("not running")`);
    await until("no second resume", `${shown}?.querySelector(".tty-status button") === null`);
    const noticeText = `${notice}?.textContent`;
    const notRunning = `${noticeText}.includes("operator agent not running")`;
    await until("notice in the context bar", notRunning);
    const noticeLink = `${notice}?.querySelector("button.link")?.textContent`;
    await until("notice has the link", `${noticeLink} === "resume"`);
    await shot("82-operator-stopped");
    await click(".operator-toolbar button", "resume");
    await until("notice gone", `${notice} === null`);
    await until("toolbar offers stop", `${text(".operator-toolbar button")} === "stop"`);
    await until("attached again", `${shown}.querySelector(".tty-status") === null`);
    if (process.env["E2E_BANNER"] === undefined) {
        // The fixture makes a fresh pty on a start: one banner, no echo of the old line.
        await until("fresh pty", `${rows}.includes(${JSON.stringify(banner)})`);
    }
    await shot("83-operator-resumed");
    // The link in the context bar is the other way back.
    await click(".operator-toolbar button", "stop");
    await until("stopped again", `${notice} !== null`);
    await click(".context-bar .operator-notice button.link");
    await until("resumed from the bar", `${notice} === null`);
    await until("stop offered again", `${text(".operator-toolbar button")} === "stop"`);
    // The icon again: the session's agents pane comes back, the icon dims.
    await click("button[aria-label='Hide operator']");
    await until("agents pane back", `document.querySelector(".agents-pane .chips") !== null`);
    await until("operator pane gone", `document.querySelector(".operator-pane") === null`);
    const iconOff = `document.querySelector("button[aria-label='Show operator']")?.ariaPressed`;
    await until("icon off", `${iconOff} === "false"`);
    await shot("84-operator-hidden");
    console.log("operator ok");
    await finish();
}

if (flow === "diff") {
    // The right pane's `diff` view (s012): the `previews` and `diff` tabs across the top; the
    // diff page with a repo switcher and `start diff` while no viewer runs; the `diff` job's
    // progress line; then the viewer's page in a focused frame that gets the viewer's keys;
    // a switch of repo; expand to the window; the services view's `diff` heading with stop
    // and restart; a one-repo start from the page once the other repo runs.
    const previewTab = ".preview-pane .view-tabs .view-tab";
    const frame = `document.querySelector(".preview-pane iframe.preview-frame")`;
    const frameSrc = `(${frame}?.src ?? "")`;
    const page = text(".diff-page");
    const progress = text(".diff-progress");
    await click(".session", process.env["E2E_SESSION"] ?? "Refund flow");
    await until("two top-level tabs", `document.querySelectorAll("${previewTab}").length === 2`);
    const labels = await evaluate(
        `[...document.querySelectorAll("${previewTab}")].map((t) => t.textContent)`,
    );
    if (JSON.stringify(labels) !== JSON.stringify(["previews", "diff"])) {
        throw new Error(`expected the tabs previews and diff, got ${JSON.stringify(labels)}`);
    }
    await click(previewTab, "diff");
    await until("repo switcher", `document.querySelectorAll(".diff-page .tab").length === 2`);
    await until("start diff offered", `${text(".diff-start")} === "start diff"`);
    await until("web stopped", `${progress}.includes("web is stopped.")`);
    await shot("60-diff-empty");
    await click(".diff-start");
    await until("job progress line", `${progress}.startsWith("diff · running")`);
    await until("fetch logged", `${progress}.includes("cloning")`);
    await shot("61-diff-starting");
    await until("web viewer framed", `${frameSrc}.includes("/diffview/web/")`);
    await until("no start button", `document.querySelector(".diff-start") === null`);
    await until("frame focused", `document.activeElement === ${frame}`);
    await until("web dot green", `document.querySelector(".diff-page .tab-selected .dot-running")`
        + ` !== null`);
    // The viewer's keys: the fixture's page records what reaches it.
    const viewerUrl = (await evaluate(frameSrc)) as string;
    for (const key of ["j", "k", "[", "]"]) {
        await send("Input.dispatchKeyEvent", { type: "keyDown", key, text: key });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key });
    }
    const keysUrl = `${viewerUrl}keys`;
    let keys: string[] = [];
    for (let tries = 0; tries < 50; tries += 1) {
        keys = ((await (await fetch(keysUrl)).json()) as { keys: string[] }).keys;
        if (keys.length >= 4) {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    console.log("keys in the frame:", JSON.stringify(keys));
    if (JSON.stringify(keys) !== JSON.stringify(["j", "k", "[", "]"])) {
        throw new Error("the viewer's keys did not reach the frame");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    await shot("62-diff-web");
    await click(".diff-page .tab", "api");
    await until("api viewer framed", `${frameSrc}.includes("/diffview/api/")`);
    await shot("63-diff-api");
    // Expand: the diff page takes the window and keeps its frame; Escape brings it back.
    if ((await evaluate(`document.querySelector("button[aria-label='Expand previews']")`
        + ` !== null`)) === true) {
        await click("button[aria-label='Expand previews']");
        await until("one pane", `document.querySelectorAll(".pane").length === 1`);
        await until("frame kept", `${frameSrc}.includes("/diffview/api/")`);
        await shot("64-diff-expanded");
        // Escape is the page's key; the focused frame keeps it, so the button brings it back.
        await click("button[aria-label='Restore layout']");
        await until("layout back", `document.querySelectorAll(".pane").length === 3`);
    }
    // The previews tab is still the service previews.
    await click(previewTab, "previews");
    await until("service tabs back", `${text(".preview-pane .tabs")}.includes("web")`);
    await until("diff page gone", `document.querySelector(".diff-page") === null`);
    // The services view: the `diff` heading, stop, restart.
    await click(".agents-pane .tab", "services");
    const row = (repo: string) => `document.querySelector(".diff-table tr[data-repo=${repo}]")`;
    await until("diff heading", `${text(".diff-heading")}.toLowerCase() === "diff"`);
    await until("web running in the table", `${row("web")}.innerText.includes("running")`);
    await evaluate(`[...${row("web")}.querySelectorAll("button")]`
        + `.find((b) => b.textContent === "stop").click(), true`);
    await until("web stopped in the table", `${row("web")}.innerText.includes("stopped")`);
    await evaluate(`[...${row("api")}.querySelectorAll("button")]`
        + `.find((b) => b.textContent === "restart").click(), true`);
    await until("api restarting", `${row("api")}.innerText.includes("starting")`);
    await until("api running again", `${row("api")}.innerText.includes("running")`);
    await shot("65-services-diff");
    // Back on the diff page, web is stopped while api runs: the start is for web alone.
    await click(previewTab, "diff");
    await until("api still shown", `${frameSrc}.includes("/diffview/api/")`);
    await click(".diff-page .tab", "web");
    await until("web stopped on the page", `${progress}.includes("web is stopped.")`);
    await until("one-repo start", `${text(".diff-start")} === "start diff · web"`);
    await click(".diff-start");
    await until("web framed again", `${frameSrc}.includes("/diffview/web/")`);
    await shot("66-diff-web-restarted");
    console.log("page text:", JSON.stringify(await evaluate(page)));
    console.log("diff ok");
    await finish();
}

if (flow === "bridge-diff") {
    // The desktop path of the diff view with the stub: the running viewer is a native view
    // under the key `<dir>/diff/<repo>` (no iframe), a repo switch hides it and sets the other
    // key, and the pane's pop-out takes the diff view along.
    const calls = `window.bridgeCalls`;
    const lastCall = (method: string) =>
        `${calls}.filter((c) => c.method === ${JSON.stringify(method)}).at(-1)`;
    const previewTab = ".preview-pane .view-tabs .view-tab";
    await click(".session", process.env["E2E_SESSION"] ?? "Refund flow");
    await until("diff tab", `document.querySelectorAll("${previewTab}").length === 2`);
    await click(previewTab, "diff");
    await until("start diff offered", `${text(".diff-start")} === "start diff"`);
    await click(".diff-start");
    await until("web view set", `${lastCall("set")}?.args[0].endsWith("/diff/web")`);
    await until("box, no iframe", `document.querySelector(".diff-page .preview-box") !== null`
        + ` && document.querySelector("iframe") === null`);
    const key = (await evaluate(`${lastCall("set")}.args[0]`)) as string;
    const url = (await evaluate(`${lastCall("set")}.args[1]`)) as string;
    console.log("diff view:", key, url);
    if (!url.includes("/diffview/web/")) {
        throw new Error("set() did not carry the viewer's URL");
    }
    await shot("67-bridge-diff-box");
    const quotedKey = JSON.stringify(key);
    const hides =
        `${calls}.filter((c) => c.method === "hide" && c.args[0] === ${quotedKey}).length`;
    const hidden = (await evaluate(hides)) as number;
    await click(".diff-page .tab", "api");
    await until("web hidden", `${hides} > ${hidden}`);
    await until("api view set", `${lastCall("set")}?.args[0].endsWith("/diff/api")`);
    await click("button[aria-label='Pop out previews']");
    await until("diff view popped", `${lastCall("previews.popOut")} !== undefined`);
    const popped = (await evaluate(`${lastCall("previews.popOut")}?.args[0]`)) as string;
    console.log("popped key:", popped);
    if (!popped.endsWith("/diff/api")) {
        throw new Error("pop out did not take the shown diff view along");
    }
    console.log("bridge diff ok");
    await finish();
}


if (flow === "costs") {
    // Costs (s013) against the fixture: the card and the context bar carry the session's
    // `$` figure (the tokens in the tooltip), the agent chip's tooltip its share and model;
    // the Usage section under the theme shows today, this week and this month (the fixture's
    // figures, computed here the same way), a chart of 30 day bars with a hover title, the
    // switch to week and month changes the bar count, and the tables by session and model.
    const session = process.env["E2E_SESSION"] ?? "Refund flow";
    await click(".session", session);
    const card = `document.querySelector(".session-selected .usage-cost")`;
    const bar = `document.querySelector(".context-bar .usage-cost")`;
    await until("card figure", `/^\\$\\d+\\.\\d\\d$/.test(${card}?.textContent ?? "")`);
    await until("context bar figure", `${bar}?.textContent === ${card}.textContent`);
    const figure = (await evaluate(`${card}.textContent`)) as string;
    const tooltip = (await evaluate(`${card}.title`)) as string;
    console.log("session cost:", figure, "·", tooltip);
    if (!/^[\d.]+k? in · [\d.]+k? out$/.test(tooltip)) {
        throw new Error("the cost tooltip did not carry the tokens");
    }
    const chip = (await evaluate(
        `document.querySelector(".chip-name[data-name=backend]")?.title`,
    )) as string;
    console.log("chip tooltip:", chip);
    if (!/\$\d+\.\d\d · anthropic\//.test(chip)) {
        throw new Error("the chip tooltip did not carry the agent's cost and model");
    }
    await shot("70-costs-card");
    await click("button[aria-label='Show settings']");
    await until("usage section", `document.querySelector(".usage-section") !== null`);
    const figureOf = (span: string) =>
        `document.querySelector(".usage-figure[data-span=${span}] dd")?.textContent`;
    await until("figures loaded", `${figureOf("month")} !== "…"`);
    const figures: string[] = [];
    for (const span of ["today", "week", "month"]) {
        figures.push((await evaluate(figureOf(span))) as string);
    }
    console.log("figures:", JSON.stringify(figures));
    // The fixture's amounts are a function of the date; the expected figures come from the
    // same function through the fixture module, and the UI's printer.
    const { figuresAt } = await import("../fixture/costs.ts");
    const { formatUsd } = await import("../src/costs.ts");
    const wanted = figuresAt(new Date());
    const expected = [wanted.today, wanted.week, wanted.month].map(formatUsd);
    if (JSON.stringify(figures) !== JSON.stringify(expected)) {
        throw new Error(`expected the figures ${JSON.stringify(expected)}`);
    }
    const bars = `document.querySelectorAll(".usage-bar").length`;
    await until("30 day bars", `${bars} === 30`);
    const title = await evaluate(`document.querySelector(".usage-bar title")?.textContent`);
    console.log("first bar:", title);
    if (!/^\w{3} \d+ · (\$|<\$)[\d.]+ · [\d.]+k? tokens$/.test(String(title))) {
        throw new Error("the bar's hover title is not `<day> · <cost> · <tokens> tokens`");
    }
    const rows = await evaluate(`({
        sessions: document.querySelectorAll("[aria-label='Cost by session'] tbody tr").length,
        models: document.querySelectorAll("[aria-label='Cost by model'] tbody tr").length,
        first: document.querySelector("[aria-label='Cost by session'] tbody tr")?.innerText,
    })`);
    console.log("tables:", JSON.stringify(rows));
    await shot("71-usage-day");
    await click(".usage-tab", "week");
    await until("12 week bars", `${bars} === 12`);
    await shot("72-usage-week");
    await click(".usage-tab", "month");
    await until("12 month bars", `${bars} === 12`);
    await until("month labels", `${text(".usage-axis")}.length > 0`);
    await shot("73-usage-month");
    await click(".usage-tab", "day");
    await until("30 day bars again", `${bars} === 30`);
    console.log("costs ok");
    await finish();
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
    await finish();
}

const title = `E2E ${Date.now() % 100000}`;
// The form is a view of the middle pane, opened from the card at the top of the list.
await click(".compose-new");
const newForm = `document.querySelector(".agents-pane form[aria-label='New session']")`;
await until("new form shown", `${newForm} !== null`);
await fill("textarea[aria-label='What this is about']", title);
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
await click(".agents-pane .tab", "services");
await until(
    "service healthy",
    `[...document.querySelectorAll(".services tbody tr")]
        .some((r) => r.innerText.includes("healthy"))`,
);
await until(
    "preview tab dot",
    `document.querySelector(".preview-pane .tab .tab-dot.dot-healthy")?.title === "healthy"`,
);
await click(".agents-pane .tab", "agents");
await click(".preview-pane .tab", "web");
// The proxy picks up a new route a moment after the service is healthy; reload like a user.
await new Promise((resolve) => setTimeout(resolve, 2500));
await click(".preview-bar button", "reload");
await new Promise((resolve) => setTimeout(resolve, 2000));
await until("preview frame", `document.querySelector(".preview-frame") !== null`);
await until("job finished", `${text(".drawer")}.includes("ok")`);
await shot("04-previews");

await until("verify enabled", `document.querySelector(".verified input")?.disabled === false`);
await click(".verified input");
await until("verified ticked", `document.querySelector(".verified input")?.checked === true`);
await shot("05-verified");
// The tick clears both ways: a second click sends DELETE and the daemon's view unticks it.
await until("untick enabled", `document.querySelector(".verified input")?.disabled === false`);
await click(".verified input");
await until("verified cleared", `document.querySelector(".verified input")?.checked === false`);
await until("no error", `document.querySelector(".drawer .needs-human") === null`);
await shot("05b-unverified");
await until("tick enabled again", `document.querySelector(".verified input")?.disabled === false`);
await click(".verified input");
await until("ticked again", `document.querySelector(".verified input")?.checked === true`);

await clickEndAction("close");
await until("session gone", `!${text(".sessions-pane")}.includes(${quoted})`);
await shot("06-closed");
console.log("lifecycle ok");
await finish();
