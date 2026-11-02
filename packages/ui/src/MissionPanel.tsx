import { useEffect, useRef, useState } from "react";

import type { MissionSection } from "@spinner/protocol";

import {
    changedHeadings,
    OPERATOR_SECTIONS,
    parseMission,
    tableRows,
    type MissionPart,
    type ParsedMission,
} from "./mission.ts";
import { fetchMission, putMissionSection, useLoaded } from "./remote.ts";

export interface MissionPanelProps {
    dir: string;
    /** Moves when the daemon sends `mission.changed` for this session. */
    revision: number;
}

function Roster({ body }: { body: string }) {
    const [head, ...rows] = tableRows(body);
    if (head === undefined) {
        return <p className="muted">No agents on the roster.</p>;
    }
    return (
        <table className="roster">
            <thead>
                <tr>{head.map((cell, i) => <th key={i}>{cell}</th>)}</tr>
            </thead>
            <tbody>
                {rows.map((row, r) => {
                    const blocked = (row[3] ?? "").toLowerCase();
                    const stuck = blocked !== "" && blocked !== "no" && blocked !== "-";
                    return (
                        <tr key={r} className={stuck ? "roster-blocked" : "roster-row"}>
                            {row.map((cell, i) => <td key={i}>{cell}</td>)}
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}

function Editor(props: { dir: string; section: MissionSection; body: string; done: () => void }) {
    const [draft, setDraft] = useState(props.body);
    const [error, setError] = useState<string | null>(null);
    const save = () =>
        putMissionSection(props.dir, {
            section: props.section, mode: "replace", text: draft, author: "operator",
        }).then(props.done, (failure: unknown) => setError(String(failure)));
    return (
        <div className="section-edit">
            <textarea
                aria-label={`Edit ${props.section}`}
                value={draft}
                rows={6}
                onChange={(event) => setDraft(event.target.value)}
            />
            {error !== null && <p className="needs-human">{error}</p>}
            <span className="section-edit-actions">
                <button className="primary" onClick={() => void save()}>save</button>
                <button onClick={props.done}>cancel</button>
            </span>
        </div>
    );
}

function Section(props: { dir: string; part: MissionPart; flash: number }) {
    const [editing, setEditing] = useState(false);
    const { part } = props;
    const editable = part.section !== null && OPERATOR_SECTIONS.includes(part.section);
    return (
        <section
            className={props.flash > 0 ? "mission-section flash" : "mission-section"}
            // A new key restarts the one-shot CSS animation for a changed section.
            key={`${part.heading}:${props.flash}`}
            data-section={part.section ?? part.heading}
        >
            <h3>
                {part.heading}
                {editable && !editing && (
                    <button className="link" onClick={() => setEditing(true)}>edit</button>
                )}
            </h3>
            {editing && part.section !== null ? (
                <Editor
                    dir={props.dir}
                    section={part.section}
                    body={part.body}
                    done={() => setEditing(false)}
                />
            ) : part.section === "roster" ? (
                <Roster body={part.body} />
            ) : (
                <pre className="section-body">{part.body === "" ? "(empty)" : part.body}</pre>
            )}
        </section>
    );
}

/** The rendered MISSION.md. Goal and Done when are editable; every write goes to the daemon. */
export function MissionPanel({ dir, revision }: MissionPanelProps) {
    const loaded = useLoaded(`${dir}#${revision}`, (signal) => fetchMission(dir, signal));
    const previous = useRef<ParsedMission | null>(null);
    const [flashes, setFlashes] = useState<Record<string, number>>({});
    const mission = loaded.value === undefined ? null : parseMission(loaded.value);

    useEffect(() => {
        if (loaded.value === undefined) {
            return;
        }
        const next = parseMission(loaded.value);
        const changed = changedHeadings(previous.current, next);
        previous.current = next;
        if (changed.length > 0) {
            setFlashes((old) => {
                const bumped = { ...old };
                for (const heading of changed) {
                    bumped[heading] = (bumped[heading] ?? 0) + 1;
                }
                return bumped;
            });
        }
    }, [loaded.value]);

    if (loaded.error !== null) {
        return <p className="needs-human">{loaded.error}</p>;
    }
    if (mission === null) {
        return <p className="muted">Loading the mission…</p>;
    }
    return (
        <div className="mission" aria-label="Mission">
            <h2>{mission.title}</h2>
            {mission.parts.map((part) => (
                <Section
                    key={part.heading}
                    dir={dir}
                    part={part}
                    flash={flashes[part.heading] ?? 0}
                />
            ))}
        </div>
    );
}
