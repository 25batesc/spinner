# s013 · Costs: what a session spent, what the month spent

## Goal
pi writes the cost and the tokens of every turn into each agent's transcript, and nobody adds them up. After this session every session card says what it has cost, every agent chip says its share, and a Usage page under Settings shows today, this week and this month, by day, by session and by model, in the shape of the usage pages of Claude and Devin. Two agents: `engine` (daemon, protocol) and `ui`.

## Done when
- [ ] The daemon keeps a cost ledger folded from every agent transcript under `<home>/sessions/*/agents/*/pi/*.jsonl`, the archive, and `<home>/operator/pi/*.jsonl`: per assistant message `ts`, `session`, `agent`, `model`, `usd`, `tokens_in`, `tokens_out`, `cache_read`, `cache_write`; cached per file by size and mtime; refolded on `agent.settled` and on a timer of 60 s
- [ ] `SessionView.cost = { usd, tokens_in, tokens_out, agents: { [name]: { usd, model } } }`; `OperatorView.cost` the same shape without agents
- [ ] `GET /costs?from=<date>&to=<date>&group=day|week|month` answers `{ total, by_period: [{ period, usd, tokens }], by_session: [{ dir, title, usd }], by_model: [{ model, usd, tokens }], by_agent: [...] }`; bounded at 366 days; dates in the daemon's local zone
- [ ] Session cards show `$1.23` beside the usage line; the context bar the same; an agent chip's tooltip carries its `$` and model
- [ ] Settings gains a Usage section: three figures (today, this week, this month), a bar chart by day for the last 30 days with a `day · week · month` switch and a hover value, a table by session (title, cost, tokens, last active) sorted by cost, a table by model; the figures follow the `costs` bus event
- [ ] `pnpm -r build && pnpm -r test && pnpm lint` and `doc-metrics --fail` green; `docs/DAEMON_API.md` lists the route; Log tells the story

## Plan
- [ ] 1. Contract under Contracts: the ledger row, `SessionView.cost`, the `/costs` response, the `costs` event (engine)
- [ ] 2. The ledger: the transcript fold, the cache, the refold triggers (engine)
- [ ] 3. The route and the views (engine)
- [ ] 4. Cards, context bar, chip tooltips (ui)
- [ ] 5. The Usage section under Settings (ui)
- [ ] 6. Lessons → protocol; release (the operator)

## Roster
| Agent  | Owns | Doing | Blocked? | Updated |
|--------|------|-------|----------|---------|
| engine | `packages/daemon/**`, `packages/protocol/**`, `docs/DAEMON_API.md` | — | no | — |
| ui     | `packages/ui/**` | — | no | — |

## Contracts & decisions
- (date) the operator: the transcript is the ledger's source; the daemon writes no cost file of its own, so a deleted session leaves the archive's transcripts as the record.
- (date) the operator: costs are pi's numbers (`usage.cost.total` per message); Spinner does not price tokens itself.
- (date) the operator: a design agent works on `packages/ui` in a separate worktree; the ui agent keeps its changes small and in the components the mission names, so the merge stays easy.
- (date) the operator: rules from s001 to s014 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path; no `git add -A`, no `git stash`; `mktemp -d` scratch, reported, never deleted; never print `.npmrc`, `.env*`, `auth.json`, `~/.spinner/env`, or a file named with `token`, `key` or `secret`; no customer or person in a tracked file; wait on an artifact, never on a Log timestamp; destructive e2e only on a scratch daemon with a scratch home; the operator's daemon on `:7777` is read-only for agents; a protocol change names the files the other agent's build touches; find the fault before you fix the proposed one.

## Open questions
- (none yet)

## Log
- (start) the operator: session opened beside s014; two pi subagents from one parent, briefs in agents/*/BRIEF.md
