# ui

Role: frontend engineer for session s013 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- `packages/ui/**`.

## Do not edit
- Anything outside `packages/ui/**`. Request a field under Contracts and in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `SessionsPane.tsx`, `PaneHead.tsx` (the context bar), `AgentsPane.tsx` (the chips), `SettingsPane.tsx`, `usage.ts` and `fixture/server.ts` once.
3. Wait for the engine agent's contract under Contracts before you code against it. Build against the fixture first.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM ui: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn.
3. Tick only your own Plan items.
4. Put questions for the operator under Open questions. Continue with other work while you wait.
5. Put a request for the engine agent in `inbox/` as `<HHMMSS>-ui-engine.md`, first line the subject.
6. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
7. Stage by path (`git add packages/ui`); never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.
9. Drivers run against the fixture or a scratch daemon; never against `:7777`. Close the CDP target on success and on failure.

## Engineering
1. Money prints as `$1.23` (two decimals; under one cent as `<$0.01`); tokens in compact form (`17.5k`). Put the printers in `costs.ts` with tests.
2. The bar chart is plain SVG, no chart library. Draw one `rect` per period. Put the hover value in a `title` and a small label. The switch is three small tabs.
3. The Usage section sits under the theme in `SettingsPane.tsx`. Keep the markup small and the classes new (`.usage-*`). A design agent edits the same files in another worktree.
4. Fixture: `cost` on the views and a `/costs` route with 30 days of made-up numbers. Driver flow `costs` asserts the card figure, the context bar figure and the three totals. It asserts the chart has 30 bars and the switch changes the bar count.
5. Start each commit message with `ui:`.

## Finish
1. Make `pnpm --filter ui build`, `pnpm --filter ui test` and root `pnpm lint` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line: what exists, and what you would change in the protocol.
