# s022 · EGM build session 6: approval, the build handoff, the PR body, the design-only guard

## Goal
The spec is the approved design `docs/designs/egm-adoption.md`, version 3, "Build session 6: `egm-approve`" (entries 6.1 to 6.23) and the Verification Plan rows for session 6, plus the resolve-stage check moved here from session 3. This file holds run state only. Read "Build findings" (sessions 1 to 5) at the end of the doc first. Three agents: `engine` (approval, design, routes, the guard, the manager), `engine-pipeline` (the PR body, pr and post, the review brief, the outcome counters, cli) and `ui`. After this session the loop closes: an idea becomes a design, the design is approved with one click, the build runs on it, the PR carries it.

## Done when
- [ ] Every entry 6.1 to 6.23 is built as written; the session-6 checkpoint in the Verification Plan passes
- [ ] On a scratch daemon with the real pi: a design-track session is approved with `approve and build`, the lead starts building the doc's plan, an edit to the doc clears the approval and locks the lead's code writes until re-approval with the diff shown, `create PR` writes the body from the doc, the resolve stage clears when the lead marks the report resolved
- [ ] `pnpm -r build && pnpm -r test && pnpm lint` and `python3 tools/doc-metrics.py --fail` green

## Plan
- [ ] 1. Entries 6.1, 6.19, 6.23 (protocol and schemas), committed first (engine)
- [ ] 2. Entries 6.2 to 6.7, 6.13 to 6.14 (approve, manager, design, routes, the guard) (engine)
- [ ] 3. Entries 6.8 to 6.12, 6.20 to 6.22 (PR body, pr, post, review brief, outcome counters and their routes) and 6.21 (cli outcomes) (engine-pipeline)
- [ ] 4. Entry 6.15 (docs) and the session-6 e2e rows in `packages/daemon/e2e/egm-harness.ts`, one real-pi run at the end (engine)
- [ ] 5. Entries 6.16 to 6.18 (ui: approve dialog, design actions, the doc view, fixture, driver) (ui)
- [ ] 6. Lessons → protocol; release (the operator)

## Roster
| Agent | Owns | Doing | Blocked? | Updated |
|-------|------|-------|----------|---------|
| engine | `packages/protocol/**`, `packages/daemon/src/egm/**`, `packages/daemon/src/agents/**`, `packages/pi-extension/**`, `packages/daemon/e2e/**`, `docs/**`, `packages/daemon/src/server.ts` | — | no | — |
| engine-pipeline | `packages/daemon/src/pipeline/**`, `packages/daemon/src/store/review-brief.ts`, `packages/daemon/src/egm/pr-body*.ts`, `packages/cli/**` | — | no | — |
| ui | `packages/ui/**` | — | no | — |

## Contracts & decisions
- (date) the operator: the design doc is the contract. An entry that cannot be built as written is a finding: record it under Open questions with the entry id, build the smallest faithful variant, and say which in the Log. At the end, append the findings to "Build findings / Session 6" in the doc (engine).
- (date) the operator: two engine agents share `packages/daemon`. `server.ts` belongs to `engine`; `engine-pipeline` asks for its wiring lines in `inbox/` and `engine` adds them. `agents/swarm.ts` in 6.12 belongs to `engine-pipeline` for that entry only. Neither edits the other's files.
- (date) the operator: verification the faster way. Unit tests of the package or module you changed after each commit; the whole suite once before you report. One real-pi e2e at the end (engine), its stop rule in the Log first. Only the driver flows you touched after each commit; the full sweep once before you report.
- (date) the operator: no cost gate and no cost-driven choice anywhere. Cost is shown, not enforced.
- (date) the operator: rules from s001 to s036 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path; no `git add -A`, no `git stash`; `mktemp -d` scratch, reported, never deleted; never print `.npmrc`, `.env*`, `auth.json`, `~/.spinner/env`, or a file named with `token`, `key` or `secret`; no customer or person in a tracked file; wait on an artifact, never on a Log timestamp; destructive e2e only on a scratch daemon with a scratch home, the project named by the absolute path of its `spinner.yaml`; the operator's daemon on `:7777` is read-only for agents; a protocol change names the files the other agents' builds touch; find the fault before you fix the proposed one; drivers close their CDP target; re-read `MISSION.md` before each edit; stop every scratch daemon, fixture and headless Chrome you started before you report; read the exact lines before an edit.

## Open questions
- (none yet)

## Log
- (start) the operator: session opened after v0.13.1 from the approved design; three pi subagents from one parent, briefs in agents/*/BRIEF.md
