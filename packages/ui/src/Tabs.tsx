// A row of tab buttons. It holds no state: the parent owns the selected tab.

export interface TabsProps {
    labels: string[];
    selected: string | undefined;
    onSelect: (label: string) => void;
    /** Labels drawn grey, for example a preview whose service is not healthy yet. */
    grey?: string[];
}

export function Tabs({ labels, selected, onSelect, grey = [] }: TabsProps) {
    return (
        <div className="tabs" role="tablist">
            {labels.map((label) => (
                <button
                    key={label}
                    role="tab"
                    aria-selected={label === selected}
                    className={[
                        "tab",
                        label === selected ? "tab-selected" : "",
                        grey.includes(label) ? "tab-grey" : "",
                    ].join(" ")}
                    onClick={() => onSelect(label)}
                >
                    {label}
                </button>
            ))}
        </div>
    );
}
