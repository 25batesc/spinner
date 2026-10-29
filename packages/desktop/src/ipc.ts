// IPC channel names shared by the main process and the preload. The preload is compiled to
// CommonJS and cannot import this ESM file at runtime, so it repeats the values; the test in
// `ipc.test.ts` keeps the two copies equal.

export const IPC = {
    previews_set: "previews:set",
    previews_show: "previews:show",
    previews_hide: "previews:hide",
    previews_reload: "previews:reload",
    previews_open_external: "previews:openExternal",
    previews_devtools: "previews:devtools",
    previews_pop_out: "previews:popOut",
    previews_dock_back: "previews:dockBack",
    previews_navigate: "previews:navigate",
    previews_back: "previews:back",
    previews_forward: "previews:forward",
    previews_zoom: "previews:zoom",
    previews_find: "previews:find",
    previews_clear_storage: "previews:clearStorage",
    /** Main to renderer: one `PreviewEvent` per message. */
    previews_event: "previews:event",
    panes_pop_out: "panes:popOut",
    panes_dock_back: "panes:dockBack",
    panes_list: "panes:list",
    /** Main to renderer: one `PaneEvent` per message. */
    panes_event: "panes:event",
    daemon_status: "daemon:status",
    /** Main to renderer: one `DaemonStatus` per message. */
    daemon_event: "daemon:event",
} as const;
