// Drives the UI in headless Chrome over the DevTools protocol and saves a screenshot per step.
// Usage: node e2e/drive.ts <ui url> <screenshot dir> [flow]. Chrome must already listen on
// port 9333 (`--remote-debugging-port=9333`) or on `E2E_CDP_PORT`. The flow `lifecycle` runs:
// new session, up, previews, verify, close. The flow `agents` prompts the first running agent
// of the first session with a pi agent. The flow `panes` collapses, hides, restores, pops out
// and opens the `?pane=` route; `bridge-popout` does the pop-out through a stub of the desktop
// bridge. It works against the fixture server or the real daemon.
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
if (flow === "panes") {
    // Start from the default layout once; the flow's own reload must keep what it stored.
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
    // The workbench layout in a browser: the activity bar and the top-left toggle show and
    // hide the left panel (no strip; the top bar then names the session with its PR badge), a
    // drag of its divider past the threshold hides it too; the previews collapse to the edge
    // strip by drag or by their header toggle and the strip restores them; the agents pane
    // never folds, its minimum stops a drag; expand gives the previews the window and Escape
    // or the same button brings the layout back; widths survive a reload; `pop out` opens the
    // pane in its own window and the strip docks it back (or a closed window docks itself);
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
    const barButton = ".activity-bar .icon-button";
    const topToggle = ".top-bar .icon-button";
    const noStrips = `document.querySelectorAll(".strip").length === 0`;
    await click(".session", process.env["E2E_SESSION"] ?? "Refund flow");
    const session = (await evaluate(
        `document.querySelector(".session-selected .muted").innerText`,
    )) as string;
    const chrome = await evaluate(`({
        bar: document.querySelectorAll("${barButton}").length,
        top: document.querySelectorAll("${topToggle}").length,
        links: document.querySelectorAll(".pane-head a, .pane-head .link, .browser-bar a")
            .length,
        icons: document.querySelectorAll(".pane-head .icon-button, .browser-bar .icon-button")
            .length,
    })`);
    console.log("chrome:", JSON.stringify(chrome));
    if (JSON.stringify(chrome) !== JSON.stringify({ bar: 1, top: 1, links: 0, icons: 9 })) {
        throw new Error("expected one bar icon, one top toggle, 9 chrome icons and no links");
    }
    await shot("39-default");
    // 1. The left divider dragged 200 px left: 260 - 200 is below the 180 threshold; no strip.
    await drag(0, -200);
    await until("left panel hidden", `document.querySelector(".sessions-pane") === null`);
    await until("no strip", noStrips);
    await until("top bar names the session", `${text(".top-title")} === "Refund flow"`);
    await until("pr badge", `${text(".pr-badge")}.includes("2")`);
    await until("bar icon off", `document.querySelector("${barButton}").ariaPressed === "false"`);
    await shot("40-left-hidden");
    // 2. The bar icon shows it again at the width before the drag; the top toggle hides it.
    await click(barButton);
    await until("left panel back at 260", `${widthOf(".sessions-pane")} === 260`);
    await until("title gone", `document.querySelector(".top-title") === null`);
    await click(topToggle);
    await until("hidden by the top toggle", `document.querySelector(".sessions-pane") === null`);
    await click(topToggle);
    await until("shown by the top toggle", `${widthOf(".sessions-pane")} === 260`);
    // 3. The previews divider dragged 400 px right: 520 - 400 is below the 240 threshold.
    await drag(1, 400);
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
    // 5. The agents pane never folds: a 900 px drag stops at its 240 px minimum (and the
    // previews maximum of 900).
    await drag(1, -900);
    await until("previews at their maximum", `${widthOf(".preview-pane")} === 900`);
    const agentsWidth = (await evaluate(widthOf(".agents-pane"))) as number;
    console.log("agents width at the stop:", agentsWidth);
    if (agentsWidth < 240) {
        throw new Error("the agents pane went below its minimum");
    }
    await shot("42-agents-minimum");
    await drag(1, 400);
    await until("previews narrower again", `${widthOf(".preview-pane")} < 600`);
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
    // 9. Pop out: a new window on the `?pane=` route, the strip docks it back.
    const targets = async () =>
        ((await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as {
            id: string; url: string;
        }[]).filter((t) => t.url.includes("pane=") && t.id !== target.id);
    const closeTarget = (id: string) => fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${id}`);
    // Windows left by an earlier run would be counted below; this Chrome is the test's own.
    for (const stale of await targets()) {
        await closeTarget(stale.id);
    }
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
    // The other way round: the operator closes the window and the pane docks itself.
    await click("button[aria-label='Pop out agents']", "", true);
    await until("agents popped strip", `${strip("agents")}?.textContent.includes("popped")`);
    windows = await popups();
    await closeTarget(windows[0]?.id ?? "");
    await until("agents docked on close", `document.querySelector(".agents-pane") !== null`);
    // 10. The route alone: one pane, no bar, strips, dividers or controls, same session.
    await send("Page.navigate", { url: `${uiUrl}?pane=agents&session=${session}` });
    await until("single pane", `document.querySelector(".layout-single .agents-pane") !== null`);
    await until("session shown", `${text(".agents-pane")}.includes("idle")`);
    const lone = await evaluate(`({
        strips: document.querySelectorAll(".strip").length,
        handles: document.querySelectorAll(".handle").length,
        controls: document.querySelectorAll(".pane-controls").length,
        bars: document.querySelectorAll(".activity-bar, .top-bar").length,
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
    // The desktop path of Plan 3 without Electron, with the stub above: `pop out` on the
    // previews pane calls `previews.popOut` with the shown tab's key and the pane becomes a
    // strip; the strip calls `previews.dockBack`, the docked event restores the pane and it
    // places the view again with `set`. The agents pane goes through `panes.popOut`, and a
    // docked event alone (the window's close button) restores it. After a reload the page asks
    // `panes.list` and shows the strip of a window that is still open.
    const calls = `window.bridgeCalls`;
    const lastCall = (method: string) =>
        `${calls}.filter((c) => c.method === ${JSON.stringify(method)}).at(-1)`;
    const strip = (pane: string) => `document.querySelector(".strip[data-pane=${pane}]")`;
    await click(".session", process.env["E2E_SESSION"] ?? "Refund flow");
    const session = (await evaluate(
        `document.querySelector(".session-selected .muted").innerText`,
    )) as string;
    await until("web tab", `document.querySelector(".preview-pane .tab") !== null`);
    await click(".preview-pane .tab", "web");
    await until("set called", `${lastCall("set")} !== undefined`);
    const key = `${session}/web`;
    const sets = (await evaluate(`${calls}.filter((c) => c.method === "set").length`)) as number;
    await click("button[aria-label='Pop out previews']");
    const quotedKey = JSON.stringify(key);
    await until("previews.popOut", `${lastCall("previews.popOut")}?.args[0] === ${quotedKey}`);
    await until("previews strip", `${strip("previews")}?.textContent.includes("popped")`);
    await shot("43-bridge-preview-popped");
    await click(".strip[data-pane=previews]");
    await until("previews.dockBack", `${lastCall("previews.dockBack")}?.args[0] === ${quotedKey}`);
    await until("pane back", `document.querySelector(".preview-pane .preview-box") !== null`);
    await until("view placed again", `${calls}.filter((c) => c.method === "set").length > ${sets}`);
    await click("button[aria-label='Pop out agents']");
    const argsOf = (method: string, args: string[]) =>
        `JSON.stringify(${lastCall(method)}?.args) === ${JSON.stringify(JSON.stringify(args))}`;
    await until("panes.popOut", argsOf("panes.popOut", ["agents", session]));
    await until("agents strip", `${strip("agents")}?.textContent.includes("popped")`);
    await evaluate(`window.bridgeDock({ pane: "agents", session: ${JSON.stringify(session)} })`);
    await until("agents back on close", `document.querySelector(".agents-pane") !== null`);
    if ((await evaluate(`${lastCall("panes.dockBack")}`)) !== undefined) {
        throw new Error("a close from the desktop side must not call dockBack");
    }
    const popped = JSON.stringify([{ pane: "sessions", session }]);
    await evaluate(`sessionStorage.setItem("e2e-popped", ${JSON.stringify(popped)})`);
    await evaluate(`window.__stale = true`);
    await send("Page.reload");
    await until("reloaded", `window.__stale === undefined`);
    await until("strip after reload", `${strip("sessions")}?.textContent.includes("popped")`);
    await shot("44-bridge-resumed-strip");
    await click(".strip[data-pane=sessions]");
    await until("panes.dockBack", argsOf("panes.dockBack", ["sessions", session]));
    await until("sessions back", `document.querySelector(".sessions-pane") !== null`);
    console.log("calls:", JSON.stringify(await evaluate(`${calls}.map((c) => c.method)`)));
    console.log("bridge popout ok");
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
    await shot("20-context");
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
