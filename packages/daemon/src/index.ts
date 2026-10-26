// Library entry point of @spinner/daemon. The CLI imports the session store from here; the
// `spinnerd` binary in `main.ts` wires the store to the HTTP server and the watcher.
export { resolve_home, is_inside_git_repo, type SpinnerHome } from "./home.js";
export {
    SESSION_FILES,
    SESSION_SUBDIRS,
    create_session,
    list_sessions,
    next_session_id,
    read_session,
    slugify,
    type CreateSessionInput,
    type ListResult,
    type ReadResult,
} from "./store/session-store.js";
