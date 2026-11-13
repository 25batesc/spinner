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

import {
    LEAD_NAME,
    type AgentEventsStamp,
    type ModelView,
    type ProjectView,
    type SessionView,
} from "@spinner/protocol";

import {
    CHAT_SHOWN_START,
    CHAT_SHOWN_STEP,
    THINKING_LEVELS,
    QUIET_HINT_MS,
    STAMP_POLL_MS,
    TOOL_RESULT_SHOWN,
    boxRows,
    chatBlocks,
    imagesLabel,
    isSpinnerNotice,
    messageWithFiles,
    modelLabel,
    quietMs,
    quietText,
    runningTool,
    sendsOnKey,
    settledStamp,
    slashMatches,
    slashQuery,
    stampKey,
    toolSummary,
    toolText,
    windowed,
    withDictation,
    workLabel,
    type ChatBlock,
    type SlashCommand,
    type WorkItem,
} from "./chat.ts";
import { agentLabel } from "./agent-view.ts";
import { ChatGate, chatQuestion } from "./ChatGate.tsx";
import {
    fetchAgentHistory,
    fetchAgentStamp,
    fetchModels,
    fetchProjects,
    postAgent,
} from "./events-client.ts";
import "./chat.css";
import { renderChatMarkdown } from "./markdown.ts";
import {
    fetchContext,
    fetchDefaultBrief,
    postAttachment,
    postUpload,
    useLoaded,
} from "./remote.ts";
import type { RunAction } from "./SessionsPane.tsx";
import {
    emptyTranscript,
    foldHistory,
    mergeTranscripts,
    type Entry,
    type Transcript,
} from "./transcript.ts";

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

type WorkBlock = Extract<ChatBlock, { kind: "work" }>;

/** One thing the agent did inside a turn: its thought, a remark, or a tool call. */
function WorkItemView({ item }: { item: WorkItem }) {
    if (item.kind === "tool") {
        return <ToolRow entry={item.entry} />;
    }
    if (item.kind === "thinking") {
        return <li className="chat-work-thought">{item.text}</li>;
    }
    return (
        <li className="chat-work-remark">
            <Answer text={item.text} />
        </li>
    );
}

/**
 * A turn's work, folded to one line (`Worked for 2m 29s · 14 steps`); a click opens the
 * thoughts and the tool calls. The group of a turn that runs shows what it does now.
 */
function WorkGroup({ block }: { block: WorkBlock }) {
    const [open, setOpen] = useState(false);
    return (
        <li className="chat-work" data-live={block.live} data-failed={block.failed > 0}>
            <button
                type="button"
                className="chat-work-head"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                <span className="chat-fold" data-open={open}>›</span>
                {block.live && <span className="dot session-working" aria-hidden="true" />}
                <span className="chat-work-label">{workLabel(block)}</span>
            </button>
            {open && (
                <ul className="chat-work-items">
                    {block.items.map((item, index) => <WorkItemView key={index} item={item} />)}
                </ul>
            )}
        </li>
    );
}

/** A message Spinner sent to the agent: one muted line; a click opens the whole text. */
function SpinnerNotice({ text }: { text: string }) {
    const [open, setOpen] = useState(false);
    const first = text.trim().split("\n")[0] ?? "";
    return (
        <li className="chat-notice">
            <button
                type="button"
                className="chat-work-head"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                title="Sent to the agent by Spinner"
            >
                <span className="chat-fold" data-open={open}>›</span>
                <span className="chat-work-label">Spinner: {first}</span>
            </button>
            {open && <div className="chat-notice-text">{text.trim()}</div>}
        </li>
    );
}

function BlockView({ block }: { block: ChatBlock }) {
    switch (block.kind) {
        case "user":
            if (isSpinnerNotice(block.entry.text)) {
                return <SpinnerNotice text={block.entry.text} />;
            }
            return (
                <li className="chat-user">
                    <div className="chat-user-text">{block.entry.text}</div>
                    {block.entry.images !== undefined && (
                        <span className="muted chat-user-images">
                            {imagesLabel(block.entry.images)}
                        </span>
                    )}
                </li>
            );
        case "answer":
            return (
                <li className="chat-assistant">
                    <Answer text={block.entry.text} />
                    {block.entry.error !== undefined && (
                        <div className="needs-human chat-error">ended: {block.entry.error}</div>
                    )}
                </li>
            );
        case "work":
            return <WorkGroup block={block} />;
        case "note":
            return <li className="chat-note muted">{block.text}</li>;
    }
}

/**
 * The message list: each turn as the operator's message, the agent's work folded, and its
 * answer. It draws the newest blocks; `show earlier` adds the rest (5.2). The Goldfish
 * transcript (entry 4.15) shows it read-only.
 */
export function TranscriptView({ transcript }: { transcript: Transcript }) {
    const [shown, setShown] = useState(CHAT_SHOWN_START);
    const blocks = useMemo(
        () => chatBlocks(transcript.entries, transcript.running),
        [transcript.entries, transcript.running],
    );
    if (blocks.length === 0) {
        return <p className="muted chat-empty">Nothing here yet. Say hi, or say what you need.</p>;
    }
    const { entries, earlier } = windowed(blocks, shown);
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
            {entries.map((block) => (
                // The key is the index of the block's first entry, so a block keeps its
                // state (an opened group) when a new entry arrives.
                <BlockView key={`${block.kind}-${block.key}`} block={block} />
            ))}
        </ol>
    );
}

/**
 * The agent's past turns from the daemon, loaded when the tab opens and again when the agent
 * is resumed. Live events then add to them; `mergeTranscripts` shows each message once.
 */
/**
 * The stamp of the agent's transcript, asked for every `STAMP_POLL_MS` while the chat shows.
 * `settled` is the stamp seen on two polls in a row. The interval ends with the component.
 */
function useStamp(base: string): { stamp: AgentEventsStamp | null; settled: string } {
    const [state, setState] = useState<{ stamp: AgentEventsStamp | null; settled: string }>({
        stamp: null,
        settled: "",
    });
    useEffect(() => {
        const abort = new AbortController();
        let previous = "";
        const poll = (): void => {
            fetchAgentStamp(base, abort.signal).then(
                (stamp) => {
                    const current = stampKey(stamp);
                    const before = previous;
                    previous = current;
                    setState((old) => ({
                        stamp,
                        settled: settledStamp(old.settled, before, current),
                    }));
                },
                () => undefined,
            );
        };
        poll();
        const timer = setInterval(poll, STAMP_POLL_MS);
        return () => {
            clearInterval(timer);
            abort.abort();
        };
    }, [base]);
    return state;
}

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

/** A file as base64, without the `data:` prefix. */
function fileBase64(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("the file could not be read"));
        reader.onload = () => {
            const url = String(reader.result);
            resolve(url.slice(url.indexOf(",") + 1));
        };
        reader.readAsDataURL(file);
    });
}

/** An image file as PNG bytes in base64, converted in the browser when it is another format. */
async function pngBase64(file: Blob): Promise<string> {
    if (file.type === "image/png") {
        return fileBase64(file);
    }
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    const url = canvas.toDataURL("image/png");
    return url.slice(url.indexOf(",") + 1);
}

/** The part of the browser's speech recognition the box uses; absent in some shells. */
interface Recognition {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onresult: ((event: { resultIndex: number; results: RecognitionResults }) => void) | null;
    onerror: ((event: { error: string }) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
}
type RecognitionResults = ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;

function recognitionOf(): (new () => Recognition) | undefined {
    const scope = window as unknown as Record<string, unknown>;
    const found = scope["SpeechRecognition"] ?? scope["webkitSpeechRecognition"];
    return found as (new () => Recognition) | undefined;
}

const DICTATION_UNAVAILABLE =
    "Dictation is not available in this window. On macOS, put the caret in the box and " +
    "press the dictation key (or Fn twice).";

/**
 * Dictation into the box through the browser's speech recognition. `toggle` starts and
 * stops it; each finished phrase goes to `onWords`. A shell without the service (the
 * desktop app has none) reports why through `onError`.
 */
function useDictation(onWords: (words: string) => void, onError: (text: string) => void) {
    const [listening, setListening] = useState(false);
    const active = useRef<Recognition | null>(null);
    useEffect(() => () => active.current?.stop(), []);
    const toggle = () => {
        if (active.current !== null) {
            active.current.stop();
            return;
        }
        const Service = recognitionOf();
        if (Service === undefined) {
            onError(DICTATION_UNAVAILABLE);
            return;
        }
        const recognition = new Service();
        recognition.continuous = true;
        recognition.interimResults = false;
        recognition.lang = navigator.language;
        recognition.onresult = (event) => {
            for (let index = event.resultIndex; index < event.results.length; index += 1) {
                const result = event.results[index];
                if (result?.isFinal === true) {
                    onWords(result[0]?.transcript ?? "");
                }
            }
        };
        recognition.onerror = (event) => {
            if (event.error !== "no-speech" && event.error !== "aborted") {
                onError(`${DICTATION_UNAVAILABLE} (${event.error})`);
            }
        };
        recognition.onend = () => {
            active.current = null;
            setListening(false);
        };
        active.current = recognition;
        setListening(true);
        try {
            recognition.start();
        } catch {
            active.current = null;
            setListening(false);
            onError(DICTATION_UNAVAILABLE);
        }
    };
    return { listening, toggle };
}

/** Something attached to the message being written. */
interface Attached {
    name: string;
    /** Relative to the session directory. */
    path: string;
    image: boolean;
}

export interface AgentChatProps {
    view: SessionView;
    agent: string;
    transcript: Transcript | undefined;
}

/** The chat of one agent (docs/designs/talk-change-ship.md, 5.1 to 5.7). */
export function AgentChat({ view, agent, transcript: live = emptyTranscript }: AgentChatProps) {
    const [text, setText] = useState("");
    const [attached, setAttached] = useState<Attached[]>([]);
    const [uploading, setUploading] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [away, setAway] = useState(false);
    const [slashAt, setSlashAt] = useState(0);
    const [slashOff, setSlashOff] = useState(false);
    const scroller = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLTextAreaElement>(null);
    const picker = useRef<HTMLInputElement>(null);
    const dir = view.summary.dir;
    const base = `/sessions/${dir}/agents/${agent}`;
    const spec = view.summary.session.agents[agent];
    const hosted = view.agents_running.includes(agent);
    const working = hosted && spec?.process === "running";
    // The history is read again when the agent is resumed (it may have compacted) and at
    // the start and the end of each turn: a live event that was lost on the way (a daemon
    // restart, a socket that reconnected) then shows with the turn's end at the latest.
    const phase = `${hosted ? "hosted" : "stopped"}/${working ? "turn" : "idle"}`;
    // A turn's end can fail to arrive (pi that does not settle, a lost event). So the
    // history is also read whenever the transcript moved and then went quiet.
    const { stamp, settled } = useStamp(base);
    const history = useHistory(base, `${phase}@${settled}`);
    const transcript = useMemo(() => {
        const merged = mergeTranscripts(history, live);
        return { ...merged, running: working };
    }, [history, live, working]);
    const models = useLoaded("models", fetchModels).value ?? [];
    // The agent's skills and prompt templates, for the completion after `/`.
    const context = useLoaded(`${base}#${hosted ? "hosted" : "stopped"}`, (signal) =>
        fetchContext(base, signal),
    );
    const commands: SlashCommand[] = (context.value?.commands ?? [])
        .filter((command) => command.kind !== "extension")
        .map(({ name, kind, description }) => ({ name, kind, description }));
    const query = slashOff ? null : slashQuery(text);
    const matches = query === null ? [] : slashMatches(commands, query);
    const picked = matches[Math.min(slashAt, matches.length - 1)];

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
    // The chat mounts while its view may be hidden, and a rendered table or code block
    // changes the height after the entries did: a change of size keeps the newest message
    // in view too, unless the operator scrolled away.
    const awayNow = useRef(away);
    awayNow.current = away;
    useEffect(() => {
        const node = scroller.current;
        if (node === null || typeof ResizeObserver === "undefined") {
            return;
        }
        const observer = new ResizeObserver(() => {
            if (!awayNow.current) {
                node.scrollTop = node.scrollHeight;
            }
        });
        observer.observe(node);
        if (node.firstElementChild !== null) {
            observer.observe(node.firstElementChild);
        }
        return () => observer.disconnect();
    }, [base]);
    const change = (next: string) => {
        setText(next);
        setSlashOff(false);
        setSlashAt(0);
    };

    const post = (action: string, body: unknown) =>
        postAgent(`${base}/${action}`, body).then(
            () => setError(null),
            (failure: unknown) => setError(String(failure)),
        );
    const send = () => {
        const images = attached.filter((file) => file.image).map((file) => file.path);
        const paths = attached.map((file) => `${view.summary.path}/${file.path}`);
        const message = messageWithFiles(text, paths);
        if (message === "" || uploading > 0) {
            return;
        }
        change("");
        setAttached([]);
        setAway(false);
        // The box marks its messages: the daemon resumes a stopped agent for them and
        // counts a steer to the lead (entry 6.20). The images go as images too.
        const sent = images.length > 0 ? { images } : {};
        void post(working ? "steer" : "prompt", { text: message, source: "operator", ...sent });
    };
    const attach = (files: readonly File[]) => {
        const pathOf = window.spinnerDesktop?.files?.pathOf;
        for (const file of files) {
            const image = file.type.startsWith("image/");
            const local = image || pathOf === undefined ? "" : pathOf(file);
            if (local !== "") {
                // The desktop app knows where the file is: the agent reads it in place.
                const gap = (old: string) => (old === "" || /\s$/.test(old) ? "" : " ");
                setText((old) => `${old}${gap(old)}${local} `);
                continue;
            }
            setUploading((old) => old + 1);
            const saved = image
                ? pngBase64(file).then((png) => postAttachment(dir, png))
                : fileBase64(file).then((data) => postUpload(dir, file.name, data));
            saved
                .then(
                    ({ name, path }) => {
                        setAttached((old) => [...old, { name, path, image }]);
                        setError(null);
                    },
                    (failure: unknown) =>
                        setError(`${file.name} was not attached: ${String(failure)}`),
                )
                .finally(() => setUploading((old) => old - 1));
        }
    };
    const detach = (file: Attached) =>
        setAttached((old) => old.filter((entry) => entry !== file));
    const accept = (command: SlashCommand) => {
        change(`/${command.name} `);
        input.current?.focus();
    };
    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (picked !== undefined) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : matches.length - 1;
                setSlashAt((slashAt + step) % matches.length);
                return;
            }
            if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
                event.preventDefault();
                accept(picked);
                return;
            }
            if (event.key === "Escape") {
                event.preventDefault();
                setSlashOff(true);
                return;
            }
        }
        const { key, shiftKey } = event;
        if (sendsOnKey({ key, shiftKey, isComposing: event.nativeEvent.isComposing })) {
            event.preventDefault();
            send();
        }
    };
    const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
        const files = [...event.clipboardData.files];
        if (files.length > 0) {
            // A file or an image on the clipboard is attached; its name is not typed.
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
    const dictated = (words: string) => setText((old) => withDictation(old, words));
    const dictation = useDictation(dictated, setError);
    const setControl = (control: "model" | "thinking", value: string) => {
        if (value !== "") {
            void post(control, control === "model" ? { model: value } : { level: value });
        }
    };

    // The lead's open question is part of its chat: the last block of the conversation.
    const asked = agent === LEAD_NAME ? chatQuestion(view) : null;
    // The lead is Remy to the operator; another agent keeps its own name.
    const who = agentLabel(agent);
    let status = `${who} is resting. Send a message to wake ${who} up.`;
    if (hosted) {
        status = working ? `${who} is on it` : `${who} is ready when you are`;
    }
    if (asked !== null && !working) {
        status = `${who} has a question for you`;
    }
    // "On it" is what pi reports, and pi can be wrong or stuck in one tool call. After a
    // few minutes without a write to the transcript the line says so, with the facts.
    const quiet = working ? quietMs(Date.now(), stamp?.written ?? null) : 0;
    if (quiet >= QUIET_HINT_MS) {
        const tool = runningTool(transcript.entries);
        const what = tool === "" ? "no tool call runs" : `still running: ${tool}`;
        const since = quietText(quiet);
        status = `${who} has written nothing for ${since} (${what}). Stop to end the turn.`;
    }
    let placeholder = `Ask ${who} to build features, fix bugs, or work on your code`;
    if (working) {
        placeholder = `Tell ${who} something now (it interrupts the turn)`;
    } else if (asked !== null) {
        placeholder = `Or reply to ${who} directly…`;
    } else if (!hosted) {
        placeholder = `Send a message to wake ${who} up`;
    }
    const model = spec?.model ?? "";
    const known = models.some((entry) => `${entry.provider}/${entry.id}` === model);
    const thinking = spec?.thinking ?? "";
    const stops = working && text.trim() === "" && attached.length === 0;
    return (
        <div className="agent-chat" data-working={working}>
            <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
                <div className="chat-column">
                    <TranscriptView transcript={transcript} />
                    <div
                        className="chat-status"
                        role="status"
                        data-state={phase}
                        data-quiet={quiet >= QUIET_HINT_MS}
                    >
                        {agent === LEAD_NAME ? (
                            // Remy's face: a small round mark that breathes while Remy works.
                            <span className="chat-avatar" data-working={working} aria-hidden="true">
                                R
                            </span>
                        ) : (
                            <span className={working ? "dot session-working" : "dot chat-idle"} />
                        )}
                        <span>{status}</span>
                    </div>
                </div>
            </div>
            <div className="chat-dock">
                {away && (
                    <button
                        type="button"
                        className="chat-jump"
                        aria-label="Jump to the latest message"
                        onClick={() => setAway(false)}
                    >
                        ↓
                    </button>
                )}
                {error !== null && <p className="needs-human chat-error">{error}</p>}
                {asked !== null && <ChatGate key={asked.key} dir={dir} asked={asked} />}
                {matches.length > 0 && (
                    <ul className="chat-slash" role="listbox" aria-label="Skills and commands">
                        {matches.map((command, index) => (
                            <li
                                key={command.name}
                                role="option"
                                aria-selected={command === picked}
                            >
                                <button
                                    type="button"
                                    className="chat-slash-item"
                                    data-picked={command === picked}
                                    onMouseEnter={() => setSlashAt(index)}
                                    onClick={() => accept(command)}
                                >
                                    <code>/{command.name}</code>
                                    <span className="muted">{command.description}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
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
                            {attached.map((file) => (
                                <span key={file.path} className="badge chat-chip" title={file.path}>
                                    {file.name}
                                    <button
                                        type="button"
                                        aria-label={`Remove ${file.name}`}
                                        onClick={() => detach(file)}
                                    >
                                        ×
                                    </button>
                                </span>
                            ))}
                            {uploading > 0 && <span className="muted">attaching…</span>}
                        </div>
                    )}
                    <textarea
                        ref={input}
                        className="chat-input"
                        value={text}
                        rows={boxRows(text)}
                        onChange={(event) => change(event.target.value)}
                        onKeyDown={onKeyDown}
                        onPaste={onPaste}
                        placeholder={placeholder}
                        aria-label="Message"
                    />
                    <div className="chat-tools">
                        <input
                            ref={picker}
                            type="file"
                            multiple
                            hidden
                            onChange={(event) => {
                                attach([...(event.target.files ?? [])]);
                                event.target.value = "";
                            }}
                        />
                        <button
                            type="button"
                            className="chat-icon"
                            title="Attach files or images (or paste or drop them)"
                            aria-label="Attach files"
                            onClick={() => picker.current?.click()}
                        >
                            +
                        </button>
                        <button
                            type="button"
                            className="chat-icon"
                            title="Skills and commands"
                            aria-label="Skills and commands"
                            onClick={() => {
                                change("/");
                                input.current?.focus();
                            }}
                        >
                            /
                        </button>
                        <span className="chat-tools-gap" />
                        <>
                            <select
                                className="chat-select"
                                title="The agent's model"
                                aria-label="Model"
                                value={model}
                                disabled={!hosted}
                                onChange={(event) => setControl("model", event.target.value)}
                            >
                                {!known && <option value={model}>{modelLabel(model)}</option>}
                                {models.map((entry) => {
                                    const id = `${entry.provider}/${entry.id}`;
                                    return <option key={id} value={id}>{modelLabel(id)}</option>;
                                })}
                            </select>
                            <select
                                className="chat-select"
                                title="How much the agent thinks before it answers"
                                aria-label="Thinking level"
                                value={thinking}
                                disabled={!hosted}
                                onChange={(event) => setControl("thinking", event.target.value)}
                            >
                                {thinking === "" && <option value="">thinking</option>}
                                {THINKING_LEVELS.map((level) => (
                                    <option key={level} value={level}>{level}</option>
                                ))}
                            </select>
                        </>
                        <button
                            type="button"
                            className="chat-icon"
                            title={dictation.listening ? "Stop dictation" : "Dictate"}
                            aria-label="Dictate"
                            aria-pressed={dictation.listening}
                            onClick={dictation.toggle}
                        >
                            <MicGlyph />
                        </button>
                        {stops ? (
                            <button
                                type="button"
                                className="chat-send"
                                title={`Stop ${who}'s turn`}
                                aria-label="Stop"
                                onClick={() => void post("abort", {})}
                            >
                                ■
                            </button>
                        ) : (
                            <button
                                type="submit"
                                className="chat-send"
                                title={working ? "Steer (Enter)" : "Send (Enter)"}
                                aria-label={working ? "Steer" : "Send"}
                                disabled={uploading > 0}
                            >
                                ↑
                            </button>
                        )}
                    </div>
                </form>
            </div>
        </div>
    );
}

/** A microphone, 14 px, in the text colour. */
function MicGlyph() {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path
                d={
                    "M8 1.5a2 2 0 0 0-2 2v4a2 2 0 0 0 4 0v-4a2 2 0 0 0-2-2Z" +
                    "M4 7.5a4 4 0 0 0 8 0M8 11.5v3M5.5 14.5h5"
                }
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
            />
        </svg>
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
