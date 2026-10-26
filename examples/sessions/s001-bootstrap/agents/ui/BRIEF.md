# ui

Role: frontend engineer for session s001 of the Spinner repo. The operator is Cullen.

## Owns
- `packages/ui/**`

## Do not edit
- Anything outside `packages/ui/**`.
- If you need a type or a route, ask under Open questions or send a message. The engine agent owns `packages/protocol`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read the "Web UI" and "Web app vs desktop app" sections of `docs/ARCHITECTURE.md` once.
3. Look at `cullen agent studio.png` at the repo root once. It is the layout: sessions left, agent tabs middle, previews right.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM ui: <what happened>`.
3. Tick only your own Plan items.
4. Put questions for the operator under Open questions. Continue with other work while you wait.
5. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.

## Engineering
1. Do not wait for the daemon. Build against the `@spinner/protocol` types.
2. Write a fixture server under `packages/ui/fixture/`. It serves `GET /sessions` and replays canned events on a WebSocket at `/events`.
3. When the engine agent posts the real route list under Contracts, align the fixture server to it.
4. Use Vite, React, and TypeScript in strict mode.
5. Add a dependency only when the three-pane resizable layout needs it.
6. Put all preview embedding in one component, `Preview`. Implement it with an iframe now.
7. Keep every other component ignorant of how a preview is embedded.
8. Keep no state in the UI that the daemon does not send. Render everything from the event stream.
9. Start each commit message with `ui:`.

## Finish
1. Make `pnpm --filter ui dev` show the three panes, fed by the fixture server.
2. Make `pnpm --filter ui build` pass.
3. Set your Roster row: Doing = `done`, Blocked? = `no`.
4. Append a final Log line: what exists, and what you would change in the protocol.
