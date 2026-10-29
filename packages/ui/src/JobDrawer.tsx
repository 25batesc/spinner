// The job log at the bottom of the agents pane. A divider above it drags its height between
// `DRAWER_MIN_PX` and the pane's height minus `DRAWER_RESERVE_PX` (the terminal keeps that);
// a drag under the floor, or the minimize icon, collapses it to a one-line bar with the job's
// name and state, and a click on the bar restores the last height. The height and the collapsed
// flag live in the layout record (`layout.ts`), so they survive a reload with the pane widths.
import { useRef, type PointerEvent } from "react";

import type { Job } from "@spinner/protocol";

import { DRAWER_MIN_PX, DRAWER_RESERVE_PX, type DrawerState } from "./layout.ts";
import { IconButton } from "./PaneHead.tsx";

export interface JobDrawerProps {
    job: Job | undefined;
    error: string | null;
    onDismiss: () => void;
    drawer: DrawerState;
    onResize: (height: number, max: number) => void;
    /** `remember` is the height a collapsing drag began at. */
    onCollapse: (collapsed: boolean, remember?: number) => void;
}

/** The bar's and the header's colour: red for a failed job, amber for an action that failed. */
export function drawerTone(job: Job | undefined, error: string | null): "failed" | "error" | null {
    if (job?.state === "failed") {
        return "failed";
    }
    if (job === undefined && error !== null) {
        return "error";
    }
    return null;
}

/** One line for the bar and the header: `up · failed`, or `action failed` without a job. */
export function drawerTitle(job: Job | undefined): string {
    return job === undefined ? "action failed" : `${job.action} · ${job.state}`;
}

/** The ceiling for a drag: the enclosing pane's height minus the terminal's reserve. */
function maxHeightOf(element: HTMLElement): number {
    const pane = element.closest(".pane");
    const height = pane === null ? window.innerHeight : pane.getBoundingClientRect().height;
    return Math.round(height - DRAWER_RESERVE_PX);
}

export function JobDrawer(props: JobDrawerProps) {
    const { job, error, onDismiss, drawer, onResize, onCollapse } = props;
    // The pointer's y and the height when the drag began; the divider sits above the body.
    const drag = useRef<{ y: number; height: number; max: number } | null>(null);
    if (job === undefined && error === null) {
        return null;
    }
    const tone = drawerTone(job, error);
    const toneClass = tone === null ? "" : ` drawer-${tone}`;
    if (drawer.collapsed) {
        return (
            <button
                type="button"
                className={`drawer-bar${toneClass}`}
                aria-label="Job log, collapsed"
                title="Show the job log"
                onClick={() => onCollapse(false)}
            >
                <strong>{drawerTitle(job)}</strong>
                {job?.error != null && <span className="muted"> {job.error}</span>}
            </button>
        );
    }
    const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
            y: event.clientY, height: drawer.height, max: maxHeightOf(event.currentTarget),
        };
    };
    const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const current = drag.current;
        if (current === null) {
            return;
        }
        // The divider moves up to grow the drawer, so the height is the start minus the move.
        const height = current.height - (event.clientY - current.y);
        if (height < DRAWER_MIN_PX) {
            drag.current = null;
            onCollapse(true, current.height);
            return;
        }
        onResize(height, current.max);
    };
    const onPointerUp = () => {
        drag.current = null;
    };
    return (
        <div
            className={`drawer${toneClass}`}
            aria-label="Job log"
            style={{ height: `${drawer.height}px` }}
        >
            <div
                className="drawer-handle"
                role="separator"
                aria-label="Resize job log"
                aria-orientation="horizontal"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
            />
            <div className="drawer-head">
                <strong>{drawerTitle(job)}</strong>
                <span className="drawer-controls">
                    <IconButton
                        icon="minimize"
                        label="Minimize job log"
                        onClick={() => onCollapse(true)}
                    />
                    <button onClick={onDismiss} disabled={job?.state === "running"}>
                        close
                    </button>
                </span>
            </div>
            {error !== null && <p className="needs-human">{error}</p>}
            {job?.error != null && <p className="needs-human">{job.error}</p>}
            <pre className="drawer-log">{job?.log.join("\n")}</pre>
        </div>
    );
}
