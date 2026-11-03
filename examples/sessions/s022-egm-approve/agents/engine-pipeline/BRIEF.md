# engine-pipeline

Role: backend engineer (engine-pipeline) for session s022 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- `packages/daemon/src/pipeline/**` and `packages/cli/**`. Also `packages/daemon/src/store/review-brief.ts`, `packages/daemon/src/egm/pr-body.ts` with its test, and the 6.12 lines of `packages/daemon/src/agents/swarm.ts`.

## Do not edit
- `packages/daemon/src/server.ts`, the rest of `packages/daemon/src/egm/**` and `agents/**`, `packages/protocol/**`, `packages/pi-extension/**`, `packages/ui/**`, `docs/**`. Your `server.ts` wiring lines go to `inbox/` as `<HHMMSS>-pipeline-engine.md`; the `engine` agent adds them.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `docs/designs/egm-adoption.md`. First the Overview, the Decisions, and Technical Plan sections 10 and 12. Then entries 6.8 to 6.12 and 6.20 to 6.22 of "Build session 6". Then the Verification Plan rows for session 6. The entries are the plan. Build them in order.
3. Read `pipeline/pr.ts`, `pipeline/post.ts`, `pipeline/routes.ts`, `store/review-brief.ts`, `agents/swarm.ts`, and `packages/cli/src/commands/` once.
4. Wait for the `engine` agent's protocol commit (check `git log` for `engine:`; never poll Log timestamps). Build your pure modules meanwhile.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM engine: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn. Re-read the file before each edit.
3. Tick only your own Plan items. Name the entry ids in each Log line and each commit.
4. Your Plan item is 3. Commit it in two parts: the pure modules first, the routes once the protocol commit is in.
5. An entry that cannot be built as written goes under Open questions with its id and the reason. Build the smallest faithful variant and say which. Do not redesign.
6. Edit `MISSION.md` in place with the edit tool. Read the exact lines before every edit.
7. Stage by path; never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them. Stop every scratch daemon and process you started before you report.
9. Nothing you run touches the operator's daemon on `:7777`.

## Engineering
1. Start each commit message with `pipeline:` and the entry ids.
2. The PR body comes from the doc (6.8), with the sections the design names, never the whole doc. The `post` step and the Slack message name the doc.
3. Verification the faster way (Contracts). Run the tests of the modules you changed after each commit and the daemon suite once at the end. No real-pi e2e on your side; the `engine` agent's run covers the pipeline rows. Name the scratch project by the absolute path of its `spinner.yaml`.

## Finish
1. Make `pnpm -r build`, the daemon, extension, protocol and cli tests, root `pnpm lint` and `python3 tools/doc-metrics.py --fail` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line. Say what exists and what you would change in the design or the protocol. Append the session's findings to "Build findings / Sessions 4 and 5" in `docs/designs/egm-adoption.md`.
