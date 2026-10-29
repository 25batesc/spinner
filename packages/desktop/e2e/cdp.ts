// The DevTools-protocol page the e2e drivers share: a socket per target, `evaluate`, a poll
// with a timeout, a click by text, and a React-safe `fill`. Every window of the app and every
// preview view is its own target on the app's `--remote-debugging-port`.

export const CDP_PORT = process.env["E2E_CDP_PORT"] ?? "9345";
export const TIMEOUT_MS = 300_000;

export interface Target {
    id: string;
    url: string;
    webSocketDebuggerUrl: string;
}

export async function targets(): Promise<Target[]> {
    return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as Target[];
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const text = (selector: string) =>
    `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? "")`;

/** The first target whose URL starts with `prefix`, within `timeout_ms`. */
export async function target_with(prefix: string, timeout_ms = 30_000): Promise<Target> {
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline) {
        const found = (await targets()).find((t) => t.url.startsWith(prefix));
        if (found !== undefined) {
            return found;
        }
        await sleep(300);
    }
    throw new Error(`no CDP target for ${prefix}`);
}

export class Page {
    private next_id = 0;
    private readonly waiting = new Map<number, (value: Record<string, unknown>) => void>();

    private readonly socket: WebSocket;
    /** Runs before a timeout throws, for a failure screenshot. */
    private readonly on_timeout: () => void;

    private constructor(socket: WebSocket, on_timeout: () => void) {
        this.socket = socket;
        this.on_timeout = on_timeout;
    }

    static async open(target: Target, on_timeout: () => void = () => undefined): Promise<Page> {
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve) => socket.addEventListener("open", resolve));
        const page = new Page(socket, on_timeout);
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
        this.on_timeout();
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
