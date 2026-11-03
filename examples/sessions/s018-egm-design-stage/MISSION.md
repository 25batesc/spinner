# s018 · EGM build session 2: design facts, the `design` block, the stepper

## Goal
The spec is the approved design `docs/designs/egm-adoption.md`, version 3, "Build session 2: `egm-design-stage`" (entries 2.1 to 2.47) and the Verification Plan rows for session 2. This file holds run state only. The design doc holds the goal, the plan and the tests; do not restate them here. Read "Build findings / Session 1" at the end of the doc first: it lists what session 1 learned.

## Done when
- [ ] Every entry 2.1 to 2.47 is built as written, and the session-2 checkpoint in the Verification Plan passes
- [ ] A design-track session on a scratch daemon shows its EGM step in the context bar and on its card, derived from files, and the lead names its doc through `design_doc`
- [ ] A session at round 2 shows the round badge with its earlier PRs
- [ ] `pnpm -r build && pnpm -r test && pnpm lint` and `python3 tools/doc-metrics.py --fail` green

## Plan
- [ ] 1. Entries 2.1 to 2.6, 2.39, 2.40 (protocol) and 2.27 (schemas), committed first so the ui agent can build (engine)
- [ ] 2. Entries 2.7 to 2.8 (extension) and 2.9 to 2.26 (daemon) (engine)
- [ ] 3. Entries 2.41 to 2.45 (rounds) and 2.28 to 2.29 (cli, docs) (engine)
- [ ] 4. Entries 2.30 to 2.38 (ui: design facts, the stepper, context bar and card, fixture, driver) (ui)
- [ ] 5. Entries 2.46 to 2.47 (ui: rounds badge) (ui)
- [ ] 6. Lessons → protocol; release (the operator)

## Roster
| Agent  | Owns | Doing | Blocked? | Updated |
|--------|------|-------|----------|---------|
| engine | `packages/daemon/**`, `packages/pi-extension/**`, `packages/protocol/**`, `packages/cli/**`, `docs/**`, `README.md` | — | no | — |
| ui     | `packages/ui/**` | — | no | — |

## Contracts & decisions
- (date) the operator: the design doc is the contract. An entry that cannot be built as written is a finding: record it under Open questions with the entry id, build the smallest faithful variant, and say which in the Log. Do not redesign. At the end, append the findings to "Build findings / Session 2" in the doc (engine).
- (date) the operator: no cost gate and no cost-driven choice anywhere. Cost is shown, not enforced.
- (date) the operator: rules from s001 to s032 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path; no `git add -A`, no `git stash`; `mktemp -d` scratch, reported, never deleted; never print `.npmrc`, `.env*`, `auth.json`, `~/.spinner/env`, or a file named with `token`, `key` or `secret`; no customer or person in a tracked file; wait on an artifact, never on a Log timestamp; destructive e2e only on a scratch daemon with a scratch home; the operator's daemon on `:7777` is read-only for agents; a protocol change names the files the other agent's build touches; find the fault before you fix the proposed one; drivers close their CDP target; re-read `MISSION.md` before each edit; stop every scratch daemon, fixture and headless Chrome you started before you report; read the exact lines before an edit, never guess old text from a report; a probe that spends model money names its stop rule before it runs.

## Open questions
- (none yet)

## Log
- (start) the operator: session opened after v0.9.0 from the approved design; two pi subagents from one parent, briefs in agents/*/BRIEF.md
