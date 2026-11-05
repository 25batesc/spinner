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
// switches repo, expands the pane, and stops and restarts a viewer from the services view. The
// flow `about-egm` reads the About EGM block in settings and watches it reload after a
// refetch. The flow `view-tabs` reads the row of view tabs with its step marks, the card's
// dots and the track chip, and folds the EGM tabs in a 1000 px window; `rounds` reads the
// round badge and its tooltip. Both read the fixture's EGM sessions. The flow `design-actions`
// runs the toolbar's design group: the primary button per stage, its dialogs, the `EGM ▾`
// menu, a refusal in the drawer and the compact menu; `design-gate` answers the gate card from
// the `needs you` pill, the resolve card, and a gate the lead asks while the page is open.
// Both read the fixture's `GET …/design/received`, so they run against the fixture only, as
// does `design-workspace`: the views of the agents pane by tab id, the round badge that opens
// History, a revision request, the done marks on Draft and the Implement list of the seeded
// session (session-workspace.md). The flow `sidebar` opens each
// view from the rail, collapses the panel from the lit icon, reads the needs-you badges,
// walks the three width levels and snaps the panel shut with the rail in place; `reload`
// reloads a session view and a review view and checks each comes back (s020). Both read the
// fixture's sessions. The flow `goldfish` reads the Goldfish chips of the fixture's design-review
// session, opens a transcript and watches it reload, returns to the lead, and reads the cap
// line and the Review tab's running count and cost tooltip; it runs against the fixture only.
// The flow `approve-design` approves the design-ready session through the blocker
// confirmation, removes the approval, and re-approves the changed session from the Design
// tab's banner with the changed section side by side, and reads the seed counts (build
// session 6; session-workspace.md); fixture only.
// The flow `composer` opens the composer in the working area from the sidebar, keeps its
// draft across a switch, and starts a session that opens on its lead and a review (s038);
// `archive` archives from a card, from the context bar's menu and from a review card, and
// reads the empty state (s038). Both run against the fixture only.
// The other flows work against the fixture server or the real daemon.
import { writeFileSync } from "node:fs";

import {
    EGM_LICENSE, EGM_NOTICE, EGM_SOURCE_URL, type SessionView,
} from "@spinner/protocol";
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

// `reset` and `archive` sit behind the toolbar's `⋯` menu in the context bar; `archive` asks
// once inside the menu before it runs the `close` job (s038).
async function clickEndAction(action: "reset" | "archive"): Promise<void> {
    await click(".toolbar-menu .icon-button");
    await until(`${action} in the menu`, `document.querySelector(".toolbar-menu .menu") !== null`);
    await click(".toolbar-menu .menu button", action);
    if (action === "archive") {
        await until("archive asks", `${text(".menu-confirm")}.includes("Archive this session?")`);
        await click(".menu-confirm button.danger", "archive");
    }
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

if (flow === "workspace") {
    // The Implement view (docs/designs/session-workspace.md, T6, entry 2.31). On the fixture
    // mission of a session without a design block: the editable goal, the sticky header with
    // the counts, the Plan as one `Plan` group with a state dot per row (doing first), the
    // Done-when checklist, the Roster in the rail, one open question, the Contracts and the
    // Log newest first. A tick writes through the item mode and comes back with the time; an
    // edit changes the text; a note reaches the owner's inbox; an answer steers the asker and
    // lands in the Log; the filter narrows the feed; `source` shows the rendered MISSION.md.
    await click(".session", process.env["E2E_SESSION"] ?? "Refund flow");
    await click(".agents-pane .tab", "Implement");
    await until("workspace shown", `document.querySelector(".im") !== null`);
    const phases = `[...document.querySelectorAll(".im-phase")].map((p) => [
        p.querySelector(".im-phase-label").textContent, p.dataset.open,
        [...p.querySelectorAll(".im-row")].map((r) => r.dataset.state)])`;
    const shape = await evaluate(`({
        phases: ${phases},
        header: [...document.querySelectorAll(".im-header .mw-pulse-pill")]
            .map((pill) => pill.textContent),
        sticky: getComputedStyle(document.querySelector(".im-header")).position,
        doneWhen: document.querySelectorAll(".mw-done-when .mw-item").length,
        agents: [...document.querySelectorAll(".im-rail .mw-agent-name")]
            .map((a) => a.textContent),
        live: [...document.querySelectorAll(".im-rail .im-live")].map((d) => d.dataset.state),
        questions: [...document.querySelectorAll(".im-rail .mw-questions .mw-question")]
            .map((q) => [q.dataset.state, q.querySelector(".mw-time")?.textContent ?? null]),
        questionCount: document.querySelector(".im-rail .mw-questions .mw-count")?.textContent,
        resolvedToggle: document.querySelector(".im-rail .mw-resolved-toggle")?.textContent,
        contracts: document.querySelectorAll(".im-rail .mw-contracts .mw-item").length,
        log: [...document.querySelectorAll(".mw-feed .mw-line-text")].map((l) => l.textContent),
        goal: document.querySelector(".mw-goal .mw-text")?.textContent,
    })`);
    console.log("workspace:", JSON.stringify(shape));
    const wanted = {
        phases: [["Plan", "true", ["doing", "next", "done"]]],
        header: ["plan 1 / 3", "1 in progress", "done when 1 / 2", "1 open question",
            "frontend blocked"],
        sticky: "sticky",
        doneWhen: 2, agents: ["backend", "frontend"], live: ["working", "blocked"],
        // The open question (old unstamped form) first, then the answered one with its time;
        // the resolved one folds (#43).
        questions: [["open", null], ["answered", "10:06"]],
        questionCount: "1 open", resolvedToggle: "\u25b8 1 resolved",
        contracts: 1,
        log: ["button wired", "route done", "session created"],
        goal: "Let a customer request a refund.",
    };
    if (JSON.stringify(shape) !== JSON.stringify(wanted)) {
        throw new Error("the workspace does not show the fixture mission as expected");
    }
    await shot("80-workspace");
    // The `doing` filter keeps the one doing row; off again, every row returns.
    await click(".im-doing-filter");
    await until("doing rows alone", `${phases}[0][2].join() === "doing"`);
    await click(".im-doing-filter");
    await until("every row again", `${phases}[0][2].length === 3`);
    // Tick Plan item 2 (`next`): its row reads `done` with the owner and a time, sorted last.
    await click(".mw-item[data-id='plan:2'] .mw-check");
    const doneItem =
        `document.querySelector(".im-row[data-state=done] .mw-item[data-id='plan:2']")`;
    await until("item 2 done", `${doneItem} !== null`);
    await until("tick time shown", `${doneItem}.querySelector(".mw-time") !== null`);
    await until("plan count moved", `${text(".im-header")}.includes("plan 2 / 3")`);
    await shot("81-workspace-ticked");
    // Edit Plan item 3's text in place.
    await click(".mw-item[data-id='plan:3'] .mw-item-actions button", "edit");
    await fill(".mw-item[data-id='plan:3'] textarea", "the Stripe refund call");
    await click(".mw-item[data-id='plan:3'] .mw-inline .primary", "save");
    const item3 = text(".mw-item[data-id='plan:3'] .mw-item-text");
    await until("item 3 edited", `${item3}.includes("the Stripe refund call")`);
    // A note on item 3 goes to its owner's inbox: the drawer's events show the delivery.
    await click(".mw-item[data-id='plan:3'] .mw-item-actions button", "note");
    await fill(".mw-item[data-id='plan:3'] textarea", "Use the idempotency key.");
    await click(".mw-item[data-id='plan:3'] .mw-inline .primary", "send");
    await until("note reached backend", `${text(".drawer")}.includes("operator → backend")`);
    // The answer is written under the question (#43), steers backend (running on the
    // fixture), and adds no Log line; the question reads answered and leaves the pulse.
    await fill("input[aria-label='Answer 1']", "No, full refunds only in round one.");
    await click(".mw-questions .mw-answer-form button[type=submit]");
    const firstQuestion = `document.querySelector(".mw-question[data-id='open_questions:1']")`;
    await until("answer under the question", `${firstQuestion}?.dataset.state === "answered"
        && ${firstQuestion}.querySelector(".mw-answer").textContent
            .endsWith("operator: No, full refunds only in round one.")`);
    await until("no open question left", `!${text(".im-header")}.includes("open question")
        && ${text(".im-rail .mw-questions .mw-count")} === "0 open"`);
    await until("no Log line for the answer", `!${text(".mw-feed")}.includes("full refunds")`);
    // The resolved fold opens on a click and shows who resolved the question and why.
    await click(".mw-resolved-toggle");
    await until("resolved shown", `${text(".mw-question[data-state=resolved] .mw-resolution")}
        === "resolved by lead at 10:09: POST /refunds, in Contracts"`);
    // The lead resolves question 1 through the route: it moves into the fold.
    const resolve = await fetch(new URL(
        "/sessions/s17-refund-flow/mission/section", uiUrl), {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({
            section: "open_questions", mode: "item", text: "", author: "lead",
            item: { command: "resolve", id: 1, text: "Full refunds only, see Contracts" },
        }),
    });
    await expectSame("resolve status", resolve.status, 200);
    await until("question 1 folded", `${firstQuestion}?.dataset.state === "resolved"
        && ${text(".mw-resolved-toggle")}.endsWith("2 resolved")`);
    await evaluate(`document.querySelector(".im-rail .mw-questions").scrollIntoView()`);
    await shot("81a-workspace-questions");
    // The filter narrows the feed to one agent.
    await click(".mw-filter-chip", "frontend");
    const lines =
        `[...document.querySelectorAll(".mw-feed .mw-line-text")].map((l) => l.textContent)`;
    await until("frontend's line alone", `JSON.stringify(${lines}) === '["button wired"]'`);
    await click(".mw-filter-chip", "all");
    await until("every line again", `${lines}.length >= 3`);
    await shot("82-workspace-after-actions");
    // The source view: the rendered MISSION.md with the Roster table, and its raw toggle.
    await click(".mission-head .link", "source");
    await until("source rendered", `document.querySelector(".mission .md table") !== null`);
    await until("tick in the source", `${text(".mission .md")}.includes("the form")`);
    await shot("83-workspace-source");
    await click(".mission-head .link", "workspace");
    await until("workspace again", `document.querySelector(".im") !== null`);
    console.log("workspace ok");
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
    // (title, stage, stack, PR badge, needs-you line); the rail at the far left (s020 round
    // 2, VS Code's shape) has sessions, reviews, the operator and the gear, the open view's
    // icon lit; the lit icon folds the side panel (no strip) and the rail stays; the icon
    // opens it again; a drag of the panel's divider 60 px past
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
        title: document.querySelector(".sidebar .side-title-label")?.textContent,
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
        // The rail: sessions (lit), reviews, the operator, the gear; the panel titled.
        bar: 4, barOn: "true", title: "Sessions", popOuts: 1, top: 0, inSessions: 0,
        // `$3.27` is the fixture session's cost (s013), between the stack and the PR badge.
        context: ["Refund flow", "peer-review", "stack up", "$3.27", "⑂ 2",
            "Approve the refund copy in PR #412"].join("\n"),
        links: 0, icons: 7,
    };
    if (JSON.stringify(chrome) !== JSON.stringify(wanted)) {
        throw new Error(
            "expected the rail (sessions lit, reviews, operator, gear), 1 pop-out, 7 icons",
        );
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
    await until("parked at the minimum", `${widthOf(".sidebar")} === 140`);
    await until("not armed", `document.querySelector(".layout[data-armed]") === null`);
    await drag(0, 120);
    await until("back to 260", `${widthOf(".sidebar")} === 260`);
    const releaseLeft = await dragHold(0, -200);
    await until("armed", `document.querySelector(".layout[data-armed=sessions]") !== null`);
    await until("still at the minimum", `${widthOf(".sidebar")} === 140`);
    const faded = `getComputedStyle(document.querySelector(".sidebar")).opacity`;
    await until("panel faded", `${faded} === "0.35"`);
    await shot("39b-left-armed");
    await releaseLeft();
    await until("left panel hidden", `document.querySelector(".sidebar") === null`);
    await until("no strip", noStrips);
    await until("context bar stays", `${text(".context-title")} === "Refund flow"`);
    // The rail stays, its icon dimmed, as the way back.
    await until("no toggle anywhere", `document.querySelectorAll("${topToggle}").length === 0`);
    await until("rail in place", `${widthOf(".activity-bar")} >= 40`);
    await until("bar icon off", `document.querySelector("${barButton}").ariaPressed === "false"`);
    await shot("40-left-hidden");
    // 2. The rail's sessions icon shows it again at the width before the drag and lights up;
    // the lit icon folds it again. There is no toggle in a pane header.
    await click(barButton);
    await until("left panel back at 260", `${widthOf(".sidebar")} === 260`);
    await until("bar icon on", `document.querySelector("${barButton}").ariaPressed === "true"`);
    await until("no header toggle", `document.querySelectorAll("${topToggle}").length === 0`);
    await click(barButton);
    await until("folded by the icon", `document.querySelector(".sidebar") === null`);
    await click(barButton);
    await until("shown by the rail", `${widthOf(".sidebar")} === 260`);
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
    // of the width (about 1500 - 40 rail - 260 - 12 - 280 = 908 px, past any fraction of
    // the window).
    await drag(1, -1200);
    await until("agents at their minimum", `${widthOf(".agents-pane")} === 280`);
    const previewsWidth = (await evaluate(widthOf(".preview-pane"))) as number;
    console.log("previews width at the stop:", previewsWidth);
    if (previewsWidth < 900) {
        throw new Error("the previews stopped short of the agents minimum");
    }
    await shot("42-agents-minimum");
    await drag(1, previewsWidth - 500);
    await until("previews narrower again", `${widthOf(".preview-pane")} < 520`);
    // 6. Left panel hidden plus previews collapsed: the agents take the window.
    await click(barButton);
    await click("button[aria-label='Collapse previews']");
    await until("agents fill the window", `${widthOf(".agents-pane")} > 1400`);
    await shot("43-agents-whole-window");
    await click(barButton);
    await click(".strip[data-pane=previews]");
    await until("three panes again", `${widthOf(".sidebar")} === 260`);
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
    await until("left panel at 400", `${widthOf(".sidebar")} === 400`);
    const stored = await evaluate(`localStorage.getItem("spinner.layout.v2")`);
    console.log("stored layout:", stored);
    await reload();
    await until("still 400", `${widthOf(".sidebar")} === 400`);
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
    // The route opens on the session's default view, Implement here; the chat is in Agents.
    await click(".agents-pane .view-tab", "Agents");
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
    // reason. An untick survives a re-extraction. The `+ New session` button pinned under the
    // sessions panel's title opens the composer in the working area (s038); another session,
    // another view and back keep the draft. `Start` creates the session, which is selected
    // and opens on the lead's terminal; the composer goes, and the next open finds it empty.
    const form = `document.querySelector(".composer form[aria-label='New session']")`;
    const addNew = ".sidebar button.side-add[aria-label='New session']";
    await click(addNew);
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
    // A look at another session and at the reviews view keep the draft.
    await click(".session", "Refund flow");
    await until("agents shown", `document.querySelector(".agents-pane .view-tabs") !== null`);
    await until("composer left", `${form} === null`);
    await click(".activity-bar button[aria-label='Show reviews']");
    await until("reviews view", `document.querySelector(".reviews-pane") !== null`);
    await click(".activity-bar button[aria-label='Show sessions']");
    await click(addNew);
    await until("compose back", `${form} !== null`);
    const draftKept = await evaluate(
        `document.querySelector("textarea[aria-label='What this is about']").value`,
    );
    if (draftKept !== paste) {
        throw new Error("the draft did not survive a look at another session and a fold");
    }
    await until("PRs found again", `${boxes}.length === 3`);
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
    await until("composer gone", `${form} === null`);
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
    await click(addNew);
    const draft = `document.querySelector("textarea[aria-label='What this is about']")?.value`;
    await until("next box empty", `${draft} === ""`);
    console.log("compose ok");
    await finish();
}

if (flow === "sessions-panel") {
    // The sessions view of the side panel (s020): the title row, the `+ New session` button
    // pinned under it (it opens the composer in the working area, s038), then one
    // block per
    // session of one height (title clamped to two lines, a badge line with the stage, the
    // stack and the PR count, a needs-you line), the per-PR lines as the card's tooltip. The
    // list scrolls inside the panel while the button stays put; a created session is selected,
    // and the agents view replaces the composer in the middle pane.
    const cards = `[...document.querySelectorAll(".session")]`;
    const shape = (await evaluate(`({
        heights: [...new Set(${cards}.map((c) => c.getBoundingClientRect().height))],
        prLines: document.querySelectorAll(".pr-line").length,
        forms: document.querySelectorAll(".sessions-pane .side-compose button.side-add").length,
        middleForms: document.querySelectorAll(".agents-pane form[aria-label='New session']")
            .length,
        composeCards: document.querySelectorAll(".compose-card, .compose-new").length,
        tooltip: document.querySelector(".session").title,
        badge: document.querySelector(".session .pr-badge")?.innerText ?? null,
    })`)) as { heights: number[]; prLines: number; forms: number; middleForms: number;
        composeCards: number; tooltip: string; badge: string | null };
    console.log("cards:", JSON.stringify(shape));
    const uniform = shape.heights.length === 1 && shape.heights[0] === 92;
    if (!uniform || shape.prLines !== 0) {
        throw new Error("the cards are not uniform 92 px blocks");
    }
    if (shape.forms !== 1 || shape.middleForms !== 0 || shape.composeCards !== 0) {
        throw new Error("the + New session button is not pinned in the panel alone");
    }
    if (!shape.tooltip.includes("web#412") || shape.badge !== "\u2442 2") {
        throw new Error("the PR lines did not move into the tooltip with a count badge");
    }
    await shot("52-session-cards");
    // The list scrolls under the button: the button keeps its place.
    const boxTop =
        `Math.round(document.querySelector(".side-compose").getBoundingClientRect().top)`;
    const topBefore = await evaluate(boxTop);
    await evaluate(`(document.querySelector(".sidebar .session-list").scrollTop = 400, true)`);
    await until("list scrolled", `document.querySelector(".sidebar .session-list").scrollTop > 0`);
    const topAfter = await evaluate(boxTop);
    if (topBefore !== topAfter) {
        throw new Error("the + New session button scrolled with the list");
    }
    await shot("53-list-scrolled-box-pinned");
    await click(".side-compose button.side-add");
    const form = `document.querySelector(".composer form[aria-label='New session']")`;
    await until("composer opened", `${form} !== null`);
    const name = `E2E card ${Date.now() % 100000}`;
    await fill("textarea[aria-label='What this is about']", name);
    await shot("54-compose-new");
    await click(".composer .compose-actions .primary", "Start");
    const picked = text(".session-selected");
    await until("new session selected", `${picked}.includes(${JSON.stringify(name)})`);
    const tabs = `document.querySelectorAll(".agents-pane .view-tabs").length > 0`;
    await until("agents view in the middle", tabs);
    await until("composer gone", `${form} === null`);
    await shot("55-created-and-selected");
    console.log("sessions panel ok");
    await finish();
}

if (flow === "sidebar" || flow === "reload") {
    // Shared by the two sidebar flows (s020): a width, a drag of the first divider (the
    // panel's), a reload that waits for the new document, and the rail's selectors.
    const widthOf = (selector: string) =>
        `Math.round(document.querySelector(${JSON.stringify(selector)})` +
        `?.getBoundingClientRect().width ?? -1)`;
    const handleAt = async () =>
        (await evaluate(`(() => {
            const r = document.querySelector(".handle").getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + 300 };
        })()`)) as { x: number; y: number };
    // Holds the button until the returned release runs, so the armed state shows mid-drag.
    const dragHold = async (dx: number) => {
        const at = await handleAt();
        const mouse = (type: string, x: number) =>
            send("Input.dispatchMouseEvent", {
                type, x, y: at.y, button: "left", buttons: 1, clickCount: 1,
            });
        await mouse("mousePressed", at.x);
        for (let step = 1; step <= 5; step += 1) {
            await mouse("mouseMoved", at.x + (dx * step) / 5);
        }
        return () => mouse("mouseReleased", at.x + dx);
    };
    const drag = async (dx: number) => (await dragHold(dx))();
    const reload = async () => {
        await evaluate(`window.__stale = true`);
        await send("Page.reload");
        await until("reloaded", `window.__stale === undefined`);
        await until("daemon connected again", `${text(".status")}.includes("open")`);
    };
    const level = `document.querySelector(".sidebar")?.dataset.level`;
    const shown = (selector: string) => `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return el !== null && getComputedStyle(el).display !== "none";
    })()`;
    const title = text(".sidebar .side-title-label");
    const sideRecord = `sessionStorage.getItem("spinner.sidebar.v2")`;
    const rail = (label: string) => `.activity-bar button[aria-label='${label}']`;
    const lit = `[...document.querySelectorAll(".activity-bar .icon-button")]
        .filter((b) => b.ariaPressed === "true").map((b) => b.ariaLabel).join(",")`;

    if (flow === "sidebar") {
        // VS Code's shape (s020, round 2): the rail stays at the far left, sessions and
        // reviews at the top, the gear at the bottom, each list icon with its needs-you badge
        // at all times. An icon opens its view in the one side panel, titled with its name,
        // count and needs pill; the lit icon collapses the panel and the rail stays; the
        // state survives a reload. The panel's width picks one of three detail levels; a drag
        // past the snap point folds it, and the rail's icon opens it again.
        const body = (await (await fetch(new URL("/sessions", uiUrl))).json()) as
            SessionView[] | { sessions: SessionView[] };
        const views = Array.isArray(body) ? body : body.sessions;
        const needs = (view: SessionView) =>
            (view.board === null ? view.summary.session.needs_human : view.board.needs_human)
                !== null;
        // The badge leaves out every session the operator has looked at: a pick marks its
        // needs-you line seen (`sidebar.ts` `markSeen`). The rail switch selects the first
        // row of the other list, so that row counts as seen from then on.
        const seenDirs: string[] = [];
        const noteSelected = async () => {
            const dir = await evaluate(`document.querySelector(
                ".session-selected, .rv-card-selected")?.dataset.dir ?? null`) as string | null;
            if (dir !== null && !seenDirs.includes(dir)) {
                seenDirs.push(dir);
            }
        };
        await noteSelected();
        const countOf = (review: boolean) => String(views.filter((view) =>
            (view.kind === "review") === review && needs(view) &&
            !seenDirs.includes(view.summary.dir)).length);
        const badgesNow = () =>
            JSON.stringify({ sessions: countOf(false), reviews: countOf(true) });
        const wantedBadges = badgesNow();
        const badges = `JSON.stringify(Object.fromEntries([...document
            .querySelectorAll(".activity-bar .bar-badge")]
            .map((b) => [b.dataset.section, b.textContent])))`;
        await until("panel open", `document.querySelector(".sidebar") !== null`);
        const start = await evaluate(`(() => {
            const buttons = [...document.querySelectorAll(".activity-bar .icon-button")];
            const box = (b) => b.getBoundingClientRect();
            const gear = buttons[buttons.length - 1];
            return {
                rail: buttons.map((b) => b.ariaLabel),
                gearAtBottom: box(gear).top > box(buttons[1]).bottom + 300,
                title: ${title},
                addNew: document.querySelectorAll(".sidebar button.side-add").length,
                badges: ${badges},
            };
        })()`);
        console.log("start:", JSON.stringify(start));
        const wantedStart = {
            rail: ["Hide sessions", "Show reviews", "Show operator", "Show settings"],
            gearAtBottom: true, title: "Sessions", addNew: 1, badges: wantedBadges,
        };
        if (JSON.stringify(start) !== JSON.stringify(wantedStart)) {
            throw new Error("the rail, the titled sessions panel and the badges are not right");
        }
        await shot("sidebar2-1-sessions-open");
        // One view at a time: reviews replaces sessions; the badges stay on the icons.
        await click(rail("Show reviews"));
        await until("reviews titled", `${title} === "Reviews"`);
        await until("reviews alone", `document.querySelector(".sessions-pane") === null &&
            document.querySelector(".reviews-pane") !== null`);
        await until("reviews lit", `${lit} === "Hide reviews"`);
        await until("New review pinned",
            `document.querySelector(".sidebar button.side-add[aria-label='New review']") !== null`);
        // The switch focused the reviews list: a review is selected and its line is seen.
        await until("a review selected", `document.querySelector(".rv-card-selected") !== null`);
        await noteSelected();
        await until("badges kept", `${badges} === ${JSON.stringify(badgesNow())}`);
        await shot("sidebar2-2-reviews-open");
        // The gear opens settings in the same panel, its own head hidden under the title.
        await click(rail("Show settings"));
        await until("settings titled", `${title} === "Settings"`);
        await until("settings shown", shown(".sidebar .settings-pane"));
        await until("gear lit", `${lit} === "Hide settings"`);
        await shot("sidebar2-3-settings-open");
        // The lit icon collapses the panel; the rail and its badges stay; a reload keeps it.
        await click(rail("Hide settings"));
        await until("collapsed", `document.querySelector(".sidebar") === null`);
        await until("rail stays", `${widthOf(".activity-bar")} >= 40`);
        await until("nothing lit", `${lit} === ""`);
        await until("record collapsed", `${sideRecord} === '{"view":null}'`);
        await reload();
        await until("still collapsed", `document.querySelector(".sidebar") === null`);
        await until("badges while collapsed", `${badges} === ${JSON.stringify(badgesNow())}`);
        await shot("sidebar2-4-collapsed-badges");
        await click(rail("Show sessions"));
        await until("sessions back at 260", `${widthOf(".sidebar")} === 260 && ${title} ===
            "Sessions"`);
        // The three detail levels follow the width: 260 full, 210 pills, 160 title.
        await until("full at 260", `${level} === "full"`);
        await until("needs line shown", shown(".session-needs"));
        await shot("sidebar2-5-level-full-260");
        await drag(-50);
        await until("pills at 210", `${widthOf(".sidebar")} === 210 && ${level} === "pills"`);
        await until("pills: badges kept", shown(".session .badges"));
        await until("pills: needs line gone", `!${shown(".session-needs")}`);
        await shot("sidebar2-6-level-pills-210");
        await drag(-50);
        await until("title at 160", `${widthOf(".sidebar")} === 160 && ${level} === "title"`);
        await until("title: badges gone", `!${shown(".session .badges")}`);
        await until("title: still a title", shown(".session-title"));
        await shot("sidebar2-7-level-title-160");
        await drag(100);
        await until("full again", `${widthOf(".sidebar")} === 260 && ${level} === "full"`);
        // A drag past the snap point folds the panel on release; the rail stays.
        const release = await dragHold(-200);
        await until("armed", `document.querySelector(".layout[data-armed=sessions]") !== null`);
        await release();
        await until("folded", `document.querySelector(".sidebar") === null`);
        await until("rail after the fold", `${widthOf(".activity-bar")} >= 40`);
        await until("icon dimmed", `${lit} === ""`);
        await until("fold recorded", `${sideRecord} === '{"view":null}'`);
        await click(rail("Show reviews"));
        await until("reopened on reviews at 260",
            `${widthOf(".sidebar")} === 260 && ${title} === "Reviews"`);
        await reload();
        await until("view kept on reload", `${title} === "Reviews" && ${lit} === "Hide reviews"`);
        await shot("sidebar2-8-reopened-from-rail");
        console.log("sidebar ok");
        await finish();
    }

    // The reload bug (s020): before, no key held the selection, so a reload fell back to
    // the first session of all, a review that waits on its draft. A fresh window opens on a
    // session; a session view reloads to the same session and a review view to the same
    // review, with the other list's pick kept for the way back.
    const context = text(".context-title");
    const record = `sessionStorage.getItem("spinner.focus.v1")`;
    if ((await evaluate(`document.querySelector(".rv-context") !== null`)) === true) {
        throw new Error("a fresh window opened on a review");
    }
    await click(rail("Show reviews"));
    await until("reviews open", `document.querySelector(".rv-card") !== null`);
    await click(".rv-card[data-dir='r77-web-77'] .rv-card-body");
    await until("review shown", `${context} === "Dark mode for the settings page"`);
    await click(rail("Show sessions"));
    await until("sessions open", `document.querySelector(".session") !== null`);
    await click(".session[data-dir='s001-bootstrap']");
    await until("session shown", `${context} === "Bootstrap: Spinner builds Spinner"`);
    await reload();
    await until("same session after reload",
        `${context} === "Bootstrap: Spinner builds Spinner"`);
    await until("its card selected",
        `document.querySelector(".session-selected")?.dataset.dir === "s001-bootstrap"`);
    await until("sessions view kept", `${title} === "Sessions"`);
    await shot("reload-1-session-view-survives");
    await click(rail("Show reviews"));
    await until("reviews again", `document.querySelector(".rv-card") !== null`);
    await click(".rv-card[data-dir='r51-peanut-51'] .rv-card-body");
    await until("other review shown", `${context} === "Retry the upload on 5xx"`);
    await reload();
    await until("same review after reload", `${context} === "Retry the upload on 5xx"`);
    await until("reviews view kept", `${title} === "Reviews"`);
    await until("its card selected",
        `document.querySelector(".rv-card-selected")?.dataset.dir === "r51-peanut-51"`);
    const kept = JSON.parse(String(await evaluate(record))) as Record<string, string>;
    console.log("focus record:", JSON.stringify(kept));
    const wantedRecord = { panel: "reviews", session: "s001-bootstrap", review: "r51-peanut-51" };
    if (JSON.stringify(kept) !== JSON.stringify(wantedRecord)) {
        throw new Error("the focus record must keep both picks and the active list");
    }
    await shot("reload-2-review-view-survives");
    console.log("reload ok");
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
    await click(".agents-pane .tab", "Implement");
    await until("mission shown", `document.querySelector(".im") !== null`);
    await click(".mw-goal .mw-text");
    await fill("textarea[aria-label='Edit goal']", "Let a customer ask for a refund. Edited.");
    await click(".mw-goal .mw-inline .primary", "save");
    await until("goal changed", `${text(".mw-goal")}.includes("Edited.")`);
    await shot("13-mission-edited");
    await click(".agents-pane .tab", "Threads");
    await until("threads shown", `document.querySelectorAll(".thread").length > 0`);
    await shot("14-threads");
    await fill("input[aria-label='Reply to T1']", "Fixed in the next push.");
    await click(".thread-actions button", "reply");
    await until("reply shown", `${text(".threads")}.includes("Fixed in the next push.")`);
    await click(".thread-actions button", "flag");
    await until("flag shown", `${text(".threads")}.includes("Flag:")`);
    await shot("15-thread-replied-flagged");
    for (const action of ["create PR", "review", "fix"]) {
        await click(".actions button", action);
        await until(`${action} finished`, `${text(".drawer")}.includes("ok")`);
        if (action === "review") {
            // The swarm (s015): the reviewers are agents of the session, so their chips show.
            await until("review log", `${text(".drawer")}.includes("POSTED")`);
            await until("reviewer chips",
                `${text(".agents-pane .chips")}.includes("review-anthropic-claude-opus-5-5")`);
        }
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
    await click(".agents-pane .tab", "Agents");
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
    // The file renders as markdown: a table, read-only task boxes, a highlighted fence; the
    // script in the fixture's file is gone. `raw` shows the text; `rendered` brings it back.
    const rendered = await evaluate(`({
        tables: document.querySelectorAll(".context-file .md table").length,
        boxes: [...document.querySelectorAll(".context-file .md input[type=checkbox]")]
            .map((b) => [b.checked, b.disabled]),
        keyword: document.querySelectorAll(".context-file .md .hljs-keyword").length,
        scripts: document.querySelectorAll(".context-file .md script").length,
        ran: window.contextScriptRan === true,
    })`);
    console.log("rendered:", JSON.stringify(rendered));
    const wantedRendered = {
        tables: 1, boxes: [[true, true], [false, true]], keyword: 1, scripts: 0, ran: false,
    };
    if (JSON.stringify(rendered) !== JSON.stringify(wantedRendered)) {
        throw new Error("the context file is not rendered and sanitized as expected");
    }
    await shot("20a-context-rendered");
    await click(".context-file:nth-child(2) .md-toolbar .link", "raw");
    await until("raw text", `${text(".context-file:nth-child(2) pre")}.includes("| Rule |")`);
    await click(".context-file:nth-child(2) .md-toolbar .link", "rendered");
    const tables = `document.querySelectorAll(".context-file .md table").length`;
    await until("rendered again", `${tables} === 1`);
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
    await click(".agents-pane .tab", "Implement");
    await until("mission shown", `document.querySelector(".im") !== null`);
    await shot("21-real-mission");
    await click(".agents-pane .tab", "Threads");
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
    await click(".agents-pane .tab", "Implement");
    await until("mission shown", `document.querySelector(".im") !== null`);
    await click(".mw-goal .mw-text");
    await fill("textarea[aria-label='Edit goal']", "Let a customer ask for a refund.");
    await click(".mw-goal .mw-inline .primary", "save");
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
    await click(".agents-pane .tab", "Threads");
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
    await click(".agents-pane .tab", "Agents");
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
    await click(".agents-pane .tab", "Agents");
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
    // rail opens the view in the side panel (s020); the theme select lists
    // system, light, dark and the valid custom theme, the invalid one is struck through with
    // its missing keys; picking light changes the page's `--bg` and the terminal's
    // background, dark changes them again, system brings the stylesheet's defaults back; each
    // change arrives as the `settings` event, which the select follows.
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
    // A session without a design block opens on Implement (session-workspace.md T5); the
    // terminal is in the Agents view.
    await click(".agents-pane .view-tab", "Agents");
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
    // The Review block: the defaults show, a change enables save, the save goes through
    // PUT /settings and the `settings` event brings the stored values back into the fields.
    const modelsField = `document.querySelector("textarea[aria-label='Review models']")`;
    const nField = `document.querySelector("input[aria-label='Reviews per PR']")`;
    const saveReview = `[...document.querySelectorAll(".review-setting button")]
        .find((b) => b.textContent === "save review settings")`;
    await until("review defaults", `${modelsField}.value.split("\\n").length === 3`);
    await until("save off while clean", `${saveReview}.disabled === true`);
    await fill("textarea[aria-label='Review models']", "a/one\nb/two\n");
    await fill("input[aria-label='Reviews per PR']", "2");
    await until("save on", `${saveReview}.disabled === false`);
    await click(".review-setting button", "save review settings");
    await until("review stored", `${saveReview}.disabled === true && ${nField}.value === "2"`);
    await until("models stored", `${modelsField}.value === "a/one\\nb/two"`);
    await shot("79-settings-review");
    // The lit gear collapses the panel (s020 round 2); the sessions icon opens the sessions
    // view again; from settings, the reviews icon swaps the panel to reviews.
    await click("button[aria-label='Hide settings']");
    await until("panel collapsed", `document.querySelector(".sidebar") === null`);
    await click("button[aria-label='Show sessions']");
    await until("sessions view back", `document.querySelector(".session-list") !== null`);
    await click("button[aria-label='Show settings']");
    await until("settings again", `document.querySelector(".settings-pane") !== null`);
    await click("button[aria-label='Show reviews']");
    await until("settings left", `document.querySelector(".settings-pane") === null`);
    await until("reviews open", `document.querySelector(".sidebar .rv-list") !== null`);
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
    await click(".agents-pane .tab", "Services");
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
    // A session without a design block opens on Implement (session-workspace.md T5); the
    // terminal is in the Agents view.
    await click(".agents-pane .view-tab", "Agents");
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
    // A narrow window keeps the terminal usable. At 900 px (860 px for the grid beside the
    // rail) the previews
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
            sessions: ${widthOf(".sidebar")}, agents: ${widthOf(".agents-pane")},
            previews: ${widthOf(".preview-pane")}, strips: document.querySelectorAll(".strip")
                .length, window: window.innerWidth,
        })`)) as Record<string, number>;
    await resize(900);
    await click(".session", process.env["E2E_SESSION"] ?? "Refund flow");
    // A session without a design block opens on Implement (session-workspace.md T5); the
    // terminal is in the Agents view.
    await click(".agents-pane .view-tab", "Agents");
    await until("agents at the minimum", `${widthOf(".agents-pane")} === 280`);
    // 860 px less the rail's border, 260, two handles and 280: about 307 px.
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
    await until("side panel at the minimum", `${widthOf(".sidebar")} === 140`);
    const at600 = await widths();
    console.log("600 px:", JSON.stringify(at600));
    if (at600["agents"] < 280 || at600["strips"] !== 1) {
        throw new Error("at 600 px the previews strip and the agents keep 280 px");
    }
    await until("terminal still shown", `${shown}?.querySelector(".xterm") !== null`);
    await shot("61-narrow-600");
    await resize(440);
    await until("side panel folded", `document.querySelector(".sidebar") === null`);
    const at440 = await widths();
    console.log("440 px:", JSON.stringify(at440));
    if (at440["agents"] < 280 || at440["strips"] !== 1) {
        throw new Error("at 440 px only the agents pane and the previews strip remain");
    }
    await shot("62-narrow-440");
    await resize(1500);
    await until("side panel back", `${widthOf(".sidebar")} === 260`);
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
    await until("side panel hidden", `document.querySelector(".sidebar") === null`);
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
    // A session without a design block opens on Implement (session-workspace.md T5); the
    // terminal is in the Agents view.
    await click(".agents-pane .view-tab", "Agents");
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
            views: ["Agents", "Implement", "Files", "History", "Threads", "Services"],
            viewSelected: "Agents",
            groups: [["run local", "stop local"],
                ["create PR", "review", "fix", "post", "approve", "land"],
                ["", "reset", "archive"]],
            seps: 2,
            untitled: [],
            danger: ["land", "reset", "archive"],
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
    // The route opens on the session's default view, Implement here; the terminal is in Agents.
    await click(".agents-pane .view-tab", "Agents");
    await until("xterm in the pane route", `${shown}?.querySelector(".xterm") !== null`);
    await until("scrollback replayed", `${rows}.includes(${JSON.stringify(expected)})`);
    await shot("60-terminal-pane-route");
    console.log("terminal ok");
    await finish();
}

if (flow === "operator") {
    // The operator tab, against the fixture (or a scratch daemon with E2E_BANNER set to a
    // string pi prints): the headset icon sits above the gear at the bottom of the rail;
    // a click swaps the middle pane
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
    // The headset waits for GET /operator: the fixture's agent is enabled and idle.
    const headsetShown = `document.querySelector("button[aria-label='Show operator']") !== null`;
    await until("headset shown", headsetShown);
    const bar = await evaluate(`[...document.querySelectorAll(".activity-bar .icon-button")]
        .map((b) => b.getAttribute("aria-label"))`);
    console.log("activity bar:", JSON.stringify(bar));
    const wantedBar = ["Hide sessions", "Show reviews", "Show operator", "Show settings"];
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
    // Off by default (s014): with `settings.operator.enabled` false and the agent stopped,
    // the headset and the context-bar notice go; the agent's stop alone does not hide them.
    await click("button[aria-label='Show operator']");
    await until("operator pane", `document.querySelector(".operator-pane") !== null`);
    await click(".operator-toolbar button", "stop");
    await until("notice back", `${notice} !== null`);
    await evaluate(`fetch("/settings", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme: "system", operator: { enabled: false } }),
    }).then(() => true)`);
    const headset = `document.querySelector("button[aria-label^='Show operator'], ` +
        `button[aria-label^='Hide operator']")`;
    await until("headset gone", `${headset} === null`);
    await until("notice gone", `${notice} === null`);
    await until("session back", `document.querySelector(".agents-pane .chips") !== null`);
    await shot("85-operator-off");
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
    await click(".agents-pane .tab", "Services");
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

if (flow === "reviews") {
    // The Reviews panel (s015), against the fixture: its rail icon opens it in the side
    // panel (s020); the review sessions are not in the Sessions panel; the cards come latest
    // activity first with the CI pill (the failing checks in its tooltip), the decision pill
    // and the thread count; a card opens the review's middle pane with the PR header and the swarm
    // chips (s018: facts, not controls; the agents are headless, so no terminal view and
    // nothing happens on a click); the right pane opens on `diff`. A paste in the box makes
    // a review, which starts the lead and the swarm (s016): the chips go queued, reading,
    // done or failed as `review.updated` arrives, and the state pill follows; `review` in
    // the context bar runs a second round. The lead's blocks are the `review-lead` flow.
    const sessionsText = text(".sessions-pane");
    if ((await evaluate(`${sessionsText}.includes("Retry the upload")`)) === true) {
        throw new Error("a review session shows in the Sessions panel");
    }
    await click(".activity-bar button[aria-label='Show reviews']");
    const pane = `document.querySelector(".reviews-pane")`;
    await until("reviews pane", `${pane} !== null`);
    const cards = `[...document.querySelectorAll(".rv-card")]`;
    await until("two cards", `${cards}.length === 2`);
    const order = (await evaluate(
        `${cards}.map((c) => c.querySelector(".rv-title").innerText)`,
    )) as string[];
    console.log("cards:", JSON.stringify(order));
    if (order[0] !== "Retry the upload on 5xx") {
        throw new Error("the review with the latest activity is not first");
    }
    const firstCard = `${cards}[0]`;
    const ci = (await evaluate(`${firstCard}.querySelector(".rv-ci").title`)) as string;
    const decision = (await evaluate(`${firstCard}.querySelector(".rv-decision").innerText`));
    const threads = (await evaluate(`${firstCard}.querySelector(".rv-threads").innerText`));
    console.log("first card:", JSON.stringify({ ci, decision, threads }));
    if (!ci.includes("lint") || decision !== "changes requested" || threads !== "\u2442 4") {
        throw new Error("the first card's pills do not carry the fixture's facts");
    }
    if ((await evaluate(`${text(".reviews-pane")}.includes("Refund flow")`)) === true) {
        throw new Error("an ordinary session shows in the Reviews panel");
    }
    await shot("70-reviews-panel");
    await click(".rv-card-body", "Retry the upload on 5xx");
    await until("review pane", `document.querySelector(".rv-pane .rv-head") !== null`);
    await until("card selected", `${firstCard}.classList.contains("rv-card-selected")`);
    await until("context bar names the review",
        `${text(".context-bar")}.includes("Retry the upload on 5xx")`);
    await until("review button in the bar",
        `[...document.querySelectorAll(".context-bar .rv-toolbar button")]
            .some((b) => b.textContent === "review")`);
    const chips = `[...document.querySelectorAll(".rv-swarm .rv-chip")]`;
    await until("the lead and three chips", `${chips}.length === 4`);
    const states = (await evaluate(`${chips}.map((c) => c.dataset.state)`)) as string[];
    console.log("chip states:", JSON.stringify(states));
    if (JSON.stringify(states) !== JSON.stringify(["idle", "done", "done", "failed"])) {
        throw new Error("the chips do not show the lead and the swarm's states");
    }
    const reviewPane = `document.querySelector(".rv-pane")`;
    const controls = await evaluate(`({
        buttons: ${chips}.filter((c) => c.querySelector("button") !== null).length,
        tabs: document.querySelectorAll(".rv-pane .tabs-sub").length,
        terminals: document.querySelectorAll(".rv-pane .agent-terminal").length,
    })`);
    console.log("pane controls:", JSON.stringify(controls));
    if (JSON.stringify(controls) !== JSON.stringify({ buttons: 0, tabs: 0, terminals: 0 })) {
        throw new Error("a review pane must have no chip button, sub tab or terminal");
    }
    await until("diff tab shown",
        `document.querySelector(".preview-pane .view-tab.tab-selected")?.textContent === "diff"`);
    await until("threads shown", `document.querySelector(".rv-pane .threads") !== null`);
    if ((await evaluate(`${text(".rv-pane .threads")}.includes("fix")`)) === true) {
        throw new Error("the threads view of a review offers fix");
    }
    await shot("71-review-pane");
    // A chip click does nothing: the threads stay, no terminal appears.
    await click(".rv-swarm .rv-chip", "opus");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await until("threads still shown", `${reviewPane}.querySelector(".threads") !== null`);
    if ((await evaluate(`${reviewPane}.querySelector(".agent-terminal") !== null`)) === true) {
        throw new Error("a chip click opened a terminal");
    }
    // A paste makes a review; the job's session is selected when it finishes. The review
    // composer opens in the working area from the `+ New review` button (s038).
    await click(".sidebar button.side-add[aria-label='New review']");
    await fill("textarea[aria-label='Pull requests to review']",
        "please look at https://github.com/acme/peanut/pull/9");
    await until("PR found", `${text(".rv-found")}.includes("acme/peanut#9")`);
    await shot("73-review-paste");
    await click(".rv-compose-actions .primary", "Start review");
    await until("three cards", `${cards}.length === 3`);
    await until("new review selected",
        `${text(".rv-card-selected")}.includes("PR 9 of peanut")`);
    await until("box folded",
        `document.querySelector("textarea[aria-label='Pull requests to review']") === null`);
    await until("job finished", `${text(".drawer")}.includes("ok")`);
    // The job started the lead and the swarm: the chips move on their own.
    const reviewers = `${chips}.filter((c) => c.dataset.name !== "lead")`;
    await until("chips queued", `${reviewers}.some((c) => c.dataset.state === "queued")`);
    const stateOf = (where: string) =>
        `document.querySelector("${where} .rv-state")?.dataset.state`;
    await until("card reviewing", `${stateOf(".rv-card-selected")} === "reviewing"`);
    await until("header reviewing", `${stateOf(".rv-head")} === "reviewing"`);
    await until("reviewing dot",
        `document.querySelector(".rv-head .rv-state .rv-state-dot") !== null`);
    await shot("74-swarm-queued");
    await until("a chip reads", `${reviewers}.some((c) => c.dataset.state === "reading")`);
    const settled = `${reviewers}.length === 3
        && ${reviewers}.every((c) => c.dataset.state === "done" || c.dataset.state === "failed")`;
    await until("all settled", settled);
    await until("draft shown", `document.querySelector(".rv-draft") !== null`);
    await until("card drafted", `${stateOf(".rv-card-selected")} === "drafted"`);
    await until("card counts the comments",
        `${text(".rv-card-selected .rv-draft-pill")} === "2 comments"`);
    await shot("75-swarm-done");
    // A second round from the context bar: the chips go back to queued.
    await click(".context-bar .rv-toolbar button", "review");
    await until("queued again", `${reviewers}.some((c) => c.dataset.state === "queued")`);
    await until("all settled again", settled);
    console.log("reviews ok");
    await finish();
}

if (flow === "review-lead") {
    // The review lead (s016, s018), against the fixture. The canned review r51 shows the
    // briefing as markdown and the draft: the event pill, the summary, two `path:line` rows,
    // `post` and `drop`; the lead's chip is first with its state; the failed reviewer's chip
    // carries the reason in its tooltip; the card and the header pill `drafted` and
    // `2 comments`. An edit of a comment saves on blur and comes back through
    // `review.updated`; the pill click swaps the event; `post` asks once in place, `cancel`
    // keeps the draft; `post` again and the confirm posts: the URL replaces the draft, the
    // thread count follows, `needs_human` clears, the pills read `posted`. The canned r77 is
    // an APPROVE with no comment: `approve` as a green pill, no comment row, and it posts.
    // On a fresh paste the briefing shows before the verdicts land, the draft once they
    // have; `drop` removes it.
    await click(".activity-bar button[aria-label='Show reviews']");
    await until("reviews pane", `document.querySelector(".reviews-pane") !== null`);
    const cardPills = (title: string) => `(() => {
        const card = [...document.querySelectorAll(".rv-card")]
            .find((c) => c.querySelector(".rv-title").textContent === ${JSON.stringify(title)});
        return [...card.querySelectorAll(".rv-state, .rv-draft-pill")]
            .map((p) => p.textContent.trim());
    })()`;
    const cardsBefore = await evaluate(`[${cardPills("Retry the upload on 5xx")},
        ${cardPills("Dark mode for the settings page")}]`);
    console.log("card pills:", JSON.stringify(cardsBefore));
    if (JSON.stringify(cardsBefore) !== '[["drafted","2 comments"],["drafted","approve"]]') {
        throw new Error("the cards do not pill the review state and the draft");
    }
    await click(".rv-card-body", "Retry the upload on 5xx");
    await until("review pane", `document.querySelector(".rv-pane .rv-head") !== null`);
    await until("briefing rendered",
        `${text(".rv-briefing .md")}.includes("What to look at")`);
    await until("briefing heading", `document.querySelector(".rv-briefing .md h1") !== null`);
    await until("draft shown", `document.querySelector(".rv-draft") !== null`);
    const chips = `[...document.querySelectorAll(".rv-swarm .rv-chip")]`;
    const chipShape = await evaluate(`${chips}.map((c) => [c.dataset.name, c.dataset.state,
        c.title.split("\\n")[1] ?? ""])`);
    console.log("chips:", JSON.stringify(chipShape));
    const chipsWanted = [
        ["lead", "idle", ""],
        ["review-anthropic-claude-opus-5-5", "done", ""],
        ["review-openai-gpt-6-luna", "done", ""],
        ["review-x-ai-grok-4-6", "failed",
            "pi exited with code 1 before a VERDICT: model x-ai/grok-4.6 is not configured"],
    ];
    if (JSON.stringify(chipShape) !== JSON.stringify(chipsWanted)) {
        throw new Error("the chips do not show the lead, the verdicts and the failed reason");
    }
    const headPills = `[...document.querySelectorAll(".rv-head .rv-state, .rv-head .rv-draft-pill")]
        .map((p) => p.textContent.trim())`;
    await until("header pills", `JSON.stringify(${headPills}) === '["drafted","2 comments"]'`);
    const bar = text(".context-bar");
    await until("context bar pills", `${bar}.includes("drafted") && ${bar}.includes("2 comments")`);
    const rows = `[...document.querySelectorAll(".rv-comment")]`;
    const shape = await evaluate(`({
        event: document.querySelector(".rv-event").dataset.event,
        summary: document.querySelector(".rv-draft-body").value.slice(0, 30),
        rows: ${rows}.map((r) => r.querySelector(".rv-comment-at").textContent),
        labels: ${rows}.map((r) => r.querySelector("textarea").value.split(" ")[0]),
        post: document.querySelector(".rv-draft-actions .primary")?.textContent,
        drop: document.querySelector(".rv-draft-actions .danger")?.textContent,
        needs: ${text(".context-bar")}.includes("post or drop the review draft"),
    })`);
    console.log("draft:", JSON.stringify(shape));
    const wanted = {
        event: "COMMENT", summary: "Thanks, the retry is the right",
        rows: ["src/upload.ts:42", "src/upload.test.ts:88"], labels: ["BUG:", "NIT:"],
        post: "post", drop: "drop", needs: true,
    };
    if (JSON.stringify(shape) !== JSON.stringify(wanted)) {
        throw new Error("the draft block does not show the fixture's draft");
    }
    await shot("76-review-lead-draft");
    // An edit of the second comment saves on blur; the fixture's `review.updated` brings it
    // back and the row shows the new text.
    // A headless page has no focus, so `blur()` is silent: the `focusout` React listens to
    // is dispatched by hand.
    const second = ".rv-comment:nth-child(2) textarea";
    await fill(second, "NIT: This asserts the wrong error class.");
    await evaluate(`document.querySelector(${JSON.stringify(second)})
        .dispatchEvent(new FocusEvent("focusout", { bubbles: true })), true`);
    await until("edit saved",
        `document.querySelector(${JSON.stringify(second)}).value.endsWith("error class.")`);
    await until("no error", `document.querySelector(".rv-draft-error") === null`);
    await until("save finished", `document.querySelector(".rv-saving") === null`);
    const savedBody = (await (await fetch(`${process.env["E2E_DAEMON"] ?? uiUrl}` +
        "/sessions/r51-peanut-51")).json()) as {
        session: { review: { draft: { comments: { body: string }[] } } };
    };
    const stored = savedBody.session.review.draft.comments[1]?.body;
    console.log("stored comment:", JSON.stringify(stored));
    if (stored !== "NIT: This asserts the wrong error class.") {
        throw new Error("the edit did not reach the draft route");
    }
    // The pill swaps the event and saves at once.
    await click(".rv-event");
    await until("event APPROVE", `document.querySelector(".rv-event").dataset.event === "APPROVE"`);
    await click(".rv-event");
    await until("event COMMENT", `document.querySelector(".rv-event").dataset.event === "COMMENT"`);
    // `post` asks once in place; `cancel` keeps the draft.
    // The buttons wait while a save runs; so does the operator.
    await until("pill save finished", `document.querySelector(".rv-saving") === null`);
    await click(".rv-draft-actions .primary", "post");
    await until("asked", `${text(".rv-confirm")}.includes("Post this review as you?")`);
    await shot("77-review-lead-confirm");
    await click(".rv-confirm button", "cancel");
    await until("draft kept", `document.querySelector(".rv-confirm") === null`);
    await click(".rv-draft-actions .primary", "post");
    await until("asked again", `document.querySelector(".rv-confirm") !== null`);
    await click(".rv-confirm .primary", "post");
    await until("posted URL shown",
        `${text(".rv-posted-url")}.includes("pullrequestreview-9001")`);
    await until("draft gone", `document.querySelector(".rv-draft") === null`);
    await until("thread count follows", `${text(".context-bar .rv-threads")} === "\u2442 6"`);
    await until("needs_human cleared",
        `!${text(".context-bar")}.includes("post or drop the review draft")`);
    await until("header posted", `JSON.stringify(${headPills}) === '["posted"]'`);
    await until("card posted",
        `JSON.stringify(${cardPills("Retry the upload on 5xx")}) === '["posted"]'`);
    await shot("78-review-lead-posted");
    // The APPROVE review: no comment row, `approve` on the header, and it posts as APPROVE.
    await click(".rv-card-body", "Dark mode for the settings page");
    await until("approve draft shown",
        `document.querySelector(".rv-event")?.dataset.event === "APPROVE"`);
    await until("no comment row", `document.querySelectorAll(".rv-comment").length === 0`);
    await until("approve pill", `JSON.stringify(${headPills}) === '["drafted","approve"]'`);
    await until("approve pill green",
        `document.querySelector(".rv-head .rv-draft-pill").classList.contains("pill-ok")`);
    await shot("78b-review-lead-approve");
    await click(".rv-draft-actions .primary", "post");
    await until("asked for approve", `document.querySelector(".rv-confirm") !== null`);
    await click(".rv-confirm .primary", "post");
    await until("approve posted",
        `${text(".rv-posted-url")}.includes("pull/77#pullrequestreview-9001")`);
    await until("decision approved", `${text(".rv-head .rv-decision")} === "approved"`);
    await until("approve card posted",
        `JSON.stringify(${cardPills("Dark mode for the settings page")}) === '["posted"]'`);
    // A fresh review: the briefing shows before the verdicts land; the draft once they have.
    await click(".sidebar button.side-add[aria-label='New review']");
    await fill("textarea[aria-label='Pull requests to review']",
        "https://github.com/acme/peanut/pull/12");
    await until("PR found", `${text(".rv-found")}.includes("acme/peanut#12")`);
    await click(".rv-compose-actions .primary", "Start review");
    await until("new review selected",
        `${text(".rv-card-selected")}.includes("PR 12 of peanut")`);
    const reviewers = `${chips}.filter((c) => c.dataset.name !== "lead")`;
    await until("briefing before the verdicts",
        `document.querySelector(".rv-briefing .md h1") !== null
            && ${reviewers}.every((c) => c.dataset.state !== "done")`);
    if ((await evaluate(`document.querySelector(".rv-draft") !== null`)) === true) {
        throw new Error("the draft showed before the verdicts landed");
    }
    await until("reviewing while the briefing shows",
        `JSON.stringify(${headPills}) === '["reviewing"]'`);
    await shot("79-review-lead-briefing-first");
    await until("draft after the verdicts",
        `document.querySelector(".rv-draft") !== null
            && ${reviewers}.filter((c) => c.dataset.state === "done").length === 2
            && ${reviewers}.filter((c) => c.dataset.state === "failed").length === 1`);
    await until("lead idle", `${chips}[0].dataset.state === "idle"`);
    await click(".rv-draft-actions .danger", "drop");
    await until("draft dropped", `document.querySelector(".rv-draft") === null`);
    await until("briefing stays", `document.querySelector(".rv-briefing") !== null`);
    await shot("79b-review-lead-dropped");
    console.log("review lead ok");
    await finish();
}

if (flow === "about-egm") {
    // About EGM (docs/designs/egm-adoption.md, entries 1.35 to 1.39) against the fixture or a
    // scratch daemon: the block is the last one in settings, its notice is `EGM_NOTICE` of the
    // protocol, it names the source, the 12-character pin, the license and the state line, and
    // it has no `fetch` button while EGM is ready. A `POST /egm/fetch` runs a job `egm`; its
    // `job.finished` event moves the block's load key, so the state line reloads with the new
    // fetch date without a page reload.
    const block = `document.querySelector(".settings > .about-egm:last-child")`;
    const state = `(${block}?.querySelector(".pill")?.textContent ?? "")`;
    await click("button[aria-label='Show settings']");
    await until("about EGM last in settings", `${block} !== null`);
    await until("EGM state loaded", `${state}.startsWith("ready")`);
    const shape = await evaluate(`({
        legend: ${block}.querySelector("legend")?.textContent,
        notice: ${block}.querySelector(".about-egm-notice")?.textContent,
        source: ${block}.querySelector("a")?.getAttribute("href"),
        facts: [...${block}.querySelectorAll("dd")].map((dd) => dd.textContent),
        fetch: [...${block}.querySelectorAll("button")].map((b) => b.textContent),
    })`);
    console.log("about EGM:", JSON.stringify(shape));
    // The driver reads the route itself (through the UI's origin), so the check does not
    // depend on the fixture's canned values and also runs against a scratch daemon.
    const status = (await (await fetch(new URL("/egm", uiUrl))).json()) as {
        egm: { fetched_at: string | null; subagents: boolean };
    };
    const fetchedDay = status.egm.fetched_at?.slice(0, 10) ?? "";
    const missing = status.egm.subagents ? "" : " \u00b7 pi-subagents missing";
    const wantedShape = {
        legend: "About EGM",
        notice: EGM_NOTICE,
        source: EGM_SOURCE_URL,
        facts: [
            EGM_SOURCE_URL, "pinned a119668d7dc5", EGM_LICENSE,
            `ready \u00b7 fetched ${fetchedDay}${missing}`,
        ],
        fetch: [],
    };
    if (JSON.stringify(shape) !== JSON.stringify(wantedShape)) {
        await shot("failure");
        await closeTarget();
        throw new Error(`About EGM is not the block expected: ${JSON.stringify(wantedShape)}`);
    }
    await evaluate(`${block}.scrollIntoView({ block: "end" })`);
    await shot("80-about-egm");
    const posted = await fetch(new URL("/egm/fetch", uiUrl), { method: "POST" });
    const job = (await posted.json()) as { job: { id: string; action: string } };
    console.log("egm job:", JSON.stringify(job.job));
    await until("fetching shows", `${state}.startsWith("fetching")`);
    await shot("81-about-egm-fetching");
    // After `fetching`, `ready` can only come from the reload that `job.finished` keys.
    await until("ready again after job.finished", `${state}.startsWith("ready")`);
    const after = (await (await fetch(new URL("/egm", uiUrl))).json()) as typeof status;
    const wanted = `ready \u00b7 fetched ${after.egm.fetched_at?.slice(0, 10) ?? ""}${missing}`;
    await until("the new fetch date", `${state} === ${JSON.stringify(wanted)}`);
    await shot("82-about-egm-refetched");
    console.log("about-egm ok");
    await finish();
}

if (flow === "view-tabs") {
    // The row of view tabs (docs/designs/session-workspace.md, T5, D5, D12, D13) against the
    // fixture: the design-review session shows the EGM tabs in step order with their marks,
    // Brainstorm and Draft done, Review active with `3/5`, Implement to do, and the context
    // bar shows the stage badge; the two running Goldfish of the fixture are the Review tab's
    // suffix; its card shows the five steps as dots. The direct session
    // shows the shorter row and opens on Implement; it switches to `design` on the track chip
    // and back. The design-ready session marks Review waiting (Approve's state). In a narrow
    // agents pane the four EGM tabs fold into `EGM 3/5 Review` with a menu of the four.
    const bar = `document.querySelector(".context-bar")`;
    await send("Emulation.setDeviceMetricsOverride", {
        width: 1920, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    const tabs = `[...document.querySelectorAll(".agents-pane .view-tabs .view-tab")]`;
    const tabsNow = `${tabs}.map((t) => [t.dataset.view, t.dataset.state ?? null,
        t.textContent])`;
    const fail = async (message: string): Promise<never> => {
        await shot("failure");
        await closeTarget();
        throw new Error(message);
    };
    await click(".session", "CSV export \u00b7 design-review");
    await until("design row shown",
        `document.querySelector(".agents-pane .view-tab[data-view=implement]") !== null`);
    const shape = await evaluate(`({
        tabs: ${tabsNow},
        review: document.querySelector(".agents-pane .view-tab[data-view=review]").title,
        brainstorm: document.querySelector(".agents-pane .view-tab[data-view=brainstorm]").title,
        marks: [...document.querySelectorAll(".agents-pane .view-tab-mark")]
            .map((m) => m.getAttribute("aria-label")),
        stepper: document.querySelectorAll(".context-bar .egm-stepper").length,
        stageBadge: [...${bar}.querySelectorAll(":scope > .badge:not(.round-badge)")]
            .map((b) => b.textContent),
        track: document.querySelector(".context-bar .track-chip")?.textContent,
        card: [...document.querySelectorAll(".session-selected .card-dot")]
            .map((d) => d.dataset.state),
    })`);
    console.log("tabs:", JSON.stringify(shape));
    const wanted = {
        tabs: [
            ["agents", null, "Agents"], ["brainstorm", "done", "Brainstorm"],
            ["draft", "done", "Draft"], ["review", "active", "Review3/5 2 live"],
            ["implement", "todo", "Implement"], ["files", null, "Files"],
            ["history", null, "History"], ["threads", null, "Threads"],
            ["services", null, "Services"],
        ],
        review: "Review: active \u00b7 Goldfish: $1.20\nApprove: todo",
        brainstorm: `${EGM_NOTICE}\nBrainstorm: done \u00b7 Goldfish: $0.42`,
        marks: ["done", "done", "active", "todo"],
        stepper: 0,
        stageBadge: ["planned"],
        track: "design \u25be",
        card: ["done", "done", "active", "todo", "todo"],
    };
    if (JSON.stringify(shape) !== JSON.stringify(wanted)) {
        await fail(`the row is not the one expected: ${JSON.stringify(wanted)}`);
    }
    await shot("83-view-tabs");

    // The direct session: the shorter row, Implement shown; `design` on the chip, and back.
    await click(".session", "CSV export \u00b7 direct track");
    const chip = `(document.querySelector(".context-bar .track-chip")?.textContent ?? "")`;
    await until("direct chip", `${chip} === "direct \u25be"`);
    await until("direct row", `JSON.stringify(${tabs}.map((t) => t.textContent))
        === '["Agents","Implement","Files","History","Threads","Services"]'`);
    await until("implement shown",
        `document.querySelector(".agents-pane .view-tab.tab-selected")?.dataset.view
            === "implement" && document.querySelector(".im") !== null`);
    await click(".context-bar .track-chip");
    await until("track menu", `document.querySelector(".track-menu .menu") !== null`);
    await shot("84-track-menu");
    await click(".track-menu .menu button", "design");
    await until("switched to design", `${chip} === "design \u25be"`);
    await until("intake row", `${tabs}.length === 9
        && ${tabs}.filter((t) => t.dataset.state === "todo").length === 4`);
    await shot("85-track-design");
    await click(".context-bar .track-chip");
    await until("track menu again", `document.querySelector(".track-menu .menu") !== null`);
    await click(".track-menu .menu button", "direct");
    await until("back to direct", `${chip} === "direct \u25be"`);
    await until("no error", `document.querySelector(".drawer .needs-human") === null`);

    // Waiting: the design-ready session needs the operator, so Review shows Approve waiting.
    await click(".session", "CSV export \u00b7 design-ready");
    await until("review waits",
        `document.querySelector(".agents-pane .view-tab[data-view=review]")
            ?.dataset.state === "waiting"`);
    await shot("86-view-tabs-waiting");

    // The fold: a 1000 px window gives the agents pane too little for nine tabs, so the four
    // EGM tabs fold into one with a menu that opens the picked view.
    await click(".session", "CSV export \u00b7 design-review");
    await until("review active again",
        `document.querySelector(".agents-pane .view-tab[data-view=review]")
            ?.dataset.state === "active"`);
    await send("Emulation.setDeviceMetricsOverride", {
        width: 1000, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    const folded = `document.querySelector(".agents-pane .view-tab[data-view=egm]")`;
    await until("folded", `${folded} !== null && ${folded}.textContent === "EGM 3/5 Review"`);
    // The rest of the row scrolls sideways, as before; the row keeps one line (Q3).
    const row = `document.querySelector(".agents-pane .view-tabs")`;
    await until("one line", `${row}.getBoundingClientRect().height <= 40`);
    await click(".agents-pane .view-tab-fold-toggle");
    await until("fold menu", `[...document.querySelectorAll(".view-tab-fold .menu button")]
        .map((b) => b.dataset.view).join() === "brainstorm,draft,review,implement"`);
    await shot("87-view-tabs-folded");
    await click(".view-tab-fold .menu button", "Draft");
    await until("draft from the menu", `document.querySelector(".agents-pane .dw-doc") !== null
        && ${folded}.getAttribute("aria-selected") === "true"`);
    await send("Emulation.setDeviceMetricsOverride", {
        width: 1920, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await until("unfolded", `${folded} === null && ${tabs}.length === 9`);
    await shot("88-view-tabs-unfolded");
    await send("Emulation.setDeviceMetricsOverride", {
        width: 1500, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    console.log("view-tabs ok");
    await finish();
}

if (flow === "rounds") {
    // The round badge (entry 2.47) against the fixture: the round-3 session shows `r3` after
    // the title in the context bar and after the stage badge on its card, with the PRs of
    // rounds 1 and 2 in the tooltip; a round-1 session shows no badge.
    const firstLine = "r1: web#41 merged 2026-10-14";
    await click(".session", "Bootstrap");
    await until("bootstrap selected", `${text(".context-title")}.startsWith("Bootstrap")`);
    if ((await evaluate(`document.querySelector(".context-bar .round-badge") !== null`))) {
        await shot("failure");
        await closeTarget();
        throw new Error("a round-1 session shows a round badge");
    }
    await click(".session", "CSV export \u00b7 round 3");
    const badge = `document.querySelector(".context-bar .round-badge")`;
    await until("round badge", `${badge}?.textContent === "r3"`);
    const shape = await evaluate(`({
        bar: ${badge}.textContent,
        barTip: ${badge}.title.split("\\n"),
        afterTitle: ${badge}.previousElementSibling?.classList.contains("context-title"),
        card: document.querySelector(".session-selected .round-badge")?.textContent,
        cardTip: document.querySelector(".session-selected .round-badge")?.title.split("\\n"),
    })`) as { barTip: string[]; cardTip: string[] };
    console.log("rounds:", JSON.stringify(shape));
    const wanted = {
        bar: "r3",
        barTip: [firstLine, "r2: web#57 merged 2026-10-18, api#9 closed"],
        afterTitle: true,
        card: "r3",
        cardTip: [firstLine, "r2: web#57 merged 2026-10-18, api#9 closed"],
    };
    if (JSON.stringify(shape) !== JSON.stringify(wanted)) {
        await shot("failure");
        await closeTarget();
        throw new Error(`the round badge is not the one expected: ${JSON.stringify(wanted)}`);
    }
    await shot("89-rounds");
    console.log("rounds ok");
    await finish();
}

if (flow === "design-workspace") {
    // The views of the agents pane (session-workspace.md T5; egm-adoption.md entries 5.6 to
    // 5.14) against the fixture. A legacy session shows the direct row and opens on
    // Implement; a design-track session shows the nine tabs. A tab opens its view by id.
    // Brainstorm: the brief, or the empty line at intake. Draft: the 7-section outline (a
    // `## ` line in a fence is no section), the source toggle, a revision request that reaches
    // the lead as `POST …/design/answer`, and the done marks beside the plan entries. Review:
    // the compact resolve line, the stage rows, the review Goldfish, a report, the archived
    // run `r1`. Files: the direct track's drift report. History: the round badge opens it;
    // round 1 expands to its Log; two approval rows, the round-2 one `current`. Implement on
    // the seeded session: three phases, Other, the stale and orphan badges, the doc's goal
    // paragraph with `open in Draft`, and a tick that moves the Draft tab's mark.
    const workspace = `document.querySelector(".agents-pane .chat")`;
    const tabOf = `(document.querySelector(".agents-pane .view-tab.tab-selected")?.dataset.view
        ?? "")`;
    const body = (selector: string) =>
        `(${workspace}?.querySelector(${JSON.stringify(selector)})?.innerText ?? "")`;
    const viewTabsNow = `[...document.querySelectorAll(".agents-pane .view-tab")]
        .map((tab) => tab.textContent)`;
    await send("Emulation.setDeviceMetricsOverride", {
        width: 1920, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    await click(".session", "Bootstrap");
    await until("bootstrap selected", `${text(".context-title")}.startsWith("Bootstrap")`);
    await expectSame("legacy view tabs", await evaluate(viewTabsNow),
        ["Agents", "Implement", "Files", "History", "Threads", "Services"]);
    await until("legacy opens on Implement", `${tabOf} === "implement"`);
    await click(".agents-pane .view-tab", "Files");
    await until("files empty", `${body(".dw-empty")} === "No design files yet."`);

    // Brainstorm at intake: the empty line; History in round 1: its empty line.
    await click(".session", "CSV export \u00b7 intake");
    await until("intake selected", `${text(".context-title")} === "CSV export \u00b7 intake"`);
    await expectSame("design view tabs", await evaluate(viewTabsNow), [
        "Agents", "Brainstorm", "Draft", "Review", "Implement", "Files", "History", "Threads",
        "Services",
    ]);
    await until("design opens on Agents", `${tabOf} === "agents"`);
    await click(".agents-pane .view-tab", "Brainstorm");
    await until("brief empty", `${tabOf} === "brainstorm"
        && ${body(".dw-empty")} === "No brief yet. Start with brainstorm."`);
    await click(".agents-pane .view-tab", "History");
    await until("history empty", `${body(".dw-empty")} === "Round 1, no approval yet."`);

    // The resolving session: the Brainstorm tab shows the brief.
    await click(".session", "CSV export \u00b7 resolving");
    await until("resolving selected",
        `${text(".context-title")} === "CSV export \u00b7 resolving"`);
    await click(".agents-pane .view-tab", "Brainstorm");
    await until("brief tab",
        `${tabOf} === "brainstorm" && ${body(".md h1")} === "Concepts brief: CSV export"`);
    await shot("90-workspace-brief");

    // Review: the resolve line above, the rows, the Goldfish, the consolidated report first.
    await click(".agents-pane .view-tab", "Review");
    await until("review tab", `${tabOf} === "review"
        && ${body(".dw-body .md h1")} === "Consolidated review report"`);
    await expectSame("review", await evaluate(`({
        resolveCard: ${workspace}.querySelector(".design-gate-compact")?.dataset.kind,
        resolveLine: ${body(".design-gate-compact")},
        approveHead: ${workspace}.querySelectorAll(".dw-approve-head").length,
        rows: [...${workspace}.querySelectorAll(".dw-list .dw-row")]
            .map((row) => [row.dataset.stage, row.querySelector(".pill").textContent]),
        goldfish: [...${workspace}.querySelectorAll(".dw-goldfish-row")]
            .map((row) => row.innerText.replace(/\\s+/g, " ").trim()),
        runs: [...${workspace}.querySelectorAll("select option")].map((o) => o.textContent),
    })`), {
        resolveCard: "resolve",
        resolveLine: "Findings to resolve \u2192 open Agents",
        approveHead: 0,
        rows: [
            ["5", "written"], ["6", "written"], ["7", "written"], ["8", "not yet"],
            ["9", "not yet"], ["consolidated", "written"], ["resolve", "written"],
        ],
        goldfish: ["zoom_out done $0.31", "comprehension done $0.27", "critic done $0.40"],
        runs: ["r2 (current)", "r1"],
    });
    await click(".agents-pane .dw-row[data-stage='5']");
    await until("stage 5 report", `${body(".dw-body .md h1")} === "Zoom out report"`);
    await shot("91-workspace-review");
    await evaluate(`(() => {
        const select = ${workspace}.querySelector("select");
        const proto = Object.getPrototypeOf(select);
        Object.getOwnPropertyDescriptor(proto, "value").set.call(select, "r1");
        select.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await until("archived run", `${body(".dw-body .md h1")}
        === "Consolidated review report (run r1)"
        && [...${workspace}.querySelectorAll(".dw-list .pill")]
            .every((pill) => pill.textContent === "archived")`);
    await shot("92-workspace-review-r1");

    // Draft on the design-ready session: the doc, its outline, the approve header, source, a
    // revision request, and the entry marks (none before the seed).
    await click(".session", "CSV export \u00b7 design-ready");
    await until("design-ready selected",
        `${text(".context-title")} === "CSV export \u00b7 design-ready"`);
    await click(".agents-pane .view-tab", "Review");
    await until("approve header", `${tabOf} === "review"
        && ${body(".dw-approve-head .dw-approve")} === "approve design"`);
    await click(".agents-pane .view-tab", "Draft");
    const outlineNow = `[...${workspace}.querySelectorAll(".dw-outline-item")]
        .map((item) => item.textContent)`;
    await until("draft tab", `${tabOf} === "draft" && ${outlineNow}.length === 7`);
    await expectSame("doc", await evaluate(`({
        outline: ${outlineNow},
        name: ${body(".dw-doc-name")},
        revise: ${workspace}.querySelectorAll(".dw-revise").length,
        marks: [...${workspace}.querySelectorAll("[data-entry]")]
            .map((h) => [h.dataset.entry, h.dataset.mark]),
    })`), {
        outline: [
            "Overview", "Goals", "Non-Goals", "Decisions", "Technical Plan",
            "Verification Plan", "Detailed Implementation Plan",
        ],
        name: "docs/designs/csv-export.md",
        revise: 7,
        marks: [
            ["1.1", "none"], ["1.2", "none"], ["1.3", "none"], ["2.1", "none"],
            ["2.2", "none"], ["3.1", "none"], ["3.2", "none"],
        ],
    });
    // The outline is a sticky left column (styles.css `@container dw`), so it stays in view
    // after a jump and the next jump is one click away.
    const outlineBox = `(() => {
        const pane = ${workspace};
        const outline = pane.querySelector(".dw-outline");
        const doc = pane.querySelector(".dw-body");
        return {
            column: outline.getBoundingClientRect().right <= doc.getBoundingClientRect().left,
            sticky: getComputedStyle(outline).position,
            visible: outline.getBoundingClientRect().top >= pane.getBoundingClientRect().top,
        };
    })()`;
    await expectSame("outline column", await evaluate(outlineBox), {
        column: true, sticky: "sticky", visible: true,
    });
    // A short window, so the doc overflows the pane and the outline has to scroll it.
    await send("Emulation.setDeviceMetricsOverride", {
        width: 1920, height: 600, deviceScaleFactor: 1, mobile: false,
    });
    await click(".agents-pane .dw-outline-item", "Decisions");
    await until("scrolled to the section", `(() => {
        const pane = ${workspace};
        const section = ${workspace}.querySelector("[data-heading-index='3']");
        const top = section.getBoundingClientRect().top - pane.getBoundingClientRect().top;
        return pane.scrollTop > 0 && top >= 0 && top < 120;
    })()`);
    await expectSame("outline after the jump", await evaluate(outlineBox), {
        column: true, sticky: "sticky", visible: true,
    });
    await shot("93-workspace-design");
    await send("Emulation.setDeviceMetricsOverride", {
        width: 1920, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    await click(".agents-pane .dw-section[aria-label=Overview] .dw-revise");
    await until("revision box", `${workspace}.querySelector(".dw-revision textarea") !== null`);
    await fill(".agents-pane .dw-revision textarea", "Name the source of the row cap.");
    await click(".agents-pane .dw-revision button", "send");
    await until("revision sent", `${workspace}.querySelector(".dw-revision") === null`);
    const answers = (await received("s207-csv-design-ready")).answers;
    await expectSame("revision request", answers.slice(-1), [
        'Revision request for "Overview" in csv-export.md: Name the source of the row cap.',
    ]);
    await click(".agents-pane .dw-doc-head .link", "source");
    await until("source shown", `${body(".dw-source")}.includes("## Overview")`);

    // Files on the direct track: the session opens on Implement; the drift report renders.
    await click(".session", "CSV export \u00b7 direct track");
    await until("direct selected",
        `${text(".context-title")} === "CSV export \u00b7 direct track"`);
    await until("direct opens on Implement", `${tabOf} === "implement"`);
    await click(".agents-pane .view-tab", "Files");
    await until("files tab",
        `${tabOf} === "files" && ${body(".dw-list")}.includes("drift report")`);
    await click(".agents-pane .dw-row", "CSV_EXPORT_DRIFT_REPORT.md");
    await until("drift report", `${body(".dw-body .md h1")} === "Drift report: CSV export"`);
    await shot("94-workspace-files");

    // History from the round badge: three rounds, round 1's Log, two approvals.
    await click(".agents-pane .view-tab", "Agents");
    await click(".session", "CSV export \u00b7 round 3");
    await until("round badge button",
        `document.querySelector(".context-bar button.round-badge")?.textContent === "r3"`);
    await click(".context-bar button.round-badge");
    await until("history tab", `${tabOf} === "history"`);
    await click(".agents-pane .dw-round-toggle", "r1");
    await until("round 1 log", `${body(".dw-round-log")}.includes("web#41 merged")`);
    await expectSame("history", await evaluate(`({
        rounds: [...${workspace}.querySelectorAll(".dw-round-name")]
            .filter((name) => name.closest(".dw-round") !== null)
            .map((name) => name.textContent.replace(/^[\u25b8\u25be] /, "")),
        approvals: [...${workspace}.querySelectorAll(".dw-approval")].map((row) => [
            row.querySelector(".dw-round-name").textContent,
            row.querySelector("code").textContent,
            row.dataset.mark ?? null,
        ]),
    })`), {
        rounds: ["r3 (current)", "r2", "r1"],
        approvals: [["r2", "9f2c4be1d0a7", "current"], ["r1", "4d1e9a07c3b2", null]],
    });
    await shot("95-workspace-history");

    // Implement on the seeded session (T6, CUJ 1, CUJ 3, CUJ 5): the doc's goal paragraph,
    // the header's entry count, the three phases and Other, the badges, the rail; a tick
    // moves the phase count and the Draft tab's mark without a reload.
    await click(".session", "CSV export \u00b7 seeded");
    await until("seeded selected", `${text(".context-title")} === "CSV export \u00b7 seeded"`);
    await click(".agents-pane .view-tab", "Implement");
    const phasesNow = `[...document.querySelectorAll(".im-phase")].map((p) => [
        p.querySelector(".im-phase-label").textContent, p.dataset.open,
        p.querySelector(".mw-count").textContent,
        [...p.querySelectorAll(".im-row")].map((r) => [r.dataset.entry ?? null, r.dataset.state,
            [...r.querySelectorAll(".im-badges .pill")].map((b) => b.textContent).join()])])`;
    await until("implement shown", `${tabOf} === "implement" && ${phasesNow}.length === 4`);
    await expectSame("seeded implement", await evaluate(`({
        goal: ${body(".im-goal .im-goal-text")},
        openDraft: ${workspace}.querySelectorAll(".im-open-draft").length,
        editable: ${workspace}.querySelectorAll(".im-goal button.mw-text").length,
        doneWhen: ${workspace}.querySelectorAll(".mw-done-when").length,
        header: [...${workspace}.querySelectorAll(".im-header .mw-pulse-pill")]
            .map((pill) => pill.textContent),
        phases: ${phasesNow},
        rail: [...${workspace}.querySelectorAll(".im-rail .mw-agent")].map((a) => [
            a.querySelector(".mw-agent-name").textContent,
            a.querySelector(".im-live").dataset.state]),
    })`), {
        goal: "The list page gains an export button that streams the shown rows as CSV.",
        openDraft: 1,
        editable: 0,
        doneWhen: 0,
        header: ["entries done 2 / 7", "2 in progress", "1 open question", "ui blocked"],
        phases: [
            ["Build session 1: the route", "true", "2 / 3",
                [["1.3", "doing", ""], ["1.1", "done", ""], ["1.2", "done", ""]]],
            ["Build session 2: the button", "true", "0 / 2",
                [["2.1", "doing", ""], ["2.2", "next", "stale"]]],
            ["Build session 3: the docs", "false", "0 / 2", []],
            ["Other", "false", "1 / 3", []],
        ],
        rail: [["lead", "idle"], ["engine", "working"], ["ui", "blocked"]],
    });
    await shot("96-implement-seeded");
    await click(".im-phase[data-phase=other] .im-phase-toggle");
    await until("Other open", `${phasesNow}[3][3].map((r) => r.join("|")).join()
        === "|next|,4.1|next|orphan,|done|"`);
    const orphanTip = await evaluate(
        `${workspace}.querySelector(".im-orphan")?.title`);
    await expectSame("orphan tooltip", orphanTip, "entry 4.1 is not in the doc");
    await click(".im-row[data-entry='1.3'] .mw-check");
    await until("phase 1 done", `${phasesNow}[0][2] === "3 / 3"
        && ${phasesNow}[0][1] === "false"`);
    await until("entries count moved", `${body(".im-header")}.includes("entries done 3 / 7")`);
    // The Log is the main column's last block and the rail a sticky column beside it, so a
    // folded phase list neither pushes the Log down nor lets the rail slide over it.
    await expectSame("implement layout", await evaluate(`(() => {
        const pane = ${workspace};
        const box = (s) => pane.querySelector(s).getBoundingClientRect();
        const main = box(".im-main");
        const rail = box(".im-rail");
        const log = box(".mw-log");
        const plan = box(".im-phase:last-of-type");
        return {
            logInMain: log.left >= main.left && log.right <= main.right,
            logUnderPlan: log.top >= plan.bottom && log.top - plan.bottom < 60,
            apart: log.right <= rail.left,
            rail: getComputedStyle(pane.querySelector(".im-rail")).position,
        };
    })()`), { logInMain: true, logUnderPlan: true, apart: true, rail: "sticky" });
    await shot("97-implement-ticked");
    await click(".agents-pane .im-open-draft");
    await until("draft marks moved", `${tabOf} === "draft"
        && JSON.stringify([...${workspace}.querySelectorAll("[data-entry]")]
            .map((h) => [h.dataset.mark, h.title]))
        === JSON.stringify([
            ["done", "done 1 / 1"], ["done", "done 1 / 1"], ["done", "done 1 / 1"],
            ["doing", "doing"], ["none", ""], ["none", ""], ["none", ""]])`);
    await shot("98-draft-marks");
    // The views share one scroll box; a view change opens at the top, not at the depth the
    // Draft was read at. A short window, so both the Draft and Implement overflow the pane.
    await send("Emulation.setDeviceMetricsOverride", {
        width: 1920, height: 600, deviceScaleFactor: 1, mobile: false,
    });
    await click(".agents-pane .dw-outline-item", "Detailed Implementation Plan");
    // The jump scrolls smoothly; the switch waits for the section to settle at the top.
    await until("draft scrolled", `(() => {
        const pane = ${workspace};
        const section = pane.querySelector("[data-heading-index='6']");
        const top = section.getBoundingClientRect().top - pane.getBoundingClientRect().top;
        return pane.scrollTop > 0 && top >= 0 && top < 120;
    })()`);
    await click(".agents-pane .view-tab", "Implement");
    await until("implement at the top", `${tabOf} === "implement"
        && ${workspace}.scrollHeight > ${workspace}.clientHeight
        && ${workspace}.scrollTop === 0`);
    await send("Emulation.setDeviceMetricsOverride", {
        width: 1500, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await until("no error", `document.querySelector(".drawer .needs-human") === null`);
    console.log("design-workspace ok");
    await finish();
}

/** What the fixture received on a session's design routes (`fixture/design.ts`). */
async function received(dir: string): Promise<{ answers: string[]; runs: unknown[] }> {
    const url = new URL(`/sessions/${dir}/design/received`, uiUrl);
    return (await (await fetch(url)).json()) as { answers: string[]; runs: unknown[] };
}

/** Throws after a shot and a closed tab when `got` is not `wanted`. */
async function expectSame(label: string, got: unknown, wanted: unknown): Promise<void> {
    console.log(`${label}:`, JSON.stringify(got));
    if (JSON.stringify(got) !== JSON.stringify(wanted)) {
        await shot("failure");
        await closeTarget();
        throw new Error(`${label} is not the one expected: ${JSON.stringify(wanted)}`);
    }
}

if (flow === "design-actions") {
    // The toolbar's design group (docs/designs/egm-adoption.md, entries 3.18 to 3.20, 3.24)
    // against the fixture. One filled primary per stage, left of the stack group; brainstorm
    // asks an optional concept, review design a preset with `consolidated report` checked,
    // draft runs at once; drafting has no primary. The `EGM ▾` menu lists 7 skills with
    // bootstrap disabled before approval, 2 on the direct track; resolve prefills the doc's
    // absolute path. A refused run lands in the drawer. At 1100 px the group opens the `⋯` menu.
    const primary = `document.querySelector(".context-bar .design-group > .primary")`;
    const dialog = `document.querySelector(".design-dialog")`;
    const pick = async (title: string) => {
        await click(".session", title);
        await until(`${title} selected`, `${text(".context-title")} === ${JSON.stringify(title)}`);
    };
    await pick("CSV export \u00b7 intake");
    await until("brainstorm primary", `${primary}?.textContent === "brainstorm"`);
    await expectSame("toolbar order", await evaluate(`[...document.querySelector(
        ".context-bar .toolbar").children].map((c) => c.className)`), [
        "toolbar-group design-group", "toolbar-sep", "toolbar-group", "toolbar-sep",
        "toolbar-group", "toolbar-sep", "toolbar-group toolbar-menu",
    ]);
    await shot("90-design-intake");
    await click(".context-bar .design-group > .primary", "brainstorm");
    await until("concept dialog", `${dialog}?.getAttribute("aria-label") === "Brainstorm"`);
    await fill("textarea[aria-label=Concept]", "CSV export of the orders list");
    await shot("91-design-brainstorm-dialog");
    await click(".design-dialog button", "run");
    await until("concept dialog closed", `${dialog} === null`);
    await expectSame("brainstorm run", await received("s201-csv-intake"), {
        answers: [], runs: [{ skill: "egm-brainstorm", args: "CSV export of the orders list" }],
    });

    await pick("CSV export \u00b7 brainstorm");
    await until("draft primary", `${primary}?.textContent === "draft"`);
    await click(".context-bar .design-group > .primary", "draft");
    await until("draft posted", `${dialog} === null`);
    await expectSame("draft run", await received("s202-csv-brainstorm"), {
        answers: [], runs: [{ skill: "egm-draft" }],
    });

    await pick("CSV export \u00b7 drafting");
    await until("no primary while drafting", `${primary} === null`);

    await pick("CSV export \u00b7 drafted");
    await until("review primary", `${primary}?.textContent === "review design"`);
    await click(".context-bar .design-group > .primary", "review design");
    await until("preset dialog", `${dialog}?.getAttribute("aria-label") === "Review the design"`);
    await expectSame("presets", await evaluate(`[...document.querySelectorAll(
        ".design-preset")].map((l) => [l.querySelector("input").value,
        l.querySelector("input").checked, l.childNodes[1].textContent.trim()])`), [
        ["interactive", false, "interactive, a gate after each stage"],
        ["uninterrupted", true, "consolidated report"],
        ["feature_spec", false, "feature spec first"],
        ["implementation", false, "implementation plan"],
    ]);
    await shot("92-design-review-dialog");
    await click(".design-dialog button", "run");
    await until("preset dialog closed", `${dialog} === null`);

    // The menu: 7 skills, bootstrap disabled with the guard's reason.
    await click(".context-bar .design-menu > button", "EGM");
    await until("EGM menu", `document.querySelector(".design-menu .menu") !== null`);
    await expectSame("menu", await evaluate(`[...document.querySelectorAll(
        ".design-menu .menu button")].map((b) => [b.textContent, b.disabled])`), [
        ["brainstorm", false], ["draft", false], ["review design", false],
        ["review loop", false], ["resolve", false], ["drift report", false],
        ["bootstrap", true],
    ]);
    const guard = await evaluate(
        `document.querySelector(".design-menu .menu button[data-skill=egm-bootstrap]").title`);
    await expectSame("bootstrap tooltip", guard,
        "the design-only scope blocks README writes; use a direct-track session");
    await shot("93-design-egm-menu");
    await click(".design-menu .menu button", "resolve");
    await until("resolve dialog", `${dialog}?.getAttribute("aria-label") === "Resolve"`);
    const doc = "/home/fixture/.spinner/sessions/s204-csv-drafted/web/docs/designs/csv-export.md";
    await expectSame("target prefill", await evaluate(
        `document.querySelector(".design-dialog input").value`), doc);
    await shot("94-design-resolve-dialog");
    await click(".design-dialog button", "run");
    await until("resolve dialog closed", `${dialog} === null`);
    await click(".context-bar .design-menu > button", "EGM");
    await until("EGM menu again", `document.querySelector(".design-menu .menu") !== null`);
    await click(".design-menu .menu button", "drift report");
    await until("drift dialog", `${dialog}?.getAttribute("aria-label") === "Drift report"`);
    await expectSame("designs prefill", await evaluate(
        `document.querySelector(".design-dialog input").value`),
        "/home/fixture/.spinner/sessions/s204-csv-drafted/web/docs/designs");
    await click(".design-dialog button", "cancel");
    await until("drift dialog closed", `${dialog} === null`);
    await expectSame("drafted runs", await received("s204-csv-drafted"), {
        answers: [], runs: [
            { skill: "egm-review", preset: "uninterrupted" },
            { skill: "egm-resolve", args: doc },
        ],
    });

    // A refusal goes to the drawer: a review with a preset before the doc exists is a 409.
    await pick("CSV export \u00b7 intake");
    await click(".context-bar .design-menu > button", "EGM");
    await until("EGM menu on intake", `document.querySelector(".design-menu .menu") !== null`);
    await click(".design-menu .menu button", "review design");
    await until("preset dialog on intake", `${dialog} !== null`);
    await click(".design-dialog button", "run");
    await until("refusal in the drawer",
        `${text(".drawer .needs-human")}.includes("no design doc yet")`);
    await shot("95-design-refused");
    await click(".design-dialog button", "cancel");
    await until("refused dialog closed", `${dialog} === null`);

    // The direct track: drift report and bootstrap only.
    await pick("CSV export \u00b7 direct track");
    await until("no primary on direct", `${primary} === null`);
    await click(".context-bar .design-menu > button", "EGM");
    await until("EGM menu on direct", `document.querySelector(".design-menu .menu") !== null`);
    await expectSame("direct menu", await evaluate(`[...document.querySelectorAll(
        ".design-menu .menu button")].map((b) => b.textContent)`), ["drift report", "bootstrap"]);
    await click(".context-bar .design-menu > button", "EGM");

    // Compact: the design group opens the `⋯` menu, the primary first.
    await pick("CSV export \u00b7 intake");
    await send("Emulation.setDeviceMetricsOverride", {
        width: 1100, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await until("compact toolbar", `document.querySelector(".toolbar-compact") !== null`);
    await click(".toolbar-menu > .icon-button");
    await until("compact menu", `document.querySelector(".toolbar-menu .menu") !== null`);
    await expectSame("compact menu", await evaluate(`(() => {
        const first = document.querySelector(".toolbar-menu .menu").firstElementChild;
        return [first.className, [...first.querySelectorAll("button")]
            .map((b) => b.textContent)];
    })()`), ["toolbar-group design-group", [
        "brainstorm", "brainstorm", "draft", "review design", "review loop", "resolve",
        "drift report", "bootstrap",
    ]]);
    await shot("96-design-compact-menu");
    await send("Emulation.setDeviceMetricsOverride", {
        width: 1500, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    console.log("design-actions ok");
    await finish();
}

if (flow === "design-gate") {
    // The gate cards (egm-adoption.md entries 3.21, 3.22, 3.24; session-workspace.md K1)
    // against the fixture. On the gate session's Brainstorm tab the gate is one compact line,
    // `The lead asks: … → answer in Agents`, which opens Agents with `lead` picked. The
    // `needs you` pill does the same from Implement. The card above the chips shows the
    // question as markdown and one button per option. A click sends the option's full text
    // and the card goes on the next `session.updated`. The resolving session shows the
    // resolve line on Review and the resolve card in Agents; `auto accept` sends
    // `Auto accept`. A gate the lead asks while the page is open shows at once, and the
    // "other answer" box answers it.
    const card = `document.querySelector(".agents-pane .agents-view .design-gate")`;
    const line = `document.querySelector(".agents-pane .design-gate-compact")`;
    const needs = `document.querySelector(".context-bar .context-needs")`;
    const shown = `document.querySelector(".agents-pane .view-tab.tab-selected")?.dataset.view`;
    // Wide enough that the nine tabs do not fold, so the selected tab's id is the view's.
    await send("Emulation.setDeviceMetricsOverride", {
        width: 1920, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await click(".session", "CSV export \u00b7 gate");
    await until("gate session", `${text(".context-title")} === "CSV export \u00b7 gate"`);
    await click(".agents-pane .view-tab", "Brainstorm");
    await until("compact gate line", `${shown} === "brainstorm" && ${line} !== null
        && ${line}.innerText === "The lead asks: Which export shape should the brief carry "
            + "forward? - Streamed CSV: rows go out as the query reads them. - Background job"
            + "\u2026 \u2192 answer in Agents"
        && ${line}.querySelectorAll("button").length === 1`);
    await shot("96-design-gate-line");
    await click(".design-gate-compact button", "answer in Agents");
    await until("agents from the line", `${shown} === "agents" && ${card} !== null
        && document.querySelector(".chip-selected .chip-name")?.dataset.name === "lead"`);
    await click(".agents-pane .view-tab", "Implement");
    await until("implement view", `document.querySelector(".agents-view")?.hidden === true`);
    await until("needs pill is a button", `${needs}?.tagName === "BUTTON"`);
    await click(".context-bar .context-needs");
    await until("gate card shown", `${card} !== null
        && document.querySelector(".agents-view")?.hidden === false`);
    await expectSame("gate card", await evaluate(`({
        kind: ${card}.dataset.kind,
        title: ${card}.querySelector(".design-gate-title").textContent,
        strong: [...${card}.querySelectorAll(".design-gate-question strong")]
            .map((e) => e.textContent),
        options: [...${card}.querySelectorAll(".design-gate-options button")]
            .map((b) => b.textContent),
        lead: document.querySelector(".chip-selected .chip-name")?.dataset.name,
        aboveChips: ${card}.nextElementSibling?.classList.contains("chips"),
    })`), {
        kind: "gate", title: "The lead asks", strong: ["Streamed CSV", "Background job"],
        options: [
            "Streamed CSV from the list page", "Background job with a mailed link",
            "Both, picked by row count",
        ],
        lead: "lead",
        aboveChips: true,
    });
    await shot("97-design-gate");
    await click(".design-gate-options button", "Background job");
    await until("gate card gone", `${card} === null`);
    await until("needs cleared", `${needs} === null`);
    await expectSame("gate answer", await received("s211-csv-gate"), {
        answers: ["Background job with a mailed link"], runs: [],
    });
    await shot("98-design-gate-answered");

    // A gate the lead asks now: the card shows from `session.updated`; the box answers it.
    const asked = await fetch(new URL("/sessions/s211-csv-gate/design/gate", uiUrl), {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "Name the CSV columns?", options: ["Yes", "No"] }),
    });
    await expectSame("gate put", asked.status, 200);
    await until("new gate card", `${card}?.innerText.includes("Name the CSV columns?") === true`);
    await fill(".design-gate-other input", "Only id, total and date");
    await click(".design-gate-other button", "send");
    await until("new gate card gone", `${card} === null`);

    await click(".session", "CSV export \u00b7 resolving");
    await until("resolving selected",
        `${text(".context-title")} === "CSV export \u00b7 resolving"`);
    await click(".agents-pane .view-tab", "Review");
    await until("resolve line", `${shown} === "review" && ${line}?.dataset.kind === "resolve"`);
    await click(".design-gate-compact button", "open Agents");
    await until("resolve card", `${shown} === "agents" && ${card}?.dataset.kind === "resolve"`);
    await expectSame("resolve card", await evaluate(`({
        title: ${card}.querySelector(".design-gate-title").textContent,
        options: [...${card}.querySelectorAll(".design-gate-options button")]
            .map((b) => [b.textContent, b.title]),
    })`), {
        title: "Resolve the review findings",
        options: [
            ["auto accept", "Auto accept"], ["continue", "Continue"],
            ["interactive breakdown", "Interactive breakdown"],
        ],
    });
    await shot("99-design-resolve");
    await click(".design-gate-options button", "auto accept");
    await until("resolve card gone", `${card} === null`);
    await expectSame("resolve answer", await received("s206-csv-resolving"), {
        answers: ["Auto accept"], runs: [],
    });
    await expectSame("other answer", await received("s211-csv-gate"), {
        answers: ["Background job with a mailed link", "Only id, total and date"], runs: [],
    });
    console.log("design-gate ok");
    await finish();
}

if (flow === "approve-design") {
    // The approve dialog (egm-adoption.md entries 6.16 to 6.18; session-workspace.md T4, T5,
    // entry 2.22) against the fixture. At design-ready the Review tab's header carries the
    // `approve design` primary, as the toolbar does; its dialog names the doc, has `start the
    // build` checked, and confirms with `approve and build`. The report lists 1 blocker, so
    // the first post is a 409 and the dialog asks `approve with 1 listed blocker`, which
    // posts `blockers_confirmed: 1`; the dialog then shows the seed counts, the Implement tab
    // marks Build active and the Plan holds the seeded rows, and the `EGM ▾` menu ends with
    // `remove approval`, which takes the session back. The changed session reads `re-approve
    // design`; its Draft tab has the "Changed since approval" banner, whose dialog shows the
    // Technical Plan side by side and approves without a build.
    const primary = `document.querySelector(".context-bar .design-group > .primary")`;
    const dialog = `document.querySelector(".approve-dialog")`;
    const confirm = `(${dialog}?.querySelector(".confirm-actions .primary")?.textContent ?? "")`;
    const tabState = (view: string) =>
        `document.querySelector(".agents-pane .view-tab[data-view=${view}]")?.dataset.state`;
    const buildActive =
        `(${tabState("review")} === "done" && ${tabState("implement")} === "active")`;
    const approves = async (dir: string) => {
        const url = new URL(`/sessions/${dir}/design/approve-received`, uiUrl);
        return ((await (await fetch(url)).json()) as { approves: unknown[] }).approves;
    };
    const pick = async (title: string) => {
        await click(".session", title);
        await until(`${title} selected`, `${text(".context-title")} === ${JSON.stringify(title)}`);
    };
    await send("Emulation.setDeviceMetricsOverride", {
        width: 1920, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    await pick("CSV export \u00b7 design-ready");
    await until("approve primary", `${primary}?.textContent === "approve design"`);
    await until("review waits", `${tabState("review")} === "waiting"`);
    await click(".agents-pane .view-tab", "Review");
    await until("approve header", `${text(".agents-pane .dw-approve-head")}
        === "The review is done\\napprove design"`);
    await click(".agents-pane .dw-approve-head .dw-approve", "approve design");
    await until("approve dialog", `${dialog}?.getAttribute("aria-label") === "Approve the design"`);
    await expectSame("approve dialog", await evaluate(`({
        doc: ${dialog}.querySelector(".approve-doc code").textContent,
        build: ${dialog}.querySelector(".approve-build input").checked,
        confirm: ${confirm},
        primaries: ${dialog}.querySelectorAll("button.primary").length,
        changes: ${dialog}.querySelector(".approve-changes") !== null,
    })`), {
        doc: "docs/designs/csv-export.md", build: true, confirm: "approve and build",
        primaries: 1, changes: false,
    });
    await click(".approve-build input");
    await until("confirm without build", `${confirm} === "approve"`);
    await click(".approve-build input");
    await until("confirm with build", `${confirm} === "approve and build"`);
    await shot("100-approve-dialog");
    await click(".approve-dialog .confirm-actions .primary", "approve and build");
    await until("blocker confirmation", `${confirm} === "approve with 1 listed blocker"`);
    await expectSame("blocker line", await evaluate(text(".approve-dialog .approve-blockers")),
        "The newest review report lists 1 blocker.");
    await shot("101-approve-blockers");
    await click(".approve-dialog .confirm-actions .primary", "approve with 1 listed blocker");
    await until("seed counts shown", `${text(".approve-dialog .approve-seed")}
        === "Plan seeded: 7 added, 3 kept, 0 stale, 0 orphaned"`);
    await shot("101a-approve-seeded");
    await until("dialog closed", `${dialog} === null`);
    await until("build active", buildActive);
    await until("no primary once approved", `${primary} === null
        && document.querySelector(".agents-pane .dw-approve-head") === null`);
    await expectSame("approve bodies", await approves("s207-csv-design-ready"), [
        { build: true }, { build: true, blockers_confirmed: 1 },
    ]);
    await click(".agents-pane .view-tab", "Implement");
    // The seeded phases, collapsed: `Other` holds the doing row, so it alone is open (T6).
    await until("seeded phases", `[...document.querySelectorAll(".im-phase")]
        .map((p) => p.querySelector(".im-phase-label").textContent + " "
            + p.querySelector(".mw-count").textContent + " " + p.dataset.open).join("; ")
        === "Build session 1: the route 0 / 3 false; Build session 2: the button 0 / 2 false; "
            + "Build session 3: the docs 0 / 2 false; Other 1 / 3 true"
        && ${text(".im-header")}.includes("entries done 0 / 7")`);
    await click(".im-phase[data-phase=phase-1] .im-phase-toggle");
    await until("phase 1 rows", `[...document.querySelectorAll(
        ".im-phase[data-phase=phase-1] .im-row")].map((row) => row.dataset.entry).join()
        === "1.1,1.2,1.3"`);
    await shot("102-approved-build");

    // `remove approval` ends the menu while an approval exists and takes the session back.
    await click(".context-bar .design-menu > button", "EGM");
    await until("EGM menu", `document.querySelector(".design-menu .menu") !== null`);
    await expectSame("menu end", await evaluate(`[...document.querySelectorAll(
        ".design-menu .menu button")].slice(-2).map((b) => [b.textContent, b.disabled])`), [
        ["bootstrap", false], ["remove approval", false],
    ]);
    await shot("103-remove-approval-menu");
    await click(".design-menu .menu button", "remove approval");
    await until("approval removed", `${primary}?.textContent === "approve design"
        && ${tabState("review")} === "waiting"`);
    await click(".context-bar .design-menu > button", "EGM");
    await until("EGM menu again", `document.querySelector(".design-menu .menu") !== null`);
    await expectSame("no remove item", await evaluate(`[...document.querySelectorAll(
        ".design-menu .menu button")].some((b) => b.textContent === "remove approval")`), false);
    await click(".context-bar .design-menu > button", "EGM");

    // The changed session: the re-approve primary and needs line, the banner, the changes.
    await pick("CSV export \u00b7 changed");
    await until("re-approve primary", `${primary}?.textContent === "re-approve design"`);
    await expectSame("needs line", await evaluate(text(".context-bar .context-needs")),
        "re-approve the design (changed since approval)");
    await click(".agents-pane .view-tab", "Draft");
    await until("changed banner", `${text(".agents-pane .dw-changed-banner")}
        .startsWith("Changed since approval")`);
    await shot("104-changed-banner");
    await click(".agents-pane .dw-changed-banner button", "re-approve design");
    await until("re-approve dialog", `${dialog}?.getAttribute("aria-label")
        === "Re-approve the design" && ${dialog}.querySelector(".approve-change") !== null`);
    await expectSame("changes", await evaluate(`[...${dialog}.querySelectorAll(
        ".approve-change")].map((row) => [row.dataset.heading,
        ...[...row.querySelectorAll(".approve-side")].map((side) => [side.dataset.side,
            side.querySelector("pre")?.textContent ?? null])])`), [[
        "Technical Plan",
        ["approved", "`GET /exports/:list.csv` streams every row of the list."],
        ["current", "`GET /exports/:list.csv` streams rows with the list's filters."],
    ]]);
    await expectSame("side by side", await evaluate(`(() => {
        const [left, right] = [...${dialog}.querySelectorAll(".approve-side")]
            .map((side) => side.getBoundingClientRect());
        return Math.abs(left.top - right.top) < 1 && left.right <= right.left;
    })()`), true);
    await shot("105-reapprove-changes");
    await click(".approve-build input");
    await until("confirm without build", `${confirm} === "approve"`);
    await click(".approve-dialog .confirm-actions .primary", "approve");
    await until("re-approved", `${dialog} === null
        && document.querySelector(".agents-pane .dw-changed-banner") === null && ${buildActive}`);
    await expectSame("re-approve bodies", await approves("s212-csv-changed"), [{ build: false }]);
    await shot("106-reapproved");
    await click(".agents-pane .view-tab", "Agents");
    await send("Emulation.setDeviceMetricsOverride", {
        width: 1500, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await until("no error", `document.querySelector(".drawer .needs-human") === null`);
    console.log("approve-design ok");
    await finish();
}

if (flow === "goldfish") {
    // The Goldfish chips (docs/designs/egm-adoption.md, entries 4.14 to 4.18) against the
    // fixture. The design-review session shows six chips under the agent chips, the review run
    // first: the 🐟 mark, a dot per state, the persona, the tokens and `$`; a failed chip's
    // tooltip says `not run`. A click shows that Goldfish's transcript in place of the lead's
    // tabs, read-only, and reloads it every 2 s while it runs; a step without a transcript says
    // so; the lead chip returns. The Review tab carries `2 live` for the running Goldfish and
    // each EGM tab's tooltip ends with its step's Goldfish cost. The brainstorm session is at
    // the cap.
    await send("Emulation.setDeviceMetricsOverride", {
        width: 1920, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    const chips = `[...document.querySelectorAll(".agents-pane .gf-chips .gf-chip")]`;
    const transcript = `document.querySelector(".agents-pane .gf-transcript")`;
    const pickChip = (persona: string) => click(".gf-chip .chip-name", persona);
    await click(".session", "CSV export \u00b7 design-review");
    await until("six Goldfish chips", `${chips}.length === 6`);
    await expectSame("chips", await evaluate(`${chips}.map((c) => [
        c.dataset.state, c.querySelector(".gf-name").textContent,
        [...c.querySelectorAll(".gf-fact")].map((f) => f.textContent).join(" "),
        c.querySelector(".gf-mark").textContent,
        c.querySelector(".chip-dot").className.replace(/.*dot-/, ""),
    ])`), [
        ["running", "critic", "25k $0.45", "\u{1F41F}", "working"],
        ["running", "design", "9.3k $0.38", "\u{1F41F}", "working"],
        ["failed", "security", "15k $0.37", "\u{1F41F}", "failed"],
        ["queued", "readiness", "0.0k $0.00", "\u{1F41F}", "idle"],
        ["done", "zoom_out", "18k $0.30", "\u{1F41F}", "up"],
        ["stopped", "comprehension", "6.4k $0.12", "\u{1F41F}", "off"],
    ]);
    await expectSame("under the agent chips", await evaluate(`document.querySelector(
        ".agents-pane .gf-block").previousElementSibling?.getAttribute("aria-label")`), "Agents");
    await expectSame("failed tooltip", await evaluate(`${chips}[2]
        .querySelector(".chip-name").title`),
    "egm-security \u00b7 anthropic/claude-opus-5-5 \u00b7 failed, not run \u00b7 15k tokens " +
        "\u00b7 $0.37");
    await expectSame("tab marks", await evaluate(`[...document.querySelectorAll(
        ".agents-pane .view-tab[data-state]")].map((t) => [t.dataset.view,
        t.querySelector(".view-tab-suffix")?.textContent ?? null,
        t.title.replace(${JSON.stringify(EGM_NOTICE)} + "\\n", "")])`), [
        ["brainstorm", null, "Brainstorm: done \u00b7 Goldfish: $0.42"],
        ["draft", null, "Draft: done \u00b7 Goldfish: $0.18"],
        ["review", "3/5 2 live", "Review: active \u00b7 Goldfish: $1.20\nApprove: todo"],
        ["implement", null, "Build: todo \u00b7 Goldfish: $0.00"],
    ]);
    await expectSame("no cap line", await evaluate(
        `document.querySelector(".agents-pane .gf-cap")`), null);
    await shot("A0-goldfish-chips");

    // The critic's transcript replaces the lead's tabs and its terminal; no prompt form.
    await pickChip("critic");
    await until("critic transcript", `${transcript}?.innerText
        .includes("Finding 1: the export has no row limit.") === true`);
    await expectSame("transcript view", await evaluate(`({
        selected: document.querySelector(".gf-chip.chip-selected .gf-name")?.textContent,
        agentSelected: document.querySelector(
            ".agents-pane .chips .chip-selected .chip-name[data-name]")?.dataset.name ?? null,
        subTabs: document.querySelectorAll(".agents-view .tabs-sub").length,
        prompt: document.querySelectorAll(".agents-view .prompt-form").length,
        terminal: [...document.querySelectorAll(".agents-view .agent-terminal")]
            .some((t) => !t.hidden),
        entries: ${transcript}.querySelectorAll(".transcript .entry").length,
        tool: ${transcript}.querySelector(".entry-tool code")?.textContent,
    })`), {
        selected: "critic", agentSelected: null, subTabs: 0, prompt: 0, terminal: false,
        entries: 4, tool: "read",
    });
    await shot("A1-goldfish-transcript");
    // A running Goldfish reloads every 2 s: at least two more requests within 5 s.
    const loads = `performance.getEntriesByType("resource")
        .filter((e) => e.name.includes("/egm/goldfish/e5f6a7b8/0/events")).length`;
    const first = Number(await evaluate(loads));
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const later = Number(await evaluate(loads));
    console.log(`transcript loads: ${first} then ${later}`);
    if (later - first < 2) {
        await shot("failure");
        await closeTarget();
        throw new Error(`the running transcript did not reload: ${first} then ${later}`);
    }

    // A step without a transcript file says so and is not requested.
    await pickChip("security");
    await until("no transcript line", `${transcript}?.innerText
        .includes("This Goldfish has no transcript yet.") === true`);
    await expectSame("no request without a transcript", await evaluate(`performance
        .getEntriesByType("resource")
        .filter((e) => e.name.includes("/egm/goldfish/e5f6a7b8/2/events")).length`), 0);
    await shot("A2-goldfish-no-transcript");

    // The lead chip returns to its tabs.
    await click(".agents-pane .chips .chip-name[data-name=lead]");
    await until("lead tabs back", `${transcript} === null
        && document.querySelectorAll(".agents-view .tabs-sub").length === 1`);
    await expectSame("after lead", await evaluate(`({
        fish: document.querySelectorAll(".gf-chip.chip-selected").length,
        lead: document.querySelector(".agents-pane .chip-selected .chip-name")?.dataset.name,
    })`), { fish: 0, lead: "lead" });

    // The cap: 12 live Goldfish across sessions; the session has no chips of its own.
    await click(".session", "CSV export \u00b7 brainstorm");
    await until("cap line", `${text(".agents-pane .gf-cap")} ===
        "12 Goldfish running across sessions; new skill starts wait"`);
    await expectSame("cap chips", await evaluate(`${chips}.length`), 0);
    await shot("A3-goldfish-cap");
    await click(".session", "CSV export \u00b7 intake");
    await until("no Goldfish block", `${text(".context-title")} === "CSV export \u00b7 intake"
        && document.querySelector(".agents-pane .gf-block") === null`);
    await send("Emulation.setDeviceMetricsOverride", {
        width: 1500, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    console.log("goldfish ok");
    await finish();
}

if (flow === "composer") {
    // The composer (s038), against the fixture. `+ New session` in the sidebar opens the
    // working area as one large box with its placeholder, the project select and `Start` as the
    // one primary button; the sidebar holds the button alone, pressed. A paste lists the PRs
    // found under the box. A look at a session leaves the composer, and the button brings the
    // draft back. `Start` posts `POST /sessions`: the created session is selected and the
    // middle pane shows the agents view with `lead` picked. `+ New review` opens the same
    // composer for PR links with `Start review`; the created review is selected.
    const form = `document.querySelector(".composer form[aria-label='New session']")`;
    const box = "textarea[aria-label='What this is about']";
    const addNew = ".sidebar button.side-add[aria-label='New session']";
    if ((await evaluate(`document.querySelector(".composer-pane") !== null`)) === true) {
        throw new Error("a session is selected on load, so the composer must not show");
    }
    await click(addNew);
    await until("composer in the middle", `${form} !== null`);
    const options = `[...document.querySelectorAll(".composer select[aria-label=Project] option")]`;
    await until("projects loaded", `${options}.some((o) => o.textContent === "sample-stack")`);
    const shape = await evaluate(`(() => {
        const side = document.querySelector(".sidebar").getBoundingClientRect();
        const pane = document.querySelector(".composer-pane").getBoundingClientRect();
        const previews = document.querySelector(".preview-pane").getBoundingClientRect();
        return {
            placeholder: document.querySelector(${JSON.stringify(box)}).placeholder,
            between: pane.left >= side.right && pane.right <= previews.left,
            agentsPane: document.querySelectorAll(".agents-pane").length,
            sidebarForms: document.querySelectorAll(".sidebar form, .sidebar textarea").length,
            primary: [...document.querySelectorAll(".composer-pane button.primary")]
                .map((b) => b.textContent),
            pressed: document.querySelector(${JSON.stringify(addNew)}).ariaPressed,
            selectedCards: document.querySelectorAll(".session-selected").length,
        };
    })()`);
    console.log("composer:", JSON.stringify(shape));
    const wanted = {
        placeholder:
            "What should this session be about? Paste a ticket, a PR link, or a sentence.",
        between: true, agentsPane: 0, sidebarForms: 0, primary: ["Start"], pressed: "true",
        selectedCards: 0,
    };
    if (JSON.stringify(shape) !== JSON.stringify(wanted)) {
        throw new Error("the composer is not the one box in the working area");
    }
    await shot("composer-1-empty");
    await evaluate(`(() => {
        const select = document.querySelector(".composer select[aria-label=Project]");
        const option = [...select.options].find((o) => o.textContent === "sample-stack");
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
        setter.call(select, option.value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    })()`);
    const stamp = Date.now() % 100000;
    const paste = [
        `E2E composer ${stamp}`,
        "Finish the refund copy: https://github.com/example/web/pull/412 and api#87.",
    ].join("\n");
    await fill(box, paste);
    const boxes = `[...document.querySelectorAll(".composer .compose-prs input")]`;
    await until("two PRs found under the box", `${boxes}.length === 2`);
    await shot("composer-2-prs-found");
    // A look at a session leaves the composer; the button brings the draft back.
    await click(".session", "Refund flow");
    await until("composer left", `${form} === null`);
    await until("the session shown", `document.querySelector(".agents-pane .view-tabs") !== null`);
    await until("button released", `document.querySelector(${JSON.stringify(addNew)})
        .ariaPressed === "false"`);
    await click(addNew);
    await until("composer back", `${form} !== null`);
    const kept = await evaluate(`document.querySelector(${JSON.stringify(box)}).value`);
    if (kept !== paste) {
        throw new Error("the draft did not survive a switch to a session and back");
    }
    await until("PRs found again", `${boxes}.length === 2`);
    await click(".composer .compose-actions .primary", "Start");
    const selected = text(".session-selected");
    await until("created session selected", `${selected}.includes("E2E composer ${stamp}")`);
    await until("composer gone", `${form} === null`);
    const lead = `document.querySelector(".agents-pane .chip-selected .chip-name")?.dataset.name`;
    await until("lead picked", `${lead} === "lead"`);
    await until("agents view shown", `document.querySelector(".agents-pane .view-tab.tab-selected")
        ?.textContent === "Agents"`);
    await until("lead terminal shown",
        `document.querySelector(".agent-terminal:not([hidden])") !== null`);
    await shot("composer-3-lead-after-start");
    // The review composer: the same box for PR links, `Start review`.
    await click(".activity-bar button[aria-label='Show reviews']");
    await until("reviews view", `document.querySelector(".reviews-pane") !== null`);
    await click(".sidebar button.side-add[aria-label='New review']");
    const reviewForm = `document.querySelector(".composer form[aria-label='New review']")`;
    await until("review composer", `${reviewForm} !== null`);
    await fill("textarea[aria-label='Pull requests to review']",
        "please look at https://github.com/acme/peanut/pull/9");
    await until("PR found", `${text(".composer .rv-found")}.includes("acme/peanut#9")`);
    await click(".composer .compose-actions .primary", "Start review");
    await until("new review selected", `${text(".rv-card-selected")}.includes("PR 9 of peanut")`);
    await until("review pane shown", `document.querySelector(".rv-pane .rv-head") !== null`);
    await until("review composer gone", `${reviewForm} === null`);
    await shot("composer-4-review-started");
    console.log("composer ok");
    await finish();
}

if (flow === "archive") {
    // `archive` (s038), against the fixture. Every session card carries the action. It asks
    // once in place of the card; `cancel` keeps the card; the confirm runs `close`, the card
    // goes and the selection moves to the next row. The context bar's `⋯` menu asks the same
    // question. A review card does the same. With every session archived, the middle pane is
    // the composer: the empty state.
    const question = "Archive this session? It moves to the archive and its agents stop.";
    const dirs = `[...document.querySelectorAll(".session")].map((c) => c.dataset.dir)`;
    const selectedDir = `document.querySelector(".session-selected")?.dataset.dir`;
    const before = (await evaluate(dirs)) as string[];
    const counts = await evaluate(`[document.querySelectorAll(".session-item").length,
        document.querySelectorAll(".session-item .card-archive").length]`);
    if (JSON.stringify(counts) !== JSON.stringify([before.length, before.length])) {
        throw new Error("not every session card has an archive action");
    }
    const [first, second, third] = before;
    if (first === undefined || second === undefined || third === undefined) {
        throw new Error("the fixture needs three sessions");
    }
    const card = (dir: string) => `.session[data-dir='${dir}']`;
    await click(card(first));
    await until("first selected", `${selectedDir} === ${JSON.stringify(first)}`);
    // The pill shows under the pointer.
    const at = (await evaluate(`(() => {
        const r = document.querySelector(${JSON.stringify(card(first))}).getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)) as { x: number; y: number };
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
    const pill = `.session-item:has(${card(first)}) .card-archive`;
    await until("pill on hover",
        `getComputedStyle(document.querySelector(${JSON.stringify(pill)})).opacity === "1"`);
    await click(pill);
    await until("asked in place", `${text(".session-item .card-confirm")}.includes(${
        JSON.stringify(question)})`);
    await shot("archive-1-confirm");
    await click(".card-confirm button", "cancel");
    await until("cancel keeps the card", `document.querySelector(".card-confirm") === null
        && document.querySelector(${JSON.stringify(card(first))}) !== null`);
    await click(pill);
    await until("asked again", `document.querySelector(".card-confirm") !== null`);
    await click(".card-confirm button.danger", "archive");
    await until("selection on the next row", `${selectedDir} === ${JSON.stringify(second)}`);
    await until("card gone", `!${dirs}.includes(${JSON.stringify(first)})`);
    await until("close ran", `${text(".drawer")}.includes("close · ok")`);
    await shot("archive-2-gone-next-selected");
    // The context bar's menu: the same question, the same move.
    await clickEndAction("archive");
    await until("menu archive moves on", `${selectedDir} === ${JSON.stringify(third)}`);
    await until("second card gone", `!${dirs}.includes(${JSON.stringify(second)})`);
    // A review card.
    await click(".activity-bar button[aria-label='Show reviews']");
    await until("a review selected", `document.querySelector(".rv-card-selected") !== null`);
    const reviewDirs = `[...document.querySelectorAll(".rv-card")].map((c) => c.dataset.dir)`;
    const reviews = (await evaluate(reviewDirs)) as string[];
    await until("the first review shown",
        `document.querySelector(
            ".rv-card-selected").dataset.dir === ${JSON.stringify(reviews[0])}`);
    await click(".rv-card-selected .card-archive");
    await until("review asked in place",
        `${text(".rv-card .card-confirm")}.includes(${JSON.stringify(question)})`);
    await shot("archive-3-review-confirm");
    await click(".rv-card .card-confirm button.danger", "archive");
    await until("review selection moved",
        `document.querySelector(
            ".rv-card-selected")?.dataset.dir === ${JSON.stringify(reviews[1])}`);
    await until("review card gone", `!${reviewDirs}.includes(${JSON.stringify(reviews[0])})`);
    // Every other session goes through the daemon's route; the composer is the empty state.
    const listed = (await (await fetch(new URL("/sessions", uiUrl))).json()) as
        SessionView[] | { sessions: SessionView[] };
    const rest = Array.isArray(listed) ? listed : listed.sessions;
    for (const view of rest) {
        await fetch(new URL(`/sessions/${view.summary.dir}/close`, uiUrl), {
            method: "POST", headers: { "content-type": "application/json" }, body: "{}",
        });
    }
    await until("no review left", `document.querySelectorAll(".rv-card").length === 0`);
    await click(".activity-bar button[aria-label='Show sessions']");
    await until("no session left", `document.querySelectorAll(".session").length === 0`);
    await until("the composer is the empty state",
        `document.querySelector(".composer form[aria-label='New session']") !== null`);
    await shot("archive-4-empty-state");
    console.log("archive ok");
    await finish();
}

if (flow === "agents") {
    // A session without a design block opens on Implement (session-workspace.md T5).
    await click(".session", "Refund flow");
    await click(".agents-pane .view-tab", "Agents");
    await until("agent tab", `document.querySelector(".agents-pane .tabs-sub .tab") !== null`);
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
// The `+ New session` button pinned under the sessions panel's title opens the composer in
// the working area (s038).
await click(".sidebar button.side-add[aria-label='New session']");
const newForm = `document.querySelector(".composer form[aria-label='New session']")`;
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
await click(".agents-pane .tab", "Services");
await until(
    "service healthy",
    `[...document.querySelectorAll(".services tbody tr")]
        .some((r) => r.innerText.includes("healthy"))`,
);
await until(
    "preview tab dot",
    `document.querySelector(".preview-pane .tab .tab-dot.dot-healthy")?.title === "healthy"`,
);
await click(".agents-pane .tab", "Agents");
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

await clickEndAction("archive");
await until("session gone", `!${text(".sessions-pane")}.includes(${quoted})`);
await shot("06-closed");
console.log("lifecycle ok");
await finish();
