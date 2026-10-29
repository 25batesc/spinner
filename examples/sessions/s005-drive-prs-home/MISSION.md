# s005 · Agents that drive PRs home

## Goal
Finish M2. After this session, one feature of the operator's project goes `pr → fix → verify → post → approve → land` with the operator's only actions being the verify tick, the confirmation of the Slack post, and the approval. Three tracks that share only `packages/protocol`: `engine` builds the pipeline commands; `ext` builds the Spinner pi extension and the agent plumbing (inbox delivery, file-watcher steers, the fixer role); `ui` builds the mission panel, the threads view and the PR buttons. The daemon and the UI from s003 are the base; the CLI calls the same `actions` module as the routes.

## Done when
- [ ] `spinner pr <session>` pushes every repo with commits ahead of its base and opens one PR per repo as the operator, body from the mission doc; stage moves to *bot-review*
- [ ] `threads/<repo>-<pr>.md` renders from GitHub; `spinner fix` starts or steers the fixer agent, which replies to, fixes or flags every open thread through the `thread_*` tools and never skips one
- [ ] `spinner post` composes the Slack message, shows it, posts as the operator on confirmation, stores the post URL; the board shows reviewer activity from the post's replies
- [ ] `spinner approve` shows head, diff stat and open-thread count, then submits the operator's approving review; after any push the approval is asked again, never re-applied
- [ ] `spinner land` enqueues each PR with `expectedHeadOid`, watches, rebases and re-enqueues on a pop-out, notifies on merge; `spinner reset` starts the next round
- [ ] Agents in a session run under the Spinner pi extension: mission in the system prompt, `mission_*`, `message`, `stack`, `pr` and `thread_*` tools, an out-of-area edit guard, a reload command; `inbox/` files become steers; an edit to `MISSION.md` by one agent becomes a debounced steer to the others
- [ ] The UI shows the rendered mission with editable operator sections, the threads with resolve and flag state, and `create PR / fix / post / land` buttons with job logs
- [ ] One real feature on the operator's project runs the full loop; `pnpm -r build && pnpm -r test && pnpm lint` and `doc-metrics --fail` green; Log tells the story; protocol updated with lessons

## Plan
- [ ] 1. `packages/protocol`: `ThreadsView` (per PR: threads with id, state, author kind, path, line, body, flagged), `PostView`, the `pr/fix/post/approve/land/reset` routes as jobs, events `threads.updated`, `pipeline.updated`, `message.delivered`; `ExtensionManifest` (the tools and their argument types) shared by `ext` and the daemon; schemas regenerated (engine, then ext and ui review)
- [ ] 2. `packages/daemon/src/pipeline/`: `pr.ts` (push, `gh pr create` per changed repo, body from Goal + Done when + Log, PR numbers into `session.yaml`), `threads.ts` (render `threads/` from the collector; reply, resolve, flag through `gh api`), `post.ts` (compose; post only on confirm; token from `SLACK_USER_TOKEN`; replies and reactions polled into the facts; a fixture when the token is absent), `approve.ts`, `land.ts` (enqueue with `expectedHeadOid`, watch, pop-out → rebase job on the session's worktree → re-enqueue), `reset.ts`; all as `actions` the CLI and the routes share (engine)
- [ ] 3. `packages/pi-extension/`: the Spinner pi extension loaded into every agent the daemon starts: system-prompt section (session, hosts, brief, mission, digest per other agent), the `mission_*`, `message`, `stack`, `pr`, `thread_*` tools backed by the daemon's routes, a `beforeTool` out-of-area guard, a `/spinner-reload` command that calls `ctx.reload()`; mission writes serialized through the daemon (ext)
- [ ] 4. `packages/daemon/src/agents/`: inbox delivery (a new `inbox/` file → steer to a running agent, or prepended to the next prompt), the watcher on `MISSION.md` and `agents/*/NOTES.md` → one debounced steer per agent per 30 s, the fixer role (`spinner fix` adds or steers an agent with the fixer brief over `threads/`, `threads.autofix` honoured), `NOTES.md` per agent (ext)
- [ ] 5. Review item 1 for the panes; Contracts (ui)
- [ ] 6. `packages/ui`: mission panel (rendered `MISSION.md`; Goal and Done when editable through `PUT /sessions/:dir/mission/section`; Roster highlighted; a flash on change), threads view per PR with resolve and flag state, `create PR / fix / post / land / reset` buttons with the job drawer, the Slack post preview with a confirm step, the approval dialog (head, diff stat, open threads) (ui)
- [ ] 7. Context tab per agent: the `AGENTS.md` chain from user level to the working directory, each file editable through the daemon, git-tracked ones marked; loaded skills from pi's `get_commands` (ui, with a route from ext)
- [ ] 8. End to end on `examples/sample-stack` with a throwaway repo the operator names: new → agent edits → `pr` → bot-less *bot-review* → `fix` on a thread the operator writes → `verify` → `post` (fixture or real) → `approve` → `land` → `reset` (all three)
- [ ] 9. One real feature on the operator's project through the UI (operator with all three)
- [ ] 10. Lessons → docs/SESSION_PROTOCOL.md; protocol v2 if the extension changed the editing rules (Cullen)

## Roster
| Agent  | Owns | Doing | Blocked? | Updated |
|--------|------|-------|----------|---------|
| engine | `packages/protocol` (all), `packages/daemon/src/pipeline/**`, `packages/daemon/src/actions.ts`, `packages/cli/src/commands/{pr,fix,post,approve,land,reset}.ts`, root configs | — | no | — |
| ext    | `packages/pi-extension/**`, `packages/daemon/src/agents/**`, `packages/daemon/src/watch/**`, `packages/daemon/src/store/mission-*.ts`, `examples/sessions/*/agents/fixer/` | — | no | — |
| ui     | `packages/ui/**` | — | no | — |

## Contracts & decisions
- (date) Cullen: Spinner acts as the operator. PRs open as the operator's `gh` login; the Slack post is sent with the operator's user token (`SLACK_USER_TOKEN` in the environment; never in a file); the approval is the operator's review. The daemon never posts, approves or lands on its own; each is a job the operator starts, and `post` and `approve` show what they will send before they send it.
- (date) Cullen: after any push to a PR, the operator's approval is asked again (`needs_human: approve <repo>#<n>`), never re-applied by Spinner. Peer approvals count as GitHub counts them; a stale one is shown as stale.
- (date) Cullen: a thread is never skipped. The fixer replies to every open thread; it resolves only after its fix is pushed and checks are green; it flags design questions, disagreements and out-of-session changes. With `threads.resolve_human: false` it replies to human threads and leaves them open.
- (date) Cullen: the fixer never force-pushes and never rebases a branch with unpushed agent work; `land` rebases through a job that stops on conflict with `needs_human`.
- (date) Cullen: mission writes go through the daemon (`PUT /sessions/:dir/mission/section`, one writer at a time). The extension's `mission_*` tools call it; the UI calls it; a hand edit still works for an agent without the extension.
- (date) Cullen: `cli.ts` and `daemon/src/index.ts` are shared-append registries, one line per owner; `src/agents/**` belongs to ext in this session; engine calls `agents` through its exported functions.
- (date) Cullen: the Slack API runs against a fixture (`packages/daemon/test/fixtures/slack/`) when `SLACK_USER_TOKEN` is unset; the real post is tested by the operator once the token exists. Posting without the operator's confirm is a bug.
- (date) Cullen: one port, no polling in the UI, actions are jobs, the fixture server stays for UI tests, headless Chrome over the DevTools protocol for UI checks (s003 Contracts).
- (date) Cullen: rules from s001 to s003 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path; the lockfile with its `package.json`; `inbox/` for agent-to-agent requests; `mktemp -d` scratch, reported, never deleted; one retry on a repo-side failure; never print `.npmrc`, `.env*`, `auth.json` or a file named with `token`, `key` or `secret`; no customer, employer, private repo or person in a tracked file.
- (date) Cullen: a driver prompts an idle agent and steers a busy one; a steer to an agent with no run in flight never enters. The daemon finds `pi` through `SPINNER_PI`.
- (date) Cullen: never `git stash` in the shared checkout; it catches the other agents' files.
- (date) Cullen: binaries: `pi` 1.4.0 (`SPINNER_PI_BIN` or PATH; it lives under the Node version that installed it), `gh` logged in as the operator, Docker running. A throwaway GitHub repo for item 8 is named by the operator under Open questions.

## Open questions
- engine: which throwaway repo and base branch for item 8? The operator names one he owns; Spinner must not open PRs on the team's repos during this session.

## Log
- (start) Cullen: session opened after s003; three pi subagents from one parent session, briefs in agents/*/BRIEF.md
