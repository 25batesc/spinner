// The selected Goldfish's transcript (docs/designs/egm-adoption.md, entry 4.15): read-only,
// folded and rendered as the `chat` tab of an rpc agent, without the prompt form. The daemon
// reads the step's `sessionFile`; the view reloads it every `GOLDFISH_POLL_MS` while the chip
// is `running`, because a child's events do not reach the events socket.
import { useEffect, useState } from "react";

import { GOLDFISH_POLL_MS, type GoldfishView } from "@spinner/protocol";

import { TranscriptView } from "./AgentChat.tsx";
import { formatUsd } from "./costs.ts";
import { chipLabel, tokensLabel } from "./goldfish.ts";
import { fetchGoldfishEvents } from "./remote.ts";
import { emptyTranscript, foldEvent, type Transcript } from "./transcript.ts";

interface Loaded {
    /** `<dir>/<run>/<step>`: a load for another chip does not show under this one. */
    key: string;
    /** Null while the daemon has no transcript file for the step (a 404). */
    transcript: Transcript | null;
    error: string | null;
}

/** Loads the step's events once, and again every poll interval while `running`. */
function useGoldfishTranscript(dir: string, run: string, step: number, running: boolean) {
    const key = `${dir}/${run}/${step}`;
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    useEffect(() => {
        const abort = new AbortController();
        const load = () => {
            fetchGoldfishEvents(dir, run, step, abort.signal).then(
                (events) => {
                    const transcript = events === null
                        ? null
                        : events.reduce(foldEvent, emptyTranscript);
                    setLoaded({ key, transcript, error: null });
                },
                (failure: unknown) => {
                    if (!abort.signal.aborted) {
                        setLoaded({ key, transcript: null, error: String(failure) });
                    }
                },
            );
        };
        load();
        const timer = running ? setInterval(load, GOLDFISH_POLL_MS) : undefined;
        return () => {
            abort.abort();
            clearInterval(timer);
        };
    }, [dir, run, step, running, key]);
    return loaded?.key === key ? loaded : null;
}

export function GoldfishTranscript({ dir, view }: { dir: string; view: GoldfishView }) {
    const loaded = useGoldfishTranscript(dir, view.run, view.step, view.state === "running");
    const facts = [
        view.state, view.model ?? "model unknown", `${tokensLabel(view.tokens)} tokens`,
        formatUsd(view.usd),
    ].join(" · ");
    return (
        <div className="gf-transcript" aria-label="Goldfish transcript">
            <p className="muted agent-status">
                <span className="gf-mark" aria-hidden="true">🐟</span> {chipLabel(view)} · {facts}
                {" · read-only"}
            </p>
            {loaded === null && <p className="muted">Loading the transcript.</p>}
            {loaded?.error !== null && loaded?.error !== undefined && (
                <p className="needs-human">{loaded.error}</p>
            )}
            {loaded !== null && loaded.error === null && loaded.transcript === null && (
                <p className="muted">This Goldfish has no transcript yet.</p>
            )}
            {loaded?.transcript !== null && loaded?.transcript !== undefined && (
                <TranscriptView transcript={loaded.transcript} />
            )}
        </div>
    );
}
