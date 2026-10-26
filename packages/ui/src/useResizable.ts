// Drag-to-resize for one pane edge. The width is a view preference, so it lives here and is not
// part of the daemon-driven state.
import { useCallback, useState, type PointerEvent } from "react";

export interface Resizable {
    width: number;
    handleProps: {
        onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
        onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
        onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
    };
}

/**
 * @param direction `1` when dragging right widens the pane (left pane), `-1` when it narrows it
 *   (right pane).
 */
export function useResizable(initial: number, min: number, max: number, direction: 1 | -1) {
    const [width, setWidth] = useState(initial);
    const [drag, setDrag] = useState<{ x: number; start: number } | null>(null);

    const onPointerDown = useCallback(
        (event: PointerEvent<HTMLDivElement>) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setDrag({ x: event.clientX, start: width });
        },
        [width],
    );
    const onPointerMove = useCallback(
        (event: PointerEvent<HTMLDivElement>) => {
            if (drag === null) {
                return;
            }
            const next = drag.start + direction * (event.clientX - drag.x);
            setWidth(Math.min(max, Math.max(min, next)));
        },
        [drag, direction, min, max],
    );
    const onPointerUp = useCallback(() => setDrag(null), []);

    const result: Resizable = { width, handleProps: { onPointerDown, onPointerMove, onPointerUp } };
    return result;
}
