// The Goldfish chips under the agent chips (docs/designs/egm-adoption.md, entry 4.14, Technical
// Plan T5): one chip per step of the newest 3 runs, the newest run first. A chip is a fact like
// a review chip: the 🐟 mark, a state dot, the persona, the tokens and `$`; the model and the
// state are its tooltip. A click selects it, and the agents view shows its transcript. While
// the global cap holds, a line under the chips says that new skill starts wait.
import type { DesignView, GoldfishView } from "@spinner/protocol";

import { formatUsd } from "./costs.ts";
import {
    capLine, chipLabel, chipTitle, goldfishDot, GOLDFISH_CHIP_RUNS, newestRuns, tokensLabel,
} from "./goldfish.ts";

/** A chip's identity: its run and its step index, as the events route names it. */
export interface GoldfishPick {
    run: string;
    step: number;
}

export interface GoldfishChipsProps {
    design: DesignView;
    selected: GoldfishPick | null;
    onPick: (pick: GoldfishPick) => void;
}

function GoldfishChip(props: { view: GoldfishView; current: boolean; onPick: () => void }) {
    const { view, current, onPick } = props;
    const classes = ["chip", "gf-chip", `gf-chip-${view.state}`, current ? "chip-selected" : ""];
    return (
        <span className={classes.join(" ").trim()} data-state={view.state}>
            <button
                type="button"
                role="tab"
                aria-selected={current}
                className={current ? "tab chip-name tab-selected" : "tab chip-name"}
                title={chipTitle(view)}
                data-run={view.run}
                data-step={view.step}
                onClick={onPick}
            >
                <span className="gf-mark" aria-hidden="true">🐟</span>
                <span className={`dot chip-dot ${goldfishDot(view.state)}`} />
                <span className="gf-name">{chipLabel(view)}</span>
                <span className="muted gf-fact">{tokensLabel(view.tokens)}</span>
                <span className="muted gf-fact">{formatUsd(view.usd)}</span>
            </button>
        </span>
    );
}

export function GoldfishChips({ design, selected, onPick }: GoldfishChipsProps) {
    const chips = newestRuns(design.goldfish, GOLDFISH_CHIP_RUNS);
    const cap = capLine(design.goldfish_live);
    return (
        <div className="gf-block">
            {chips.length > 0 && (
                <div className="chips gf-chips" role="tablist" aria-label="Goldfish">
                    {chips.map((view) => (
                        <GoldfishChip
                            key={`${view.run}/${view.step}`}
                            view={view}
                            current={selected?.run === view.run && selected.step === view.step}
                            onPick={() => onPick({ run: view.run, step: view.step })}
                        />
                    ))}
                </div>
            )}
            {cap !== null && <p className="muted gf-cap">{cap}</p>}
        </div>
    );
}
