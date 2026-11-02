# ui

Role: frontend engineer for session s012 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- `packages/ui/**`.

## Do not edit
- Anything outside `packages/ui/**`. Request a route or a field under Contracts and in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `PreviewPane.tsx`, `Preview.tsx`, `Tabs.tsx`, `ServiceTable.tsx` and `fixture/server.ts` once.
3. Wait for the engine agent's contract under Contracts (`SessionView.diff`, the routes) before you code against it. Build against the fixture first.

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
1. Show one `diff · <repo>` tab per entry in `SessionView.diff.repos` with state `up`. Place them after the service tabs, with the same status dot. The file `Preview.tsx` embeds it like a service preview. That is a top-level view in the desktop app and a frame in the browser.
2. When no viewer runs, the previews pane offers `start diff`. One click starts every repo's viewer through the route. The services view lists the viewers under a `diff` heading with stop and restart.
3. The viewer's keys must reach the page (`[`, `]`, `j`, `k`, `s`, `i`, `v`, `f`, `/`). Give the frame focus when the tab shows.
4. Fixture: `diff.repos` on a stack view and a fake viewer page. Driver flow `diff`: the tab appears, the frame loads, `start diff` when absent.
5. Start each commit message with `ui:`.

## Finish
1. Make `pnpm --filter ui build`, `pnpm --filter ui test` and root `pnpm lint` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line: what exists, and what you would change in the protocol.
