// React binding for the daemon connection. Returns the reduced state and nothing else.
// One snapshot per load (`/sessions`, `/jobs`), then events only.
import { useEffect, useReducer } from "react";

import {
    connectEvents,
    fetchJobs,
    fetchSessions,
    fetchSettings,
    fetchUsage,
} from "./events-client.ts";
import { fetchOperator } from "./operator.ts";
import { initialState, reduce, type UiState } from "./state.ts";

export function useSpinner(): UiState {
    const [state, dispatch] = useReducer(reduce, initialState);

    useEffect(() => {
        const abort = new AbortController();
        const stop = connectEvents({
            onEvent: (event) => dispatch({ kind: "event", event }),
            onOpen: () => dispatch({ kind: "connection", status: "open" }),
            onClose: () => dispatch({ kind: "connection", status: "closed" }),
        });
        const report = (what: string) => (error: unknown) => {
            if (!abort.signal.aborted) {
                console.error(`Could not load ${what}.`, error);
            }
        };
        fetchSessions(abort.signal)
            .then((body) => dispatch({ kind: "snapshot", sessions: body.sessions }))
            .catch(report("sessions"));
        // Older daemons have no `GET /jobs`; the UI then learns of jobs from events only.
        fetchJobs(abort.signal)
            .then((jobs) => dispatch({ kind: "jobs", jobs }))
            .catch(report("jobs"));
        fetchUsage(abort.signal)
            .then((usage) => {
                if (usage !== null) {
                    dispatch({ kind: "usage", usage });
                }
            })
            .catch(report("usage"));
        fetchSettings(abort.signal)
            .then((settings) => {
                if (settings !== null) {
                    dispatch({ kind: "settings", settings });
                }
            })
            .catch(report("settings"));
        fetchOperator(abort.signal)
            .then((operator) => {
                if (operator !== null) {
                    dispatch({ kind: "operator", operator });
                }
            })
            .catch(report("operator"));
        return () => {
            abort.abort();
            stop();
        };
    }, []);

    return state;
}
