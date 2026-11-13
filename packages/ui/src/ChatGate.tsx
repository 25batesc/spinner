// The lead's question, inside its chat (the operator's request of 2026-11-13: the card above
// the agents was large and stood in the way). It reads as part of the conversation: the
// question as the agent's prose, one quiet button per option, and the message box below for
// any other answer. An option is `POST …/design/answer`; a message typed in the box answers
// the gate too, because a prompt to the lead clears it. The resolve gate of an EGM review
// shows the same way, with its three replies.
import { useMemo, useState } from "react";

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

export function ChatGate({ dir, asked }: { dir: string; asked: ChatQuestion }) {
    const [posting, setPosting] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const html = useMemo(() => renderChatMarkdown(asked.question), [asked.question]);
    const answer = (text: string) => {
        setPosting(text);
        setError(null);
        // Nothing changes here on success: the daemon clears the gate and the next
        // `session.updated` removes the block.
        postDesignAnswer(dir, text).then(
            () => setPosting(null),
            (failure: unknown) => {
                setPosting(null);
                setError(String(failure));
            },
        );
    };
    return (
        <section className="chat-gate" aria-label="The lead's question">
            <span className="chat-gate-label">{asked.label}</span>
            {asked.question !== "" && (
                // The HTML passed through DOMPurify in `renderChatMarkdown`.
                <div className="md chat-answer" dangerouslySetInnerHTML={{ __html: html }} />
            )}
            <div className="chat-gate-options">
                {asked.options.map((option) => (
                    <button
                        key={option}
                        type="button"
                        className="chat-gate-option"
                        disabled={posting !== null}
                        data-posting={posting === option}
                        onClick={() => answer(option)}
                    >
                        {option}
                    </button>
                ))}
            </div>
            <span className="muted chat-gate-hint">
                Pick one, or type another answer in the box below.
            </span>
            {error !== null && <p className="needs-human chat-error">{error}</p>}
        </section>
    );
}
