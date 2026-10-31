# engine

Role: backend engineer for session s010 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- The daemon, cli, protocol and desktop packages. Also `docs/DAEMON_API.md`.

## Do not edit
- `packages/ui/**`. Put a request for the ui agent in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `docs/sessions/soak-questions.md`: each row names the fault, the wanted state and a proposed fix.
3. For each item, read the code it touches before you change it. The places are: `server.ts` static serving; `agents/manager.ts` `add`; `pipeline/routes.ts` verify; `desktop/src/electron-previews.ts`; `agents/plumbing.test.ts`; `store/session-store.ts` `next_session_id`; `stack/host-service.ts` route files.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM engine: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn.
3. Tick only your own Plan items.
4. The `DELETE /verify` route lands first and its commit is named under Contracts; the ui agent waits on it.
5. Put questions for the operator under Open questions. Continue with other work while you wait.
6. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
7. Stage by path; never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.
9. E2e runs only against a scratch daemon with a scratch `SPINNER_HOME` and a free port. The operator's daemon on `:7777` is off limits.

## Engineering
1. One commit per item, with a test that fails before and passes after. Name the item in the commit message.
2. The UI snapshot. At start, copy `packages/ui/dist` to `~/.spinner/ui/<commit>/` when absent. Serve from there. Remove other commits' snapshots. `GET /health` carries `ui_commit`.
3. Settings in the manager: read `settings.yaml` at `add`; `request.model`, then `settings.default_model`, then `config.default_model`; the harness the same way.
4. The cookie partition. Give each preview's `WebContentsView` the session `fromPartition("persist:" + session dir)`. The pop-out window keeps the view, so it keeps the partition.
5. The flaky test: find the race, do not add a sleep. A fake clock or a widened window in the test is fine when the code is right.
6. Ids across homes. `next_session_id` takes the maximum over three sources: the home's sessions, the archive, and the ids in the proxy route files.
7. Start each commit message with `engine:`.

## Finish
1. Make `pnpm -r build`, the daemon, cli, protocol and desktop tests, root `pnpm lint` and `python3 tools/doc-metrics.py --fail` pass.
2. Mark the soak rows you closed with the commit in `docs/sessions/soak-questions.md`.
3. Set your Roster row: Doing = `done`, Blocked? = `no`.
4. Append a final Log line: what exists, and what you would change in the protocol.
