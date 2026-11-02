// The About EGM block, the last one in settings (docs/designs/egm-adoption.md, entry 1.36): the
// attribution, the source, the pin, the licence, the fetch state and, when EGM is absent or a
// fetch failed, a `fetch` button. The button starts a job `egm`; the block does not track the
// job itself. Its load key names the last `egm` job and that job's state, so the `job.started`
// and `job.finished` events reload `GET /egm`.
import { useState } from "react";

import { EGM_NOTICE, type EgmFetchState, type Job } from "@spinner/protocol";

import { egmKey, egmLine } from "./about-egm.ts";
import { postAction } from "./events-client.ts";
import { fetchEgm, useLoaded } from "./remote.ts";

/** The pill of each fetch state, from the DESIGN-PASS state pills. */
const STATE_PILL: Record<EgmFetchState, string> = {
    ready: "pill pill-ok",
    fetching: "pill pill-accent",
    failed: "pill pill-fail",
    absent: "pill",
};

/** The pin as the block shows it: the first 12 characters of the commit. */
const PIN_SHOWN_LENGTH = 12;

export function AboutEgm(props: { jobs: readonly Job[] }) {
    const loaded = useLoaded(egmKey(props.jobs), fetchEgm);
    const [error, setError] = useState<string | null>(null);
    const status = loaded.value?.egm;
    const fetchable =
        status !== undefined && (status.state === "absent" || status.state === "failed");
    const start = () => {
        postAction("/egm/fetch").then(
            () => setError(null),
            (failure: unknown) => setError(String(failure)),
        );
    };
    return (
        <fieldset className="setting about-egm" aria-label="About EGM">
            <legend>About EGM</legend>
            <p className="about-egm-notice">{EGM_NOTICE}</p>
            {status === undefined ? (
                <p className="muted">{loaded.error ?? "Loading the EGM state…"}</p>
            ) : (
                <dl className="about-egm-facts">
                    <dt>Source</dt>
                    <dd>
                        <a href={status.source} target="_blank" rel="noreferrer">
                            {status.source}
                        </a>
                    </dd>
                    <dt>Pin</dt>
                    <dd>
                        pinned <code>{status.pinned_sha.slice(0, PIN_SHOWN_LENGTH)}</code>
                    </dd>
                    <dt>License</dt>
                    <dd>{status.license}</dd>
                    <dt className="about-egm-state">State</dt>
                    <dd className="about-egm-state">
                        <span className={STATE_PILL[status.state]}>{egmLine(status)}</span>
                    </dd>
                </dl>
            )}
            {fetchable && (
                <span className="about-egm-actions">
                    <button type="button" className="primary" onClick={start}>
                        fetch
                    </button>
                </span>
            )}
            {error !== null && <p className="needs-human">{error}</p>}
        </fieldset>
    );
}
