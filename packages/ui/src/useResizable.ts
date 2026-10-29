// Drag-to-resize, collapse, hide and restore for the three panes. The rules live in `layout.ts`;
// this hook binds them to React state, the pointer, the keyboard and `localStorage`.
import {
    useCallback,
    useEffect,
    useReducer,
    useRef,
    useState,
    type KeyboardEvent,
    type PointerEvent,
} from "react";

import {
    columns,
    isStrip,
    LIMITS,
    loadLayout,
    reduceLayout,
    saveLayout,
    STRIP_PX,
    type Layout,
    type LayoutAction,
    type PaneName,
} from "./layout.ts";

/** One keyboard step on a focused divider, in CSS pixels. */
const KEY_STEP_PX = 24;

export interface HandleProps {
    role: "separator";
    tabIndex: 0;
    "aria-label": string;
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
    onDoubleClick: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

export interface PaneLayout {
    layout: Layout;
    /** The `grid-template-columns` value for the current layout. */
    columns: string;
    /** True during a divider drag; the layout then ignores pointer events on the previews. */
    dragging: boolean;
    /** Props for the divider beside a side pane. */
    handle(pane: "sessions" | "previews"): HandleProps;
    hide(pane: PaneName): void;
    restore(pane: PaneName): void;
    setPopped(pane: PaneName, popped: boolean): void;
}

function storageOrUndefined(): Storage | undefined {
    try {
        return window.localStorage;
    } catch {
        return undefined;
    }
}

export function useLayout(): PaneLayout {
    const [layout, dispatch] = useReducer(reduceLayout, undefined, () =>
        loadLayout(storageOrUndefined()),
    );
    const drag = useRef<{ pane: PaneName; x: number; start: number } | null>(null);
    const [dragging, setDragging] = useState(false);

    useEffect(() => {
        saveLayout(storageOrUndefined(), layout);
    }, [layout]);

    const act = useCallback((action: LayoutAction) => dispatch(action), []);

    const handle = useCallback(
        (pane: "sessions" | "previews"): HandleProps => {
            // Dragging right widens the left pane and narrows the right one.
            const direction = pane === "sessions" ? 1 : -1;
            const state = layout[pane];
            return {
                role: "separator",
                tabIndex: 0,
                "aria-label": `Resize ${pane}`,
                onPointerDown: (event) => {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    const start = isStrip(state) ? STRIP_PX : state.width;
                    drag.current = { pane, x: event.clientX, start };
                    setDragging(true);
                },
                onPointerMove: (event) => {
                    if (drag.current === null) {
                        return;
                    }
                    const { start } = drag.current;
                    const next = start + direction * (event.clientX - drag.current.x);
                    if (next < LIMITS[pane].min) {
                        // The width at pointer down is what a restore brings back, not the
                        // last open width the pointer crossed on its way to the threshold.
                        const remember = start >= LIMITS[pane].min ? start : undefined;
                        act({ kind: "collapse", pane, remember });
                    } else {
                        act({ kind: "drag", pane, width: next });
                    }
                },
                onPointerUp: () => {
                    drag.current = null;
                    setDragging(false);
                },
                onDoubleClick: () => act({ kind: "restore", pane }),
                onKeyDown: (event) => {
                    if (event.key === "Enter") {
                        act({ kind: "restore", pane });
                    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                        const sign = event.key === "ArrowRight" ? 1 : -1;
                        const width = isStrip(state) ? STRIP_PX : state.width;
                        act({ kind: "drag", pane, width: width + direction * sign * KEY_STEP_PX });
                    } else {
                        return;
                    }
                    event.preventDefault();
                },
            };
        },
        [layout, act],
    );

    return {
        layout,
        columns: columns(layout),
        dragging,
        handle,
        hide: useCallback((pane: PaneName) => act({ kind: "hide", pane }), [act]),
        restore: useCallback((pane: PaneName) => act({ kind: "restore", pane }), [act]),
        setPopped: useCallback(
            (pane: PaneName, popped: boolean) => act({ kind: "popped", pane, popped }),
            [act],
        ),
    };
}
