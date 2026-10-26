// A row of tab buttons. It holds no state: the parent owns the selected tab.

export interface TabsProps {
    labels: string[];
    selected: string | undefined;
    onSelect: (label: string) => void;
}

export function Tabs({ labels, selected, onSelect }: TabsProps) {
    return (
        <div className="tabs" role="tablist">
            {labels.map((label) => (
                <button
                    key={label}
                    role="tab"
                    aria-selected={label === selected}
                    className={label === selected ? "tab tab-selected" : "tab"}
                    onClick={() => onSelect(label)}
                >
                    {label}
                </button>
            ))}
        </div>
    );
}
