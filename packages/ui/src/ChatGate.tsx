// The lead's question, on the message box of its chat (the operator's requests of
// 2026-11-13: the card above the agents was large and stood in the way; then a reference
// for the shape). A card of the box's width sits right above it: the question, one numbered
// row per option, a `Something else` row, `Skip`. An option is `POST …/design/answer`; a
// message typed in the box answers the gate too, because a prompt to the lead clears it. The
// resolve gate of an EGM review shows the same way, with its three replies.
import { useMemo, useState, type FormEvent } from "react";

import { RESOLVE_ANSWERS, type SessionView } from "@spinner/protocol";

import { gateCard } from "./design.ts";
import { renderChatMarkdown } from "./markdown.ts";
import { postDesignAnswer } from "./remote.ts";
import { needsHuman } from "./state.ts";

/** What the lead waits for, as the chat shows it; null when it asks nothing. */
export interface ChatQuestion {
    /** The gate's `asked` time, or `resolve`: a new question is a new block. */
    key: string;
    label: string;
    /** Markdown; empty for the resolve gate. */
    question: string;
    options: string[];
}

/** The lead's open question of this session, or null. */
export function chatQuestion(view: SessionView): ChatQuestion | null {
    const design = view.design;
    const card = gateCard(design, needsHuman(view));
    if (card === "gate" && design?.gate != null) {
        const gate = design.gate;
        return {
            key: gate.asked,
            label: "lead asks",
            question: gate.question,
            options: gate.options,
        };
    }
    if (card === "resolve") {
        return {
            key: "resolve",
            label: "review findings to resolve",
            question: "",
            options: [...RESOLVE_ANSWERS],
        };
    }
    return null;
}

/** An option as the card shows it: a short title and the rest as its detail. */
export interface OptionParts {
    title: string;
    detail: string;
}

/** A title longer than this is not a title: the whole option then reads as one line. */
export const OPTION_TITLE_MAX = 70;

/**
 * Splits an option into a title and a detail, as the card draws them. A marker the lead
 * wrote (`(a)`, `b)`, `1.`) goes: the card numbers the rows itself. The title ends at the
 * first `: `, ` - `, ` — ` or `. ` within `OPTION_TITLE_MAX` characters; without one the
 * whole text is the title.
 */
export function optionParts(text: string): OptionParts {
    const plain = text.trim().replace(/^(?:\(?[a-zA-Z0-9]{1,2}[).]|[-*•])\s+/, "");
    const cut = /^(.{2,}?)(?::\s+|\s+[-–—]\s+|\.\s+)(\S[\s\S]*)$/.exec(plain);
    const title = cut?.[1];
    if (title === undefined || title.length > OPTION_TITLE_MAX) {
        return { title: plain, detail: "" };
    }
    return { title, detail: (cut?.[2] ?? "").trim() };
}

/** What `Skip` answers: the lead decides, as the fast path asks of it. */
export const SKIP_ANSWER =
    "Skipped. Take the option you recommend, log it as an assumption, and continue.";

/**
 * The lead's question as a card on the message box (the operator's reference, 2026-11-13):
 * the question, one numbered row per option with its detail, a `Something else` row to type
 * another answer, `Skip`, and a cross that folds the card to one line.
 */
export function ChatGate({ dir, asked }: { dir: string; asked: ChatQuestion }) {
    const [posting, setPosting] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [other, setOther] = useState("");
    const [folded, setFolded] = useState(false);
    const html = useMemo(() => renderChatMarkdown(asked.question), [asked.question]);
    const answer = (text: string) => {
        setPosting(text);
        setError(null);
        // Nothing changes here on success: the daemon clears the gate and the next
        // `session.updated` removes the card.
        postDesignAnswer(dir, text).then(
            () => setPosting(null),
            (failure: unknown) => {
                setPosting(null);
                setError(String(failure));
            },
        );
    };
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (other.trim() !== "") {
            answer(other.trim());
        }
    };
    if (folded) {
        return (
            <button
                type="button"
                className="chat-gate chat-gate-folded"
                aria-label="Show the lead's question"
                onClick={() => setFolded(false)}
            >
                <span className="chat-gate-label">{asked.label}</span>
                <span className="chat-gate-folded-text">
                    {asked.question.replace(/[*`#]/g, "").replace(/\s+/g, " ").trim()}
                </span>
                <span className="muted">show</span>
            </button>
        );
    }
    return (
        <section className="chat-gate" aria-label="The lead's question">
            <header className="chat-gate-head">
                {asked.question === "" ? (
                    <div className="chat-gate-question">{asked.label}</div>
                ) : (
                    // The HTML passed through DOMPurify in `renderChatMarkdown`.
                    <div
                        className="md chat-answer chat-gate-question"
                        dangerouslySetInnerHTML={{ __html: html }}
                    />
                )}
                <button
                    type="button"
                    className="chat-icon chat-gate-close"
                    aria-label="Fold the question"
                    title="Fold the question; it stays open"
                    onClick={() => setFolded(true)}
                >
                    ×
                </button>
            </header>
            <ol className="chat-gate-options">
                {asked.options.map((option, index) => {
                    const parts = optionParts(option);
                    return (
                        <li key={option}>
                            <button
                                type="button"
                                className="chat-gate-option"
                                disabled={posting !== null}
                                data-posting={posting === option}
                                onClick={() => answer(option)}
                            >
                                <span className="chat-gate-number">{index + 1}</span>
                                <span className="chat-gate-text">
                                    <span className="chat-gate-title">{parts.title}</span>
                                    {parts.detail !== "" && (
                                        <span className="chat-gate-detail">{parts.detail}</span>
                                    )}
                                </span>
                            </button>
                        </li>
                    );
                })}
            </ol>
            <form className="chat-gate-other" onSubmit={submit}>
                <span className="chat-gate-number" aria-hidden="true">✎</span>
                <input
                    value={other}
                    onChange={(event) => setOther(event.target.value)}
                    placeholder="Something else"
                    aria-label="Another answer"
                    disabled={posting !== null}
                />
                <button
                    type="button"
                    className="chat-gate-skip"
                    disabled={posting !== null}
                    title="Let the lead decide and log its assumption"
                    onClick={() => answer(SKIP_ANSWER)}
                >
                    Skip
                </button>
            </form>
            {error !== null && <p className="needs-human chat-error">{error}</p>}
        </section>
    );
}
