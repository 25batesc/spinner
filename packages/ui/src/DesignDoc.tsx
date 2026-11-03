// The Design tab of the design workspace (docs/designs/egm-adoption.md, entry 5.8): the doc
// once the lead named it with `design_doc`, else `design_draft.md`. A left outline lists the
// `## ` headings; a click scrolls to the section. Under each section, `request revision` opens
// a text box whose `send` answers the lead through `POST …/design/answer`. `source` shows the
// raw text. The doc renders section by section with the mission's markdown renderer.
import { useMemo, useRef, useState, type FormEvent } from "react";

import { DESIGN_ANSWER_MAX, type SessionView } from "@spinner/protocol";

import {
    docSections, docSource, outline, revisionText, type DocSection,
} from "./design-workspace.ts";
import { renderMarkdown } from "./markdown.ts";
import { fetchDesignDoc, fetchDesignFile, postDesignAnswer, useLoaded } from "./remote.ts";

import "./markdown.css";

export interface DesignDocProps {
    view: SessionView;
    /** The workspace's reload key (entry 5.6). */
    reload: string;
    onError: (message: string) => void;
}

export function DesignDoc({ view, reload, onError }: DesignDocProps) {
    const dir = view.summary.dir;
    const source = view.design === undefined ? null : docSource(view.design);
    const loaded = useLoaded(`${reload}#doc#${source?.kind ?? "none"}`, (signal) => {
        if (source === null) {
            return Promise.resolve("");
        }
        return source.kind === "doc"
            ? fetchDesignDoc(dir, signal)
            : fetchDesignFile(dir, source.name, signal);
    });
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
    return (
        <DocView
            key={source.name}
            dir={dir}
            name={source.name}
            path={source.kind === "doc" ? source.path : null}
            text={loaded.value}
            onError={onError}
        />
    );
}

function DocView(props: {
    dir: string;
    name: string;
    /** The repo-relative path of the doc; null for the draft. */
    path: string | null;
    text: string;
    onError: (message: string) => void;
}) {
    const { dir, name, path, text, onError } = props;
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
    const scrollTo = (index: number) => {
        const target = body.current?.querySelector(`[data-heading-index="${index}"]`);
        target?.scrollIntoView({ block: "start", behavior: "smooth" });
    };
    return (
        <div className="dw-doc">
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
