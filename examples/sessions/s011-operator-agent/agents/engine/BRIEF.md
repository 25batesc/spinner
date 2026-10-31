# engine

Role: backend engineer for session s011 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- The daemon package. The pi extension package. The protocol package. The cli package. The two docs pages `ARCHITECTURE.md` and `DAEMON_API.md`.

## Do not edit
- `packages/ui/**`, `packages/desktop/**`. Put a request for the ui agent in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `packages/daemon/src/agents/tty-harness.ts`, `extension-channel.ts`, `manager.ts`, `routes-tty.ts`, `packages/pi-extension/src/tools.ts` and `tty.ts` once. The operator host reuses the harness and the channel; it does not copy them.
3. Read one full session template under `examples/sessions/` (mission, briefs, `session.yaml`): the operator agent writes that shape.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM engine: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn.
3. Tick only your own Plan items.
4. Put the contract (Plan item 1) under Contracts and commit the protocol types first. Then ping the operator through the supervisor channel. The ui agent waits on that commit.
5. Put questions for the operator under Open questions. Continue with other work while you wait.
6. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
7. Stage by path; never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.
9. E2e runs only against a scratch daemon with a scratch `SPINNER_HOME` and a free port. The operator's daemon on `:7777` is off limits.

## Engineering
1. The file `agents/operator.ts` hosts one agent over `PiTtyHarness`. Its cwd is the home. Its arguments are `--session-dir <home>/operator/pi`, `--session-id operator`, and the extension in role `operator`. Start it with the daemon after `adopt_all`. Resume on restart the same way.
2. The brief writer puts `BRIEF.md` under `<home>/operator/` when absent. Write it as prose a model acts on. It says what Spinner is and the shape of a session. It says how to turn a request into a mission and briefs. It states the rules. Keep it under 120 lines.
3. The tools in the operator role call the daemon's routes with the same bodies the UI sends. The tool `mission_write` takes `{ session, section, text }`. The tool `agent_add` takes `{ session, name, brief, repo?, model? }`. A refused action (push, post, approve, land, reset, close) returns a message that says the operator must do it.
4. Notices: subscribe on the bus; batch per second; one `notify` through the channel; text starts with the session dir. Bound the queue at 100; drop the oldest and say so in the notice.
5. Test through the daemon with the fake interactive pi. The operator starts and resumes. A tool call creates a session and writes a mission. A `needs_human` reaches the operator as a notice. Add one e2e script with the real pi under `packages/daemon/e2e/operator.ts`.
6. Start each commit message with `engine:`.

## Finish
1. Make `pnpm -r build`, the daemon, extension and cli tests, root `pnpm lint` and `python3 tools/doc-metrics.py --fail` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line: what exists, and what you would change in the protocol.
