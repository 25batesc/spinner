# s021 · EGM build sessions 4 and 5: Goldfish visibility, the design workspace

## Goal
The spec is the approved design `docs/designs/egm-adoption.md`, version 3: "Build session 4: `egm-goldfish`" (entries 4.1 to 4.18) and "Build session 5: `egm-workspace`" (entries 5.1 to 5.15), with the Verification Plan rows for both. This file holds run state only. Read "Build findings" (sessions 1 to 3) at the end of the doc first. Three agents: `engine` builds the engine entries of both sessions; `ui-goldfish` builds 4.14 to 4.18 in the main tree; `ui-workspace` builds 5.6 to 5.14 in its own worktree on the branch `egm/s5-workspace`, and the operator merges it.

## Done when
- [ ] Every entry of sessions 4 and 5 is built as written; the session-4 and session-5 checkpoints in the Verification Plan pass
- [ ] On a scratch daemon with the real pi, one review shows each Goldfish as a chip with live state, tokens and cost, and its transcript opens; the brief, the doc and the review reports read in the workspace; a gate answers from the workspace
- [ ] `pnpm -r build && pnpm -r test && pnpm lint` and `python3 tools/doc-metrics.py --fail` green on `main` after the merge

## Plan
- [ ] 1. Entries 4.1 to 4.3, 5.1 to 5.2 (protocol for both sessions) and 4.12, 5.15 (schemas), committed first (engine)
- [ ] 2. Entries 4.4 to 4.10 (daemon: goldfish, ledger, design, routes, server) (engine)
- [ ] 3. Entries 5.3 to 5.5 (daemon routes for the workspace, docs) and 4.13 (docs) (engine)
- [ ] 4. Entry 4.11: the harness e2e with the Goldfish and workspace rows, one run at the end (engine)
- [ ] 5. Entries 4.14 to 4.18 (ui: Goldfish chips, transcript, stepper cost, fixture, driver) (ui-goldfish)
- [ ] 6. Entries 5.6 to 5.14 (ui: the design workspace: brief, doc, review, files, history; fixture, driver) on the branch (ui-workspace)
- [ ] 7. Merge, checks, lessons, release (the operator)

## Roster
| Agent | Owns | Doing | Blocked? | Updated |
|-------|------|-------|----------|---------|
| engine | `packages/daemon/**`, `packages/protocol/**`, `packages/pi-extension/**`, `docs/**` | — | no | — |
| ui-goldfish | `packages/ui/**` in the main tree: `GoldfishChips.tsx`, `GoldfishTranscript.tsx`, `goldfish.ts`, the chips block of `AgentsPane.tsx`, `DesignStepper.tsx`, its lines in `remote.ts` and the fixture | — | no | — |
| ui-workspace | `packages/ui/**` on the branch `egm/s5-workspace`: `Design*.tsx` of session 5, `design-workspace.ts`, the view wiring of `AgentsPane.tsx` and `App.tsx`, its lines in `remote.ts` and the fixture | — | no | — |

## Contracts & decisions
- (date) the operator: the design doc is the contract. An entry that cannot be built as written is a finding: record it under Open questions with the entry id, build the smallest faithful variant, and say which in the Log. At the end, append the findings to "Build findings / Sessions 4 and 5" in the doc (engine).
- (date) the operator: verification, the faster way. Unit tests of the package you changed after each commit; the whole suite once before you report. One real-pi e2e per session, at the end, with its stop rule in the Log first. Only the driver flows you touched after each commit; the full sweep once before you report.
- (date) the operator: no cost gate and no cost-driven choice anywhere. Cost is shown, not enforced.
- (date) the operator: rules from s001 to s035 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path; no `git add -A`, no `git stash`; `mktemp -d` scratch, reported, never deleted; never print `.npmrc`, `.env*`, `auth.json`, `~/.spinner/env`, or a file named with `token`, `key` or `secret`; no customer or person in a tracked file; wait on an artifact, never on a Log timestamp; destructive e2e only on a scratch daemon with a scratch home, the project named by the absolute path of its `spinner.yaml`; the operator's daemon on `:7777` is read-only for agents; a protocol change names the files the other agents' builds touch; find the fault before you fix the proposed one; drivers close their CDP target; re-read `MISSION.md` before each edit; stop every scratch daemon, fixture and headless Chrome you started before you report; read the exact lines before an edit.

## Open questions
- (none yet)

## Log
- (start) the operator: session opened after v0.12.1 from the approved design; three pi subagents from one parent, briefs in agents/*/BRIEF.md
