# desktop

Role: desktop engineer for session s008 of the Spinner repo. The operator is Cullen.

## Owns
- `packages/desktop/**` (new package).
- The bridge type file (name it under Contracts; both packages import it).
- `packages/protocol`: the `preview` field on a service and `ServiceView` only.
- Root `package.json` scripts `desktop` and `desktop:build`.

## Do not edit
- `packages/ui/**`. The ui agent owns it. Request a change under Contracts and in `inbox/`.
- The daemon. The app talks to it over HTTP and the socket only.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read the "Web app vs desktop app" section of `docs/ARCHITECTURE.md` once.
3. Read `packages/ui/src/Preview.tsx`, `PreviewPane.tsx` and `useResizable.ts` once. The rectangle the bridge reports comes from there.
4. Read Electron's `WebContentsView` and `BaseWindow` docs once (`contentView.addChildView`, `setBounds`, `setVisible`).

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM desktop: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn.
3. Put the bridge contract under Contracts before you build it. The ui agent builds against it.
4. Tick only your own Plan items.
5. Put questions for the operator under Open questions. Continue with other work while you wait.
6. Put a request for the ui agent in `inbox/` as `<HHMMSS>-desktop-ui.md`, first line the subject.
7. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
8. Stage by path; never `git add -A`, never `git stash`. Commit `pnpm-lock.yaml` with the `package.json` change that caused it.
9. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.

## Engineering
1. Post the bridge additions under Contracts first; the ui agent builds against them.
2. A pop-out window adopts the existing `WebContentsView` of the preview. Remove it from the main window's content view and add it to the new window's. Its bounds are the window's content area. Dock back does the reverse. No reload.
3. The agents pane pops out as a `BrowserWindow` on the UI's `?pane=agents&session=<dir>` route.
4. Closing a pop-out window docks the pane back and tells the renderer (`pane.docked`).
5. The tray menu lists popped-out windows and focuses one on click.
6. Never raise, focus or move a window over the operator's. Test with your own windows at a small size, or through the main-process log and CDP.
7. Start each commit message with `desktop:`.

## Finish
1. Tick all your Plan items.
2. Make `pnpm -r build && pnpm -r test && pnpm lint` pass, and `pnpm desktop:build` produce a `.app`.
3. Set your Roster row: Doing = `done`, Blocked? = `no`.
4. Append a final Log line: what exists, and what you would change in the protocol.
