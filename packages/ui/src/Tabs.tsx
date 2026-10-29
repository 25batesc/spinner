// A row of tab buttons. It holds no state: the parent owns the selected tab.

export interface TabsProps {
    labels: string[];
    selected: string | undefined;
    onSelect: (label: string) => void;
    /** Labels drawn grey, for example a preview whose service is not healthy yet. */
    grey?: string[];
    /** A status dot before a label: the state word, which is the dot's colour and tooltip. */
    dots?: Partial<Record<string, string>>;
}

export function Tabs({ labels, selected, onSelect, grey = [], dots = {} }: TabsProps) {
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
                    {dots[label] !== undefined && (
                        <span className={`dot tab-dot dot-${dots[label]}`} title={dots[label]} />
                    )}
                    {label}
                </button>
            ))}
        </div>
    );
}
