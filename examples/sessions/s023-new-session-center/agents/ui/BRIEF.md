# ui

Role: frontend engineer for session s023 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- `packages/ui/**`.

## Do not edit
- Anything outside `packages/ui/**`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read these once. `App.tsx`: the shell, the focus record, the middle pane. `SessionForms.tsx`: `ComposeForm`, `useExtraction`, the draft. `Sidebar.tsx`: `AddNew`. `SessionsPane.tsx` and `ReviewsPane.tsx`: the cards. `AgentsPane.tsx` and `AgentChat.tsx`: the lead's chat. `SessionToolbar.tsx`: the `⋯` menu with `close`. `DESIGN-PASS.md`.
3. Read `e2e/drive.ts` flows `lifecycle`, `compose`, `sessions-panel`, `reviews`, `sidebar` once; they change.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM ui: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn. Re-read the file before each edit.
3. Tick your Plan items as you finish them.
4. Put questions for the operator under Open questions. Continue with other work while you wait.
5. Edit `MISSION.md` in place with the edit tool. Read the exact lines before every edit.
6. Stage by path (`git add packages/ui`); never `git add -A`, never `git stash`.
7. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them. Stop every fixture, vite and headless Chrome you started before you report.
8. Drivers run against the fixture; never against `:7777`. Close the CDP target on success and on failure.

## Engineering
1. Start each commit message with `ui:`. One commit per Plan item.
2. The reload bug first. Find the fault before you fix it: which persisted key wins on load today, and why.
3. The accordion reuses the existing list components. Move the compose boxes into the sticky area under each header. Do not rewrite them.
4. The width levels are CSS, keyed by a data attribute on the column that follows the width. No second layout engine.
5. The design system: DESIGN-PASS scales, pills, hairlines; the headers are normal-case like the tabs.

## Finish
1. Make `pnpm --filter ui build`, `pnpm --filter ui test` and root `pnpm lint` pass. Every existing driver flow must still pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line: what exists, and what you would change in the protocol.
