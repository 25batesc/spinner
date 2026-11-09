// The agent tab for a `tty` agent: pi's own terminal UI, rendered with xterm.js over the pty
// socket from `tty-client.ts`. One Terminal per agent tab; it stays mounted while the tab is
// hidden so the scrollback survives a tab switch, and it fits the pane again whenever the pane
// changes size, on a tab switch back, and in a pop-out window (a fresh mount of this route).
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState, type DragEvent } from "react";

import "@xterm/xterm/css/xterm.css";

import { terminalTheme, THEME_EVENT } from "./theme.ts";
import {
    connectTty,
    droppedPathsText,
    ttyUrl,
    type TtyConnection,
    type TtyStatus,
} from "./tty-client.ts";

export interface AgentTerminalProps {
    /** The socket path, `tty_path(dir, name)`. */
    path: string;
    /** The daemon hosts the agent's process; without it there is no pty to attach to. */
    running: boolean;
    /** True while this tab is the one shown; a hidden terminal keeps its socket and buffer. */
    visible: boolean;
    /** Starts the agent again on its transcript; the status line offers it while not running. */
    onResume?: () => Promise<void>;
}

/** The font the app uses for code (see `.pr-line` in `styles.css`), at 13 px. */
const FONT_FAMILY = "ui-monospace, monospace";
const FONT_SIZE_PX = 13;
/** Lines xterm keeps above the screen; the daemon's own replay is 64 KiB, well below this. */
const SCROLLBACK_LINES = 5000;
/** A host smaller than this has no layout yet (a hidden or backgrounded page); no fit then. */
const HOST_MIN_PX = { width: 80, height: 40 };
/** A drag moves the divider many times a second; one resize frame per pause is enough. */
const FIT_DEBOUNCE_MS = 50;

/** The one-line status for the tab's header; null while the socket is open. */
export function statusLine(status: TtyStatus | null, running: boolean): string | null {
    if (!running) {
        return "not running: resume the agent to open its terminal";
    }
    if (status === null || status.state === "connecting") {
        return "connecting to the agent's terminal…";
    }
    if (status.state === "closed") {
        return `disconnected; retrying in ${Math.round(status.retry_ms / 1000)} s`;
    }
    if (status.state === "exited") {
        return `pi exited (code ${status.code === null ? "none" : status.code})`;
    }
    return null;
}

interface Opened {
    terminal: Terminal;
    fit: FitAddon;
    /** True once `open()` ran; it needs a host with a size, so a hidden tab waits. */
    shown: boolean;
}

function makeTerminal(): Opened {
    const terminal = new Terminal({
        fontFamily: FONT_FAMILY,
        fontSize: FONT_SIZE_PX,
        // The palette's terminal block, from the stylesheet's variables (`theme.ts`).
        theme: terminalTheme(),
        cursorBlink: true,
        scrollback: SCROLLBACK_LINES,
        macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon());
    // A Cmd (or Ctrl on other platforms) shortcut belongs to the app and the window, not to
    // pi: xterm leaves it alone and the browser or Electron handles it.
    terminal.attachCustomKeyEventHandler((event) => !event.metaKey);
    return { terminal, fit, shown: false };
}

/** Binary data from xterm is a string of byte values; the pty wants the bytes. */
function bytesOf(binary: string): Uint8Array {
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function AgentTerminal({ path, running, visible, onResume }: AgentTerminalProps) {
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const act = (action: (() => Promise<void>) | undefined) => () => {
        if (action === undefined) {
            return;
        }
        setBusy(true);
        setFailure(null);
        action().then(
            () => setBusy(false),
            (error: unknown) => {
                setBusy(false);
                setFailure(String(error));
            },
        );
    };
    const host = useRef<HTMLDivElement>(null);
    const opened = useRef<Opened | null>(null);
    const link = useRef<TtyConnection | null>(null);
    const [status, setStatus] = useState<TtyStatus | null>(null);

    // The terminal lives as long as the tab. Output written before `open()` waits in xterm's
    // buffer, so a hidden tab's terminal fills up in the background.
    useEffect(() => {
        const made = makeTerminal();
        made.terminal.onData((data) => link.current?.input(data));
        made.terminal.onBinary((data) => link.current?.input(bytesOf(data)));
        opened.current = made;
        // A theme change re-reads the variables; xterm repaints on a new theme object.
        const retheme = () => {
            made.terminal.options.theme = terminalTheme();
        };
        window.addEventListener(THEME_EVENT, retheme);
        return () => {
            window.removeEventListener(THEME_EVENT, retheme);
            made.terminal.dispose();
            opened.current = null;
        };
    }, []);

    // The socket follows the agent: a new base or a resumed agent attaches again.
    useEffect(() => {
        if (!running) {
            setStatus(null);
            return;
        }
        const connection = connectTty(ttyUrl(path, window.location), {
            onOutput: (bytes) => opened.current?.terminal.write(bytes),
            onStatus: setStatus,
        });
        link.current = connection;
        const current = opened.current;
        if (current !== null && current.shown) {
            connection.resize(current.terminal.cols, current.terminal.rows);
        }
        return () => {
            connection.close();
            link.current = null;
        };
    }, [path, running]);

    // Fit when the tab shows and whenever the host changes size (a pane drag, a collapse of
    // the previews, a window resize, the pop-out window). Each fit reports the size.
    useEffect(() => {
        const element = host.current;
        if (element === null || !visible) {
            return;
        }
        const fitNow = () => {
            const current = opened.current;
            const laidOut =
                element.clientWidth >= HOST_MIN_PX.width &&
                element.clientHeight >= HOST_MIN_PX.height;
            if (current === null || !laidOut) {
                return;
            }
            if (!current.shown) {
                current.terminal.open(element);
                current.shown = true;
                current.terminal.focus();
            }
            current.fit.fit();
            link.current?.resize(current.terminal.cols, current.terminal.rows);
        };
        // The observer fires once on `observe()`, after layout, so the first fit measures a
        // settled host; a fit right here would run before the fonts and the grid are ready.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const observer = new ResizeObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(fitNow, FIT_DEBOUNCE_MS);
        });
        observer.observe(element);
        // The pty takes the last size any client sent. When this window gets the focus back
        // (a pop-out window closed, or the operator returned), its size wins again.
        window.addEventListener("focus", fitNow);
        // A tab shown again takes the keyboard; the first show focuses after `open()`.
        if (opened.current?.shown === true) {
            opened.current.terminal.focus();
        }
        return () => {
            clearTimeout(timer);
            observer.disconnect();
            window.removeEventListener("focus", fitNow);
        };
    }, [visible]);

    // A file dropped on the terminal pastes its path, as iTerm does: pi reads an image path
    // in the prompt as an attachment. The page learns the path from the desktop bridge only.
    const [dropNote, setDropNote] = useState<string | null>(null);
    const onDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        const files = [...event.dataTransfer.files];
        if (files.length === 0) {
            return;
        }
        const pathOf = window.spinnerDesktop?.files?.pathOf;
        if (pathOf === undefined) {
            setDropNote("Dropping a file needs the desktop app; in a browser, paste its path.");
            return;
        }
        const paths = files.map((file) => pathOf(file)).filter((path) => path.length > 0);
        const terminal = opened.current?.terminal;
        if (paths.length === 0 || terminal === undefined) {
            return;
        }
        setDropNote(null);
        terminal.paste(droppedPathsText(paths));
        terminal.focus();
    };

    const line = statusLine(status, running);
    return (
        <div
            className="agent-terminal"
            hidden={!visible}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
        >
            {(line !== null || failure !== null) && (
                <p className="muted tty-status">
                    {line !== null && <span>{line} </span>}
                    {!running && onResume !== undefined && (
                        <button type="button" disabled={busy} onClick={act(onResume)}>
                            resume
                        </button>
                    )}
                    {failure !== null && <span className="error"> {failure}</span>}
                </p>
            )}
            {dropNote !== null && <p className="muted tty-status">{dropNote}</p>}
            <div className="terminal-host" ref={host} />
        </div>
    );
}
