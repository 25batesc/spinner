// The middle pane of a session: one row of view tabs and one view at a time. Agents is the
// agent rows and the picked agent's chat; Files is the session directory, with comments
// (`SessionFiles.tsx`); Services is the stack. Every session has the same three views.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { agentRows, type RowAction } from "./agent-rows.ts";
import { AddAgent, AgentChat } from "./AgentChat.tsx";
import { AgentRows } from "./AgentRows.tsx";
import { postAgent } from "./events-client.ts";
import { ContextTab } from "./ContextTab.tsx";
import { GoldfishTranscript } from "./GoldfishTranscript.tsx";
import type { IconButtonProps } from "./PaneHead.tsx";
import { fetchMissionView, useLoaded } from "./remote.ts";
import type { Revisions } from "./state.ts";
import { ServiceTable } from "./ServiceTable.tsx";
import { SessionFiles } from "./SessionFiles.tsx";
import { shownView, TAB_LABELS, VIEW_IDS } from "./session-views.ts";
import { Tabs } from "./Tabs.tsx";
import type { ChatState } from "./transcript-sync.ts";
import type { Transcript } from "./transcript.ts";
import type { UsageSample } from "./usage.ts";
import { ViewTabs } from "./ViewTabs.tsx";
import type { AgentTranscriptResponse, MissionView, SessionView } from "@spinner/protocol";

import type { RunAction } from "./SessionForms.tsx";

export interface AgentsPaneProps {
    view: SessionView | undefined;
    run: RunAction;
    /** Each agent's chat, by agent name, for the selected session. */
    chats: Record<string, ChatState>;
    /** Puts a page of an agent's transcript, fetched by its chat, into the store. */
    onPage: (agent: string, page: AgentTranscriptResponse) => void;
    /** The last usage sample, for the services view. */
    usage: UsageSample | null;
    revisions: Revisions;
    /** The structured mission from the last `mission.changed`, for the agent rows. */
    mission: MissionView | undefined;
    /** The activity drawer, at the bottom of the pane. */
    children?: ReactNode;
    /** Header icons; absent when the pane is rendered alone by the `?pane=` route. */
    controls?: IconButtonProps[] | undefined;
    /** The side-panel toggle, at the left of the title. */
    leading?: IconButtonProps | undefined;
    /** The shown view and the picked agent, held by the App: a new session opens on its lead. */
    shown: string;
    onShown: (view: string) => void;
    picked: string | undefined;
    onPicked: (name: string | undefined) => void;
    /** Where a failed row action goes: the drawer, as a failed job's error does. */
    onError: (message: string) => void;
}

function agentBase(dir: string, agent: string): string {
    return `/sessions/${dir}/agents/${agent}`;
}

/** A row action on its existing route: `abort` ends the turn; a resume adds the agent again. */
function postAction(dir: string, name: string, action: RowAction): Promise<void> {
    if (action === "resume") {
        return postAgent(`/sessions/${dir}/agents`, { name });
    }
    return postAgent(`${agentBase(dir, name)}/${action === "interrupt" ? "abort" : action}`, {});
}

const AGENT_TABS = ["chat", "context"] as const;

/** The transcript of each chat, for the agent rows. */
function transcriptsOf(chats: Record<string, ChatState>): Record<string, Transcript> {
    return Object.fromEntries(Object.entries(chats).map(([name, chat]) => [name, chat.transcript]));
}

export function AgentsPane(props: AgentsPaneProps) {
    const { view, run, chats, onPage, usage, revisions, mission, children } = props;
    const transcripts = useMemo(() => transcriptsOf(chats), [chats]);
    const { controls, leading, picked } = props;
    const shown = shownView(props.shown);
    const setShown = props.onShown;
    // The views share one scroll box; a view change starts at its top.
    const chat = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        chat.current?.scrollTo({ top: 0 });
    }, [shown, view?.summary.dir]);
    const setPicked = props.onPicked;
    // An agent shows as its chat; `context` is a look at what it was started with.
    const [agentTab, setAgentTab] = useState<string>(AGENT_TABS[0]);
    // The `+` chip at the end of the agent row: the add-agent form as the pane's view.
    const [adding, setAdding] = useState(false);
    // The picked subagent row, per session: its transcript replaces the agent's tabs until an
    // agent row or `+ add agent` is picked.
    const [fish, setFish] = useState<{ run: string; step: number; dir: string } | null>(null);
    const fishView = fish === null || fish.dir !== view?.summary.dir
        ? undefined
        : (view.subagents ?? []).find((item) => item.run === fish.run && item.step === fish.step);
    const showsFish = !adding && fishView !== undefined;
    const session = view?.summary.session;
    const names = session === undefined ? [] : Object.keys(session.agents);
    const selected = picked !== undefined && names.includes(picked) ? picked : names[0];
    const agent = selected === undefined ? undefined : session?.agents[selected];
    // The rows' Roster fallback: the last `mission.changed`, else the mission read once per
    // session and revision, so a reload shows what each agent said it does.
    const missionDir = mission === undefined ? view?.summary.dir : undefined;
    const loadedMission = useLoaded(`${missionDir ?? ""}#${revisions.mission}#roster`, (signal) =>
        missionDir === undefined
            ? Promise.resolve(undefined)
            : fetchMissionView(missionDir, signal));
    const roster = (mission ?? loadedMission.value)?.roster ?? [];
    const tabs = VIEW_IDS.map((id) => ({ id, label: TAB_LABELS[id] }));

    return (
        <section className="pane agents-pane" aria-label="Agents">
            <ViewTabs
                key={view?.summary.dir ?? ""}
                tabs={tabs}
                shown={shown}
                onSelect={setShown}
                controls={controls}
                leading={leading}
            />
            <div className="chat" ref={chat}>
                {/* Hidden, not unmounted, while another view shows: the open file, its place
                    and a half-written comment stay. */}
                {view !== undefined && (
                    <SessionFiles
                        key={view.summary.dir}
                        view={view}
                        active={shown === "files"}
                        commentsRevision={revisions.comments}
                    />
                )}
                {view !== undefined && shown === "services" && (
                    <ServiceTable view={view} usage={usage} run={run} />
                )}
                {/* Hidden, not unmounted, while another view shows: the chat keeps what was
                    typed and where it was scrolled. */}
                <div className="agents-view" hidden={shown !== "agents"}>
                    {view !== undefined && (
                        <AgentRows
                            groups={agentRows(view, transcripts, roster)}
                            selected={showsFish
                                ? `fish:${fishView.run}/${fishView.step}`
                                : selected === undefined ? null : `agent:${selected}`}
                            adding={adding}
                            onPick={(target) => {
                                const dir = view.summary.dir;
                                setAdding(false);
                                if (target.kind === "agent") {
                                    setPicked(target.name);
                                    setFish(null);
                                } else {
                                    setFish({ run: target.run, step: target.step, dir });
                                }
                            }}
                            onAdd={() => {
                                setAdding(true);
                                setFish(null);
                            }}
                            onAction={(name, action) => {
                                if (action === "resume") {
                                    setPicked(name);
                                    setAdding(false);
                                    setFish(null);
                                }
                                return postAction(view.summary.dir, name, action)
                                    .catch((failure: unknown) => props.onError(String(failure)));
                            }}
                        />
                    )}
                    {view !== undefined && !adding && fishView !== undefined && (
                        <GoldfishTranscript dir={view.summary.dir} view={fishView} />
                    )}
                    {view !== undefined && adding && (
                        <AddAgent
                            view={view}
                            run={run}
                            onDone={(name) => {
                                setPicked(name);
                                setAdding(false);
                            }}
                            onCancel={() => setAdding(false)}
                        />
                    )}
                    {!adding && !showsFish && (agent === undefined || view === undefined ||
                        selected === undefined ? (
                            <p className="muted">This session has no agents.</p>
                        ) : (
                            <>
                                <Tabs
                                    variant="sub"
                                    labels={[...AGENT_TABS]}
                                    selected={agentTab}
                                    onSelect={setAgentTab}
                                />
                                {agentTab === "context" && (
                                    <ContextTab
                                        base={agentBase(view.summary.dir, selected)}
                                        revision={agent.process}
                                    />
                                )}
                                {agentTab !== "context" && (
                                    <AgentChat
                                        view={view}
                                        agent={selected}
                                        chat={chats[selected]}
                                        onPage={onPage}
                                    />
                                )}
                            </>
                        ))}
                </div>
                {children}
            </div>
        </section>
    );
}
