// The Draft tab (docs/designs/session-workspace.md, T7; docs/designs/egm-adoption.md, entry
// 5.8): the doc once the lead named it with `design_doc`, else `design_draft.md`, fetched by
// the agents pane once per reload key (D15). A left outline lists the
// `## ` headings; a click scrolls to the section. Under each section, `request revision` opens
// a text box whose `send` answers the lead through `POST …/design/answer`. `source` shows the
// raw text. The doc renders section by section with the mission's markdown renderer. While
// the doc differs from its approval, a warn banner above it opens the approve dialog with the
// changed sections (entry 6.17). Beside each plan entry heading the tab draws a done mark from
// the Plan items linked to it (T7, D9): a DOM walk after each render sets `data-mark` on the
// `h4` and `h5` elements that parse as entries, so the doc text and its hash never change.
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import {
    DESIGN_ANSWER_MAX, parse_entry_heading, scan, type MissionView, type SessionView,
} from "@spinner/protocol";

import { ApproveDesign } from "./ApproveDesign.tsx";
import {
    docSections, docSource, outline, revisionText, type DocSection,
} from "./design-workspace.ts";
import { entryMarks, markTitle, type EntryMark } from "./implement.ts";
import { renderMarkdown } from "./markdown.ts";
import { postDesignAnswer, type Loaded } from "./remote.ts";

import "./markdown.css";

export interface DesignDocProps {
    view: SessionView;
    /** The doc's text, fetched by the agents pane once per reload key (D15). */
    doc: Loaded<string>;
    /** The mission of the last `mission.changed`: the done marks beside the entries (T7). */
    mission: MissionView | undefined;
    onError: (message: string) => void;
}

/** The mark of every entry of the doc (D9): the scan per text, the marks per scan and Plan. */
function useEntryMarks(text: string | undefined, mission: MissionView | undefined) {
    const parsed = useMemo(() => (text === undefined ? null : safeScan(text)), [text]);
    const plan = mission?.plan;
    return useMemo(
        () => (parsed === null || plan === undefined ? EMPTY_MARKS : entryMarks(parsed, plan)),
        [parsed, plan],
    );
}

const EMPTY_MARKS: ReadonlyMap<string, EntryMark> = new Map();

/** The scan throws past its bounds; a draft over them shows without marks. */
function safeScan(text: string) {
    try {
        return scan(text);
    } catch {
        return null;
    }
}

export function DesignDoc({ view, doc, mission, onError }: DesignDocProps) {
    const dir = view.summary.dir;
    const source = view.design === undefined ? null : docSource(view.design);
    const loaded = doc;
    const marks = useEntryMarks(loaded.value, mission);
    if (source === null) {
        return (
            <p className="muted dw-empty">
                No draft yet. Start with <code>draft</code>.
            </p>
        );
    }
    if (loaded.error !== null) {
        return <p className="needs-human dw-error">{loaded.error}</p>;
    }
    if (loaded.value === undefined) {
        return <p className="muted">Loading {source.name}…</p>;
    }
    const changed = source.kind === "doc" && view.design?.changed_after_approval === true;
    return (
        <DocView
            key={source.name}
            dir={dir}
            name={source.name}
            path={source.kind === "doc" ? source.path : null}
            text={loaded.value}
            marks={marks}
            banner={source.kind === "doc" ? <ChangedBanner view={view} changed={changed} /> : null}
            onError={onError}
        />
    );
}

/**
 * Sets `data-entry`, `data-mark` and the title on every `h4` and `h5` under `root` whose text
 * parses as a plan entry. A heading inside a fence renders as `<pre>`, so the walk is
 * fence-safe. Bounded by the headings the doc has, at most `ENTRIES_MAX` entries of it.
 */
export function markHeadings(root: ParentNode, marks: ReadonlyMap<string, EntryMark>): number {
    let marked = 0;
    for (const heading of root.querySelectorAll("h4, h5")) {
        const entry = parse_entry_heading(heading.textContent ?? "");
        if (entry === null) {
            continue;
        }
        const mark = marks.get(entry.id);
        heading.setAttribute("data-entry", entry.id);
        heading.setAttribute("data-mark", mark?.state ?? "none");
        const title = mark === undefined ? null : markTitle(mark);
        if (title === null) {
            heading.removeAttribute("title");
        } else {
            heading.setAttribute("title", title);
        }
        marked += 1;
    }
    return marked;
}

/**
 * "Changed since approval" and the button that opens the approve dialog. The dialog outlives
 * the banner: the `session.updated` of the re-approval clears `changed` while the dialog still
 * shows the seed counts.
 */
function ChangedBanner({ view, changed }: { view: SessionView; changed: boolean }) {
    const [open, setOpen] = useState(false);
    const dialog = open ? <ApproveDesign view={view} onClose={() => setOpen(false)} /> : null;
    return (
        <>
            {changed && (
                <div className="dw-changed-banner" role="status">
                    <span>Changed since approval</span>
                    <button type="button" onClick={() => setOpen(true)}>re-approve design</button>
                </div>
            )}
            {dialog}
        </>
    );
}

function DocView(props: {
    dir: string;
    name: string;
    /** The repo-relative path of the doc; null for the draft. */
    path: string | null;
    text: string;
    marks: ReadonlyMap<string, EntryMark>;
    /** Above the head: the changed-since-approval banner, or null. */
    banner: ReactNode;
    onError: (message: string) => void;
}) {
    const { dir, name, path, text, marks, banner, onError } = props;
    const [raw, setRaw] = useState(false);
    const body = useRef<HTMLDivElement | null>(null);
    // Each section with the index of its heading in the outline, null for the preamble.
    const sections = useMemo(() => {
        let next = 0;
        return docSections(text).map((section) => {
            if (section.heading === null) {
                return { section, index: null };
            }
            next += 1;
            return { section, index: next - 1 };
        });
    }, [text]);
    const headings = useMemo(() => outline(text), [text]);
    // After each render of the parts: the marks survive a doc reload and move on a tick (T7).
    useEffect(() => {
        if (body.current !== null && !raw) {
            markHeadings(body.current, marks);
        }
    }, [marks, sections, raw]);
    const scrollTo = (index: number) => {
        const target = body.current?.querySelector(`[data-heading-index="${index}"]`);
        target?.scrollIntoView({ block: "start", behavior: "smooth" });
    };
    return (
        <div className="dw-doc">
            {banner}
            <div className="dw-doc-head">
                <code className="dw-doc-name" title={path ?? name}>{path ?? name}</code>
                {path === null && <span className="pill pill-warn">draft</span>}
                <button
                    type="button"
                    className="link"
                    aria-pressed={raw}
                    onClick={() => setRaw(!raw)}
                >
                    {raw ? "rendered" : "source"}
                </button>
            </div>
            <div className="dw-split">
                <nav className="dw-outline" aria-label="Outline">
                    {headings.map((heading, index) => (
                        <button
                            key={`${index}:${heading}`}
                            type="button"
                            className="dw-outline-item"
                            title={heading}
                            onClick={() => scrollTo(index)}
                        >
                            {heading}
                        </button>
                    ))}
                </nav>
                <div className="dw-body" ref={body}>
                    {raw ? (
                        <pre className="section-body dw-source">{text}</pre>
                    ) : (
                        <div className="md dw-doc-md">
                            {sections.map(({ section, index }, position) => (
                                <DocPart
                                    key={`${position}:${section.heading ?? ""}`}
                                    dir={dir}
                                    file={name}
                                    section={section}
                                    headingIndex={index}
                                    onError={onError}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

/** One section of the doc, with its `request revision` link when it has a `## ` heading. */
function DocPart(props: {
    dir: string;
    file: string;
    section: DocSection;
    headingIndex: number | null;
    onError: (message: string) => void;
}) {
    const { dir, file, section, headingIndex, onError } = props;
    const html = useMemo(() => renderMarkdown(section.text), [section.text]);
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState("");
    const [posting, setPosting] = useState(false);
    const heading = section.heading;
    const submit = (event: FormEvent) => {
        event.preventDefault();
        const text = draft.trim();
        if (heading === null || text === "") {
            return;
        }
        setPosting(true);
        postDesignAnswer(dir, revisionText(heading, file, text)).then(
            () => {
                setPosting(false);
                setOpen(false);
                setDraft("");
            },
            (failure: unknown) => {
                setPosting(false);
                onError(String(failure));
            },
        );
    };
    return (
        <section
            className="dw-section"
            data-heading-index={headingIndex ?? undefined}
            aria-label={heading ?? "Preamble"}
        >
            {/* The HTML passed through DOMPurify in `renderMarkdown`. */}
            <div className="dw-section-md" dangerouslySetInnerHTML={{ __html: html }} />
            {heading !== null && !open && (
                <button type="button" className="link dw-revise" onClick={() => setOpen(true)}>
                    request revision
                </button>
            )}
            {heading !== null && open && (
                <form className="dw-revision" onSubmit={submit}>
                    <textarea
                        aria-label={`Revision request for ${heading}`}
                        placeholder={`What should change in "${heading}"?`}
                        maxLength={DESIGN_ANSWER_MAX - revisionText(heading, file, "").length}
                        rows={3}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                    />
                    <div className="dw-revision-actions">
                        <button
                            type="submit"
                            className="primary"
                            disabled={posting || draft.trim() === ""}
                        >
                            send
                        </button>
                        <button type="button" onClick={() => setOpen(false)}>
                            cancel
                        </button>
                    </div>
                </form>
            )}
        </section>
    );
}
