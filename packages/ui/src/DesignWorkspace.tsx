// The design workspace (docs/designs/egm-adoption.md, build session 5, Technical Plan T13): the
// `design` view of the agents pane for a session with a `design` block. Five tabs: Brief,
// Design, Review, Files and History. The tab is held outside, so a stepper step or the round
// badge opens the workspace on its tab; until someone picks one, the workspace opens on Brief,
// or on Files on the direct track. Every read reloads when the newest design file or the doc
// path moves (entry 5.6).
import type { SessionView } from "@spinner/protocol";

import {
    defaultTab, reloadKey, TAB_LABELS, WORKSPACE_TABS, type WorkspaceTab,
} from "./design-workspace.ts";
import { DesignBrief } from "./DesignBrief.tsx";
import { DesignDoc } from "./DesignDoc.tsx";
import { DesignFiles } from "./DesignFiles.tsx";
import { DesignHistory } from "./DesignHistory.tsx";
import { DesignReview } from "./DesignReview.tsx";
import { needsHuman } from "./state.ts";
import { Tabs } from "./Tabs.tsx";

export interface DesignWorkspaceProps {
    view: SessionView;
    /** The tab picked from outside or by a click; null opens the track's default tab. */
    tab: WorkspaceTab | null;
    onTab: (tab: WorkspaceTab) => void;
    /** Where a refused answer goes: the drawer, as a failed job's error does. */
    onError: (message: string) => void;
}

export function DesignWorkspace({ view, tab, onTab, onError }: DesignWorkspaceProps) {
    const design = view.design;
    if (design === undefined) {
        return null;
    }
    const shown = tab ?? defaultTab(design);
    const reload = reloadKey(view.summary.dir, design);
    const pick = (label: string) => {
        const next = WORKSPACE_TABS.find((id) => TAB_LABELS[id] === label);
        if (next !== undefined) {
            onTab(next);
        }
    };
    return (
        <div className="dw" aria-label="Design workspace" data-tab={shown}>
            <Tabs
                variant="sub"
                labels={WORKSPACE_TABS.map((id) => TAB_LABELS[id])}
                selected={TAB_LABELS[shown]}
                onSelect={pick}
            />
            {shown === "brief" && <DesignBrief view={view} reload={reload} onError={onError} />}
            {shown === "design" && <DesignDoc view={view} reload={reload} onError={onError} />}
            {shown === "review" && (
                <DesignReview
                    view={view}
                    reload={reload}
                    needs={needsHuman(view)}
                    onError={onError}
                />
            )}
            {shown === "files" && <DesignFiles view={view} reload={reload} />}
            {shown === "history" && <DesignHistory view={view} />}
        </div>
    );
}
