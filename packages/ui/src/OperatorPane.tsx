// The operator tab: the middle pane's view of the operator agent, opened from the headset
// icon in the activity bar. It is not a session: one tab across the top, `stop` or `resume`
// with the line that says what the agent waits on, then the agent's terminal full width (the
// agents pane's terminal component pointed at `/operator/tty`). The side panel and the
// previews stay as they are around it. The view comes from `GET /operator` and every
// `operator.updated`; a start or stop answers with the same view.
import { useState } from "react";

import type { OperatorView } from "@spinner/protocol";
import { OPERATOR_TTY_PATH } from "@spinner/protocol";

import { AgentTerminal } from "./AgentTerminal.tsx";
import { operatorRunning, postOperator, waitingLine } from "./operator.ts";
import { IconButton, type IconButtonProps } from "./PaneHead.tsx";

export interface OperatorPaneProps {
    view: OperatorView | null;
    /** Header icons; absent when the pane is rendered alone by the `?pane=` route. */
    controls?: IconButtonProps[] | undefined;
}

/** `waiting on: …` with the pid and the model, as the chip tooltip names an agent. */
function detailLine(view: OperatorView): string {
    const model = view.model ?? "pi's default model";
    const pid = view.pid === null ? "no process" : `pid ${view.pid}`;
    return `${model} · ${pid} · ${view.process}`;
}

/**
 * Mounted only while the tab shows: the daemon replays the pty's scrollback on the next
 * attach, so a hidden tab needs no socket of its own, unlike a session's agent tabs.
 */
export function OperatorPane({ view, controls }: OperatorPaneProps) {
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const running = operatorRunning(view);
    // The answer is the view the event carries too; the state takes it from the event.
    const act = async (action: "start" | "stop") => {
        setBusy(true);
        setFailure(null);
        try {
            await postOperator(action);
        } catch (error: unknown) {
            setFailure(String(error));
            throw error;
        } finally {
            setBusy(false);
        }
    };
    const click = (action: "start" | "stop") => () => void act(action).catch(() => undefined);
    return (
        <section className="pane agents-pane operator-pane" aria-label="Operator">
            <nav className="view-tabs" role="tablist" aria-label="Views">
                <button role="tab" aria-selected className="tab view-tab tab-selected">
                    operator
                </button>
                {controls !== undefined && controls.length > 0 && (
                    <span className="pane-controls">
                        {controls.map((control) => (
                            <IconButton key={control.label} {...control} />
                        ))}
                    </span>
                )}
            </nav>
            <div
                className="actions toolbar operator-toolbar"
                role="toolbar"
                aria-label="Operator actions"
            >
                {running ? (
                    <button
                        className="danger"
                        disabled={busy}
                        title="Stop the operator agent's process; its transcript stays"
                        onClick={click("stop")}
                    >
                        stop
                    </button>
                ) : (
                    <button
                        className="primary"
                        disabled={busy || view === null}
                        title="Start the operator agent again on its transcript"
                        onClick={click("start")}
                    >
                        resume
                    </button>
                )}
                <span className="toolbar-sep" />
                <span
                    className="muted operator-waiting"
                    title={view === null ? undefined : detailLine(view)}
                >
                    {waitingLine(view)}
                </span>
                {failure !== null && <span className="error">{failure}</span>}
            </div>
            <div className="chat">
                {view === null ? (
                    <p className="muted">This daemon has no operator agent.</p>
                ) : (
                    <AgentTerminal path={OPERATOR_TTY_PATH} running={running} visible />
                )}
            </div>
        </section>
    );
}
