// The mission view of the middle pane: the workspace over the structured mission, with the raw
// MISSION.md behind a `source` toggle. This file owns the data and the actions; the look is
// `MissionWorkspaceView.tsx` (the props contract is under *Contracts* in the session's
// MISSION.md). Every write goes to the daemon: an edit or a tick through the section route,
// an answer as a steer to the asker, a note as an inbox message to the item's owner. Nothing
// changes here until `mission.changed` brings the new view.
import { useState } from "react";

import type { MissionSection, MissionView } from "@spinner/protocol";

import { postAgent } from "./events-client.ts";
import { Markdown } from "./Markdown.tsx";
import { MissionWorkspaceView, type TickSection } from "./MissionWorkspaceView.tsx";
import {
    fetchMission, fetchMissionView, postInbox, putMissionSection, useLoaded,
} from "./remote.ts";

export interface MissionWorkspaceProps {
    dir: string;
    /** Moves when the daemon sends `mission.changed` for this session. */
    revision: number;
    /** The view the last `mission.changed` carried, from state; undefined before the first. */
    view: MissionView | undefined;
    /** The agents the daemon hosts now; an answer steers only one of them. */
    running: readonly string[];
}

/** Who the UI writes as: the Log and the Contracts prefix lines with it. */
const AUTHOR = "operator";

/** The agent that owns the mission; a note on an item without an owner goes there. */
const LEAD = "lead";

const SECTION_LABEL: Record<MissionSection, string> = {
    goal: "Goal", done_when: "Done when", plan: "Plan", roster: "Roster",
    contracts: "Contracts", open_questions: "Open questions", log: "Log",
};

/** The write of one item: `<section>:<id>`, what the view disables while it runs. */
function key(section: MissionSection, id: number): string {
    return `${section}:${id}`;
}

/**
 * Runs the writes one at a time and keeps the last failure for the view. The result of a
 * write is never applied here: the daemon's `mission.changed` is what moves the view.
 */
function useWrites(): {
    pending: string | null;
    error: string | null;
    write: (item: string, action: () => Promise<unknown>) => void;
} {
    const [pending, setPending] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const write = (item: string, action: () => Promise<unknown>) => {
        setPending(item);
        setError(null);
        action().then(
            () => setPending(null),
            (failure: unknown) => {
                setPending(null);
                setError(String(failure));
            },
        );
    };
    return { pending, error, write };
}

export function MissionWorkspace({ dir, revision, view, running }: MissionWorkspaceProps) {
    const [source, setSource] = useState(false);
    const [filter, setFilter] = useState<string | null>(null);
    const writes = useWrites();
    // The route answers the first render; after that the event's view is the newer one.
    const loaded = useLoaded(`${dir}#${revision}`, (signal) => fetchMissionView(dir, signal));
    const raw = useLoaded(`${dir}#${revision}#${source ? "source" : ""}`, (signal) =>
        source ? fetchMission(dir, signal) : Promise.resolve(""),
    );
    const mission = view ?? loaded.value;

    const section = (body: Parameters<typeof putMissionSection>[1]) =>
        putMissionSection(dir, body);

    const onEdit = (target: MissionSection, id: number, text: string) => {
        if (target === "goal") {
            writes.write(key(target, 0), () =>
                section({ section: "goal", mode: "replace", text, author: AUTHOR }));
            return;
        }
        if (target === "plan" || target === "done_when") {
            writes.write(key(target, id), () => section({
                section: target, mode: "item", text: "", author: AUTHOR,
                item: { command: "edit", id, text },
            }));
            return;
        }
        writes.write(key(target, id), () =>
            Promise.reject(new Error(`${SECTION_LABEL[target]} is edited in the source view`)));
    };

    const onTick = (target: TickSection, id: number) => {
        const items = target === "plan" ? mission?.plan : mission?.done_when;
        const item = items?.find((candidate) => candidate.id === id);
        if (item === undefined) {
            return;
        }
        const command = item.state === "done" ? "untick" : "tick";
        writes.write(key(target, id), () => section({
            section: target, mode: "item", text: "", author: AUTHOR, item: { command, id },
        }));
    };

    // The answer steers the asker, and the Log keeps it so the workspace shows it too.
    const onAnswer = (questionId: number, text: string) => {
        const question = mission?.questions.find((candidate) => candidate.id === questionId);
        if (question === undefined) {
            return;
        }
        const asker = question.author ?? LEAD;
        writes.write(key("open_questions", questionId), async () => {
            if (!running.includes(asker)) {
                throw new Error(`${asker} is not running; the answer was not sent`);
            }
            await postAgent(`/sessions/${dir}/agents/${asker}/steer`, {
                text: `Answer to your question "${question.text}": ${text}`,
            });
            await section({
                section: "log", mode: "append", author: AUTHOR,
                text: `answered ${asker}'s question "${question.text}": ${text}`,
            });
        });
    };

    const onNote = (target: MissionSection, id: number, text: string) => {
        const owner = ownerOf(mission, target, id) ?? LEAD;
        writes.write(key(target, id), () => postInbox(dir, {
            from: AUTHOR, to: owner,
            subject: `note on ${SECTION_LABEL[target]} #${id}`,
            text,
        }));
    };

    if (loaded.error !== null && mission === undefined) {
        return <p className="needs-human">{loaded.error}</p>;
    }
    if (mission === undefined) {
        return <p className="muted">Loading the mission…</p>;
    }
    return (
        <div className="mission" aria-label="Mission">
            <div className="mission-head">
                <button
                    type="button"
                    className="link"
                    aria-pressed={source}
                    onClick={() => setSource(!source)}
                >
                    {source ? "workspace" : "source"}
                </button>
            </div>
            {source ? (
                raw.error !== null
                    ? <p className="needs-human">{raw.error}</p>
                    : <Markdown text={raw.value ?? ""} label="MISSION.md" />
            ) : (
                <MissionWorkspaceView
                    mission={mission}
                    agents={mission.roster.map((row) => row.agent)}
                    filter={filter}
                    pending={writes.pending}
                    error={writes.error}
                    onEdit={onEdit}
                    onTick={onTick}
                    onAnswer={onAnswer}
                    onNote={onNote}
                    onFilter={setFilter}
                />
            )}
        </div>
    );
}

/** The owner of a Plan or Done-when item, or the author of a question or a contract line. */
function ownerOf(
    mission: MissionView | undefined,
    section: MissionSection,
    id: number,
): string | null {
    if (mission === undefined) {
        return null;
    }
    switch (section) {
        case "plan":
            return mission.plan.find((item) => item.id === id)?.owner ?? null;
        case "done_when":
            return mission.done_when.find((item) => item.id === id)?.owner ?? null;
        case "open_questions":
            return mission.questions.find((item) => item.id === id)?.author ?? null;
        case "contracts":
            return mission.contracts.find((item) => item.id === id)?.author ?? null;
        default:
            return null;
    }
}
