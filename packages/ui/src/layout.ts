// Pane geometry for the three-column layout: sessions | agents | previews. This is view state
// the daemon never sees, so it is remembered per browser profile in `localStorage`. The module
// is pure (no React, no DOM) so the rules are unit-tested in node; `useResizable.ts` binds it.

export type PaneName = "sessions" | "agents" | "previews";

export const PANES: readonly PaneName[] = ["sessions", "agents", "previews"];

/** Width of a collapsed, hidden or popped-out pane: a strip with the name turned sideways. */
export const STRIP_PX = 24;
const HANDLE_PX = 6;

export interface PaneState {
    /** The last open width in CSS pixels. The agents pane is `1fr`, so its width is unused. */
    width: number;
    /** A strip in place of the pane: dragged past the threshold or hidden from the header. */
    collapsed: boolean;
    /** The pane lives in its own window. Runtime only: not remembered across loads. */
    popped: boolean;
}

export type Layout = Record<PaneName, PaneState>;

/** Below `min` a drag collapses the pane; above it the width is clamped to `max`. */
export interface PaneLimits {
    min: number;
    max: number;
}

export const LIMITS: Record<PaneName, PaneLimits> = {
    sessions: { min: 180, max: 480 },
    agents: { min: 0, max: Infinity },
    previews: { min: 240, max: 900 },
};

export const DEFAULT_LAYOUT: Layout = {
    sessions: { width: 260, collapsed: false, popped: false },
    agents: { width: 0, collapsed: false, popped: false },
    previews: { width: 520, collapsed: false, popped: false },
};

export type LayoutAction =
    | { kind: "drag"; pane: PaneName; width: number }
    /** Below the threshold. `remember` is the width when the drag began, for the restore. */
    | { kind: "collapse"; pane: PaneName; remember: number | undefined }
    | { kind: "hide"; pane: PaneName }
    | { kind: "restore"; pane: PaneName }
    | { kind: "popped"; pane: PaneName; popped: boolean };

/** True when the pane shows as a strip in the main window, for any of the three reasons. */
export function isStrip(pane: PaneState): boolean {
    return pane.collapsed || pane.popped;
}

export function reduceLayout(layout: Layout, action: LayoutAction): Layout {
    const pane = layout[action.pane];
    switch (action.kind) {
        case "drag": {
            const { min, max } = LIMITS[action.pane];
            if (action.width < min) {
                const collapse = { kind: "collapse", pane: action.pane, remember: undefined };
                return reduceLayout(layout, collapse as LayoutAction);
            }
            const width = Math.min(max, Math.max(min, Math.round(action.width)));
            return { ...layout, [action.pane]: { ...pane, width, collapsed: false } };
        }
        case "collapse": {
            const width = action.remember ?? pane.width;
            return { ...layout, [action.pane]: { ...pane, width, collapsed: true } };
        }
        case "hide":
            return { ...layout, [action.pane]: { ...pane, collapsed: true } };
        case "restore":
            return { ...layout, [action.pane]: { ...pane, collapsed: false, popped: false } };
        case "popped":
            return { ...layout, [action.pane]: { ...pane, popped: action.popped } };
    }
}

/**
 * The `grid-template-columns` value. The agents pane takes the free space; when it is a strip,
 * the free space goes to the previews pane, else to the sessions pane, so no column is empty.
 */
export function columns(layout: Layout): string {
    const strip = `${STRIP_PX}px`;
    const fixed = (pane: PaneName) => (isStrip(layout[pane]) ? strip : `${layout[pane].width}px`);
    let left = fixed("sessions");
    let middle = isStrip(layout.agents) ? strip : "1fr";
    let right = fixed("previews");
    if (isStrip(layout.agents)) {
        if (!isStrip(layout.previews)) {
            right = "1fr";
        } else if (!isStrip(layout.sessions)) {
            left = "1fr";
        } else {
            middle = "1fr";
        }
    }
    return `${left} ${HANDLE_PX}px ${middle} ${HANDLE_PX}px ${right}`;
}

export const STORAGE_KEY = "spinner.layout.v1";

/** The subset of `Storage` the layout needs, so tests pass a plain object. */
export interface LayoutStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

function isPaneRecord(value: unknown): value is { width?: unknown; collapsed?: unknown } {
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
    const layout: Layout = { ...DEFAULT_LAYOUT };
    if (!isPaneRecord(parsed)) {
        return layout;
    }
    const record = parsed as Record<string, unknown>;
    for (const pane of PANES) {
        const saved = record[pane];
        if (!isPaneRecord(saved)) {
            continue;
        }
        const { min, max } = LIMITS[pane];
        const width =
            typeof saved.width === "number" && Number.isFinite(saved.width)
                ? Math.min(max, Math.max(min, saved.width))
                : DEFAULT_LAYOUT[pane].width;
        const collapsed = saved.collapsed === true;
        layout[pane] = { width, collapsed, popped: false };
    }
    return layout;
}

/** Writes widths and collapsed flags. A full or disabled storage is not an error. */
export function saveLayout(storage: LayoutStorage | undefined, layout: Layout): void {
    const record: Record<string, { width: number; collapsed: boolean }> = {};
    for (const pane of PANES) {
        record[pane] = { width: layout[pane].width, collapsed: layout[pane].collapsed };
    }
    try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(record));
    } catch {
        // Private mode or a full quota: the layout lasts for this page only.
    }
}
