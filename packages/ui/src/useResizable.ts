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
    type RefCallback,
} from "react";

import {
    columns,
    fitLayout,
    LIMITS,
    SNAP_PX,
    loadLayout,
    reduceLayout,
    saveLayout,
    visiblePanes,
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
    /** The stored layout: what the operator set, whatever the window's width. */
    layout: Layout;
    /**
     * The layout as the grid's width allows (`fitLayout`): a narrow window shrinks, then
     * folds, the previews and the side panel here without a change to `layout`.
     */
    fitted: Layout;
    /** Goes on the grid element; its width feeds `fitted`. */
    container: RefCallback<HTMLDivElement>;
    /** The panes with a column, left to right; a divider sits between two of them. */
    visible: PaneName[];
    /** The `grid-template-columns` value for the fitted layout. */
    columns: string;
    /** True during a divider drag; the layout then ignores pointer events on the previews. */
    dragging: boolean;
    /** The pane a drag has pulled past its minimum by `SNAP_PX`: it folds on release. */
    armed: PaneName | null;
    /** Props for the divider between two neighbouring visible panes. */
    handle(left: PaneName, right: PaneName): HandleProps;
    /** Folds the pane: the left panel hides, the previews become a strip, agents stay. */
    fold(pane: PaneName): void;
    restore(pane: PaneName): void;
    setPopped(pane: PaneName, popped: boolean): void;
    setExpanded(expanded: boolean): void;
    /** The job drawer's height from a drag; `max` is the pane's height minus the reserve. */
    setDrawerHeight(height: number, max: number): void;
    setDrawerCollapsed(collapsed: boolean, remember?: number): void;
}

/** The widths of the two panes beside a divider when the drag began. */
interface Drag {
    left: PaneName;
    right: PaneName;
    x: number;
    leftStart: number;
    rightStart: number;
}

function storageOrUndefined(): Storage | undefined {
    try {
        return window.localStorage;
    } catch {
        return undefined;
    }
}

/** The rendered widths of the elements beside the divider, strips included. */
function neighbourWidths(handle: HTMLElement): { left: number; right: number } {
    const widthOf = (element: Element | null) =>
        element === null ? 0 : element.getBoundingClientRect().width;
    return {
        left: widthOf(handle.previousElementSibling),
        right: widthOf(handle.nextElementSibling),
    };
}

/**
 * One side of a divider after the pointer moved: a shown pane takes the width, clamped at its
 * minimum; a collapsed pane reopens once the pointer is back past the minimum. A popped-out
 * strip is left alone; its window owns the pane. The fold itself waits for the release.
 */
function moveSide(layout: Layout, pane: PaneName, next: number): LayoutAction | null {
    const state = layout.panes[pane];
    const { min } = LIMITS[pane];
    if (state.popped || state.hidden) {
        return null;
    }
    if (state.collapsed) {
        return next >= min ? { kind: "restore", pane, width: next } : null;
    }
    return { kind: "drag", pane, width: next };
}

/** True when the pointer pulled an open pane `SNAP_PX` past its minimum. */
function overshoots(layout: Layout, pane: PaneName, next: number): boolean {
    const state = layout.panes[pane];
    return !state.hidden && !state.popped && !state.collapsed && next < LIMITS[pane].min - SNAP_PX;
}

/** The agents pane never folds: the drag stops where it reaches the agents minimum. */
function stopAtAgents(current: Drag, dx: number): number {
    const min = LIMITS.agents.min;
    if (current.left === "agents") {
        return Math.max(dx, min - current.leftStart);
    }
    if (current.right === "agents") {
        return Math.min(dx, current.rightStart - min);
    }
    return dx;
}

export function useLayout(): PaneLayout {
    const [layout, dispatch] = useReducer(reduceLayout, undefined, () =>
        loadLayout(storageOrUndefined()),
    );
    const latest = useRef(layout);
    latest.current = layout;
    const drag = useRef<Drag | null>(null);
    const [dragging, setDragging] = useState(false);
    const [armed, setArmed] = useState<PaneName | null>(null);
    // The grid's width, from a ResizeObserver on the element; 0 until the first measure.
    const [width, setWidth] = useState(0);
    const observer = useRef<ResizeObserver | null>(null);
    const container = useCallback<RefCallback<HTMLDivElement>>((element) => {
        observer.current?.disconnect();
        observer.current = null;
        if (element === null || typeof ResizeObserver === "undefined") {
            return;
        }
        setWidth(Math.round(element.getBoundingClientRect().width));
        observer.current = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (entry !== undefined) {
                setWidth(Math.round(entry.contentRect.width));
            }
        });
        observer.current.observe(element);
    }, []);

    useEffect(() => {
        saveLayout(storageOrUndefined(), layout);
    }, [layout]);

    const act = useCallback((action: LayoutAction) => dispatch(action), []);

    // Both sides move at once: the left grows by `dx`, the right shrinks by it. The free pane
    // takes its width too, so a later restore of its neighbour leaves no jump.
    const move = useCallback(
        (current: Drag, moved: number) => {
            const dx = stopAtAgents(current, moved);
            const sides: [PaneName, number, number][] = [
                [current.left, current.leftStart, current.leftStart + dx],
                [current.right, current.rightStart, current.rightStart - dx],
            ];
            let pulled: PaneName | null = null;
            for (const [pane, , next] of sides) {
                const action = moveSide(latest.current, pane, next);
                if (action !== null) {
                    act(action);
                }
                if (overshoots(latest.current, pane, next)) {
                    pulled = pane;
                }
            }
            setArmed(pulled);
        },
        [act],
    );
    // The fold on release: the width at pointer down is what a restore brings back, not the
    // minimum the pane sat at while the pointer was past it.
    const release = useCallback(() => {
        const current = drag.current;
        if (current !== null && armed !== null) {
            const start = armed === current.left ? current.leftStart : current.rightStart;
            const remember = start >= LIMITS[armed].min ? start : undefined;
            act({ kind: "collapse", pane: armed, remember });
        }
        drag.current = null;
        setDragging(false);
        setArmed(null);
    }, [act, armed]);

    const handle = useCallback(
        (left: PaneName, right: PaneName): HandleProps => {
            const begin = (element: HTMLElement, x: number): Drag => {
                const widths = neighbourWidths(element);
                return { left, right, x, leftStart: widths.left, rightStart: widths.right };
            };
            const restoreBoth = () => {
                for (const pane of [left, right]) {
                    if (latest.current.panes[pane].collapsed) {
                        act({ kind: "restore", pane });
                    }
                }
            };
            return {
                role: "separator",
                tabIndex: 0,
                "aria-label": `Resize ${left} and ${right}`,
                onPointerDown: (event) => {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    drag.current = begin(event.currentTarget, event.clientX);
                    setDragging(true);
                },
                onPointerMove: (event) => {
                    if (drag.current === null) {
                        return;
                    }
                    move(drag.current, event.clientX - drag.current.x);
                },
                onPointerUp: release,
                onDoubleClick: restoreBoth,
                onKeyDown: (event) => {
                    if (event.key === "Enter") {
                        restoreBoth();
                    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                        const sign = event.key === "ArrowRight" ? 1 : -1;
                        move(begin(event.currentTarget, 0), sign * KEY_STEP_PX);
                    } else {
                        return;
                    }
                    event.preventDefault();
                },
            };
        },
        [act, move, release],
    );

    const fitted = fitLayout(layout, width);
    return {
        layout,
        fitted,
        container,
        visible: visiblePanes(fitted),
        columns: columns(fitted),
        dragging,
        armed,
        handle,
        fold: useCallback(
            (pane: PaneName) => act({ kind: "collapse", pane, remember: undefined }),
            [act],
        ),
        restore: useCallback((pane: PaneName) => act({ kind: "restore", pane }), [act]),
        setPopped: useCallback(
            (pane: PaneName, popped: boolean) => act({ kind: "popped", pane, popped }),
            [act],
        ),
        setExpanded: useCallback((expanded: boolean) => act({ kind: "expand", expanded }), [act]),
        setDrawerHeight: useCallback(
            (height: number, max: number) => act({ kind: "drawer", height, max }),
            [act],
        ),
        setDrawerCollapsed: useCallback(
            (collapsed: boolean, remember?: number) =>
                act({ kind: "drawer-collapse", collapsed, remember }),
            [act],
        ),
    };
}
