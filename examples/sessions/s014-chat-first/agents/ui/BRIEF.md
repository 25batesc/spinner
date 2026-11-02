# ui

Role: frontend engineer for session s014 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- `packages/ui/**`. The design agent owns `src/MissionWorkspaceView.tsx` and `src/mission-workspace.css`.

## Do not edit
- Anything outside `packages/ui/**`. Request a route or a field under Contracts and in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `SessionForms.tsx`, `SessionsPane.tsx`, `MissionPanel.tsx`, `mission.ts`, `state.ts`, `fixture/server.ts` and `DESIGN-PASS.md` once.
3. Wait for the engine agent's contract under Contracts before you code against it. Agree the workspace props with the design agent under Contracts before either of you codes the workspace.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM ui: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn.
3. Tick only your own Plan items.
4. Put questions for the operator under Open questions. Continue with other work while you wait.
5. Put a request for another agent in `inbox/` as `<HHMMSS>-ui-<agent>.md`, first line the subject.
6. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
7. Stage by path (`git add packages/ui`); never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.
9. Drivers run against the fixture or a scratch daemon; never against `:7777`. Close the CDP target on success and on failure.

## Engineering
1. The compose box is one textarea and the project select. Extraction runs on a 500 ms pause through `POST /sessions/extract`. The PRs show as checkboxes with title and branch. A PR that is not adoptable is unticked, with the reason. One `Start` button. On success the session is selected and the lead's terminal shows.
2. `MissionWorkspace.tsx` owns data and actions. It reads the structured view from state. It gives `MissionWorkspaceView` props plus callbacks: `onEdit(section, id, text)`, `onTick(id)`, `onAnswer(questionId, text)`, `onNote(id, text)`, `onFilter(agent)`. Writes go through the section route. An answer is a steer. A note is an inbox message.
3. The `mission` view shows the workspace; the raw markdown stays reachable behind a `source` toggle.
4. Fixture: the extract route, the new sessions body, the structured mission view and `mission.changed` with ids and times. Driver flows `compose` and `workspace`.
5. Start each commit message with `ui:`.

## Finish
1. Make `pnpm --filter ui build`, `pnpm --filter ui test` and root `pnpm lint` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line: what exists, and what you would change in the protocol.
