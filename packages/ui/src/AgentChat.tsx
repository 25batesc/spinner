import { useEffect, useState, type FormEvent } from "react";

import type {
    AgentMessageRequest, ModelView, ProjectView, SessionView,
} from "@spinner/protocol";

import { fetchAgentHistory, fetchModels, fetchProjects, postAgent } from "./events-client.ts";
import { fetchDefaultBrief } from "./remote.ts";
import type { RunAction } from "./SessionsPane.tsx";
import { emptyTranscript, foldEvent, type Entry, type Transcript } from "./transcript.ts";

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

/** The chat tab's message list; the Goldfish transcript (entry 4.15) shows it read-only. */
export function TranscriptView({ transcript }: { transcript: Transcript }) {
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

/**
 * The agent's past turns from the daemon, loaded once per tab. Live events then add to them.
 * An event that arrives while the request is in flight can show twice; the daemon sends turns
 * as `message_end` records, so this is rare and only cosmetic.
 */
function useHistory(base: string): Transcript {
    const [loaded, setLoaded] = useState<{ base: string; transcript: Transcript } | null>(null);
    useEffect(() => {
        const abort = new AbortController();
        fetchAgentHistory(base, abort.signal).then(
            (events) => {
                if (events !== null) {
                    setLoaded({ base, transcript: events.reduce(foldEvent, emptyTranscript) });
                }
            },
            () => undefined,
        );
        return () => abort.abort();
    }, [base]);
    return loaded?.base === base ? loaded.transcript : emptyTranscript;
}

export interface AgentChatProps {
    view: SessionView;
    agent: string;
    transcript: Transcript | undefined;
}

/** Transcript, cost, and the prompt, steer and abort controls for one agent. */
export function AgentChat({ view, agent, transcript: live = emptyTranscript }: AgentChatProps) {
    const [text, setText] = useState("");
    const [error, setError] = useState<string | null>(null);
    const base = `/sessions/${view.summary.dir}/agents/${agent}`;
    const history = useHistory(base);
    const transcript: Transcript = {
        entries: [...history.entries, ...live.entries],
        cost: history.cost + live.cost,
        running: live.running,
        open: null,
    };
    const running = view.agents_running.includes(agent);

    const send = (action: "prompt" | "steer" | "abort") => {
        // Only the operator's steer is marked, for the daemon's `operator_steers` counter
        // (entry 6.20); a prompt and an abort are not counted.
        let body: AgentMessageRequest | Record<string, never> = {};
        if (action === "steer") {
            body = { text, source: "operator" };
        } else if (action === "prompt") {
            body = { text };
        }
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
            <p className="muted agent-status">
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
                <button type="submit" className="primary" disabled={!running}>
                    {transcript.running ? "steer" : "send"}
                </button>
                <button type="button" disabled={!transcript.running} onClick={() => send("abort")}>
                    abort
                </button>
            </form>
        </>
    );
}

/** A session has somewhere to work once one repo has a worktree; an adopted one may not. */
function hasWorktree(view: SessionView): boolean {
    return Object.values(view.summary.session.repos).some((repo) => repo.worktree !== undefined);
}

/**
 * `attach project` for a session adopted without a project: the daemon checks the PR
 * branches out as worktrees, and the add-agent form's repo select fills in.
 */
function AttachProject({ dir, run }: { dir: string; run: RunAction }) {
    const [projects, setProjects] = useState<ProjectView[]>([]);
    const [project, setProject] = useState("");

    useEffect(() => {
        const abort = new AbortController();
        fetchProjects(abort.signal).then(setProjects, () => undefined);
        return () => abort.abort();
    }, []);

    return (
        <div className="add-agent attach-banner" aria-label="Attach project">
            <span className="muted">No worktree yet: attach the project the PRs belong to.</span>
            <select
                value={project}
                onChange={(e) => setProject(e.target.value)}
                aria-label="Project"
            >
                <option value="">project</option>
                {projects.map((p) => (
                    <option key={p.path} value={p.path}>
                        {p.name}
                    </option>
                ))}
            </select>
            <button
                type="button"
                disabled={project === ""}
                onClick={() => void run(`/sessions/${dir}/attach`, { project })}
            >
                attach project
            </button>
        </div>
    );
}

export interface AddAgentProps {
    view: SessionView;
    run: RunAction;
    /** The agent was added; the pane selects its tab. */
    onDone: (name: string) => void;
    onCancel: () => void;
}

/**
 * The `+` view of the agents pane: starts an agent with a model from `GET /models`. The brief
 * textarea starts with the daemon's default for the name and repo
 * (`GET .../agents/default-brief`) and is sent as `brief` once edited; the daemon writes it
 * when the session has none for that agent.
 */
export function AddAgent({ view, run, onDone, onCancel }: AddAgentProps) {
    const dir = view.summary.dir;
    const repos = Object.keys(view.summary.session.repos);
    const [repo, setRepo] = useState("");
    const [models, setModels] = useState<ModelView[]>([]);
    const [name, setName] = useState("");
    const [model, setModel] = useState("");
    const [brief, setBrief] = useState("");
    const [briefEdited, setBriefEdited] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const abort = new AbortController();
        fetchModels(abort.signal).then(setModels, () => undefined);
        return () => abort.abort();
    }, []);

    useEffect(() => {
        if (briefEdited) {
            return;
        }
        const abort = new AbortController();
        fetchDefaultBrief(dir, name, repo, abort.signal).then(setBrief, () => undefined);
        return () => abort.abort();
    }, [dir, name, repo, briefEdited]);

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const body = {
            name,
            ...(model === "" ? {} : { model }),
            ...(repo === "" ? {} : { repo }),
            ...(briefEdited && brief.trim() !== "" ? { brief } : {}),
        };
        postAgent(`/sessions/${dir}/agents`, body).then(
            () => {
                setError(null);
                onDone(name);
            },
            (failure: unknown) => setError(String(failure)),
        );
    };

    return (
        <>
            {!hasWorktree(view) && <AttachProject dir={dir} run={run} />}
            <form className="add-agent compose-form" onSubmit={submit} aria-label="Add agent">
                <h3>New agent</h3>
                <label className="field">
                    <span className="field-label">Name</span>
                    <input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="Agent name"
                        aria-label="Agent name"
                    />
                </label>
                <span className="field-row">
                    <label className="field">
                        <span className="field-label">Model</span>
                        <select
                            value={model}
                            onChange={(e) => setModel(e.target.value)}
                            aria-label="Model"
                        >
                            <option value="">default model</option>
                            {models.map((m) => (
                                <option
                                    key={`${m.provider}/${m.id}`}
                                    value={`${m.provider}/${m.id}`}
                                >
                                    {m.provider}/{m.id}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field">
                        <span className="field-label">Working directory</span>
                        <select
                            value={repo}
                            onChange={(e) => setRepo(e.target.value)}
                            aria-label="Repo"
                        >
                            <option value="">session dir</option>
                            {repos.map((key) => (
                                <option key={key} value={key}>
                                    worktree: {key}
                                </option>
                            ))}
                        </select>
                    </label>
                </span>
                <label className="field">
                    <span className="field-label">Brief</span>
                    <textarea
                        className="brief"
                        value={brief}
                        onChange={(event) => {
                            setBrief(event.target.value);
                            setBriefEdited(true);
                        }}
                        rows={6}
                        aria-label="Brief"
                        placeholder="Brief (the daemon's default when left as is)"
                    />
                </label>
                <div className="compose-actions">
                    <button type="submit" className="primary" disabled={name.trim() === ""}>
                        add agent
                    </button>
                    <button type="button" onClick={onCancel}>cancel</button>
                </div>
                {error !== null && <span className="needs-human">{error}</span>}
            </form>
        </>
    );
}
