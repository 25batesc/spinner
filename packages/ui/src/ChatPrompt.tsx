// The prompt pi's terminal waits on, as a card on the message box: a damage-control confirm
// (`Allow this once?`), a trust question. Without it the chat showed a turn that looked
// stuck while pi waited in the terminal tab. A confirm is answered from here: `Allow` is
// Enter and `Deny` is Escape, typed into the pty by the daemon only while the prompt waits.
// Another kind of prompt (a select, an input) names the terminal tab.
import { useState } from "react";

import { postAgent } from "./events-client.ts";
import type { PromptWaiting } from "./transcript.ts";

export function ChatPrompt({
    base,
    who,
    prompt,
}: {
    base: string;
    who: string;
    prompt: PromptWaiting;
}) {
    const [posting, setPosting] = useState<"yes" | "no" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const answer = (value: "yes" | "no") => {
        setPosting(value);
        setError(null);
        // Nothing changes here on success: pi's `ui_prompt_end` removes the card.
        postAgent(`${base}/answer`, { answer: value }).then(
            () => setPosting(null),
            (failure: unknown) => {
                setPosting(null);
                setError(String(failure));
            },
        );
    };
    const confirm = prompt.kind === "confirm";
    return (
        <section className="chat-gate chat-prompt" aria-label={`${who} waits in the terminal`}>
            <header className="chat-gate-head">
                <div className="chat-gate-question">
                    <span className="chat-gate-label">{who} waits in the terminal</span>
                    <div className="chat-prompt-title">{prompt.title}</div>
                    {!confirm && (
                        <div className="muted">
                            This {prompt.kind} prompt is answered in the terminal tab.
                        </div>
                    )}
                </div>
            </header>
            {confirm && (
                <ol className="chat-gate-options">
                    <li>
                        <button
                            type="button"
                            className="chat-gate-option"
                            disabled={posting !== null}
                            data-posting={posting === "yes"}
                            onClick={() => answer("yes")}
                        >
                            <span className="chat-gate-number">1</span>
                            <span className="chat-gate-text">
                                <span className="chat-gate-title">Allow this once</span>
                            </span>
                        </button>
                    </li>
                    <li>
                        <button
                            type="button"
                            className="chat-gate-option"
                            disabled={posting !== null}
                            data-posting={posting === "no"}
                            onClick={() => answer("no")}
                        >
                            <span className="chat-gate-number">2</span>
                            <span className="chat-gate-text">
                                <span className="chat-gate-title">Deny</span>
                                <span className="chat-gate-detail">
                                    {who} is told you declined and goes on without it.
                                </span>
                            </span>
                        </button>
                    </li>
                </ol>
            )}
            {error !== null && <p className="needs-human chat-error">{error}</p>}
        </section>
    );
}
