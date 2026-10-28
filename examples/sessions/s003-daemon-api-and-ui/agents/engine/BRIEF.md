# engine

Role: backend engineer for session s003 of the Spinner repo. The operator is Cullen.

## Owns
- `packages/protocol` (all files).
- `packages/daemon/**`, except the internals of `src/stack/**` and `src/pipeline/**`. Call those modules. A needed change inside them is a Contracts line first, then a minimal edit.
- `packages/cli`: one-line changes that route a command through the daemon modules.
- Root configs.

## Do not edit
- `packages/ui/**`. The ui agent owns it.
- If the UI needs a type, a route or an event, add it to `packages/protocol`. Then announce it under Contracts.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `docs/ARCHITECTURE.md` once: the daemon, the pipeline tracker, the agent adapter, the web app.
3. Read `docs/SESSION_PROTOCOL.md` once: the session directory, `session.yaml`, the pi extension section, the Lessons.
4. Read `packages/daemon/src/stack/runner.ts`, `src/pipeline/tracker.ts` and `src/pipeline/poller.ts` once. Build on them.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM engine: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn.
3. Put each type, route or event that the UI will use under Contracts before you build it.
4. Tick only your own Plan items.
5. If you find new work, add a Plan item and name an owner.
6. Put questions for the operator under Open questions. Continue with other work while you wait.
7. Put a request for the ui agent in `inbox/` as `<HHMMSS>-engine-ui.md`, first line the subject.
8. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
9. Stage by path; never `git add -A`. Commit `pnpm-lock.yaml` with the `package.json` change that caused it.
10. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.

## Engineering
1. Use TypeScript in strict mode, Node 24, the pnpm workspace, Vitest. Follow the repo's style: snake_case, assertions on preconditions, short functions, full-sentence comments that say why.
2. Keep `packages/protocol` free of runtime dependencies.
3. Keep the daemon stateless. It rebuilds everything from `SPINNER_HOME` at start. Board facts are a cache the poller refreshes.
4. Run every action as a job. A job has an id, an action, a session, a bounded log, and one `job.finished` event. Two jobs never run on the same session at the same time.
5. Serve `packages/ui/dist` at `/`. When it is absent, `GET /` says so and names the build command.
6. Make the CLI call the same functions the routes call. No logic in a route handler.
7. For `PiRpcHarness`, start pi with `--mode rpc` and the agent's `--session-dir`. Type `agent.event` from pi's own event union; do not invent fields. Find pi's event types in its package under `~/.pi/agent/npm` or the global install, and cite the file in a comment.
8. Never print a file named `.npmrc`, `.env*`, `auth.json`, or with `token`, `key` or `secret` in its name.
9. Start each commit message with `engine:`.

## Finish
1. Tick all your Plan items.
2. Make `pnpm -r build && pnpm -r test && pnpm lint` pass.
3. Set your Roster row: Doing = `done`, Blocked? = `no`.
4. Append a final Log line: what exists, and what you would change in the protocol.
