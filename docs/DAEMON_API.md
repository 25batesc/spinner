# spinnerd API

The daemon listens on `http://localhost:7777`. The REST routes are the keys of `ROUTES` in
`packages/protocol/src/api.ts`; each value names the response type next to it. This page
documents the two WebSockets and the routes the Spinner pi extension calls, because those
are not plain request and response pairs.

## Events WebSocket

`GET /events` upgrades to a WebSocket. Each message is one `SpinnerEvent` as JSON
(`packages/protocol/src/events.ts`). The daemon accepts any `Origin`; it listens on loopback
only.

## tty WebSocket

`GET /sessions/:dir/agents/:name/tty` upgrades to a WebSocket on the agent's pseudo-terminal.
`tty_path(dir, name)` in the protocol package builds the path. Only an agent on the `tty`
harness has one.

Before the upgrade, a problem is plain HTTP:

| Status | Reason |
|---|---|
| 404 | No session `:dir`, no agent `:name`, or the agent is not running. |
| 409 | The agent runs on the `rpc` harness, or `TTY_ATTACHMENTS_MAX` (8) clients hold the pty. |

After the upgrade:

| Direction | Frame | Meaning |
|---|---|---|
| daemon → client | binary, first | The scrollback: 0 to `TTY_SCROLLBACK_BYTES` (65536) raw pty bytes. It can start mid-escape. |
| daemon → client | binary | One chunk of pty output. |
| daemon → client | text `{"exit":{"code":n}}` | pi exited; `code` is null on a signal. Close 1000 follows. |
| client → daemon | binary | Keystrokes, written to the pty unchanged. Bound 1 MiB per frame (close 1009 beyond). |
| client → daemon | text `{"resize":{"cols":n,"rows":n}}` | Resize the pty. Both in 1 to `TTY_DIMENSION_MAX` (1000). Any other text frame closes with 1008. |

One pty serves every attachment. The pty's size is the last resize from any client; before
the first resize it is `TTY_SIZE_DEFAULT` (120×40). `POST .../stop` sends the `exit` frame
to every client, then closes each with 1000.

The daemon never writes to the pty on the operator's behalf. A `prompt` or a `steer` goes
through the extension (next section), so pi's transcript records a message, not keystrokes.

## Extension routes (tty harness)

The Spinner pi extension runs inside pi. Under `SPINNER_HARNESS=tty` it is the daemon's only
channel into the interactive pi, over three routes. Each answers 404 while the daemon does
not host the agent (for example during a daemon restart); the extension retries after 1 s.

### `POST /sessions/:dir/agents/:name/hello`

Body `AgentHelloRequest`: `{ "pid": n, "commands": SlashCommandInfo[] }`. The extension
posts it at `session_start`, so once at pi's start and again after `/spinner-reload`.
`commands` is `pi.getCommands()`; the Context tab shows it. Answer: 200 `{ "ok": true }`.

### `GET /sessions/:dir/agents/:name/commands`

The long-poll. The daemon holds the request up to 30 s, then answers:

- 200 `{ "command": { "id": "c-1", "type": "prompt" | "steer" | "abort", "text": "..." } }`,
  one command per response; `text` is absent for `abort`.
- 204 when no command arrived in time. The extension reopens the poll at once.

Query `ack=<id>&disposition=<text>` on a poll acknowledges the command the extension just
acted on. The `POST .../prompt` or `POST .../steer` that queued the command resolves with
that disposition: `started` when pi was idle, `queued` when a turn was running. Without an
ack in 30 s the route answers 504. The extension acts as follows:

| Command | pi call | Disposition |
|---|---|---|
| `prompt`, pi idle | `pi.sendUserMessage(text)` | `started` |
| `prompt`, pi busy | `pi.sendUserMessage(text, { deliverAs: "followUp" })` | `queued` |
| `steer` | `pi.sendUserMessage(text, { deliverAs: "steer" })` | `started` or `queued` |
| `abort` | `ctx.abort()` | `aborted` |

### `POST /sessions/:dir/agents/:name/events`

Body `AgentEventsRequest`: `{ "events": PiEvent[] }`, bound 8 MiB. The extension posts
`agent_start`, `agent_end`, `agent_settled`, `turn_end`, `tool_execution_start` and
`tool_execution_end`, each with the fields pi hands the extension, batched. The daemon's
fold is the one the RPC harness uses: `agent.event` on the bus per event, `process: running`
on `agent_start`, `agent.settled` and `process: idle` on `agent_settled`. Answer: 202.

## Agent records in `session.yaml`

`agents.<name>` holds `harness`, `model` and `process`. `harness` is `tty` or `rpc`; `pi`
in files before s009 reads as `rpc`. While the process runs the record also holds `pid`,
`started` (the start time as `ps -o lstart=` prints it) and `repo`. On daemon start the manager uses `pid` and `started`
to stop a pi the previous daemon left, then resumes each `tty` agent on its transcript.

## Configuration

`config.yaml` `agents.harness: tty | rpc` (default `tty`), overridden by
`SPINNER_AGENTS_HARNESS`. `tty` needs the Spinner extension; the daemon refuses a tty spawn
without it.
