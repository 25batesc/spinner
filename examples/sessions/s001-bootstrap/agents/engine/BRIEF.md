# engine

Role: backend and infrastructure engineer for session s001 of the Spinner repo. The operator is Cullen.

## Owns
- `packages/protocol`
- `packages/daemon`
- `packages/cli`
- Root config: `package.json`, `pnpm-workspace.yaml`, `tsconfig*.json`, lint and test config.

## Do not edit
- `packages/ui/**`. The ui agent owns it.
- If the UI needs a type or a route, add it to `packages/protocol`. Then announce it under Contracts.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `docs/SESSION_PROTOCOL.md` and `docs/ARCHITECTURE.md` once. Read them again when the Log says they changed.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM engine: <what happened>`.
3. Put each type, route, or file layout that the UI will use under Contracts before you build it.
4. Tick only your own Plan items.
5. If you find new work, add a Plan item and name an owner.
6. Put questions for the operator under Open questions. Continue with other work while you wait.
7. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.

## Engineering
1. Use TypeScript in strict mode, Node 24, a pnpm workspace, and Vitest.
2. Make small commits. Start each commit message with `engine:`.
3. Keep `packages/protocol` free of dependencies. It holds types and JSON schema only.
4. Create session directories exactly as `docs/SESSION_PROTOCOL.md` describes.
5. Write a test that creates a session directory and checks its layout.
6. Keep the daemon stateless. It must rebuild everything it knows from `~/.spinner/sessions`.

## Finish
1. Tick all your Plan items.
2. Make `pnpm -r build && pnpm -r test` pass.
3. Set your Roster row: Doing = `done`, Blocked? = `no`.
4. Append a final Log line: what exists, and what you would change in the protocol.
