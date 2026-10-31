# ui

Role: frontend engineer for session s010 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- `packages/ui/**`.

## Do not edit
- Anything outside `packages/ui/**`. Request a route under Contracts and in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `docs/sessions/soak-questions.md` for the narrow-window and fixture-port rows.
3. Read `useResizable.ts`, `layout.ts`, `fixture/server.ts`, `vite.config.ts` and `PipelineActions.tsx` once.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM ui: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn.
3. Tick only your own Plan items.
4. The verify checkbox waits for the engine agent's `DELETE /verify` commit under Contracts. Do the port and the narrow window first.
5. Put questions for the operator under Open questions. Continue with other work while you wait.
6. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
7. Stage by path (`git add packages/ui`); never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.
9. Drivers run against the fixture or a scratch daemon; never against `:7777`. Close the CDP target on success and on failure.

## Engineering
1. The fixture and vite default to `17777`; `SPINNER_PORT` still overrides. The README's fixture line follows.
2. Narrow window. When the three minimums do not fit the width, the previews collapse first. Then the side panel folds. The agents pane never goes under 280 px. A driver flow at 900 px asserts the terminal opens.
3. The verify checkbox: unchecking calls `DELETE`; the tick follows the daemon's view, not local state.
4. One commit per item, each with a test or a driver flow. Start each commit message with `ui:`.

## Finish
1. Make `pnpm --filter ui build`, `pnpm --filter ui test` and root `pnpm lint` pass.
2. The soak list is outside your paths. Send the engine agent an `inbox/` note with the rows you closed and the commits. The engine agent marks them.
3. Set your Roster row: Doing = `done`, Blocked? = `no`.
4. Append a final Log line: what exists, and what you would change in the protocol.
