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
| `GET /health` | | `HealthResponse` | The home, the start time, the build and `ui_commit`, the UI snapshot served. |
| `GET /projects` | | `ProjectsResponse` | Every `spinner.yaml` the daemon can find. |
| `GET /sessions` | | `SessionsResponse` | Every session as the daemon sees it. |
| `GET /sessions/:dir` | | `SessionResponse` | 404 without the session. |
| `GET /sessions/:dir/mission` | | `text/markdown` | The raw `MISSION.md`. |
| `POST /sessions` | `NewSessionRequest` | `JobResponse` | With `title`: the job attaches the project. With `text` (chat first, below): the job attaches, adopts, starts the lead and sends it the text. |
| `POST /sessions/extract` | `ExtractRequest` | `ExtractResponse` | The PR references in a paste, resolved against the project and looked up. Synchronous; below. |
| `POST /sessions/adopt` | `AdoptRequest` | `JobResponse` | PRs opened outside Spinner. |
| `POST /reviews` | `ReviewsRequest` | `JobResponse` | One session of `kind: review` per PR reference in `text`; below. 409 without a reference. |
| `POST /sessions/:dir/adopt` | `SessionAdoptRequest` | `JobResponse` | PR references into an existing session; the lead's `adopt` tool. 409 without a project. |
| `PUT /sessions/:dir/title` | `SessionTitleRequest` | `SessionResponse` | `session.yaml` and the mission heading. Query `author`, default `operator`. |
| `GET /sessions/:dir/mission/view` | | `MissionViewResponse` | The structured mission; below. |
| `POST /sessions/:dir/attach` | `AttachRequest` | `JobResponse` | Worktrees on the PR branches. |
| `POST /sessions/:dir/up` | `UpRequest`, optional | `JobResponse` | `build: true` rebuilds the dev images. |
| `POST /sessions/:dir/down` | | `JobResponse` | Volumes and the database stay. |
| `POST /sessions/:dir/close` | | `JobResponse` | Containers, database, worktrees; the session is archived. |
| `POST /sessions/:dir/verify` | `VerifyRequest`, optional | `JobResponse` | The operator's local test. |
| `DELETE /sessions/:dir/verify` | | `SessionResponse` | Clears the tick. Synchronous; the new view answers. 404 without the session. |
| `POST /sessions/:dir/pr` | `PrRequest` | `JobResponse` | One PR per changed repo, as the operator. |
| `POST /sessions/:dir/fix` | `FixRequest` | `JobResponse` | Renders `threads/`, then starts or steers the fixer. |
| `POST /sessions/:dir/review` | `ReviewRequest`, optional | `JobResponse` | Starts the review swarm on each open PR; below. 409 without an open PR, without a worktree for it, or while a reviewer of it reads. |
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
| `PUT /sessions/:dir/mission/section` | `MissionSectionRequest` | `MissionSectionResponse` | The daemon serializes writes. The `item` mode is below. |
| `POST /sessions/:dir/inbox` | `InboxMessageRequest` | `InboxMessageResponse` | Writes the message and delivers it. |
| `GET /sessions/:dir/agents/default-brief` | | `DefaultBriefResponse` | Query `name`, `repo`, both optional. |
| `POST /sessions/:dir/agents` | `AddAgentRequest` | `AgentResponse` | 201. Model: the request, else the agent's last run, else `settings.default_model`, else `config.yaml`. Harness: `settings.agents.harness`, else `config.yaml`. |
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
| `PUT /sessions/:dir/agents/:name/brief` | `AgentBriefRequest` | `AgentBriefResponse` | Writes `agents/:name/BRIEF.md`, whole file, over an existing one. |
| `GET /operator` | | `OperatorResponse` | The operator agent; below. |
| `POST /operator/start` | | `OperatorResponse` | Starts or resumes the operator agent. 409 while it runs, 500 when pi fails to start. |
| `POST /operator/stop` | | `OperatorResponse` | 409 when it does not run. |
| `POST /operator/prompt` | `AgentMessageRequest` | `AgentCommandResponse` | 409 when it does not run. |
| `POST /operator/steer` | `AgentMessageRequest` | `AgentCommandResponse` | 409 when it does not run. |
| `POST /operator/hello` | `AgentHelloRequest` | `AgentCommandResponse` | Extension only. |
| `GET /operator/commands` | | `AgentCommandPollResponse` | Extension only; the long-poll. |
| `POST /operator/events` | `AgentEventsRequest` | `AgentCommandResponse` | Extension only; 202. |
| `GET /operator/tty` | | WebSocket | The operator agent's pty; the frames of the tty WebSocket below. 404 while stopped. |
| `POST /sessions/:dir/diff/start` | `DiffRepoRequest` | `JobResponse` | The job fetches the viewer on first use, then starts one viewer per repo (`repo` names one). 404 for an unknown repo. |
| `POST /sessions/:dir/diff/stop` | `DiffRepoRequest` | `SessionResponse` | Stops one viewer or every viewer; synchronous. |
| `POST /sessions/:dir/agents/:name/diff/comments` | `DiffCommentsRequest` | `DiffCommentsResponse` | Runs `diffview comments` in the agent's worktree. 404 for an agent without a repo, 409 before the fetch. |
| `GET /sessions/:dir/stack/logs/:service` | | `StackLogsResponse` | Query `lines`, 1 to 2000. |
| `GET /usage` | | `UsageResponse` | The machine and every up stack. |
| `GET /costs` | | `CostsResponse` | Spend by period, session, model and agent over a span of days. Query: `from`, `to`, `group`. |
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

## The diff tab

`SessionView.diff` describes the diff viewers of a session (MISSION.md s012). `fetch` is
`absent` before the first start, `fetching` while the job clones the viewer, `ready` once it
answers, `failed` with `fetch_error`. `available` is `fetch === "ready"`. `repos[<repo>]` has
one entry per repo of `session.yaml`: `state` (`stopped`, `starting`, `running`, `failed`),
`url` (`http://127.0.0.1:<port>/`, direct, never through the proxy), `pid`, `error` and
`waiting` (`agent` and `human` thread counts). The viewers are not a package dependency. The
first `POST /sessions/:dir/diff/start` clones `adamsanghera/diff-viewer` and
`adamsanghera/peanut` at the commits in `packages/daemon/src/diff/pins.ts` under
`<home>/diffview/src/` and runs `npm install` there, as the `diff` job, bounded at 5 minutes.
`<home>/diffview/` is also `DIFFVIEW_HOME`: the comment store and the viewer registry.

A viewer runs in the repo's worktree as a Spinner-managed host process: `session.yaml`
records it under `diff.repos.<repo>` with `pid`, `started`, `port` and `log`
(`diff/<repo>.log`). A port comes from the top of the session's host half, `base + 49`
downward. `down` and `close` stop the viewers; a daemon restart reattaches them by pid identity.

The daemon watches each viewer with `diffview comments wait` in 30 s rounds. A new thread
waiting on the agent is one `notify` to every running tty agent of the session, at most 2
per second. The notice has three lines. Line 1 is
`diff comment #<id> on <repo> <path>:<start>[-<end>] waits on you.`. Line 2 is
`<author>: <text>`, cut at 200 characters. Line 3 is
`Read it with diff_comments show <id>; answer with diff_reply.`. Each round also records the unresolved threads of both sides under
`diff.threads`; a thread waiting on the operator becomes `needs_human`
(`answer diff comment #<id> on <where>[ and <n> more]`) when the pipeline has nothing for them.

`DiffCommentsRequest` is `{ command, threads?, text? }` with `command` one of `list`, `show`,
`reply`, `suggest-resolve`. The daemon runs the CLI with `DIFFVIEW_AUTHOR=<agent>` and a 30 s
bound and answers `{ code, stdout, stderr }`; the CLI's exit code is in the body, not the
status. The worker role's `diff_comments` (`list`, `show`) and `diff_reply` (`reply`,
`suggest-resolve`) tools call this route. `spinner doctor` reports the fetch.

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

## Costs

pi writes the cost and the tokens of every turn into each agent's transcript
(`usage.cost.total` on an assistant message). The daemon adds them up and prices nothing
itself. The ledger folds `<home>/sessions/*/agents/*/pi/*.jsonl`, the same under
`<home>/archive/`, and `<home>/operator/pi/*.jsonl`. Each assistant message is one row. The
row holds `ts`, `session` (null for the operator agent), `agent`, `model` as
`provider/model`, `usd`, `tokens_in`, `tokens_out`, `cache_read` and `cache_write`. The rows are cached per file by size
and mtime, so a refold reads only the files that changed. The ledger refolds at start, on
every `agent.settled`, and every 60 s. The daemon writes no cost file; a closed session's
transcripts in the archive stay the record.

`SessionView.cost` is `SessionCost { usd, tokens_in, tokens_out, agents }`, where `agents`
maps each agent to `{ usd, tokens_in, tokens_out, model }` and `model` is that of its latest
message. `OperatorView.cost` is the same without `agents`. Token counts leave the cache
counts out.

`GET /costs?from=YYYY-MM-DD&to=YYYY-MM-DD&group=day|week|month` answers `CostsResponse`.
`from` and `to` are days in the daemon's local zone, both inclusive. `to` defaults to today
and `from` to 29 days before `to`; `group` defaults to `day`. A span over 366 days, `from`
after `to`, or a bad date or group is a 400. The response holds `total`, `by_period`, `by_session`, `by_model` and
`by_agent`. `by_period` lists `period`, `usd` and `tokens` for the periods with a row, oldest
first. `by_session` lists `dir`, `title`, `usd`, `tokens` and `last_active`, by cost,
highest first.
`period` is `YYYY-MM-DD` for a day, the Monday's `YYYY-MM-DD` for a week, `YYYY-MM` for a
month. `tokens` is `tokens_in + tokens_out`. The operator agent appears as `dir: "operator"`
with the title `Operator agent`.

A refold that changed a total publishes the bus event `costs { type, ts, session: null,
today, week, month, changed }`. The three totals are local-zone: today, the week from Monday,
and the calendar month, each up to now. `changed` holds the new `SessionCost` of each session
whose total moved. Each changed session also gets a `session.updated`.

## Settings

`~/.spinner/settings.yaml` holds the operator's preferences, which the UI and the desktop app
edit. The daemon's own configuration (`pi_bin`, `port`, `default_model`, `agents.harness`,
Slack) stays in `config.yaml`. The document is `Settings`:

| Key | Meaning |
|---|---|
| `theme` | `system`, `light`, `dark`, `rainbow`, or the name of a valid `~/.spinner/themes/<name>.json`. `system` follows the OS. |
| `default_model` | Optional. `provider/model` for an agent tab that names none. |
| `agents.harness` | Optional. `tty` or `rpc`. |
| `operator.enabled` | Optional, default false since s014. The daemon starts the operator agent at boot when true. |
| `operator.model` | Optional. `provider/model` for the operator agent; else `default_model`, else the daemon's default. |
| `review.models` | Optional. The swarm's models, `provider/model`; default `x-ai/grok-4.6`, `anthropic/claude-opus-5-5`, `openai/gpt-6-luna`. |
| `review.n` | Optional, 1 to 20. How many of `models` run, from the first; default 3. |
| `review.skill` | Optional. The review skill's directory, given to every reviewer with `--skill`; default `~/.pi/agent/skills/review-pr` when it exists. |

`GET /settings` answers `SettingsResponse { settings, path }`; without a file, `settings` is
`{ theme: "system" }`. `PUT /settings` takes the whole document as the body, validates it, and
writes the file. A problem is a 400 with the first reason. The reasons are an unknown key, a wrong
type, or a theme that is not built-in and not a valid user file. On success the daemon answers
`SettingsResponse` and publishes the bus event `settings { type, ts, session: null, settings }`.
A hand edit of the file shows on the next `GET`; the daemon does not watch it.

## Chat first: a session from a paste

Since s014 a session starts from one paste and one click. The compose box sends the paste to
`POST /sessions/extract { text, project? }`. The daemon finds every PR reference in the text.
The forms are a full GitHub PR URL in any form, `owner/repo#N`, `repo#N` and a bare `#N`.
In `repo#N`, `repo` is a project repo key or a GitHub repo name. A bare `#N` resolves
against the project's one repo. Each reference becomes
one `ExtractedPr`:

| Field | Meaning |
|---|---|
| `ref` | The reference as written. |
| `url`, `repo`, `number` | The canonical URL and the GitHub `owner/name`; null when the reference did not resolve. |
| `key` | The project's repo key, when the repo is one of the project's. |
| `title`, `branch`, `base` | From GitHub; null when the lookup failed. |
| `adoptable` | True when `POST /sessions` can make a worktree for it: the repo is in the project. |
| `reason` | Why it did not resolve, or is not adoptable: an ambiguous `#N`, a repo the project does not list, a failed lookup. |

Duplicates fold on `owner/name#number`. The lookups run in parallel under a 10 s bound; a
late one carries a reason. `rest` is the text with every reference removed. The project's
repo names and owners come from each clone's `origin`, else `pipeline.github.org`.

`POST /sessions { text, project?, adopt?: [url] }` creates the session at once, with a
provisional title (the first line of `rest`, else the first adopted PR's title). The job
`new` then attaches the project and adopts each `adopt` URL: a worktree on the PR's head
branch. It starts the agent `lead` in the lead role with the lead brief, in the one repo's
worktree when the project has one repo. It prompts the lead with the text, one `Adopted:`
line per worktree and one `Mentioned:` line per other reference. The lead owns the mission
from there: it sets the title, writes Goal, Done when and the Plan, ticks, logs, asks, and
adds agents. It never pushes, posts, approves, lands, resets or closes. The old body with
`title` alone still works for the CLI and the templates.

## The mission view

`GET /sessions/:dir/mission/view` answers `MissionViewResponse { view: MissionView }`, derived
from `MISSION.md` on every read; nothing is stored. The markdown file stays the source of
truth. `mission.changed` carries the same `view` after a tool write and after a hand edit.

| Field | Shape |
|---|---|
| `title` | From the `# id · title` line. |
| `goal` | The Goal body; the template's placeholder reads as empty. |
| `done_when[]` | `{ id, text, owner, state: open \| done, ticked_at }`; `id` is the position. |
| `plan[]` | `{ id, text, owner, state: next \| doing \| done, ticked_at }`; `id` is the number in the file. |
| `roster[]` | `{ agent, owns, doing, blocked, updated }`, the cells as written. |
| `contracts[]` | `{ id, ts, author, text }`; nested lines join the text. |
| `questions[]` | `{ id, author, text, answer }`; the indented lines under a question are the answer. |
| `log[]` | `{ ts, author, text }`, file order, oldest first. |

A Plan item is `doing` when it is unticked and its owner's Roster `Doing` names `#id` or
`item id`. An owner whose `Doing` is active (not `—`, empty or `done`) and names no item is
`doing` on its lowest unticked item.

The `item` mode of `PUT /sessions/:dir/mission/section` edits one item of `plan` or
`done_when`: `item: { command, id?, text?, owner?, order? }`. `add` appends `- [ ] N. text
(owner)` to the Plan (N is `max + 1`; the owner defaults to the author) or `- [ ] text` to
Done when. `tick` writes `[x]` and `(owner, HH:MM)` with the daemon's clock. `untick` drops
the time. `edit` replaces the text. `assign` sets the owner. `reorder` takes the ids in their
new order; unlisted items follow in their old order. Ids never change. A Plan line
written before s014 without a number gets one on the first write to the section. A 400
names the first problem. An unknown id is one.

## Reviews

A review (s015) is a session of `kind: review`: a place for a peer's PR. `POST /reviews
{ text }` runs the extractor over the paste and makes one session per PR, in one job
(action `reviews`). Full URLs and `owner/repo#N` resolve; there is no project, so a bare
`#N` does not. The
job's `session` is the first one; its log names each. For each PR the daemon clones the
repository once under `<home>/reviews/<owner>-<name>/` and fetches `refs/pull/<n>/head`.
It checks the PR head out detached under the session's `worktrees/<name>`, so nothing can
be pushed from it. The session has no project and no stack. `branch` and `base` are the PR's.
`repos.<name>.pr` holds the facts as an adopted PR's, so the poller, the board and the
threads track it. A reference GitHub does not know is skipped with the reason in the log; a
paste with no reference is a 409.

`SessionView.kind` is `review` for such a session and `session` otherwise.
`SessionView.review` (`ReviewFields`) carries the PR's `checks` with the `failing` check
names, the `review_decision` and the `threads` count (open and resolved). Its `swarm` is
one `SwarmMember { name, model, state, usd, pr }` per reviewer. `review.updated { data }` goes on
the bus whenever those fields change, right after the `session.updated` that carries them.
An ordinary session gets `review` too once its swarm ran, so its chips show. Every PR the
poller tracks carries `checks_failing`, the names of the red checks.

## The review step

`POST /sessions/:dir/review { pr? }` starts the review swarm in one job (action `review`).
It runs on each open or draft PR of the session, or on the one repo key `pr` names. The
swarm is one tty agent per model in `settings.review.models`, the first `n` of them. A
reviewer is named `review-<model-slug>`: the model id in lower case, one dash per run of
other characters. With several target PRs the name is `review-<repo>-<model-slug>`. Each reviewer starts in the PR repo's worktree with
`agents/<name>/BRIEF.md`, written once from the review brief. The brief is the prompt
`review-blast` gave its agents, with the PR and the model filled in. The reviewer reads the diff and the
code it hooks into, and posts inline comments only, each identified as
`**review-blast** · <model>`. It never approves, never requests changes and never pushes.
It prints `POSTED model=<model> blockers=N should-fix=M` last. The review skill goes in with
`--skill`: `settings.review.skill`, else `~/.pi/agent/skills/review-pr` when it exists.
`agents.<name>.skills` in `session.yaml` keeps the path, so a resumed reviewer loads it.

The states live in `session.yaml` under `review.swarm.<name>`. `queued` is a reviewer the
running-agents cap (24) holds back. `reading` is one that started. `posted` is one whose
settled turn ended with an assistant text that carries `POSTED model=`. `failed` is one
whose pi exited without that line. On `posted` the daemon stops the reviewer's pi, so the slot frees and the next
queued reviewer starts. The transcript stays, and the tab resumes it on request. One GitHub
poll follows a post, so the thread count moves at once. On daemon start, queued reviewers go
back in the queue and reading ones without a process are failed.

A review holds no session lock: it runs beside another job on the session. The route is a
409 for a session without an open PR, for a PR whose repo has no worktree, and while a
reviewer of that PR still reads. A second `review` after the swarm settled runs it again.

## The operator agent

One per home, outside every session ([ARCHITECTURE.md](ARCHITECTURE.md#the-operator-agent-packagesdaemonsrcagentsoperatorts)).
`GET /operator` answers `OperatorResponse { operator: OperatorView }`:

| Field | Meaning |
|---|---|
| `enabled` | `settings.operator.enabled`. |
| `process` | `idle` (pi runs and waits), `running` (a turn is in progress), `exited` (no process). |
| `ready` | True once the extension inside pi posted `hello`; a prompt or a notice reaches it. |
| `pid`, `model` | The process and its `provider/model`; null when stopped or on pi's default. |
| `dir` | `<home>/operator`: the transcript (`pi/`), `BRIEF.md`, `process.json`. |
| `waiting_on` | `operator` when idle, `model` while a turn runs, `start` when stopped. |
| `last_notice` | The last `{ ts, text }` the daemon delivered, or null. |
| `notices_pending` | Lines batched or held (the agent is stopped) and not yet delivered. |

The bus event `operator.updated { type, ts, session: null, data: OperatorView }` follows every
change. A change is a start, a stop, an exit, `hello`, a turn's start or end, or a delivered
notice. The agent's own routes (`/operator/start|stop|prompt|steer|tty`) and the extension's
(`/operator/hello|commands|events`) take the same bodies and frames as a session agent's.

A notice is one `notify` command through the extension channel. The daemon batches the events
of one second into one notice, one line per event. Each line is `<session dir>: <fact>`. The
facts are:

| Event | Line |
|---|---|
| `session.updated` where `needs_human` goes from null to text | `needs a human: <text>` |
| `agent.settled` | `agent <name> settled` |
| `agent.exited` | `agent <name> exited (code N)` |
| `job.finished` with `ok: false` | `job <action> failed: <error>` |
| `inbox.message` to `operator` | `message from <agent> (inbox/<file>): <subject>` |

The queue holds 100 lines. Past that the oldest go, and the notice ends with `(N older notices
dropped)`. Lines wait while the agent is stopped and go out on the next start.

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
`started` (the start time as `ps -o lstart=` prints it) and `repo`. `skills` lists the
directories pi loads with `--skill` beyond the session's `skills/` (a reviewer's skill). On
daemon start the manager uses `pid` and `started` to stop a pi the previous daemon left, then
resumes each `tty` agent on its transcript.

## Configuration

`config.yaml` `agents.harness: tty | rpc` (default `tty`), overridden by
`SPINNER_AGENTS_HARNESS`. `settings.yaml` `agents.harness` wins over both when set, and
`settings.default_model` wins over `config.yaml` `default_model`; the manager reads the
settings file on every `add`. `tty` needs the Spinner extension; the daemon refuses a tty
spawn without it.

## The UI snapshot

At start the daemon copies `packages/ui/dist` (or `SPINNER_UI_DIR`) to `<home>/ui/<commit>/`
when that snapshot is absent, removes the snapshots of other commits, and serves `GET /` from
the copy. `<commit>` is the checkout's short commit, or `unversioned` outside git. A rebuild
of `dist` does not change a running daemon's UI; a restart takes the new build. `GET /health`
names the snapshot in `ui_commit`, null when no UI is served.
