// The preload: puts `window.spinnerDesktop` on the page through `contextBridge` and nothing
// else. The page never sees an Electron API; every call is an IPC invoke the main process
// validates. The file is CommonJS because a sandboxed preload cannot load ESM; the channel
// names repeat `ipc.ts` and `ipc.test.ts` keeps them equal.
// A sandboxed preload is CommonJS; `verbatimModuleSyntax` allows only this import form here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import electron = require("electron");
import type {
    DaemonStatus,
    PreviewEvent,
    PreviewKey,
    PreviewRect,
    SpinnerDesktop,
} from "@spinner/protocol";

const { contextBridge, ipcRenderer } = electron;

const IPC = {
    previews_set: "previews:set",
    previews_show: "previews:show",
    previews_hide: "previews:hide",
    previews_reload: "previews:reload",
    previews_open_external: "previews:openExternal",
    previews_devtools: "previews:devtools",
    previews_event: "previews:event",
    daemon_status: "daemon:status",
    daemon_event: "daemon:event",
} as const;

/** `ipcRenderer.on` listeners get the event first; the page's listener wants the payload only. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
        ipcRenderer.removeListener(channel, wrapped);
    };
}

const bridge: SpinnerDesktop = {
    previews: {
        set: (key: PreviewKey, url: string, rect: PreviewRect) =>
            ipcRenderer.invoke(IPC.previews_set, key, url, rect),
        show: (key: PreviewKey) => ipcRenderer.invoke(IPC.previews_show, key),
        hide: (key: PreviewKey) => ipcRenderer.invoke(IPC.previews_hide, key),
        reload: (key: PreviewKey) => ipcRenderer.invoke(IPC.previews_reload, key),
        openExternal: (key: PreviewKey) => ipcRenderer.invoke(IPC.previews_open_external, key),
        devtools: (key: PreviewKey) => ipcRenderer.invoke(IPC.previews_devtools, key),
        subscribe: (listener: (event: PreviewEvent) => void) =>
            subscribe(IPC.previews_event, listener),
    },
    daemon: {
        status: () => ipcRenderer.invoke(IPC.daemon_status),
        subscribe: (listener: (status: DaemonStatus) => void) =>
            subscribe(IPC.daemon_event, listener),
    },
};

contextBridge.exposeInMainWorld("spinnerDesktop", bridge);
