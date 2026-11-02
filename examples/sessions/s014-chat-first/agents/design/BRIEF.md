# design

Role: product designer and frontend engineer for session s014 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- `packages/ui/src/MissionWorkspaceView.tsx` and `packages/ui/src/mission-workspace.css`.

## Do not edit
- Anything else. Ask the ui agent for a prop or a callback under Contracts and in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `packages/ui/DESIGN-PASS.md` (the design system you build on) and `styles.css` for the variables.
3. Agree the props of `MissionWorkspaceView` with the ui agent under Contracts before you code.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM design: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn.
3. Tick only your own Plan items.
4. Put questions for the operator under Open questions. Continue with other work while you wait.
5. Put a request for the ui agent in `inbox/` as `<HHMMSS>-design-ui.md`, first line the subject.
6. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
7. Stage by path (your two files); never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.
9. Screenshots come from the fixture in headless Chrome; never from `:7777`. Close the CDP target on success and on failure.

## Design
1. The workspace is where the operator reads the state of the work in ten seconds. It is also where he sees agents hand off to each other. The references are a calm project board, Linear's issue view, and Graphite's PR page.
2. Layout at 1500 px. Goal across the top as a card, with Done when as a checklist beside it. Under them, three Plan columns `next · doing · done` with owner chips and the tick time. Then Roster as chips with each agent's doing. Then Open questions as cards with an inline answer box, and Contracts as a list. The Log is a feed at the bottom or the right, newest first, with an agent filter. At 1000 px the columns stack.
3. Every item is one row: text, owner chip, time. Hover shows edit and note. The editing state is an input in place. Ticks animate once. A new Log line arrives without a jump.
4. Empty states say what the lead will write there.
5. Keep the DESIGN-PASS scales and button kinds. New classes go under `.mw-*`.

## Finish
1. `pnpm --filter ui build`, `pnpm --filter ui test` and root `pnpm lint` pass with your files in.
2. Screenshots of the workspace at 1500 and 1000 px in the session's `artifacts/`.
3. Set your Roster row: Doing = `done`, Blocked? = `no`.
4. Append a final Log line: what exists, and what you would change in the protocol.
