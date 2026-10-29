// The desktop app's main process. One `BrowserWindow` loads the web UI from the daemon; the
// previews are `WebContentsView`s the renderer places through the bridge (`preload.cts`,
// IPC in `ipc.ts`). The main process owns the view map (`previews.ts`), the daemon link
// (`daemon.ts`), its own events socket (`events.ts`) and the tray (`tray.ts`). The renderer
// never touches an Electron API.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import { DAEMON_HOST, DAEMON_PORT, type PreviewRect } from "@spinner/protocol";
import { DaemonLink, probe_health, RECONNECT_POLL_MS } from "./daemon.js";
import { data_url, electron_preview_host } from "./electron-previews.js";
import { watch_events } from "./events.js";
import { IPC } from "./ipc.js";
import { down_page, starting_page } from "./pages.js";
import { PreviewRegistry } from "./previews.js";
import { repo_root, run_start_command, start_command } from "./start-daemon.js";
import { create_tray } from "./tray.js";

const dist = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env["SPINNER_PORT"] ?? DAEMON_PORT);
assert.ok(Number.isInteger(port) && port > 0 && port < 65536, "SPINNER_PORT must be a port");
const daemon_url = `http://${DAEMON_HOST}:${port}`;

const log = (line: string) => console.log(`[desktop] ${line}`);
/** `SPINNER_DESKTOP_DEBUG=1` logs every bridge call with its arguments. */
const debug = (line: string): void => {
    if (process.env["SPINNER_DESKTOP_DEBUG"] === "1") {
        log(line);
    }
};

const link = new DaemonLink({
    url: daemon_url,
    probe: () => probe_health(daemon_url),
    start: () => run_start_command(start_command(repo_root(), process.env, process.execPath), log),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

let window: BrowserWindow | null = null;
let registry: PreviewRegistry | null = null;
let stop_events: (() => void) | null = null;
let reconnect_timer: NodeJS.Timeout | null = null;
let quitting = false;

function create_window(): BrowserWindow {
    const created = new BrowserWindow({
        width: 1440,
        height: 900,
        title: "Spinner",
        show: false,
        webPreferences: {
            preload: join(dist, "preload.cjs"),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            // The page places the preview views from `ResizeObserver` and animation frames.
            // Chromium stops both while the window is occluded (another window in front);
            // the views must still follow a resize then, so the page is never throttled.
            backgroundThrottling: false,
        },
    });
    created.once("ready-to-show", () => created.show());
    // The window hides on close; the tray brings it back. Quit is explicit.
    created.on("close", (event) => {
        if (!quitting) {
            event.preventDefault();
            created.hide();
        }
    });
    created.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url);
        return { action: "deny" };
    });
    return created;
}

function send_to_renderer(channel: string, payload: unknown): void {
    if (window !== null && !window.isDestroyed()) {
        window.webContents.send(channel, payload);
    }
}

/** Loads the UI once the daemon answers; otherwise the inline page for the state. */
function render_window(): void {
    if (window === null) {
        return;
    }
    const status = link.status();
    if (status.state === "connected") {
        const current = window.webContents.getURL();
        if (!current.startsWith(daemon_url)) {
            void window.loadURL(daemon_url);
        }
    } else if (status.state === "starting") {
        void window.loadURL(data_url(starting_page(daemon_url)));
    }
}

function show_down(detail: string): void {
    if (window !== null) {
        void window.loadURL(data_url(down_page(daemon_url, detail)));
    }
}

/** The events socket is open while connected; its loss moves the link to `down` and polls. */
function follow_daemon(): void {
    if (stop_events !== null || link.status().state !== "connected") {
        return;
    }
    stop_events = watch_events(
        daemon_url,
        {
            on_session_closed: (session_dir) => {
                const closed = registry?.close_session(session_dir) ?? 0;
                log(`session ${session_dir} closed: ${closed} preview view(s) destroyed`);
            },
            on_lost: () => {
                stop_events = null;
                link.lost();
                schedule_reconnect();
            },
        },
        (url) => new WebSocket(url),
    );
}

function schedule_reconnect(): void {
    if (reconnect_timer !== null) {
        return;
    }
    reconnect_timer = setTimeout(() => {
        reconnect_timer = null;
        void link.check().then((status) => {
            if (status.state !== "connected") {
                schedule_reconnect();
            }
        });
    }, RECONNECT_POLL_MS);
}

async function ensure_daemon(): Promise<void> {
    try {
        const status = await link.ensure();
        if (status.state === "down") {
            show_down(`The daemon did not answer /health within the wait.`);
        }
    } catch (error) {
        show_down(error instanceof Error ? error.message : String(error));
    }
}

function register_ipc(views: PreviewRegistry): void {
    ipcMain.handle(IPC.previews_set, (_event, key: unknown, url: unknown, rect: unknown) => {
        assert.equal(typeof key, "string");
        assert.equal(typeof url, "string");
        assert.equal(typeof rect, "object");
        debug(`set ${String(key)} ${String(url)} ${JSON.stringify(rect)}`);
        views.set(key as string, url as string, rect as PreviewRect);
    });
    const with_key =
        (name: string, handler: (key: string) => void) => (_event: unknown, key: unknown) => {
            assert.equal(typeof key, "string");
            debug(`${name} ${String(key)}`);
            handler(key as string);
        };
    ipcMain.handle(IPC.previews_show, with_key("show", (key) => views.show(key)));
    ipcMain.handle(IPC.previews_hide, with_key("hide", (key) => views.hide(key)));
    ipcMain.handle(IPC.previews_reload, with_key("reload", (key) => views.reload(key)));
    ipcMain.handle(IPC.previews_devtools, with_key("devtools", (key) => views.devtools(key)));
    ipcMain.handle(
        IPC.previews_open_external,
        with_key("openExternal", (key) => {
            const url = views.url(key);
            if (url !== undefined) {
                void shell.openExternal(url);
            }
        }),
    );
    ipcMain.handle(IPC.daemon_status, () => link.status());
}

function open_window(): void {
    if (window === null) {
        window = create_window();
        registry = new PreviewRegistry(
            electron_preview_host(
                window,
                (event) => {
                    log(`preview ${event.key} ${event.type} ${event.url}`);
                    send_to_renderer(IPC.previews_event, event);
                },
                debug,
            ),
        );
        render_window();
    } else {
        window.show();
        window.focus();
    }
}

app.on("window-all-closed", () => {
    // The tray keeps the app alive on macOS; elsewhere closing the window quits.
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("activate", open_window);

app.on("before-quit", () => {
    quitting = true;
    stop_events?.();
    registry?.close_all();
});

void app.whenReady().then(async () => {
    Menu.setApplicationMenu(
        Menu.buildFromTemplate([
            { role: "appMenu" },
            { role: "editMenu" },
            { role: "viewMenu" },
            { role: "windowMenu" },
        ]),
    );
    const render_tray = create_tray({
        open_window,
        reconnect: () => void link.check(),
        start_daemon: () => void ensure_daemon(),
        quit: () => app.quit(),
    });
    render_tray(link.status());
    link.subscribe((status) => {
        log(`daemon ${status.state}`);
        render_tray(status);
        send_to_renderer(IPC.daemon_event, status);
        render_window();
        follow_daemon();
    });
    open_window();
    assert.ok(window !== null);
    assert.ok(registry !== null);
    register_ipc(registry);
    await ensure_daemon();
});
