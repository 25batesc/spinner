// Comment mode of a desktop preview (s054). The native view is hidden while this shows: the
// page is a still picture from `previews.capture`, because nothing the UI draws can sit over
// a live native view. The operator hovers to see the element under the cursor (asked of the
// page through `onInspect`), clicks to pick it, drags to mark an area, or takes the whole
// page; then writes the comment, picks the agent, and sends. The send crops the picture,
// saves it (`POST .../attachments`) and posts the comment, which the daemon delivers. The
// bridge stays in `Preview.tsx`; this file gets the capture and the inspect call as props.
import { useEffect, useRef, useState, type MouseEvent } from "react";

import type {
    Comment,
    PreviewAnchor,
    PreviewCapture,
    PreviewElement,
    PreviewRect,
} from "@spinner/protocol";

import {
    clampRect,
    defaultAgent,
    dragRect,
    imageRect,
    isDrag,
    openCommentsOn,
    sentNote,
    type Point,
} from "./preview-comment.ts";
import { postAttachment, postComment } from "./remote.ts";

export interface PreviewCommentProps {
    dir: string;
    service: string;
    capture: PreviewCapture;
    agents: string[];
    /** The session's comments, for the pins of the open ones on this service. */
    comments: Comment[];
    onInspect: (point: Point) => Promise<PreviewElement | null>;
    /** Leaves comment mode; `note` says what happened to a sent comment. */
    onClose: (note: string | null) => void;
}

/** What the operator marked: an element, an area, or the whole page. */
type Selection =
    | { kind: "element"; element: PreviewElement }
    | { kind: "area"; rect: PreviewRect }
    | { kind: "page" };

function selectionRect(selection: Selection): PreviewRect | null {
    if (selection.kind === "element") {
        return selection.element.rect;
    }
    return selection.kind === "area" ? selection.rect : null;
}

/** The selection's part of the picture as base64 PNG; the whole picture for the page. */
async function cropped(capture: PreviewCapture, rect: PreviewRect | null): Promise<string> {
    if (rect === null) {
        return capture.png;
    }
    const image = new Image();
    image.src = `data:image/png;base64,${capture.png}`;
    await image.decode();
    const natural = { width: image.naturalWidth, height: image.naturalHeight };
    const area = imageRect(rect, capture, natural);
    if (area === null) {
        return capture.png;
    }
    const canvas = document.createElement("canvas");
    canvas.width = area.width;
    canvas.height = area.height;
    const context = canvas.getContext("2d");
    if (context === null) {
        return capture.png;
    }
    const { x, y, width, height } = area;
    context.drawImage(image, x, y, width, height, 0, 0, width, height);
    return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}

function anchorOf(
    service: string,
    capture: PreviewCapture,
    selection: Selection,
    screenshot: string,
): PreviewAnchor {
    const element = selection.kind === "element" ? selection.element : null;
    return {
        kind: "preview",
        service,
        url: capture.url,
        selector: element?.selector ?? null,
        text: element?.text ?? null,
        component: element?.component ?? null,
        source: element?.source ?? null,
        rect: selectionRect(selection),
        screenshot,
        console_errors: capture.console_errors,
    };
}

/** A box over the picture at a page rectangle, scaled to the picture on screen. */
function Box({ rect, scale, className }: { rect: PreviewRect; scale: number; className: string }) {
    const style = {
        left: rect.x * scale,
        top: rect.y * scale,
        width: rect.width * scale,
        height: rect.height * scale,
    };
    return <div className={className} style={style} />;
}

export function PreviewComment(props: PreviewCommentProps) {
    const { dir, service, capture, agents, comments, onInspect, onClose } = props;
    const image = useRef<HTMLImageElement>(null);
    const [scale, setScale] = useState(1);
    const [hover, setHover] = useState<PreviewElement | null>(null);
    const [press, setPress] = useState<{ start: Point; now: Point } | null>(null);
    const [selection, setSelection] = useState<Selection | null>(null);
    const inspecting = useRef(false);

    // The picture is fitted to the pane's width; every page rectangle is scaled by this.
    useEffect(() => {
        const element = image.current;
        if (element === null) {
            return;
        }
        const measure = () => setScale(element.clientWidth / capture.width);
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        measure();
        return () => observer.disconnect();
    }, [capture.width]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                if (selection !== null) {
                    setSelection(null);
                } else {
                    onClose(null);
                }
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [selection, onClose]);

    const pagePoint = (event: MouseEvent): Point => {
        const box = event.currentTarget.getBoundingClientRect();
        return { x: (event.clientX - box.left) / scale, y: (event.clientY - box.top) / scale };
    };

    const onMove = (event: MouseEvent<HTMLDivElement>) => {
        const point = pagePoint(event);
        if (press !== null) {
            setPress({ ...press, now: point });
            return;
        }
        // One question to the page at a time; the hover follows the last answer.
        if (selection === null && !inspecting.current) {
            inspecting.current = true;
            void onInspect(point)
                .then(setHover)
                .finally(() => {
                    inspecting.current = false;
                });
        }
    };

    const onDown = (event: MouseEvent<HTMLDivElement>) => {
        if (selection === null && event.button === 0) {
            const point = pagePoint(event);
            setPress({ start: point, now: point });
        }
    };

    const onUp = async (event: MouseEvent<HTMLDivElement>) => {
        if (press === null) {
            return;
        }
        const end = pagePoint(event);
        setPress(null);
        // A drag is measured on screen, where the operator's hand moved.
        const on_screen = (point: Point) => ({ x: point.x * scale, y: point.y * scale });
        if (isDrag(on_screen(press.start), on_screen(end))) {
            const rect = clampRect(dragRect(press.start, end), capture.width, capture.height);
            if (rect !== null) {
                setSelection({ kind: "area", rect });
            }
            return;
        }
        const element = await onInspect(end);
        if (element !== null) {
            setSelection({ kind: "element", element });
        }
    };

    const pins = openCommentsOn(comments, service).filter(
        (comment) => comment.anchor.kind === "preview" && comment.anchor.url === capture.url,
    );
    const marked = selection === null ? null : selectionRect(selection);
    return (
        <div className="comment-mode" aria-label="Comment on the preview">
            <div className="comment-toolbar">
                <span>
                    {selection === null
                        ? "Click an element, drag an area, or"
                        : "Write the comment, or Escape to mark again."}
                </span>
                {selection === null && (
                    <button onClick={() => setSelection({ kind: "page" })}>whole page</button>
                )}
                {capture.console_errors.length > 0 && (
                    <span className="badge" title={capture.console_errors.join("\n")}>
                        {capture.console_errors.length} console error
                        {capture.console_errors.length === 1 ? "" : "s"}
                    </span>
                )}
                <button onClick={() => onClose(null)}>cancel</button>
            </div>
            <div className="comment-stage">
                <div
                    className={selection === null ? "comment-canvas picking" : "comment-canvas"}
                    onMouseMove={onMove}
                    onMouseDown={onDown}
                    onMouseUp={(event) => void onUp(event)}
                    onMouseLeave={() => setHover(null)}
                >
                    <img
                        ref={image}
                        className="comment-shot"
                        src={`data:image/png;base64,${capture.png}`}
                        alt="The preview, frozen"
                        draggable={false}
                    />
                    {selection === null && press === null && hover !== null && (
                        <Box rect={hover.rect} scale={scale} className="comment-hover" />
                    )}
                    {press !== null && (
                        <Box
                            rect={dragRect(press.start, press.now)}
                            scale={scale}
                            className="comment-mark"
                        />
                    )}
                    {marked !== null && (
                        <Box rect={marked} scale={scale} className="comment-mark" />
                    )}
                    {pins.map((comment) => {
                        const rect = comment.anchor.kind === "preview" ? comment.anchor.rect : null;
                        const style = rect === null
                            ? { left: 4, top: 4 }
                            : { left: rect.x * scale, top: rect.y * scale };
                        return (
                            <span key={comment.id} className="comment-pin" style={style}
                                title={comment.messages[0]?.text}>
                                {comment.id}
                            </span>
                        );
                    })}
                </div>
                {selection !== null && (
                    <Composer
                        agents={agents}
                        selection={selection}
                        onSend={async (agent, text) => {
                            const png = await cropped(capture, selectionRect(selection));
                            const saved = await postAttachment(dir, png);
                            const anchor = anchorOf(service, capture, selection, saved.path);
                            const sent = await postComment(dir, { agent, text, anchor });
                            onClose(sentNote(sent.comment.id, agent, sent.delivered));
                        }}
                    />
                )}
            </div>
        </div>
    );
}

/** What the comment box says was picked. */
function pickedLine(selection: Selection): string {
    if (selection.kind === "element") {
        const { component, selector, source } = selection.element;
        return `${component ?? selector}${source === null ? "" : ` · ${source}`}`;
    }
    return selection.kind === "area" ? "the marked area" : "the whole page";
}

interface ComposerProps {
    agents: string[];
    selection: Selection;
    onSend: (agent: string, text: string) => Promise<void>;
}

/** The comment box: what was picked, the text, the agent, send. */
function Composer({ agents, selection, onSend }: ComposerProps) {
    const [text, setText] = useState("");
    const [agent, setAgent] = useState(defaultAgent(agents) ?? "");
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const send = () => {
        setSending(true);
        onSend(agent, text.trim()).catch((failure: unknown) => {
            setError(String(failure));
            setSending(false);
        });
    };
    return (
        <form
            className="comment-composer"
            onSubmit={(event) => {
                event.preventDefault();
                send();
            }}
        >
            <p className="muted comment-picked">{pickedLine(selection)}</p>
            <textarea
                autoFocus
                value={text}
                placeholder="What should change here?"
                aria-label="Comment"
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        send();
                    }
                }}
            />
            <div className="comment-send">
                <label>
                    to{" "}
                    <select value={agent} onChange={(event) => setAgent(event.target.value)}>
                        {agents.map((name) => (
                            <option key={name} value={name}>{name}</option>
                        ))}
                    </select>
                </label>
                <button
                    className="primary"
                    type="submit"
                    disabled={sending || text.trim() === "" || agent === ""}
                >
                    send
                </button>
            </div>
            {agents.length === 0 && <p className="needs-human">The session has no agent yet.</p>}
            {error !== null && <p className="needs-human">{error}</p>}
        </form>
    );
}
