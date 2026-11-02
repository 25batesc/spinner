// The mission workspace's look: the Goal card and the Done-when checklist, the Plan board in
// three columns, the Roster as chips, the Open questions with an answer box, the Contracts, and
// the Log as a feed, newest first. The view never fetches and never writes: `MissionWorkspace`
// owns the data and maps each callback to the section route or the inbox (the props contract
// under *Contracts* in the session's MISSION.md). The view keeps look state only: the item in
// edit, the draft, and which items arrived after the first render, for the one-shot animations.
import { useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";

import type { MissionSection } from "@spinner/protocol";

import "./mission-workspace.css";

// A local copy of the structured mission from the props contract. It goes when the ui agent
// commits `mission-view.ts`; the view then imports `MissionView` from there.
export type PlanState = "next" | "doing" | "done";
export interface MissionPlanItem {
    id: string;
    text: string;
    owner: string | null;
    state: PlanState;
    ticked_at: string | null;
}
export interface MissionDoneItem {
    id: string;
    text: string;
    owner: string | null;
    state: "open" | "done";
    ticked_at: string | null;
}
export interface MissionRosterRow {
    agent: string;
    owns: string;
    doing: string;
    blocked: string;
    updated: string;
}
export interface MissionContract { id: string; text: string }
export interface MissionQuestion {
    id: string;
    text: string;
    author: string | null;
    answer: string | null;
}
export interface MissionLogLine { ts: string; author: string; text: string }
export interface MissionView {
    title: string;
    goal: string;
    done_when: MissionDoneItem[];
    plan: MissionPlanItem[];
    roster: MissionRosterRow[];
    contracts: MissionContract[];
    questions: MissionQuestion[];
    log: MissionLogLine[];
}

export interface MissionWorkspaceViewProps {
    mission: MissionView;
    /** The roster names, for the Log filter and the owner chips. */
    agents: string[];
    /** The Log's agent; null shows every line. */
    filter: string | null;
    /** The id of the item whose write is in flight; the view disables it. */
    pending: string | null;
    /** The last failed write. */
    error: string | null;
    onEdit(section: MissionSection, id: string, text: string): void;
    /** A plan or done_when item: done ↔ open. */
    onTick(id: string): void;
    onAnswer(questionId: string, text: string): void;
    onNote(id: string, text: string): void;
    onFilter(agent: string | null): void;
}

const PLAN_COLUMNS: { state: PlanState; label: string; empty: string }[] = [
    { state: "next", label: "Next", empty: "The lead writes the next steps here." },
    { state: "doing", label: "Doing", empty: "Items move here when an agent starts them." },
    { state: "done", label: "Done", empty: "Ticked items land here with their time." },
];

/** The workspace: everything the operator reads in ten seconds, top to bottom. */
export function MissionWorkspaceView(props: MissionWorkspaceViewProps) {
    const { mission } = props;
    const ticked = useArrivals(doneKeys(mission));
    const rows: RowContext = { ...props, ticked };
    return (
        <div className="mw" aria-label="Mission workspace">
            {props.error !== null && <p className="mw-error" role="alert">{props.error}</p>}
            <div className="mw-grid">
                <div className="mw-main">
                    <div className="mw-top">
                        <GoalCard mission={mission} rows={rows} />
                        <DoneWhen items={mission.done_when} rows={rows} />
                    </div>
                    <PlanBoard plan={mission.plan} rows={rows} />
                    <Roster roster={mission.roster} />
                    <div className="mw-pair">
                        <Questions
                            questions={mission.questions}
                            pending={props.pending}
                            onAnswer={props.onAnswer}
                        />
                        <Contracts contracts={mission.contracts} rows={rows} />
                    </div>
                </div>
                <LogFeed
                    log={mission.log}
                    agents={props.agents}
                    filter={props.filter}
                    onFilter={props.onFilter}
                />
            </div>
        </div>
    );
}

/** What every row needs from the view: the callbacks, the pending id, the fresh ticks. */
interface RowContext extends MissionWorkspaceViewProps {
    ticked: ReadonlySet<string>;
}

function doneKeys(mission: MissionView): string[] {
    const plan = mission.plan.filter((item) => item.state === "done");
    const done = mission.done_when.filter((item) => item.state === "done");
    return [...plan, ...done].map((item) => item.id);
}

/**
 * The keys that were not there at the first render. A row with a fresh key mounts with its
 * one-shot animation class; the class stays, so a later render does not replay it.
 */
function useArrivals(keys: string[]): ReadonlySet<string> {
    const initial = useRef<ReadonlySet<string> | null>(null);
    if (initial.current === null) {
        initial.current = new Set(keys);
    }
    const known = initial.current;
    return new Set(keys.filter((key) => !known.has(key)));
}

function Section(props: {
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

function GoalCard({ mission, rows }: { mission: MissionView; rows: RowContext }) {
    return (
        <section className="mw-section mw-goal" data-section="goal" aria-label="Goal">
            <h3 className="mw-label">Goal</h3>
            <h2 className="mw-title">{mission.title}</h2>
            <EditableText
                id="goal"
                text={mission.goal}
                multiline
                empty="The lead writes the goal here from the first message."
                pending={rows.pending === "goal"}
                onSave={(text) => rows.onEdit("goal", "goal", text)}
            />
        </section>
    );
}

function DoneWhen({ items, rows }: { items: MissionDoneItem[]; rows: RowContext }) {
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

function PlanBoard({ plan, rows }: { plan: MissionPlanItem[]; rows: RowContext }) {
    const done = plan.filter((item) => item.state === "done").length;
    return (
        <Section
            section="plan"
            label="Plan"
            className="mw-plan"
            count={plan.length === 0 ? undefined : `${done} / ${plan.length}`}
        >
            <div className="mw-board">
                {PLAN_COLUMNS.map((column) => {
                    const items = plan.filter((item) => item.state === column.state);
                    return (
                        <div
                            key={column.state}
                            className="mw-column"
                            data-state={column.state}
                            aria-label={column.label}
                        >
                            <h4 className="mw-column-head">
                                <span className="mw-column-dot" />
                                {column.label}
                                <span className="mw-count">{items.length}</span>
                            </h4>
                            {items.length === 0 ? (
                                <Empty text={column.empty} />
                            ) : (
                                <ul className="mw-list mw-cards">
                                    {items.map((item) => (
                                        <PlanCard key={item.id} item={item} rows={rows} />
                                    ))}
                                </ul>
                            )}
                        </div>
                    );
                })}
            </div>
        </Section>
    );
}

function PlanCard({ item, rows }: { item: MissionPlanItem; rows: RowContext }) {
    return (
        <Item
            section="plan"
            id={item.id}
            number={item.id}
            text={item.text}
            owner={item.owner}
            time={item.state === "done" ? item.ticked_at : null}
            done={item.state === "done"}
            rows={rows}
        />
    );
}

/**
 * One item: the box, the text (a click edits it in place), the owner chip and the time. Under
 * the pointer the edit and note actions show. A note goes to the owner's inbox.
 */
function Item(props: {
    section: MissionSection;
    id: string;
    text: string;
    owner: string | null;
    time: string | null;
    done: boolean | null;
    number?: string;
    rows: RowContext;
}) {
    const { rows } = props;
    const [mode, setMode] = useState<"view" | "edit" | "note">("view");
    const pending = rows.pending === props.id;
    const fresh = props.done === true && rows.ticked.has(props.id);
    const className = ["mw-item", props.done === true ? "mw-item-done" : "",
        fresh ? "mw-item-ticked" : "", pending ? "mw-item-pending" : ""].join(" ");
    const close = () => setMode("view");
    return (
        <li className={className} data-id={props.id} aria-busy={pending}>
            {props.done !== null && (
                <input
                    type="checkbox"
                    className="mw-check"
                    checked={props.done}
                    disabled={pending}
                    aria-label={`${props.done ? "untick" : "tick"} ${props.text}`}
                    onChange={() => rows.onTick(props.id)}
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
                            rows.onNote(props.id, text);
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
                title="Click to edit"
                onClick={() => props.onMode("edit")}
            >
                {props.number !== undefined && <span className="mw-number">{props.number}</span>}
                {props.text}
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

/** A free text that edits in place: the Goal. */
function EditableText(props: {
    id: string;
    text: string;
    multiline?: boolean;
    empty: string;
    pending: boolean;
    onSave: (text: string) => void;
}) {
    const [editing, setEditing] = useState(false);
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
    return (
        <button
            className="mw-text"
            disabled={props.pending}
            title="Click to edit"
            onClick={() => setEditing(true)}
        >
            {props.text === "" ? <span className="mw-empty">{props.empty}</span> : props.text}
        </button>
    );
}

function Roster({ roster }: { roster: MissionRosterRow[] }) {
    return (
        <Section section="roster" label="Roster" className="mw-roster">
            {roster.length === 0 ? (
                <Empty text="The lead adds agents here when the work splits." />
            ) : (
                <ul className="mw-agents">
                    {roster.map((row) => <RosterChip key={row.agent} row={row} />)}
                </ul>
            )}
        </Section>
    );
}

function RosterChip({ row }: { row: MissionRosterRow }) {
    const blocked = isBlocked(row.blocked);
    const idle = row.doing === "" || row.doing === "—" || row.doing === "-";
    return (
        <li
            className={blocked ? "mw-agent mw-agent-blocked" : "mw-agent"}
            data-agent={row.agent}
            data-hue={hue(row.agent)}
            title={row.owns}
        >
            <span className="mw-agent-head">
                <span className="mw-agent-dot" />
                <span className="mw-agent-name">{row.agent}</span>
                {blocked && <span className="pill pill-warn">blocked</span>}
                {row.updated !== "" && row.updated !== "—" && <Clock value={row.updated} />}
            </span>
            <span className={idle ? "mw-agent-doing mw-empty" : "mw-agent-doing"}>
                {idle ? "No task yet" : row.doing}
            </span>
            {blocked && row.blocked.toLowerCase() !== "yes" && (
                <span className="mw-agent-blocker">{row.blocked}</span>
            )}
        </li>
    );
}

function isBlocked(value: string): boolean {
    const text = value.trim().toLowerCase();
    return text !== "" && text !== "no" && text !== "-" && text !== "—";
}

function Questions(props: {
    questions: MissionQuestion[];
    pending: string | null;
    onAnswer: (id: string, text: string) => void;
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
                            pending={props.pending === question.id}
                            onAnswer={props.onAnswer}
                        />
                    ))}
                </ul>
            )}
        </Section>
    );
}

function QuestionCard(props: {
    question: MissionQuestion;
    pending: boolean;
    onAnswer: (id: string, text: string) => void;
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
            data-id={question.id} aria-busy={props.pending}>
            <span className="mw-question-head">
                {question.author !== null && <Owner name={question.author} />}
                {answered && <span className="pill pill-ok">answered</span>}
            </span>
            <p className="mw-question-text">{question.text}</p>
            {answered ? (
                <p className="mw-answer">{question.answer}</p>
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

function Contracts({ contracts, rows }: { contracts: MissionContract[]; rows: RowContext }) {
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
                            owner={null}
                            time={null}
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
function LogFeed(props: {
    log: MissionLogLine[];
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
            <div className="mw-filter" role="group" aria-label="Filter the Log by agent">
                {[null, ...props.agents].map((agent) => (
                    <button
                        key={agent ?? "all"}
                        className={`mw-filter-chip${props.filter === agent ? " mw-on" : ""}`}
                        aria-pressed={props.filter === agent}
                        data-hue={agent === null ? undefined : hue(agent)}
                        onClick={() => props.onFilter(agent)}
                    >
                        {agent !== null && <span className="mw-owner-dot" />}
                        {agent ?? "all"}
                    </button>
                ))}
            </div>
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
                            <span className="mw-line-text">{line.text}</span>
                        </li>
                    ))}
                </ol>
            )}
        </section>
    );
}

/** A stable key per line: its content, and its count among equal lines before it. */
function logKeys(log: MissionLogLine[]): (MissionLogLine & { key: string })[] {
    const seen = new Map<string, number>();
    return log.map((line) => {
        const base = `${line.ts}|${line.author}|${line.text}`;
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        return { ...line, key: `${base}|${count}` };
    });
}

function Owner({ name }: { name: string }) {
    return (
        <span className="mw-owner" data-hue={hue(name)}>
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
    if (/^\d{1,2}:\d{2}$/.test(value)) {
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

/** One of six agent colours, the same for a name everywhere, so a hand-off reads at a glance. */
export function hue(name: string): number {
    let sum = 0;
    for (let index = 0; index < name.length; index += 1) {
        sum = (sum * 31 + name.charCodeAt(index)) % 9973;
    }
    return sum % 6;
}

function Empty({ text }: { text: string }) {
    return <p className="mw-empty">{text}</p>;
}
