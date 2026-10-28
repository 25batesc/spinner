import { useEffect, useState, type FormEvent } from "react";

import type { ModelView, SessionView } from "@spinner/protocol";

import { fetchModels, postAgent } from "./events-client.ts";
import { emptyTranscript, type Entry, type Transcript } from "./transcript.ts";

function short(value: unknown): string {
    const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function EntryView({ entry }: { entry: Entry }) {
    switch (entry.kind) {
        case "user":
            return <li className="entry entry-user">{entry.text}</li>;
        case "assistant":
            return (
                <li className="entry entry-assistant">
                    {entry.thinking !== "" && <em className="muted">{entry.thinking}</em>}
                    <div>{entry.text}</div>
                </li>
            );
        case "tool":
            return (
                <li className={`entry entry-tool tool-${entry.state}`}>
                    <code>{entry.name}</code> <span className="muted">{short(entry.args)}</span>
                    <span className="badge">{entry.state}</span>
                    {entry.result !== undefined && <pre>{short(entry.result)}</pre>}
                </li>
            );
        case "note":
            return <li className="entry muted">{entry.text}</li>;
    }
}

function TranscriptView({ transcript }: { transcript: Transcript }) {
    if (transcript.entries.length === 0) {
        return <p className="muted">No messages yet.</p>;
    }
    return (
        <ol className="transcript">
            {transcript.entries.map((entry, index) => (
                <EntryView key={index} entry={entry} />
            ))}
        </ol>
    );
}

export interface AgentChatProps {
    view: SessionView;
    agent: string;
    transcript: Transcript | undefined;
}

/** Transcript, cost, and the prompt, steer and abort controls for one agent. */
export function AgentChat({ view, agent, transcript = emptyTranscript }: AgentChatProps) {
    const [text, setText] = useState("");
    const [error, setError] = useState<string | null>(null);
    const base = `/sessions/${view.summary.dir}/agents/${agent}`;
    const running = view.agents_running.includes(agent);

    const send = (action: "prompt" | "steer" | "abort") => {
        const body = action === "abort" ? {} : { text };
        postAgent(`${base}/${action}`, body).then(
            () => {
                setError(null);
                if (action !== "abort") {
                    setText("");
                }
            },
            (failure: unknown) => setError(String(failure)),
        );
    };
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (text.trim() !== "") {
            send(transcript.running ? "steer" : "prompt");
        }
    };

    return (
        <>
            <p className="muted">
                {running ? (transcript.running ? "working" : "idle") : "not running"} · cost $
                {transcript.cost.toFixed(4)}
            </p>
            <TranscriptView transcript={transcript} />
            {error !== null && <p className="needs-human">{error}</p>}
            <form className="prompt-form" onSubmit={submit}>
                <input
                    className="prompt"
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    disabled={!running}
                    placeholder={transcript.running ? "Steer the agent" : "Prompt"}
                    aria-label="Prompt"
                />
                <button type="submit" disabled={!running}>
                    {transcript.running ? "steer" : "send"}
                </button>
                <button type="button" disabled={!transcript.running} onClick={() => send("abort")}>
                    abort
                </button>
            </form>
        </>
    );
}

/** Starts an agent from `agents/<name>/BRIEF.md`, with a model from `GET /models`. */
export function AddAgent({ dir }: { dir: string }) {
    const [models, setModels] = useState<ModelView[]>([]);
    const [name, setName] = useState("");
    const [model, setModel] = useState("");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const abort = new AbortController();
        fetchModels(abort.signal).then(setModels, () => undefined);
        return () => abort.abort();
    }, []);

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const body = model === "" ? { name } : { name, model };
        postAgent(`/sessions/${dir}/agents`, body).then(
            () => {
                setName("");
                setError(null);
            },
            (failure: unknown) => setError(String(failure)),
        );
    };

    return (
        <form className="add-agent" onSubmit={submit} aria-label="Add agent">
            <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Agent name (needs a brief)"
                aria-label="Agent name"
            />
            <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
                <option value="">default model</option>
                {models.map((m) => (
                    <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                        {m.provider}/{m.id}
                    </option>
                ))}
            </select>
            <button type="submit" disabled={name.trim() === ""}>add agent</button>
            {error !== null && <span className="needs-human">{error}</span>}
        </form>
    );
}
