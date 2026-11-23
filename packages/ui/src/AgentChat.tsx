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
    ASSISTANT_NAME,
    LEAD_NAME,
    type AgentTranscriptResponse,
    type ModelView,
    type ProjectView,
    type SessionView,
} from "@spinner/protocol";

import {
    CHAT_SHOWN_START,
    CHAT_SHOWN_STEP,
    THINKING_LEVELS,
    QUIET_HINT_MS,
    SENT_SHOWN_MS_MAX,
    TOOL_RESULT_SHOWN,
    boxRows,
    chatBlocks,
    dragsFiles,
    imagesLabel,
    noticeOf,
    SPINNER_SENDER,
    splitPendingNotices,
    messageWithFiles,
    modelLabel,
    quietMs,
    quietText,
    runningTool,
    sendsOnKey,
    slashMatches,
    slashQuery,
    toolSummary,
    toolText,
    unconfirmedSent,
    windowed,
    type SentMessage,
    withDictation,
    workLabel,
    type ChatBlock,
    type HandledBlock,
    type SlashCommand,
    type WorkItem,
} from "./chat.ts";
import { agentLabel } from "./agent-view.ts";
import { ChatGate, chatQuestion } from "./ChatGate.tsx";
import { ChatPrompt } from "./ChatPrompt.tsx";
import { Icon } from "./PaneHead.tsx";
import { fetchModels, fetchProjects, fetchTranscript, postAgent } from "./events-client.ts";
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
import { emptyChat, needsPage, type ChatState } from "./transcript-sync.ts";
import type { Entry, Transcript } from "./transcript.ts";

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

/**
 * Who a message that is not the operator's came from, as the chat marks it: a bolt in amber
 * for Spinner's own pings, a speech bubble in violet for another agent's message. The mark
 * and the colour say which at a glance; the name follows.
 */
function NoticeMark({ from }: { from: string }) {
    const spinner = from === SPINNER_SENDER;
    return (
        <>
            <span className="chat-from-icon" aria-hidden="true">
                <Icon name={spinner ? "ping" : "comment"} />
            </span>
            <span className="chat-from-name">{spinner ? SPINNER_SENDER : agentLabel(from)}</span>
        </>
    );
}

function noticeKind(from: string): "spinner" | "agent" {
    return from === SPINNER_SENDER ? "spinner" : "agent";
}

/**
 * A message the agent got from Spinner or from another agent while a turn ran: one line
 * that names the sender; a click opens the whole text. It is not the operator's, so it is
 * not a bubble.
 */
function SpinnerNotice({ text }: { text: string }) {
    const [open, setOpen] = useState(false);
    const notice = noticeOf(text);
    const from = notice?.from ?? SPINNER_SENDER;
    const line = notice?.line ?? (text.trim().split("\n")[0] ?? "");
    return (
        <li className="chat-notice" data-from={noticeKind(from)}>
            <button
                type="button"
                className="chat-work-head"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                title="Sent to the agent, not by you"
            >
                <span className="chat-fold" data-open={open}>›</span>
                <NoticeMark from={from} />
                <span className="chat-work-label">{line}</span>
            </button>
            {open && <div className="chat-notice-text">{text.trim()}</div>}
        </li>
    );
}

/**
 * A turn that Spinner or another agent started: the message's one line, then the agent's
 * brief of what it did. A click opens the message, the work and the whole answer.
 */
function HandledTurn({ block, who }: { block: HandledBlock; who: string }) {
    const [open, setOpen] = useState(false);
    const steps = block.steps === 0 ? "" : `${block.steps} step${block.steps === 1 ? "" : "s"}`;
    return (
        <li className="chat-notice chat-handled" data-from={noticeKind(block.from)}>
            <button
                type="button"
                className="chat-work-head"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                title={`Not from you: ${who} handled it. Click for the whole turn.`}
            >
                <span className="chat-fold" data-open={open}>›</span>
                {block.live && <span className="dot session-working" aria-hidden="true" />}
                <NoticeMark from={block.from} />
                <span className="chat-work-label">{block.line}</span>
                {steps !== "" && <span className="chat-handled-steps">{steps}</span>}
            </button>
            {!open && block.brief !== "" && (
                <div className="chat-handled-brief">
                    <span className="chat-handled-who">{who}:</span> {block.brief}
                    {block.clipped ? "…" : ""}
                </div>
            )}
            {open && (
                <div className="chat-handled-body">
                    <div className="chat-notice-text">{block.text}</div>
                    <ol className="chat-list">
                        {block.blocks.map((inner) => (
                            <BlockView key={`${inner.kind}-${inner.key}`} block={inner} who={who} />
                        ))}
                    </ol>
                </div>
            )}
        </li>
    );
}

function BlockView({ block, who }: { block: ChatBlock; who: string }) {
    switch (block.kind) {
        case "handled":
            return <HandledTurn block={block} who={who} />;
        case "user": {
            const { notice, operator } = splitPendingNotices(block.entry.text);
            return (
                <>
                    {notice !== null && <SpinnerNotice text={notice} />}
                    {operator !== null && (
                        <li className="chat-user">
                            <div className="chat-user-text">{operator}</div>
                            {block.entry.images !== undefined && (
                                <span className="muted chat-user-images">
                                    {imagesLabel(block.entry.images)}
                                </span>
                            )}
                        </li>
                    )}
                </>
            );
        }
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
export function TranscriptView({
    transcript,
    who = ASSISTANT_NAME,
}: {
    transcript: Transcript;
    /** The agent's name in the chat, for the brief of a turn it handled alone. */
    who?: string;
}) {
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
                <BlockView key={`${block.kind}-${block.key}`} block={block} who={who} />
            ))}
        </ol>
    );
}

/** The wait before the chat asks again for a page the daemon did not answer. */
const PAGE_RETRY_MS = 2000;
/** How often the status line looks at the clock while a turn runs, for the quiet hint. */
const QUIET_TICK_MS = 30_000;

/**
 * Keeps the chat in step with the daemon's transcript. It fetches a page when the chat has
 * none (a tab that opens, a pi that started again, a socket that reconnected) and when a
 * live event came ahead of the next number. A chat in step fetches nothing: the numbered
 * events carry it. One request runs at a time; a failed one is asked again.
 */
function useTranscriptPages(
    base: string,
    chat: ChatState,
    onPage: (page: AgentTranscriptResponse) => void,
): void {
    const needed = needsPage(chat);
    const since = chat.cursor ?? 0;
    const [retry, setRetry] = useState(0);
    // The callback changes with every render of the parent; the request must not restart.
    const deliver = useRef(onPage);
    useEffect(() => {
        deliver.current = onPage;
    });
    useEffect(() => {
        if (!needed) {
            return;
        }
        const abort = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const again = (): void => {
            if (!abort.signal.aborted) {
                timer = setTimeout(() => setRetry((count) => count + 1), PAGE_RETRY_MS);
            }
        };
        fetchTranscript(base, since, abort.signal).then((page) => {
            if (page === null) {
                again();
            } else if (!abort.signal.aborted) {
                deliver.current(page);
            }
        }, again);
        return () => {
            abort.abort();
            clearTimeout(timer);
        };
    }, [base, needed, since, retry]);
}

/** The time now, read again every `QUIET_TICK_MS` while `on`, so a quiet turn shows as one. */
function useClock(on: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!on) {
            return;
        }
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), QUIET_TICK_MS);
        return () => clearInterval(timer);
    }, [on]);
    return now;
}

/** A failure as the chat shows it: the message alone, without the `Error:` of its type. */
function failureText(failure: unknown): string {
    return failure instanceof Error ? failure.message : String(failure);
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
    /** The agent's chat from the store; absent before its first event or page. */
    chat: ChatState | undefined;
    /** Puts a page of the daemon's transcript into the store. */
    onPage: (agent: string, page: AgentTranscriptResponse) => void;
}

/** The chat of one agent (docs/designs/talk-change-ship.md, 5.1 to 5.7). */
export function AgentChat({ view, agent, chat = emptyChat, onPage }: AgentChatProps) {
    const [text, setText] = useState("");
    const [attached, setAttached] = useState<Attached[]>([]);
    const [uploading, setUploading] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [away, setAway] = useState(false);
    const [slashAt, setSlashAt] = useState(0);
    const [slashOff, setSlashOff] = useState(false);
    // What the box sent and the transcript has not shown yet (5.2): drawn at once, so the
    // operator sees the message the moment it goes, not when pi records it.
    const [sent, setSent] = useState<{ base: string; messages: SentMessage[] }>({
        base: "",
        messages: [],
    });
    const scroller = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLTextAreaElement>(null);
    const picker = useRef<HTMLInputElement>(null);
    const dir = view.summary.dir;
    const base = `/sessions/${dir}/agents/${agent}`;
    const spec = view.summary.session.agents[agent];
    const hosted = view.agents_running.includes(agent);
    const working = hosted && spec?.process === "running";
    // The transcript has one source: the daemon's, a page and then its numbered events.
    useTranscriptPages(base, chat, (page) => onPage(agent, page));
    const held = chat.transcript;
    const transcript = useMemo(() => {
        const pending = sent.base === base ? unconfirmedSent(sent.messages, held.entries) : [];
        const echoed = pending.map((message) => ({
            kind: "user" as const,
            text: message.text,
            ts: message.ts,
            ...(message.images === undefined ? {} : { images: message.images }),
        }));
        return { ...held, entries: [...held.entries, ...echoed], running: working };
    }, [held, working, sent, base]);
    // A confirmed or stale sent message leaves the list, so it cannot show twice later.
    useEffect(() => {
        if (sent.base !== base || sent.messages.length === 0) {
            return;
        }
        const now = Date.now();
        const kept = unconfirmedSent(sent.messages, held.entries)
            .filter((message) => now - message.ts < SENT_SHOWN_MS_MAX);
        if (kept.length !== sent.messages.length) {
            setSent({ base, messages: kept });
        }
    }, [held, sent, base]);
    const now = useClock(working);
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

    // The box grows with what is typed: `rows` counts newlines only, so a long line that
    // wraps stayed one row high and scrolled inside itself. The height follows the content
    // up to the stylesheet's `max-height`; past that the box scrolls.
    useLayoutEffect(() => {
        const node = input.current;
        if (node === null) {
            return;
        }
        node.style.height = "auto";
        node.style.height = `${node.scrollHeight}px`;
    }, [text]);

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
            (failure: unknown) => setError(failureText(failure)),
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
        const withImages = images.length > 0 ? { images } : {};
        const echo: SentMessage = {
            text: message,
            ts: Date.now(),
            ...(images.length === 0 ? {} : { images: images.length }),
        };
        setSent((old) => ({ base, messages: [...(old.base === base ? old.messages : []), echo] }));
        const body = { text: message, source: "operator", ...withImages };
        postAgent(`${base}/${working ? "steer" : "prompt"}`, body).then(
            () => setError(null),
            (failure: unknown) => {
                // Not sent: the echo goes, so the chat does not show a message the agent
                // lacks. The words go back into the box when nothing was typed since: what
                // the operator wrote is never lost to a refusal (a compaction ate one).
                setSent((old) => ({ base, messages: old.messages.filter((m) => m !== echo) }));
                setText((typed) => (typed === "" ? text : typed));
                setAttached((files) => (files.length === 0 ? attached : files));
                setError(failureText(failure));
            },
        );
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
    // A file dragged over any part of the chat is taken: the message box is a small target
    // under a tall transcript. A drag of text or of a link keeps the browser's own handling.
    const [dropping, setDropping] = useState(false);
    const onDragOver = (event: DragEvent<HTMLDivElement>) => {
        if (dragsFiles(event.dataTransfer.types)) {
            event.preventDefault();
            setDropping(true);
        }
    };
    const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
        // The drag also "leaves" each child it crosses; only the way out of the chat counts.
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
            setDropping(false);
        }
    };
    const onDrop = (event: DragEvent<HTMLDivElement>) => {
        setDropping(false);
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
    // pi waits on a prompt in its terminal (a damage-control confirm): the turn is not stuck,
    // it waits for the operator, and the card on the box answers it.
    const prompt = transcript.prompt ?? null;
    if (prompt !== null) {
        status = `${who} waits for your answer: ${prompt.title}`;
    }
    // pi takes no message while it compacts; the daemon holds one and sends it afterwards.
    const compacting = hosted && transcript.compacting === true;
    if (compacting) {
        status = `${who} is compacting its context. A message you send now waits for it.`;
    }
    // "On it" is what pi reports, and pi can be wrong or stuck in one tool call. After a
    // few minutes without an event from the agent's pi the line says so, with the facts.
    const quiet = working ? quietMs(now, chat.active) : 0;
    if (quiet >= QUIET_HINT_MS && prompt === null) {
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
        <div
            className="agent-chat"
            data-working={working}
            data-dropping={dropping}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
        >
            <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
                <div className="chat-column">
                    <TranscriptView transcript={transcript} who={who} />
                    <div
                        className="chat-status"
                        role="status"
                        data-state={`${hosted ? "hosted" : "stopped"}/${working ? "turn" : "idle"}`}
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
                {prompt !== null && <ChatPrompt base={base} who={who} prompt={prompt} />}
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
            (failure: unknown) => setError(failureText(failure)),
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
