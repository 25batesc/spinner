// Drives the UI in headless Chrome over the DevTools protocol and saves a screenshot per step.
// Usage: node e2e/drive.ts <ui url> <screenshot dir> [flow]. Chrome must already listen on
// port 9333 (`--remote-debugging-port=9333`) or on `E2E_CDP_PORT`. The flow `lifecycle` runs:
// new session, up, previews, verify, close. The flow `agents` prompts the first running agent
// of the first session with a pi agent. The flow `panes` collapses, hides, restores, expands
// and opens the `?pane=` route; `bridge-popout` docks the desktop's popped-out windows back
// through a stub of the bridge. The flow `terminal` attaches a tty agent's terminal to the
// fixture's echo pty, types, resizes and opens the pane route; `drawer` drags, collapses and
// restores the job drawer under it. It works against the fixture server or the real daemon.
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
    // A tab left open keeps its sockets (a terminal's pty gets its size again on the next
    // fixture); close it before the throw.
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${target.id}`);
    throw new Error(`Timed out waiting for: ${label}`);
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

await send("Page.enable");
if (flow === "bridge-stub" || flow === "bridge-popout" || flow === "bridge-bar") {
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
    socket.close();
    process.exit(0);
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
    socket.close();
    process.exit(0);
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
    socket.close();
    process.exit(0);
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
                && !c.classList.contains("machine-line"))
            .map((c) => c.innerText).filter((t) => t !== "").join("\\n"),
        links: document.querySelectorAll(".pane-head a, .pane-head .link, .browser-bar a")
            .length,
        icons: document.querySelectorAll(".pane-head .icon-button, .browser-bar .icon-button")
            .length,
    })`);
    console.log("chrome:", JSON.stringify(chrome));
    const wanted = {
        bar: 1, barOn: "true", popOuts: 1, top: 1, inSessions: 1,
        context: ["Refund flow", "peer-review", "stack up", "⑂ 2",
            "Approve the refund copy in PR #412"].join("\n"),
        links: 0, icons: 8,
    };
    if (JSON.stringify(chrome) !== JSON.stringify(wanted)) {
        throw new Error("expected the bar lit, the toggle beside sessions, one pop-out, 8 icons");
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
    // icon hides it; the header toggle beside SESSIONS hides it too.
    await click(barButton);
    await until("left panel back at 260", `${widthOf(".sessions-pane")} === 260`);
    await until("bar icon on", `document.querySelector("${barButton}").ariaPressed === "true"`);
    await until("toggle beside sessions", `document.querySelectorAll("${topToggle}").length === 1`);
    await click(barButton);
    await until("hidden by the bar", `document.querySelector(".sessions-pane") === null`);
    await click(barButton);
    await until("shown by the bar", `${widthOf(".sessions-pane")} === 260`);
    await click(topToggle);
    await until("hidden by the header toggle", `document.querySelector(".sessions-pane") === null`);
    await click(barButton);
    await until("shown again", `${widthOf(".sessions-pane")} === 260`);
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
    await click(topToggle);
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
    const closeTarget = (id: string) => fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${id}`);
    for (const stale of await targets()) {
        await closeTarget(stale.id);
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
    await closeTarget(windows[0]?.id ?? "");
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
    socket.close();
    // This tab now sits on a `pane=` URL; the next run must not count it as a popped window.
    await closeTarget(target.id);
    process.exit(0);
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
    socket.close();
    process.exit(0);
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
    socket.close();
    process.exit(0);
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
    socket.close();
    process.exit(0);
}

if (flow === "sessions-panel") {
    // The side panel: a split card at the top (Adopt | + New session), then one block per
    // session of one height (title clamped to two lines, a badge line with the stage, the
    // stack and the PR count, a needs-you line), the per-PR lines as the card's tooltip and
    // no form in the panel. Either half of the top card opens its form as the middle pane's
    // view; cancel returns to agents; a created session is selected and the view returns.
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
    await click(".compose-adopt");
    const adoptForm = `document.querySelector(".agents-pane form[aria-label='Adopt PRs']")`;
    await until("adopt form in the middle pane", `${adoptForm} !== null`);
    const viewTabs = `document.querySelectorAll(".agents-pane .view-tabs").length`;
    await until("no view tabs", `${viewTabs} === 0`);
    await shot("53-compose-adopt");
    await click(".compose-actions button", "cancel");
    await until("back to agents", `${viewTabs} > 0`);
    await click(".compose-new");
    const newForm = `document.querySelector(".agents-pane form[aria-label='New session']")`;
    await until("new form in the middle pane", `${newForm} !== null`);
    const name = `E2E card ${Date.now() % 100000}`;
    await fill("[aria-label='New session title']", name);
    await shot("54-compose-new");
    await click(".compose-actions .primary");
    const picked = text(".session-selected");
    await until("new session selected", `${picked}.includes(${JSON.stringify(name)})`);
    const tabsBack = `document.querySelectorAll(".agents-pane .view-tabs").length > 0`;
    await until("view back to agents", tabsBack);
    await until("form gone", `${newForm} === null`);
    await shot("55-created-and-selected");
    console.log("sessions panel ok");
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
    socket.close();
    process.exit(0);
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
    for (const action of ["land", "reset"]) {
        await click(".actions button", action);
        await until(`${action} finished`, `${text(".drawer")}.includes("${action} · ok")`);
        await click(".drawer button", "close");
    }
    await shot("19-landed-reset");
    await click(".agents-pane .tab", "agents");
    await click(".agents-pane .tab", "context");
    await until("context shown", `document.querySelectorAll(".context-file").length > 0`);
    // Every file is a collapsible section: the first open, the rest and the commands closed;
    // the chevron toggles one; collapse all and expand all act on all of them.
    const openCount = `document.querySelectorAll(".context-file[data-open=true]").length`;
    const sections = `document.querySelectorAll(".context-file").length`;
    await until("only the first open", `${openCount} === 1 && ${sections} > 2`);
    const firstOpen = `document.querySelector(".context-file").dataset.open === "true"`;
    await until("the first one is the open one", firstOpen);
    const size = text(".context-file .context-size");
    await until("sizes shown", `/\\d+ lines? · \\d+ B/.test(${size})`);
    await shot("20-context");
    await click(".context-file:nth-child(2) .disclosure");
    await until("second opened by its chevron", `${openCount} === 2`);
    await click(".context-toolbar .link", "collapse all");
    await until("all collapsed", `${openCount} === 0`);
    await click(".context-toolbar .link", "expand all");
    await until("all expanded", `${openCount} === ${sections}`);
    await shot("20b-context-expanded");
    console.log("pipeline ok");
    socket.close();
    process.exit(0);
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
    socket.close();
    process.exit(0);
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
    await click(".actions button", "reset");
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
    socket.close();
    process.exit(0);
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
    socket.close();
    process.exit(0);
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
        head: [...document.querySelectorAll(".services th")].map((h) => h.textContent),
        rows: [...document.querySelectorAll(".services tbody tr")].map((r) =>
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
    console.log("line before and after a sample:", before, await evaluate(barLine));
    await shot("75-usage-updated");
    console.log("usage ok");
    socket.close();
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${target.id}`);
    process.exit(0);
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
    socket.close();
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${target.id}`);
    process.exit(0);
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
        // The pane's chrome: view tabs underlined with no title, the toolbar in three groups
        // with a tooltip per button and the irreversible ones marked, the agents as chips with
        // a state dot and a tooltip, the × only on the selected hosted chip, and the sub-tabs.
        const chrome = await evaluate(`({
            title: document.querySelectorAll(".agents-pane .pane-head").length,
            views: [...document.querySelectorAll(".view-tabs .view-tab")].map((t) => t.textContent),
            viewSelected: document.querySelector(".view-tabs .tab-selected")?.textContent,
            groups: [...document.querySelectorAll(".toolbar .toolbar-group")]
                .map((g) => [...g.querySelectorAll("button")].map((b) => b.textContent)),
            seps: document.querySelectorAll(".toolbar .toolbar-sep").length,
            untitled: [...document.querySelectorAll(".toolbar button")]
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
            title: 0,
            views: ["agents", "mission", "threads", "services"],
            viewSelected: "agents",
            groups: [["run local", "stop local"], ["create PR", "fix", "post", "approve", "land"],
                ["reset", "close"]],
            seps: 2,
            untitled: [],
            danger: ["land", "reset", "close"],
            chips: [
                { name: "backend", state: "working",
                  tip: "tty · anthropic/claude-fable-5-1 · working",
                  selected: true, stop: "Stop backend" },
                { name: "frontend", state: "off", tip: "rpc · anthropic/claude-sonnet-5-5 · off",
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
// The form is a view of the middle pane, opened from the card at the top of the list.
await click(".compose-new");
const newForm = `document.querySelector(".agents-pane form[aria-label='New session']")`;
await until("new form shown", `${newForm} !== null`);
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

await click(".actions button", "close");
await until("session gone", `!${text(".sessions-pane")}.includes(${quoted})`);
await shot("06-closed");
console.log("lifecycle ok");
socket.close();
