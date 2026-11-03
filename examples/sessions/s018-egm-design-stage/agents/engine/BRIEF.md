# engine

Role: backend engineer for session s018 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- The daemon, pi extension, protocol and cli packages. The docs directory. `README.md`.

## Do not edit
- `packages/ui/**`, `packages/desktop/**`. Put a request for the ui agent in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `docs/designs/egm-adoption.md`. First the Overview, the Decisions, and Technical Plan sections 7, 10, 11 and 12. Then "Build session 2" in full, entries 2.1 to 2.47, and the Verification Plan rows for session 2. The entries are the plan. Build them in order.
3. Read `packages/daemon/src/egm/` as session 1 left it, `pipeline/derive-stage.ts`, `pipeline/tracker.ts`, `pipeline/reset.ts` and `store/mission-writer.ts`.
4. Read the EGM copy at `~/.spinner/egm/src`: `skills/egm-draft/SKILL.md` and `skills/egm-review/SKILL.md`. The design facts derive from the files each one writes.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM engine: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn. Re-read the file before each edit.
3. Tick only your own Plan items. Name the entry ids in each Log line and each commit.
4. Commit Plan item 1 (the protocol entries and the schemas) first and ping the operator through the supervisor channel. The ui agent waits on that commit.
5. An entry that cannot be built as written goes under Open questions with its id and the reason. Build the smallest faithful variant and say which. Do not redesign.
6. Edit `MISSION.md` in place with the edit tool. Read the exact lines before every edit.
7. Stage by path; never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them. Stop every scratch daemon and process you started before you report.
9. E2e runs only against a scratch daemon with a scratch `SPINNER_HOME` and a free port, on the sandbox repository. The operator's daemon on `:7777` is off limits.

## Engineering
1. Start each commit message with `engine:` and the entry ids.
2. `derive_design` is pure and tested from files, like `derive_stage`. The tracker calls `derive_stage` after it writes, so `needs_human` follows (review v2 B-1).
3. The session-2 checkpoint of the Verification Plan runs on a scratch daemon with the real pi. Name its stop rule in the Log before it runs.

## Finish
1. Make `pnpm -r build`, the daemon, extension, protocol and cli tests, root `pnpm lint` and `python3 tools/doc-metrics.py --fail` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line. Say what exists and what you would change in the design or the protocol. Append the session's findings to "Build findings / Session 2" in `docs/designs/egm-adoption.md`.
