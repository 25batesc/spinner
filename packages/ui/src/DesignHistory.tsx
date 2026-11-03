// The History tab of the design workspace (docs/designs/egm-adoption.md, entry 5.13, Technical
// Plan T14): the session's rounds, newest first, each earlier one with its PRs and its Log;
// then the doc's approvals with their rounds and hashes. The standing approval is `current`,
// or `invalidated` once the doc changed after it.
import { useState } from "react";

import type { RoundPr, SessionView } from "@spinner/protocol";

import {
    approvalRows, roundRows, timeLabel, type RoundRow,
} from "./design-workspace.ts";
import { MarkdownFile } from "./DesignFiles.tsx";
import { fetchRoundLog } from "./remote.ts";

export interface DesignHistoryProps {
    view: SessionView;
}

/** The characters of `sha256` an approval row shows. */
const HASH_SHOWN = 12;

function PrLink({ pr }: { pr: RoundPr }) {
    const name = `${pr.repo}#${pr.number}`;
    const day = pr.merged_at === null ? "" : ` ${pr.merged_at.slice(0, 10)}`;
    return (
        <span className="dw-pr">
            {pr.url === null ? (
                <span>{name}</span>
            ) : (
                <a href={pr.url} target="_blank" rel="noopener noreferrer">{name}</a>
            )}
            <span className="muted">
                {" "}{pr.state}{day}
            </span>
        </span>
    );
}

function RoundItem({ dir, row }: { dir: string; row: RoundRow }) {
    const [open, setOpen] = useState(false);
    const record = row.record;
    const span = record?.started !== null && record?.started !== undefined
        ? `${timeLabel(record.started)} – ${record.ended === null ? "" : timeLabel(record.ended)}`
        : null;
    return (
        <li className="dw-round" data-round={row.round}>
            <div className="dw-round-head">
                {row.current ? (
                    <span className="dw-round-name">r{row.round} (current)</span>
                ) : (
                    <button
                        type="button"
                        className="dw-round-name dw-round-toggle"
                        aria-expanded={open}
                        onClick={() => setOpen(!open)}
                    >
                        {open ? "▾" : "▸"} r{row.round}
                    </button>
                )}
                {row.branch !== null && <code className="muted">{row.branch}</code>}
                {record !== null && record.prs.length === 0 && (
                    <span className="muted">no PR</span>
                )}
                {record?.prs.map((pr) => <PrLink key={`${pr.repo}#${pr.number}`} pr={pr} />)}
                {span !== null && <span className="muted dw-round-span">{span}</span>}
            </div>
            {open && (
                <div className="dw-round-log">
                    <MarkdownFile
                        loadKey={`${dir}#round-log#${row.round}`}
                        read={(signal) => fetchRoundLog(dir, row.round, signal)}
                        label={`Log of round ${row.round}`}
                    />
                </div>
            )}
        </li>
    );
}

export function DesignHistory({ view }: DesignHistoryProps) {
    const design = view.design;
    const dir = view.summary.dir;
    const rounds = roundRows(view);
    const approvals = design === undefined ? [] : approvalRows(design);
    if (rounds.length === 1 && approvals.length === 0) {
        return <p className="muted dw-empty">Round 1, no approval yet.</p>;
    }
    return (
        <div className="dw-tab-body dw-history">
            <section aria-label="Rounds">
                <h3 className="dw-label">Rounds</h3>
                <ul className="dw-rounds">
                    {rounds.map((row) => <RoundItem key={row.round} dir={dir} row={row} />)}
                </ul>
            </section>
            <section aria-label="Approvals">
                <h3 className="dw-label">Approvals</h3>
                {approvals.length === 0 ? (
                    <p className="muted">No approval yet.</p>
                ) : (
                    <ul className="dw-approvals">
                        {approvals.map(({ approval, mark }) => (
                            <li
                                key={`${approval.at}:${approval.sha256}`}
                                className="dw-approval"
                                data-mark={mark ?? undefined}
                            >
                                <span className="dw-round-name">r{approval.round}</span>
                                <span className="muted">{timeLabel(approval.at)}</span>
                                <code title={approval.sha256}>
                                    {approval.sha256.slice(0, HASH_SHOWN)}
                                </code>
                                <code className="muted">{approval.path}</code>
                                <span className="muted">
                                    {approval.blockers} listed blocker
                                    {approval.blockers === 1 ? "" : "s"}
                                </span>
                                {mark === "current" && (
                                    <span className="pill pill-ok">current</span>
                                )}
                                {mark === "invalidated" && (
                                    <span className="pill pill-warn">invalidated</span>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}
