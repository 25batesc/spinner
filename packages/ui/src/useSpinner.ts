// React binding for the daemon connection. Returns the reduced state and nothing else.
import { useEffect, useReducer } from "react";

import { connectEvents, fetchSessions } from "./events-client.ts";
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
        fetchSessions(abort.signal)
            .then((body) => dispatch({ kind: "snapshot", sessions: body.sessions }))
            .catch((error: unknown) => {
                if (!abort.signal.aborted) {
                    console.error("Could not load sessions.", error);
                }
            });
        return () => {
            abort.abort();
            stop();
        };
    }, []);

    return state;
}
