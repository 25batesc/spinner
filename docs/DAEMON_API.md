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
| `GET /sessions/:dir/post` | | `PostResponse` | The composed Slack message. |
| `POST /sessions/:dir/post` | `PostRequest` | `JobResponse` | `confirm: true` or 400. |
| `GET /sessions/:dir/approve` | | `ApproveResponse` | Head, diff stat and open threads per PR. |
| `POST /sessions/:dir/approve` | `ApproveRequest` | `JobResponse` | `confirm: true` or 400. |
| `POST /sessions/:dir/land` | `LandRequest`, optional | `JobResponse` | Enqueue, watch, rebase and re-enqueue on a pop-out. |
| `POST /sessions/:dir/reset` | `ResetRequest`, optional | `JobResponse` | The next round. |
| `PUT /sessions/:dir/mission/section` | `MissionSectionRequest` | `MissionSectionResponse` | The daemon serializes writes. The `item` mode is below. |
| `POST /sessions/:dir/inbox` | `InboxMessageRequest` | `InboxMessageResponse` | Writes the message and delivers it. |
| `GET /sessions/:dir/agents/default-brief` | | `DefaultBriefResponse` | Query `name`, `repo`, both optional. |
| `POST /sessions/:dir/agents` | `AddAgentRequest` | `AgentResponse` | 201. Model: the request, else the agent's last run, else `settings.default_model`, else `config.yaml`. Harness: `settings.agents.harness`, else `config.yaml`. First turn: a new agent gets `message`, else the go signal (read the mission and the brief, take your Plan items, start); a listed agent (a resume) gets `message` or nothing. `first_turn` answers pi's disposition, `queued` when pi refused it (it goes with the next prompt), or `none`. |
| `POST /sessions/:dir/agents/:name/prompt` | `AgentMessageRequest` | `AgentCommandResponse` | 409 with the state for a stopped agent. |
| `POST /sessions/:dir/agents/:name/steer` | `AgentMessageRequest` | `AgentCommandResponse` | Enters after the current turn. A steer to `lead` with `source: "operator"` adds 1 to `outcomes.operator_steers`; below. |
| `POST /sessions/:dir/agents/:name/abort` | | `AgentCommandResponse` | |
| `POST /sessions/:dir/agents/:name/stop` | | `AgentCommandResponse` | The transcript stays. |
| `POST /sessions/:dir/agents/:name/compact` | | `AgentCommandResponse` | Starts pi's compaction and answers `started` at once; writes the `spinner` Log line `compacted <agent> at NN %`. 409 with the process state for a listed agent that is not running. |
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
| `GET /egm` | | `EgmResponse` | The EGM fetch state and the pin; below. |
| `POST /egm/fetch` | | `JobResponse` | The `egm` job: fetches EGM again at the pin and regenerates the adapter; below. |
| `PUT /sessions/:dir/design/track` | `DesignTrackRequest` | `SessionResponse` | Sets `design.track`; below. 400 for an unknown track, 409 once a repo has commits or for `design` when EGM is not available. |
| `PUT /sessions/:dir/design/doc` | `DesignDocRequest` | `SessionResponse` | The lead's `design_doc` tool; below. 400 with the reason, 409 off the design track or while an approval stands. |
| `PUT /sessions/:dir/design/gate` | `DesignGateRequest` | `OkResponse` | The lead's `ask_question` tool writes `design.gate`; below. 400 with the first fault. |
| `POST /sessions/:dir/design/answer` | `DesignAnswerRequest` | `AgentCommandResponse` | Clears the gate and prompts the lead with the text; below. 400 for an empty or long text, 409 when the lead is not running. |
| `POST /sessions/:dir/design/run` | `DesignRunRequest` | `AgentCommandResponse` | Starts an EGM skill in the lead with the arguments the daemon composes; below. 400 for a bad body, 409 with the reason. |
| `GET /sessions/:dir/rounds/:round/log` | | `text/markdown` | The Log of an earlier round from `## Previous rounds`. 400 unless `:round` is an integer from 1 to 200, 404 for a round without one. |
| `GET /sessions/:dir/egm/goldfish/:run/:step/events` | | `AgentEventsResponse` | The transcript events of one Goldfish step; below. 404 for an unknown run or step, or a transcript outside `<session>/agents/`. |
| `GET /sessions/:dir/design/files` | | `DesignFilesResponse` | The files of `<session>/design/` and the archived review runs; below. |
| `GET /sessions/:dir/design/files/:name` | | `text/markdown` | One file of `<session>/design/`. 400 for a bad name, 404 when absent. |
| `GET /sessions/:dir/design/reviews/:run/:name` | | `text/markdown` | One report of an archived review run. 400 for a bad run id or name, 404 when absent. |
| `GET /sessions/:dir/design/doc` | | `text/markdown` | The design doc from the worktree of `design.repo`. 404 before `design_doc` and when the file is missing. |
| `POST /sessions/:dir/design/approve` | `DesignApproveRequest` | `DesignApproveResponse` | Approves the design doc, seeds the Plan from its entries and, with `build`, prompts the lead to build; below. 400 for a bad body, 409 with a `DesignApproveRefusal`. |
| `DELETE /sessions/:dir/design/approve` | | `SessionResponse` | Removes the approval and `approved.md`. `design.approvals` keeps its history. |
| `GET /sessions/:dir/design/approved` | | `text/markdown` | The doc as approved, `<session>/design/approved.md`. 404 before an approval. |
| `GET /sessions/:dir/design/changes` | | `DesignChangesResponse` | The `## ` sections changed since the approval; an empty list without a change. |

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

## EGM

Spinner runs Google's Elephant-Goldfish Model (EGM, Apache-2.0) from a pinned copy under
`<home>/egm/` ([ARCHITECTURE.md](ARCHITECTURE.md#egm-elephant-goldfish-model)).
`GET /egm` answers `{ egm: EgmStatus }`:

| Field | Meaning |
|---|---|
| `state` | `absent` before the first fetch, `fetching` while the fetch runs, `ready` when the marker matches the pin, the adapter version and every required file, `failed` after a failed fetch. |
| `pinned_sha` | The commit the daemon pins. |
| `fetched_sha`, `fetched_at`, `adapter_version` | From `<home>/egm/fetched.json`; null without the marker. |
| `error` | The last fetch error, else null. |
| `source`, `license`, `notice` | The EGM source URL, `Apache-2.0` and the credit line. |
| `subagents` | True when the operator's pi settings list pi-subagents. Without it, leads start without EGM. |

`POST /egm/fetch` takes no body and answers 202 with a job of action `egm` and `session: null`.
The job deletes the marker and fetches again: a shallow clone of the pin, a check of the
required files, the adapter under `<home>/egm/pi/agents`, then the marker. The bound is
5 minutes. The job fails with the fetch error. A lead start fetches EGM the same way when
pi-subagents is installed and EGM is not fetched. A failure there is one job log line, and
the lead starts without EGM.

### The design track and the design doc

`PUT /sessions/:dir/design/track` takes `{ track: "design" | "direct" }`.
It creates the `design` block when it is absent and answers with the session's view.
It answers 409 with `the build has started; the track is fixed` when a track is set and a repo has commits.
It answers 409 with `EGM is not available: <reason>` for `design` when EGM is not `ready` or pi-subagents is not installed.
On `design` it writes the Goal pointer and the one *Done when* item as author `spinner`.
When a session that has a track gets another one, the route writes the `spinner` Log line `track: <new> (was <old>)` and sends the lead one line about the new track (dogfood #44).
A tty lead gets the line as a notice; an rpc lead gets a steer while it runs and a prompt while it is idle; a stopped lead gets it with its next prompt.
The first track of a new session, and the same track again, write no line and send nothing.

`PUT /sessions/:dir/design/doc` takes `{ path }`, the absolute path of the doc.
The designs directory is `spinner.yaml` `designs.dir` (default `docs/designs`) in the worktree of `designs.repo` (default the first repo).
The route answers 400 with the first refusal of these checks, in order:

1.  The path is absolute.
2.  The file is a `.md` file directly in the designs directory.
3.  The name is not `SITEMAP.md` or `README.md`.
4.  The file exists and is at most 1 MB.
5.  The file has both a `## Overview` and a `## Detailed Implementation Plan` heading.
6.  The file does not exist on `origin/<base>`, unless it is the session's current `design.doc`. The `git` call has a 10-second bound.

It answers 409 off the design track, and while an approval stands that no edit invalidated.
On success it records `design.doc` and `design.repo`, points the Goal at the doc, and watches the doc file.

`SessionView.design` (a `DesignView`) carries the track, the stage (null on the direct track), the files of `<session>/design/`, the current run's report flags, the doc and whether it is missing, the doc's repo (`repo`), the absolute designs directory (`designs_dir`), the approvals and the gate.
`SessionView.round` is `session.round`, else the `-r<n>` suffix of the branch, else 1.
`SessionView.rounds` lists the earlier rounds, oldest first, from `session.yaml` `rounds` (`source: "record"`) and from `## Previous rounds` (`source: "mission"`).

### Gates and skill runs

`PUT /sessions/:dir/design/gate` takes `{ question, options }`, the lead's `ask_question` payload after the extension checked it.
It answers 400 with the first fault: an empty question, a question over 2000 characters, fewer than 2 or more than 6 options, or an empty option or one over 300 characters.
It writes `design.gate` with the time, replaces any open gate, and answers `{ ok: true }`.
The design's `needs` and the session's `needs_human` become `answer the lead: <first 80 characters of the question>`.

`POST /sessions/:dir/design/answer` takes `{ text }`, at most 4000 characters.
It answers 409 with `the lead is not running; resume it from its tab` when the lead has no process; the gate then stays.
Otherwise it clears the gate, prompts the lead with the text, and answers with the prompt's disposition.
The resolve card uses the same route with `Auto accept`, `Continue` or `Interactive breakdown`.
A prompt or a steer to the lead through the agents routes also clears the gate, and so does the lead's next `agent_start`.

`POST /sessions/:dir/design/run` takes `{ skill, args?, preset? }`.
`skill` is one of the 7 EGM skills. `preset` goes only with `egm-review` and is one of `interactive`, `uninterrupted`, `feature_spec` and `implementation`. `args` is at most 4000 characters.
The route checks, in order: 400 for a bad body, 409 when the lead is not running, then the 409s of the table.
It prompts the lead with `/skill:<skill>`, a space and the composed arguments:

| Skill | Arguments | 409 |
| --- | --- | --- |
| `egm-brainstorm` | `args`, the operator's concept text, when given | |
| `egm-draft` | `Context File: <session>/design/concepts_brief.md. Target directory: <designs dir>.`, then `args` when given | no worktree of the designs repo |
| `egm-review` with `preset` | `<absolute doc path> Step: <preset> GoldfishContext: none` | `no design doc yet` |
| `egm-review` without `preset`, `egm-review-loop`, `egm-resolve` | `args`, else the absolute doc path | `no design doc yet` when neither is set |
| `egm-drift-report` | `args`, else the designs dir, then `Landed rounds: r1 web#41, r3 web#57.` from the merged PRs of `SessionView.rounds` | a repo has `changed: true` |
| `egm-bootstrap` | `path: ` and `args`, else the designs repo's worktree root | no worktree of the designs repo |

The composed text is at most 4000 characters, else 400.
For `egm-review` and `egm-review-loop` the route first archives the current review run into `<session>/design/reviews/<id>/` and records `design.review_run` with the next free id ([SESSION_PROTOCOL.md](SESSION_PROTOCOL.md#review-runs)). It answers 409 when 99 runs are archived.
Every run clears an open gate.
After the 400 checks, the route answers 409 with `<n> Goldfish are running across sessions (cap 12); start this skill when they finish` while 12 or more Goldfish run across all watched sessions.

### Goldfish

`DesignView.goldfish` lists the lead's Goldfish of the newest 200 runs, newest run first.
The daemon reads the files that pi-subagents writes:

1.  An async run writes `<session>/egm-runs/async-subagent-runs/<runId>/status.json`. A fan-out is one `workflow` run whose steps each name a child run with its own directory. The child run stands for the step, so each Goldfish shows once.
2.  A foreground run writes only `agents/lead/pi/subagent-artifacts/<runId>_<agent>_<step>_*`. Its step runs until its `meta.json` exists, and reads `stopped` if the lead's turn ends first.

Each `GoldfishView` has the run id, the step index, the agent, the chip `state`, the model and the tokens.
`persona` is the agent name without `egm-`. `usd` comes from `SessionCost.children`.
The view also has the start and last-activity times, `design_step` and `transcript`.

| Step status | Chip state |
| --- | --- |
| `queued`, `pending` | `queued` |
| `running` | `running` |
| `complete`, `completed` | `done` |
| `failed`, `rejected` | `failed` |
| `stopped`, `paused` | `stopped` |
| any other word | `running` while the run's state is `running`, else `failed` |

`design_step` comes from `<session>/egm-runs/runs.json`, which records the design stage of each run at its first sight (at most 1,000 runs).
`cost_by_stage` sums the Goldfish `usd` per design step. The lead's own cost is not split.
`goldfish_live` counts the `running` Goldfish across all sessions.

The watcher polls a session every 2 s while its lead is busy, while one of its Goldfish runs, and for 30 s after the lead's `agent.settled`. The lead's `agent_start` and its `subagent` tool calls start the poll. A change publishes `session.updated`.

`GET /sessions/:dir/egm/goldfish/:run/:step/events` answers `{ events }` from the step's transcript, in the shape of `GET …/agents/:name/events`.

### The design workspace

`GET /sessions/:dir/design/files` answers `{ files, review_runs }`.
`files` lists the `.md` files of `<session>/design/` without dotfiles, newest first, as `DesignView.files` does.
`review_runs` lists the `r<n>` directories of `<session>/design/reviews/`, highest number first.

`GET /sessions/:dir/design/files/:name` and `GET /sessions/:dir/design/reviews/:run/:name` answer the file as `text/markdown`.
`:name` must match `DESIGN_FILE_NAME_PATTERN` (`^[A-Za-z0-9_.-]{1,100}\.md$`) and must not start with `.`. `:run` must match `^r\d{1,2}$`. Else the route answers 400.
An absent file is 404.

`GET /sessions/:dir/design/doc` answers the doc at `<worktree of design.repo>/<design.doc>` as `text/markdown`.
It answers 404 before `design_doc` and when the file is missing.
The daemon does not parse report findings.

The UI reads these routes from the views of its agents pane: Brainstorm (the brief and the gate line), Draft (the doc), Review (the reports and the approve button), Files and History ([designs/session-workspace.md](designs/session-workspace.md), T5).
A session on the design track shows those views beside Agents, Implement, Threads and Services; a direct-track session and a session without a `design` block show Agents, Implement, Files, History, Threads and Services and open on Implement.
The pane fetches the doc once per change of `design.files` or `design.doc` and hands the text to the Draft and Implement views; a `mission.changed` never refetches it.

### Approval and the build

`POST /sessions/:dir/design/approve` takes `{ build, blockers_confirmed? }` ([designs/egm-adoption.md](designs/egm-adoption.md), T10).
It does these steps in order:

1.  It refuses with 409 off the design track, without `design.doc`, at stage `resolving`, and with an open gate.
2.  It counts the blockers that the newest report of the current run lists. The newest report is `goldfish_review_report.md`, else `consolidated_review_report.md`, else `implementation_readiness_report.md`. When the count N is above 0 and `blockers_confirmed` is not N, it refuses with 409.
3.  It refuses with 409 when the doc is missing from the worktree, and when `build` is true while the lead is not running.
4.  It scans the doc's plan (below) and runs the seed's checks against the current Plan. It refuses with 409 when the doc has duplicate entry ids (`the plan has duplicate entry ids: 2.3`), an entry whose title is empty (`entries without a title: 2.5`), or no entries (`no plan entries found under an Implementation Plan heading`). It also refuses a doc past the scan's bounds, and a Plan that would hold more than 500 items once every entry without an item is added. No write happens before these checks.
5.  It rewrites the doc's `*   **Status:**` line to `Approved`. A doc without that line is not changed.
6.  It hashes the doc (normalized) and copies the text to `<session>/design/approved.md`.
7.  It writes `design.approved` with the path, repo, hash, time, N and round, appends the same record to `design.approvals`, and clears `design.changed_after_approval`.
8.  It seeds the Plan through the mission writer: one `- [ ] <id>. [<entry>] <title>` line per entry that has no item, owner none, after the existing items. Every Plan line is rewritten in canonical form on the way. An item whose entry's title changed counts `stale`; an item whose entry left the doc counts `orphaned`. Both stay in place, and no token is rewritten. One `mission.changed` is published with the whole view.
9.  It appends the Log lines `design approved: <path> (<sha12>, <N> listed blockers)` and `plan seeded from <path> (<sha12>): <added> added, <kept> kept, <n> stale[: ids], <m> orphaned[: ids]` as author `spinner`.
10. With `build`, it prompts the lead with the build message.

The response is a `DesignApproveResponse`: the `SessionResponse` plus `seed: SeedResult`, `{ doc_path, sha12, added, kept, stale[], orphaned[] }`.
A 409 body is a `DesignApproveRefusal`: `{ error, blockers }`. `blockers` is N for the refusal of step 2 and null for the others.
The blocker count reads only `##` to `####` headings outside code fences.
Severity mode counts the headings with `Severity: Blocker` or `Severity: High`.
When it finds none, section mode applies. A blocker section starts at a level-2 or level-3 heading with `🔴` or `Blockers` and ends at the next heading of that level or higher.
Section mode counts the headings one level below the section heading.
The count does not know which blockers a resolve pass fixed, so the UI calls them "listed".

The build message names the absolute doc path and the first 12 characters of the hash.
It says the Plan holds one item per entry, with the seed's counts.
It names the `[n.n]` token and the `entry` argument of `mission_plan add` for a split.
It tells the lead to assign owners and to tick each item when its entry is done.
It names two worker conventions. A worker's Roster `Doing` cell names `#<id>`, so the item reads `doing`. An entry a worker cannot build as written goes under Open questions with the entry id.

The scan of the doc's plan is `scan` in `@spinner/protocol` (`plan-entries.ts`), shared with the UI ([designs/session-workspace.md](designs/session-workspace.md), T2).
The plan section starts at a `## ` heading whose text ends with `Implementation Plan` and ends at the next `## ` heading.
A phase is a `#### Build session N[: title]` heading; an entry is a `#### n.` or `##### n.n` heading.
An entry's title is the heading text after three strips: every `**[…]**` tag, one trailing parenthetical, and surrounding whitespace. The backticks stay.
Headings inside code fences do not count. The scan reads at most 100 000 lines, 50 phases and 500 entries.

The design tracker hashes the doc on every change.
When an approval exists and the hash differs, it sets `design.changed_after_approval`, and the guard locks the lead's code writes again.
Once per new hash, it sends every running agent of the session the text "The design doc changed in <sections>; the approval is invalidated. Your code writes stay locked until the operator re-approves."
An agent without `notify` (the rpc harness) gets the text as a steer.
The daemon keeps the notified hash in memory, so a daemon restart sends the notice once more.

`GET /sessions/:dir/design/changes` answers `{ changes }`.
Each change is `{ heading, approved, current }` for one `## ` section of `approved.md` and the doc that differs by heading or body. A side without the section is null.
Text above the first `## ` heading is not compared, so the status line never counts.
`DELETE /sessions/:dir/design/approve` removes `design.approved`, `design.changed_after_approval` and `approved.md`. The lead's code writes are then locked until the next approval.

### PR body and outcome counters

With an approved design, `create PR` writes the PR body from the doc in the designs repo's worktree.
The body holds the `## Overview` body, the `## Goals` section, the doc path and the session id.
The Slack post is each PR's title with its link under it, then the reviewer's mention when one is set; the doc and the Goal stay out of it, because the PR body names the doc.
The PR reviewers' brief names the approved doc and asks them to name each place where the code differs from it.

`session.yaml` `outcomes` holds two counters: `fix_rounds` and `operator_steers`.
A `fix` job adds 1 to `fix_rounds` when it starts.
A steer through `POST /sessions/:dir/agents/lead/steer` adds 1 to `operator_steers` only when the body has `source: "operator"`. The UI's message box sets it; the extension tools do not.
`source` with any other value answers 400.
A text typed in the lead's terminal does not pass through the route, so the counter is a lower bound.
`spinner outcomes` compares the counters per PR between the design and the direct track.

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

The UI's Implement view renders this view as a phase-first list ([designs/session-workspace.md](designs/session-workspace.md), T6):
it scans the design doc with the same `scan` the seed uses and groups the Plan by the number
before the dot of each item's `entry` (`[2.3]` goes under `#### Build session 2`); an item
without an entry, or whose entry is not in the doc, goes under `Other`; an item whose entry
has another title in the doc shows a `stale` badge. The Draft view marks each entry heading
`done`, `doing`, `partial` or `none` from the states of the items linked to it. On the design
track with a named doc the goal block shows the first paragraph of the doc's `## Overview`,
read-only; otherwise it shows the Goal section, editable.

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

## Worktree sync

Every 15 seconds (`sync_seconds`; 0 is off, and off when `poll_seconds` is 0) the daemon reads each session worktree and writes `repos.<key>.sync` into `session.yaml`: `dirty` (changed tracked files), `ahead` and `behind` (against the upstream branch), `upstream` (true once the branch tracks a remote branch), `pushed` (the time of the daemon's last push), `error` (the first line of a refused push, else null). When `upstream` is true and `ahead` is above 0, the daemon runs `git push origin HEAD`, never a force. A refused push fetches the branch so `behind` is current. A worktree with a PR and no upstream gets `origin/<branch>` as its upstream first. The card and the context bar show `push failed`, `↑n unpushed` or `n uncommitted` from these facts. Agents never push themselves: the extension guard refuses `git push`, and the daemon keeps the remote branch current.
