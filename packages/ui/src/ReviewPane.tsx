// The middle pane for a review session (s015): the PR header with the card's facts, the
// swarm as chips (a state dot, the model, `$`; a click opens the reviewer's terminal), and
// the threads view live. There is no pipeline toolbar; `review` lives in the context bar.
import { useState, type ReactNode } from "react";

import { tty_path, type SessionView, type SwarmMember } from "@spinner/protocol";

import { AgentTerminal } from "./AgentTerminal.tsx";
import { formatUsd } from "./costs.ts";
import { postAgent } from "./events-client.ts";
import { StatePill, type IconButtonProps } from "./PaneHead.tsx";
import { ciPill, decisionPill, swarmDot, swarmLine, type ReviewFacts } from "./review.ts";
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

/** The swarm row: one chip per reviewer; the picked one is filled. */
function SwarmChips(props: {
    swarm: SwarmMember[];
    picked: string | undefined;
    onPick: (name: string) => void;
}) {
    const { swarm, picked, onPick } = props;
    return (
        <div className="chips rv-swarm" role="tablist" aria-label="Reviewers">
            {swarm.map((member) => {
                const current = member.name === picked;
                const classes = ["chip", "rv-chip", `rv-chip-${member.state}`,
                    current ? "chip-selected" : ""];
                return (
                    <span key={member.name} className={classes.join(" ").trim()}>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={current}
                            className={current ? "tab chip-name tab-selected" : "tab chip-name"}
                            title={`${member.model} · ${member.state} · ${formatUsd(member.usd)}`}
                            data-name={member.name}
                            data-state={member.state}
                            onClick={() => onPick(member.name)}
                        >
                            <span className={`dot chip-dot ${swarmDot(member.state)}`} />
                            {modelShort(member.model)}
                            <span className="muted rv-chip-cost">{formatUsd(member.usd)}</span>
                        </button>
                    </span>
                );
            })}
            {swarm.length === 0 && <span className="muted">{swarmLine(swarm)}</span>}
        </div>
    );
}

export function ReviewPane(props: ReviewPaneProps) {
    const { view, facts, busy, run, revisions, children, controls, leading } = props;
    // The sub view under the chips: the threads, or the picked reviewer's terminal.
    const [picked, setPicked] = useState<string | undefined>(undefined);
    const [shown, setShown] = useState<"threads" | "terminal">("threads");
    const dir = view.summary.dir;
    const names = facts.swarm.map((member) => member.name);
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
