// The header of a pane: its name and, in the main window, the `hide` and `pop out` controls.
// A pane rendered alone by the `?pane=` route has no controls: closing the window docks it.
import type { PaneName } from "./layout.ts";

export interface PaneControls {
    onHide: () => void;
    onPopOut: () => void;
}

export interface PaneHeadProps {
    name: PaneName;
    controls: PaneControls | undefined;
}

export function PaneHead({ name, controls }: PaneHeadProps) {
    return (
        <header className="pane-head">
            <h2>{name}</h2>
            {controls !== undefined && (
                <span className="pane-controls">
                    <button className="link" onClick={controls.onHide} aria-label={`Hide ${name}`}>
                        hide
                    </button>
                    <button
                        className="link"
                        onClick={controls.onPopOut}
                        aria-label={`Pop out ${name}`}
                    >
                        pop out
                    </button>
                </span>
            )}
        </header>
    );
}

export interface PaneStripProps {
    name: PaneName;
    popped: boolean;
    /** Restores a collapsed pane, or docks a popped-out one back. */
    onRestore: () => void;
}

/** The 24 px strip that stands in for a collapsed, hidden or popped-out pane. */
export function PaneStrip({ name, popped, onRestore }: PaneStripProps) {
    const verb = popped ? "Dock" : "Restore";
    return (
        <button
            className={popped ? "strip strip-popped" : "strip"}
            onClick={onRestore}
            aria-label={`${verb} ${name}`}
            title={popped ? `${name} is in its own window; click to dock it back` : ""}
            data-pane={name}
        >
            {popped ? `${name} · popped out` : name}
        </button>
    );
}
