# s012 · The diff tab: see what a session changed

## Goal
A session is a branch across repos, and the operator cannot see its diff without a terminal or GitHub. This session adds a `diff` tab per repo in the previews pane, backed by `diffview` (a local viewer for stacked branches: each branch's diff against its parent, the stack from trunk to the top, live reload, and comments on lines that an agent reads and answers). Comments the operator leaves reach the session's agent as notices, and the agent answers them with the viewer's CLI. Two agents: `engine` (daemon, extension, protocol) and `ui`.

## Done when
- [ ] `diffview` is a pinned git dependency of the daemon (`github:adamsanghera/diff-viewer#<commit>`), optional: when it is absent the tab does not appear and `spinner doctor` says so; its renderer bundle is built once, on first use, under `~/.spinner/diffview/`
- [ ] The daemon runs one `diffview --no-open --port <n>` per repo of a session in that repo's worktree, as a Spinner-managed host process that does not need the stack: started by `POST /sessions/:dir/diff/start` (and on `up`), stopped by `POST /sessions/:dir/diff/stop` (and on `down`, `close`), reattached after a daemon restart by pid identity; `ServiceView`-like entries under `SessionView.diff.repos[name] = { state, url, pid }`
- [ ] The previews pane shows a `diff · <repo>` tab per running viewer; the tab is a top-level preview in the desktop app and a frame in the browser; `j`/`k`, `[`/`]` and the viewer's own keys work inside it
- [ ] A comment left in the viewer reaches the session: the daemon runs `diffview comments wait` per repo, turns a new comment waiting on the agent into one `notify` to the session's running tty agents (s011 channel) with the thread id, the file and line, and the text, and sets `needs_human` when a thread waits on the operator; the extension's role `worker` gets the tools `diff_comments` (list, show) and `diff_reply` (reply, suggest-resolve), which run the CLI in the agent's worktree
- [ ] E2e on a scratch daemon with the sample project: start the viewer, open the tab, leave a comment through the viewer's HTTP API, see the notice reach a fake tty agent, reply through the tool, see the thread turn
- [ ] `pnpm -r build && pnpm -r test && pnpm lint` and `doc-metrics --fail` green; `docs/ARCHITECTURE.md` gains "The diff tab"; `docs/DAEMON_API.md` lists the routes; `docs/STACK_SPEC.md` says the diff viewer needs no stack entry; Log tells the story

## Plan
- [ ] 1. Contract under Contracts: the routes, `SessionView.diff`, the notice text, the tool names and arguments (engine)
- [ ] 2. The dependency, the first-use bundle, the per-repo process with pid identity, start/stop with the session (engine)
- [ ] 3. The comments watcher and the notices; `needs_human` on a thread waiting on the operator (engine)
- [ ] 4. The tools `diff_comments` and `diff_reply` in the extension (engine)
- [ ] 5. The `diff · <repo>` tabs in the previews pane, with the viewer's keys passing through; a `start diff` action when no viewer runs (ui)
- [ ] 6. E2e; docs (engine)
- [ ] 7. Lessons → protocol; `v0.4.0` (the operator)

## Roster
| Agent  | Owns | Doing | Blocked? | Updated |
|--------|------|-------|----------|---------|
| engine | `packages/daemon/**`, `packages/pi-extension/**`, `packages/protocol/**`, `packages/cli/**`, `docs/ARCHITECTURE.md`, `docs/DAEMON_API.md`, `docs/STACK_SPEC.md` | — | no | — |
| ui     | `packages/ui/**` | — | no | — |

## Contracts & decisions
- (date) the operator: `diffview` is optional. The repository it comes from has no licence file today; Spinner's release does not depend on it, and the tab hides when it is absent.
- (date) the operator: the viewer runs in the session's worktree and shows only what is committed; the operator commits (or the agent does) to see a change.
- (date) the operator: comments are the local review loop before a PR; a thread waiting on the operator is `needs_human`, like a review thread.
- (date) the operator: the viewer is a host process of the session, not a `spinner.yaml` service; a project spec never names it.
- (date) the operator: rules from s001 to s013 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path; no `git add -A`, no `git stash`; `mktemp -d` scratch, reported, never deleted; never print `.npmrc`, `.env*`, `auth.json`, `~/.spinner/env`, or a file named with `token`, `key` or `secret`; no customer or person in a tracked file; wait on an artifact, never on a Log timestamp; destructive e2e only on a scratch daemon with a scratch home; the operator's daemon on `:7777` is read-only for agents; a protocol change names the files the other agent's build touches; find the fault before you fix the proposed one.

## Open questions
- (none yet)

## Log
- (start) the operator: session opened after s013; two pi subagents from one parent, briefs in agents/*/BRIEF.md
