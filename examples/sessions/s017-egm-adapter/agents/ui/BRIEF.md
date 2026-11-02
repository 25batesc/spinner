# ui

Role: frontend engineer for session s017 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- `packages/ui/**`.

## Do not edit
- Anything outside `packages/ui/**`. Request a route or a field in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `docs/designs/egm-adoption.md`. First the Overview, the Decisions, and Technical Plan section 13 (UI). Then entries 1.35 to 1.39 and the ui rows of the Verification Plan for session 1. The entries are the plan.
3. Read `SettingsPane.tsx`, `remote.ts`, `fixture/server.ts` and `fixture/data.ts` once.
4. Wait for the engine agent's commit of entries 1.1 to 1.5 (check `git log` for `engine:`; never poll Log timestamps). Build against the fixture first.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM ui: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn. Re-read the file before each edit.
3. Tick only your own Plan item. Name the entry ids in each Log line and each commit.
4. An entry that cannot be built as written goes under Open questions with its id and the reason. Build the smallest faithful variant and say which.
5. Put a request for the engine agent in `inbox/` as `<HHMMSS>-ui-engine.md`, first line the subject.
6. Edit `MISSION.md` in place with the edit tool. Read the exact lines before every edit.
7. Stage by path (`git add packages/ui`); never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them. Stop every fixture, vite and headless Chrome you started before you report.
9. Drivers run against the fixture or a scratch daemon; never against `:7777`. Close the CDP target on success and on failure.

## Engineering
1. Start each commit message with `ui:` and the entry ids.
2. The design system: DESIGN-PASS scales, pills and buttons. The EGM attribution text is `EGM_NOTICE` from the protocol, never a copy.
3. Driver flow `about-egm` with screenshots in `.spinner/artifacts/`.

## Finish
1. Make `pnpm --filter ui build`, `pnpm --filter ui test` and root `pnpm lint` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line: what exists, and what you would change in the design or the protocol.
