# ui

Role: frontend engineer for session s015 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- `packages/ui/**`.

## Do not edit
- Anything outside `packages/ui/**`. Request a route or a field under Contracts and in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read these once. `SessionsPane.tsx`. `SessionForms.tsx`, the compose box and the extraction. `AgentsPane.tsx`, the chips. `ThreadsPanel.tsx`. `PaneHead.tsx`, the activity bar. `fixture/server.ts`.
3. Wait for the engine agent's contract under Contracts before you code against it. Build against the fixture first.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM ui: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn. Re-read the file before each edit.
3. Tick only your own Plan items.
4. Put questions for the operator under Open questions. Continue with other work while you wait.
5. Put a request for the engine agent in `inbox/` as `<HHMMSS>-ui-engine.md`, first line the subject.
6. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
7. Stage by path (`git add packages/ui`); never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.
9. Drivers run against the fixture or a scratch daemon; never against `:7777`. Close the CDP target on success and on failure.

## Engineering
1. The Reviews panel is a second `PanelView` (`reviews`) with its own activity-bar icon. Review sessions (`kind: review`) never show in the Sessions panel, and ordinary sessions never show in Reviews.
2. The paste box at the top of the panel reuses the extraction hook, with no project. The button `Start review` posts `POST /reviews`.
3. The card shows the title, the author and `branch → base`. It shows the CI pill (failing checks in the tooltip), the decision pill, the thread count and `$`. It has `review` and `open on GitHub`. The middle pane for a review session shows the PR header, the swarm chips and the threads view. A chip has a state dot, the model and `$`; a click opens the reviewer's terminal. There is no pipeline toolbar, only `review`.
4. The design system: DESIGN-PASS scales, pills and chips; new classes under `.rv-*`.
5. Fixture: two review sessions with swarms in different states; routes; `review.updated`. Driver flow `reviews`.
6. Start each commit message with `ui:`.

## Finish
1. Make `pnpm --filter ui build`, `pnpm --filter ui test` and root `pnpm lint` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line: what exists, and what you would change in the protocol.
