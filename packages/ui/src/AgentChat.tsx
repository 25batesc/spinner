import {
    memo,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ClipboardEvent,
    type DragEvent,
    type FormEvent,
    type KeyboardEvent,
} from "react";

import type {
    AgentMessageRequest, ModelView, ProjectView, SessionView,
} from "@spinner/protocol";

import {
    CHAT_SHOWN_START,
    CHAT_SHOWN_STEP,
    TOOL_RESULT_SHOWN,
    boxRows,
    imagesLabel,
    messageWithImages,
    sendsOnKey,
    toolSummary,
    toolText,
    windowed,
} from "./chat.ts";
import { fetchAgentHistory, fetchModels, fetchProjects, postAgent } from "./events-client.ts";
import { renderChatMarkdown } from "./markdown.ts";
import { fetchDefaultBrief, postAttachment } from "./remote.ts";
import type { RunAction } from "./SessionsPane.tsx";
import {
    emptyTranscript,
    foldHistory,
    mergeTranscripts,
    type Entry,
    type Transcript,
} from "./transcript.ts";

/** An image attached to the message being written: its name and where the session holds it. */
interface Attached {
    name: string;
    /** Absolute path of the saved PNG, which the agent reads. */
    path: string;
}

/** The agent's thinking, folded to one line; a click opens it (5.2). */
function Thinking({ text }: { text: string }) {
    const [open, setOpen] = useState(false);
    const first = text.trim().split("\n")[0] ?? "";
    return (
        <button
            type="button"
            className="chat-thinking"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            title={open ? "Fold the thinking" : "Show the thinking"}
        >
            <span className="chat-fold">{open ? "▾" : "▸"}</span>
            {open ? <span className="chat-thinking-text">{text.trim()}</span> : (
                <span className="chat-thinking-line">thinking: {first}</span>
            )}
        </button>
    );
}

/** The agent's answer as markdown. Memoized: only the message that streams renders again. */
const Answer = memo(function Answer({ text }: { text: string }) {
    const html = useMemo(() => renderChatMarkdown(text), [text]);
    // The HTML passed through DOMPurify in `renderChatMarkdown`.
    return <div className="md chat-answer" dangerouslySetInnerHTML={{ __html: html }} />;
});

type ToolEntry = Extract<Entry, { kind: "tool" }>;

/** One tool call: a state mark, the name, what it acts on; a click opens it (5.2). */
function ToolRow({ entry }: { entry: ToolEntry }) {
    const [open, setOpen] = useState(false);
    const [whole, setWhole] = useState(false);
    const result = toolText(entry.result);
    const cut = !whole && result.length > TOOL_RESULT_SHOWN;
    return (
        <li className="chat-tool" data-state={entry.state}>
            <button
                type="button"
                className="chat-tool-head"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                <span className="chat-tool-mark" aria-label={entry.state} />
                <code className="chat-tool-name">{entry.name}</code>
                <span className="chat-tool-summary">{toolSummary(entry)}</span>
            </button>
            {open && (
                <div className="chat-tool-body">
                    <pre className="chat-tool-args">{toolText(entry.args)}</pre>
                    {result !== "" && (
                        <pre className="chat-tool-result">
                            {cut ? `${result.slice(0, TOOL_RESULT_SHOWN)}…` : result}
                        </pre>
                    )}
                    {cut && (
                        <button type="button" className="link" onClick={() => setWhole(true)}>
                            show all ({result.length} characters)
                        </button>
                    )}
                    {entry.state === "running" && <span className="muted">running…</span>}
                </div>
            )}
        </li>
    );
}

function EntryView({ entry }: { entry: Entry }) {
    switch (entry.kind) {
        case "user":
            return (
                <li className="chat-user">
                    <div className="chat-user-text">{entry.text}</div>
                    {entry.images !== undefined && (
                        <span className="muted chat-user-images">{imagesLabel(entry.images)}</span>
                    )}
                </li>
            );
        case "assistant":
            return (
                <li className="chat-assistant">
                    {entry.thinking.trim() !== "" && <Thinking text={entry.thinking} />}
                    {entry.text !== "" && <Answer text={entry.text} />}
                    {entry.error !== undefined && (
                        <div className="needs-human chat-error">ended: {entry.error}</div>
                    )}
                </li>
            );
        case "tool":
            return <ToolRow entry={entry} />;
        case "note":
            return <li className="chat-note muted">{entry.text}</li>;
    }
}

/**
 * The message list: the newest entries, and `show earlier` for the rest (5.2). The Goldfish
 * transcript (entry 4.15) shows it read-only.
 */
export function TranscriptView({ transcript }: { transcript: Transcript }) {
    const [shown, setShown] = useState(CHAT_SHOWN_START);
    if (transcript.entries.length === 0) {
        return <p className="muted">No messages yet.</p>;
    }
    const { entries, earlier } = windowed(transcript.entries, shown);
    return (
        <ol className="chat-list">
            {earlier > 0 && (
                <li className="chat-earlier">
                    <button
                        type="button"
                        className="link"
                        onClick={() => setShown(shown + CHAT_SHOWN_STEP)}
                    >
                        show earlier ({earlier})
                    </button>
                </li>
            )}
            {entries.map((entry, index) => (
                // The key counts from the oldest entry, so a row keeps its state (an opened
                // tool call) when a new entry arrives or `show earlier` adds rows above it.
                <EntryView key={earlier + index} entry={entry} />
            ))}
        </ol>
    );
}

/**
 * The agent's past turns from the daemon, loaded when the tab opens and again when the agent
 * is resumed. Live events then add to them; `mergeTranscripts` shows each message once.
 */
function useHistory(base: string, revision: string): Transcript {
    const [loaded, setLoaded] = useState<{ base: string; transcript: Transcript } | null>(null);
    useEffect(() => {
        const abort = new AbortController();
        fetchAgentHistory(base, abort.signal).then(
            (events) => {
                if (events !== null) {
                    setLoaded({ base, transcript: foldHistory(events) });
                }
            },
            () => undefined,
        );
        return () => abort.abort();
    }, [base, revision]);
    return loaded?.base === base ? loaded.transcript : emptyTranscript;
}

/** How near the bottom, in pixels, still counts as "at the newest message". */
const STICK_PX = 48;

/** An image file as PNG bytes in base64, converted in the browser when it is another format. */
async function pngBase64(file: Blob): Promise<string> {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    const url = canvas.toDataURL("image/png");
    return url.slice(url.indexOf(",") + 1);
}

export interface AgentChatProps {
    view: SessionView;
    agent: string;
    transcript: Transcript | undefined;
}

/** The chat of one agent (docs/designs/talk-change-ship.md, 5.1 to 5.5). */
export function AgentChat({ view, agent, transcript: live = emptyTranscript }: AgentChatProps) {
    const [text, setText] = useState("");
    const [attached, setAttached] = useState<Attached[]>([]);
    const [uploading, setUploading] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [away, setAway] = useState(false);
    const scroller = useRef<HTMLDivElement>(null);
    const dir = view.summary.dir;
    const base = `/sessions/${dir}/agents/${agent}`;
    const hosted = view.agents_running.includes(agent);
    const working = hosted && view.summary.session.agents[agent]?.process === "running";
    // The history is read again when the agent is resumed (it may have compacted) and at
    // the start and the end of each turn: a live event that was lost on the way (a daemon
    // restart, a socket that reconnected) then shows with the turn's end at the latest.
    const phase = `${hosted ? "hosted" : "stopped"}/${working ? "turn" : "idle"}`;
    const history = useHistory(base, phase);
    const transcript = useMemo(() => mergeTranscripts(history, live), [history, live]);

    // Stay at the newest message while the operator is there; leave him where he scrolled.
    const count = transcript.entries.length;
    const last = transcript.entries[count - 1];
    const tail = last?.kind === "assistant" ? last.text.length + last.thinking.length : 0;
    useLayoutEffect(() => {
        const node = scroller.current;
        if (node !== null && !away) {
            node.scrollTop = node.scrollHeight;
        }
    }, [count, tail, away, base]);
    const onScroll = () => {
        const node = scroller.current;
        if (node !== null) {
            setAway(node.scrollHeight - node.scrollTop - node.clientHeight > STICK_PX);
        }
    };

    const post = (action: "prompt" | "steer" | "abort", message: string) => {
        // The UI's message box marks its messages: the daemon resumes a stopped agent for
        // them and counts a steer to the lead (entry 6.20).
        const body: AgentMessageRequest | Record<string, never> =
            action === "abort" ? {} : { text: message, source: "operator" };
        return postAgent(`${base}/${action}`, body).then(
            () => setError(null),
            (failure: unknown) => setError(String(failure)),
        );
    };
    const send = () => {
        const message = messageWithImages(text, attached.map((image) => image.path));
        if (message === "" || uploading > 0) {
            return;
        }
        setText("");
        setAttached([]);
        setAway(false);
        void post(working ? "steer" : "prompt", message);
    };
    const attach = (files: readonly File[]) => {
        const images = files.filter((file) => file.type.startsWith("image/"));
        for (const file of images) {
            setUploading((old) => old + 1);
            pngBase64(file)
                .then((png) => postAttachment(dir, png))
                .then(
                    (saved) => {
                        const path = `${view.summary.path}/${saved.path}`;
                        setAttached((old) => [...old, { name: saved.name, path }]);
                        setError(null);
                    },
                    (failure: unknown) =>
                        setError(`The image was not attached: ${String(failure)}`),
                )
                .finally(() => setUploading((old) => old - 1));
        }
        // In the desktop app a file that is not an image adds its path to the text.
        const pathOf = window.spinnerDesktop?.files?.pathOf;
        const others = files.filter((file) => !file.type.startsWith("image/"));
        if (pathOf !== undefined && others.length > 0) {
            const paths = others.map((file) => pathOf(file)).filter((path) => path.length > 0);
            const gap = (old: string) => (old === "" || old.endsWith(" ") ? "" : " ");
            setText((old) => `${old}${gap(old)}${paths.join(" ")}`);
        }
    };
    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        const { key, shiftKey } = event;
        if (sendsOnKey({ key, shiftKey, isComposing: event.nativeEvent.isComposing })) {
            event.preventDefault();
            send();
        }
    };
    const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
        const files = [...event.clipboardData.files];
        if (files.some((file) => file.type.startsWith("image/"))) {
            // An image on the clipboard is attached; its text form (a file name) is not typed.
            event.preventDefault();
            attach(files);
        }
    };
    const onDrop = (event: DragEvent<HTMLFormElement>) => {
        if (event.dataTransfer.files.length > 0) {
            event.preventDefault();
            attach([...event.dataTransfer.files]);
        }
    };

    let status = "stopped: a message resumes it";
    if (hosted) {
        status = working ? "working" : "idle";
    }
    let placeholder = `Message ${agent}`;
    if (working) {
        placeholder = `Steer ${agent}: your message interrupts its turn`;
    } else if (!hosted) {
        placeholder = `Message ${agent} (it is stopped; your message resumes it)`;
    }
    return (
        <div className="agent-chat" data-working={working}>
            <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
                <TranscriptView transcript={transcript} />
                {working && (
                    <div className="chat-working" role="status">
                        <span className="dot session-working" aria-hidden="true" />
                        <span>{agent} is working</span>
                        <button type="button" onClick={() => void post("abort", "")}>stop</button>
                    </div>
                )}
            </div>
            {away && (
                <button type="button" className="chat-jump" onClick={() => setAway(false)}>
                    jump to latest ↓
                </button>
            )}
            {error !== null && <p className="needs-human chat-error">{error}</p>}
            <form
                className="chat-box"
                onSubmit={(event: FormEvent) => {
                    event.preventDefault();
                    send();
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={onDrop}
            >
                {(attached.length > 0 || uploading > 0) && (
                    <div className="chat-attached">
                        {attached.map((image) => (
                            <span key={image.path} className="badge chat-chip" title={image.path}>
                                {image.name}
                                <button
                                    type="button"
                                    aria-label={`Remove ${image.name}`}
                                    onClick={() =>
                                        setAttached((old) => old.filter((entry) => entry !== image))
                                    }
                                >
                                    ×
                                </button>
                            </span>
                        ))}
                        {uploading > 0 && <span className="muted">attaching…</span>}
                    </div>
                )}
                <div className="chat-box-row">
                    <textarea
                        className="chat-input"
                        value={text}
                        rows={boxRows(text)}
                        onChange={(event) => setText(event.target.value)}
                        onKeyDown={onKeyDown}
                        onPaste={onPaste}
                        placeholder={placeholder}
                        aria-label="Message"
                    />
                    <button type="submit" className="primary" disabled={uploading > 0}>
                        {working ? "steer" : "send"}
                    </button>
                </div>
                <div className="muted chat-foot">
                    <span>{status} · ${transcript.cost.toFixed(2)}</span>
                    <span>Enter sends · Shift+Enter makes a new line · paste or drop an image</span>
                </div>
            </form>
        </div>
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
