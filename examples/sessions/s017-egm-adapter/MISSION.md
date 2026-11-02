# s017 · EGM build session 1: the harness adapter and its evidence probes

## Goal
The spec is the approved design `docs/designs/egm-adoption.md`, version 3, "Build session 1: `egm-adapter`" (entries 1.1 to 1.39) and the Verification Plan rows for session 1. This file holds run state only. The design doc holds the goal, the plan and the tests; do not restate them here.

## Done when
- [ ] Every entry 1.1 to 1.39 is built as written, and the session-1 checkpoint in the Verification Plan passes
- [ ] The evidence probes of entry 1.26 ran on a scratch daemon with the real pi, and `docs/egm/HARNESS_EVIDENCE.md` (1.27) records each result with its transcript path
- [ ] `pnpm -r build && pnpm -r test && pnpm lint` and `python3 tools/doc-metrics.py --fail` green

## Plan
- [ ] 1. Entries 1.1 to 1.5 (protocol), committed first so the ui agent can build (engine)
- [ ] 2. Entries 1.6 to 1.21 (daemon: pinned clone, pins, adapter, fetch, spawn, routes, harness, manager, lead, server, mission template) (engine)
- [ ] 3. Entries 1.22 to 1.25 (pi extension) and 1.28 to 1.29 (cli doctor) (engine)
- [ ] 4. Entry 1.26 (the e2e with the probes) and 1.27 (the evidence) (engine)
- [ ] 5. Entries 1.30 to 1.34 (docs; 1.34: `docs/designs/egm-adoption.md` already exists, add `SITEMAP.md` and fold `docs/designs/README.md` into it) (engine)
- [ ] 6. Entries 1.35 to 1.39 (ui: remote, About EGM, settings, fixture) (ui)
- [ ] 7. Lessons → protocol; release (the operator)

## Roster
| Agent  | Owns | Doing | Blocked? | Updated |
|--------|------|-------|----------|---------|
| engine | `packages/daemon/**`, `packages/pi-extension/**`, `packages/protocol/**`, `packages/cli/**`, `docs/**`, `README.md` | — | no | — |
| ui     | `packages/ui/**` | — | no | — |

## Contracts & decisions
- (date) the operator: the design doc is the contract. An entry that cannot be built as written is a finding: record it under Open questions with the entry id, build the smallest faithful variant, and say which in the Log. Do not redesign.
- (date) the operator: no cost gate and no cost-driven choice anywhere. Cost is shown, not enforced.
- (date) the operator: the EGM copy under `~/.spinner/egm/src` on this machine is pinned at `a119668d7dc5d558664ba711d4671d11fb7270a8`; `~/.spinner/egm/PIN` holds it. The fetch of entry 1.10 may reuse it when the sha matches.
- (date) the operator: rules from s001 to s018 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path; no `git add -A`, no `git stash`; `mktemp -d` scratch, reported, never deleted; never print `.npmrc`, `.env*`, `auth.json`, `~/.spinner/env`, or a file named with `token`, `key` or `secret`; no customer or person in a tracked file; wait on an artifact, never on a Log timestamp; destructive e2e only on a scratch daemon with a scratch home; the operator's daemon on `:7777` is read-only for agents; a protocol change names the files the other agent's build touches; find the fault before you fix the proposed one; drivers close their CDP target; re-read `MISSION.md` before each edit; stop every scratch daemon, fixture and headless Chrome you started before you report; read the exact lines before an edit, never guess old text from a report.

## Open questions
- (none yet)

## Log
- (start) the operator: session opened after v0.8.0 from the approved design; two pi subagents from one parent, briefs in agents/*/BRIEF.md
