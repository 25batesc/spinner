import type { Session } from "@spinner/protocol";

export interface SessionsPaneProps {
    sessions: [string, Session][];
    selected: string | undefined;
    onSelect: (dir: string) => void;
}

function stackBadge(session: Session): string {
    return session.stack.state === "none" ? "no stack" : `stack ${session.stack.state}`;
}

export function SessionsPane({ sessions, selected, onSelect }: SessionsPaneProps) {
    return (
        <section className="pane sessions-pane" aria-label="Sessions">
            <h2>Sessions</h2>
            <ul className="session-list">
                {sessions.map(([dir, session]) => (
                    <li key={dir}>
                        <button
                            className={dir === selected ? "session session-selected" : "session"}
                            onClick={() => onSelect(dir)}
                        >
                            <strong>{session.title}</strong>
                            <span className="muted">{dir}</span>
                            <span className="badges">
                                <span className="badge">{session.stage}</span>
                                <span className="badge">{stackBadge(session)}</span>
                            </span>
                            {session.needs_human !== null && (
                                <span className="needs-human">{session.needs_human}</span>
                            )}
                        </button>
                    </li>
                ))}
                {sessions.length === 0 && <li className="muted">No sessions yet.</li>}
            </ul>
            <button className="new-session" disabled title="Needs the daemon: POST /sessions">
                new session
            </button>
        </section>
    );
}
