// The rules of the session workspace (docs/designs/session-workspace.md, T5; the doc and
// History rules from docs/designs/egm-adoption.md, build session 5, T13): the view tabs per
// track and which one opens, the step mark of each EGM tab, the sections and the outline of a
// doc, the rows of the Review tab, and the rows of the History tab. The components render
// what these return; the daemon sends the facts in `SessionView.design`, `round` and `rounds`.
import {
    BRIEF_FILE,
    CONSOLIDATED_REPORT,
    DRAFT_FILE,
    REVIEW_STAGE_REPORTS,
    RESOLVE_REPORT,
    type DesignApproval,
    type DesignView,
    type ReviewStageId,
    type RoundView,
    type SessionView,
} from "@spinner/protocol";

import { stepTitle, type DesignStep, type StepId, type StepState } from "./design.ts";
import { runningOn } from "./goldfish.ts";

/** The views of the agents pane, in row order (T5). */
export const VIEW_IDS = [
    "agents", "brainstorm", "draft", "review", "implement", "files", "history", "threads",
    "services",
] as const;

export type ViewId = (typeof VIEW_IDS)[number];

/** The Title-case label of each view (D13). */
export const TAB_LABELS: Record<ViewId, string> = {
    agents: "Agents", brainstorm: "Brainstorm", draft: "Draft", review: "Review",
    implement: "Implement", files: "Files", history: "History", threads: "Threads",
    services: "Services",
};

/** The four EGM tabs, which carry a step mark and fold into one tab on a narrow row (T5). */
export const EGM_VIEWS: readonly ViewId[] = ["brainstorm", "draft", "review", "implement"];

/** The two rows of T5: the design track, and the direct track or a legacy session (R3). */
const DESIGN_VIEWS: readonly ViewId[] = VIEW_IDS;
const DIRECT_VIEWS: readonly ViewId[] = [
    "agents", "implement", "files", "history", "threads", "services",
];

/** True for a session on the design track; a legacy session has no `design` block (D5). */
function onDesignTrack(view: SessionView | undefined): boolean {
    return view?.design?.track === "design";
}

/** The view tabs of the agents pane: the EGM tabs only on the design track (D5, R3). */
export function viewTabs(view: SessionView | undefined): readonly ViewId[] {
    return onDesignTrack(view) ? DESIGN_VIEWS : DIRECT_VIEWS;
}

/** The view a session opens on when nobody picked one: Agents on the design track (T5). */
export function defaultView(view: SessionView | undefined): ViewId {
    return onDesignTrack(view) ? "agents" : "implement";
}

/** The shown view: `shown` when the session offers it, else the session's default view. */
export function shownView(view: SessionView | undefined, shown: string): ViewId {
    const tabs = viewTabs(view);
    return tabs.includes(shown as ViewId) ? (shown as ViewId) : defaultView(view);
}

/** The tab of each EGM step (D12): Approve is a state of the Review tab; Build is Implement. */
export function stepTab(step: StepId): ViewId {
    switch (step) {
        case "brainstorm":
            return "brainstorm";
        case "draft":
            return "draft";
        case "review":
        case "approve":
            return "review";
        case "build":
            return "implement";
    }
}

/** The mark an EGM tab carries: a state dot before the label, a tooltip, an optional suffix. */
export interface TabMark {
    state: StepState;
    title: string;
    suffix?: string;
}

/** `2 live`: the running Goldfish of a step as a tab suffix. */
function liveSuffix(count: number): string | undefined {
    return count === 0 ? undefined : `${count} live`;
}

/**
 * The marks of the four EGM tabs (T5). Review carries two steps: its state is Approve's while
 * Approve is active or waiting, else Review's; its tooltip is both step titles; its suffix is
 * `n/5` (the written review stages) while the review runs. Brainstorm and Review add their
 * running Goldfish as a suffix while a run is live.
 */
export function tabMarks(
    steps: readonly DesignStep[],
    design: DesignView,
): Partial<Record<ViewId, TabMark>> {
    const marks: Partial<Record<ViewId, TabMark>> = {};
    const review = steps.find((step) => step.id === "review");
    const approve = steps.find((step) => step.id === "approve");
    for (const step of steps) {
        if (step.id === "approve") {
            continue;
        }
        const mark: TabMark = { state: step.state, title: stepTitle(step, design) };
        const live = liveSuffix(runningOn(design.goldfish, step.id));
        if (live !== undefined) {
            mark.suffix = live;
        }
        marks[stepTab(step.id)] = mark;
    }
    if (review !== undefined && approve !== undefined) {
        const approving = approve.state === "active" || approve.state === "waiting";
        const reviewing = review.state === "active" || review.state === "waiting";
        const written = (review.dots ?? []).filter(Boolean).length;
        const mark: TabMark = {
            state: approving ? approve.state : review.state,
            title: `${stepTitle(review, design)}\n${stepTitle(approve, design)}`,
        };
        const parts = [
            reviewing ? `${written}/${review.dots?.length ?? 0}` : undefined,
            liveSuffix(runningOn(design.goldfish, "review")),
        ].filter((part): part is string => part !== undefined);
        if (parts.length > 0) {
            mark.suffix = parts.join(" ");
        }
        marks.review = mark;
    }
    return marks;
}

/**
 * The reload key of the workspace's data (entry 5.6): the session dir, the newest `mtime` in
 * `design.files`, and `design.doc`. A file the lead writes moves the newest `mtime`.
 */
export function reloadKey(dir: string, design: DesignView): string {
    const newest = design.files.reduce((top, file) => (file.mtime > top ? file.mtime : top), "");
    return `${dir}#${newest}#${design.doc ?? ""}`;
}

/** True when `<session>/design/` holds `name`. */
export function hasFile(design: DesignView, name: string): boolean {
    return design.files.some((file) => file.name === name);
}

/** What the Design tab shows: the doc once `design.doc` is set, else the draft, else nothing. */
export type DocSource =
    | { kind: "doc"; name: string; path: string }
    | { kind: "draft"; name: string }
    | null;

export function docSource(design: DesignView): DocSource {
    if (design.doc !== null) {
        const name = design.doc.split("/").pop() ?? design.doc;
        return { kind: "doc", name, path: design.doc };
    }
    return hasFile(design, DRAFT_FILE) ? { kind: "draft", name: DRAFT_FILE } : null;
}

/** True when the Brief tab has a brief to read. */
export function hasBrief(design: DesignView): boolean {
    return hasFile(design, BRIEF_FILE);
}

/** One part of a doc: the text before the first `## ` heading, or one `## ` section. */
export interface DocSection {
    /** The `## ` heading's text, or null for the text before the first one. */
    heading: string | null;
    /** The section's markdown, its heading line included. */
    text: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const SECTION_HEADING = /^## +(.+?)\s*#*\s*$/;

/**
 * The doc cut at each `## ` heading outside a code fence (entry 5.8). Joined back, the parts
 * are the doc. An empty preamble is left out.
 */
export function docSections(markdown: string): DocSection[] {
    const lines = markdown.split("\n");
    const sections: DocSection[] = [];
    let heading: string | null = null;
    let body: string[] = [];
    let fence: string | null = null;
    const flush = () => {
        const text = body.join("\n");
        if (heading !== null || text.trim() !== "") {
            sections.push({ heading, text });
        }
    };
    for (const line of lines) {
        const opened = FENCE.exec(line)?.[1];
        if (opened !== undefined) {
            if (fence === null) {
                fence = opened;
            } else if (opened[0] === fence[0] && opened.length >= fence.length) {
                fence = null;
            }
        }
        const match = fence === null ? SECTION_HEADING.exec(line) : null;
        if (match !== null) {
            flush();
            heading = match[1] ?? "";
            body = [line];
            continue;
        }
        body.push(line);
    }
    flush();
    return sections;
}

/** The `## ` headings of a doc, in order: the left outline of the Design tab (entry 5.8). */
export function outline(markdown: string): string[] {
    return docSections(markdown)
        .map((section) => section.heading)
        .filter((heading): heading is string => heading !== null);
}

/** The text a revision request sends to the lead (entry 5.8). */
export function revisionText(heading: string, file: string, text: string): string {
    return `Revision request for "${heading}" in ${file}: ${text}`;
}

/** The EGM name of each `egm-review` stage. */
const STAGE_NAMES: Record<ReviewStageId, string> = {
    "5": "Zoom out",
    "6": "Comprehension",
    "7": "Critic",
    "8": "Intermediate zoom out",
    "9": "Implementation readiness",
};

/** One row of the Review tab: a stage 5 to 9, or the consolidated or the resolve report. */
export interface StageRow {
    id: string;
    label: string;
    file: string;
    /** True once the current run's report exists; null for an archived run, which is unknown. */
    written: boolean | null;
}

/**
 * The Review tab's rows (entry 5.9): stages 5 to 9 with `written` from `design.reviews`, then
 * the consolidated report and the resolve report when the current run has them. For an
 * archived run (`current` false) every row shows, with `written` unknown: the daemon lists no
 * files of an archived run.
 */
export function stageRows(design: DesignView, current = true): StageRow[] {
    const ids = Object.keys(REVIEW_STAGE_REPORTS).sort() as ReviewStageId[];
    const stages: StageRow[] = ids.map((id) => ({
        id,
        label: `${id} ${STAGE_NAMES[id]}`,
        file: REVIEW_STAGE_REPORTS[id],
        written: current ? design.reviews[id] : null,
    }));
    const consolidated: StageRow = {
        id: "consolidated", label: "Consolidated report", file: CONSOLIDATED_REPORT,
        written: current ? design.consolidated : null,
    };
    const resolve: StageRow = {
        id: "resolve", label: "Resolve report", file: RESOLVE_REPORT,
        written: current ? design.resolve !== "none" : null,
    };
    if (!current) {
        return [...stages, consolidated, resolve];
    }
    return [
        ...stages,
        ...(design.consolidated ? [consolidated] : []),
        ...(design.resolve !== "none" ? [resolve] : []),
    ];
}

/** One row of the History tab's rounds, newest first. */
export interface RoundRow {
    round: number;
    current: boolean;
    branch: string | null;
    record: RoundView | null;
}

/**
 * The rounds of the History tab (entry 5.13): the current round first as `r<round> (current)`,
 * then each `view.rounds` entry, newest first.
 */
export function roundRows(view: SessionView): RoundRow[] {
    const round = view.round ?? 1;
    const earlier = [...(view.rounds ?? [])].sort((a, b) => b.round - a.round);
    const head: RoundRow = {
        round, current: true, branch: view.summary.session.branch, record: null,
    };
    return [head, ...earlier.map((record) => ({
        round: record.round, current: false, branch: record.branch, record,
    }))];
}

/** The mark of an approval row: the standing one is `current`, or `invalidated` once changed. */
export type ApprovalMark = "current" | "invalidated" | null;

export interface ApprovalRow {
    approval: DesignApproval;
    mark: ApprovalMark;
}

/** The approvals of the History tab (entry 5.13), newest first, the standing one marked. */
export function approvalRows(design: DesignView): ApprovalRow[] {
    const standing = design.approved;
    const isStanding = (approval: DesignApproval) =>
        standing !== null && approval.sha256 === standing.sha256 && approval.at === standing.at;
    return [...design.approvals].reverse().map((approval) => {
        if (!isStanding(approval)) {
            return { approval, mark: null };
        }
        return { approval, mark: design.changed_after_approval ? "invalidated" : "current" };
    });
}

/** `4.0 KB`, `812 B`: a file size for the Files tab. */
export function sizeLabel(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    return `${(bytes / 1024).toFixed(1)} KB`;
}

/** `2026-10-20 10:00`: an ISO time cut to the minute, as the Files and History tabs show it. */
export function timeLabel(iso: string): string {
    return iso.slice(0, 16).replace("T", " ");
}
