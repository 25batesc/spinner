// The middle pane for a review session (s015, s016, s018): the PR header with the card's
// facts and pills, the chips (the lead first, then one per reviewer: a state dot, the model,
// `$`; nothing to click, the agents are headless), the lead's briefing and draft
// (`ReviewDraft.tsx`), and the threads view live. There is no pipeline toolbar and no
// terminal view; `review` lives in the context bar.
import { useState, type ReactNode } from "react";

import type { SessionView, SwarmMember } from "@spinner/protocol";

import { formatUsd } from "./costs.ts";
import { ReviewPills, type IconButtonProps } from "./PaneHead.tsx";
import { leadDot, swarmDot, swarmLine, type LeadChip, type ReviewFacts } from "./review.ts";
import { ReviewBriefing, ReviewDraftBlock, ReviewPosted } from "./ReviewDraft.tsx";
import type { RunAction } from "./SessionForms.tsx";
import { postReviewApprove, postReviewCancel } from "./remote.ts";
import type { Revisions } from "./state.ts";
import { ThreadsPanel } from "./ThreadsPanel.tsx";
import { ViewTabs } from "./ViewTabs.tsx";

export interface ReviewPaneProps {
    view: SessionView;
    facts: ReviewFacts;
    busy: boolean;
    run: RunAction;
    revisions: Revisions;
    /** The activity drawer, at the bottom of the pane. */
    children?: ReactNode;
    controls?: IconButtonProps[] | undefined;
    leading?: IconButtonProps | undefined;
}

/** `opus-5-5` from `anthropic/claude-opus-5-5`: the chip's text; the full id in the tooltip. */
export function modelShort(model: string): string {
    const name = model.split("/").at(-1) ?? model;
    return name.replace(/^claude-/, "");
}

/**
 * The one-click answers of a review (dogfood #22), on the card and the PR header: `approve`
 * posts APPROVE "LGTM" as the operator after one question that names the PR, since it
 * speaks for the operator on GitHub; `cancel review` shows while the swarm or the lead
 * works and stops them at once. The daemon's `session.updated` carries the result (the
 * `posted` or `cancelled` pill); a refusal shows under the buttons.
 */
export function ReviewActions({ facts }: { facts: ReviewFacts }) {
    const [asking, setAsking] = useState(false);
    const [pending, setPending] = useState<"approve" | "cancel" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const act = (kind: "approve" | "cancel", call: () => Promise<unknown>) => {
        setPending(kind);
        setError(null);
        call().then(
            () => setAsking(false),
            (failure: unknown) => setError(String(failure)),
        ).finally(() => setPending(null));
    };
    const busy = pending !== null;
    const ref = facts.pr_ref;
    if (asking && ref !== null) {
        return (
            <span className="rv-confirm rv-actions" role="group" aria-label="Confirm approve">
                <span>Approve {ref} as you?</span>
                <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => act("approve", () => postReviewApprove(facts.dir))}
                >
                    {pending === "approve" ? "approving…" : "approve"}
                </button>
                <button type="button" disabled={busy} onClick={() => setAsking(false)}>
                    no
                </button>
                {error !== null && <span className="needs-human rv-action-error">{error}</span>}
            </span>
        );
    }
    return (
        <span className="rv-actions">
            {ref !== null && (
                <button
                    type="button"
                    disabled={busy}
                    title={`Post APPROVE "LGTM" on ${ref} as you, without a swarm`}
                    onClick={() => setAsking(true)}
                >
                    approve
                </button>
            )}
            {facts.state === "reviewing" && (
                <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    title="Stop the reviewers and the lead; their verdicts are archived"
                    onClick={() => act("cancel", () => postReviewCancel(facts.dir))}
                >
                    {pending === "cancel" ? "cancelling…" : "cancel review"}
                </button>
            )}
            {error !== null && <span className="needs-human rv-action-error">{error}</span>}
        </span>
    );
}

/** The PR header: the title as a link, the author, `branch → base`, the pills, the answers. */
function ReviewHeader({ facts }: { facts: ReviewFacts }) {
    const title = facts.url === null
        ? <strong className="rv-head-title">{facts.title}</strong>
        : (
            <a className="rv-head-title" href={facts.url} target="_blank" rel="noreferrer">
                {facts.title}
            </a>
        );
    return (
        <header className="rv-head" aria-label="Pull request">
            {title}
            <span className="muted rv-meta">
                <span className="rv-author">{facts.author}</span>
                <code className="rv-branches">{facts.branch} → {facts.base}</code>
            </span>
            <ReviewPills facts={facts} />
            <ReviewActions facts={facts} />
        </header>
    );
}

/** One chip: a dot, a name, the cost. The tooltip has the model, the state and the error. */
function Chip(props: { name: string; label: string; title: string; state: string; dot: string;
    usd: number }) {
    const { name, label, title, state, dot, usd } = props;
    return (
        <span
            className={`chip rv-chip rv-chip-${state}`}
            title={title}
            data-name={name}
            data-state={state}
        >
            <span className={`dot chip-dot ${dot}`} />
            <span className="chip-name rv-chip-name">{label}</span>
            <span className="muted rv-chip-cost">{formatUsd(usd)}</span>
        </span>
    );
}

/** A failed reviewer's tooltip ends with the daemon's reason, when it has one. */
function memberTitle(member: SwarmMember): string {
    const base = `${member.model} · ${member.state} · ${formatUsd(member.usd)}`;
    const error = member.error ?? null;
    return member.state === "failed" && error !== null ? `${base}\n${error}` : base;
}

/** The chip row: the lead first, then one chip per reviewer. */
function SwarmChips({ lead, swarm }: { lead: LeadChip | null; swarm: SwarmMember[] }) {
    return (
        <div className="chips rv-swarm" aria-label="Reviewers">
            {lead !== null && (
                <Chip
                    name={lead.name}
                    label="lead"
                    title={`${lead.model} · ${lead.state} · ${formatUsd(lead.usd)}`}
                    state={lead.state}
                    dot={leadDot(lead.state)}
                    usd={lead.usd}
                />
            )}
            {swarm.map((member) => (
                <Chip
                    key={member.name}
                    name={member.name}
                    label={modelShort(member.model)}
                    title={memberTitle(member)}
                    state={member.state}
                    dot={swarmDot(member.state)}
                    usd={member.usd}
                />
            ))}
            {swarm.length === 0 && <span className="muted">{swarmLine(swarm)}</span>}
        </div>
    );
}

/** The lead's blocks: the briefing once it exists; the posted URL, else the draft. */
function LeadBlocks({ dir, facts }: { dir: string; facts: ReviewFacts }) {
    return (
        <>
            {facts.briefing && <ReviewBriefing dir={dir} />}
            {facts.posted_url !== null && <ReviewPosted url={facts.posted_url} />}
            {facts.posted_url === null && facts.draft !== null && (
                <ReviewDraftBlock dir={dir} draft={facts.draft} />
            )}
        </>
    );
}

export function ReviewPane(props: ReviewPaneProps) {
    const { view, facts, busy, run, revisions, children, controls, leading } = props;
    const dir = view.summary.dir;
    return (
        <section className="pane agents-pane rv-pane" aria-label="Review">
            <ViewTabs
                tabs={[{ id: "review", label: "review" }]}
                shown="review"
                onSelect={() => undefined}
                controls={controls}
                leading={leading}
            />
            <div className="chat">
                <ReviewHeader facts={facts} />
                <SwarmChips lead={facts.lead} swarm={facts.swarm} />
                <LeadBlocks dir={dir} facts={facts} />
                <ThreadsPanel
                    dir={dir}
                    revision={revisions.threads}
                    busy={busy}
                    run={run}
                    fixable={false}
                />
                {children}
            </div>
        </section>
    );
}
