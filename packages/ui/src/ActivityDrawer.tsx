// The bottom drawer of the agents pane: the Activity feed and, while the operator watches a
// job, its log as a first section. A divider on its top edge (and the header itself) drags
// the height between `DRAWER_MIN_PX` and the pane's height minus `DRAWER_RESERVE_PX` (the
// terminal keeps that); a drag under the floor, or the minimize icon, collapses it to a
// one-line bar with the last job's name and state, and a click on the bar restores the last
// height. The height lives in the layout record (`layout.ts`) and survives a reload; the
// drawer starts collapsed and opens itself only for what needs the operator (`drawerOpens`,
// dogfood row 4): a watched job that fails, an action that fails, or the shown session's
// `needs_human` turning from none to a line. A routine job only moves the bar's line.
import { useRef, type PointerEvent } from "react";

import type { Job } from "@spinner/protocol";

import { DRAWER_MIN_PX, DRAWER_RESERVE_PX, type DrawerState } from "./layout.ts";
import { IconButton } from "./PaneHead.tsx";
import type { FeedLine } from "./state.ts";

export interface ActivityDrawerProps {
    feed: FeedLine[];
    /** The job the operator started, until they dismiss it. */
    job: Job | undefined;
    /** An action that failed before it became a job. */
    error: string | null;
    onDismiss: () => void;
    drawer: DrawerState;
    onResize: (height: number, max: number) => void;
    /** `remember` is the height a collapsing drag began at. */
    onCollapse: (collapsed: boolean, remember?: number) => void;
}

/** The header's and the bar's colour: red for a failed job, amber for an action that failed. */
export function drawerTone(job: Job | undefined, error: string | null): "failed" | "error" | null {
    if (job?.state === "failed") {
        return "failed";
    }
    if (job === undefined && error !== null) {
        return "error";
    }
    return null;
}

/** The job's line: `up · failed`; `action failed` for an error without a job; null for none. */
export function drawerTitle(job: Job | undefined, error: string | null): string | null {
    if (job !== undefined) {
        return `${job.action} · ${job.state}`;
    }
    return error === null ? null : "action failed";
}

/** What the auto-open rule reads, once per render of the main layout. */
export interface DrawerWatch {
    jobId: string | null;
    jobState: Job["state"] | null;
    error: string | null;
    /** The shown session's dir, or null when none is shown. */
    dir: string | null;
    /** The shown session's `needs_human`. */
    needs: string | null;
}

/**
 * True when the drawer opens itself between two reads: the watched job reached `failed`
 * (a new job that is already failed counts), an action failed before it became a job, or
 * the same shown session's `needs_human` turned from null to a line. Selecting another session
 * that already needs the operator does not open it; neither does a job that runs or ends ok.
 */
export function drawerOpens(before: DrawerWatch, after: DrawerWatch): boolean {
    if (after.jobState === "failed") {
        const sameJob = before.jobId === after.jobId;
        if (!sameJob || before.jobState !== "failed") {
            return true;
        }
    }
    if (before.error === null && after.error !== null) {
        return true;
    }
    if (before.dir === after.dir && after.dir !== null) {
        return before.needs === null && after.needs !== null;
    }
    return false;
}

/** The pill's colour for the job line: the job's state, or amber for an action that failed. */
function pillTone(job: Job | undefined): "accent" | "ok" | "fail" | "warn" {
    if (job === undefined) {
        return "warn";
    }
    if (job.state === "running") {
        return "accent";
    }
    return job.state === "ok" ? "ok" : "fail";
}

/** The ceiling for a drag: the enclosing pane's height minus the terminal's reserve. */
function maxHeightOf(element: HTMLElement): number {
    const pane = element.closest(".pane");
    const height = pane === null ? window.innerHeight : pane.getBoundingClientRect().height;
    return Math.round(height - DRAWER_RESERVE_PX);
}

type JobLogProps = Pick<ActivityDrawerProps, "job" | "error" | "onDismiss">;

function JobLog({ job, error, onDismiss }: JobLogProps) {
    return (
        <section className="drawer-section drawer-job" aria-label="Job log">
            <div className="drawer-section-head">
                <span className="muted">job log</span>
                <button onClick={onDismiss} disabled={job?.state === "running"}>close</button>
            </div>
            {error !== null && <p className="needs-human">{error}</p>}
            {job?.error != null && <p className="needs-human">{job.error}</p>}
            {job !== undefined && <pre className="drawer-log">{job.log.join("\n")}</pre>}
        </section>
    );
}

export function ActivityDrawer(props: ActivityDrawerProps) {
    const { feed, job, error, onDismiss, drawer, onResize, onCollapse } = props;
    // The pointer's y and the height when the drag began; the divider sits above the body.
    const drag = useRef<{ y: number; height: number; max: number } | null>(null);
    const tone = drawerTone(job, error);
    const toneClass = tone === null ? "" : ` drawer-${tone}`;
    const title = drawerTitle(job, error);
    const jobLine =
        title === null ? null : (
            <strong className={`pill pill-${pillTone(job)} drawer-job-line`}>{title}</strong>
        );
    if (drawer.collapsed) {
        return (
            <button
                type="button"
                className={`drawer-bar${toneClass}`}
                aria-label="Activity, collapsed"
                title="Show the activity drawer"
                onClick={() => onCollapse(false)}
            >
                <span>Activity</span>
                {jobLine}
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
            aria-label="Activity"
            style={{ height: `${drawer.height}px` }}
        >
            <div
                className="drawer-handle"
                role="separator"
                aria-label="Resize activity"
                aria-orientation="horizontal"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
            />
            <div
                className="drawer-head"
                title="Drag to resize; drag down to minimize"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
            >
                <h2>Activity</h2>
                <span className="drawer-controls" onPointerDown={(e) => e.stopPropagation()}>
                    {jobLine}
                    <IconButton
                        icon="minimize"
                        label="Minimize activity"
                        onClick={() => onCollapse(true)}
                    />
                </span>
            </div>
            <div className="drawer-body">
                {title !== null && <JobLog job={job} error={error} onDismiss={onDismiss} />}
                <section className="drawer-section feed" aria-label="Events">
                    {title !== null && <div className="drawer-section-head muted">events</div>}
                    {title === null && feed.length === 0 && (
                        <p className="muted drawer-empty">
                            No job yet. The log of the next action shows here.
                        </p>
                    )}
                    <ul>
                        {[...feed].reverse().map((line, index) => (
                            <li key={index}>
                                <span className="muted">{line.session}</span> {line.text}
                            </li>
                        ))}
                    </ul>
                </section>
            </div>
        </div>
    );
}
