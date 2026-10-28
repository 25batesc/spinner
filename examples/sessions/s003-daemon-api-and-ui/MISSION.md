# s003 · Daemon API + web UI, then the pi adapter

## Goal
Make the daemon the one place that knows every session's board facts and stack state, and give the operator a window per feature on top of it: sessions and board on the left, agent tabs in the middle, previews on the right. Everything the CLI can do today (`new`, `adopt`, `up`, `down`, `close`, `verify`) becomes a daemon action with progress over the event stream, and the UI drives it. Then the daemon learns to host pi agents (`PiRpcHarness`), and the agent tabs come alive. Two agents: `engine` (protocol, daemon, pi adapter) and `ui` (the web app). The CLI keeps working; it calls the same daemon code in-process.

## Done when
- [ ] `pnpm daemon` serves the built UI at `http://localhost:7777`, `GET /sessions` returns board facts and stack state per session, and every CLI action has a `POST` route that runs as a job with progress events
- [ ] The daemon runs the GitHub poller itself and emits `session.updated` on every stage or queue transition; the macOS notification moves into the daemon
- [ ] In the UI, on `examples/sample-stack`: new session → `up` → previews answer in the panes → `verify` tick → `close`, with no terminal open
- [ ] In the UI, on the operator's own stack: two sessions up side by side, previews logged in, the board line of an adopted PR updates within one poll of a GitHub change
- [ ] `PiRpcHarness` spawns, resumes, prompts, steers and aborts one pi agent per agent tab, and the tab renders text and tool calls from a typed `agent.event`
- [ ] `pnpm -r build && pnpm -r test && pnpm lint` green; `tools/doc-metrics.py --fail` green; Log tells the story; protocol doc updated with lessons

## Plan
- [ ] 1. `packages/protocol`: API v1 in `src/api.ts`: `GET /projects`; `GET /sessions` and `GET /sessions/:dir` return `SessionView = { summary, board?: StageResult + per-PR facts, stack: StackView (services with where/status/url, database, processes) }`; `POST /sessions` (new, with `project`), `POST /sessions/adopt`, `POST /sessions/:dir/{up,down,close,verify}` return `202 { job }`; `GET /jobs/:id`; events `job.started | job.log | job.finished`, `session.updated` carrying the full `SessionView`; `agent.event` typed from pi's RPC event union (Plan 9 of s001). Schemas regenerated (engine)
- [ ] 2. Review item 1 for what the panes need; post changes under Contracts (ui)
- [ ] 3. `packages/daemon`: a `jobs/` module (one job per action, log lines to the event bus, bounded concurrency), the stack runner and the pipeline tracker behind the new routes, the poller as a daemon loop with the notifier, and `SessionView` assembled from the store, the tracker and the stack state (engine)
- [ ] 4. `packages/daemon`: serve `packages/ui/dist` at `/` with a `SPINNER_UI_DIR` override; Vite dev proxy for everything under `/sessions`, `/projects`, `/jobs`, `/events` (engine; ui aligns the fixture)
- [ ] 5. `packages/ui`: sessions and board pane from `SessionView`: sorted by `needs_human` first, stage badge, per-PR line, stack state dot; the new-session form with a project select; the adopt form (ui)
- [ ] 6. `packages/ui`: session view: the service table (where, status, url), the action buttons (`up`, `down`, `close`, `verify`, `create PR` disabled until M2), a job log drawer fed by `job.log`, and the preview pane: one tab per host, grey until healthy, open-in-tab, reload, the **verified** tick (ui)
- [ ] 7. End to end on `examples/sample-stack` from the UI, then two sessions of the operator's stack (both; the operator logs in)
- [ ] 8. `packages/daemon/src/agents/`: `PiRpcHarness` (spawn `pi --mode rpc` with the agent's `--session-dir` under the session, resume by id, prompt, steer, abort, event passthrough as `agent.event`), `POST /sessions/:dir/agents` (add from a brief), `POST .../agents/:name/{prompt,steer,abort}`; the session `AGENTS.md` generated per the protocol (engine)
- [ ] 9. `packages/ui`: agent tabs: the `agent.event` stream rendered as text, tool calls and cost; prompt box, steer, abort; model picker from `GET /models` (ui, after 8)
- [ ] 10. One agent runs in a session from the UI and edits a file in a worktree (both)
- [ ] 11. Lessons → docs/SESSION_PROTOCOL.md; API v1 frozen with a Decisions entry (Cullen)

## Roster
| Agent  | Owns | Doing | Blocked? | Updated |
|--------|------|-------|----------|---------|
| engine | `packages/protocol` (all), `packages/daemon/**` except `src/stack/**` and `src/pipeline/**` internals (call them, do not rewrite them), `packages/cli` (one-line changes to call the daemon modules), root configs | — | no | — |
| ui     | `packages/ui/**` | — | no | — |

## Contracts & decisions
- (date) Cullen: one port. The daemon serves the UI and the API on `localhost:7777`; `pnpm --filter ui dev` proxies to it. The fixture server stays for UI tests only.
- (date) Cullen: no polling in the UI. The UI fetches `GET /sessions` once and then renders from `session.updated` and `job.*` events. If the UI needs a fact, the daemon puts it in `SessionView`.
- (date) Cullen: actions are jobs. A `POST` returns `202 { job: { id, action, session } }` at once; progress is `job.log` lines (the same lines the CLI prints) and `job.finished { ok, error? }`. The CLI keeps its synchronous output by subscribing to its own job.
- (date) Cullen: the daemon never posts anywhere and never starts an agent on its own. Notifications stay local (`osascript`).
- (date) Cullen: `packages/cli/src/cli.ts` and `packages/daemon/src/index.ts` are shared-append registries, one line per owner. `src/stack/**` and `src/pipeline/**` are called as they are; a needed change there is a Contracts line first, then a minimal edit by engine.
- (date) Cullen: the ui agent verifies with a browser. `playwright-cli` is not installed; headless Chrome over the DevTools protocol, as in s001, is fine. Screenshots go to `<session>/artifacts/`.
- (date) Cullen: rules from s001 and s002 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path, never `git add -A`; the lockfile with its `package.json`; a request for the other agent is an `inbox/` message; scratch directories from `mktemp -d`, reported, never deleted; one retry on a repo-side failure, then stop; never print `.npmrc`, `.env*`, `auth.json` or any file named with `token`, `key` or `secret`.
- (date) Cullen: `verify` is allowed on a session with no PR; `SessionView.can_verify` says when the tick is enabled. Project names resolve under `local/`, `~/.spinner/projects/` and `examples/`.
- (date) Cullen: every stream the UI renders has a history route; the tab loads it before it subscribes. A prompt to a stopped agent is a 409.
- (date) Cullen: pi does not reload context files in RPC mode; the daemon stops and re-adds the agent after a context edit. The pi binary lives under the Node version that installed it; the daemon finds it on PATH or through `SPINNER_PI_BIN`.
- (date) Cullen: a tracked file names no customer, employer, private repo, person or vendor project (WRITING.md rule 13). The operator's stack is "the operator's project"; its spec is under `local/`.

## Open questions
- engine: does pi reload context files (`AGENTS.md`, the brief) between turns in RPC mode, or must the daemon restart the process? Find out from pi's docs and `pi --mode rpc` itself before item 8; put the answer under Contracts.

## Log
- (start) Cullen: session opened after the M1 exit; two pi subagents from one parent session, briefs in agents/*/BRIEF.md
