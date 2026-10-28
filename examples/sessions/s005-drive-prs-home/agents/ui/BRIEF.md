# ui

Role: frontend engineer for session s005 of the Spinner repo. The operator is Cullen.

## Owns
- `packages/ui/**`.

## Do not edit
- Anything outside `packages/ui/**`. Request a type, route or event under Contracts and in `inbox/` to engine.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read the "Web UI" section of `docs/ARCHITECTURE.md` and the `MISSION.md` editing rules in `docs/SESSION_PROTOCOL.md` once.
3. Read `packages/ui/src` once. It is the s003 UI; build on it.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM ui: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn.
3. Tick only your own Plan items.
4. Put questions for the operator under Open questions. Continue with other work while you wait.
5. Put a request for another agent in `inbox/` as `<HHMMSS>-ui-<to>.md`, first line the subject.
6. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
7. Stage by path (`git add packages/ui`); never `git add -A`. Commit `pnpm-lock.yaml` with the `package.json` change that caused it.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.

## Engineering
1. Render from `GET /sessions` once and then from events. Keep no state the daemon does not send, except selection and unsaved edits.
2. Mission panel: render `MISSION.md`. Goal and Done when are editable, saved through the daemon's section route. Highlight the Roster. Flash a changed section once.
3. Threads view: one block per PR. Show each thread with its state, author kind, path and line, body, and the flagged mark. Add a `fix` button per PR.
4. Buttons `create PR`, `fix`, `post`, `land`, `reset` call their jobs and show the log drawer. `post` shows the composed message and asks for confirmation before the job posts. `approve` shows head, diff stat and open threads, then asks.
5. Context tab per agent: the context-file chain with scope and git state, each editable through the daemon. List the loaded skills and commands.
6. Keep the fixture server aligned with the routes and events; it serves the UI tests.
7. Verify in headless Chrome over the DevTools protocol with the driver under `e2e/`. Screenshots under `.spinner/artifacts/`.
8. Never print `.npmrc`, `.env*`, `auth.json`, or a file named with `token`, `key` or `secret`.
9. Start each commit message with `ui:`.

## Finish
1. Make `pnpm --filter ui build`, `pnpm --filter ui test` and root `pnpm lint` pass.
2. Make the end-to-end run of Plan item 8 pass from the UI with a screenshot per step.
3. Set your Roster row: Doing = `done`, Blocked? = `no`.
4. Append a final Log line: what exists, and what you would change in the protocol.
