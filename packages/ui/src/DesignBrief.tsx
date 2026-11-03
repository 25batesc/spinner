// The Brief tab of the design workspace (docs/designs/egm-adoption.md, entry 5.7): the gate
// card while the lead asks, then `concepts_brief.md` rendered as markdown.
import { BRIEF_FILE, type SessionView } from "@spinner/protocol";

import { hasBrief } from "./design-workspace.ts";
import { DesignGate } from "./DesignGate.tsx";
import { MarkdownFile } from "./DesignFiles.tsx";
import { fetchDesignFile } from "./remote.ts";

export interface DesignBriefProps {
    view: SessionView;
    /** The workspace's reload key (entry 5.6). */
    reload: string;
    onError: (message: string) => void;
}

export function DesignBrief({ view, reload, onError }: DesignBriefProps) {
    const design = view.design;
    const dir = view.summary.dir;
    if (design === undefined) {
        return null;
    }
    const gate = design.gate;
    return (
        <div className="dw-tab-body">
            {gate !== null && (
                <DesignGate key={gate.asked} kind="gate" dir={dir} gate={gate} onError={onError} />
            )}
            {hasBrief(design) ? (
                <MarkdownFile
                    loadKey={`${reload}#brief`}
                    read={(signal) => fetchDesignFile(dir, BRIEF_FILE, signal)}
                    label={BRIEF_FILE}
                />
            ) : (
                <p className="muted dw-empty">
                    No brief yet. Start with <code>brainstorm</code>.
                </p>
            )}
        </div>
    );
}
