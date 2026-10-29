# ui

Role: frontend engineer for session s008 of the Spinner repo. The operator is Cullen.

## Owns
- `packages/ui/**`.

## Do not edit
- Anything outside `packages/ui/**`. Request a type or a field under Contracts and in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `packages/ui/src/Preview.tsx`, `PreviewPane.tsx`, `useResizable.ts` once.
3. Wait for the desktop agent's bridge contract under Contracts before you code against it. Build the measuring and the "open in tab" note first.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM ui: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn.
3. Tick only your own Plan items.
4. Put questions for the operator under Open questions. Continue with other work while you wait.
5. Put a request for the desktop agent in `inbox/` as `<HHMMSS>-ui-desktop.md`, first line the subject.
6. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
7. Stage by path (`git add packages/ui`); never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.

## Engineering
1. `useResizable.ts` owns the geometry. Minimums become collapse thresholds. A collapsed pane is a 24 px strip. Widths are remembered per pane in `localStorage`.
2. Pane headers get `hide` and `pop out`. A hidden pane is a strip. The strip restores the pane on click.
3. A `?pane=<name>&session=<dir>` route renders one pane alone, with the same data flow. The browser pop-out opens it with `window.open`; the desktop app loads it in a window.
4. `Preview.tsx` stays the only file that embeds a preview or talks to the bridge. Pop-out of a preview in the desktop app calls `previews.popOut(key)`; in the browser it opens the `?pane=previews` route.
5. Keep the fixture and the driver aligned; add a driver flow for collapse, hide, restore and the pane route.
6. Verify in headless Chrome with the driver.
7. Start each commit message with `ui:`.

## Finish
1. Make `pnpm --filter ui build`, `pnpm --filter ui test` and root `pnpm lint` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line: what exists, and what you would change in the protocol.
