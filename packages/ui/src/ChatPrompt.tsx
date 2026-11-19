// The question pi waits on, as a card on the message box: a damage-control confirm (`Allow
// this once?`), a select, an input. An extension inside pi asked it through `ctx.ui`, and pi
// blocks until the answer; without the card the turn would look stuck. The daemon holds the
// prompt (`ui_prompt_start`) and `POST …/answer` writes pi's response. The card goes when
// the daemon reports the prompt's end.
import { type FormEvent, useState } from "react";
import type { AgentAnswer, AgentPrompt } from "@spinner/protocol";

import { postAgent } from "./events-client.ts";

export function ChatPrompt({
    base,
    who,
    prompt,
}: {
    base: string;
    who: string;
    prompt: AgentPrompt;
}) {
    const [posting, setPosting] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [typed, setTyped] = useState(prompt.prefill ?? "");
    const answer = (label: string, body: AgentAnswer) => {
        setPosting(label);
        setError(null);
        // Nothing changes here on success: the prompt's end removes the card.
        postAgent(`${base}/answer`, { id: prompt.id, ...body }).then(
            () => setPosting(null),
            (failure: unknown) => {
                setPosting(null);
                setError(String(failure));
            },
        );
    };
    const submit = (event: FormEvent) => {
        event.preventDefault();
        answer("value", { kind: "value", value: typed });
    };
    const choices = promptChoices(prompt);
    const types = prompt.kind === "input" || prompt.kind === "editor";
    return (
        <section className="chat-gate chat-prompt" aria-label={`${who} waits for your answer`}>
            <header className="chat-gate-head">
                <div className="chat-gate-question">
                    <span className="chat-gate-label">{who} waits for your answer</span>
                    <div className="chat-prompt-title">{prompt.title}</div>
                    {prompt.message !== undefined && (
                        <div className="chat-prompt-title muted">{prompt.message}</div>
                    )}
                </div>
            </header>
            <ol className="chat-gate-options">
                {choices.map((choice, index) => (
                    <li key={choice.label}>
                        <button
                            type="button"
                            className="chat-gate-option"
                            disabled={posting !== null}
                            data-posting={posting === choice.label}
                            onClick={() => answer(choice.label, choice.answer)}
                        >
                            <span className="chat-gate-number">{index + 1}</span>
                            <span className="chat-gate-text">
                                <span className="chat-gate-title">{choice.label}</span>
                            </span>
                        </button>
                    </li>
                ))}
            </ol>
            {types && (
                <form className="chat-gate-other" onSubmit={submit}>
                    <span className="chat-gate-number" aria-hidden="true">✎</span>
                    {prompt.kind === "editor" ? (
                        <textarea
                            value={typed}
                            rows={4}
                            aria-label={prompt.title}
                            onChange={(event) => setTyped(event.target.value)}
                        />
                    ) : (
                        <input
                            value={typed}
                            placeholder={prompt.placeholder ?? ""}
                            aria-label={prompt.title}
                            onChange={(event) => setTyped(event.target.value)}
                        />
                    )}
                    <button type="submit" className="chat-gate-skip" disabled={posting !== null}>
                        Send
                    </button>
                </form>
            )}
            {error !== null && <p className="needs-human chat-error">{error}</p>}
        </section>
    );
}

interface Choice {
    label: string;
    answer: AgentAnswer;
}

/**
 * The buttons of a prompt: Allow and Deny for a confirm, one per option and Cancel for a
 * select, and Cancel alone for a prompt the operator types into.
 */
export function promptChoices(prompt: AgentPrompt): Choice[] {
    if (prompt.kind === "confirm") {
        return [
            { label: "Allow", answer: { kind: "confirm", confirmed: true } },
            { label: "Deny", answer: { kind: "confirm", confirmed: false } },
        ];
    }
    const cancel: Choice = { label: "Cancel", answer: { kind: "cancel" } };
    if (prompt.kind === "select") {
        const options = (prompt.options ?? []).map(
            (option): Choice => ({ label: option, answer: { kind: "value", value: option } }),
        );
        return [...options, cancel];
    }
    return [cancel];
}
