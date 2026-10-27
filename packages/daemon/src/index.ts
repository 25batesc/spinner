// Library entry point of @spinner/daemon. The CLI imports the session store from here; the
// `spinnerd` binary in `main.ts` wires the store to the HTTP server and the watcher.
export { resolve_home, is_inside_git_repo, type SpinnerHome } from "./home.js";
export {
    SESSION_FILES,
    SESSION_SUBDIRS,
    create_session,
    find_session,
    list_sessions,
    next_session_id,
    read_session,
    slugify,
    write_session,
    type CreateSessionInput,
    type ListResult,
    type ReadResult,
} from "./store/session-store.js";
export {
    find_spec,
    load_spec,
    check_spec_shape,
    expand_home,
    type LoadedSpec,
} from "./stack/spec.js";
export { render_compose, compose_project, hostname, type Rendered } from "./stack/compose.js";
export * from "./stack/runner.js";
export { add_worktree, remove_worktree, list_worktrees } from "./git/worktree.js";
export * from "./pipeline/index.js";
