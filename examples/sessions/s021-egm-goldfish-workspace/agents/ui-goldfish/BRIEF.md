# ui-goldfish

Role: frontend engineer (ui-goldfish) for session s021 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- In `packages/ui/`: `GoldfishChips.tsx`, `GoldfishTranscript.tsx`, `goldfish.ts` and its test, and `DesignStepper.tsx`. Also the Goldfish chips block of `AgentsPane.tsx`. Also your own lines in `remote.ts`, the fixture, `e2e/drive.ts` and `styles.css`.

## Do not edit
- Anything outside `packages/ui/**`, and nothing of session 5 (`Design*.tsx`, `design-workspace.ts`, the view wiring of `AgentsPane.tsx` and `App.tsx`): the `ui-workspace` agent builds those on a branch. Request a route or a field in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `docs/designs/egm-adoption.md`. First the Overview, the Decisions, and Technical Plan sections 5, 6 and 13. Then entries 4.14 to 4.18 and the ui rows of the Verification Plan for session 4. The entries are the plan.
3. Read these once. `AgentsPane.tsx`, the chips and the gate cards. `ReviewPane.tsx`, the review swarm chips (the pattern). `DesignStepper.tsx`. The fixture files `data.ts` and `server.ts`.
4. Wait for the engine agent's commit of Plan item 1, the protocol entries. Check `git log` for `engine:`; never poll Log timestamps. Build against the fixture first.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM ui: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn. Re-read the file before each edit.
3. Tick only your own Plan items. Name the entry ids in each Log line and each commit.
4. An entry that cannot be built as written goes under Open questions with its id and the reason. Build the smallest faithful variant and say which.
5. Put a request for the engine agent in `inbox/` as `<HHMMSS>-ui-engine.md`, first line the subject.
6. Edit `MISSION.md` in place with the edit tool. Read the exact lines before every edit.
7. Stage by path (`git add packages/ui`); never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them. Stop every fixture, vite and headless Chrome you started before you report.
9. Drivers run against the fixture or a scratch daemon; never against `:7777`. Close the CDP target on success and on failure.

## Engineering
1. Start each commit message with `ui:` and the entry ids.
2. The design system: DESIGN-PASS scales, pills and chips. A Goldfish chip is a fact like a review chip: state dot, persona, tokens, `$`. A click opens its transcript.
3. Driver flow `goldfish` with screenshots in `.spinner/artifacts/`. Only the flows you touched after each commit; the full sweep once before you report.

## Finish
1. Make `pnpm --filter ui build`, `pnpm --filter ui test` and root `pnpm lint` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line: what exists, and what you would change in the design or the protocol.
