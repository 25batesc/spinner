# ui

Role: frontend engineer for session s016 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- `packages/ui/**`.

## Do not edit
- Anything outside `packages/ui/**`. Request a route or a field under Contracts and in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read these once. `ReviewPane.tsx` and `ReviewsPane.tsx`. `src/review.ts`. `MissionWorkspace.tsx`, the markdown rendering. `fixture/reviews.ts`.
3. Wait for the engine agent's contract under Contracts before you code against it. Build against the fixture first.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM ui: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn. Re-read the file before each edit.
3. Tick only your own Plan items.
4. Put questions for the operator under Open questions. Continue with other work while you wait.
5. Put a request for the engine agent in `inbox/` as `<HHMMSS>-ui-engine.md`, first line the subject.
6. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
7. Stage by path (`git add packages/ui`); never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them. Stop every fixture, vite and headless Chrome you started before you report.
9. Drivers run against the fixture or a scratch daemon; never against `:7777`. Close the CDP target on success and on failure.

## Engineering
1. The review pane gets two blocks above the threads. The briefing is markdown, with the same renderer as the mission context. Show it as soon as `review.briefing` is true. Fetch `artifacts/briefing.md` through the session files route. The draft shows the event as a pill, the summary body, and one row per line comment. A row has `path:line` and an editable body. Below them, `post` and `drop`.
2. `post` is a primary button. It asks once in place ("Post this review as you?"), then calls the route. The posted URL replaces the draft block. `drop` is a danger button. An edit saves through the draft route on blur.
3. The swarm chip states: `queued`, `reading`, `done`, `failed`. The lead has a chip too, with its state from the agent.
4. The design system: DESIGN-PASS scales, pills and buttons; classes under `.rv-*`.
5. Fixture: a review session with a briefing, three verdicts and a draft with two comments. The post route returns a URL. Driver flow `review-lead`.
6. Start each commit message with `ui:`.

## Finish
1. Make `pnpm --filter ui build`, `pnpm --filter ui test` and root `pnpm lint` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line: what exists, and what you would change in the protocol.
