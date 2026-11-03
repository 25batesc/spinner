# engine

Role: backend engineer for session s022 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- `packages/protocol/**`, `packages/pi-extension/**`, `packages/daemon/e2e/**`, `packages/daemon/src/server.ts`, `docs/**`. Also `packages/daemon/src/egm/**` except `pr-body*.ts`. Also `packages/daemon/src/agents/**` except the 6.12 lines of `swarm.ts`.

## Do not edit
- The `engine-pipeline` agent's files: `packages/daemon/src/pipeline/**`, `store/review-brief.ts`, `egm/pr-body*.ts`, `packages/cli/**`. Also `packages/ui/**`. Requests go to `inbox/`. The `engine-pipeline` agent sends you its `server.ts` wiring lines there.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `docs/designs/egm-adoption.md`. First the Overview, the Decisions, and Technical Plan sections 7, 8, 10 and 13. Then "Build session 6" in full, entries 6.1 to 6.23, and the Verification Plan rows for session 6. The entries are the plan. Build them in order.
3. Read `packages/daemon/src/egm/design.ts` and `derive-design.ts` as sessions 1 to 5 left them, `agents/manager.ts`, `packages/pi-extension/src/guard.ts`, and `packages/daemon/e2e/egm-harness.ts`.
4. Read `~/.spinner/egm/src/skills/egm-resolve/SKILL.md` Step 5 for the resolve marker the stage check reads.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM engine: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn. Re-read the file before each edit.
3. Tick only your own Plan items. Name the entry ids in each Log line and each commit.
4. Commit Plan item 1 first: the protocol entries and the schemas. Then ping the operator through the supervisor channel. The `engine-pipeline` and `ui` agents wait on that commit.
5. An entry that cannot be built as written goes under Open questions with its id and the reason. Build the smallest faithful variant and say which. Do not redesign.
6. Edit `MISSION.md` in place with the edit tool. Read the exact lines before every edit.
7. Stage by path; never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them. Stop every scratch daemon and process you started before you report.
9. E2e runs only against a scratch daemon with a scratch `SPINNER_HOME` and a free port, on the sandbox repository. The operator's daemon on `:7777` is off limits.

## Engineering
1. Start each commit message with `engine:` and the entry ids.
2. Approval pins the doc's normalized hash (`normalized_doc_hash`). Any edit clears it and locks the lead's code writes through the guard until re-approval. Approval with open blockers needs the explicit confirmation that records the count (review M17).
3. The session-6 e2e rows: approve and build, the edit that clears approval, the re-approval, the PR body, the resolve stage. One real-pi run at the end, stop rule in the Log first. Name the scratch project by the absolute path of its `spinner.yaml`.

## Finish
1. Make `pnpm -r build`, the daemon, extension, protocol and cli tests, root `pnpm lint` and `python3 tools/doc-metrics.py --fail` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line. Say what exists and what you would change in the design or the protocol. Append the session's findings to "Build findings / Session 6" in `docs/designs/egm-adoption.md`.
