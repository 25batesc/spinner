// The view tabs across the top of a pane: underlined, no borders, the pane's icon buttons at
// the right of the row. The agents pane, the previews pane and the review pane share it;
// each owns the shown view. In a narrow pane the row scrolls sideways.
import { IconButton, type IconButtonProps } from "./PaneHead.tsx";

export interface ViewTab {
    id: string;
    label: string;
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
}

export function ViewTabs(props: ViewTabsProps) {
    const { tabs, shown, onSelect, controls, leading, label = "Views" } = props;
    return (
        <nav className="view-tabs" role="tablist" aria-label={label}>
            {leading !== undefined && <IconButton {...leading} />}
            {tabs.map((tab) => (
                <button
                    key={tab.id}
                    role="tab"
                    aria-selected={tab.id === shown}
                    className={tab.id === shown ? "tab view-tab tab-selected" : "tab view-tab"}
                    data-view={tab.id}
                    onClick={() => onSelect(tab.id)}
                >
                    {tab.label}
                </button>
            ))}
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
