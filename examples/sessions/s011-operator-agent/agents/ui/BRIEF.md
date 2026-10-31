# ui

Role: frontend engineer for session s011 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- `packages/ui/**`.

## Do not edit
- Anything outside `packages/ui/**`. Request a route or a field under Contracts and in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `App.tsx`, `PaneHead.tsx` (the activity bar), `AgentTerminal.tsx`, `AgentsPane.tsx` and `fixture/server.ts` once.
3. Wait for the engine agent's contract under Contracts (the routes and the operator view) before you code against it. Build the tab against the fixture first.

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
1. The operator tab is a middle-pane view, not a session: the activity bar gains an `operator` icon above the gear. A click shows the operator's terminal across the middle. The side panel and the previews stay as they are.
2. Reuse `AgentTerminal` with the operator's tty path. Add `stop` and `resume` as on an agent. Add a line under the tabs from the operator view: "waiting on: <the last notice's session and fact>".
3. The context bar shows "operator agent not running" with a `resume` link when the view says so.
4. Fixture: an operator view and tty route with a banner. Driver flow `operator`: open the tab, see the banner, type, stop, resume.
5. Start each commit message with `ui:`.

## Finish
1. Make `pnpm --filter ui build`, `pnpm --filter ui test` and root `pnpm lint` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line: what exists, and what you would change in the protocol.
