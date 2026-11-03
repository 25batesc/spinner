// The composer (s038): a new session starts in the working area, as in Devin. The middle pane
// holds one large box and nothing else; the activity drawer stays at the bottom, so the job
// that `Start` posts shows where a session's jobs show. The App renders this pane for
// `+ New session` and while no session is selected.
import type { ReactNode } from "react";

export function ComposerPane(props: { label: string; form: ReactNode; children?: ReactNode }) {
    return (
        <section className="pane composer-pane" aria-label={props.label}>
            <div className="composer">{props.form}</div>
            {props.children}
        </section>
    );
}
