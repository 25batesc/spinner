# s019 · EGM build session 3: the skills and the gates in the app

## Goal
The spec is the approved design `docs/designs/egm-adoption.md`, version 3, "Build session 3: `egm-skills-in-app`" (entries 3.1 to 3.24) and the Verification Plan rows for session 3. This file holds run state only. The design doc holds the goal, the plan and the tests; do not restate them here. Read "Build findings" (sessions 1 and 2) at the end of the doc first.

## Done when
- [ ] Every entry 3.1 to 3.24 is built as written, and the session-3 checkpoint in the Verification Plan passes
- [ ] On a scratch daemon with the real pi, a design-track session runs brainstorm, draft and review from the buttons; the lead follows the design-track brief and does not build before approval; the gate cards answer the lead's questions; the session-1 probe P11 now reaches draft and review
- [ ] `pnpm -r build && pnpm -r test && pnpm lint` and `python3 tools/doc-metrics.py --fail` green

## Plan
- [ ] 1. Entries 3.1 to 3.3 (protocol) and 3.16 (schemas), committed first so the ui agent can build (engine)
- [ ] 2. Entries 3.4 to 3.6 (extension), 3.7 to 3.12 (daemon: gate, review runs, routes, design), 3.13 to 3.14 (the design-track lead brief) (engine)
- [ ] 3. Entries 3.15 (the harness e2e, P11 through draft and review) and 3.17 (docs) (engine)
- [ ] 4. Entries 3.18 to 3.24 (ui: design actions, the EGM menu, the gate cards, fixture, driver) (ui)
- [ ] 5. Lessons → protocol; release (the operator)

## Roster
| Agent  | Owns | Doing | Blocked? | Updated |
|--------|------|-------|----------|---------|
| engine | `packages/daemon/**`, `packages/pi-extension/**`, `packages/protocol/**`, `packages/cli/**`, `docs/**`, `README.md` | — | no | — |
| ui     | `packages/ui/**` | — | no | — |

## Contracts & decisions
- (date) the operator: the design doc is the contract. An entry that cannot be built as written is a finding: record it under Open questions with the entry id, build the smallest faithful variant, and say which in the Log. Do not redesign. At the end, append the findings to "Build findings / Session 3" in the doc (engine).
- (date) the operator: no cost gate and no cost-driven choice anywhere. Cost is shown, not enforced.
- (date) the operator: rules from s001 to s032 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path; no `git add -A`, no `git stash`; `mktemp -d` scratch, reported, never deleted; never print `.npmrc`, `.env*`, `auth.json`, `~/.spinner/env`, or a file named with `token`, `key` or `secret`; no customer or person in a tracked file; wait on an artifact, never on a Log timestamp; destructive e2e only on a scratch daemon with a scratch home; the operator's daemon on `:7777` is read-only for agents; a protocol change names the files the other agent's build touches; find the fault before you fix the proposed one; drivers close their CDP target; re-read `MISSION.md` before each edit; stop every scratch daemon, fixture and headless Chrome you started before you report; read the exact lines before an edit, never guess old text from a report; a probe that spends model money names its stop rule before it runs.

## Open questions
- (none yet)

## Log
- (start) the operator: session opened after v0.10.0 from the approved design; two pi subagents from one parent, briefs in agents/*/BRIEF.md
