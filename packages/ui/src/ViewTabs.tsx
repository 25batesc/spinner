// The view tabs across the top of a pane: underlined, no borders, the pane's icon buttons at
// the right of the row. The agents pane and the previews pane share it; each owns the shown
// view. A tab can carry a step mark (docs/designs/session-workspace.md, T5): a state dot
// before the label, a tooltip, and a suffix such as `2/5`. When the row overflows its width,
// the tabs named in `fold` become one tab with a menu; the fold keeps the hysteresis of the
// old context-bar stepper, measured on the row itself.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import type { StepState } from "./design.ts";
import { IconButton, type IconButtonProps } from "./PaneHead.tsx";

export interface ViewTab {
    id: string;
    label: string;
}

export interface ViewTabMark {
    state: StepState;
    title: string;
    suffix?: string | undefined;
}

export interface ViewTabFold {
    /** The tabs that fold, in row order. */
    ids: readonly string[];
    /** The folded tab's label, `EGM 3/5 Review`. */
    label: string;
    /** The tab the folded tab opens on a plain click. */
    opens: string;
    /** The folded tab's tooltip. */
    title?: string | undefined;
}

export interface ViewTabsProps {
    tabs: readonly ViewTab[];
    shown: string;
    onSelect: (id: string) => void;
    /** The pane's icons; absent when the `?pane=` route renders the pane alone. */
    controls: IconButtonProps[] | undefined;
    /** An icon button before the tabs, for example the side-panel toggle. */
    leading?: IconButtonProps | undefined;
    /** The accessible name of the row; two panes must not share one. */
    label?: string;
    /** The step marks by tab id. */
    marks?: Partial<Record<string, ViewTabMark>> | undefined;
    /** The tabs that fold into one when the row overflows. */
    fold?: ViewTabFold | undefined;
}

/**
 * True while the row's content is wider than the row. On a fold it records the width the full
 * row needs, and it unfolds only once the row is that wide, so a fold never flips back and
 * forth. The caller keys the row by session, so the record resets with the row's content.
 */
export function useRowFold(ref: RefObject<HTMLElement | null>): boolean {
    const [need, setNeed] = useState<number | null>(null);
    const check = () => {
        const row = ref.current;
        if (row === null) {
            return;
        }
        const width = row.clientWidth;
        setNeed((old) => {
            if (old !== null) {
                return width >= old ? null : old;
            }
            const deficit = Math.max(0, row.scrollWidth - row.clientWidth);
            return deficit > 0 ? width + deficit : null;
        });
    };
    // Every render: the row's content (the marks, the suffixes) moves with the view.
    useLayoutEffect(check);
    useEffect(() => {
        const row = ref.current;
        if (row === null) {
            return;
        }
        const observer = new ResizeObserver(check);
        observer.observe(row);
        return () => observer.disconnect();
        // `check` reads the ref and the setter only; one observer per mount.
    }, []);
    return need !== null;
}

/** The state dot before a marked tab's label; the state is in the accessible name too. */
function TabMarkDot({ mark }: { mark: ViewTabMark }) {
    return (
        <span
            className={`view-tab-mark view-tab-mark-${mark.state}`}
            aria-label={mark.state}
            data-state={mark.state}
        />
    );
}

function TabButton(props: {
    tab: ViewTab;
    shown: string;
    mark: ViewTabMark | undefined;
    onSelect: (id: string) => void;
}) {
    const { tab, shown, mark, onSelect } = props;
    const selected = tab.id === shown;
    return (
        <button
            role="tab"
            aria-selected={selected}
            className={selected ? "tab view-tab tab-selected" : "tab view-tab"}
            data-view={tab.id}
            data-state={mark?.state}
            title={mark?.title}
            onClick={() => onSelect(tab.id)}
        >
            {mark !== undefined && <TabMarkDot mark={mark} />}
            {tab.label}
            {mark?.suffix !== undefined && (
                <span className="view-tab-suffix">{mark.suffix}</span>
            )}
        </button>
    );
}

/** The folded tab: a click opens `fold.opens`; the chevron opens a menu of the folded tabs. */
function FoldedTab(props: {
    tabs: readonly ViewTab[];
    fold: ViewTabFold;
    shown: string;
    marks: Partial<Record<string, ViewTabMark>>;
    onSelect: (id: string) => void;
}) {
    const { tabs, fold, shown, marks, onSelect } = props;
    const [open, setOpen] = useState(false);
    const selected = fold.ids.includes(shown);
    const current = marks[fold.opens];
    const pick = (id: string) => {
        setOpen(false);
        onSelect(id);
    };
    return (
        <span className="view-tab-fold">
            <button
                role="tab"
                aria-selected={selected}
                className={selected ? "tab view-tab tab-selected" : "tab view-tab"}
                data-view="egm"
                data-state={current?.state}
                title={fold.title}
                onClick={() => pick(fold.opens)}
            >
                {current !== undefined && <TabMarkDot mark={current} />}
                {fold.label}
            </button>
            <button
                type="button"
                className="tab view-tab view-tab-fold-toggle"
                aria-label="EGM tabs"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                {"\u25be"}
            </button>
            {open && (
                <div className="menu" role="menu" aria-label="EGM tabs">
                    {tabs.map((tab) => (
                        <button
                            key={tab.id}
                            type="button"
                            role="menuitem"
                            data-view={tab.id}
                            title={marks[tab.id]?.title}
                            onClick={() => pick(tab.id)}
                        >
                            {marks[tab.id] !== undefined && (
                                <TabMarkDot mark={marks[tab.id] as ViewTabMark} />
                            )}
                            {tab.label}
                        </button>
                    ))}
                </div>
            )}
        </span>
    );
}

export function ViewTabs(props: ViewTabsProps) {
    const { tabs, shown, onSelect, controls, leading, label = "Views", fold } = props;
    const marks = props.marks ?? {};
    const ref = useRef<HTMLElement | null>(null);
    const folded = useRowFold(ref) && fold !== undefined;
    const folding = folded && fold !== undefined ? fold : null;
    const foldable = folding === null ? [] : tabs.filter((tab) => folding.ids.includes(tab.id));
    const first = foldable[0]?.id;
    return (
        <nav ref={ref} className="view-tabs" role="tablist" aria-label={label}>
            {leading !== undefined && <IconButton {...leading} />}
            {tabs.map((tab) => {
                if (folding !== null && folding.ids.includes(tab.id)) {
                    // The folded tab stands where the first folded tab stood.
                    return tab.id === first ? (
                        <FoldedTab
                            key="egm"
                            tabs={foldable}
                            fold={folding}
                            shown={shown}
                            marks={marks}
                            onSelect={onSelect}
                        />
                    ) : null;
                }
                return (
                    <TabButton
                        key={tab.id}
                        tab={tab}
                        shown={shown}
                        mark={marks[tab.id]}
                        onSelect={onSelect}
                    />
                );
            })}
            {controls !== undefined && controls.length > 0 && (
                <span className="pane-controls">
                    {controls.map((control) => (
                        <IconButton key={control.label} {...control} />
                    ))}
                </span>
            )}
        </nav>
    );
}
