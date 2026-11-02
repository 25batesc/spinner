# s015 · Reviews: a place for your peers' PRs

## Goal
Reviewing a peer's PR today means a terminal, `review-blast`, and GitHub in a browser. After this session Spinner has a Reviews panel: paste PR links, start the review swarm, and watch it: the PR's CI status and review decision, one chip per reviewer with its live state and cost, the threads as they arrive, the diff on the right. A review is a session of kind `review`: a read-only checkout at the PR head and one tty agent per model, started with the review skill's brief, so the chips, terminals, threads, costs and cards come from what exists. Two agents: `engine` (daemon, extension, protocol) and `ui`.

## Done when
- [ ] `POST /reviews` takes `{ text }` (PR references in any form, through the extractor; no project needed, any repository the operator's `gh` can read) and creates one session of `kind: review` per PR: a clone or fetch of the repository under `<home>/reviews/<owner>-<repo>/`, a detached worktree at the PR head under the session, the PR facts tracked by the poller like an adopted PR, no stack, no pipeline actions but `review`
- [ ] `POST /sessions/:dir/review` on a review session starts the swarm: one tty agent per model in `settings.review.models` (name `review-<model-slug>`), each with the review brief (`store/review-brief.ts`, from the operator's review skill: read the diff and the code it touches, post inline comments only, identify as the model, never approve or request changes, never push), started from the operator's skill directory when `settings.review.skill` names one; a reviewer that prints its `POSTED` line is `posted`; one that exits otherwise is `failed`; the swarm is bounded by the running-agents cap and the rest queue
- [ ] `SessionView` for a review carries `kind`, the PR's `checks` with the failing ones named, `review_decision`, `threads` count, and `swarm: [{ name, model, state: queued|reading|posted|failed, usd }]`; `review.updated` on the bus per change
- [ ] The Reviews panel: an icon in the activity bar; a paste box at the top; one card per review: title, author, `branch → base`, the CI pill (green, red with the failing checks in the tooltip, amber pending), the review decision pill, the thread count, `$`; `review` and `open on GitHub` on the card; cards ordered by last activity
- [ ] The middle pane for a review: the PR header with the same facts; the swarm as chips with state dots and cost, a reviewer's terminal on click; the threads view live (reply and resolve inline, as on a session); the diff tab on the right at the PR head; the context bar names the review
- [ ] `review` on an ordinary session (s016) runs the same swarm as agents of that session instead of `review-blast`, so the chips and costs show there too; `review-blast` is no longer called
- [ ] E2e on a scratch daemon with the real pi: paste the sandbox PR, the review session appears with CI and decision, start the swarm with one model, the reviewer posts (or prints `POSTED` with nothing to post) and its chip reads `posted`; the thread count follows
- [ ] `pnpm -r build && pnpm -r test && pnpm lint` and `doc-metrics --fail` green; `ARCHITECTURE.md` "Reviews", `DAEMON_API.md`; Log tells the story

## Plan
- [ ] 1. Contract under Contracts: `kind: review` in `session.yaml`, the routes, `SessionView.swarm`, the event, `settings.review` additions (engine)
- [ ] 2. The review session: clone or fetch, the detached worktree, the poller on it (engine)
- [ ] 3. The swarm: the brief, the agents per model, the `POSTED` detection, the cap and the queue; the s016 `review` route moved onto it (engine)
- [ ] 4. The Reviews panel and the review middle pane (ui)
- [ ] 5. E2e; docs (engine)
- [ ] 6. Lessons → protocol; release (the operator)

## Roster
| Agent  | Owns | Doing | Blocked? | Updated |
|--------|------|-------|----------|---------|
| engine | `packages/daemon/**`, `packages/pi-extension/**`, `packages/protocol/**`, `packages/cli/**`, `docs/**` | — | no | — |
| ui     | `packages/ui/**` | — | no | — |

## Contracts & decisions
- (date) the operator: a review is a session of kind `review`; it reuses the agent, thread, cost and card machinery; it has no stack and no pipeline beyond `review`.
- (date) the operator: reviewers post COMMENT reviews with inline comments only; they never approve, never request changes, never push; they identify themselves with their model.
- (date) the operator: the swarm is bounded by the running-agents cap; queued reviewers show as `queued`.
- (date) the operator: rules from s001 to s016 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path; no `git add -A`, no `git stash`; `mktemp -d` scratch, reported, never deleted; never print `.npmrc`, `.env*`, `auth.json`, `~/.spinner/env`, or a file named with `token`, `key` or `secret`; no customer or person in a tracked file; wait on an artifact, never on a Log timestamp; destructive e2e only on a scratch daemon with a scratch home; the operator's daemon on `:7777` is read-only for agents; a protocol change names the files the other agent's build touches; find the fault before you fix the proposed one; drivers close their CDP target; re-read `MISSION.md` before each edit, several agents write it.

## Open questions
- (none yet)

## Log
- (start) the operator: session opened after v0.6.0; two pi subagents from one parent, briefs in agents/*/BRIEF.md
