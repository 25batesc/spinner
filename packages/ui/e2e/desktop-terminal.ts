// The terminal tab in the desktop app, over the DevTools protocol (Plan 6 of s009). Start the
// app against a scratch daemon that hosts one tty agent first:
//   SPINNER_PORT=<port> electron . --remote-debugging-port=<cdp> --user-data-dir=<scratch>
// then `E2E_CDP_PORT=<cdp> E2E_SESSION=<title> node e2e/desktop-terminal.ts <screenshot dir>`.
// Checks: keystrokes reach pi's editor; the arrow keys reach the pty (two left, then a
// character lands inside the word); a paste lands in the editor; a Cmd shortcut is left to
// the window (xterm neither consumes it nor writes to the pty); the agents pane pops out
// through the bridge and the window carries the terminal with the scrollback; Ctrl-C reaches
// the pty (pi clears its editor). Screenshots come from `Page.captureScreenshot`.
import { writeFileSync } from "node:fs";

const [outDir] = process.argv.slice(2);
if (outDir === undefined) {
    throw new Error("Usage: desktop-terminal.ts <screenshot dir>");
}
const CDP_PORT = process.env["E2E_CDP_PORT"] ?? "9362";
const SESSION = process.env["E2E_SESSION"] ?? "ui terminal check";
const TIMEOUT_MS = 60_000;

interface Target {
    id: string;
    url: string;
    type: string;
    webSocketDebuggerUrl: string;
}

async function targets(): Promise<Target[]> {
    return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as Target[];
}

class Page {
    private nextId = 0;
    private readonly waiting = new Map<number, (value: Record<string, unknown>) => void>();
    private readonly socket: WebSocket;
    private constructor(socket: WebSocket) {
        this.socket = socket;
    }

    static async open(target: Target): Promise<Page> {
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve) => socket.addEventListener("open", resolve));
        const page = new Page(socket);
        socket.addEventListener("message", (message) => {
            const data = JSON.parse(String(message.data)) as {
                id?: number; result?: Record<string, unknown>;
            };
            if (data.id !== undefined) {
                page.waiting.get(data.id)?.(data.result ?? {});
            }
        });
        return page;
    }

    send(method: string, params: object = {}): Promise<Record<string, unknown>> {
        this.nextId += 1;
        const id = this.nextId;
        return new Promise((resolve) => {
            this.waiting.set(id, resolve);
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    async evaluate(expression: string): Promise<unknown> {
        const result = (await this.send("Runtime.evaluate", {
            expression, returnByValue: true, awaitPromise: true,
        })) as { result?: { value?: unknown } };
        return result.result?.value;
    }

    async until(label: string, expression: string): Promise<void> {
        const deadline = Date.now() + TIMEOUT_MS;
        while (Date.now() < deadline) {
            if ((await this.evaluate(expression)) === true) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        throw new Error(`Timed out waiting for: ${label}`);
    }

    async shot(name: string): Promise<void> {
        const result = (await this.send("Page.captureScreenshot", { format: "png" })) as {
            data?: string;
        };
        if (result.data === undefined) {
            console.log(`no screenshot for ${name} (the window is not painted)`);
            return;
        }
        writeFileSync(`${outDir}/${name}.png`, Buffer.from(result.data, "base64"));
        console.log(`screenshot ${outDir}/${name}.png`);
    }

    key(key: string, code: string, keyCode: number, text = "", modifiers = 0): Promise<unknown> {
        const down = this.send("Input.dispatchKeyEvent", {
            type: text === "" ? "rawKeyDown" : "keyDown", key, code, modifiers,
            windowsVirtualKeyCode: keyCode, ...(text === "" ? {} : { text }),
        });
        return down.then(() => this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code }));
    }

    async type(text: string): Promise<void> {
        for (const char of text) {
            const upper = char.toUpperCase();
            await this.key(char, `Key${upper}`, upper.charCodeAt(0), char);
        }
    }

    close(): void {
        this.socket.close();
    }
}

const CTRL = 2;
const META = 4;
const rows =
    `(document.querySelector(".agent-terminal:not([hidden]) .xterm-rows")?.innerText ?? "")`;
const click = (selector: string, text: string) =>
    `(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
            .find((e) => e.textContent.includes(${JSON.stringify(text)}));
        if (!el) return false;
        el.click();
        return true;
    })()`;
let checks = 0;
function check(ok: boolean, label: string): void {
    checks += 1;
    console.log(`${ok ? "ok" : "FAIL"}: ${label}`);
    if (!ok) {
        throw new Error(label);
    }
}

const main = (await targets()).find((t) => t.type === "page" && !t.url.includes("pane="));
if (main === undefined) {
    throw new Error("no main window target");
}
const ui = await Page.open(main);
await ui.send("Page.enable");
await ui.until("sessions", `document.querySelector("[aria-label=Sessions]") !== null`);
await ui.evaluate(click(".session", SESSION));
await ui.until("terminal", `${rows}.length > 0`);
const session = (await ui.evaluate(
    `document.querySelector(".session-selected").dataset.dir`,
)) as string;
await ui.evaluate(`document.querySelector(".xterm-helper-textarea").focus(), true`);
// A key passes pi's start notice if it is still up; then the editor shows the typed text.
await ui.key(" ", "Space", 32, " ");
await new Promise((resolve) => setTimeout(resolve, 800));
// An earlier run's text in the editor: one Ctrl-C clears it (pi exits only on a second).
if (((await ui.evaluate(rows)) as string).includes("desk")) {
    await ui.key("c", "KeyC", 67, "\u0003", CTRL);
    await ui.until("editor cleared", `!${rows}.includes("desk")`);
}
await ui.type("desk");
await ui.until("keystrokes in pi's editor", `${rows}.includes("desk")`);
check(true, "keystrokes reach pi's editor");
await ui.shot("63-desktop-typed");

// Two arrow keys left, then a character: it lands inside the word, so the line reads `deXsk`.
await ui.key("ArrowLeft", "ArrowLeft", 37);
await ui.key("ArrowLeft", "ArrowLeft", 37);
await ui.type("X");
await ui.until("arrow keys moved the cursor", `${rows}.includes("deXsk")`);
check(true, "the arrow keys reach the pty (the line reads deXsk)");

// A paste through the textarea's paste event, as Cmd-V ends up in the renderer.
await ui.evaluate(`(() => {
    const textarea = document.querySelector(".xterm-helper-textarea");
    const event = new ClipboardEvent("paste", {
        bubbles: true, cancelable: true, clipboardData: new DataTransfer(),
    });
    event.clipboardData.setData("text/plain", " pasted-text");
    textarea.dispatchEvent(event);
    return true;
})()`);
await ui.until("pasted text in the editor", `${rows}.includes("pasted-text")`);
check(true, "a paste lands in the editor");
await ui.shot("64-desktop-pasted");

// A Cmd shortcut: xterm leaves it to the window. The keydown reaches the window unprevented
// and the editor does not change.
const before = (await ui.evaluate(rows)) as string;
await ui.evaluate(`window.__metaSeen = []; window.addEventListener("keydown", (e) => {
    if (e.metaKey) window.__metaSeen.push({ key: e.key, prevented: e.defaultPrevented });
}, true), true`);
await ui.evaluate(`window.__metaPrevented = null; window.addEventListener("keydown", (e) => {
    if (e.metaKey) window.__metaPrevented = e.defaultPrevented;
}), true`);
await ui.key("k", "KeyK", 75, "", META);
await ui.until("meta keydown seen", `window.__metaSeen.length > 0`);
await new Promise((resolve) => setTimeout(resolve, 500));
const metaPrevented = await ui.evaluate(`window.__metaPrevented`);
const after = (await ui.evaluate(rows)) as string;
check(metaPrevented === false, `Cmd-K keydown left to the window (defaultPrevented false)`);
check(before === after, "Cmd-K wrote nothing to the pty");

const rowWidth = `${rows}.split("\\n")[0].length`;
const paneWidth = (await ui.evaluate(rowWidth)) as number;
// The agents pane window through the bridge, as the tray opens it: the new window loads the
// pane route and carries the terminal with the scrollback, a second attachment to the pty.
await ui.evaluate(`window.spinnerDesktop.panes.popOut("agents", ${JSON.stringify(session)})`);
let popped: Target | undefined;
for (let tries = 0; popped === undefined && tries < 50; tries += 1) {
    popped = (await targets()).find((t) => t.url.includes("pane=agents"));
    await new Promise((resolve) => setTimeout(resolve, 200));
}
check(popped !== undefined, `the agents window opened (${popped?.url ?? "none"})`);
const win = await Page.open(popped as Target);
await win.send("Page.enable");
await win.until("terminal in the window", `${rows}.includes("pasted-text")`);
check(true, "the pop-out window carries the terminal with the scrollback");
await win.until("pi reflowed to the window", `${rowWidth} !== ${paneWidth}`);
console.log(`pane ${paneWidth} cols, window ${String(await win.evaluate(rowWidth))} cols`);
await win.shot("65-desktop-agents-window");
await ui.evaluate(`window.spinnerDesktop.panes.dockBack("agents", ${JSON.stringify(session)})`);
for (let tries = 0; tries < 50; tries += 1) {
    if ((await targets()).every((t) => !t.url.includes("pane=agents"))) {
        break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
}
check((await targets()).every((t) => !t.url.includes("pane=agents")), "the window closed");
await ui.until("terminal still in the pane", `${rows}.includes("pasted-text")`);
check(true, "the pane's terminal is untouched by the window's close");
// The window's size was the pty's last resize; a focus of the main window sends its own.
await ui.evaluate(`window.dispatchEvent(new Event("focus")), true`);
await ui.until("pi back at the pane's width", `${rowWidth} === ${paneWidth}`);
check(true, "the pane's size reaches the pty again on focus");
// Ctrl-C: pi clears its editor (one press; a second on an empty editor would exit pi).
await ui.evaluate(`document.querySelector(".xterm-helper-textarea").focus(), true`);
await ui.key("c", "KeyC", 67, "\u0003", CTRL);
await ui.until("editor cleared by Ctrl-C", `!${rows}.includes("pasted-text")`);
check(true, "Ctrl-C reaches the pty (pi cleared its editor)");
console.log(`desktop terminal ok (${checks} checks)`);
ui.close();
win.close();
process.exit(0);
