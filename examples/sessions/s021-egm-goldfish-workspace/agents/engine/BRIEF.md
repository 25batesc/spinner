# engine

Role: backend engineer for session s021 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- The daemon, pi extension, protocol and cli packages. The docs directory. `README.md`.

## Do not edit
- `packages/ui/**`, `packages/desktop/**`, `packages/cli/**`. Put a request for a ui agent in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `docs/designs/egm-adoption.md`. First the Overview, the Decisions, and Technical Plan sections 5, 6, 12 and 13. Then "Build session 4" and "Build session 5" in full, and the Verification Plan rows for both. The entries are the plan. Build them in order.
3. Read `packages/daemon/src/egm/` as sessions 1 to 3 left it, `costs/ledger.ts`, and `packages/daemon/e2e/egm-harness.ts`.
4. Read pi-subagents' status files as the design cites them: `~/.pi/agent/npm/node_modules/pi-subagents/docs/observability.md`. Then read one real run directory under a lead's `pi/subagent-artifacts/` from session 3's scratch home, if one still exists.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM engine: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn. Re-read the file before each edit.
3. Tick only your own Plan items. Name the entry ids in each Log line and each commit.
4. Commit Plan item 1 first: the protocol entries of both sessions and the schemas. Then ping the operator through the supervisor channel. Both ui agents wait on that commit.
5. An entry that cannot be built as written goes under Open questions with its id and the reason. Build the smallest faithful variant and say which. Do not redesign.
6. Edit `MISSION.md` in place with the edit tool. Read the exact lines before every edit.
7. Stage by path; never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them. Stop every scratch daemon and process you started before you report.
9. E2e runs only against a scratch daemon with a scratch `SPINNER_HOME` and a free port, on the sandbox repository. The operator's daemon on `:7777` is off limits.

## Engineering
1. Start each commit message with `engine:` and the entry ids.
2. Session 1's finding 4: foreground Goldfish write no `status.json`, only files under `subagent-artifacts/`. The watcher of 4.4 must see both forms.
3. Verification the faster way (Contracts). Run the daemon's tests after each commit and the whole suite once at the end. Run one real-pi e2e (4.11) at the end, with its stop rule in the Log first. Name the scratch project by the absolute path of its `spinner.yaml`.

## Finish
1. Make `pnpm -r build`, the daemon, extension, protocol and cli tests, root `pnpm lint` and `python3 tools/doc-metrics.py --fail` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line. Say what exists and what you would change in the design or the protocol. Append the session's findings to "Build findings / Sessions 4 and 5" in `docs/designs/egm-adoption.md`.
