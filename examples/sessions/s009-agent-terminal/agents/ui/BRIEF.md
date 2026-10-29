# ui

Role: frontend engineer for session s009 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- `packages/ui/**`.

## Do not edit
- Anything outside `packages/ui/**`. Request a route or a field under Contracts and in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `packages/ui/src/AgentsPane.tsx`, `AgentChat.tsx`, `useResizable.ts` and `fixture/server.ts` once.
3. Wait for the engine agent's contract under Contracts (the WebSocket framing) before you code against it. Build the terminal component against the fixture's echo pty first.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM ui: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn.
3. Tick only your own Plan items.
4. Put questions for the operator under Open questions. Continue with other work while you wait.
5. Put a request for the engine agent in `inbox/` as `<HHMMSS>-ui-engine.md`, first line the subject.
6. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
7. Stage by path (`git add packages/ui`); never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.
9. Drivers run against the fixture or a scratch daemon; never against `:7777`.

## Engineering
1. The file `AgentTerminal.tsx` uses `@xterm/xterm` with `@xterm/addon-fit` and `@xterm/addon-web-links`. One `Terminal` per agent tab. Keep it mounted while the tab is hidden, so the scrollback survives a tab switch. Call `fit()` on mount, on the pane's resize observer, and on pop-out.
2. The WebSocket client sends and receives binary frames. It sends the resize text frame after each `fit()`. It reconnects with a back-off of 1, 2, 4 s up to 30 s. It shows a one-line status in the tab's header while disconnected.
3. The agent tab shows the terminal for a `tty` agent and the old chat for an `rpc` agent. The engine agent adds `agents.<name>.harness` to `SessionView`; read it when it lands. `?chat=1` forces the chat.
4. Keep `add agent`, `stop`, `resume` and the Context tab working. Keep the pop-out of the agents pane working with the terminal inside.
5. Theme: pi's default colours on the pane's dark background; the font the app uses for code; 13 px.
6. Fixture: a fake pty endpoint that echoes keystrokes and prints a banner on attach. The driver then types and asserts without pi.
7. Driver flow `terminal`: attach and see the banner. Type `hello` and Enter and see the echo. Resize the pane and see the resize frame. Pop out and see the terminal in the window.
8. Start each commit message with `ui:`.

## Finish
1. Make `pnpm --filter ui build`, `pnpm --filter ui test` and root `pnpm lint` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line: what exists, and what you would change in the protocol.
