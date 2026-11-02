// A rendered markdown block with a `raw` toggle, for a file or a section that people and
// agents write by hand: the Context tab's files and the mission's source view.
import { useMemo, useState } from "react";

import { renderMarkdown } from "./markdown.ts";

import "./markdown.css";

export interface MarkdownProps {
    text: string;
    /** The accessible name of the toggle, for example the file's path. */
    label: string;
}

export function Markdown({ text, label }: MarkdownProps) {
    const [raw, setRaw] = useState(false);
    const html = useMemo(() => (raw ? "" : renderMarkdown(text)), [raw, text]);
    return (
        <div className="md-block">
            <div className="md-toolbar">
                <button
                    type="button"
                    className="link"
                    aria-pressed={raw}
                    aria-label={`${raw ? "Render" : "Raw"} ${label}`}
                    onClick={() => setRaw(!raw)}
                >
                    {raw ? "rendered" : "raw"}
                </button>
            </div>
            {raw ? (
                <pre className="section-body">{text}</pre>
            ) : (
                // The HTML passed through DOMPurify in `renderMarkdown`.
                <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
            )}
        </div>
    );
}
