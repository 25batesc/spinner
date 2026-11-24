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
| `POST /sessions` | `NewSessionRequest` | `JobResponse` | With `title`: the job attaches the project. With `text` (chat first, below): the job attaches, adopts, starts the lead and sends it the text. `track: design` asks for the EGM design track; absent means `direct`, the fast path. `design` falls back to `direct` when EGM is not ready or a pull request is adopted. |
| `POST /sessions/extract` | `ExtractRequest` | `ExtractResponse` | The PR references in a paste, resolved against the project and looked up. Synchronous; below. |
| `POST /sessions/adopt` | `AdoptRequest` | `JobResponse` | PRs opened outside Spinner. |
| `POST /reviews` | `ReviewsRequest` | `JobResponse` | One session of `kind: review` per PR reference in `text`, with its `lead` and its swarm started; below. 409 without a reference. |
| `POST /sessions/:dir/adopt` | `SessionAdoptRequest` | `JobResponse` | PR references into an existing session; the lead's `adopt` tool. 409 without a project. |
| `PUT /sessions/:dir/title` | `SessionTitleRequest` | `SessionResponse` | `session.yaml` and the mission heading. Query `author`, default `operator`. The operator's `title` pins it (`title_pinned`), `{ pinned: false }` unpins; an agent's write is a 409 while pinned and a 400 with `pinned`. A changed title writes the Log line `title: <new> (was <old>)` by its author. |
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
| `GET /sessions/:dir/review/briefing` | | `text/markdown` | The lead's briefing, `artifacts/briefing.md`. 404 before it exists. |
| `PUT /sessions/:dir/review/briefing` | `ReviewBriefingRequest` | `OkResponse` | The lead's `review_briefing` tool writes the briefing. 400 when `markdown` is empty. |
| `PUT /sessions/:dir/review/draft` | `ReviewDraft` | `ReviewDraftResponse` | The lead's `review_draft` tool and the operator's edits; validated against the PR diff, below. 400 with every fault; 409 without a PR. |
| `DELETE /sessions/:dir/review/draft` | | `OkResponse` | Drops the draft. 404 without one. |
| `POST /sessions/:dir/review/post` | | `ReviewPostResponse` | Posts the draft as one PR review through the operator's `gh`; below. 409 without a draft; 502 when GitHub refuses. |
| `POST /sessions/:dir/review/approve` | | `ReviewPostResponse` | Posts one APPROVE review with the body "LGTM", no swarm and no draft; below. 409 without a PR; 502 when GitHub refuses. |
| `POST /sessions/:dir/review/cancel` | | `ReviewCancelResponse` | Stops a running review: the swarm, a review session's lead, the verdict files; below. 409 without a review. |
| `GET /sessions/:dir/threads` | | `ThreadsResponse` | From the last render. |
| `POST /sessions/:dir/threads/refresh` | | `ThreadsResponse` | Re-renders from GitHub now. |
| `POST /sessions/:dir/threads/:id/reply` | `ThreadReplyRequest` | `ThreadResponse` | As the operator. |
| `POST /sessions/:dir/threads/:id/resolve` | | `ThreadResponse` | 409 without a reply, or for a human thread when `resolve_human` is off. |
| `POST /sessions/:dir/threads/:id/flag` | `ThreadFlagRequest` | `ThreadResponse` | Flags the thread for the operator. |
| `POST /sessions/:dir/attachments` | `AttachmentRequest` | `AttachmentResponse` | 201. Saves a PNG as `artifacts/comments/<name>`. 400 for a bad body, 413 past `ATTACHMENT_BYTES_MAX` (8 MiB decoded). Preview comments, below. |
| `POST /sessions/:dir/uploads` | `UploadRequest` | `UploadResponse` | 201. `{ "name", "data": <base64> }`, any file up to `UPLOAD_BYTES_MAX` (10 MiB decoded). Saves it as `artifacts/uploads/<YYYYMMDD-HHMMSS>-<6 hex>-<safe name>`: the last path part of `name`, each run of characters outside `A-Za-z0-9_-` turned into `-`, the extension kept. Answers `name` and `path` relative to the session directory. 400 for a bad body, 413 past the bound. |
| `GET /sessions/:dir/attachments/:name` | | `image/png` | One saved attachment. 404 for a bad or unknown name. |
| `GET /sessions/:dir/comments` | | `CommentsResponse` | Every preview comment, newest first. |
| `POST /sessions/:dir/comments` | `NewCommentRequest` | `CommentResponse` | 201. Writes the comment and delivers it to the agent with the screenshot as an image; below. 400 for a bad body or a `doc` anchor, 404 for an agent the session does not list, 409 past `COMMENTS_MAX` (500). |
| `POST /sessions/:dir/comments/:id/reply` | `CommentReplyRequest` | `CommentResponse` | The operator's reply goes to the agent; an agent's reply (`author`) waits on the operator. 409 on a resolved comment or past `COMMENT_MESSAGES_MAX` (100). |
| `POST /sessions/:dir/comments/:id/suggest-resolve` | `CommentReplyRequest` | `CommentResponse` | The agent's suggestion; state `suggested`. 400 with `author: operator`. |
| `POST /sessions/:dir/comments/:id/resolve` | | `CommentResponse` | The operator resolves. A resolved comment answers unchanged. |
| `GET /sessions/:dir/files` | | `SessionFilesResponse` | The tree of the session directory; below. |
| `GET /sessions/:dir/files/text?path=` | | `SessionFileResponse` | A text file. 400 for a path the tree does not list, 404 when absent, 413 past 2 MiB, 415 for a binary file. |
| `PUT /sessions/:dir/files/text` | `SessionFileSaveRequest` | `SessionFileResponse` | The operator's edit. 409 when the file changed since `mtime`, and for `session.yaml` and `MISSION.md`. |
| `GET /sessions/:dir/files/raw?path=` | | bytes | An image inline; any other file as a download. |
| `POST /sessions/:dir/files/reveal` | `SessionFileActionRequest` | `OkResponse` | Shows the file, or the session directory for `""`, in the file manager. |
| `POST /sessions/:dir/files/download` | `SessionFileActionRequest` | `SessionFileDownloadResponse` | 201. Copies the file to the operator's Downloads folder; never overwrites. |
| `GET /sessions/:dir/post` | | `PostResponse` | The composed Slack message. |
| `POST /sessions/:dir/post` | `PostRequest` | `JobResponse` | `confirm: true` or 400. |
| `GET /sessions/:dir/approve` | | `ApproveResponse` | Head, diff stat and open threads per PR. |
| `POST /sessions/:dir/approve` | `ApproveRequest` | `JobResponse` | `confirm: true` or 400. |
| `POST /sessions/:dir/land` | `LandRequest`, optional | `JobResponse` | Enqueue, watch, rebase and re-enqueue on a pop-out. |
| `POST /sessions/:dir/reset` | `ResetRequest`, optional | `JobResponse` | The next round. Kept for one release; a new change replaces it. |
| `POST /sessions/:dir/changes` | `ChangeStartRequest` | `JobResponse` | Start a change: a new branch in every worktree. |
| `POST /sessions/:dir/changes/:id/switch` | none | `JobResponse` | Check out the branch of change `:id` in every worktree. |
| `PUT /sessions/:dir/mission/section` | `MissionSectionRequest` | `MissionSectionResponse` | The daemon serializes writes. The `item` mode is below. |
| `POST /sessions/:dir/inbox` | `InboxMessageRequest` | `InboxMessageResponse` | Writes the message and delivers it. |
| `GET /sessions/:dir/agents/default-brief` | | `DefaultBriefResponse` | Query `name`, `repo`, both optional. |
| `POST /sessions/:dir/agents` | `AddAgentRequest` | `AgentResponse` | 201. Model: the request, else the agent's last run, else `settings.default_model`, else `config.yaml`. Harness: `settings.agents.harness`, else `config.yaml`. First turn: a new agent gets `message`, else the go signal (read the mission and the brief, take your Plan items, start); a listed agent (a resume) gets `message` or nothing. `first_turn` answers pi's disposition, `queued` when pi refused it (it goes with the next prompt), or `none`. |
| `POST /sessions/:dir/agents/:name/prompt` | `AgentMessageRequest` | `AgentCommandResponse` | 409 with the state for a stopped agent. `images`, at most `MESSAGE_IMAGES_MAX` (8): paths relative to the session directory, each an existing PNG under `artifacts/` (links resolved), sent to pi as images; 400 for any other. The same for `steer`. |
| `POST /sessions/:dir/agents/:name/steer` | `AgentMessageRequest` | `AgentCommandResponse` | Enters after the current turn. A steer to `lead` with `source: "operator"` adds 1 to `outcomes.operator_steers`; below. |
| `POST /sessions/:dir/agents/:name/abort` | | `AgentCommandResponse` | |
| `POST /sessions/:dir/agents/:name/stop` | | `AgentCommandResponse` | The transcript stays. |
| `POST /sessions/:dir/agents/:name/compact` | | `AgentCommandResponse` | Starts pi's compaction and answers `started` at once; writes the `spinner` Log line `compacted <agent> at NN %`. 409 with the process state for a listed agent that is not running. |
| `POST /sessions/:dir/agents/:name/model` | `AgentModelRequest` | `OkResponse` | `{ "model": "provider/id" }`. 200 once pi took the model; then `agents.<name>.model` holds it and `session.updated` follows. 400 with pi's error when pi does not know the model or has no key for it, or when `model` is not `provider/id`; 404 for an unknown session or agent; 409 with `AgentNotRunningResponse` when it is not running. A tty agent gets `set_model` through its extension, an rpc agent pi's `set_model`. |
| `POST /sessions/:dir/agents/:name/thinking` | `AgentThinkingRequest` | `OkResponse` | `{ "level": ThinkingLevel }`, one of `THINKING_LEVELS` (`off minimal low medium high xhigh max`), else 400. Records `agents.<name>.thinking`; the other answers as `model`. pi clamps the level to the model; a tty agent's extension then reports the clamped one. |
| `GET /sessions/:dir/agents/:name/events` | | `AgentEventsResponse` | The past turns, for a tab that loads late. |
| `GET /sessions/:dir/agents/:name/context` | | `ContextResponse` | The context chain and the loaded commands. |
| `PUT /sessions/:dir/agents/:name/context` | `ContextFileRequest` | `ContextFileResponse` | Writes one file of the chain. |
| `PUT /sessions/:dir/agents/:name/brief` | `AgentBriefRequest` | `AgentBriefResponse` | Writes `agents/:name/BRIEF.md`, whole file, over an existing one. |
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
| `POST /poll` | | `PollResponse` | Reads every session's pull requests from GitHub now; the poller does it every 60 s (`SPINNER_POLL_SECONDS`). Answers `{ ok, at }` when the round ended; a call during a round waits for that round. 503 without a poller. The PR view's `refresh` calls it. |
| `GET /egm` | | `EgmResponse` | The EGM fetch state and the pin; below. |
| `POST /egm/fetch` | | `JobResponse` | The `egm` job: fetches EGM again at the pin and regenerates the adapter; below. |
| `GET /sessions/:dir/rounds/:round/log` | | `text/markdown` | The Log of an earlier round from `## Previous rounds`. 400 unless `:round` is an integer from 1 to 200, 404 for a round without one. |
| `GET /sessions/:dir/egm/goldfish/:run/:step/events` | | `AgentEventsResponse` | The transcript events of one subagent step of the lead; below. 404 for an unknown run or step, or a transcript outside `<session>/agents/`. |

## Events WebSocket

`GET /events` upgrades to a WebSocket. Each message is one `SpinnerEvent` as JSON
(`packages/protocol/src/events.ts`). The daemon accepts any `Origin`; it listens on loopback
only.

The desktop app's main process opens its socket as `GET /events?client=desktop`. The daemon
counts the open sockets that carry this query; the UI's socket does not carry it. Every local
notification (a pipeline transition from the poller, a PR merged by `land`) is a `notify`
event: `{ type: "notify", ts, session, title, message }`. `session` is the session directory,
or null when the notification names no session. `message` is at most 200 characters. While
the count is 0, the daemon also shows the banner itself through `osascript`. While the count
is 1 or more, it sends the event only, and the app posts the banner under Spinner's name; a
click on it opens the session in the app. With `SPINNER_NOTIFY=off`, the daemon sends no
`notify` event and shows no banner. The `notify` event is not the operator agent's `notify`
command ("The operator agent" below).

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

A viewer stops on its own in three cases (dogfood #15); the next `diff/start` starts it again.
The daemon stops every live viewer when it stops, so no viewer outlives it.
It stops a viewer that had no activity for 30 minutes (`DIFF_IDLE_MS`); a sweep checks each minute.
Activity is what the daemon sees: a `diff/start`, an agent's `diff_comments` or `diff_reply`, and a change in the recorded threads.
The viewer serves the browser directly, so reading the diff without a comment is not activity.
At most 6 viewers run across sessions (`DIFF_VIEWERS_MAX`); a start past that stops the least recently active one first.
Each stop is a line in the job log or the daemon log that names the reason.

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

## EGM skills and the lead's subagents

Spinner fetches Google's Elephant-Goldfish Model (EGM, Apache-2.0) at a pinned commit into
`<home>/egm/` and gives its skills to each lead ([ARCHITECTURE.md](ARCHITECTURE.md#egm-skills)).
The skills are tools the operator asks for: `/skill:egm-brainstorm`, `egm-draft`,
`egm-review`, `egm-review-loop`, `egm-resolve`, `egm-drift-report`. Nothing in a session
needs one. A skill writes its files to `<session>/egm/`, where the Files view shows them.

Until 2026-11-23 the daemon also ran EGM as a lifecycle: a design track, stages, gates, an
approval and tabs for each step, and a plans library. All of that is removed, with its routes
(`…/design/*`, `/plans*`) and the `design_doc` and `ask_question` tools. A `session.yaml`
from before keeps its `design` and `outcomes` blocks; nothing reads them. `kind: plan` reads
as an ordinary session.

`GET /egm` answers `{ egm: EgmStatus }`: `state` (`absent`, `fetching`, `ready`, `failed`),
the pinned and the fetched commit, the time of the fetch, `error`, and `subagents` (whether
the operator's pi settings list pi-subagents). `POST /egm/fetch` starts the job `egm`, which
clones the pin again and regenerates the adapter. `spinner doctor` reports the same facts.

The Goldfish of a skill run as pi-subagents children of the lead, as any other subagent the
lead starts. The daemon reads the status files pi-subagents writes under
`<session>/egm-runs/` and lists the steps in `SessionView.subagents`: one `GoldfishView` per
step with `run`, `step`, `agent`, `persona` (set for an `egm-*` agent), `state`, `model`,
`tokens`, `usd`, `started`, `last_activity` and `transcript`. The Agents view shows them as
rows under `Subagents`. `GET /sessions/:dir/egm/goldfish/:run/:step/events` answers the
transcript events of one step, or 404 for an unknown run or step, or a file outside
`<session>/agents/`.

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
maps each agent to `{ usd, tokens_in, tokens_out, model, context }` and `model` is that of its latest
message. `OperatorView.cost` is the same without `agents`. Token counts leave the cache
counts out.

`context` (dogfood #45) is `{ tokens, window, pct }` or null. `tokens` is `input + cacheRead + cacheWrite` of the agent's latest assistant message: the size of the prompt that message answered.
`window` is that model's `contextWindow` from the daemon's model list, and `pct` is the whole percent, rounded down.
`context` is null before the agent's first message and while the window is unknown.
The model list loads in the background the first time a view asks for a window; the sessions then republish.
After a failed load the daemon asks pi again after 5 minutes, not on every view.

The ledger also folds the transcripts of the lead's Goldfish. Each run's `status.json`
under `<session>/egm-runs/` names a transcript per step (`steps[].sessionFile`). A
foreground run names it through its files under `subagent-artifacts/`. The ledger takes
only a path inside `<session>/agents/`. Each row of such a file carries
`child: "<runId>/<step index>"`. Those rows sum into `SessionCost.children[child]`, not into
`agents.lead`. The session totals include them. `children` is absent when the session has
no Goldfish row. At most 20,000 child transcripts are folded across the home. Past that
bound, the newest by mtime are kept, and the ledger logs one line per refold.

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
| `agents.github` | Optional. `guarded` (the default) or `full`. With `full` a session's lead acts on GitHub as the operator. Its shell may run `git push`, `gh pr create`, `comment`, `review`, `merge` and a writing `gh api`. Its tools `pr` `open`, `thread_reply` and `thread_resolve` work. The autopilot runs (below). The extension reads the setting at each spawn as `SPINNER_GITHUB`. Slack posts, `approve`, `land`, `reset` and `close` stay the operator's. The operator agent stays guarded. |
| `operator.enabled` | Optional, default false since s014. The daemon starts the operator agent at boot when true. |
| `operator.model` | Optional. `provider/model` for the operator agent; else `default_model`, else the daemon's default. |
| `review.models` | Optional. The swarm's models, `provider/model`; default `x-ai/grok-4.6`, `anthropic/claude-opus-5-5`, `openai/gpt-6-luna`. |
| `review.n` | Optional, 1 to 20. How many of `models` run, from the first; default 3. |
| `review.skill` | Optional. The `pr-review` skill's directory; the rulebook (`engineer-conventions`, `backend-conventions`, `principles`, `interrogate/references/lead-judgment.md`) is read from the `skills/` directory next to it; default `~/.pi/agent/skills/pr-review`. |

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
| `plan[]` | `{ id, text, owner, entry, state: next \| doing \| done, ticked_at }`; `id` is the number in the file; `entry` is the doc entry of the `[1.5]` token (or the older `plan 1.5:` prefix) at the start of the line, null for a free item; `text` is the text without the token. |
| `roster[]` | `{ agent, owns, doing, blocked, updated }`, the cells as written. |
| `contracts[]` | `{ id, ts, author, text }`; nested lines join the text. |
| `questions[]` | `{ id, ts, author, text, answer, resolved }`; `id` is the position; `ts` is the `HH:MM` of a stamped question, null for an older line; the indented lines under a question are the answer, except the first `[resolved]` line, which is `resolved: { ts, author, reason }`. |
| `log[]` | `{ ts, author, text }`, file order, oldest first. |

A Plan item is `doing` when it is unticked and its owner's Roster `Doing` names `#id` or
`item id`. An owner whose `Doing` is active (not `—`, empty or `done`) and names no item is
`doing` on its lowest unticked item.

The `item` mode of `PUT /sessions/:dir/mission/section` edits one item of `plan` or
`done_when`: `item: { command, id?, text?, owner?, entry?, order? }`. `add` appends `- [ ] N.
text (owner)` to the Plan (N is `max + 1`; the owner defaults to the author) or `- [ ] text`
to Done when; with `entry` (`add` only; an entry id such as `2.3`) the Plan line starts its
text with the `[2.3]` token. `tick` writes `[x]` and `(owner, HH:MM)` with the daemon's
clock. `untick` drops the time. `edit` replaces the text and keeps the token, unless the new
text starts with a token, which then replaces the entry. `assign` sets the owner. `reorder`
takes the ids in their new order; unlisted items follow in their old order. Ids never
change. A Plan line written before s014 without a number gets one on the first write to the
section. A 400 names the first problem. An unknown id is one.

Open questions (dogfood #43) are stamped: `append` on `open_questions` writes
`- HH:MM author: text`. The `item` mode on `open_questions` takes `answer` and `resolve`
with `id` (the question's position) and `text`. `answer` writes `  - HH:MM author: text`
under the question; any author may answer. `resolve` writes `  - HH:MM author: [resolved]
text`; only `lead` and `operator` may resolve, and a question resolves once. Neither writes
a Log line. An older daemon reads the new lines as a question and its answer lines.

## Reviews

A review (s015) is a session of `kind: review`: a place for a peer's PR. `POST /reviews
{ text }` runs the extractor over the paste and makes one session per PR, in one job
(action `reviews`). Full URLs and `owner/repo#N` resolve; there is no project, so a bare
`#N` does not. The job's `session` is the first one; its log names each. For each PR the
daemon clones the repository once under `<home>/reviews/<owner>-<name>/` and fetches
`refs/pull/<n>/head`. It checks the PR head out detached under the session's
`worktrees/<name>`, so nothing can be pushed from it. The session has no project and no
stack. `branch` and `base` are the PR's. `repos.<name>.pr` holds the facts as an adopted
PR's, so the poller, the board and the threads track it. A reference GitHub does not know
is skipped with the reason in the log; a paste with no reference is a 409.

The same job then starts the review (s016): the agent `lead` in the PR worktree, with
model `settings.default_model` and the review lead's brief (the operator's `pr-review`
skill, with the daemon in the loop), the PR as its first message; then the swarm, below.
Both run headless on the rpc harness (`agents.<name>.harness: rpc` in `session.yaml`): no
pty, no startup screen, no terminal tab; `GET /sessions/:dir/agents/:name/tty` answers 409
for them. A lead that does not start is one job log line; the swarm runs either way.

`SessionView.kind` is `review` for such a session and `session` otherwise.
`SessionView.review` (`ReviewFields`) carries the PR's `checks` with the `failing` check
names, the `review_decision` and the `threads` count (open and resolved). Its `swarm` is
one `SwarmMember { name, model, state, usd, pr, error }` per reviewer, `error` the reason of
a `failed` one (null otherwise). `state` sums the review up: `drafted` while a draft exists,
else `reviewing` while a reviewer is `queued` or `reading` or the lead runs a turn, else
`posted` once a review went up, else `idle`; `comment_count` and `event` are the draft's
(`0` and null without one). `briefing` is true once
`artifacts/briefing.md` exists; `draft` is the `ReviewDraft` of `artifacts/review-draft.json`
or null; `posted_url` is the posted review's URL or null. `review.updated { data }` goes on
the bus whenever those fields change, right after the `session.updated` that carries them.
An ordinary session gets `review` too once its swarm ran, so its chips show. Every PR the
poller tracks carries `checks_failing`, the names of the red checks.

## The review step

`POST /sessions/:dir/review { pr? }` starts the review swarm in one job (action `review`).
It runs on each open or draft PR of the session, or on the one repo key `pr` names. The
swarm is one headless (rpc) agent per model in `settings.review.models`, the first `n` of
them. A
reviewer is named `review-<model-slug>`: the model id in lower case, one dash per run of
other characters. With several target PRs the name is `review-<repo>-<model-slug>`. Each
reviewer starts in the PR repo's worktree with `agents/<name>/BRIEF.md`, written once from
the reviewer brief: the operator's `reviewer` role word for word, with the PR, the detached
checkout, the rulebook by path, the skill's comment format and the `VERDICT` contract. The
reviewer reads only: it never comments, reviews, posts, edits or pushes. It ends its turn
with the verdict block. The role's skills (`engineer-conventions`, `principles`) go in with
`--skill` when they exist next to `settings.review.skill`; `agents.<name>.skills` in
`session.yaml` keeps the paths, so a resumed reviewer loads them.

The states live in `session.yaml` under `review.swarm.<name>`. `queued` is a reviewer the
running-agents cap (24) holds back. `reading` is one that started. `done` is one whose
settled turn ended with an assistant text that carries `VERDICT: BLOCKING` or `VERDICT:
CLEAR`: the daemon saves that text as `artifacts/reviews/<model-slug>.md` and stops the
reviewer's pi, so the slot frees and the next queued reviewer starts. `failed` is one whose
pi did not start or exited without that line; `review.swarm.<name>.error` holds the reason
(the start error, else the last assistant text, else the exit code; 300 characters at
most). The transcript stays. When no reviewer is `queued` or `reading` any more, the lead
gets the verdicts notice: the files by absolute path, the reviewers that failed, the
lead-judgment rules and the `review_draft` contract. A tty lead gets it through the
extension channel; a headless lead as a prompt when idle, a steer while it runs; a lead that
is not running gets it with its next prompt. The reviewers hear no mission or notes notices. On daemon start,
queued reviewers go back in the queue and reading ones without a process are failed.

A review holds no session lock: it runs beside another job on the session. The route is a
409 for a session without an open PR, for a PR whose repo has no worktree, and while a
reviewer of that PR still reads. A second `review` after the swarm settled runs it again.
On an ordinary session the lead is the session's own `lead`; the notice reaches it the
same way.

## The review draft and the post

The lead's two tools write through two routes. `PUT /sessions/:dir/review/briefing
{ markdown }` writes `artifacts/briefing.md`; the UI reads it from `GET
/sessions/:dir/review/briefing` as `text/markdown`. `PUT /sessions/:dir/review/draft` takes
a `ReviewDraft { event, body, comments: [{ path, line, body }] }`, from the lead's
`review_draft` tool (whose `comments` is a JSON array text) or from the operator's edits in
the review pane. The daemon reads the PR diff once per write (`gh api
repos/:owner/:repo/pulls/:n/files`, a read) and checks: `event` is `APPROVE` or `COMMENT`,
and not `APPROVE` with a `BLOCKING:` comment; `body` is not empty; each comment body starts
with `BLOCKING:`, `BUG:`, `NIT:` or `SUPER NIT:`; each `path:line` is on the right side of
the diff (an added or a context line). A fault is a 400 whose `error` lists every one, and
nothing is written. A whole draft is written to `artifacts/review-draft.json`,
`review.draft` in `session.yaml` is true, and the tracker sets `needs_human` to `post or
drop the review draft` (`REVIEW_DRAFT_NEEDS_HUMAN`), which wins over the pipeline's own
text until the draft goes. `DELETE /sessions/:dir/review/draft` drops it.

`POST /sessions/:dir/review/post` is the operator's click and the only path that posts a
review. It runs `gh api --method POST repos/:owner/:repo/pulls/:n/reviews --input <file>`
through the GitHub writer with `commit_id` at the PR head, `event`, `body` and `comments[]`
with `side: RIGHT`. An `APPROVE` GitHub refuses for the author's own PR is reposted as
`COMMENT`; the answer `ReviewPostResponse { url, event, fell_back }` says so. The URL lands
in `session.yaml` (`review.posted_url`), in `artifacts/review-posted.json` (the draft as
posted) and in one Log line by `operator`; the draft file goes, `needs_human` clears, one
GitHub poll follows, and `review.updated` carries the change. The write guard applies: a
review session's PR repo is allowed; an ordinary session's PR must be on its project's
`pipeline.github.write_repos`. 409 without a draft; 502 with GitHub's reason when it
refuses. The lead role's bash guard refuses `gh pr review`, `gh pr comment` and `gh api`
writes, so the lead cannot post by hand.

`POST /sessions/:dir/review/approve` (dogfood #22) is the operator's one-click approve.
It posts one review with `event: APPROVE`, the body "LGTM" and no comments, at the PR head, through the same writer and the same allow-list as `post`.
It needs no swarm and no draft; a draft that exists stays.
GitHub's refusal of APPROVE on the author's own PR reposts it as `COMMENT`, as `post` does.
The URL lands in `review.posted_url` and `artifacts/review-posted.json`, and one Log line by `operator` reads `approved <owner/repo>#<n> as <event>: <url>`.

`POST /sessions/:dir/review/cancel` (dogfood #22) stops a running review as one.
The swarm drops its queued reviewers, clears `review.swarm` and sets `review.cancelled`, then stops the running reviewers; a stopped reviewer is therefore not recorded as failed.
In a review session the lead stops too; in an ordinary session the lead is the session's own and stays.
The verdict files under `artifacts/reviews/` move to `artifacts/reviews-cancelled/<stamp>/`.
The answer is `ReviewCancelResponse { ok, stopped, archived }`, and one Log line by `operator` names what stopped.
`ReviewFields.cancelled` is true while the review is `idle` after a cancel; the next start, draft, drop, approve or post clears it.

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

## Preview comments

In the desktop app, the operator freezes a preview, marks an element, an area or the whole
page, writes a comment and sends it to an agent (s054). Each comment is a thread under the
session: `artifacts/comments/<id>.json`, with its screenshot beside it as
`shot-<date>-<time>-<hex>.png`. Nothing goes into a repo worktree. The types are in
`packages/protocol/src/comments.ts`.

The UI sends a comment in two calls:

1. `POST /sessions/:dir/attachments` with `{ "mime": "image/png", "data": <base64> }`. The
   answer is `{ name, path }`; `path` is relative to the session directory.
2. `POST /sessions/:dir/comments` with `{ agent, text, anchor }`. The `preview` anchor holds
   `service`, `url`, `selector`, `text`, `component`, `source`, `rect`, `screenshot` (the
   `path` of step 1, or null) and `console_errors`. A `doc` anchor is reserved for the docs
   tab; the daemon refuses it with 400 for now.

The daemon numbers the comment `c<n>` per session. Before it writes the record, it redacts
secrets: the values of secret-looking query parameters in `url` (`redact_url`), and every
secret value of its environment in the text, the URL, the element text, the selector and
the console errors (`redact`, the job-log redaction). Then it delivers the comment to the
agent through `deliver_message`:

- The text is `comment_prompt_text`: the operator's sentence, a `Where:` list (service,
  URL, selector, element text, component, source, area, the screenshot's absolute path,
  the console errors), and the instruction to answer with `comment_reply` and
  `comment_suggest_resolve`.
- The screenshot goes with the text as an image ("Extension routes" above, or the rpc
  `images` field).
- An idle agent gets a prompt, a busy one a steer. A stopped agent gets the text with its
  next prompt, without the image; `delivered` is then `stopped`.

`CommentResponse.delivered` is pi's disposition (`started`, `queued`) or `stopped`. It is
absent when nothing went to the agent: an agent's own reply, a suggestion, a resolve.

The states follow the diff viewer's threads:

| Call | Author | `state` | `waiting_on` | Goes to the agent |
|---|---|---|---|---|
| create | operator | `open` | `agent` | the comment and the image |
| reply | operator | `open` | `agent` | `comment_reply_text` |
| reply | the agent | unchanged | `operator` | nothing |
| suggest-resolve | the agent | `suggested` | `operator` | nothing |
| resolve | operator | `resolved` | unchanged | nothing |

`author` in `CommentReplyRequest` is `operator` by default. Any other author must be an
agent the session lists, else 400. The extension's tools send the agent's name.

After each change, the daemon mirrors the comments that wait on the operator (state not
`resolved`, `waiting_on: operator`) into `session.yaml` as `comments.waiting`, oldest
first. The stage derivation reads it: while nothing in the pipeline needs the operator, the
oldest one becomes `needs_human`, `answer preview comment c1 on web /refunds · RefundRow`,
with `and N more` for the rest. The daemon then publishes the session view and one
`comment.updated` event: `{ id, state, waiting_on, author }`. The UI reloads
`GET /sessions/:dir/comments` on that event.

The agent tools ("What the pi extension provides" in SESSION_PROTOCOL.md) call these
routes. `comments_list` prints the open comments, or every comment with `all: yes`, with
the screenshot's absolute path for the `read` tool. `comment_reply` and
`comment_suggest_resolve` post with the agent's name as `author`.

## Session files

The Files view of a session shows its directory as a tree, the way mdview shows a folder
(`packages/protocol/src/files.ts`). The operator reads a file, comments on a passage for an
agent, edits it, shows it in the file manager and copies it to his Downloads folder.

`GET /sessions/:dir/files` answers `SessionFilesResponse { root, entries, truncated }`. Each
entry is `{ path, kind: file | dir, bytes, mtime }`, sorted by `path`, with `/` between the
parts and relative to the session directory. The walk lists at most 3,000 entries, 8 levels
deep, and does not follow a symbolic link. Never listed and never served: `worktrees/`,
`egm-runs/`, `log/`, `diff/`, an agent's `agents/<name>/pi/`, a name that starts with a dot,
`node_modules` and `__pycache__`.

Every route takes a `path` the tree lists. A path that is absolute, climbs with `..`, is not
listed, or leaves the session directory through a link is a 400; a path with nothing there
is a 404.

| Route | Answer |
|---|---|
| `GET …/files/text?path=` | `SessionFileResponse { path, absolute, text, bytes, mtime, editable }`. 413 past 2 MiB, 415 for a file with a NUL byte in its first 8 KiB. |
| `PUT …/files/text` | Body `{ path, text, mtime }`; `mtime` is the one the read gave. 409 and nothing written when the file changed since, so an agent's edit is not lost. 409 for `session.yaml` and `MISSION.md`, which Spinner writes. The write is a temporary file and a rename. |
| `GET …/files/raw?path=` | The bytes. `png`, `jpg`, `gif` and `webp` answer inline; any other file is `application/octet-stream` with `content-disposition: attachment`, so a file an agent wrote never runs as a page of the daemon's origin. |
| `POST …/files/reveal` | Body `{ path }`; `""` is the session directory. `open -R` on macOS; elsewhere the file's directory opens. |
| `POST …/files/download` | Body `{ path }`. 201 with `{ saved }`, the copy's path in `~/Downloads`. A taken name gets ` (1)`, ` (2)`, …; nothing is overwritten. |

A comment on a file is a comment thread as a preview's (`POST /sessions/:dir/comments`), with
the anchor `{ kind: "doc", path, quote, heading }`: the text the operator selected (`""` for
the whole file) and the nearest heading above it. The daemon checks `path` as above and
fills `line`, the 1-based line of the file where the quote starts, when it finds the quote's
first words in the source. The agent gets `Doc comment c<n> from operator on <path> ·
<heading>:` with the file's absolute path, the line, the heading and the selected text, and
answers with `comment_reply` and `comment_suggest_resolve`. A doc comment that waits on the
operator reads `answer doc comment c<n> on <path> · <heading>` in `needs_human`.

The UI reads the tree again every 3 s while the Files view shows. An open file follows its
file, except while the operator edits it, writes a comment or holds a selection, and for a
file over 200 KB; a chip then offers the reload.

## Agent records in `session.yaml`

`agents.<name>` holds `harness`, `model` and `process`, and `thinking` once pi reported a
thinking level or `POST .../thinking` set one. `harness` is `tty` or `rpc`; `pi`
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

## Worktree sync

Every 15 seconds (`sync_seconds`; 0 is off, and off when `poll_seconds` is 0) the daemon reads each session worktree and writes `repos.<key>.sync` into `session.yaml`. `dirty` is the count of changed tracked files. `ahead` and `behind` compare the worktree with `origin/<its branch>`, the remote branch of the same name, not with the branch's configured upstream. `upstream` is true once that remote branch exists. `pushed` is the time of the daemon's last push. `error` is the first line of a refused push, else null. When `upstream` is true and `ahead` is above 0, the daemon runs `git push origin HEAD`, never a force. A refused push fetches the branch so `behind` is current. A worktree with a pull request whose remote branch is not fetched yet fetches it first. The card and the context bar show `push failed`, `↑n unpushed` or `n uncommitted` from these facts. With `agents.github: guarded` the agents never push themselves, and the daemon keeps the remote branch current; with `full` a lead may push too.

## The fast path and the autopilot

The design is `docs/designs/talk-change-ship.md`, step 1. A new session is on the `direct` track. Its lead builds the change, verifies it, opens the pull request and keeps it ready. No gate asks the operator for a plan.

The lead's tools for it:

- `stack` `up` runs the `up` job and waits up to 2 minutes. A longer start keeps running; `stack` `show` reads it.
- `pr` `open` runs the `pr` job: a push, one pull request per changed repo, with `body` as the description. It needs `agents.github: full`.
- `thread_list`, `thread_reply`, `thread_resolve` and `thread_flag` are the lead's as well as the fixer's. For a lead, `thread_reply` and `thread_resolve` need `agents.github: full`.

The autopilot runs inside the GitHub poll, for each session with an open pull request, when `agents.github` is `full`. It sends one message to the session's lead per poll, with what is new:

- The checks are red at a head the lead was not told about. The message names the pull request, the head and the failing checks.
- Open review threads the lead was not told about, from bots and from people. Flagged threads are left out.

A stopped lead is resumed for the message. A lead that cannot be reached is told at the next poll. The daemon keeps what it told in `session.yaml` under `pipeline.autopilot`: `red` (per repo key, the head and the count of red heads in a row) and `threads` (the thread ids, at most 500). The `pr` job starts a pull request with an empty state. A pull request that the poller sees with no state gets the baseline: what stands is recorded as told and no message is sent, so an adopted pull request does not flood its lead with history. After 5 red heads in a row on one pull request the autopilot stops telling the lead about its checks and notifies the operator; a green head resets the count. `reset` clears the state with the rest of `pipeline`.

## Changes

The design is `docs/designs/talk-change-ship.md`, step 2. A change is one branch and its pull request in each repo it touches. A session holds any number of them.

The shape in `session.yaml`:

- The top-level `branch`, `repos.<key>.changed`, `repos.<key>.pr`, `pipeline`, `stage` and `needs_human` describe the current change. That is the change checked out in the worktrees.
- `change` names the current change: `id`, `title`, `started`, and `on` when it was started on another change. A file without it reads as change `c1` with the session's title.
- `changes` holds every other change, open or finished, at most 200. A record carries `id`, `title`, `branch`, `repos`, `pipeline`, `stage`, `needs_human`, `started`, and `ended` once every pull request is merged or closed.

A file written before step 2 is valid as it is. Nothing migrates.

`POST /sessions/:dir/changes` starts a change. The body is `{ title, on? }`. The job does these steps:

1. It refuses when a worktree has uncommitted or untracked files, and names the paths.
2. It pushes the current branch when its remote branch exists and lacks commits.
3. It makes the branch `feat/<slug of the title>` in every worktree. The branch starts at fresh `origin/<base>`, or at the branch of the change `on` names.
4. It puts the current change into `changes` and makes the new one the top level. A current change with no commit and no pull request is not kept.
5. It appends a Log line.

`POST /sessions/:dir/changes/:id/switch` does steps 1 and 2, checks out the branch of change `:id`, and swaps the two changes. Neither job touches the stack.
It refuses first when another worktree has the branch checked out, and names that worktree.

An agent can open a pull request outside a change: it makes a worktree of its own under the session directory and runs `gh pr create` there. The poll finds such a pull request:

1. Once per repository, at most every 2 minutes, it lists the operator's open pull requests with `gh pr list --author @me`.
2. It drops each one that a live session holds in a change or a round.
3. For each one left, it looks for the session whose worktrees had the head branch checked out. It reads the present branch and the HEAD reflog of each worktree under the session directory.
4. It records the pull request in that session. A change on that branch without a pull request for the repo takes it. Else it becomes a new record in `changes`, with the pull request's title and creation time.
5. It appends the Log line `pr: found <repo>#<n> on <branch>, opened outside a change: tracked as <id>`.

The poll of the same round then reads the pull request's facts. A review session and a planning session are skipped. A pull request that no session's worktree had is left alone. A failed `gh` call is logged and does not stop the poll.

The `pr` job opens the pull requests of the current change. The title is the change's title. `PrRequest.body` is the description. Without it the first change takes the mission's Goal and Log, and a later change takes its title. A change started `on` another opens against that change's branch while that pull request is open.

`land`, `post` and `approve` take `?change=<id>`, on the `GET` previews too. Without it they act on the current change. The daemon runs them focused on the change: it writes only that change's fields, into the file as it is at that moment. A `land` that watches the merge queue therefore never writes a stale session over a change started meanwhile. `land` is not an exclusive job, so the lead can open the next pull request while one waits in the queue. After a pop-out, `land` rebases only when the worktree is on the change's branch; else it stops and says so.

The GitHub poll reads the open pull requests of every change. It derives each change's `stage` and `needs_human`. The autopilot keeps its state per change. For a change that is not checked out, its message tells the lead to commit, switch to it, fix, and switch back. A merged change has `needs_human: null`.

`SessionView.changes` lists every change, oldest first: the rounds of earlier resets as `r<n>`, the records, the current one. Each entry has `id`, `title`, `branch`, `current`, `state`, `stage`, `needs_human`, `prs`, `on`, `started` and `ended`. `state` is one of `empty`, `building`, `PR open`, `fixing CI`, `answering review`, `in review`, `ready to merge`, `in merge queue`, `merged`, `closed`. A pull request carries `diff` (`files`, `additions`, `deletions`) from the poll. `repos.<key>.sync.commits` counts the commits on the branch that the base lacks.

The lead's `change` tool has `list`, `start` and `switch`. The extension guard refuses `git checkout -b`, `git switch` and `git branch <name>` for a session's agents and names the tool. A command with `git -C <dir>` is allowed, for a scratch repository.

In the UI, the right pane has a `PRs` tab (its id is still `changes`): a table with one line per pull request, described under "The PR view and the Agents view". The pane opens on it while the stack is down and a pull request exists. The sidebar has a `Pull requests` view: every pull request of every session, open ones first.

`UpRequest.change` is `test locally` on a change (step 3). For the current change, `up` runs as before. For another change the job does these steps:

1. It refuses while an agent of the session is in a turn.
2. It switches the worktrees to the change, with the refusal on uncommitted work.
3. It stops a stack that was up, so every service starts on the change's code.
4. It starts the stack.

The database is kept across a switch. `ChangeView.verified` is true when the operator's tick stands at the head of every open pull request of the change. With more than one change, the lead's prompt section lists the open changes and marks the one that is checked out.

`change start` gives the branch a number when a repository already has the name, locally or on the remote. The stack jobs write only the `stack` field of `session.yaml`, into the file as it is at that moment.

### Groups of changes

A change can be in a group: `ChangeHead.group` names an entry of `session.groups`, each
`{ id: "g<n>", name, purpose, hold? }`. The lead groups the changes that belong together
with the `change` tool (`group`, with a name and a one-line purpose); the operator renames a
group and edits its purpose in the PR view. A change started `on` a grouped change joins its
group. A group left without a change is dropped. `:group` in a route is an id or a name.

| Route | Body | Does |
|---|---|---|
| `PUT /sessions/:dir/changes/:id/group` | `{ group: name \| null, purpose? }` | Puts the change in the group, made when new; `null` takes it out. |
| `PUT /sessions/:dir/groups/:group` | `{ name?, purpose? }` | Renames the group or changes its purpose. 409 for a name another group has. |
| `PUT /sessions/:dir/groups/:group/hold` | `{ reason, by }` | Puts the group on hold. |
| `DELETE /sessions/:dir/groups/:group/hold` | | Ends the hold. |

Each answers `SessionResponse`; 404 for an unknown change or group. While a group holds, the
autopilot sends the lead nothing about its pull requests, and the lead's prompt lists the
change with `ON HOLD: <reason>`. The PR view shows each group as a headline with its name,
purpose and one status: `on hold`, else the status of its most pressing change (`needs you`,
`CI failing`, `answering review`, `pending CI`, `draft`, `needs peer review`, `in merge
queue`, `ready to merge`).

## Linear tickets

The daemon keeps Linear tickets for a session's pull requests
(`packages/protocol/src/linear.ts`, `packages/daemon/src/pipeline/linear.ts`). It is off
until two things exist: `LINEAR_API_KEY` in the daemon's environment (`<home>/env`), and a
`linear:` block with a `team` in the project's `pipeline:`.

```yaml
pipeline:
  linear:
    team: GKA                                  # the team's key; without it nothing is written
    labels: { backend: Backend, admin: Frontend }   # a label per repo key; made when missing
    # The state of each stage; these are the defaults.
    states: { draft: In Progress, open: In Review, merged: In Dev Env, closed: Canceled, hold: Canceled }
```

A unit of work is a group of changes, or a change in no group. Each pull request of a unit
gets one ticket, with its repo's label, assigned to the key's user. A unit with two or more
pull requests also gets a parent ticket, named after the group (or the change), and its
tickets go under it. A change in one repository therefore has one ticket; a change in two
repositories has a parent and two tickets.

| When | What the daemon sends |
|---|---|
| A pull request is first seen open or as a draft | It asks Linear for a ticket already linked to the pull request's URL. With one, it adopts it: the state and the parent follow, the title and the description stay as written. Without one, it makes the ticket and attaches the pull request (`attachmentLinkGitHubPR`, Linear's own GitHub link). |
| A unit gets its second pull request | The parent ticket, then `parentId` on each ticket of the unit. |
| A draft is marked ready, a pull request merges | The state: `draft`, `open` or `merged` of `states`. A parent is as far as its least advanced pull request. |
| A pull request is closed without a merge | The `closed` state, for a ticket the daemon made. A parent whose pull requests were all dropped closes too. Opened again, the ticket returns to its stage. |
| A group is put on hold | The `hold` state for the ticket of each open pull request of the group and for its parent, for tickets the daemon made. A merged ticket stays merged. When the hold ends, each returns to the stage of its pull request. |
| The title of the pull request or the purpose of the group changes | The title and the description of the tickets the daemon made. |

Never sent: a comment; a ticket for a pull request that was already merged or closed when
first seen; a state for a ticket that a person moved to a completed, cancelled or duplicate
state (the daemon reopens only a ticket it closed itself); the `closed` or `hold` state for
an adopted ticket, because another pull request or another person may still carry it.
`merged` is the furthest state the daemon sets: the ticket goes no further by itself.

The sync runs at the end of each poll round, after GitHub was read. `session.linear` records
each ticket (`prs` by pull request URL, `parents` by unit) with a signature of what was last
sent; a round in which nothing moved makes no call to Linear. One round sends at most 20
writes per session. A failure is logged as `linear <session>: …` and tried again at the next
round; it never fails the poll. A ticket whose attach call failed is recorded as `unlinked`
and attached at the next round, so it is never made twice.

In the UI, each row of the PR view carries its ticket id, a link to Linear, and a group's
headline carries the parent's. The sidebar's `Linear tickets` view lists every ticket across
sessions by unit of work, each with its Linear state and where its pull request stands.

## The chat

The chat is the surface of every agent; `context` is a tab beside it. Each session agent is
one `pi --mode rpc` process that the daemon hosts, and the daemon holds the transcript.
`GET /sessions/:dir/agents/:name/transcript?since=<seq>` answers
`AgentTranscriptResponse { reset, next, events, running, prompt, compacting, active }`: the
numbered events after `since`, or the newest 2,000 with `reset: true` when `since` is absent
or too old. The `/events` socket sends each new event with its `seq`; a page that sees a gap
reads the route again. A prompt pi waits on (a guard's confirm, a select, an input) is
`prompt`; `POST …/agents/:name/answer` with `AgentAnswerRequest` answers it, 409 for a wrong
id and 400 for a wrong kind.

`POST /sessions/:dir/agents/:name/prompt` and `.../steer` resume a listed agent that is stopped when the body has `source: "operator"`, then send the text as a prompt. Without that mark a stopped agent is still a 409.

An image pasted or dropped on the message box is saved with `POST /sessions/:dir/attachments` (a PNG; the browser converts another format). The message then ends with one `Attached image: <absolute path>` line per image, and the agent reads the file.

## The PR view and the Agents view

`ChangeView` carries what the session's PR view shows. A `ChangePr` has, besides the fields of the Changes section, `author`, `approvals` (`required`, `peer`, `owner`), `approval_check`, `bot_reviewed_head`, `queue_reason` and `last_activity`. A `ChangeView` has `posted` (the Slack permalink of the change's post, or null) and `approved` (true when `pipeline.approved_heads` holds the head of every open pull request). `GET` and `POST /sessions/:dir/approve` take `?change=<id>`, as `post` and `land` do.

The PR view is a table. Each pull request is one line at every width of the pane. The columns are `PR` (a link to GitHub), `Title`, `State`, `CI` (a link to the checks), `Review`, `Threads` (a link to the files), `Size` and `Updated`. As the pane narrows the columns drop from the right; `PR` and `Title` stay. A click on a line opens its detail: what the change needs, the facts of the dropped columns, the branch, the head, the author, the approval, and the actions. One detail is open at a time. A change without a pull request is one line with `no PR`.

`AgentSpec.ended` records how an agent's process ended: `code` (null for a signal), `by` (`operator` for the stop route, `daemon` for a reviewer the swarm stops; absent when the process ended on its own) and `at`. A resume clears it. The Agents view reads it: stopped by someone is `stopped`, code 0 is `done`, any other end is `failed`.

## A project from inside a session

A project is a `spinner.yaml`. `GET /projects` lists the ones the daemon finds. Two routes let a session's lead make one:

| Route | Body | Answer | What it does |
|---|---|---|---|
| `GET /projects/help` | none | `ProjectHelpResponse` | The path of `docs/STACK_SPEC.md` and a small spec to start from. |
| `POST /projects` | `ProjectCreateRequest` | 201 `ProjectCreateResponse` | Checks the spec text and saves it as `<home>/projects/<name>/spinner.yaml`. |

`POST /projects` answers 400 for text that is not YAML, for a spec that does not load, and for a repo path that is not absolute (or does not start with `~`) or is not a git checkout. It answers 409 when a project of that name exists. With `replace: true` it writes over a project under `<home>/projects`; it never writes over a linked directory or a project of another place.

`POST /sessions/:dir/attach` now attaches a project to any session. A session that tracks pull requests gets their head branches, as before. Any other session gets one worktree per repo on its own branch. It answers 409 for a review session and for a session that has another project.

The lead's `project` tool has `help`, `list`, `create`, `update` (a `create` with `replace`) and `attach` (on its own session, waited for).

## Projects and stacks

The UI's `Projects` view shows every project, its settings, and every session's stack. The operator edits a project as its `spinner.yaml` text. A project is named as `GET /projects` lists it: the first entry of that name, from `<home>/projects`, then `local/`, then `examples/`. A link under `<home>/projects` to a directory elsewhere is listed too.

| Route | Body | Answer | What it does |
|---|---|---|---|
| `GET /projects/:name` | none | `ProjectDetailResponse` | The project, the file's text, `writable`, `linked`, a `summary` of its repos, services, database and pipeline, and the live sessions whose `session.project` is the name. |
| `PUT /projects/:name/spec` | `ProjectSpecRequest` | `ProjectDetailResponse` | Checks the text as `POST /projects` does, requires `name:` to be `:name`, and writes the file, through a link too. |
| `DELETE /projects/:name` | none | `OkResponse` | Removes a link under `<home>/projects` (the target stays), or a directory there that holds only `spinner.yaml`. |
| `POST /projects/link` | `ProjectLinkRequest` | 201 `ProjectDetailResponse` | Makes the link `<home>/projects/<spec name>` to the directory of an existing `spinner.yaml`. |

`writable` is false for a project of `examples/`, which the repository tracks. `linked` is true for a link under `<home>/projects` and for a project found only under `local/`. The summary fills in what the daemon fills in: a repo's `base` from the spec's, a service's `preview` as `frame`, the database's `server` as `spinner-postgres` and its `template` as `<name>_seed`, and the pipeline's defaults from `pipeline_config_from_spec`. A repo's `git` is false when its path holds no `.git`.

The answers: 404 for an unknown name. `PUT` answers 400 with the reason for a spec that does not load, names a repo path that is not a git checkout, or has another name, and 409 for a project of `examples/`. `DELETE` answers 409 while a live session uses the project, for a directory that holds other files, and for a project only under `local/` or `examples/`. It never removes anything through a link. `POST /projects/link` answers 400 when the path is not absolute or the spec does not load, and 409 when the name is taken.

A session holds its own copy of the spec, `<session>/stack/spinner.yaml`, written when the project is attached. A save does not change it. `POST /sessions/:dir/attach` with the same project writes the copy again; the project page calls this `update its copy`. The Stacks section of the view lists every live session with a project, newest first, with `run local` (`POST /sessions/:dir/up`) and `stop local` (`POST /sessions/:dir/down`).

