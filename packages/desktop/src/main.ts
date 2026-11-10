// The desktop app's main process. One `BrowserWindow` loads the web UI from the daemon; the
// previews are `WebContentsView`s the renderer places through the bridge (`preload.cts`,
// IPC in `ipc.ts`). The main process owns the view map (`previews.ts`), the daemon link
// (`daemon.ts`), the pane windows (`pane-windows.ts`), its own events socket (`events.ts`)
// and the tray (`tray.ts`). The renderer never touches an Electron API.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, Notification, shell } from "electron";
import {
    DAEMON_HOST,
    DAEMON_PORT,
    preview_key_session,
    type PaneEvent,
    type PaneName,
    type PoppedPane,
    type PreviewRect,
    type ZoomDirection,
} from "@spinner/protocol";
import { DaemonLink, probe_health, RECONNECT_POLL_MS } from "./daemon.js";
import {
    data_url,
    electron_preview_host,
    POPOUT_CASCADE_PX,
    POPOUT_MIN,
} from "./electron-previews.js";
import { watch_events } from "./events.js";
import { IPC } from "./ipc.js";
import { NotificationPoster } from "./notifications.js";
import { down_page, starting_page } from "./pages.js";
import { PaneWindows, type PaneWindowHost } from "./pane-windows.js";
import { PreviewRegistry, window_rect } from "./previews.js";
import { repo_root, run_start_command, start_command } from "./start-daemon.js";
import { create_tray, type TrayWindow } from "./tray.js";
import { window_geometry } from "./window-geometry.js";

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
let panes: PaneWindows | null = null;
let refresh_tray: () => void = () => undefined;
let stop_events: (() => void) | null = null;
let reconnect_timer: NodeJS.Timeout | null = null;
let quitting = false;

const web_preferences: Electron.WebPreferences = {
    preload: join(dist, "preload.cjs"),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    // The page places the preview views from `ResizeObserver` and animation frames.
    // Chromium stops both while the window is occluded (another window in front);
    // the views must still follow a resize then, so the page is never throttled.
    backgroundThrottling: false,
};

function create_window(): BrowserWindow {
    const created = new BrowserWindow({
        ...window_geometry(process.env["SPINNER_DESKTOP_WINDOW"]),
        title: "Spinner",
        show: false,
        webPreferences: web_preferences,
    });
    created.once("ready-to-show", () => created.show());
    // The window hides on close; the tray brings it back. Quit is explicit.
    created.on("close", (event) => {
        if (!quitting) {
            event.preventDefault();
            created.hide();
        }
    });
    // A reload or a new page drops the renderer that placed the preview views; without this
    // the old views stay painted at their last rectangles over the new page.
    created.webContents.on("did-start-navigation", (details) => {
        if (details.isMainFrame && !details.isSameDocument) {
            registry?.close_docked();
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

/**
 * A pane window: the UI's one-pane route, cascaded from the main window like a pop-out. A
 * previews pane window holds the session's preview views; `on_close` runs before the window
 * goes away so the registry can take them back.
 */
function electron_pane_host(
    main: BrowserWindow,
    on_close: (window: BrowserWindow) => void,
): PaneWindowHost {
    return {
        open(popped, url, on_closed) {
            const bounds = main.getBounds();
            const content = main.getContentBounds();
            // A previews window is a page to look at: a large rectangle, most of the main
            // window. The other panes are lists and chats: a third of its width, full height.
            const size = pane_window_size(popped.pane, content);
            const created = new BrowserWindow({
                ...size,
                x: bounds.x + POPOUT_CASCADE_PX,
                y: bounds.y + POPOUT_CASCADE_PX,
                title: `${popped.session} \u2014 ${popped.pane}`,
                webPreferences: web_preferences,
            });
            created.webContents.setWindowOpenHandler(({ url: opened }) => {
                void shell.openExternal(opened);
                return { action: "deny" };
            });
            // The page sets its own title; the window keeps the pane and session as its name.
            created.on("page-title-updated", (event) => event.preventDefault());
            created.on("close", () => on_close(created));
            created.on("closed", on_closed);
            void created.loadURL(url);
            return {
                focus: () => created.focus(),
                close: () => {
                    created.removeListener("closed", on_closed);
                    created.close();
                },
            };
        },
    };
}

/** The initial size of a pane window from the main window's content size. */
export function pane_window_size(
    pane: PaneName,
    content: { width: number; height: number },
): { width: number; height: number } {
    if (pane === "previews") {
        return {
            width: Math.max(POPOUT_MIN.width, Math.round(content.width * 0.8)),
            height: Math.max(POPOUT_MIN.height, Math.round(content.height * 0.8)),
        };
    }
    return {
        width: Math.max(POPOUT_MIN.width, Math.round(content.width / 3)),
        height: Math.max(POPOUT_MIN.height, content.height),
    };
}

function docked(popped: PoppedPane): void {
    const event: PaneEvent = { type: "docked", ...popped };
    const key = popped.key === undefined ? "" : ` ${popped.key}`;
    log(`docked ${popped.pane} ${popped.session}${key}`);
    send_to_renderer(IPC.panes_event, event);
    refresh_tray();
}

function preview_popped(key: string): PoppedPane {
    return { pane: "previews", session: preview_key_session(key), key };
}

function pop_out_preview(views: PreviewRegistry, key: string): void {
    const popped = views.pop_out(key, () => docked(preview_popped(key)));
    if (popped) {
        refresh_tray();
    } else {
        log(`popOut ${key}: no view yet, ignored`);
    }
}

function pop_out_pane(windows: PaneWindows, pane: PaneName, session: string): void {
    const popped = windows.pop_out(pane, session, () => docked({ pane, session }));
    if (popped) {
        refresh_tray();
    } else {
        log(`popOut ${pane} ${session}: not a pane page, ignored`);
    }
}

/** Every popped-out window, previews first, for `panes.list` and the tray. */
function popped_windows(): PoppedPane[] {
    const previews = registry?.popped_keys().map(preview_popped) ?? [];
    return [...previews, ...(panes?.list() ?? [])];
}

/** The tray's entries: a click brings the window forward; a repeated pop-out is a focus. */
function tray_windows(): TrayWindow[] {
    return popped_windows().map((popped) => ({
        label: popped.key === undefined ? `${popped.session} \u2014 ${popped.pane}` : popped.key,
        focus: () => {
            if (popped.key !== undefined && registry !== null) {
                pop_out_preview(registry, popped.key);
            } else if (panes !== null) {
                pop_out_pane(panes, popped.pane, popped.session);
            }
        },
    }));
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

/**
 * A click on a Spinner banner: the main window comes forward, and the page shows `session`
 * through the bridge (`sessions.subscribeFocus`). A window that is still loading gets the
 * session once the page has loaded, so the click is not lost on a first open.
 */
function focus_session(session: string | null): void {
    open_window();
    app.focus({ steal: true });
    const target = window;
    if (session === null || target === null) {
        return;
    }
    log(`notification click: focus ${session}`);
    if (target.webContents.isLoading()) {
        target.webContents.once("did-finish-load", () => {
            send_to_renderer(IPC.sessions_focus, session);
        });
    } else {
        send_to_renderer(IPC.sessions_focus, session);
    }
}

// The daemon's `notify` events, posted as the app's own banners. Electron's `Notification`
// needs the app ready; the events socket opens only after `whenReady`, so every post is.
const notifications = new NotificationPoster(
    (options) => new Notification({ ...options, silent: false }),
    focus_session,
);

/** The events socket is open while connected; its loss moves the link to `down` and polls. */
function follow_daemon(): void {
    if (stop_events !== null || link.status().state !== "connected") {
        return;
    }
    stop_events = watch_events(
        daemon_url,
        {
            on_session_closed: (session_dir) => {
                // A popped-out window of the session goes with it; the page learns it docked.
                const popped = popped_windows().filter((p) => p.session === session_dir);
                const closed = registry?.close_session(session_dir) ?? 0;
                panes?.close_session(session_dir);
                log(`session ${session_dir} closed: ${closed} preview view(s) destroyed`);
                for (const entry of popped) {
                    docked(entry);
                }
            },
            on_notify: (event) => {
                if (Notification.isSupported()) {
                    notifications.post(event);
                } else {
                    log(`notify (no notification support): ${event.message}`);
                }
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

function register_ipc(views: PreviewRegistry, windows: PaneWindows): void {
    ipcMain.handle(IPC.previews_set, (event, key: unknown, url: unknown, rect: unknown) => {
        assert.equal(typeof key, "string");
        assert.equal(typeof url, "string");
        assert.equal(typeof rect, "object");
        debug(`set ${String(key)} ${String(url)} ${JSON.stringify(rect)}`);
        // The view goes in the window that asked: the main window, or a popped-out previews
        // pane, so every tab of the session follows that window.
        const sender = BrowserWindow.fromWebContents(event.sender);
        const pane_window = sender !== null && sender !== window ? sender : null;
        // The page measured CSS pixels; the view is placed in window pixels.
        const placed = window_rect(rect as PreviewRect, event.sender.getZoomFactor());
        views.set(key as string, url as string, placed, pane_window);
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
    ipcMain.handle(IPC.previews_back, with_key("back", (key) => views.back(key)));
    ipcMain.handle(IPC.previews_forward, with_key("forward", (key) => views.forward(key)));
    ipcMain.handle(IPC.previews_navigate, (_event, key: unknown, url: unknown) => {
        assert.equal(typeof key, "string");
        assert.equal(typeof url, "string");
        debug(`navigate ${String(key)} ${String(url)}`);
        views.navigate(key as string, url as string);
    });
    ipcMain.handle(IPC.previews_zoom, (_event, key: unknown, direction: unknown) => {
        assert.equal(typeof key, "string");
        assert.ok(direction === "in" || direction === "out" || direction === "reset");
        debug(`zoom ${String(key)} ${String(direction)}`);
        views.zoom(key as string, direction as ZoomDirection);
    });
    ipcMain.handle(IPC.previews_find, (_event, key: unknown, text: unknown) => {
        assert.equal(typeof key, "string");
        assert.ok(text === null || typeof text === "string");
        debug(`find ${String(key)} ${JSON.stringify(text)}`);
        return views.find(key as string, text as string | null);
    });
    ipcMain.handle(IPC.previews_clear_storage, (_event, key: unknown) => {
        assert.equal(typeof key, "string");
        log(`clearStorage ${String(key)}`);
        return views.clear_storage(key as string);
    });
    ipcMain.handle(IPC.previews_capture, (_event, key: unknown) => {
        assert.equal(typeof key, "string");
        debug(`capture ${String(key)}`);
        return views.capture(key as string);
    });
    ipcMain.handle(IPC.previews_inspect, (_event, key: unknown, point: unknown) => {
        assert.equal(typeof key, "string");
        assert.ok(typeof point === "object" && point !== null, "inspect takes a point");
        const { x, y } = point as { x: unknown; y: unknown };
        assert.ok(typeof x === "number" && typeof y === "number", "a point is two numbers");
        return views.inspect(key as string, { x, y });
    });
    ipcMain.handle(IPC.previews_pop_out, with_key("popOut", (key) => pop_out_preview(views, key)));
    ipcMain.handle(
        IPC.previews_dock_back,
        with_key("dockBack", (key) => {
            if (views.dock_back(key)) {
                docked(preview_popped(key));
            }
        }),
    );
    const with_pane =
        (name: string, handler: (pane: PaneName, session: string) => void) =>
        (_event: unknown, pane: unknown, session: unknown) => {
            assert.equal(typeof pane, "string");
            assert.equal(typeof session, "string");
            debug(`${name} ${String(pane)} ${String(session)}`);
            handler(pane as PaneName, session as string);
        };
    ipcMain.handle(
        IPC.panes_pop_out,
        with_pane("panes.popOut", (pane, session) => pop_out_pane(windows, pane, session)),
    );
    ipcMain.handle(
        IPC.panes_dock_back,
        with_pane("panes.dockBack", (pane, session) => {
            if (windows.dock_back(pane, session)) {
                docked({ pane, session });
            }
        }),
    );
    ipcMain.handle(IPC.panes_list, () => popped_windows());
    ipcMain.handle(IPC.daemon_status, () => link.status());
}

function open_window(): void {
    if (window === null) {
        window = create_window();
        registry = new PreviewRegistry(
            electron_preview_host(
                window,
                (event) => {
                    // The five `navigated` triggers would flood the log; the load states stay.
                    const line = `preview ${event.key} ${event.type} ${event.url}`;
                    if (event.type === "navigated") {
                        debug(line);
                    } else {
                        log(line);
                    }
                    send_to_renderer(IPC.previews_event, event);
                },
                debug,
            ),
        );
        panes = new PaneWindows(
            electron_pane_host(window, (closing) => {
                const moved = registry?.rehome(closing) ?? 0;
                if (moved > 0) {
                    log(`pane window closing: ${moved} preview view(s) back in the main window`);
                }
            }),
            daemon_url,
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

// In a dev run the binary is Electron's, and the app menu would take that name.
app.setName("Spinner");

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
    refresh_tray = () => {
        const windows = tray_windows();
        debug(`tray windows: ${windows.map((w) => w.label).join(", ") || "(none)"}`);
        render_tray(link.status(), windows);
    };
    refresh_tray();
    link.subscribe((status) => {
        log(`daemon ${status.state}`);
        refresh_tray();
        send_to_renderer(IPC.daemon_event, status);
        render_window();
        follow_daemon();
    });
    open_window();
    assert.ok(window !== null);
    assert.ok(registry !== null);
    assert.ok(panes !== null);
    register_ipc(registry, panes);
    await ensure_daemon();
});
