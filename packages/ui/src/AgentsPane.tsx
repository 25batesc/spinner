// The middle pane of a session (docs/designs/session-workspace.md, T5, D15): one row of view
// tabs in EGM step order, each EGM tab marked with its step's state, and one view at a time:
// Agents (the gate card, the agent rows, the chat), Brainstorm, Draft, Review, Files,
// History, Implement, Threads, Services. The pane fetches the design doc once per reload key
// and hands the text to the Draft and Implement views; a `mission.changed` never refetches it.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { agentRows, type RowAction } from "./agent-rows.ts";
import { AddAgent, AgentChat } from "./AgentChat.tsx";
import { AgentRows } from "./AgentRows.tsx";
import { postAgent } from "./events-client.ts";
import { ContextTab } from "./ContextTab.tsx";
import { compactLabel, designSteps, stepperText } from "./design.ts";
import { DesignBrief } from "./DesignBrief.tsx";
import { DesignDoc } from "./DesignDoc.tsx";
import { DesignHistory } from "./DesignHistory.tsx";
import { DesignReview } from "./DesignReview.tsx";
import {
    docSource, EGM_VIEWS, reloadKey, shownView, stepTab, TAB_LABELS, tabMarks, viewTabs,
    WORKSPACE_VIEWS, type ViewId,
} from "./design-workspace.ts";
import { GoldfishTranscript } from "./GoldfishTranscript.tsx";
import { capLine } from "./goldfish.ts";
import { MissionWorkspace } from "./MissionWorkspace.tsx";
import type { IconButtonProps } from "./PaneHead.tsx";
import { fetchDesignDoc, fetchDesignFile, fetchMissionView, useLoaded } from "./remote.ts";
import { needsHuman, type Revisions } from "./state.ts";
import { ThreadsPanel } from "./ThreadsPanel.tsx";
import { ServiceTable } from "./ServiceTable.tsx";
import { SessionFiles } from "./SessionFiles.tsx";
import { Tabs } from "./Tabs.tsx";
import type { ChatState } from "./transcript-sync.ts";
import type { Transcript } from "./transcript.ts";
import type { UsageSample } from "./usage.ts";
import { ViewTabs, type ViewTabFold } from "./ViewTabs.tsx";
import {
    EGM_NOTICE,
    type AgentTranscriptResponse,
    type MissionView,
    type SessionView,
} from "@spinner/protocol";

import type { RunAction } from "./SessionForms.tsx";

export interface AgentsPaneProps {
    view: SessionView | undefined;
    /** True while a job runs on this session; the action buttons wait. */
    busy: boolean;
    run: RunAction;
    /** Each agent's chat, by agent name, for the selected session. */
    chats: Record<string, ChatState>;
    /** Puts a page of an agent's transcript, fetched by its chat, into the store. */
    onPage: (agent: string, page: AgentTranscriptResponse) => void;
    /** The last usage sample, for the services view. */
    usage: UsageSample | null;
    revisions: Revisions;
    /** The structured mission from the last `mission.changed`, for the mission view. */
    mission: MissionView | undefined;
    /** The activity drawer, at the bottom of the pane. */
    children?: ReactNode;
    /** Header icons; absent when the pane is rendered alone by the `?pane=` route. */
    controls?: IconButtonProps[] | undefined;
    /** The side-panel toggle, at the left of the title. */
    leading?: IconButtonProps | undefined;
    /**
     * The shown view and the picked agent, held by the App (entry 3.22): the `needs you` pill
     * switches to the `agents` view and picks `lead` when a gate card shows.
     */
    shown: string;
    onShown: (view: string) => void;
    picked: string | undefined;
    onPicked: (name: string | undefined) => void;
    /** Opens the Agents view with `name` picked: the compact gate line, a rail chip. */
    onOpenAgent: (name: string) => void;
    /** Opens another view: `open in Draft` on Implement, the round badge. */
    onOpenView: (id: ViewId) => void;
    /** Where a refused gate answer goes: the drawer, as a failed job's error does. */
    onError: (message: string) => void;
}

// The chip's dot rule lives in `agent-view.ts` (pure), so the Implement rail can wrap it
// (session-workspace.md, D14) without this module.
export { agentState } from "./agent-view.ts";

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

/**
 * The doc the Draft and Implement views read (D15): the named doc, else the draft, fetched
 * once per reload key. The key never carries the mission revision, so a tick does not refetch.
 */
function useDesignDoc(view: SessionView | undefined) {
    const design = view?.design;
    const source = design === undefined ? null : docSource(design);
    const dir = view?.summary.dir ?? "";
    const reload = design === undefined ? dir : reloadKey(dir, design);
    return useLoaded(`${reload}#doc#${source?.kind ?? "none"}`, (signal) => {
        if (source === null) {
            return Promise.resolve("");
        }
        return source.kind === "doc"
            ? fetchDesignDoc(dir, signal)
            : fetchDesignFile(dir, source.name, signal);
    });
}

const AGENT_TABS = ["chat", "context"] as const;

/** The transcript of each chat, for the agent rows. */
function transcriptsOf(chats: Record<string, ChatState>): Record<string, Transcript> {
    return Object.fromEntries(Object.entries(chats).map(([name, chat]) => [name, chat.transcript]));
}

export function AgentsPane(props: AgentsPaneProps) {
    const { view, busy, run, chats, onPage, usage, revisions, mission, children } = props;
    const transcripts = useMemo(() => transcriptsOf(chats), [chats]);
    const { controls, leading, picked, onOpenAgent, onOpenView } = props;
    // A session off the design track has no EGM views; its pick falls back to the default.
    const shown = shownView(view, props.shown);
    const setShown = props.onShown;
    // The views share one scroll box; a view change starts at its top, so a long Review does
    // not open at the depth the Implement list was read at.
    const chat = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        chat.current?.scrollTo({ top: 0 });
    }, [shown, view?.summary.dir]);
    const setPicked = props.onPicked;
    // An agent shows as its chat; `context` is a look at what it was started with.
    const [agentTab, setAgentTab] = useState<string>(AGENT_TABS[0]);
    // The `+` chip at the end of the agent row: the add-agent form as the pane's view.
    const [adding, setAdding] = useState(false);
    // The picked Goldfish row (entry 4.16), per session: its transcript replaces the agent's
    // tabs until an agent row or `+ add agent` is picked.
    const [fish, setFish] = useState<{ run: string; step: number; dir: string } | null>(null);
    const design = view?.design;
    const fishView = fish === null || fish.dir !== view?.summary.dir
        ? undefined
        : design?.goldfish.find((item) => item.run === fish.run && item.step === fish.step);
    const showsFish = !adding && fishView !== undefined;
    const session = view?.summary.session;
    const names = session === undefined ? [] : Object.keys(session.agents);
    const selected = picked !== undefined && names.includes(picked) ? picked : names[0];
    const agent = selected === undefined ? undefined : session?.agents[selected];
    const needs = view === undefined ? null : needsHuman(view);
    const reload = view === undefined || design === undefined
        ? ""
        : reloadKey(view.summary.dir, design);
    const doc = useDesignDoc(view);
    // The rows' Roster fallback: the last `mission.changed`, else the mission read once per
    // session and revision, so a reload shows what each agent said it does.
    const missionDir = mission === undefined ? view?.summary.dir : undefined;
    const loadedMission = useLoaded(`${missionDir ?? ""}#${revisions.mission}#roster`, (signal) =>
        missionDir === undefined
            ? Promise.resolve(undefined)
            : fetchMissionView(missionDir, signal));
    const roster = (mission ?? loadedMission.value)?.roster ?? [];
    // The step marks and the fold of the EGM tabs (T5): only on the design track.
    const steps = useMemo(
        () => (design?.track === "design" ? designSteps(design, needs) : null),
        [design, needs],
    );
    const marks = useMemo(() => {
        if (steps === null || design === undefined) {
            return undefined;
        }
        const egm = tabMarks(steps, design);
        const brainstorm = egm.brainstorm;
        if (brainstorm !== undefined) {
            brainstorm.title = `${EGM_NOTICE}\n${brainstorm.title}`;
        }
        return egm;
    }, [steps, design]);
    let fold: ViewTabFold | undefined;
    if (steps !== null) {
        const current = steps.find((step) => step.state !== "done") ?? steps[steps.length - 1];
        fold = {
            ids: EGM_VIEWS,
            label: compactLabel(steps),
            opens: stepTab(current?.id ?? "build"),
            title: `${EGM_NOTICE}\n${stepperText(steps)}`,
        };
    }
    const tabs = viewTabs(view).map((id) => ({ id, label: TAB_LABELS[id] }));

    return (
        <section className="pane agents-pane" aria-label="Agents">
            <ViewTabs
                key={view?.summary.dir ?? ""}
                tabs={tabs}
                shown={shown}
                onSelect={setShown}
                controls={controls}
                leading={leading}
                marks={marks}
                fold={fold}
            />
            <div className="chat" ref={chat}>
                {/* `.dw` is the container the design views' split layout queries (styles.css
                    `@container dw`): without it the outline stacks above the doc. */}
                {view !== undefined && WORKSPACE_VIEWS.has(shown) && (
                    <div className="dw" aria-label="Design workspace" data-tab={shown}>
                        {shown === "brainstorm" && (
                            <DesignBrief view={view} reload={reload} onOpenAgent={onOpenAgent} />
                        )}
                        {shown === "draft" && (
                            <DesignDoc
                                view={view}
                                doc={doc}
                                mission={mission}
                                onError={props.onError}
                            />
                        )}
                        {shown === "review" && (
                            <DesignReview
                                view={view}
                                reload={reload}
                                needs={needs}
                                onOpenAgent={onOpenAgent}
                            />
                        )}
                        {shown === "history" && <DesignHistory view={view} />}
                    </div>
                )}
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
                {view !== undefined && shown === "implement" && (
                    <MissionWorkspace
                        dir={view.summary.dir}
                        revision={revisions.mission}
                        mission={mission}
                        view={view}
                        docText={design?.doc === null || design === undefined
                            ? null
                            : doc.value ?? null}
                        running={view.agents_running}
                        onOpenAgent={onOpenAgent}
                        onOpenView={onOpenView}
                    />
                )}
                {view !== undefined && shown === "threads" && (
                    <ThreadsPanel
                        dir={view.summary.dir}
                        revision={revisions.threads}
                        commentsRevision={revisions.comments}
                        busy={busy}
                        run={run}
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
                            cap={design === undefined ? null : capLine(design.goldfish_live)}
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
