# ui

Role: frontend engineer for session s007 of the Spinner repo. The operator is Cullen.

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
1. `Preview.tsx` stays the only file that embeds a preview or talks to the bridge. Every other component stays ignorant of how a preview is shown.
2. With the bridge: render an empty box. Measure it with `ResizeObserver`, on scroll and on pane drag. Send the rectangle in CSS pixels relative to the window. Send show or hide on tab switch and unmount.
3. Without the bridge: keep the iframe. When the service's `preview` is `top-level`, show a short note above it. The note says that the app keeps its login in cookies and needs a top-level page. It offers open in tab or the desktop app. Keep the iframe for a look.
4. Keep the fixture server aligned. Add a service with `preview: top-level` to its data.
5. Verify in headless Chrome with the driver for the browser path; the desktop agent verifies the bridge path in Electron.
6. Start each commit message with `ui:`.

## Finish
1. Make `pnpm --filter ui build`, `pnpm --filter ui test` and root `pnpm lint` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line: what exists, and what you would change in the protocol.
