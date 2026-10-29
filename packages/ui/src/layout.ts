// Pane geometry for the workbench: activity bar | left panel | agents | previews. This is view
// state the daemon never sees, so it is remembered per browser profile in `localStorage`. The
// module is pure (no React, no DOM) so the rules are unit-tested in node; `useResizable.ts`
// binds it.
//
// The left panel (its view today: sessions) is shown or hidden: the activity bar toggles it,
// and a drag of its divider past the threshold hides it; no strip stays. The agents pane is the
// work area: never hidden, never a strip; its minimum stops a drag. The previews pane collapses
// to a 24 px strip at the right edge, by a drag past its threshold or by its toggle icon; a
// click on the strip restores it. A popped-out pane (the desktop's tray can still open one) is
// a strip too, so one click docks it back.
// `expanded` gives the previews the whole window; the panes keep their state for the return.

export type PaneName = "sessions" | "agents" | "previews";

export const PANES: readonly PaneName[] = ["sessions", "agents", "previews"];

/** Width of a collapsed or popped-out pane: a strip with the name turned sideways. */
export const STRIP_PX = 24;
export const HANDLE_PX = 6;

export interface PaneState {
    /** The last open width in CSS pixels. Unused while the pane is the free (`1fr`) column. */
    width: number;
    /** A strip in place of the pane (previews only). */
    collapsed: boolean;
    /** No column at all (the left panel only). */
    hidden: boolean;
    /** The pane lives in its own window. Runtime only: not remembered across loads. */
    popped: boolean;
}

export interface Layout {
    panes: Record<PaneName, PaneState>;
    /** The previews pane fills the window; the other panes keep their state underneath. */
    expanded: boolean;
}

/** Below `min` a drag folds the pane; above it the width is clamped to `max`. */
export interface PaneLimits {
    min: number;
    max: number;
}

export const LIMITS: Record<PaneName, PaneLimits> = {
    sessions: { min: 180, max: 480 },
    agents: { min: 280, max: Infinity },
    // No cap of its own: the previews grow until the agents pane is at its minimum.
    previews: { min: 240, max: Infinity },
};

/** What a drag past the threshold, or the header's toggle, does to each pane. */
const FOLD: Record<PaneName, "hidden" | "strip" | "never"> = {
    sessions: "hidden",
    agents: "never",
    previews: "strip",
};

export const DEFAULT_LAYOUT: Layout = {
    panes: {
        sessions: { width: 260, collapsed: false, hidden: false, popped: false },
        agents: { width: 640, collapsed: false, hidden: false, popped: false },
        previews: { width: 520, collapsed: false, hidden: false, popped: false },
    },
    expanded: false,
};

export type LayoutAction =
    /** A width from a drag: below the threshold folds, above it clamps to `max`. */
    | { kind: "drag"; pane: PaneName; width: number }
    /**
     * Below the threshold, or the header's toggle: the pane folds as `FOLD` says. `remember`
     * is the width when the drag began, for the restore.
     */
    | { kind: "collapse"; pane: PaneName; remember: number | undefined }
    /** Back to shown, from any state; `width` when the restoring drag sets one. */
    | { kind: "restore"; pane: PaneName; width?: number | undefined }
    | { kind: "popped"; pane: PaneName; popped: boolean }
    | { kind: "expand"; expanded: boolean };

/** True when the pane shows as a strip in the main window: collapsed or popped out. */
export function isStrip(pane: PaneState): boolean {
    return !pane.hidden && (pane.collapsed || pane.popped);
}

/** True when the pane is open: neither hidden nor a strip. */
export function isOpen(pane: PaneState): boolean {
    return !pane.hidden && !pane.collapsed && !pane.popped;
}

function clampWidth(pane: PaneName, width: number): number {
    const { min, max } = LIMITS[pane];
    return Math.min(max, Math.max(min, Math.round(width)));
}

function withPane(layout: Layout, pane: PaneName, state: PaneState): Layout {
    return { ...layout, panes: { ...layout.panes, [pane]: state } };
}

export function reduceLayout(layout: Layout, action: LayoutAction): Layout {
    if (action.kind === "expand") {
        return { ...layout, expanded: action.expanded };
    }
    const pane = layout.panes[action.pane];
    switch (action.kind) {
        case "drag": {
            if (action.width < LIMITS[action.pane].min) {
                const collapse = { kind: "collapse", pane: action.pane, remember: undefined };
                return reduceLayout(layout, collapse as LayoutAction);
            }
            const width = clampWidth(action.pane, action.width);
            return withPane(layout, action.pane, { ...pane, width, collapsed: false });
        }
        case "collapse": {
            const width = action.remember ?? pane.width;
            if (FOLD[action.pane] === "hidden") {
                return withPane(layout, action.pane, { ...pane, width, hidden: true });
            }
            if (FOLD[action.pane] === "strip") {
                return withPane(layout, action.pane, { ...pane, width, collapsed: true });
            }
            return layout;
        }
        case "restore": {
            const width =
                action.width === undefined ? pane.width : clampWidth(action.pane, action.width);
            const open = { width, collapsed: false, hidden: false, popped: false };
            return withPane(layout, action.pane, open);
        }
        case "popped":
            return withPane(layout, action.pane, { ...pane, popped: action.popped });
    }
}

/** The panes with a column, left to right. Expanded: the previews alone. */
export function visiblePanes(layout: Layout): PaneName[] {
    if (layout.expanded) {
        return ["previews"];
    }
    return PANES.filter((pane) => !layout.panes[pane].hidden);
}

/**
 * The pane that takes the free space (`1fr`): agents, else previews, else sessions, so no
 * column is empty. Only an open pane can; when none is open the first strip takes it.
 */
export function freePane(layout: Layout): PaneName | undefined {
    const visible = visiblePanes(layout);
    const order: PaneName[] = ["agents", "previews", "sessions"];
    const open = order.find((pane) => visible.includes(pane) && isOpen(layout.panes[pane]));
    return open ?? order.find((pane) => visible.includes(pane));
}

/** The `grid-template-columns` value: one track per visible pane, a handle between two. */
export function columns(layout: Layout): string {
    const free = freePane(layout);
    const tracks = visiblePanes(layout).map((pane) => {
        if (pane === free) {
            return "1fr";
        }
        const state = layout.panes[pane];
        return isStrip(state) ? `${STRIP_PX}px` : `${state.width}px`;
    });
    return tracks.join(` ${HANDLE_PX}px `);
}

export const STORAGE_KEY = "spinner.layout.v2";

/** The subset of `Storage` the layout needs, so tests pass a plain object. */
export interface LayoutStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/**
 * Reads the remembered layout; a missing, unreadable or partial record falls back to the
 * defaults field by field. `popped` is never read back: no window survives a reload.
 */
export function loadLayout(storage: LayoutStorage | undefined): Layout {
    let parsed: unknown;
    try {
        const raw = storage?.getItem(STORAGE_KEY);
        parsed = raw === null || raw === undefined ? undefined : JSON.parse(raw);
    } catch {
        parsed = undefined;
    }
    const layout: Layout = { panes: { ...DEFAULT_LAYOUT.panes }, expanded: false };
    if (!isRecord(parsed)) {
        return layout;
    }
    layout.expanded = parsed["expanded"] === true;
    const panes = parsed["panes"];
    if (!isRecord(panes)) {
        return layout;
    }
    for (const pane of PANES) {
        const saved = panes[pane];
        if (!isRecord(saved)) {
            continue;
        }
        const width =
            typeof saved["width"] === "number" && Number.isFinite(saved["width"])
                ? clampWidth(pane, saved["width"])
                : DEFAULT_LAYOUT.panes[pane].width;
        const collapsed = FOLD[pane] === "strip" && saved["collapsed"] === true;
        const hidden = FOLD[pane] === "hidden" && saved["hidden"] === true;
        layout.panes[pane] = { width, collapsed, hidden, popped: false };
    }
    return layout;
}

/** Writes widths, folds and the expand flag. A full or disabled storage is not an error. */
export function saveLayout(storage: LayoutStorage | undefined, layout: Layout): void {
    const panes: Record<string, { width: number; collapsed: boolean; hidden: boolean }> = {};
    for (const pane of PANES) {
        const { width, collapsed, hidden } = layout.panes[pane];
        panes[pane] = { width, collapsed, hidden };
    }
    try {
        storage?.setItem(STORAGE_KEY, JSON.stringify({ panes, expanded: layout.expanded }));
    } catch {
        // Private mode or a full quota: the layout lasts for this page only.
    }
}
