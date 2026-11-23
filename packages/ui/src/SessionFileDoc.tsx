// The reading column of the Files view (`SessionFiles.tsx`): the rendered file, the passage
// the operator selects in it, and the box he writes a comment in. `Document` marks the
// blocks that carry an open comment and scrolls to one on request; the parent holds the
// comments and the selection.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import type { Comment, SessionFileResponse } from "@spinner/protocol";

import { renderMarkdown } from "./markdown.ts";
import { defaultAgent } from "./preview-comment.ts";
import { blockOfQuote, rawUrl, resolveLink, viewerOf } from "./session-files.ts";

/** A passage the operator selected, before he writes the comment. `""` is the whole file. */
export interface Passage {
    quote: string;
    heading: string | null;
}

/** A heading of the open document: `index` counts every heading of the page, in order. */
export interface OutlineItem {
    level: number;
    text: string;
    index: number;
}

/** A comment to scroll to. `tick` moves on each request, so the same comment shows again. */
export interface CommentFocus {
    id: string;
    tick: number;
}

/** The blocks of a rendered document a comment can sit on, in page order. */
const BLOCKS = "h1, h2, h3, h4, h5, h6, p, li, td, th, pre, blockquote";
export const HEADINGS = "h1, h2, h3, h4, h5, h6";
/** The outline lists headings down to this level. */
const OUTLINE_LEVEL_MAX = 3;
/** How long the passage of a comment stays lit after a jump to it. */
const FLASH_MS = 1600;

/** A heading's text without the `#` mark markdown-it-anchor adds. */
function headingText(node: Element): string {
    return (node.textContent ?? "").replace(/^#\s*/, "").trim();
}

/** The nearest heading above `node` in `root`, or null above the first. */
function headingAbove(root: HTMLElement, node: Node): string | null {
    let found: string | null = null;
    for (const heading of root.querySelectorAll(HEADINGS)) {
        const position = heading.compareDocumentPosition(node);
        const above = (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 || heading.contains(node);
        if (!above) {
            break;
        }
        found = headingText(heading);
    }
    return found;
}

/** The selection inside `root` as a passage; null when nothing of `root` is selected. */
export function selectedPassage(root: HTMLElement | null): Passage | null {
    const selection = window.getSelection();
    if (root === null || selection === null || selection.isCollapsed) {
        return null;
    }
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) {
        return null;
    }
    const quote = selection.toString().trim();
    return quote === "" ? null : { quote, heading: headingAbove(root, range.startContainer) };
}

/**
 * `html` with the document's relative images pointed at the daemon. The rewrite happens in
 * a `template`, which loads nothing, so the page never asks for the unresolved address.
 */
function withSessionImages(html: string, dir: string, path: string): string {
    const holder = document.createElement("template");
    holder.innerHTML = html;
    for (const image of holder.content.querySelectorAll("img")) {
        const target = resolveLink(path, image.getAttribute("src") ?? "");
        if (target !== null) {
            image.setAttribute("src", rawUrl(dir, target));
        }
    }
    return holder.innerHTML;
}

/** The headings of the rendered page, down to `OUTLINE_LEVEL_MAX`. */
function outlineOf(root: HTMLElement): OutlineItem[] {
    const outline: OutlineItem[] = [];
    root.querySelectorAll(HEADINGS).forEach((heading, index) => {
        const level = Number(heading.tagName.slice(1));
        if (level <= OUTLINE_LEVEL_MAX) {
            outline.push({ level, text: headingText(heading), index });
        }
    });
    return outline;
}

/** Sets `data-comment` on the block of each open comment, and clears the marks before it. */
function markComments(root: HTMLElement, comments: readonly Comment[]): void {
    for (const marked of root.querySelectorAll("[data-comment]")) {
        marked.removeAttribute("data-comment");
    }
    const blocks = [...root.querySelectorAll(BLOCKS)];
    const texts = blocks.map((block) => block.textContent ?? "");
    for (const comment of comments) {
        if (comment.state !== "resolved" && comment.anchor.kind === "doc") {
            blocks[blockOfQuote(comment.anchor.quote, texts)]?.setAttribute(
                "data-comment", comment.id);
        }
    }
}

export interface DocumentProps {
    dir: string;
    file: SessionFileResponse;
    /** True shows a Markdown file as its source. */
    raw: boolean;
    /** The comments on this file. */
    comments: Comment[];
    focus: CommentFocus | null;
    bodyRef: React.RefObject<HTMLDivElement | null>;
    onOutline: (items: OutlineItem[]) => void;
    /** A click on a relative link: the path of the file it names. */
    onOpen: (path: string) => void;
    /** The selection moved: the passage and the viewport point at its end, or null. */
    onSelect: (passage: Passage | null, at: { x: number; y: number } | null) => void;
}

/**
 * The rendered file. A relative image loads from the daemon and a relative link opens that
 * file in the view; any other link leaves in a new tab. A file that is not Markdown shows as
 * its text.
 */
export function Document(props: DocumentProps) {
    const { dir, file, raw, comments, focus, bodyRef, onOutline, onOpen, onSelect } = props;
    const markdown = viewerOf(file.path) === "markdown" && !raw;
    const html = useMemo(
        () => (markdown ? withSessionImages(renderMarkdown(file.text), dir, file.path) : ""),
        [markdown, file.text, file.path, dir],
    );
    useEffect(() => {
        const root = bodyRef.current;
        // `onOutline` is a state setter of the parent; `html` names what the page holds.
        onOutline(root === null || !markdown ? [] : outlineOf(root));
    }, [html, markdown]);
    useEffect(() => {
        if (bodyRef.current !== null) {
            markComments(bodyRef.current, markdown ? comments : []);
        }
    }, [html, markdown, comments]);
    // A focus is shown once: when its block is on the page, which for a comment on another
    // file is after that file rendered. A later reload of the text does not scroll again.
    const focused = useRef(0);
    useEffect(() => {
        const root = bodyRef.current;
        if (root === null || focus === null || focused.current === focus.tick) {
            return;
        }
        const block = root.querySelector(`[data-comment="${focus.id}"]`);
        if (block === null) {
            return;
        }
        focused.current = focus.tick;
        block.scrollIntoView({ block: "center", behavior: "smooth" });
        block.classList.add("sf-flash");
        window.setTimeout(() => block.classList.remove("sf-flash"), FLASH_MS);
    }, [focus, html, comments]);

    const clicked = (event: MouseEvent<HTMLDivElement>) => {
        const href = (event.target as Element).closest("a")?.getAttribute("href") ?? "";
        const target = resolveLink(file.path, href);
        if (target !== null) {
            event.preventDefault();
            onOpen(target);
        }
    };
    const selected = () => {
        const passage = selectedPassage(bodyRef.current);
        const rect = passage === null
            ? null
            : window.getSelection()?.getRangeAt(0).getBoundingClientRect() ?? null;
        onSelect(passage, rect === null ? null : { x: rect.right, y: rect.bottom });
    };
    if (!markdown) {
        return (
            <div className="sf-doc" ref={bodyRef} onMouseUp={selected} onKeyUp={selected}>
                <pre className="sf-plain">{file.text}</pre>
            </div>
        );
    }
    return (
        <div
            className="sf-doc md"
            ref={bodyRef}
            onClick={clicked}
            onMouseUp={selected}
            onKeyUp={selected}
            // The HTML passed through DOMPurify in `renderMarkdown`.
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
}

export interface ComposerProps {
    passage: Passage;
    /** The session's agents; the comment goes to one of them. */
    agents: string[];
    onSend: (agent: string, text: string) => Promise<void>;
    onCancel: () => void;
}

/** The box a comment is written in: the quoted passage, the agent it goes to, the text. */
export function Composer({ passage, agents, onSend, onCancel }: ComposerProps) {
    const [text, setText] = useState("");
    const [agent, setAgent] = useState(defaultAgent(agents) ?? "");
    const [error, setError] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const ready = text.trim() !== "" && agent !== "" && !sending;
    const send = () => {
        if (!ready) {
            return;
        }
        setSending(true);
        onSend(agent, text.trim()).catch((failure: unknown) => {
            setError(failure instanceof Error ? failure.message : String(failure));
            setSending(false);
        });
    };
    const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            send();
        } else if (event.key === "Escape" && text.trim() === "") {
            onCancel();
        }
    };
    return (
        <div className="sf-composer">
            {passage.quote === "" ? (
                <p className="muted sf-composer-on">On the whole file</p>
            ) : (
                <blockquote className="comment-quote">{passage.quote}</blockquote>
            )}
            <textarea
                autoFocus
                aria-label="Comment"
                placeholder={`What should ${agent === "" ? "the agent" : agent} do here?`}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={keys}
            />
            <div className="sf-composer-send">
                {agents.length > 1 && (
                    <select
                        aria-label="The agent the comment goes to"
                        value={agent}
                        onChange={(event) => setAgent(event.target.value)}
                    >
                        {agents.map((name) => <option key={name}>{name}</option>)}
                    </select>
                )}
                <button type="button" onClick={onCancel}>cancel</button>
                <button
                    type="button"
                    className="primary"
                    disabled={!ready}
                    title="Send the comment to the agent (⌘Enter)"
                    onClick={send}
                >
                    comment
                </button>
            </div>
            {agents.length === 0 && (
                <p className="needs-human">This session has no agent to send a comment to.</p>
            )}
            {error !== null && <p className="needs-human">{error}</p>}
        </div>
    );
}
