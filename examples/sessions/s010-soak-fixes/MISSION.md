# s010 · Soak fixes before dogfooding

## Goal
The operator starts daily work in Spinner. This session closes the small faults that bit him in the first days, so none of them interrupts a real session. Two agents: `engine` (daemon, cli, protocol, desktop) and `ui`.

## Done when
- [ ] The daemon serves a snapshot of `packages/ui/dist` copied to `~/.spinner/ui/<commit>/` at start; a rebuild of `dist` does not change a running daemon's UI; `GET /health` names the UI commit it serves
- [ ] `settings.default_model` and `settings.agents.harness` apply: an agent added without a model gets `default_model`, and the harness comes from settings before `config.yaml`
- [ ] `DELETE /sessions/:dir/verify` clears the verify tick; the checkbox toggles both ways
- [ ] The ui fixture and vite default to a port that is not the daemon's (`17777`), so a driver can never reach the operator's daemon by omission
- [ ] A window under 1000 px keeps the terminal usable: the agents pane's minimum wins over the previews, and the side panel folds first
- [ ] Preview cookies are partitioned per session in the desktop app (`persist:<session dir>`), so two sessions of one app hold two logins
- [ ] `plumbing.test.ts` passes ten runs in a row under load (fake the clock or widen the debounce window in the test)
- [ ] Session ids are unique across homes on one machine: `next_session_id` also reads the ids named in the proxy route files
- [ ] `pnpm -r build && pnpm -r test && pnpm lint` and `doc-metrics --fail` green; `docs/sessions/soak-questions.md` rows marked done with the commit; Log tells the story

## Plan
- [ ] 1. UI snapshot at daemon start; `health.ui_commit` (engine)
- [ ] 2. Settings applied in the agent manager (engine)
- [ ] 3. `DELETE /verify` route; the checkbox toggle (engine, then ui)
- [ ] 4. Fixture and vite default port (ui)
- [ ] 5. Narrow window: fold order and minimums (ui)
- [ ] 6. Cookie partition per session (engine, in `packages/desktop`)
- [ ] 7. The flaky test; ids across homes (engine)
- [ ] 8. Soak list rows closed; lessons → protocol (the operator)

## Roster
| Agent  | Owns | Doing | Blocked? | Updated |
|--------|------|-------|----------|---------|
| engine | `packages/daemon/**`, `packages/cli/**`, `packages/protocol/**`, `packages/desktop/**`, `docs/DAEMON_API.md` | — | no | — |
| ui     | `packages/ui/**` | — | no | — |

## Contracts & decisions
- (date) the operator: each item is one commit with its own test; no item waits on another except 3 (route before checkbox).
- (date) the operator: the UI snapshot lives under `~/.spinner/ui/<commit>/`; the daemon removes snapshots of other commits at start.
- (date) the operator: rules from s001 to s011 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path; no `git add -A`, no `git stash`; `mktemp -d` scratch, reported, never deleted; never print `.npmrc`, `.env*`, `auth.json`, `~/.spinner/env`, or a file named with `token`, `key` or `secret`; no customer or person in a tracked file; wait on an artifact, never on a Log timestamp; destructive e2e only on a scratch daemon with a scratch home; the operator's daemon on `:7777` is read-only for agents; a protocol change names the files the other agent's build touches.

## Open questions
- (none yet)

## Log
- (start) the operator: session opened after s011; two pi subagents from one parent, briefs in agents/*/BRIEF.md
