// The Linear tickets view of the sidebar (the operator's ask of 2026-11-24): every ticket of
// the pull requests Spinner follows, across sessions, by unit of work. A unit with several
// pull requests shows its parent ticket over them. Each ticket carries its Linear state and
// where its pull request stands, so the list reads as the work being finished. A row opens
// its session; the ticket id links to Linear and the pull request to GitHub.
import type { MouseEvent } from "react";

import type { LinearTicket, SessionView } from "@spinner/protocol";

import { ticketUnits, type TicketRow, type TicketUnit } from "./changes.ts";

export interface TicketsPaneProps {
    sessions: readonly [string, SessionView][];
    selected: string | undefined;
    onSelect: (dir: string) => void;
}

/** A click on a link inside a row follows the link and does not open the session. */
function stay(event: MouseEvent): void {
    event.stopPropagation();
}

function TicketLink({ ticket }: { ticket: LinearTicket }) {
    return (
        <a
            className="ticket-id"
            href={ticket.url}
            target="_blank"
            rel="noreferrer"
            title={`${ticket.identifier} in Linear: ${ticket.state}`}
            onClick={stay}
        >
            {ticket.identifier}
        </a>
    );
}

function Ticket({ row }: { row: TicketRow }) {
    const { ticket, pr } = row;
    return (
        <span className="ticket-line">
            <TicketLink ticket={ticket} />
            <span className="ticket-title" title={ticket.title}>{ticket.title}</span>
            <span className="muted ticket-facts">
                {ticket.state}
                {pr !== null && (
                    <>
                        {" · "}
                        <a href={pr.url} target="_blank" rel="noreferrer" onClick={stay}>
                            {pr.name}
                        </a>
                        {" · "}
                        <span data-tone={pr.status.tone} title={pr.status.title}>
                            {pr.status.text}
                        </span>
                    </>
                )}
            </span>
        </span>
    );
}

function Unit({ unit, selected, onSelect }: {
    unit: TicketUnit;
    selected: boolean;
    onSelect: (dir: string) => void;
}) {
    return (
        <li className="pr-row-item">
            <div
                role="button"
                tabIndex={0}
                className={selected ? "pr-row pr-row-selected ticket-unit" : "pr-row ticket-unit"}
                data-dir={unit.dir}
                onClick={() => onSelect(unit.dir)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        onSelect(unit.dir);
                    }
                }}
            >
                {unit.parent !== null && (
                    <span className="ticket-line ticket-parent">
                        <TicketLink ticket={unit.parent} />
                        <strong className="ticket-title">{unit.parent.title}</strong>
                        <span className="muted ticket-facts">{unit.parent.state}</span>
                    </span>
                )}
                <span className="ticket-rows" data-children={unit.parent !== null}>
                    {unit.rows.map((row) => <Ticket key={row.ticket.id} row={row} />)}
                </span>
                <span className="muted pr-row-session">{unit.session}</span>
            </div>
        </li>
    );
}

export function TicketsPane({ sessions, selected, onSelect }: TicketsPaneProps) {
    const units = ticketUnits(sessions);
    const list = (items: TicketUnit[]) =>
        items.map((unit) => (
            <Unit key={unit.key} unit={unit} selected={unit.dir === selected} onSelect={onSelect} />
        ));
    return (
        <section className="pane prs-pane" aria-label="Linear tickets">
            {units.open.length === 0 && units.done.length === 0 && (
                <p className="muted">
                    No ticket yet. Spinner makes one when a pull request opens, for a project
                    whose <code>spinner.yaml</code> names a Linear team.
                </p>
            )}
            <ul className="pr-rows">{list(units.open)}</ul>
            {units.done.length > 0 && (
                <>
                    <h3 className="muted pr-rows-heading">Merged and closed</h3>
                    <ul className="pr-rows pr-rows-finished">{list(units.done)}</ul>
                </>
            )}
        </section>
    );
}
