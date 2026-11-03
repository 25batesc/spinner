// The toolbar's design group (docs/designs/egm-adoption.md, entry 3.19, Technical Plan T9 and
// T13): one filled primary button whose label follows the design stage, and the `EGM ▾` menu
// with the skills. `brainstorm` asks an optional concept, `review design` a preset, and the
// menu's `review loop`, `resolve`, `drift report` and `bootstrap` one prefilled field; `draft`
// runs at once. Each run is `POST …/design/run`; the daemon composes the arguments and the
// `session.updated` that follows moves the stepper. A refusal goes to the drawer. At
// `design-ready` the primary opens the approve dialog, and while an approval exists the menu
// ends with `remove approval`, a `DELETE …/design/approve` (entry 6.17).
import { useState, type ReactNode } from "react";

import {
    REVIEW_PRESETS, type EgmSkill, type ReviewPreset, type SessionView,
} from "@spinner/protocol";

import { ApproveDesign } from "./ApproveDesign.tsx";
import {
    designPaths, egmMenu, primaryAction, type MenuField, type MenuItem,
} from "./design.ts";
import { deleteDesignApprove, postDesignRun } from "./remote.ts";

export interface DesignActionsProps {
    /** A session with a `design` block. */
    view: SessionView;
    /** True when the group renders inside the toolbar's `⋯` menu (compact mode). */
    inMenu: boolean;
    /** Where a refused run goes: the drawer, as a failed job's error does. */
    onError: (message: string) => void;
}

/** The preset radio labels; `uninterrupted` is EGM's consolidated report and the default [D4]. */
const PRESET_LABELS: Record<ReviewPreset, string> = {
    uninterrupted: "consolidated report",
    interactive: "interactive, a gate after each stage",
    feature_spec: "feature spec first",
    implementation: "implementation plan",
};

/** The default preset of the review dialog [D4]. */
const PRESET_DEFAULT: ReviewPreset = "uninterrupted";

/** The field dialogs' headings and labels. */
const FIELD_LABELS: Record<Exclude<MenuField, null>, string> = {
    concept: "concept",
    target: "target file",
    dir: "designs directory",
    path: "path",
};

type Dialog =
    | { kind: "concept" }
    | { kind: "preset" }
    | { kind: "field"; item: MenuItem; value: string }
    | { kind: "approve" };

/** One sentence per primary button, as its tooltip. */
const PRIMARY_TIPS: Partial<Record<EgmSkill, string>> = {
    "egm-brainstorm": "Start egm-brainstorm in the lead, with an optional concept.",
    "egm-draft": "Start egm-draft in the lead on the concepts brief.",
    "egm-review": "Start egm-review on the design doc; Goldfish review it from a fresh context.",
};

/** The approve primary's tooltip (D2, D5). */
const APPROVE_TIP = "Approve the design doc; the dialog starts the build by default.";

/** The `remove approval` item's tooltip (Technical Plan T10). */
const REMOVE_TIP = "Remove the approval; the lead's code writes lock until you approve again.";

export function DesignActions({ view, inMenu, onError }: DesignActionsProps) {
    const design = view.design;
    const [menuOpen, setMenuOpen] = useState(false);
    const [dialog, setDialog] = useState<Dialog | null>(null);
    const [posting, setPosting] = useState(false);
    if (design === undefined) {
        return null;
    }
    const dir = view.summary.dir;
    const changed = Object.values(view.summary.session.repos).some((repo) => repo.changed);
    const items = egmMenu(design, changed);
    const primary = primaryAction(design);
    const paths = designPaths(view);

    const run = (skill: EgmSkill, extra: { args?: string; preset?: ReviewPreset } = {}) => {
        setPosting(true);
        postDesignRun(dir, { skill, ...extra }).then(
            () => {
                setPosting(false);
                setDialog(null);
            },
            (failure: unknown) => {
                setPosting(false);
                onError(String(failure));
            },
        );
    };
    const prefill = (field: MenuField): string => {
        if (field === "target") {
            return paths.doc ?? "";
        }
        if (field === "dir") {
            return paths.designs ?? "";
        }
        return field === "path" ? paths.root ?? "" : "";
    };
    // The same path for the primary button and the menu: a dialog where the skill asks for
    // something, else the run at once.
    const start = (item: Pick<MenuItem, "skill" | "field">) => {
        setMenuOpen(false);
        if (item.skill === "egm-brainstorm") {
            setDialog({ kind: "concept" });
        } else if (item.skill === "egm-review") {
            setDialog({ kind: "preset" });
        } else if (item.field === null) {
            run(item.skill);
        } else {
            const found = items.find((entry) => entry.skill === item.skill);
            if (found !== undefined) {
                setDialog({ kind: "field", item: found, value: prefill(found.field) });
            }
        }
    };
    const removeApproval = () => {
        setMenuOpen(false);
        setPosting(true);
        deleteDesignApprove(dir).then(
            () => setPosting(false),
            (failure: unknown) => {
                setPosting(false);
                onError(String(failure));
            },
        );
    };
    const primaryButton = primary === null ? null : (
        <button
            type="button"
            className="primary design-primary"
            disabled={posting}
            title={primary.kind === "run" ? PRIMARY_TIPS[primary.skill] : APPROVE_TIP}
            onClick={() => {
                if (primary.kind === "run") {
                    start({ skill: primary.skill, field: null });
                } else {
                    setDialog({ kind: "approve" });
                }
            }}
        >
            {primary.label}
        </button>
    );
    const menuItems = items.map((item) => (
        <button
            key={item.skill}
            type="button"
            role="menuitem"
            data-skill={item.skill}
            disabled={posting || item.disabled !== null}
            title={item.disabled ?? `/skill:${item.skill}`}
            onClick={() => start(item)}
        >
            {item.label}
        </button>
    ));
    if (design.approved !== null) {
        menuItems.push(
            <button
                key="remove-approval"
                type="button"
                role="menuitem"
                className="danger"
                data-action="remove-approval"
                disabled={posting}
                title={REMOVE_TIP}
                onClick={removeApproval}
            >
                remove approval
            </button>,
        );
    }
    const dialogs = dialog === null ? null : dialog.kind === "approve" ? (
        <ApproveDesign view={view} onClose={() => setDialog(null)} />
    ) : (
        <RunDialog
            key={dialog.kind}
            dialog={dialog}
            posting={posting}
            onChange={setDialog}
            onCancel={() => setDialog(null)}
            onRun={run}
        />
    );
    if (inMenu) {
        // Compact: the primary button and the skills join the `⋯` menu at the top.
        return (
            <span className="toolbar-group design-group" aria-label="EGM">
                {primaryButton}
                {menuItems}
                {dialogs}
            </span>
        );
    }
    return (
        <span className="toolbar-group design-group">
            {primaryButton}
            <span className="design-menu">
                <button
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    title="The EGM skills"
                    onClick={() => setMenuOpen(!menuOpen)}
                >
                    EGM {"\u25be"}
                </button>
                {menuOpen && (
                    <div className="menu" role="menu" aria-label="EGM skills">
                        {menuItems}
                    </div>
                )}
            </span>
            {dialogs}
        </span>
    );
}

interface RunDialogProps {
    dialog: Exclude<Dialog, { kind: "approve" }>;
    posting: boolean;
    onChange: (dialog: Dialog) => void;
    onCancel: () => void;
    onRun: (skill: EgmSkill, extra?: { args?: string; preset?: ReviewPreset }) => void;
}

/** The confirm card of a skill that asks for something before it runs. */
function RunDialog({ dialog, posting, onChange, onCancel, onRun }: RunDialogProps) {
    const [concept, setConcept] = useState("");
    const [preset, setPreset] = useState<ReviewPreset>(PRESET_DEFAULT);
    let title: string;
    let body: ReactNode;
    let confirm: () => void;
    let ready = true;
    if (dialog.kind === "concept") {
        title = "Brainstorm";
        body = (
            <label className="field">
                <span className="field-label">concept (optional)</span>
                <textarea
                    autoFocus
                    rows={5}
                    aria-label="Concept"
                    value={concept}
                    onChange={(event) => setConcept(event.target.value)}
                />
            </label>
        );
        const args = concept.trim();
        confirm = () => onRun("egm-brainstorm", args === "" ? {} : { args });
    } else if (dialog.kind === "preset") {
        title = "Review the design";
        body = (
            <fieldset className="design-presets">
                <legend className="field-label">preset</legend>
                {REVIEW_PRESETS.map((name) => (
                    <label key={name} className="design-preset">
                        <input
                            type="radio"
                            name="preset"
                            value={name}
                            checked={preset === name}
                            onChange={() => setPreset(name)}
                        />
                        {PRESET_LABELS[name]} <code className="muted">{name}</code>
                    </label>
                ))}
            </fieldset>
        );
        confirm = () => onRun("egm-review", { preset });
    } else {
        const { item, value } = dialog;
        const label = item.field === null ? "" : FIELD_LABELS[item.field];
        title = item.label[0]?.toUpperCase() + item.label.slice(1);
        body = (
            <label className="field">
                <span className="field-label">{label}</span>
                <input
                    autoFocus
                    aria-label={label}
                    value={value}
                    onChange={(event) => onChange({ ...dialog, value: event.target.value })}
                />
            </label>
        );
        ready = value.trim() !== "";
        confirm = () => onRun(item.skill, { args: value.trim() });
    }
    return (
        <div className="confirm design-dialog" role="dialog" aria-label={title}>
            <h3>{title}</h3>
            {body}
            <span className="confirm-actions">
                <button
                    type="button"
                    className="primary"
                    disabled={posting || !ready}
                    onClick={confirm}
                >
                    run
                </button>
                <button type="button" onClick={onCancel}>cancel</button>
            </span>
        </div>
    );
}
