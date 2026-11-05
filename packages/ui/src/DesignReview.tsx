// The Review tab of the design workspace (docs/designs/egm-adoption.md, entry 5.9, review
// M21): the stages 5 to 9 of `egm-review` with `written` or `not yet`, the consolidated and
// the resolve report, and the Goldfish of the review step with their cost. A click renders a
// report as markdown; the daemon does not parse findings, and neither does the UI. A run
// selector reads an archived run through `…/design/reviews/:run/:name`. While the resolve card
// shows (entry 3.21), one line above the report opens Agents, where the card is
// (session-workspace.md, K1). The tab's header carries the `approve` primary at
// `design-ready` or after a doc change invalidated the approval (T5), so Approve is a state
// of this tab and not a tab of its own (D12).
import { useState } from "react";

import type { SessionView } from "@spinner/protocol";

import { ApproveDesign } from "./ApproveDesign.tsx";
import { formatUsd } from "./costs.ts";
import { primaryAction, showResolveCard } from "./design.ts";
import { stageRows, type StageRow } from "./design-workspace.ts";
import { MarkdownFile } from "./DesignFiles.tsx";
import { DesignGate } from "./DesignGate.tsx";
import { fetchDesignFile, fetchDesignFiles, fetchReviewFile, useLoaded } from "./remote.ts";

export interface DesignReviewProps {
    view: SessionView;
    /** The workspace's reload key (entry 5.6). */
    reload: string;
    /** The session's `needs_human`: the resolve card shows on its resolve line. */
    needs: string | null;
    /** Opens the Agents view with the lead picked, where the resolve card is. */
    onOpenAgent: (name: string) => void;
}

/** The approve primary's tooltip (egm-adoption.md D2, D5). */
const APPROVE_TIP = "Approve the design doc; the dialog starts the build by default.";

/**
 * The header's `approve design` primary, which opens the approve dialog (entry 6.16), at
 * `design-ready` and after a doc change invalidated the approval.
 */
function ApproveHeader({ view }: { view: SessionView }) {
    const [open, setOpen] = useState(false);
    const design = view.design;
    if (design === undefined) {
        return null;
    }
    const primary = primaryAction(design);
    const changed = design.changed_after_approval;
    if (primary?.kind !== "approve" && !changed) {
        return null;
    }
    const label = primary?.kind === "approve" ? primary.label : "re-approve design";
    return (
        <div className="dw-approve-head">
            <span className="muted">
                {changed ? "Changed since approval" : "The review is done"}
            </span>
            <button
                type="button"
                className="primary dw-approve"
                title={APPROVE_TIP}
                onClick={() => setOpen(true)}
            >
                {label}
            </button>
            {open && <ApproveDesign view={view} onClose={() => setOpen(false)} />}
        </div>
    );
}

/** The run selector's value for the current run, which reads `<session>/design/`. */
const CURRENT = "current";

/**
 * The report shown when nobody picked one: the consolidated report, the review's output, when
 * the run may have it; else the newest written row; else none.
 */
function firstShown(rows: readonly StageRow[]): string | null {
    const written = rows.filter((row) => row.written !== false);
    const consolidated = written.find((row) => row.id === "consolidated");
    return consolidated?.file ?? written[written.length - 1]?.file ?? null;
}

function statusOf(row: StageRow): { label: string; className: string } {
    if (row.written === null) {
        return { label: "archived", className: "pill" };
    }
    return row.written
        ? { label: "written", className: "pill pill-ok" }
        : { label: "not yet", className: "pill" };
}

export function DesignReview({ view, reload, needs, onOpenAgent }: DesignReviewProps) {
    const design = view.design;
    const dir = view.summary.dir;
    const [run, setRun] = useState(CURRENT);
    const [picked, setPicked] = useState<string | null>(null);
    const runs = useLoaded(`${reload}#runs`, (signal) => fetchDesignFiles(dir, signal));
    if (design === undefined) {
        return null;
    }
    const archived = runs.value?.review_runs ?? [];
    const current = run === CURRENT || !archived.includes(run);
    const rows = stageRows(design, current);
    const shown = rows.some((row) => row.file === picked && row.written !== false)
        ? picked
        : firstShown(rows);
    const goldfish = design.goldfish.filter((fish) => fish.design_step === "review");
    const reviewUsd = design.cost_by_stage.review;
    const pick = (next: string) => {
        setRun(next);
        setPicked(null);
    };
    return (
        <div className="dw-tab-body">
            <ApproveHeader view={view} />
            {showResolveCard(design, needs) && (
                <DesignGate key="resolve" kind="resolve" compact onOpenAgent={onOpenAgent} />
            )}
            <div className="dw-review-head">
                <label className="dw-run">
                    <span className="muted">Run</span>
                    <select
                        aria-label="Review run"
                        value={current ? CURRENT : run}
                        onChange={(event) => pick(event.target.value)}
                    >
                        <option value={CURRENT}>
                            {design.review_run === null
                                ? "current"
                                : `${design.review_run.id} (current)`}
                        </option>
                        {archived.map((id) => (
                            <option key={id} value={id}>{id}</option>
                        ))}
                    </select>
                </label>
                {reviewUsd !== undefined && (
                    <span className="muted" title="The Goldfish cost of the review step">
                        Goldfish {formatUsd(reviewUsd)}
                    </span>
                )}
            </div>
            <div className="dw-split">
                <div className="dw-side">
                    <ul className="dw-list" aria-label="Review stages">
                        {rows.map((row) => {
                            const status = statusOf(row);
                            return (
                                <li key={row.id}>
                                    <button
                                        type="button"
                                        className="dw-row"
                                        aria-pressed={row.file === shown}
                                        disabled={row.written === false}
                                        data-stage={row.id}
                                        title={row.file}
                                        onClick={() => setPicked(row.file)}
                                    >
                                        <span className="dw-row-name">{row.label}</span>
                                        <span className={status.className}>{status.label}</span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                    {current && goldfish.length > 0 && (
                        <ul className="dw-goldfish" aria-label="Review Goldfish">
                            {goldfish.map((fish) => (
                                <li
                                    key={`${fish.run}/${fish.step}`}
                                    className="dw-goldfish-row"
                                    title={fish.model ?? fish.agent}
                                >
                                    <span className={`dot dot-${fish.state}`} />
                                    <span className="dw-row-name">
                                        {fish.persona ?? fish.agent}
                                    </span>
                                    <span className="muted">{fish.state}</span>
                                    <span className="muted">{formatUsd(fish.usd)}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                <div className="dw-body">
                    {shown === null ? (
                        <p className="muted dw-empty">
                            No review report yet. Start with <code>review design</code>.
                        </p>
                    ) : (
                        <MarkdownFile
                            loadKey={`${reload}#review#${current ? CURRENT : run}#${shown}`}
                            read={(signal) => current
                                ? fetchDesignFile(dir, shown, signal)
                                : fetchReviewFile(dir, run, shown, signal)}
                            label={shown}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}
