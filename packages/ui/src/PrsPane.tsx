// The PRs view of the sidebar (docs/designs/talk-change-ship.md, 2.9): every pull request
// Spinner opened, across sessions. The open ones come first, those that need the operator
// at the top; the finished ones follow. A row opens its session; the number links to GitHub.
import type { SessionView } from "@spinner/protocol";

import { checksText, diffText, prRows, stateTone, threadsText, type PrRow } from "./changes.ts";

export interface PrsPaneProps {
    sessions: readonly [string, SessionView][];
    selected: string | undefined;
    onSelect: (dir: string) => void;
}

function Row({ row, selected, onSelect }: {
    row: PrRow;
    selected: boolean;
    onSelect: (dir: string) => void;
}) {
    const { pr, change } = row;
    const facts = [checksText(pr), threadsText(pr), diffText(pr)].filter((text) => text !== "");
    const done = pr.state === "merged" || pr.state === "closed";
    return (
        <li className="pr-row-item">
            <button
                className={selected ? "pr-row pr-row-selected" : "pr-row"}
                data-dir={row.dir}
                data-tone={stateTone(change.state)}
                onClick={() => onSelect(row.dir)}
                title={`${row.session} · ${change.branch}`}
            >
                <span className="pr-row-head">
                    <span className="dot change-dot" aria-hidden="true" />
                    <strong className="pr-row-title">{pr.title ?? change.title}</strong>
                </span>
                <span className="muted pr-row-meta">
                    {pr.url === null ? (
                        <span>{pr.repo} #{pr.number}</span>
                    ) : (
                        <a
                            href={pr.url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(event) => event.stopPropagation()}
                        >
                            {pr.repo} #{pr.number}
                        </a>
                    )}
                    {" · "}
                    {done ? pr.state : change.state}
                    {facts.length > 0 && ` · ${facts.join(" · ")}`}
                </span>
                {!done && change.needs_human !== null && (
                    <span className="needs-human pr-row-needs">{change.needs_human}</span>
                )}
                <span className="muted pr-row-session">{row.session}</span>
            </button>
        </li>
    );
}

export function PrsPane({ sessions, selected, onSelect }: PrsPaneProps) {
    const rows = prRows(sessions);
    const key = (row: PrRow) => `${row.dir}#${row.change.id}#${row.pr.repo}#${row.pr.number}`;
    const list = (items: PrRow[]) =>
        items.map((row) => (
            <Row key={key(row)} row={row} selected={row.dir === selected} onSelect={onSelect} />
        ));
    return (
        <section className="pane prs-pane" aria-label="Pull requests">
            {rows.open.length === 0 && rows.finished.length === 0 && (
                <p className="muted">No pull request yet. A session's agent opens them.</p>
            )}
            <ul className="pr-rows">{list(rows.open)}</ul>
            {rows.finished.length > 0 && (
                <>
                    <h3 className="muted pr-rows-heading">Merged and closed</h3>
                    <ul className="pr-rows pr-rows-finished">{list(rows.finished)}</ul>
                </>
            )}
        </section>
    );
}
