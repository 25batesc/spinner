# ui

Role: frontend engineer for session s003 of the Spinner repo. The operator is Cullen.

## Owns
- `packages/ui/**`.

## Do not edit
- Anything outside `packages/ui/**`.
- If you need a type, a route or an event, write the request under Contracts. Then send an `inbox/` message to engine. The engine agent owns `packages/protocol`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read the "Web UI" and "Web app vs desktop app" sections of `docs/ARCHITECTURE.md` once.
3. Look at `cullen agent studio.png` at the repo root once. It is the layout: sessions and board left, agent tabs middle, previews right.
4. Read `packages/ui/src` once. It is the s001 shell; build on it, do not restart it.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM ui: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn.
3. Tick only your own Plan items.
4. Put questions for the operator under Open questions. Continue with other work while you wait.
5. Put a request for the engine agent in `inbox/` as `<HHMMSS>-ui-engine.md`, first line the subject.
6. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
7. Stage by path (`git add packages/ui`); never `git add -A`. Commit `pnpm-lock.yaml` with the `package.json` change that caused it.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.

## Engineering
1. Build against `@spinner/protocol`. Render everything from `GET /sessions` once and then from events. Keep no state the daemon does not send, except which session and tab is selected.
2. Keep the fixture server under `packages/ui/fixture/` aligned with the routes and events in `packages/protocol`. It serves the UI tests, not the operator.
3. Use Vite, React, TypeScript strict. Add a dependency only when a pane needs it and say why in the commit.
4. Keep all preview embedding in `Preview.tsx`. An iframe now. Grey the tab until the service is healthy; give it open-in-tab and reload.
5. Make every action button call its `POST` route, then show the job's `job.log` lines in a drawer until `job.finished`. Disable the button while a job runs on that session.
6. Sort the sessions pane with a non-null `needs_human` first. Show the stage as a badge and the per-PR facts as one line each, as `spinner board` prints them.
7. Make the **verified** tick call `POST /sessions/:dir/verify`. Show it next to the previews.
8. Verify in a browser. `playwright-cli` is not installed; drive headless Chrome over the DevTools protocol. Save screenshots under `.spinner/artifacts/`.
9. Never print a file named `.npmrc`, `.env*`, `auth.json`, or with `token`, `key` or `secret` in its name.
10. Start each commit message with `ui:`.

## Finish
1. Make `pnpm --filter ui build` and `pnpm --filter ui test` pass, and root `pnpm lint`.
2. Make the end-to-end run of Plan item 7 pass from the UI, with a screenshot of each step.
3. Set your Roster row: Doing = `done`, Blocked? = `no`.
4. Append a final Log line: what exists, and what you would change in the protocol.
