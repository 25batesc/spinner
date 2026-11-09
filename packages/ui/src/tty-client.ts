// The terminal's socket to one agent's pty: `GET /sessions/:dir/agents/:name/tty` upgraded to a
// WebSocket (Contracts, 16:20 engine). Binary frames carry the pty's bytes both ways, the
// scrollback first; the client's one text frame is a resize; the daemon's one text frame is
// `exit`, then close 1000. The socket reconnects with a back-off of 1, 2, 4 s up to 30 s and
// re-sends the last size once it is open again, so a daemon restart leaves the terminal
// usable without a reload. After `exit` it reconnects the same way: `resume` brings a new pty
// on the same route, and a 404 in between costs one failed attempt.
import {
    TTY_DIMENSION_MAX,
    type TtyClientMessage,
    type TtyServerMessage,
} from "@spinner/protocol";

export const TTY_RECONNECT_MS_MIN = 1000;
export const TTY_RECONNECT_MS_MAX = 30_000;

export type TtyStatus =
    | { state: "connecting" }
    | { state: "open" }
    | { state: "exited"; code: number | null }
    | { state: "closed"; retry_ms: number };

export interface TtyHandlers {
    /** Bytes from the pty, in order. */
    onOutput: (bytes: Uint8Array) => void;
    onStatus: (status: TtyStatus) => void;
}

export interface TtyConnection {
    /** Keystrokes for the pty. Dropped while the socket is not open; the status line says so. */
    input: (data: Uint8Array | string) => void;
    /** The terminal's size after a fit. Sent now when open, and again after every reconnect. */
    resize: (cols: number, rows: number) => void;
    close: () => void;
}

/** The socket URL for the path `tty_path(dir, name)` gives, on the page's origin. */
export function ttyUrl(path: string, location: { protocol: string; host: string }): string {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    return `${scheme}//${location.host}${path}`;
}

/** The one text frame a client sends, each side clamped to the daemon's bound. */
export function resizeFrame(cols: number, rows: number): string {
    const clamp = (n: number) => Math.min(TTY_DIMENSION_MAX, Math.max(1, Math.round(n)));
    const message: TtyClientMessage = { resize: { cols: clamp(cols), rows: clamp(rows) } };
    return JSON.stringify(message);
}

/** The `exit` frame's code, or undefined for any other text. */
export function exitCodeOf(text: string): number | null | undefined {
    try {
        const parsed = JSON.parse(text) as Partial<TtyServerMessage>;
        return parsed.exit === undefined ? undefined : parsed.exit.code;
    } catch {
        return undefined;
    }
}

/** The delay after a failed attempt: doubles from the minimum and stops at the maximum. */
export function nextReconnectDelay(delay_ms: number): number {
    return Math.min(delay_ms * 2, TTY_RECONNECT_MS_MAX);
}

const encoder = new TextEncoder();

export function connectTty(url: string, handlers: TtyHandlers): TtyConnection {
    let stopped = false;
    let delay_ms = TTY_RECONNECT_MS_MIN;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let size: { cols: number; rows: number } | null = null;
    /** The last frame this socket got; the same size again is not sent (pi would redraw). */
    let sent: string | null = null;
    /** Set by the daemon's `exit` frame; the close that follows keeps the exit status shown. */
    let exited: { code: number | null } | null = null;

    const isOpen = () => socket !== null && socket.readyState === WebSocket.OPEN;
    const sendSize = () => {
        if (size === null || !isOpen()) {
            return;
        }
        const frame = resizeFrame(size.cols, size.rows);
        if (frame !== sent) {
            socket?.send(frame);
            sent = frame;
        }
    };
    const open = () => {
        handlers.onStatus({ state: "connecting" });
        const next = new WebSocket(url);
        next.binaryType = "arraybuffer";
        socket = next;
        next.onopen = () => {
            delay_ms = TTY_RECONNECT_MS_MIN;
            sent = null;
            sendSize();
            handlers.onStatus({ state: "open" });
        };
        next.onmessage = (message: MessageEvent<unknown>) => {
            if (message.data instanceof ArrayBuffer) {
                handlers.onOutput(new Uint8Array(message.data));
                return;
            }
            const code = typeof message.data === "string" ? exitCodeOf(message.data) : undefined;
            if (code !== undefined) {
                exited = { code };
                handlers.onStatus({ state: "exited", code });
            }
        };
        next.onclose = () => {
            if (stopped) {
                return;
            }
            if (exited === null) {
                handlers.onStatus({ state: "closed", retry_ms: delay_ms });
            }
            exited = null;
            timer = setTimeout(open, delay_ms);
            delay_ms = nextReconnectDelay(delay_ms);
        };
    };
    open();

    return {
        input: (data) => {
            if (isOpen()) {
                socket?.send(typeof data === "string" ? encoder.encode(data) : data);
            }
        },
        resize: (cols, rows) => {
            size = { cols, rows };
            sendSize();
        },
        close: () => {
            stopped = true;
            clearTimeout(timer);
            socket?.close();
        },
    };
}

/**
 * The text a drop on the terminal pastes: each path with its spaces escaped and a space
 * after it, so the shell-style path pi expects stays one token
 * (`/a/My Shot.png` becomes `/a/My\ Shot.png `).
 */
export function droppedPathsText(paths: readonly string[]): string {
    return paths.map((path) => `${path.replace(/ /g, "\\ ")} `).join("");
}
