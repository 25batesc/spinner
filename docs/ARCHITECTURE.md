# Architecture

Spinner is a local daemon with three clients: a CLI, a web UI, and (later) a desktop wrapper around that same UI. The daemon owns sessions, stacks, agent processes and the pipeline tracker that follows each PR to merge. Everything persistent is a plain file in the session directory ([SESSION_PROTOCOL.md](SESSION_PROTOCOL.md)); the daemon has no database of its own.

```
┌────────────┐   ┌──────────────┐   ┌───────────────────┐
│  spinner   │   │   web UI     │   │ desktop (Electron)│
│   (CLI)    │   │ React, Vite  │   │ wraps the web UI  │
└─────┬──────┘   └──────┬───────┘   └─────────┬─────────┘
      │  HTTP + WebSocket on localhost:7777 / unix socket
┌─────▼──────────────────▼──────────────────────▼─────────┐
│ spinnerd                                                 │
│  ├─ session store    (session.yaml, MISSION.md, watcher) │
│  ├─ pipeline tracker (GitHub PRs, checks, threads, queue;│
│  │                    Slack post; stage + needs_human) │
│  ├─ agent manager    (pi in a pty per agent tab; rpc opt)│
│  ├─ settings         (settings.yaml, themes/*.json)      │
│  ├─ usage sampler    (docker stats + ps every 5 s)       │
│  ├─ stack runner     (docker compose per session, Traefik)
│  ├─ git/gh           (worktrees, branches, PRs)          │
│  └─ event bus        (everything the UI renders)         │
└───┬──────────────┬───────────────┬──────────────┬────────┘
    │              │               │              │
 ~/.spinner/   GitHub API      pi (in a pty)   docker compose -p spinner-s17
 sessions/s17/ Slack API       cwd=worktrees/…  backend · admin · insights
               (poll/webhook)  (one per agent)  postgres(db) · temporal · traefik
```

## Components

### spinnerd (packages/daemon)

Long-running local process. Responsibilities:

- **Sessions**: create/open/close/reset; read and write `session.yaml`; watch `MISSION.md`, `agents/*/NOTES.md`, `inbox/` and turn changes into events and agent steer messages.
- **Pipeline**: collect PR facts from GitHub and the Slack post, derive each session's `stage` and `needs_human`, render `threads/`, run the fixer and the re-queue loop. Detailed below.
- **Agents**: spawn, resume, stop pi processes; multiplex their event streams to the UI; route prompts, steers, aborts; serialize `MISSION.md` writes made through the Spinner pi extension.
- **Stacks**: render `spinner.yaml` + session into `stack/compose.yaml`; `up`/`down`/`logs`/`exec`; clone the seed DB; healthchecks; expose state.
- **Git**: worktree add/remove, branch create, commit trailers, `gh pr create/view`.
- **API**: REST for commands, WebSocket for events. Single-user, local only, no auth in v1 (bind to loopback).

### Pipeline tracker (packages/daemon/src/pipeline)

The part that answers "what does each session need from me right now". It is a fact collector plus a pure function from facts to `stage` and `needs_human` ([stage table](SESSION_PROTOCOL.md#lifecycle-and-pipeline-stages)), so it is testable without GitHub: feed it a facts fixture, assert the stage.

**Facts from GitHub**, per PR, via `gh api graphql` (uses the `gh` login you already have; no app to install):

- PR state, draft flag, author login, head SHA, mergeability, `reviewDecision`.
- Checks: status check rollup on the head commit → `pending | green | red`. The check named in `github.approval_check` is split out as `approval_check`, because it is the one check a human action flips. Unset means no approval check.
- Approvals: `reviews(states: APPROVED) { author { login } commit { oid } }` → `approvals.peer` (logins other than you, on the current head) and `approvals.owner` (yours), compared against `approvals.required`, which `github.approval_policy` derives from the PR author. Example policy: a human-authored PR needs one peer; a bot-authored PR needs the peer and the person who instructed the bot. This is what tells *approving* whether the next action is yours, a peer's, or nobody's.
- Review threads: `reviewThreads { id isResolved isOutdated path line comments { author { login } body } }`. The tracker buckets each thread by the login of its first comment: logins in `github.bot_logins` are **bot** threads, everything else **human**. Open counts drive *fixing* vs *addressing*. Top-level PR comments (not threads) are shown but never counted as blocking. With no bot logins configured there is no *bot-review* stage.
- Bot re-reviews: review bots post again after substantial pushes or after a while. The tracker records `bot_reviewed_head` (the head SHA of the latest bot review) so the UI can say "reviewed 2 pushes ago", but no stage waits for a re-review; new bot threads re-enter *fixing* whenever they appear.
- Merge queue (`github.merge_queue: github | none`): `mergeQueueEntry { state position estimatedTimeToMerge }` while queued; timeline `AddedToMergeQueueEvent` / `RemovedFromMergeQueueEvent { reason }` to detect a pop-out and why (`failed_checks`, conflicts, dequeued by someone). `enqueuePullRequest(pullRequestId, expectedHeadOid)` is how `spinner land` queues; `expectedHeadOid` guarantees we queue the commit you verified. With `none`, `spinner land` merges with `gh pr merge` once the gates pass.
- Polling every 60 s per open PR, backing off when idle; GitHub webhooks (`pull_request.dequeued`, `pull_request_review`, `check_suite`) are an optional upgrade via a tunnel for people who want sub-minute updates.

**Facts from Slack**, read-only: replies and mentions under the session's Slack post, so the board can say "reviewer replied 12 min ago" or "no response for 3 h". Posting happens only through `spinner post`, after you confirm the composed message. The daemon never writes to Slack on its own.

**Derived state**: `stage`, `needs_human`, `stale`, and per-PR summaries, written to `session.yaml` and pushed as `pipeline.updated` events. Notifications (macOS notification, and a line in the UI's activity feed) fire on transitions that matter: bot review posted, checks red, reviewer activity, approved, popped out of queue, merged.

**Actions**:

- *Fixer*: an agent run with a fixed brief (`agents/fixer/BRIEF.md`, generated) and the `thread_*` tools, pointed at `threads/<repo>-<pr>.md`. Started by `spinner fix`, or automatically on new threads per `threads.autofix` (`all`: the agent answers, fixes and resolves human comments too; `bots`: humans handle humans; `off`). Threads the agent flags are surfaced in `needs_human`.
- *Approve*: `spinner approve` submits your approving review on PRs whose rule includes you (for example bot-authored PRs you adopted), after showing the head SHA and diff stat. Explicit, never automatic.
- *Re-queue loop*: on `queue: popped`, the daemon runs an agent (or plain `git rebase` when there is no conflict) to update the branch onto `base`, waits for green checks, re-enqueues with the new head, and logs it. Note that a rebase produces a new head, which invalidates your approval and the peer's; the loop re-requests approvals through `needs_human` rather than pretending the old ones carry over. If the rebase needs a decision, `needs_human` says so with the conflicting paths.
- *Landed*: when every PR is merged, stage *merged*, notification, `needs_human: "close or reset"`.

#### PR authorship

GitHub does not let a PR's author approve it. Spinner therefore opens PRs as **you** (`gh` login): agent attribution lives in commit trailers (`Spinner-Agent:`), not in the PR author, and your sign-off is the *verify* tick. Where a team's approval policy keys on the author (one peer for human-authored PRs; peer plus the instructing person for bot-authored PRs is one real example), Spinner-opened PRs fall under the human rule. `spinner approve` exists for the other case: bot-authored PRs you adopted onto the board, where the rule still wants your approval.

**Config.** The pipeline tracker is the most workflow-specific part of Spinner, so all of it is configuration. Defaults describe a plain GitHub repo: no bots, no approval check, no merge queue, no Slack. The example below is one team's setup; it lives in `~/.spinner/config.yaml` or in the project's `spinner.yaml` under `pipeline:`, never in the public repo.

```yaml
github:
  bot_logins: ["devin-ai-integration[bot]", "sonarqubecloud[bot]"]   # quoted: brackets are YAML syntax
  approval_check: "Independent Approval"   # name of the check that encodes the approval policy; unset = none
  approval_policy:
    human_author: [peer]                   # PRs Spinner opens as you
    bot_author: [peer, owner]              # adopted bot PRs; owner = the person who instructed the bot
  owner_login: your-login
  merge_queue: github                      # github | none
  poll_seconds: 60
threads:
  autofix: all             # all | bots | off
  resolve_human: true
  stale_after_hours: 3
slack:
  channel: C0XXXXXXX       # unset = no `spinner post`
  post: confirm            # confirm | never  (never auto)
```

TypeScript on Node 24. One language across daemon, CLI, UI and pi extension keeps the contributor surface small and lets the daemon import pi's exported `RpcClient` and types directly.

### spinner (packages/cli)

Thin client of the daemon. Starts the daemon if it is not running. The CLI is the first UI (M1) and stays the scripting surface forever; the web UI never does anything the CLI cannot.

```
spinner new <title> [--repos backend,admin]     spinner agent add <session> <name> [--model ...]
spinner up|down|show|logs <session>           spinner agent prompt|steer|stop <session> <name>
spinner pr <session>                            spinner msg <session> <to> "<text>"
spinner fix <session> [--pr backend]            spinner board            # all sessions: stage, needs_human
spinner verify <session> [-m "note"]            spinner threads <session> [--all]
spinner post <session> [--to @name] [--yes]     spinner approve <session> [--pr backend]
spinner land <session>                          spinner seed rebuild
spinner reset|close <session>                   spinner open <session>   # opens the UI on that session
```

### Agent adapter (packages/daemon/src/agents)

```ts
interface AgentHarness {
  spawn(session: Session, agent: AgentSpec): Promise<AgentHandle>;
  resume(session: Session, agent: AgentSpec): Promise<AgentHandle>;
}
interface AgentHandle {
  prompt(text: string): Promise<void>;        // queued if busy
  steer(text: string): Promise<void>;         // enters after the current turn + tool calls
  abort(): Promise<void>;
  events: AsyncIterable<AgentEvent>;          // text deltas, tool calls, settled, errors, usage
  stop(): Promise<void>;
}
```

Two implementations share one spawn builder (`pi_spawn_options` in `harness.ts`): `cwd` = the agent's primary worktree, `--session-dir <session>/agents/<name>/pi`, `--session-id <name>`, `--extension <spinner-extension>`, `--skill <session>/skills` when that directory has content, and the model chosen for that tab (OpenRouter is just a provider setting in pi). `resume` is the same spawn: pi reopens the transcript with that id when it exists. `config.yaml` `agents.harness` names the one `POST /sessions/:dir/agents` uses; `session.yaml` records the choice per agent under `agents.<name>.harness`.

**`PiTtyHarness`** (`tty-harness.ts`, the default since s009). pi runs interactively, in a pseudo-terminal from `node-pty`, with `SPINNER_HARNESS=tty` and `TERM=xterm-256color`. The agent tab renders that terminal with xterm.js over one WebSocket, `GET /sessions/:dir/agents/:name/tty` ([DAEMON_API.md](DAEMON_API.md#tty-websocket)). Binary frames carry the pty's bytes both ways and one text frame carries a resize. The daemon replays a 64 KiB scrollback on attach. Up to 8 clients (a browser tab and the desktop window) share one pty. The daemon never types into the pty for the operator. `prompt`, `steer` and `abort` go through the Spinner extension inside pi: the extension long-polls `GET .../commands`, turns each command into `pi.sendUserMessage` (plain, `deliverAs: "followUp"` when busy, `deliverAs: "steer"` for a steer) or `ctx.abort()`, and acks on its next poll; the route resolves with that disposition. A failed stack job sends one `notify` command the same way. The extension delivers it as a custom message that starts a turn or steers the running one. The extension posts `agent_start`, `agent_end`, `agent_settled`, `turn_end` and `tool_execution_*` to `POST .../events`, so the manager's fold, the bus and the board run unchanged. `spawn` resolves on the extension's `hello`, or 3 s after the pty started. The grace exists because pi can wait on a startup notice the operator answers in the tab.

A daemon restart: the pty master dies with the daemon and pi gets SIGHUP, so no pty survives. On start the manager (`adopt_all`) reads `agents.<name>.{pid,started}` for every agent that is not `exited`, stops a pi whose identity still matches, and resumes each `tty` agent on its transcript. The scrollback starts empty; pi redraws the transcript. An `rpc` agent is marked `exited` and resumes from the tab.

**`PiRpcHarness`** (`harness.ts`, `pi-rpc.ts`): the headless path, kept for tests and `agents.harness: rpc`. Each agent is a `pi --mode rpc` child; the daemon does the JSONL framing and ID correlation itself rather than through pi's `RpcClient`, which would pull the pi package into the daemon.

The process runs with your normal pi agent directory (`~/.pi/agent`), so your skills, extensions, prompt templates, MCP servers, credentials and user-level `AGENTS.md` all apply, exactly as in your terminal. `PI_CODING_AGENT_DIR` can point a session at a different agent directory when you want isolation.

Why RPC subprocesses instead of pi's in-process SDK: a hung or crashed agent cannot take the daemon down, each agent has its own memory and lifetime, and the same adapter works unchanged when an agent later runs *inside* the session container (`docker exec -i <workspace> pi --mode rpc`). The SDK stays an option for a lighter-weight embedding.

**Other harnesses.** The adapter interface is deliberately small, and the parts of Spinner that touch the harness are three: spawn with a working directory and a resumable transcript, stream events, inject session context. Each candidate has a headless mode that streams JSON events, so each fits:

| Harness | Headless mode | Transcript resume | Context injection |
|---|---|---|---|
| pi (v1) | `pi --mode rpc`, bidirectional; or pi's own UI in a pty since s009 | `--session-id` | `AGENTS.md` chain + extension + `--append-system-prompt` |
| Claude Code CLI | `claude -p --output-format stream-json` | `--resume <id>` | `CLAUDE.md` chain + `--append-system-prompt` |
| Codex CLI | `codex exec --json` | `codex exec resume` | `AGENTS.md` chain |
| Cursor CLI | `agent -p --output-format stream-json` | `--resume` | `AGENTS.md` / rules |

Flags are from each tool's current docs and must be re-checked when the adapter is written; the headless modes are one-shot per prompt for some tools, so the adapter resumes the transcript per turn instead of holding a process open. The session-level `AGENTS.md` ([context chain](SESSION_PROTOCOL.md#context-chain)) is what makes the mission reach every harness without a plugin; the pi extension adds tools on top. Second adapter is an M5 item.

Why pi first: scriptable (SDK + RPC + JSON event stream), model-agnostic through OpenRouter, MIT, sessions are JSONL trees that can be forked and resumed, and extensions are plain TypeScript modules that can add tools, system-prompt sections and tool hooks, which is exactly what the session protocol needs. pi 1.0 shipped on 2026-10-01; the experimental **Pi Durable** package (many concurrent conversations in one harness, multiplayer clients, durable "documents" next to transcripts, remote execution environments) is the natural v2 runtime once its API settles: the mission doc would become a durable document and the UI would attach to conversations directly.

### Spinner pi extension (packages/pi-extension)

Loaded into every agent. Injects session context into the system prompt each turn, provides the `mission_*`, `message`, `stack` and `pr` tools, and guards edits outside the agent's owned paths. Specified in [SESSION_PROTOCOL.md](SESSION_PROTOCOL.md#what-the-pi-extension-provides-m2). The role comes from `SPINNER_ROLE`: `worker`, `fixer` (adds the `thread_*` tools), `lead` (the mission tools, below) or `operator` (below).

### Chat first: the lead agent (packages/daemon/src/agents/lead.ts)

Since s014 a session is a conversation. The operator pastes what the session is about and
clicks `Start`. `POST /sessions/extract` finds the PR references in the paste
(`pipeline/extract.ts`, a pure extractor and one GitHub lookup per reference), and the UI
shows them as checkboxes. `POST /sessions { text, project, adopt }` creates the session at
once with a provisional title. One job then attaches the project and adopts the ticked PRs
(worktrees on their head branches, `adopt_into_session`). The job starts the agent `lead`
and sends it the paste as its first message. The lead runs in role `lead` with the lead brief
(`store/brief-template.ts`, kind `lead`). It owns the mission: `session_title`,
`mission_goal`, `mission_done_when` and `mission_plan` write the title, Goal, Done when and
the Plan through the section route; `agent_add` and `agent_steer` run the other agents;
`adopt` brings a PR in later. The bash guard that keeps the operator agent from pushing,
posting, approving, landing, resetting and closing applies to the lead.

The mission format carries ids and times since s014: `- [ ] 3. text (owner)` and
`- [x] 3. text (owner, 14:02)`. `pipeline/mission-sections.ts` reads and writes both forms
and the older ones. `GET /sessions/:dir/mission/view` derives the structured mission on each
read, and `mission.changed` carries it, so the UI's workspace renders the file without
parsing markdown. The file stays the source of truth; the workspace writes through the
section route's `item` mode. The operator agent below stays, off by default.

The e2e `packages/daemon/e2e/chat-first.ts` runs the real pi on a scratch daemon with the
sandbox repository cloned into the scratch. One sentence and one PR URL go in. The lead
writes a Goal and three Plan items within two minutes, and ticks one after a steer.

### The operator agent (packages/daemon/src/agents/operator.ts)

One agent per home, outside every session. It runs Spinner for the operator the way a parent chat did before s013. It turns a request into a session, a mission and briefs. It starts the agents, relays what they ask, and reports. It is a tty pi like a session agent. `OperatorHost` hosts it over the same `PiTtyHarness.spawn_pty` and extension channel. The differences:

- Its files live under `<home>/operator/`: the transcript in `pi/` (`--session-dir <home>/operator/pi --session-id operator`), `BRIEF.md`, and `process.json`. The last holds the pid and start time, so a restart can stop a pi that outlived a crashed daemon. Its cwd is the home. It has no worktree and no stack. It reads and writes sessions only through the daemon.
- The daemon starts it after `adopt_all` when `settings.operator.enabled` is true (off by default since s014). On restart it resumes on the same transcript. `POST /operator/stop` and `POST /operator/start` stop and resume it. `SPINNER_OPERATOR=off` keeps it off for a headless run. Its model is `settings.operator.model`, else `settings.default_model`, else the daemon's default.
- `store/operator-brief.ts` writes `BRIEF.md` once, when absent, so the operator can edit it. The brief says what Spinner is and how a session is shaped. It says how a request becomes a mission and briefs. It says that the agent starts agents without asking. It says that the agent never pushes, posts, approves, lands, resets or closes without the operator's word.
- The extension in role `operator` registers `session_new`, `session_adopt`, `session_attach`, `session_list`, `session_show`, `mission_write`, `brief_write`, `agent_add`, `agent_steer` and `inbox_send`. It keeps `stack` and `pr`, which take a `session` argument in this role. Each tool is one daemon call with the body the UI sends, so the daemon's validation and Log apply. A tool that starts a job waits for it. A `bash` call that runs `spinner pr|post|approve|land|reset|close`, `git push` or `gh pr create|merge|review` is blocked. The message says the operator must do it.
- The host subscribes on the bus and turns five events into notices through the channel's `notify`. The events are `needs_human` set (a `session.updated` where it goes from null to text), `agent.settled`, `agent.exited`, `job.finished` with `ok: false`, and an `inbox.message` to `operator`. Notices are batched for one second, one line per event. Each line starts with the session directory. The queue holds 100 lines. Past that the oldest go, and the notice says how many. Lines wait while the agent is stopped.
- `GET /operator` and `operator.updated` carry the view: `process`, `ready`, `pid`, `model`, `waiting_on`, `last_notice`, `notices_pending`. The UI's operator tab renders it over the pty at `GET /operator/tty`.

The e2e `packages/daemon/e2e/operator.ts` runs the real pi on a scratch daemon. The request is "start a session for the sample stack named Refund flow with one agent `backend` that adds a health endpoint". The result is a session on a scratch copy of the sample project, a mission with a Goal and Plan items, a brief, and a running `backend`. The agent's `agent.settled` reaches the operator agent as a notice.

### Reviews (packages/daemon/src/pipeline/reviews.ts, agents/swarm.ts, agents/review-lead.ts)

A review (s015) is a session of `kind: review`: a place for a peer's PR, with no project and
no stack. `POST /reviews { text }` runs the extractor over a paste and makes one session per
PR. The repository is cloned once under `<home>/reviews/<owner>-<name>/` and fetched per
review (`refs/pull/<n>/head`, so a fork's PR works too). The PR head is checked out detached
under the session's `worktrees/<name>`, so nothing can be pushed from it. The PR facts go
into `session.yaml` as an adopted PR's, and the poller, the threads and the board track it
with no new machinery. The view adds `kind` and `review` (`ReviewFields`: the checks with
the failing names, the decision, the thread count, the swarm, and since s016 `briefing`,
`draft` and `posted_url`), and `review.updated` follows each change.

The review process (s016) is the operator's `pr-review` skill, end to end, with the daemon
in the loop. The paste starts two kinds of agent in the PR worktree, as one job. Both run
headless on the rpc harness: an interactive pi's startup screen (skill conflicts, the update
banner, "press any key") ate the first message in real use and left three terminals at an
empty prompt. A headless agent has no pty and no terminal tab (`/tty` answers 409); its only
outputs are the briefing, the verdict files and the draft:

- The agent `lead` (model `settings.default_model`), with the skill as its brief
  (`store/review-brief.ts`, `render_review_lead_brief`: the skill's rules word for word;
  where the skill launches three `subagent` calls, the daemon has started the reviewers;
  where it posts after the user's yes, the lead writes a draft and the operator posts). The
  lead reads the PR and writes the briefing with `review_briefing` while the reviewers read,
  then waits.
- The swarm: one tty agent per model of `settings.review.models`, named
  `review-<model-slug>`, with the operator's `reviewer` role as its brief word for word, the
  rulebook (`engineer-conventions`, `backend-conventions`, `principles`) named by path next
  to `settings.review.skill`, and the role's two skills through `--skill`. A reviewer reads
  only, never posts, and ends with the role's `VERDICT` block.

Each reviewer is an ordinary agent of the session, so its transcript and its cost come from
what exists; the deliverer leaves the `review-*` agents out of mission and notes notices. The swarm keeps each reviewer's state in `session.yaml` under `review.swarm`.
`queued` is a reviewer behind the running-agents cap. `reading` is one that started. `done`
is one whose settled turn ended with a `VERDICT: BLOCKING` or `VERDICT: CLEAR` line: the
daemon saves that text as `artifacts/reviews/<model-slug>.md` and stops the pi, so the slot
frees and the next queued reviewer starts. `failed` is a start that failed or an exit
without one; the record carries the reason (the start error, else the last assistant text,
else the exit code, truncated to 300 characters) and the chip shows it as
`SwarmMember.error`, because there is no terminal to read. When no reviewer is `queued` or
`reading` any more, the lead gets the verdicts notice, with the files by absolute path and
the lead-judgment rules: a tty lead through the extension channel (`notify`), a headless
lead as a prompt when idle and a steer while it runs; a lead that is not running gets it
with its next prompt. The lead reconciles and writes the
one review with `review_draft`.

The draft (`pipeline/review-draft.ts`) is validated before it is written: `event` is
`APPROVE` or `COMMENT` (`APPROVE` with a `BLOCKING:` comment is refused), each comment body
starts with `BLOCKING:`, `BUG:`, `NIT:` or `SUPER NIT:`, and each `path:line` is on the
right side of the PR diff, read from `gh api repos/:o/:r/pulls/:n/files` (added and context
lines). A bad draft returns every fault and writes nothing. A good one is
`artifacts/review-draft.json`; `review.draft: true` in `session.yaml` makes the tracker set
`needs_human` to `post or drop the review draft`, which wins over the pipeline's own text.
The operator edits the draft through the same route, drops it, or posts it:
`POST /sessions/:dir/review/post` is the only path that posts, one PR review through the
operator's `gh` (`gh api --method POST .../reviews --input`) at the head SHA with
`comments[]` on `side: RIGHT`; an `APPROVE` GitHub refuses for the author's own PR is
reposted as `COMMENT` and the answer says so. The URL lands in `session.yaml`
(`review.posted_url`), in `artifacts/review-posted.json` and in one Log line; the draft file
goes. The write guard applies: a review session's PR repo is allowed (the session exists
for it, on the operator's paste); an ordinary session's PR must be on its project's
`write_repos`. The lead role's bash guard refuses `gh pr review`, `gh pr comment` and `gh
api` writes, so the lead cannot post by hand.

`review` on an ordinary session with an open PR runs the same headless swarm (`POST
/sessions/:dir/review`); its lead is the session's own `lead`, which stays tty and gets the
same notice. On a review session the route runs a second round. `review-blast` is no longer
called. The view sums the review up for the card: `review.state` is `drafted` while a draft
exists, else `reviewing` while a reviewer is `queued` or `reading` or the lead runs a turn,
else `posted` once a review went up, else `idle`; `review.comment_count` and `review.event`
are the draft's.

### Skills and context files

Two things the operator asked for by name, and the daemon treats them as first-class:

- **Skills.** Your pi skills load unchanged (user skills from `~/.pi/agent/skills/`, project skills from the repo's `.pi/skills/` once the project is trusted, pi packages). A session can add its own under `<session>/skills/`. The daemon asks each agent for `get_commands` and shows the loaded skills, prompt templates and extension commands with their source paths.
- **Context files.** The daemon computes each agent's context chain (user file → session `AGENTS.md` → repo → subdirectory) from its working directory, watches the files, and exposes them read-write through the API. The UI's *Context* tab shows the chain, marks which files git tracks, and edits any of them in place. The daemon regenerates the session `AGENTS.md` whenever the mission, the brief or the stack hostnames change, and reloads the agent's context before its next turn.

### Settings and themes (packages/daemon/src/settings.ts)

Two files hold configuration under `~/.spinner/`, for two readers. `config.yaml` is the daemon's: `pi_bin`, `port`, `default_model`, `agents.harness`, Slack. The daemon reads it once at start and nobody edits it from the app. `settings.yaml` is the operator's: `theme`, `default_model`, `agents.harness`. The UI and the desktop app edit it through `PUT /settings`, which validates the whole document, writes the file, and publishes the `settings` event. Every window follows the event, so a theme change applies at once. A hand edit shows on the next `GET /settings`.

A theme is one `ThemePalette`: ten UI colours and a `terminal` block with the foreground, background, cursor and the 16 ANSI colours. The built-ins (`light`, `dark`, `rainbow`) are JSON files in the protocol package, so the web UI and the desktop app share one definition. A user palette is `~/.spinner/themes/<name>.json`. `GET /themes` lists the built-ins and the valid user files, and names each invalid file with its missing keys. The UI maps the palette onto CSS variables and hands the `terminal` block to xterm.js. The reason for palette files over CSS: an operator writes one JSON file and both the page and the terminal follow it. [DAEMON_API.md](DAEMON_API.md#settings) has the shapes.

### Usage sampling (packages/daemon/src/stack/usage.ts)

The operator asked how much each session costs the machine. A sampler runs every 5 s while at least one stack is up or starting, one sample in flight at a time. It stops when no stack is up and wakes after a job or a stack change. One sample runs three commands. `docker ps` with the compose labels maps containers to a session and a service. `docker stats --no-stream` reads every container. `ps -axo pid,ppid,rss,%cpu` lists every process. A host service's numbers are the sum over its process tree, from the pid in `stack/pids/<name>.pid` down. The sample lives in the daemon's memory, never in `session.yaml`.

The view carries the last sample as `stack.usage` and `services[].usage`. `GET /usage` and the `usage` event carry the machine line (total and available memory, cpu count, load) and every up stack with its services. The UI shows the stack line on each session card, the machine line in the context bar, and six columns in the `services` view. The reason for one sampler over per-request probes: `docker stats` takes about a second, and every open window would otherwise run it. [DAEMON_API.md](DAEMON_API.md#resource-usage) has the fields.

### The diff tab (packages/daemon/src/diff)

The operator wants to see what a session changed without a terminal or GitHub. The daemon
runs one `diffview` per repo of a session, in that repo's worktree, as a Spinner-managed host
process (MISSION.md s012). `diffview` is a local viewer for stacked branches with comments
on lines. It is not a package dependency: its `package.json` names its comment library as
`file:../peanut`, and the library ships TypeScript that Node refuses to run from under
`node_modules`. So the first `POST /sessions/:dir/diff/start` clones both repositories at
the commits in `pins.ts`, side by side under `<home>/diffview/src/`, and runs `npm install`
there, as a job with a log, bounded at 5 minutes. The tab is off until that fetch succeeds,
and `spinner doctor` says so. `<home>/diffview/` is also `DIFFVIEW_HOME`, the comment store.

`viewer.ts` starts a viewer detached on a port from the top of the session's host half,
waits on the viewer's own registry file for the port it took, records it under `session.yaml`
`diff.repos.<repo>`, and stops it by pid identity like a host service. `actions.down` and
`actions.close` stop the viewers before the stack, so the CLI path works without the daemon.
`manager.ts` owns the fetch state, the starts in flight and `SessionView.diff`. Viewers start
on the first click of the UI's `diff` tab, not with `up`, and outlive the daemon; a restart
reattaches them.

`watcher.ts` parks `diffview comments wait` per viewer in 30 s rounds. A new thread waiting
on the agent becomes one `notify` to the session's tty agents, at most 2 per second. Each
round records the unresolved threads under `diff.threads`; the tracker reads the ones
waiting on the operator as `PipelineFacts.diff_waiting`, and `derive_stage` makes the oldest
one `needs_human` when the pipeline has nothing for the operator. The worker role's
`diff_comments` and `diff_reply` tools call `POST /sessions/:dir/agents/:name/diff/comments`;
the daemon runs the CLI in the agent's worktree, signed as the agent, and hands back its
output. The reason for routing the CLI through the daemon: the extension holds no state and
does not know where the viewer is. [DAEMON_API.md](DAEMON_API.md#the-diff-tab) has the shapes.

### EGM (Elephant-Goldfish Model)

Elephant-Goldfish Model by Google, Apache-2.0. Spinner runs its skills from a pinned copy. Not an officially supported Google product. Source: https://github.com/google/elephant-goldfish-model. The design is [designs/egm-adoption.md](designs/egm-adoption.md); build session 1 adds the harness adapter described here.

The daemon fetches EGM like the diff viewer: a shallow clone of one commit, with no install step and no code run from the checkout. The pin is `EGM_PIN` in `packages/daemon/src/egm/pins.ts`. A moved pin, or a moved `EGM_ADAPTER_VERSION`, fetches again. A lead start fetches it when pi-subagents is installed, and `POST /egm/fetch` refetches it on request.

```text
~/.spinner/egm/
├── src/            google/elephant-goldfish-model at the pin
├── pi/agents/      one pi-subagents agent file per persona, generated at fetch time
└── fetched.json    { sha, adapter_version, fetched }, written last
```

The adapter mirrors EGM's `.claude-plugin/agents/*.md`. Each generated file names the canonical persona under `src/agents/` and restricts the child's tools and context. Every adapter sets `systemPromptMode: replace`, the three `inherit*` fields to false, an empty `extensions:` and `defaultContext: fresh`.

| Kind | Persona file | `tools` |
| --- | --- | --- |
| reviewer | every file except the two below | `read, grep, find, ls`, with `acceptanceRole: read-only` |
| synthesizer | `synthesizer.md` | `read, grep, find, ls, write`; no `subagent`, so the lead dispatches each Goldfish itself |
| bootstrap | `bootstrap_orchestrator.md` | `read, grep, find, ls, write, edit, bash, subagent` |

`AgentManager.add` asks `egm_spawn` for EGM paths when four conditions hold. The agent is the `lead`, the session is of kind `session`, EGM is fetched, and the operator's pi settings list pi-subagents. The paths are computed at each spawn, so a resume after a fetch picks them up. `pi_spawn_plan` then adds:

| Item | Value | Why |
| --- | --- | --- |
| `--skill` | `<home>/egm/src/skills` | pi discovers the 7 EGM skills. |
| `--exclude-tools` | `subagents_enable` | Keeps `subagent` active from the first request. |
| `PI_SUBAGENT_EXTRA_AGENT_DIRS` | `<home>/egm/pi/agents` | pi-subagents loads the adapters as user agents. |
| `PI_SUBAGENTS_TEMP_ROOT` | `<session>/egm-runs` | Async run status files land inside the session. |
| `SPINNER_EGM_ROOT` | `<home>/egm/src` | The extension's prompt section names the plugin root. |
| `SPINNER_EGM_ARTIFACTS` | `<session>/design` | The extension's prompt section names the artifact directory. |

The session `AGENTS.md` of every ordinary session names the EGM artifact directory, as EGM's `docs/harnesses.md` defines that override. A review session has no EGM lines.

Four layers keep a Goldfish free of the lead's context:

1. The adapter's `defaultContext: fresh`, `systemPromptMode: replace` and the three `inherit*: false` fields.
2. The adapter's empty `extensions:`, which disables discovered extensions in the child.
3. The Spinner extension registers nothing when `PI_SUBAGENT_CHILD` is `1`. Without this check a child would carry `MISSION.md` and take the lead's commands.
4. The `tools:` allowlist, which pi enforces. It is not a filesystem sandbox.

The tty channel rewrites a prompt or a steer that starts with `/skill:<name>`. `pi.sendUserMessage` does not expand it, so the extension sends "Read the skill file at `<path>` and follow it in this thread". The evidence for each layer and each probe is in [egm/HARNESS_EVIDENCE.md](egm/HARNESS_EVIDENCE.md).

Build session 3 puts the skills and the gates in the app ([DAEMON_API.md](DAEMON_API.md#gates-and-skill-runs)):

```text
UI button ──POST …/design/run──▶ daemon: archive the review run, compose the arguments ──prompt──▶ lead
lead ──ask_question──▶ extension: check EGM's payload ──PUT …/design/gate──▶ session.yaml design.gate
UI gate card ──POST …/design/answer──▶ daemon: clear the gate ──prompt──▶ lead
```

| Module | Role |
| --- | --- |
| `egm/gate.ts` | `set_gate` checks the lengths and writes `design.gate`; `clear_gate` removes it. Both re-read `session.yaml` right before they write. |
| `egm/review-runs.ts` | `archive_review_run` moves the current run's reports into `design/reviews/<id>/` and returns the next free id. |
| `egm/routes.ts` | The gate, answer and run routes, and the argument table of Technical Plan T9. |
| `egm/design.ts` | The tracker passes `lead_busy` from `AgentManager.is_busy`, sets `design.waiting` when the lead settles on a question, and clears a gate on a later `agent_start` of the lead. |
| `server.ts` | A prompt or a steer to the lead clears its gate before it is sent. |

The lead brief of a new session has a "Design (EGM)" section: the lead proposes a track, starts no EGM skill on its own, asks each gate with `ask_question`, and writes only the design doc and the session's files before approval.
The extension's prompt section names the designs directory from `.state.json` on the design track.

Build session 4 makes the Goldfish visible ([DAEMON_API.md](DAEMON_API.md#goldfish)). The Goldfish are not daemon agents. They run inside the lead's pi, so the daemon observes the files that pi-subagents writes:

```text
lead pi ──subagent (async)──▶ <session>/egm-runs/async-subagent-runs/<runId>/status.json
lead pi ──subagent (foreground)──▶ agents/lead/pi/subagent-artifacts/<runId>_<agent>_<step>_*
        each child's pi session: agents/lead/pi/<lead session>/<runId>/run-<i>/session.jsonl
GoldfishWatcher (2 s poll) ──on change──▶ DesignTracker.refresh ──▶ session.updated (chips)
CostLedger ──steps[].sessionFile──▶ rows with child ──▶ SessionCost.children
```

| Module | Role |
| --- | --- |
| `egm/goldfish.ts` | `read_runs` reads the async and foreground runs; each Goldfish shows once. `GoldfishWatcher` polls, attributes new runs in `runs.json`, and counts live Goldfish. |
| `costs/ledger.ts` | Folds each step's transcript inside `<session>/agents/` as rows of the lead with `child`. They sum into `SessionCost.children`. |
| `egm/design.ts` | The view fills `goldfish`, `goldfish_live` and `cost_by_stage`. A running Goldfish keeps the "lead waits" line off. |
| `egm/routes.ts` | The Goldfish transcript route, the global cap of 12 live Goldfish on `POST …/design/run`, and the workspace reads of build session 5. |

A result reaches the lead without the daemon. An async launch returns a receipt at once. pi-subagents delivers a completion notice into the lead's session when the run ends, and the lead can block on `bg_wait`. The prompt section tells the lead to wait for every Goldfish of a stage before it consolidates.

The global cap holds new skill starts only. The daemon cannot stop a launch inside pi, so a lead that is already in a skill can pass the cap by one stage's fan-out. Cost is shown, not enforced.

### Storage

Files, no database. Every session is a directory of YAML, Markdown and JSONL under `~/.spinner/sessions/` ([layout](SESSION_PROTOCOL.md#where-everything-lives)); the daemon's only state is process handles and an in-memory index it rebuilds from the tree at start. Reasons: an agent reads and writes the same files with its ordinary tools; a person can `cat`, `grep` and `git`-archive a session; the pi transcripts are already JSONL files; there is no migration tooling beyond the `version` field; and a crashed daemon loses nothing.

What a database would buy, and when to add it: queries across hundreds of sessions (history, cost per week, average time in *peer-review*), multiple operators sharing one daemon, or a remote daemon. The answer then is a SQLite file under `~/.spinner/` used as an **index** that can be deleted and rebuilt from the files, never as the source of truth. Pi Durable's own storage (SQLite or JSONL) fits the same rule if it becomes the runtime.

### Configuration layers

Spinner is generic; your workflow is configuration. Settings merge in this order, later wins:

1. Built-in defaults: a plain GitHub repo, no bots, no Slack, pi as the harness.
2. `~/.spinner/config.yaml`: your defaults for every project.
3. The project's `spinner.yaml` (`harness:` and `pipeline:` blocks), found in the repo, in `local/`, or in `~/.spinner/projects/`.
4. `spinner new --set key=value` for one session, recorded in `session.yaml`.

The public repo contains only layer 1 and the `examples/` stacks. Layers 2 to 4 are on your machine.

### Git hygiene

Nothing private can reach the public repo by accident:

- Live sessions are under `~/.spinner/`, outside every repository.
- Each worktree's `.spinner` symlink is listed in that repo's `.git/info/exclude`, which is per-clone and never committed.
- A Spinner checkout ignores `.spinner` and `local/` through `.gitignore`; `local/` is where private stack specs live.
- `examples/sessions/` holds templates. Running one copies it out to `~/.spinner/sessions/`; transcripts never exist inside the repo.
- `spinner doctor` (planned for M2; today `spinner new` does the first check) refuses a `~/.spinner` that sits inside a git repository and warns if a worktree contains session files.

### Stack runner (packages/daemon/src/stack)

One `docker compose` project per session, generated from the project's `spinner.yaml` ([STACK_SPEC.md](STACK_SPEC.md)). Source code is bind-mounted from the session's worktrees so dev servers hot-reload; dependencies live in named volumes keyed by lockfile hash so sessions with the same lockfile share an install.

**No host ports per service.** A single Traefik container (`spinner-proxy`) listens on `:80` and routes by hostname using Docker labels that the runner puts on every service:

```
admin.s17.localhost     → spinner-s17 / admin:5173
insights.s17.localhost  → spinner-s17 / insights:5173
api.s17.localhost       → spinner-s17 / backend:3000
temporal.s17.localhost  → spinner-s17 / temporal:8233
```

This solves three things at once: port collisions vanish (only Traefik binds a host port); **cookies stop colliding** (browsers scope cookies by host, not port, so two branches on `localhost:3000` and `localhost:3001` share a cookie jar and log each other out; `admin.s17.localhost` and `admin.s18.localhost` do not; checked on 2026-10-27 with two sessions of a stack whose auth service is shared: each origin keeps its own token); and URLs become predictable enough to put in agent briefs and PR descriptions. Traefik middleware also strips `X-Frame-Options` / `frame-ancestors` from any service we want to embed, so third-party UIs like Temporal's work in a preview pane without changes.

`*.localhost` resolves to loopback without configuration in Chromium and Firefox. Safari and `curl` use the system resolver, which on macOS does not resolve subdomains of `localhost`; `spinner doctor` offers to add `/etc/hosts` entries per session (or a `dnsmasq` resolver) for those.

**Database.** Default: one shared `spinner-postgres` container holding a seed **template database** (`<project>_seed`, built from migrations + fixtures or a scrubbed dump by `spinner seed rebuild`). `spinner up` runs `CREATE DATABASE spinner_s17 TEMPLATE acme_seed`, which is a file copy and takes seconds. Each session's services get their own `DATABASE_URL`; branch migrations only touch that database. Fallback: a Postgres container per session from a prebuilt image whose data directory already contains the seed, for branches that need a different Postgres version or extension.

**Temporal.** One dev server per session (`temporal server start-dev`) as a compose service, UI exposed at `temporal.<id>.localhost`. Not shared across sessions: workers from one branch must never pick up tasks queued by another.

**Targets.** `spinner up` warm in under 15 s, `down` in under 5 s; `close` removes containers, volumes and the session DB. Compose healthchecks drive the UI: a preview pane stays grey until its service is healthy.

Where agent tools run: on the host, in the worktree, in v1. v2 adds an optional `workspace` service in the compose project (pi publishes a Dockerfile recipe) so an agent's shell runs inside the session's network with no host access, with provider keys injected per container or substituted by a proxy such as Docker Sandboxes.

### Web UI (packages/ui)

React + Vite, served by the daemon at `http://localhost:7777`. Three panes from the sketch:

- **Sessions / board** (left): every session with its pipeline stage, its `needs_human` line, and badges (stack up/down, agents working/blocked, checks, open bot/human threads, queue position). Sorted so sessions waiting on you are on top. `new session`. The same data is `spinner board` in the terminal.
- **Activity feed** (bottom of the middle pane): pipeline transitions and notifications across all sessions ("s17: review bot posted 4 comments", "s14: popped out of queue, rebasing", "s12: merged"), so you never have to visit a tab to learn something changed.
- **Context tab** (per agent): the agent's context chain (user, session, repo, directory files), each editable, with git-tracked files marked; the loaded skills and commands with their paths.
- **Agents** (middle): one tab per agent, chat transcript rendered from pi events (text, tool calls with collapsible output, cost), prompt box, `create PR / run local / stop local`, a mission panel showing `MISSION.md` with the Roster highlighted and the operator's sections editable in place.
- **Previews** (right): tabs for admin / insights / api / temporal, each an embedded view of that session's hostname, with open-in-new-window, reload and a "report to agent" button that drops the current URL and a screenshot into a message.

Everything in the UI is driven by daemon events; the UI holds no state the daemon does not.

## Web app vs desktop app for the embedded previews

Both shells give you the thing you asked for: sidebar, agent chat and running previews in one encapsulated window per workbench, with each session's stack reachable at its own hostnames. They differ in how the preview panes are embedded and what you can do with them.

**Web app (browser tab, or Chrome's "Install app" for a standalone window).** A preview is an `<iframe src="http://admin.s17.localhost">`. Nothing special is needed for your own apps; for anything that sends frame-blocking headers, Traefik strips them. Devtools work on iframes. The limits are browser policy: the Spinner page cannot read the iframe's console or network log (cross-origin), and the preview's login cookies are "third-party" from the Spinner page's point of view, so they work in Chrome with default settings, in Firefox (partitioned, but consistently), and not in Safari, which blocks them. Practical answer: use Chrome, which is where you already live.

**Desktop app (Electron).** A preview is a `WebContentsView` placed inside the window. It is a top-level page, so frame headers and cookie policy do not apply at all, and each session can get its own cookie jar via a `partition`. The real gain is what the daemon can do with it: capture the preview's console errors and failed requests and hand them to the agent automatically, take a screenshot on demand and attach it to a message ("this is what I see at /refunds"), pop a preview out into its own native window on another monitor, and open per-preview devtools. The costs are packaging, signing and notarization on macOS, auto-update, and a second process model that contributors have to understand. Tauri is lighter but its multi-webview support is still behind an unstable flag, so Electron is the safer pick when the time comes.

**Recommendation.** Web first, built so the Electron wrap is a thin shell. The UI is a pure web app that talks only to the daemon; the preview component is the one place that knows whether it is an iframe or a `WebContentsView`. Milestone M3 ships the web UI; M4 adds the Electron wrapper and the console/screenshot-to-agent feedback loop, which is the feature that makes the desktop version worth its weight.

## Repository layout

```
spinner/
├── packages/
│   ├── protocol/       shared types: session.yaml schema, events, REST/WS API, spinner.yaml schema
│   ├── daemon/         spinnerd: sessions, agents, stack, git, API
│   ├── cli/            spinner
│   ├── pi-extension/   loaded into every pi agent
│   ├── ui/             React app
│   └── desktop/        Electron wrapper (M4)
├── docs/
├── sessions/           dogfood sessions used to build Spinner (committed as worked examples)
├── examples/
│   ├── sample-stack/   tiny api + web + Postgres anyone can run; the CI vehicle for the stack runner
│   └── sessions/       dogfood session templates (s001, s002), copied out to ~/.spinner to run
├── local/              gitignored: private stack specs (local/<project>/spinner.yaml)
└── tools/              doc-metrics.py and other repo tooling
```

pnpm workspace, TypeScript throughout, Node 24, Vitest. Docker Desktop (or OrbStack) is a hard requirement for stacks; `gh` for PRs; `pi` installed globally or vendored as a dependency.

## Event model

One event bus in the daemon; the UI and CLI subscribe over WebSocket.

```
session.created  | session.updated | session.closed
pipeline.updated (stage, needs_human, per-PR facts) | pipeline.transition (from, to, why)
pr.updated       (repo, number, state, checks, threads, review, queue)
threads.updated  (repo, number, opened[], resolved[])  | queue.popped (repo, number, reason)
slack.activity   (post, author, kind: reply | mention | reaction)
agent.spawned    | agent.event (pi JSON event passthrough) | agent.settled | agent.exited
stack.state      (per service: starting | healthy | unhealthy | stopped) | stack.log
mission.changed  (section diff, author) | inbox.message
usage            (machine, every up stack and its services; once per sample)
settings         (the whole settings document, after a PUT)
operator.updated (the operator agent's view: process, ready, waiting_on, last notice)
review.updated   (the review facts: checks, failing, decision, threads, the swarm)
```

`agent.event` is pi's own JSON event stream forwarded untouched, so the UI renders exactly what a pi TUI would and nothing is lost in translation.

## Decisions so far

- Plain files for all session state; the daemon is stateless apart from process handles.
- The pipeline stage is derived from collected facts, never set by hand; `needs_human` is a single line per session and the board sorts by it.
- GitHub via `gh api graphql` polling first; webhooks optional later. Bot vs human review threads are told apart by author login.
- Slack is read-only except `spinner post`, which posts only after you confirm the composed message.
- The fixer's reach is configuration (`threads.autofix`, `threads.resolve_human`); the example team runs `all`. Design questions get flagged, not argued.
- Files, no database. A SQLite index is allowed later only as a rebuildable cache.
- The core (sessions, worktrees, stacks, agents, mission, previews) is generic. The pipeline tracker is configuration with plain-GitHub defaults. Private config lives in `~/.spinner/` or `local/`, never in the repo.
- Your harness configuration is inherited: pi runs with your agent directory, so your skills, extensions and `AGENTS.md` apply.
- `spinner verify` and `spinner approve` are explicit operator gates; verify is cleared by any new push, approvals are re-requested after a rebase.
- No stage waits for a bot re-review; new bot threads re-enter *fixing* whenever they appear.
- pi in a pseudo-terminal per agent, rendered in the tab; the RPC subprocess stays for headless runs. The adapter interface is kept narrow so another harness can be added.
- The daemon's configuration and the operator's preferences are two files; the app edits only the second.
- Resource usage is sampled by the daemon, kept in memory, and pushed on the bus; nothing is written to the session.
- Hostname-per-service-per-session behind one Traefik, no host ports per service.
- Shared Postgres with template-database clones by default; per-session Postgres as the escape hatch.
- Temporal per session, never shared.
- Web UI first; Electron wrapper later; the UI never talks to anything but the daemon.
- TypeScript monorepo.

## Open questions

- Frontends that bake the API URL at build time: do admin and insights read `API_URL` at runtime in dev? If not, each session needs its own build or a runtime config shim.
- How big is the seed? Template cloning is fast up to a few GB; past that, a prebuilt per-session image or a ZFS/overlay snapshot approach is better.
- Does the backend need any other services (Redis, queues, S3-compatible storage) per session?
- Agent transcripts in the session directory contain code and possibly secrets from tool output. Archive policy on `close`?
- Model routing: fixed model per agent tab, or let the brief pick (cheap model for review agents)?
- For the example team's approval action: does it re-run on every `pull_request_review` only, or also on `synchronize`? Decides whether a rebase shows `approval_check: pending` immediately or only after the next review event.
- Does that action identify "the person who instructed the bot" from the PR body or from the bot's own session? For adopted bot PRs the tracker assumes `owner_login`.
- Slack permissions: reading the channel of the Slack posts needs a user or bot token with `channels:history`; which one is acceptable?
- Does pi reload context files in RPC mode without a restart? If not, the daemon restarts the process between turns after a *Context* edit.
- Codex and Cursor: do they read `AGENTS.md` from directories above the git root? If not, the session file must be linked into the worktree instead (gitignored).
