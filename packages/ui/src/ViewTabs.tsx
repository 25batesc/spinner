// The view tabs across the top of a pane: underlined, no borders, the pane's icon buttons at
// the right of the row. The agents pane and the previews pane share it; each owns the shown
// view.
import { IconButton, type IconButtonProps } from "./PaneHead.tsx";

export interface ViewTabsProps {
    labels: readonly string[];
    shown: string;
    onSelect: (view: string) => void;
    /** The pane's icons; absent when the `?pane=` route renders the pane alone. */
    controls: IconButtonProps[] | undefined;
    /** An icon button before the tabs, for example the side-panel toggle. */
    leading?: IconButtonProps | undefined;
    /** The accessible name of the row; two panes must not share one. */
    label?: string;
}

export function ViewTabs(props: ViewTabsProps) {
    const { labels, shown, onSelect, controls, leading, label = "Views" } = props;
    return (
        <nav className="view-tabs" role="tablist" aria-label={label}>
            {leading !== undefined && <IconButton {...leading} />}
            {labels.map((item) => (
                <button
                    key={item}
                    role="tab"
                    aria-selected={item === shown}
                    className={item === shown ? "tab view-tab tab-selected" : "tab view-tab"}
                    onClick={() => onSelect(item)}
                >
                    {item}
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
