// A fake pty behind `GET /sessions/:dir/agents/:name/tty` in the fixture: it prints a banner on
// the first attach, echoes keystrokes, answers a resize frame with a visible line, and replays
// its scrollback to every later attachment, as the daemon does. The driver types and asserts
// against it without pi.
import type { TtyServerMessage } from "@spinner/protocol";
import type { WebSocket } from "ws";

/** The daemon keeps this much per agent; the fixture keeps the same so a replay looks alike. */
export const SCROLLBACK_BYTES = 64 * 1024;
export const PROMPT = "$ ";

const CR = 0x0d;
const LF = 0x0a;
const DEL = 0x7f;
const ESC = 0x1b;

/**
 * What the pty writes back for the bytes typed: Enter starts a new prompt line, Delete rubs out
 * one cell, a control byte shows in caret notation (so an arrow key shows as `^[[A`), and every
 * other byte echoes as is.
 */
export function echoOf(input: Buffer): Buffer {
    const parts: Buffer[] = [];
    for (const byte of input) {
        if (byte === CR || byte === LF) {
            parts.push(Buffer.from(`\r\n${PROMPT}`));
        } else if (byte === DEL) {
            parts.push(Buffer.from("\b \b"));
        } else if (byte === ESC) {
            parts.push(Buffer.from("^["));
        } else if (byte < 0x20) {
            parts.push(Buffer.from(`^${String.fromCharCode(byte + 0x40)}`));
        } else {
            parts.push(Buffer.from([byte]));
        }
    }
    return Buffer.concat(parts);
}

export class EchoPty {
    scrollback: Buffer = Buffer.alloc(0);
    clients = new Set<WebSocket>();
    cols = 80;
    rows = 24;
    readonly name: string;

    constructor(name: string) {
        this.name = name;
    }

    /** The new client gets the scrollback first, so it sees what the others already saw. */
    attach(socket: WebSocket): void {
        if (this.scrollback.length === 0) {
            this.output(Buffer.from(`Spinner fixture pty for ${this.name}\r\n${PROMPT}`));
        }
        socket.send(this.scrollback);
        this.clients.add(socket);
        socket.on("message", (data, isBinary) => {
            if (isBinary) {
                this.input(Buffer.from(data as Buffer));
            } else {
                this.frame(String(data));
            }
        });
        socket.on("close", () => this.clients.delete(socket));
    }

    input(bytes: Buffer): void {
        this.output(echoOf(bytes));
    }

    /** The one text frame: `{"resize":{"cols":n,"rows":n}}`. Anything else is ignored. */
    frame(text: string): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            return;
        }
        const resize = (parsed as { resize?: { cols?: unknown; rows?: unknown } }).resize;
        if (typeof resize?.cols !== "number" || typeof resize.rows !== "number") {
            return;
        }
        this.cols = resize.cols;
        this.rows = resize.rows;
        this.output(Buffer.from(`\r\n[resize ${this.cols}x${this.rows}]\r\n${PROMPT}`));
    }

    /** The daemon's one text frame, then close 1000 on every attachment. */
    exit(code: number | null): void {
        const message: TtyServerMessage = { exit: { code } };
        for (const client of this.clients) {
            client.send(JSON.stringify(message));
            client.close(1000);
        }
        this.clients.clear();
    }

    output(bytes: Buffer): void {
        const joined = Buffer.concat([this.scrollback, bytes]);
        this.scrollback = joined.subarray(Math.max(0, joined.length - SCROLLBACK_BYTES));
        for (const client of this.clients) {
            client.send(bytes);
        }
    }
}
