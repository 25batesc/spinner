// Library entry point of @spinner/daemon. The CLI imports the session store from here; the
// `spinnerd` binary in `main.ts` wires the store to the HTTP server and the watcher.
export { resolve_home, is_inside_git_repo, type SpinnerHome } from "./home.js";
export * from "./config.js";
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
export { run, run_attached } from "./stack/shell.js";
export { group_alive, read_pid_files } from "./stack/host-service.js";
export { add_worktree, remove_worktree, list_worktrees } from "./git/worktree.js";
export * from "./pipeline/index.js";
export * as actions from "./actions.js";
export type { ActionContext } from "./actions.js";
export { list_projects } from "./projects.js";
export { build_session_view, build_stack, service_url } from "./views/session-view.js";
export { PiRpcHarness, type AgentHandle, type AgentHarness } from "./agents/harness.js";
export { AgentManager } from "./agents/manager.js";
export { resolve_pi_binary, spawn_pi } from "./agents/pi-rpc.js";
