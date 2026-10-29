// The tray item: a template icon with the daemon state as text beside it, and a menu that
// opens the window, lists the popped-out windows to focus one, reconnects, starts a daemon,
// or quits.
import { Menu, nativeImage, Tray } from "electron";
import type { DaemonStatus } from "@spinner/protocol";
import { tray_icon_png } from "./tray-icon.js";

export interface TrayActions {
    open_window: () => void;
    reconnect: () => void;
    start_daemon: () => void;
    quit: () => void;
}

const STATE_GLYPH: Record<DaemonStatus["state"], string> = {
    connected: "●",
    starting: "◐",
    down: "○",
};

/** One popped-out window in the menu: a label and the click that focuses it. */
export interface TrayWindow {
    label: string;
    focus: () => void;
}

export function create_tray(
    actions: TrayActions,
): (status: DaemonStatus, windows: TrayWindow[]) => void {
    const icon = nativeImage.createFromBuffer(tray_icon_png(16), { scaleFactor: 1 });
    icon.addRepresentation({ scaleFactor: 2, buffer: tray_icon_png(32) });
    icon.setTemplateImage(true);
    const tray = new Tray(icon);
    tray.on("click", actions.open_window);
    const render = (status: DaemonStatus, windows: TrayWindow[]) => {
        const label = describe(status);
        tray.setToolTip(`Spinner: ${label}`);
        tray.setTitle(STATE_GLYPH[status.state]);
        tray.setContextMenu(
            Menu.buildFromTemplate([
                { label: `Daemon: ${label}`, enabled: false },
                { label: status.url, enabled: false },
                { type: "separator" },
                { label: "Open Spinner", click: actions.open_window },
                ...windows.map((popped) => ({ label: popped.label, click: popped.focus })),
                { label: "Reconnect", click: actions.reconnect },
                {
                    label: "Start daemon",
                    enabled: status.state === "down",
                    click: actions.start_daemon,
                },
                { type: "separator" },
                { label: "Quit Spinner", click: actions.quit },
            ]),
        );
    };
    return render;
}

export function describe(status: DaemonStatus): string {
    switch (status.state) {
        case "connected":
            return `connected (build ${status.build?.commit ?? "unknown"})`;
        case "starting":
            return "starting";
        case "down":
            return "down";
    }
}
