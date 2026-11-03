// The rules of the design workspace (docs/designs/egm-adoption.md, build session 5, Technical
// Plan T13): the tabs and which one opens, the sections and the outline of a doc, the rows of
// the Review tab, and the rows of the History tab. The components render what these return;
// the daemon sends the facts in `SessionView.design`, `round` and `rounds`.
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

import type { StepId } from "./design.ts";

/** The workspace tabs, in order (entry 5.6). */
export const WORKSPACE_TABS = ["brief", "design", "review", "files", "history"] as const;

export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

/** The tab labels the workspace shows. */
export const TAB_LABELS: Record<WorkspaceTab, string> = {
    brief: "Brief", design: "Design", review: "Review", files: "Files", history: "History",
};

/** The view tabs of a session with a `design` block, and of one without (entry 5.11). */
export const DESIGN_VIEWS = ["agents", "design", "mission", "threads", "services"];
export const PLAIN_VIEWS = ["agents", "mission", "threads", "services"];

/** The view tabs of the agents pane: `design` only for a session with a `design` block. */
export function viewTabs(view: SessionView | undefined): string[] {
    return view?.design === undefined ? PLAIN_VIEWS : DESIGN_VIEWS;
}

/** The shown view: `shown` when the session offers it, else `agents`. */
export function shownView(view: SessionView | undefined, shown: string): string {
    return viewTabs(view).includes(shown) ? shown : "agents";
}

/** The tab the workspace opens on when nobody picked one: Files on the direct track. */
export function defaultTab(design: DesignView): WorkspaceTab {
    return design.track === "direct" ? "files" : "brief";
}

/** The workspace tab of a stepper step (entry 5.11): approve and build read the doc. */
export function stepTab(step: StepId): WorkspaceTab {
    switch (step) {
        case "brainstorm":
            return "brief";
        case "review":
            return "review";
        default:
            return "design";
    }
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
