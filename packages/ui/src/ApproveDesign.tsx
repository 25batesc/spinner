// The approve dialog (docs/designs/egm-adoption.md, entry 6.16, D2, D5, Technical Plan T10).
// It names the doc and, after an edit invalidated the approval, lists each changed `## `
// section with its approved and current text side by side. `start the build` is checked by
// default, so the confirm reads `approve and build`. A 409 that names listed blockers turns
// the confirm into `approve with <N> listed blockers`, which posts again with
// `blockers_confirmed: N`. The `session.updated` that follows moves the step marks. The
// response carries the seed's counts (session-workspace.md T4, entry 2.22): the dialog shows
// `23 added, 2 kept, 0 stale, 0 orphaned` for `SEED_SHOWN_MS` before it closes, or at once
// when the build is off; a 409 from the seed checks shows its text as the other refusals do.
import { useEffect, useState } from "react";

import type { DesignChange, SeedResult, SessionView } from "@spinner/protocol";

import { approveLabel, blockersLabel, blockersLine } from "./design.ts";
import { ApproveRefused, fetchDesignChanges, postDesignApprove, useLoaded } from "./remote.ts";

export interface ApproveDesignProps {
    /** A session with a `design` block. */
    view: SessionView;
    onClose: () => void;
}

/** How long the seed counts show before the dialog closes after `approve and build`. */
export const SEED_SHOWN_MS = 1000;

/** `23 added, 2 kept, 0 stale, 0 orphaned`: the seed's counts on one line. */
export function seedLine(seed: SeedResult): string {
    return `${seed.added} added, ${seed.kept} kept, ${seed.stale.length} stale, ` +
        `${seed.orphaned.length} orphaned`;
}

export function ApproveDesign({ view, onClose }: ApproveDesignProps) {
    const design = view.design;
    const dir = view.summary.dir;
    const [build, setBuild] = useState(true);
    // The listed blockers of the last 409, which the second confirm posts back; null before.
    const [listed, setListed] = useState<number | null>(null);
    const [posting, setPosting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The seed counts of the accepted approval; the dialog closes once they were shown.
    const [seed, setSeed] = useState<SeedResult | null>(null);
    const changed = design?.changed_after_approval === true;
    const title = changed ? "Re-approve the design" : "Approve the design";
    useEffect(() => {
        if (seed === null) {
            return;
        }
        if (!build) {
            onClose();
            return;
        }
        const timer = setTimeout(onClose, SEED_SHOWN_MS);
        return () => clearTimeout(timer);
        // `onClose` and `build` are read once the seed arrives.
    }, [seed]);

    const approve = () => {
        setPosting(true);
        setError(null);
        const body = listed === null ? { build } : { build, blockers_confirmed: listed };
        postDesignApprove(dir, body).then(
            (response) => {
                setPosting(false);
                setSeed(response.seed);
            },
            (failure: unknown) => {
                setPosting(false);
                const count = failure instanceof ApproveRefused ? failure.blockers : null;
                if (count !== null && count > 0 && count !== listed) {
                    setListed(count);
                    return;
                }
                setError(failure instanceof Error ? failure.message : String(failure));
            },
        );
    };
    return (
        <div
            className={`confirm approve-dialog${changed ? " approve-dialog-wide" : ""}`}
            role="dialog"
            aria-label={title}
        >
            <h3>{title}</h3>
            <p className="approve-doc">
                <span className="field-label">design doc</span>{" "}
                <code>{design?.doc ?? "none yet"}</code>
            </p>
            {changed && <ApproveChanges dir={dir} sha={design?.approved?.sha256 ?? ""} />}
            <label className="approve-build">
                <input
                    type="checkbox"
                    checked={build}
                    onChange={(event) => setBuild(event.target.checked)}
                />
                start the build
            </label>
            {listed !== null && (
                <p className="needs-human approve-blockers">{blockersLine(listed)}</p>
            )}
            {error !== null && <p className="needs-human approve-error">{error}</p>}
            {seed !== null && (
                <p className="approve-seed" role="status">
                    Plan seeded: {seedLine(seed)}
                </p>
            )}
            <span className="confirm-actions">
                <button
                    type="button"
                    className="primary"
                    disabled={posting || seed !== null}
                    onClick={approve}
                >
                    {listed === null ? approveLabel(build) : blockersLabel(listed)}
                </button>
                <button type="button" disabled={posting} onClick={onClose}>cancel</button>
            </span>
        </div>
    );
}

/** The changed sections from `GET …/design/changes`, approved text left, current right. */
function ApproveChanges({ dir, sha }: { dir: string; sha: string }) {
    const loaded = useLoaded(`${dir}#changes#${sha}`, (signal) => fetchDesignChanges(dir, signal));
    if (loaded.error !== null) {
        return <p className="needs-human">{loaded.error}</p>;
    }
    if (loaded.value === undefined) {
        return <p className="muted">Loading the changes…</p>;
    }
    if (loaded.value.length === 0) {
        return <p className="muted">No section differs from the approved doc.</p>;
    }
    return (
        <ul className="approve-changes" aria-label="Changes since approval">
            {loaded.value.map((change) => <ChangeRow key={change.heading} change={change} />)}
        </ul>
    );
}

function ChangeRow({ change }: { change: DesignChange }) {
    return (
        <li className="approve-change" data-heading={change.heading}>
            <h4>{change.heading}</h4>
            <div className="approve-sides">
                <ChangeSide label="approved" text={change.approved} />
                <ChangeSide label="current" text={change.current} />
            </div>
        </li>
    );
}

/**
 * One side of a change; null means the section is absent on that side. A body starts with the
 * blank line under its heading, which a `<pre>` would show, so the leading newlines go.
 */
function ChangeSide({ label, text }: { label: string; text: string | null }) {
    return (
        <div className="approve-side" data-side={label}>
            <span className="field-label">{label}</span>
            {text === null ? (
                <p className="muted">absent</p>
            ) : (
                <pre className="confirm-text">{text.replace(/^\n+/, "")}</pre>
            )}
        </div>
    );
}
