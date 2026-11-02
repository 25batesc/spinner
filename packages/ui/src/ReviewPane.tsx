// The middle pane for a review session (s015): the PR header with the card's facts, the
// swarm as chips (a state dot, the model, `$`; a click opens the reviewer's terminal), and
// the threads view live. There is no pipeline toolbar; `review` lives in the context bar.
// s016 adds the lead's chip and, above the threads, the briefing and the draft
// (`ReviewDraft.tsx`): the swarm's chips read `done`, the reviewers no longer post.
import { useState, type ReactNode } from "react";

import { tty_path, type SessionView, type SwarmMember } from "@spinner/protocol";

import { AgentTerminal } from "./AgentTerminal.tsx";
import { formatUsd } from "./costs.ts";
import { postAgent } from "./events-client.ts";
import { StatePill, type IconButtonProps } from "./PaneHead.tsx";
import {
    ciPill, decisionPill, leadDot, swarmDot, swarmLine, type LeadChip, type ReviewFacts,
} from "./review.ts";
import { ReviewBriefing, ReviewDraftBlock, ReviewPosted } from "./ReviewDraft.tsx";
import type { RunAction } from "./SessionForms.tsx";
import type { Revisions } from "./state.ts";
import { Tabs } from "./Tabs.tsx";
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

/** The PR header: the title as a link, the author, `branch → base`, the pills. */
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
            <span className="badges rv-pills">
                <StatePill pill={ciPill(facts.checks, facts.failing)} className="rv-ci" />
                <StatePill pill={decisionPill(facts.decision)} className="rv-decision" />
                <span className="pill rv-threads" title={`${facts.threads} review threads`}>
                    ⑂ {facts.threads}
                </span>
                {facts.usd !== null && (
                    <span className="muted usage-cost rv-cost">{formatUsd(facts.usd)}</span>
                )}
            </span>
        </header>
    );
}

/** One chip: a dot, a name, the cost; the picked one is filled. */
function Chip(props: {
    name: string;
    label: string;
    title: string;
    state: string;
    dot: string;
    usd: number;
    current: boolean;
    onPick: (name: string) => void;
}) {
    const { name, label, title, state, dot, usd, current, onPick } = props;
    const classes = ["chip", "rv-chip", `rv-chip-${state}`, current ? "chip-selected" : ""];
    return (
        <span className={classes.join(" ").trim()}>
            <button
                type="button"
                role="tab"
                aria-selected={current}
                className={current ? "tab chip-name tab-selected" : "tab chip-name"}
                title={title}
                data-name={name}
                data-state={state}
                onClick={() => onPick(name)}
            >
                <span className={`dot chip-dot ${dot}`} />
                {label}
                <span className="muted rv-chip-cost">{formatUsd(usd)}</span>
            </button>
        </span>
    );
}

/** The chip row: the lead first, then one chip per reviewer. */
function SwarmChips(props: {
    lead: LeadChip | null;
    swarm: SwarmMember[];
    picked: string | undefined;
    onPick: (name: string) => void;
}) {
    const { lead, swarm, picked, onPick } = props;
    return (
        <div className="chips rv-swarm" role="tablist" aria-label="Reviewers">
            {lead !== null && (
                <Chip
                    name={lead.name}
                    label="lead"
                    title={`${lead.model} · ${lead.state} · ${formatUsd(lead.usd)}`}
                    state={lead.state}
                    dot={leadDot(lead.state)}
                    usd={lead.usd}
                    current={lead.name === picked}
                    onPick={onPick}
                />
            )}
            {swarm.map((member) => (
                <Chip
                    key={member.name}
                    name={member.name}
                    label={modelShort(member.model)}
                    title={`${member.model} · ${member.state} · ${formatUsd(member.usd)}`}
                    state={member.state}
                    dot={swarmDot(member.state)}
                    usd={member.usd}
                    current={member.name === picked}
                    onPick={onPick}
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
    // The sub view under the chips: the threads, or the picked reviewer's terminal.
    const [picked, setPicked] = useState<string | undefined>(undefined);
    const [shown, setShown] = useState<"threads" | "terminal">("threads");
    const dir = view.summary.dir;
    const names = facts.swarm.map((member) => member.name);
    if (facts.lead !== null) {
        names.unshift(facts.lead.name);
    }
    const reviewer = picked !== undefined && names.includes(picked) ? picked : undefined;
    const terminalShown = shown === "terminal" && reviewer !== undefined;
    // Every reviewer's terminal stays mounted; only the picked one shows, as in AgentsPane.
    const terminals = names
        .filter((name) => view.summary.session.agents[name] !== undefined)
        .map((name) => (
            <AgentTerminal
                key={`${dir}/${name}`}
                path={tty_path(dir, name)}
                running={view.agents_running.includes(name)}
                onResume={() => postAgent(`/sessions/${dir}/agents`, { name })}
                visible={terminalShown && name === reviewer}
            />
        ));
    return (
        <section className="pane agents-pane rv-pane" aria-label="Review">
            <ViewTabs
                labels={["review"]}
                shown="review"
                onSelect={() => undefined}
                controls={controls}
                leading={leading}
            />
            <div className="chat">
                <ReviewHeader facts={facts} />
                <SwarmChips
                    lead={facts.lead}
                    swarm={facts.swarm}
                    picked={terminalShown ? reviewer : undefined}
                    onPick={(name) => {
                        setPicked(name);
                        setShown("terminal");
                    }}
                />
                <Tabs
                    variant="sub"
                    labels={reviewer === undefined ? ["threads"] : ["threads", "terminal"]}
                    selected={terminalShown ? "terminal" : "threads"}
                    onSelect={(tab) => setShown(tab === "terminal" ? "terminal" : "threads")}
                />
                {!terminalShown && <LeadBlocks dir={dir} facts={facts} />}
                {!terminalShown && (
                    <ThreadsPanel
                        dir={dir}
                        revision={revisions.threads}
                        busy={busy}
                        run={run}
                        fixable={false}
                    />
                )}
                {terminals}
                {children}
            </div>
        </section>
    );
}
