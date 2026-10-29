# engine

Role: backend engineer for session s009 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- The daemon, the pi extension, the protocol and the cli packages. Also `docs/ARCHITECTURE.md` and `docs/DAEMON_API.md`.

## Do not edit
- `packages/ui/**`, `packages/desktop/**`. Put a request for the ui agent in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `packages/daemon/src/agents/harness.ts`, `pi-rpc.ts`, `manager.ts`, `routes.ts` and `packages/pi-extension/src/index.ts` once. The `AgentHandle` interface is the seam: the tty harness implements it, the manager does not change its shape.
3. Read pi's `docs/extensions.md` and `docs/session-format.md`. They live under the pi package directory that `SPINNER_PI` points into (`../lib/node_modules/@earendil-works/pi-coding-agent/docs`). Look for `pi.sendUserMessage`, the steer queue, and the events `agent_start`, `agent_end`, `turn_end`, `tool_execution_start`, `tool_execution_end`.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM engine: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn.
3. Tick only your own Plan items.
4. Put the contract (Plan item 1) under Contracts first and commit it. Then ping the operator through the supervisor channel. The ui agent waits on that commit.
5. Put questions for the operator under Open questions. Continue with other work while you wait.
6. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
7. Stage by path (`git add packages/daemon packages/pi-extension packages/protocol packages/cli docs`); never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.
9. E2e runs only against a scratch daemon with a scratch `SPINNER_HOME` and a free port. The operator's daemon on `:7777` is off limits.

## Engineering
1. The class `PiTtyHarness` lives in `packages/daemon/src/agents/tty-harness.ts`. The `node-pty` package spawns `pi` with the argument list the RPC harness builds. Share the builder. Do not copy it. Add the environment variable `SPINNER_HARNESS=tty`. Set `TERM=xterm-256color`. The size comes from the first client, or is 120×40.
2. The handle's `prompt` and `steer` resolve when the extension acknowledges the command on the long-poll. The `abort` call is a steer of pi's abort. The `commands` call reads what the extension posted at startup. The `stop` call sends SIGTERM, then SIGKILL after 5 s.
3. The extension does three things when `SPINNER_HARNESS=tty`. At startup it posts the commands list. It opens a long-poll on `GET /sessions/:dir/agents/:name/commands` (30 s, reopened at once) and acts on each command. It posts the listed pi events to `POST /sessions/:dir/agents/:name/events`. The payload is the event as it would be on the RPC stream. The manager's existing fold then runs unchanged.
4. The WebSocket route uses the `ws` package the daemon already has for the events stream. Binary frames carry bytes both ways. One text frame carries a resize. Attach replays the scrollback. Bound the scrollback at 64 KiB and the attachments at 8 per agent.
5. Reattach after a daemon restart. Record `pid` and `started` under `agents.<name>` in `session.yaml`. `started` is the process start time, as `pid-identity.ts` reads it. On daemon start, an agent with a live identity is adopted. The pty master is lost with the daemon, so adoption means: stop it cleanly and `resume`. Say so in the Log and in the docs. Do not try to keep a pty master across a daemon restart.
6. Test through the public behaviour. Run the harness against a fake `pi` script (a shell that echoes and reads the long-poll). Run the routes against the in-memory store. Add one e2e script under `packages/daemon/e2e/`. It runs the "Done when" e2e against a scratch daemon with the real pi.
7. Keep `PiRpcHarness` green; it is the headless path.
8. Start each commit message with `engine:`.

## Finish
1. Make `pnpm -r build`, the daemon and extension tests, root `pnpm lint` and `python3 tools/doc-metrics.py --fail` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line: what exists, and what you would change in the protocol.
