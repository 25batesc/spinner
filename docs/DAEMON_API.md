# spinnerd API

The daemon listens on `http://localhost:7777`. The REST routes are the keys of `ROUTES` in
`packages/protocol/src/api.ts`; each value names the response type next to it. The table
below lists every route with its body and response type from `@spinner/protocol`. The later
sections document the two WebSockets and the routes the Spinner pi extension calls, because
those are not plain request and response pairs.

## Routes

A request body is JSON. A route without a body takes none. A `JobResponse` names a job; its
progress arrives as `job.*` events and `GET /jobs/:id`. An error is `{ "error": string }`
with a 4xx or 5xx status. The daemon also serves the web UI at `GET /` and the two
WebSockets below.

| Route | Body | Response | Notes |
|---|---|---|---|
| `GET /health` | | `HealthResponse` | The home, the start time and the build. |
| `GET /projects` | | `ProjectsResponse` | Every `spinner.yaml` the daemon can find. |
| `GET /sessions` | | `SessionsResponse` | Every session as the daemon sees it. |
| `GET /sessions/:dir` | | `SessionResponse` | 404 without the session. |
| `GET /sessions/:dir/mission` | | `text/markdown` | The raw `MISSION.md`. |
| `POST /sessions` | `NewSessionRequest` | `JobResponse` | The job creates the session and attaches the project. |
| `POST /sessions/adopt` | `AdoptRequest` | `JobResponse` | PRs opened outside Spinner. |
| `POST /sessions/:dir/attach` | `AttachRequest` | `JobResponse` | Worktrees on the PR branches. |
| `POST /sessions/:dir/up` | `UpRequest`, optional | `JobResponse` | `build: true` rebuilds the dev images. |
| `POST /sessions/:dir/down` | | `JobResponse` | Volumes and the database stay. |
| `POST /sessions/:dir/close` | | `JobResponse` | Containers, database, worktrees; the session is archived. |
| `POST /sessions/:dir/verify` | `VerifyRequest`, optional | `JobResponse` | The operator's local test. |
| `POST /sessions/:dir/pr` | `PrRequest` | `JobResponse` | One PR per changed repo, as the operator. |
| `POST /sessions/:dir/fix` | `FixRequest` | `JobResponse` | Renders `threads/`, then starts or steers the fixer. |
| `GET /sessions/:dir/threads` | | `ThreadsResponse` | From the last render. |
| `POST /sessions/:dir/threads/refresh` | | `ThreadsResponse` | Re-renders from GitHub now. |
| `POST /sessions/:dir/threads/:id/reply` | `ThreadReplyRequest` | `ThreadResponse` | As the operator. |
| `POST /sessions/:dir/threads/:id/resolve` | | `ThreadResponse` | 409 without a reply, or for a human thread when `resolve_human` is off. |
| `POST /sessions/:dir/threads/:id/flag` | `ThreadFlagRequest` | `ThreadResponse` | Flags the thread for the operator. |
| `GET /sessions/:dir/post` | | `PostResponse` | The composed Slack message. |
| `POST /sessions/:dir/post` | `PostRequest` | `JobResponse` | `confirm: true` or 400. |
| `GET /sessions/:dir/approve` | | `ApproveResponse` | Head, diff stat and open threads per PR. |
| `POST /sessions/:dir/approve` | `ApproveRequest` | `JobResponse` | `confirm: true` or 400. |
| `POST /sessions/:dir/land` | `LandRequest`, optional | `JobResponse` | Enqueue, watch, rebase and re-enqueue on a pop-out. |
| `POST /sessions/:dir/reset` | `ResetRequest`, optional | `JobResponse` | The next round. |
| `PUT /sessions/:dir/mission/section` | `MissionSectionRequest` | `MissionSectionResponse` | The daemon serializes writes. |
| `POST /sessions/:dir/inbox` | `InboxMessageRequest` | `InboxMessageResponse` | Writes the message and delivers it. |
| `GET /sessions/:dir/agents/default-brief` | | `DefaultBriefResponse` | Query `name`, `repo`, both optional. |
| `POST /sessions/:dir/agents` | `AddAgentRequest` | `AgentResponse` | 201; the harness comes from `config.yaml`. |
| `POST /sessions/:dir/agents/:name/prompt` | `AgentMessageRequest` | `AgentCommandResponse` | 409 with the state for a stopped agent. |
| `POST /sessions/:dir/agents/:name/steer` | `AgentMessageRequest` | `AgentCommandResponse` | Enters after the current turn. |
| `POST /sessions/:dir/agents/:name/abort` | | `AgentCommandResponse` | |
| `POST /sessions/:dir/agents/:name/stop` | | `AgentCommandResponse` | The transcript stays. |
| `GET /sessions/:dir/agents/:name/events` | | `AgentEventsResponse` | The past turns, for a tab that loads late. |
| `GET /sessions/:dir/agents/:name/context` | | `ContextResponse` | The context chain and the loaded commands. |
| `PUT /sessions/:dir/agents/:name/context` | `ContextFileRequest` | `ContextFileResponse` | Writes one file of the chain. |
| `POST /sessions/:dir/agents/:name/hello` | `AgentHelloRequest` | `AgentCommandResponse` | Extension only; below. |
| `GET /sessions/:dir/agents/:name/commands` | | `AgentCommandPollResponse` | Extension only; the long-poll below. |
| `POST /sessions/:dir/agents/:name/events` | `AgentEventsRequest` | `AgentCommandResponse` | Extension only; 202. |
| `GET /sessions/:dir/agents/:name/tty` | | WebSocket | Below. |
| `GET /sessions/:dir/stack/logs/:service` | | `StackLogsResponse` | Query `lines`, 1 to 2000. |
| `GET /usage` | | `UsageResponse` | The machine and every up stack. |
| `GET /settings` | | `SettingsResponse` | Defaults when the file is absent. |
| `PUT /settings` | `Settings` | `SettingsResponse` | The whole document; 400 names the first problem. |
| `GET /themes` | | `ThemesResponse` | Built-ins and user palettes. |
| `GET /models` | | `ModelsResponse` | The models pi can run. |
| `GET /jobs` | | `JobsResponse` | Running jobs and the last finished ones. |
| `GET /jobs/:id` | | `JobResponse` | 404 when the daemon never ran it. |

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

- 200 `{ "command": { "id": "c-1", "type": "prompt" | "steer" | "abort" | "notify", "text": "..." } }`,
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
| `notify`, pi idle | `pi.sendMessage({ customType: "spinner_notice", content, display: true }, { triggerTurn: true })` | `started` |
| `notify`, pi busy | `pi.sendMessage(..., { deliverAs: "steer" })` | `queued` |

### `POST /sessions/:dir/agents/:name/events`

Body `AgentEventsRequest`: `{ "events": PiEvent[] }`, bound 8 MiB. The extension posts
`agent_start`, `agent_end`, `agent_settled`, `turn_end`, `tool_execution_start` and
`tool_execution_end`, each with the fields pi hands the extension, batched. The daemon's
fold is the one the RPC harness uses: `agent.event` on the bus per event, `process: running`
on `agent_start`, `agent.settled` and `process: idle` on `agent_settled`. Answer: 202.

## Stack jobs: `stack.last_job` and the notice to the agent

When an `up`, `down` or `reset` job ends, the daemon writes `stack.last_job` into
`session.yaml`. The record holds `action`, `state` (`ok` or `failed`), `error` (the job's
error message, or null), `finished` (ISO 8601) and `tail` (the last 40 log lines). `GET /sessions/:dir`
carries it as `stack.last_job`, null before the first job. The extension's `stack show` prints
the error and the tail under the service list when the state is `failed`.

When the job failed and the session has a running `tty` agent, the daemon also sends one
`notify` command through the extension channel (next section). The text holds the first
error line, the tail in a code fence, and a pointer to the `stack` tool. The extension delivers it as a custom
message (`customType: spinner_notice`). The message starts a turn when pi is idle and steers
the running one when it is busy. One notice per failed job; every running tty agent of the session
receives it. An `rpc` agent receives none.

## Stack logs

`GET /sessions/:dir/stack/logs/:service?lines=N` answers `StackLogsResponse`:
`{ "service", "where": "host" | "container", "lines": string[] }`, oldest first. `lines` is 1
to 2000, default 100. A host service's lines come from its file under the session's `log/`. A
container's lines come from `docker compose logs --tail N`. The route answers 404 when the
session has no such service and no log file for it. It answers 400 for a bad `lines` or
service name, and 502 when docker fails.
The extension's `stack logs` calls this route; `spinner logs` keeps its attached `tail -f`.

## Resource usage

A sampler runs every 5 s (`USAGE_INTERVAL_MS`) while at least one stack is up or starting,
one sample in flight at a time. It stops when no stack is up and starts again after a job or
a stack change. Each sample runs three commands. `docker ps` with the compose labels maps containers
to a session and a service. `docker stats --no-stream` reads every container. `ps -axo
pid,ppid,rss,%cpu` lists every process. A host service's numbers are the sum over its
process tree: the pid in `stack/pids/<name>.pid` and every descendant. The sample lives in the
daemon's memory; nothing is written to `session.yaml`.

`ServiceUsage` fields:

| Field | Meaning |
|---|---|
| `cpu_pct` | A percentage of one core, as docker and ps report it; 200 means two cores busy. |
| `mem_bytes` | A container's memory usage, or the sum of RSS over a host service's tree. |
| `mem_limit_bytes` | Containers only. The limit docker prints: the container's own, or the engine's memory for a container without one. |
| `net_rx_bytes`, `net_tx_bytes` | Containers only. Network totals since the container started. |
| `block_read_bytes`, `block_write_bytes` | Containers only. Block I/O totals since the container started. |
| `container` | Containers only. The container id. |
| `pid` | Host services only. The root of the process tree. |
 Host services carry `pid` (the root of the tree). A service without a
sample (a container not yet started, a host process that is gone) has no entry.

`StackUsage { cpu_pct, mem_bytes, sampled }` is the sum over a stack's services and the ISO
8601 time of the sample. `SessionUsage { stack, services }` is one session's sample.

Where the numbers appear:

| Surface | Shape |
|---|---|
| `GET /sessions/:dir`, `GET /sessions` | `stack.usage: StackUsage \| null`, `stack.services[].usage: ServiceUsage \| null`; null when the stack is down or not sampled yet. |
| `GET /usage` | `UsageResponse { machine, sessions: { [dir]: SessionUsage }, sampled }`; `sampled` is null before the first sample. |
| Bus event `usage` | `{ type: "usage", ts, session: null, machine, sessions: { [dir]: SessionUsage } }`, once per sample; none while no stack is up. |

`MachineUsage { mem_total_bytes, mem_free_bytes, cpu_count, load_1m, stacks_up, mem_sessions_bytes }`
comes from `os`, with one exception. `mem_free_bytes` is the memory *available* to new work,
not only the "free" pages. On macOS it is free + inactive + speculative pages from `vm_stat`,
at the page size its header prints. On linux it is `MemAvailable` from `/proc/meminfo`.
Where neither is readable it is `os.freemem()`. `os.freemem()` alone reported 1.4 GB of 52 GB on a
Mac with 17 GB reclaimable. The other fields are total memory, the cpu count, and the 1-minute
load average. `stacks_up` counts the sampled stacks and `mem_sessions_bytes` sums their
`mem_bytes`.

## Settings

`~/.spinner/settings.yaml` holds the operator's preferences, which the UI and the desktop app
edit. The daemon's own configuration (`pi_bin`, `port`, `default_model`, `agents.harness`,
Slack) stays in `config.yaml`. The document is `Settings`:

| Key | Meaning |
|---|---|
| `theme` | `system`, `light`, `dark`, `rainbow`, or the name of a valid `~/.spinner/themes/<name>.json`. `system` follows the OS. |
| `default_model` | Optional. `provider/model` for an agent tab that names none. |
| `agents.harness` | Optional. `tty` or `rpc`. |

`GET /settings` answers `SettingsResponse { settings, path }`; without a file, `settings` is
`{ theme: "system" }`. `PUT /settings` takes the whole document as the body, validates it, and
writes the file. A problem is a 400 with the first reason. The reasons are an unknown key, a wrong
type, or a theme that is not built-in and not a valid user file. On success the daemon answers
`SettingsResponse` and publishes the bus event `settings { type, ts, session: null, settings }`.
A hand edit of the file shows on the next `GET`; the daemon does not watch it.

## Themes

A theme is one `ThemePalette`. The UI colours are `bg`, `surface`, `border`, `text`, `muted`,
`accent`, `ok`, `warn`, `fail` and `link`. The `terminal` block has `foreground`,
`background`, `cursor` and the 16 ANSI colours (`black` … `white`, `bright_black` …
`bright_white`). Every value is a CSS colour string. The built-ins `light`, `dark` and `rainbow`
are the JSON files under `packages/protocol/src/themes/`, exported as `BUILTIN_THEMES`. The web UI
and the desktop app share that one definition. The operator adds `~/.spinner/themes/<name>.json`;
the name must match `[a-z0-9][a-z0-9_-]{0,63}`.

`GET /themes` answers `ThemesResponse { themes, invalid }`. `themes` lists the built-ins first,
then every valid user file by name, each as `{ name, source: "builtin" | "user", palette }`.
`invalid` names each user file that did not validate: `{ name, path, missing, reason }`, where
`missing` lists the absent keys (as `terminal.red` for the terminal block). A file that shadows
a built-in name, does not parse, or has a bad name is `invalid` too, with `missing` empty. An
invalid theme is not under `themes` and `PUT /settings` refuses it. `validate_palette` in the
protocol package is the same check, for a UI preview.

## Agent records in `session.yaml`

`agents.<name>` holds `harness`, `model` and `process`. `harness` is `tty` or `rpc`; `pi`
in files before s009 reads as `rpc`. While the process runs the record also holds `pid`,
`started` (the start time as `ps -o lstart=` prints it) and `repo`. On daemon start the manager uses `pid` and `started`
to stop a pi the previous daemon left, then resumes each `tty` agent on its transcript.

## Configuration

`config.yaml` `agents.harness: tty | rpc` (default `tty`), overridden by
`SPINNER_AGENTS_HARNESS`. `tty` needs the Spinner extension; the daemon refuses a tty spawn
without it.
