// The lead's gates as cards (docs/designs/egm-adoption.md, entry 3.21, Technical Plan T8). The
// gate card shows the question the lead asked through `ask_question`, one button per option
// and an "other answer" box. The resolve card answers `egm-resolve` Step 4 with one of its
// three replies. Every answer is `POST …/design/answer`; nothing changes here on success,
// because the daemon clears the gate and the next `session.updated` removes the card.
import { useMemo, useState, type FormEvent } from "react";

import { DESIGN_ANSWER_MAX, RESOLVE_ANSWERS, type DesignGate as Gate } from "@spinner/protocol";

import { renderMarkdown } from "./markdown.ts";
import { postDesignAnswer } from "./remote.ts";

import "./markdown.css";

export type DesignGateProps =
    | { kind: "gate"; dir: string; gate: Gate; onError: (message: string) => void }
    | { kind: "resolve"; dir: string; onError: (message: string) => void };

/** The resolve card's buttons, in the order and the words of `RESOLVE_ANSWERS`. */
const RESOLVE_LABELS: Record<(typeof RESOLVE_ANSWERS)[number], string> = {
    "Auto accept": "auto accept",
    Continue: "continue",
    "Interactive breakdown": "interactive breakdown",
};

export function DesignGate(props: DesignGateProps) {
    const { dir, onError } = props;
    const [posting, setPosting] = useState(false);
    const [other, setOther] = useState("");
    const question = props.kind === "gate" ? props.gate.question : "";
    const html = useMemo(() => renderMarkdown(question), [question]);
    const answer = (text: string) => {
        setPosting(true);
        postDesignAnswer(dir, text).then(
            () => setPosting(false),
            (failure: unknown) => {
                setPosting(false);
                onError(String(failure));
            },
        );
    };
    const submit = (event: FormEvent) => {
        event.preventDefault();
        const text = other.trim();
        if (text !== "") {
            answer(text);
        }
    };
    const options: { text: string; label: string }[] = props.kind === "gate"
        ? props.gate.options.map((text) => ({ text, label: text }))
        : RESOLVE_ANSWERS.map((text) => ({ text, label: RESOLVE_LABELS[text] }));
    const title = props.kind === "gate" ? "The lead asks" : "Resolve the review findings";
    return (
        <section
            className="design-gate"
            data-kind={props.kind}
            aria-label={props.kind === "gate" ? "Gate" : "Resolve"}
        >
            <h3 className="design-gate-title">{title}</h3>
            {props.kind === "gate" && (
                // The HTML passed through DOMPurify in `renderMarkdown`.
                <div
                    className="md design-gate-question"
                    dangerouslySetInnerHTML={{ __html: html }}
                />
            )}
            {/* EGM's gates list options without a ranking [D9], so no option is primary. */}
            <div className="design-gate-options">
                {options.map((option) => (
                    <button
                        key={option.text}
                        type="button"
                        disabled={posting}
                        title={option.text}
                        onClick={() => answer(option.text)}
                    >
                        {option.label}
                    </button>
                ))}
            </div>
            <form className="design-gate-other" onSubmit={submit}>
                <input
                    aria-label="Other answer"
                    placeholder="other answer"
                    maxLength={DESIGN_ANSWER_MAX}
                    value={other}
                    onChange={(event) => setOther(event.target.value)}
                />
                <button type="submit" disabled={posting || other.trim() === ""}>
                    send
                </button>
            </form>
        </section>
    );
}
