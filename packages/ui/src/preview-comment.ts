// The pure half of preview comments (s054): the geometry of a frozen preview (a drag, the
// crop of the screenshot) and the choices the comment box and the lists make. The page's own
// coordinates are CSS pixels of its viewport, as `previews.capture` and `previews.inspect`
// measure them; the image on screen is scaled, and the PNG has the screen's pixel density.
import type { Comment, PreviewCapture, PreviewRect } from "@spinner/protocol";

export interface Point {
    x: number;
    y: number;
}

/** A press that moves less than this, in screen pixels, is a click, not a drag. */
export const DRAG_MIN_PX = 4;

export function isDrag(start: Point, end: Point): boolean {
    return Math.abs(end.x - start.x) >= DRAG_MIN_PX || Math.abs(end.y - start.y) >= DRAG_MIN_PX;
}

/** The rectangle between two corners, whichever way the drag went. */
export function dragRect(start: Point, end: Point): PreviewRect {
    return {
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
    };
}

/** `rect` cut to the viewport and rounded; null when nothing of it is inside. */
export function clampRect(rect: PreviewRect, width: number, height: number): PreviewRect | null {
    const left = Math.max(0, Math.round(rect.x));
    const top = Math.max(0, Math.round(rect.y));
    const right = Math.min(width, Math.round(rect.x + rect.width));
    const bottom = Math.min(height, Math.round(rect.y + rect.height));
    if (right <= left || bottom <= top) {
        return null;
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * `rect` in CSS pixels of the page as pixels of the PNG: the image is `natural` pixels for
 * the capture's `width` × `height` CSS pixels (2 per CSS pixel on a Retina screen).
 */
export function imageRect(
    rect: PreviewRect,
    capture: Pick<PreviewCapture, "width" | "height">,
    natural: { width: number; height: number },
): PreviewRect | null {
    if (capture.width <= 0 || capture.height <= 0) {
        return null;
    }
    const sx = natural.width / capture.width;
    const sy = natural.height / capture.height;
    const scaled = {
        x: rect.x * sx,
        y: rect.y * sy,
        width: rect.width * sx,
        height: rect.height * sy,
    };
    return clampRect(scaled, natural.width, natural.height);
}

/** The comment box's agent: the lead when the session has one, else the first agent. */
export function defaultAgent(agents: readonly string[]): string | undefined {
    return agents.includes("lead") ? "lead" : agents[0];
}

/** The unresolved preview comments on `service`, oldest first: the pins and the strip. */
export function openCommentsOn(comments: readonly Comment[], service: string): Comment[] {
    return comments
        .filter((comment) => comment.state !== "resolved")
        .filter((c) => c.anchor.kind === "preview" && c.anchor.service === service)
        .sort((a, b) => a.created.localeCompare(b.created));
}

/** `waits on you`, `waits on lead`, `suggested: resolve?` or `resolved`. */
export function waitingLabel(comment: Comment): string {
    if (comment.state === "resolved") {
        return "resolved";
    }
    if (comment.state === "suggested") {
        return "suggested: resolve?";
    }
    return comment.waiting_on === "operator" ? "waits on you" : `waits on ${comment.agent}`;
}

/** The file name of a screenshot path, for `GET /sessions/:dir/attachments/:name`. */
export function attachmentUrl(dir: string, path: string | null): string | null {
    if (path === null) {
        return null;
    }
    const name = path.split("/").pop() ?? "";
    return name === "" ? null : `/sessions/${dir}/attachments/${encodeURIComponent(name)}`;
}

/** What the agent hears about a send, for the line under the bar. */
export function sentNote(id: string, agent: string, delivered: string | undefined): string {
    if (delivered === "stopped") {
        return `Comment ${id} saved; ${agent} is not running and gets it with its next prompt.`;
    }
    if (delivered === "queued") {
        return `Comment ${id} sent to ${agent}; it waits behind the current turn.`;
    }
    return `Comment ${id} sent to ${agent}.`;
}
