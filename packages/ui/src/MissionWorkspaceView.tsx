// The parts of the mission view that `ImplementView.tsx` composes (docs/designs/
// session-workspace.md, T6, entry 2.18): the pulse line, the Done-when checklist, one item
// row with its edit and note boxes, the editable goal text, the roster chip, the Open
// questions with an answer box, the Contracts, and the Log as a feed, newest first. Nothing
// here fetches or writes: `MissionWorkspace` owns the data and maps each callback to the
// section route or the inbox (the props contract under *Contracts* in the session's
// MISSION.md). The parts keep look state only: the item in edit, the draft, and which items
// arrived after the first render, for the one-shot animations.
import {
    createContext, useContext, useRef, useState, type FormEvent, type KeyboardEvent,
    type ReactNode,
} from "react";

import type {
    DoneWhenItem, LogLine, MissionLine, MissionSection, MissionView, QuestionItem, RosterRow,
} from "@spinner/protocol";

import { GOAL_CLAMP_CHARS } from "./implement.ts";

import "./mission-workspace.css";

export interface MissionWorkspaceViewProps {
    mission: MissionView;
    /** The roster names, for the Log filter and the owner chips. */
    agents: string[];
    /** The Log's agent; null shows every line. */
    filter: string | null;
    /** The item whose write is in flight, as `<section>:<id>` (`plan:3`, `goal:0`). */
    pending: string | null;
    /** The last failed write. */
    error: string | null;
    /** A new text for one item; `id` is 0 for the Goal. */
    onEdit(section: MissionSection, id: number, text: string): void;
    /** A plan or done_when item: done ↔ open. */
    onTick(section: TickSection, id: number): void;
    /** A steer to the question's asker. */
    onAnswer(questionId: number, text: string): void;
    /** A note to the item's owner, through the owner's inbox. */
    onNote(section: MissionSection, id: number, text: string): void;
    onFilter(agent: string | null): void;
}

export type TickSection = "plan" | "done_when";

/** The key of an item across sections, as `pending` names it: Plan and Done-when ids overlap. */
export function itemKey(section: MissionSection, id: number): string {
    return `${section}:${id}`;
}

/** What every row needs from the view: the callbacks, the pending id, the fresh ticks. */
export interface RowContext extends MissionWorkspaceViewProps {
    ticked: ReadonlySet<string>;
}

/** The keys of the ticked Plan and Done-when items, for `useArrivals`. */
export function doneKeys(mission: MissionView): string[] {
    const plan = mission.plan.filter((item) => item.state === "done");
    const done = mission.done_when.filter((item) => item.state === "done");
    return [
        ...plan.map((item) => itemKey("plan", item.id)),
        ...done.map((item) => itemKey("done_when", item.id)),
    ];
}

/**
 * The keys that were not there at the first render. A row with a fresh key mounts with its
 * one-shot animation class; the class stays, so a later render does not replay it.
 */
export function useArrivals(keys: string[]): ReadonlySet<string> {
    const initial = useRef<ReadonlySet<string> | null>(null);
    if (initial.current === null) {
        initial.current = new Set(keys);
    }
    const known = initial.current;
    return new Set(keys.filter((key) => !known.has(key)));
}

export function Section(props: {
    section: MissionSection;
    label: string;
    count?: string | undefined;
    className?: string;
    children: ReactNode;
}) {
    return (
        <section
            className={`mw-section ${props.className ?? ""}`}
            data-section={props.section}
            aria-label={props.label}
        >
            <h3 className="mw-label">
                {props.label}
                {props.count !== undefined && <span className="mw-count">{props.count}</span>}
            </h3>
            {props.children}
        </section>
    );
}

/** The entry counts of the Implement header (T6): the text stands in for `plan n / N`. */
export interface PulseCounts {
    /** `entries done 9 / 23`; null shows the Plan count instead. */
    entries: string | null;
    /** False on the design track, where Done when is hidden (D4). */
    doneWhen: boolean;
}

/**
 * The state of the work on one line, for the ten-second read: the Plan and Done-when counts
 * (or the entry counts with `counts`), what is in progress, the open questions and the
 * blocked agents. A pill scrolls to its section.
 */
export function Pulse({ mission, counts }: { mission: MissionView; counts?: PulseCounts }) {
    const plan = mission.plan.filter((item) => item.state === "done").length;
    const doing = mission.plan.filter((item) => item.state === "doing").length;
    const done = mission.done_when.filter((item) => item.state === "done").length;
    const open = mission.questions.filter((question) => question.answer === null).length;
    const blocked = mission.roster.filter((row) => isBlocked(row.blocked));
    const facts: { section: MissionSection; text: string; kind: string }[] = [];
    if (counts?.entries !== null && counts?.entries !== undefined) {
        facts.push({ section: "plan", text: counts.entries, kind: "" });
    } else if (mission.plan.length > 0) {
        facts.push({ section: "plan", text: `plan ${plan} / ${mission.plan.length}`, kind: "" });
    }
    if (doing > 0) {
        facts.push({ section: "plan", text: `${doing} in progress`, kind: "pill-accent" });
    }
    if (mission.done_when.length > 0 && counts?.doneWhen !== false) {
        const text = `done when ${done} / ${mission.done_when.length}`;
        const kind = done === mission.done_when.length ? "pill-ok" : "";
        facts.push({ section: "done_when", text, kind });
    }
    if (open > 0) {
        const text = open === 1 ? "1 open question" : `${open} open questions`;
        facts.push({ section: "open_questions", text, kind: "pill-warn" });
    }
    for (const row of blocked) {
        facts.push({ section: "roster", text: `${row.agent} blocked`, kind: "pill-warn" });
    }
    if (facts.length === 0) {
        return null;
    }
    const reveal = (section: MissionSection) =>
        document.querySelector(`.mw [data-section="${section}"]`)
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
    return (
        <div className="mw-pulse" aria-label="State of the work">
            {facts.map((fact) => (
                <button key={fact.text} className={`pill mw-pulse-pill ${fact.kind}`}
                    onClick={() => reveal(fact.section)}>
                    {fact.text}
                </button>
            ))}
        </div>
    );
}

export function DoneWhen({ items, rows }: { items: DoneWhenItem[]; rows: RowContext }) {
    const done = items.filter((item) => item.state === "done").length;
    return (
        <Section
            section="done_when"
            label="Done when"
            className="mw-done-when"
            count={items.length === 0 ? undefined : `${done} / ${items.length}`}
        >
            {items.length === 0 ? (
                <Empty text="The lead lists what must be true when the work is done." />
            ) : (
                <ul className="mw-list">
                    {items.map((item) => (
                        <Item
                            key={item.id}
                            section="done_when"
                            id={item.id}
                            text={item.text}
                            owner={item.owner}
                            time={item.ticked_at}
                            done={item.state === "done"}
                            rows={rows}
                        />
                    ))}
                </ul>
            )}
        </Section>
    );
}

/**
 * One item: the box, the text (a click edits it in place), the owner chip and the time. Under
 * the pointer the edit and note actions show. A note goes to the owner's inbox.
 */
export function Item(props: {
    section: MissionSection;
    id: number;
    text: string;
    owner: string | null;
    time: string | null;
    /** The tick state; null for an item without a box (a contract). */
    done: boolean | null;
    number?: string;
    rows: RowContext;
}) {
    const { rows, section } = props;
    const [mode, setMode] = useState<"view" | "edit" | "note">("view");
    const key = itemKey(section, props.id);
    const pending = rows.pending === key;
    const fresh = props.done === true && rows.ticked.has(key);
    const tick = () => {
        if (section === "plan" || section === "done_when") {
            rows.onTick(section, props.id);
        }
    };
    const className = ["mw-item", props.done === true ? "mw-item-done" : "",
        fresh ? "mw-item-ticked" : "", pending ? "mw-item-pending" : ""].join(" ");
    const close = () => setMode("view");
    return (
        <li className={className} data-id={key} aria-busy={pending}>
            {props.done !== null && (
                <input
                    type="checkbox"
                    className="mw-check"
                    checked={props.done}
                    disabled={pending}
                    aria-label={`${props.done ? "untick" : "tick"} ${props.text}`}
                    onChange={tick}
                />
            )}
            {mode === "view" ? (
                <ItemBody {...props} pending={pending} onMode={setMode} />
            ) : (
                <InlineForm
                    initial={mode === "edit" ? props.text : ""}
                    label={mode === "edit" ? "Edit item" : `Note to ${props.owner ?? "owner"}`}
                    placeholder={mode === "note" ? `A note to ${props.owner ?? "the owner"}…` : ""}
                    submit={mode === "edit" ? "save" : "send"}
                    onCancel={close}
                    onSubmit={(text) => {
                        if (mode === "edit") {
                            rows.onEdit(props.section, props.id, text);
                        } else {
                            rows.onNote(section, props.id, text);
                        }
                        close();
                    }}
                />
            )}
        </li>
    );
}

function ItemBody(props: {
    text: string;
    owner: string | null;
    time: string | null;
    number?: string;
    pending: boolean;
    onMode: (mode: "edit" | "note") => void;
}) {
    return (
        <>
            <button
                className="mw-item-text"
                disabled={props.pending}
                title={`${props.text}\n\nClick to edit.`}
                onClick={() => props.onMode("edit")}
            >
                {props.number !== undefined && <span className="mw-number">{props.number}</span>}
                <Inline text={props.text} />
            </button>
            <span className="mw-item-meta">
                {props.owner !== null && <Owner name={props.owner} />}
                {props.time !== null && <Clock value={props.time} />}
            </span>
            <span className="mw-item-actions">
                <button className="mw-ghost" onClick={() => props.onMode("edit")}>edit</button>
                {props.owner !== null && (
                    <button className="mw-ghost" onClick={() => props.onMode("note")}>
                        note
                    </button>
                )}
            </span>
        </>
    );
}

/** An input in place of the text: Enter saves, Escape cancels; Shift+Enter breaks a line. */
function InlineForm(props: {
    initial: string;
    label: string;
    placeholder: string;
    submit: string;
    multiline?: boolean;
    onSubmit: (text: string) => void;
    onCancel: () => void;
}) {
    const [draft, setDraft] = useState(props.initial);
    const send = (event?: FormEvent) => {
        event?.preventDefault();
        const text = draft.trim();
        if (text === "" || text === props.initial.trim()) {
            props.onCancel();
            return;
        }
        props.onSubmit(text);
    };
    const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === "Escape") {
            props.onCancel();
        }
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            send();
        }
    };
    return (
        <form className="mw-inline" onSubmit={send}>
            <textarea
                autoFocus
                aria-label={props.label}
                className="mw-inline-field"
                rows={props.multiline === true ? 4 : 1}
                value={draft}
                placeholder={props.placeholder}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={keys}
            />
            <span className="mw-inline-actions">
                <button className="primary" type="submit">{props.submit}</button>
                <button type="button" onClick={props.onCancel}>cancel</button>
            </span>
        </form>
    );
}


/**
 * A mission text with its `code` spans set in mono. The rest stays plain text: the file is
 * markdown, but an item is one line, and code spans are what the lead and the agents write.
 */
function Inline({ text }: { text: string }) {
    const parts = text.split("`");
    // An odd count of backticks leaves the last span open; then the text shows as written.
    if (parts.length % 2 === 0) {
        return <>{text}</>;
    }
    return (
        <>
            {parts.map((part, index) =>
                index % 2 === 1 ? <code key={index} className="mw-code">{part}</code> : part)}
        </>
    );
}

/** A free text that edits in place: the Goal. */
export function EditableText(props: {
    id: string;
    text: string;
    multiline?: boolean;
    empty: string;
    pending: boolean;
    onSave: (text: string) => void;
}) {
    const [editing, setEditing] = useState(false);
    const [expanded, setExpanded] = useState(false);
    if (editing) {
        return (
            <InlineForm
                initial={props.text}
                label={`Edit ${props.id}`}
                placeholder=""
                submit="save"
                multiline={props.multiline === true}
                onCancel={() => setEditing(false)}
                onSubmit={(text) => {
                    props.onSave(text);
                    setEditing(false);
                }}
            />
        );
    }
    // A long goal shows its first lines; the rest is one click away, so the Plan stays in view.
    const long = props.text.length > GOAL_CLAMP_CHARS;
    const clamped = long && !expanded;
    return (
        <>
            <button
                className={clamped ? "mw-text mw-clamped" : "mw-text"}
                disabled={props.pending}
                title="Click to edit"
                onClick={() => setEditing(true)}
            >
                {props.text === ""
                    ? <span className="mw-empty">{props.empty}</span>
                    : <Inline text={props.text} />}
            </button>
            {long && (
                <button className="mw-ghost mw-more" onClick={() => setExpanded(!expanded)}>
                    {expanded ? "show less" : "show all"}
                </button>
            )}
        </>
    );
}

export function RosterChip({ row, dot, onOpen }: {
    row: RosterRow;
    /** The rail's live dot (D14), before the name; absent on the plain chip. */
    dot?: ReactNode;
    /** Opens the agent in the Agents view (T6). */
    onOpen?: (() => void) | undefined;
}) {
    const hueOf = useHue();
    const blocked = isBlocked(row.blocked);
    const idle = row.doing === "" || row.doing === "—" || row.doing === "-";
    return (
        <li
            className={blocked ? "mw-agent mw-agent-blocked" : "mw-agent"}
            data-agent={row.agent}
            data-hue={hueOf(row.agent)}
            title={row.owns}
        >
            <span className="mw-agent-head">
                <span className="mw-agent-dot" />
                {dot}
                {onOpen === undefined ? (
                    <span className="mw-agent-name">{row.agent}</span>
                ) : (
                    <button
                        type="button"
                        className="mw-agent-name mw-agent-open"
                        title={`Open ${row.agent} in Agents`}
                        onClick={onOpen}
                    >
                        {row.agent}
                    </button>
                )}
                {blocked && <span className="pill pill-warn">blocked</span>}
                {row.updated !== "" && row.updated !== "—" && <Clock value={row.updated} />}
            </span>
            <span className={idle ? "mw-agent-doing mw-empty" : "mw-agent-doing"}>
                {idle ? "No task yet" : <Inline text={row.doing} />}
            </span>
            {blocked && row.blocked.toLowerCase() !== "yes" && (
                <span className="mw-agent-blocker">{row.blocked}</span>
            )}
        </li>
    );
}

export function isBlocked(value: string): boolean {
    const text = value.trim().toLowerCase();
    return text !== "" && text !== "no" && text !== "-" && text !== "—";
}

export function Questions(props: {
    questions: QuestionItem[];
    pending: string | null;
    onAnswer: (id: number, text: string) => void;
}) {
    const open = props.questions.filter((question) => question.answer === null).length;
    return (
        <Section
            section="open_questions"
            label="Open questions"
            className="mw-questions"
            count={props.questions.length === 0 ? undefined : `${open} open`}
        >
            {props.questions.length === 0 ? (
                <Empty text="The lead asks product calls here; you answer them in place." />
            ) : (
                <ul className="mw-list mw-question-list">
                    {props.questions.map((question) => (
                        <QuestionCard
                            key={question.id}
                            question={question}
                            pending={props.pending === itemKey("open_questions", question.id)}
                            onAnswer={props.onAnswer}
                        />
                    ))}
                </ul>
            )}
        </Section>
    );
}

function QuestionCard(props: {
    question: QuestionItem;
    pending: boolean;
    onAnswer: (id: number, text: string) => void;
}) {
    const { question } = props;
    const [draft, setDraft] = useState("");
    const asker = question.author ?? "the lead";
    const send = (event: FormEvent) => {
        event.preventDefault();
        const text = draft.trim();
        if (text !== "") {
            props.onAnswer(question.id, text);
            setDraft("");
        }
    };
    const answered = question.answer !== null;
    return (
        <li className={answered ? "mw-question mw-question-answered" : "mw-question"}
            data-id={itemKey("open_questions", question.id)} aria-busy={props.pending}>
            <span className="mw-question-head">
                {question.author !== null && <Owner name={question.author} />}
                {answered && <span className="pill pill-ok">answered</span>}
            </span>
            <p className="mw-question-text"><Inline text={question.text} /></p>
            {answered ? (
                <p className="mw-answer"><Inline text={question.answer ?? ""} /></p>
            ) : (
                <form className="mw-answer-form" onSubmit={send}>
                    <input
                        aria-label={`Answer ${question.id}`}
                        placeholder={`Answer ${asker}…`}
                        value={draft}
                        disabled={props.pending}
                        onChange={(event) => setDraft(event.target.value)}
                    />
                    <button className="primary" type="submit"
                        disabled={props.pending || draft.trim() === ""}>
                        answer
                    </button>
                </form>
            )}
        </li>
    );
}

export function Contracts({ contracts, rows }: { contracts: MissionLine[]; rows: RowContext }) {
    return (
        <Section section="contracts" label="Contracts" className="mw-contracts">
            {contracts.length === 0 ? (
                <Empty text="The lead records what the agents agree on here." />
            ) : (
                <ul className="mw-list mw-rows">
                    {contracts.map((contract) => (
                        <Item
                            key={contract.id}
                            section="contracts"
                            id={contract.id}
                            text={contract.text}
                            owner={contract.author}
                            time={contract.ts}
                            done={null}
                            rows={rows}
                        />
                    ))}
                </ul>
            )}
        </Section>
    );
}

/**
 * The Log, newest first. `log` comes in file order (oldest first). A line that arrives after
 * the first render fades in at the top; the feed's own scroll keeps the reader's place.
 */
export function LogFeed(props: {
    log: LogLine[];
    agents: string[];
    filter: string | null;
    onFilter: (agent: string | null) => void;
}) {
    const keyed = logKeys(props.log);
    const fresh = useArrivals(keyed.map((line) => line.key));
    const shown = keyed
        .filter((line) => props.filter === null || line.author === props.filter)
        .reverse();
    return (
        <section className="mw-section mw-log" data-section="log" aria-label="Log">
            <h3 className="mw-label">
                Log<span className="mw-count">{props.log.length}</span>
            </h3>
            {props.agents.length > 0 && <LogFilter {...props} />}
            {shown.length === 0 ? (
                <Empty text={props.filter === null
                    ? "Each change shows here as a line, newest first."
                    : `${props.filter} has no line in the Log yet.`} />
            ) : (
                <ol className="mw-feed">
                    {shown.map((line) => (
                        <li key={line.key}
                            className={fresh.has(line.key) ? "mw-line mw-line-new" : "mw-line"}>
                            <Clock value={line.ts} />
                            <Owner name={line.author} />
                            <span className="mw-line-text"><Inline text={line.text} /></span>
                        </li>
                    ))}
                </ol>
            )}
        </section>
    );
}

/** The agent filter over the feed: `all`, then one chip per roster agent in its colour. */
function LogFilter(props: {
    agents: string[];
    filter: string | null;
    onFilter: (agent: string | null) => void;
}) {
    const hueOf = useHue();
    return (
        <div className="mw-filter" role="group" aria-label="Filter the Log by agent">
            {[null, ...props.agents].map((agent) => (
                <button
                    key={agent ?? "all"}
                    className={`mw-filter-chip${props.filter === agent ? " mw-on" : ""}`}
                    aria-pressed={props.filter === agent}
                    data-hue={agent === null ? undefined : hueOf(agent)}
                    onClick={() => props.onFilter(agent)}
                >
                    {agent !== null && <span className="mw-owner-dot" />}
                    {agent ?? "all"}
                </button>
            ))}
        </div>
    );
}

/** A stable key per line: its content, and its count among equal lines before it. */
function logKeys(log: LogLine[]): (LogLine & { key: string })[] {
    const seen = new Map<string, number>();
    return log.map((line) => {
        const base = `${line.ts}|${line.author}|${line.text}`;
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        return { ...line, key: `${base}|${count}` };
    });
}

function Owner({ name }: { name: string }) {
    const hueOf = useHue();
    return (
        <span className="mw-owner" data-hue={hueOf(name)}>
            <span className="mw-owner-dot" />
            {name}
        </span>
    );
}

/** A time as `HH:MM`: a clock time stays as written; an ISO time shows in local time. */
function Clock({ value }: { value: string }) {
    return <time className="mw-time" dateTime={value} title={value}>{clock(value)}</time>;
}

export function clock(value: string): string {
    // Only a full ISO time converts; a clock time or a date (a Contracts line) stays as written.
    if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) {
        return value;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
}

/** The roster's names, in order: the first six agents get six different colours. */
export const AgentOrder = createContext<readonly string[]>([]);

/**
 * One of six agent colours, the same for a name everywhere in the view, so a hand-off reads at
 * a glance: the roster position when the name is on the roster, else a hash of the name.
 */
function useHue(): (name: string) => number {
    const agents = useContext(AgentOrder);
    return (name) => {
        const index = agents.indexOf(name);
        return index >= 0 ? index % 6 : hash(name) % 6;
    };
}

function hash(name: string): number {
    let sum = 0;
    for (let index = 0; index < name.length; index += 1) {
        sum = (sum * 31 + name.charCodeAt(index)) % 9973;
    }
    return sum;
}

function Empty({ text }: { text: string }) {
    return <p className="mw-empty">{text}</p>;
}
