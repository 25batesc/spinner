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
│  ├─ agent manager    (pi RPC subprocess per agent tab)   │
│  ├─ stack runner     (docker compose per session, Traefik)
│  ├─ git/gh           (worktrees, branches, PRs)          │
│  └─ event bus        (everything the UI renders)         │
└───┬──────────────┬───────────────┬──────────────┬────────┘
    │              │               │              │
 ~/.spinner/   GitHub API      pi --mode rpc   docker compose -p spinner-s17
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

v1 implementation: **`PiRpcHarness`**. Each agent tab is a `pi --mode rpc` child process started with `cwd` = the agent's primary worktree, `--session-dir <session>/agents/<name>/pi`, `-e <spinner-extension>`, `--skill <session>/skills` when that directory exists, `--approve` when `harness.pi.trust_projects` is on, and the model chosen for that tab (OpenRouter is just a provider setting in pi). pi exports an `RpcClient` that does the JSONL framing, ID correlation and `agent_settled` tracking; the adapter is a thin wrapper around it.

The process runs with your normal pi agent directory (`~/.pi/agent`), so your skills, extensions, prompt templates, MCP servers, credentials and user-level `AGENTS.md` all apply, exactly as in your terminal. `PI_CODING_AGENT_DIR` can point a session at a different agent directory when you want isolation.

Why RPC subprocesses instead of pi's in-process SDK: a hung or crashed agent cannot take the daemon down, each agent has its own memory and lifetime, and the same adapter works unchanged when an agent later runs *inside* the session container (`docker exec -i <workspace> pi --mode rpc`). The SDK stays an option for a lighter-weight embedding.

**Other harnesses.** The adapter interface is deliberately small, and the parts of Spinner that touch the harness are three: spawn with a working directory and a resumable transcript, stream events, inject session context. Each candidate has a headless mode that streams JSON events, so each fits:

| Harness | Headless mode | Transcript resume | Context injection |
|---|---|---|---|
| pi (v1) | `pi --mode rpc`, bidirectional | `--session-id` | `AGENTS.md` chain + extension + `--append-system-prompt` |
| Claude Code CLI | `claude -p --output-format stream-json` | `--resume <id>` | `CLAUDE.md` chain + `--append-system-prompt` |
| Codex CLI | `codex exec --json` | `codex exec resume` | `AGENTS.md` chain |
| Cursor CLI | `agent -p --output-format stream-json` | `--resume` | `AGENTS.md` / rules |

Flags are from each tool's current docs and must be re-checked when the adapter is written; the headless modes are one-shot per prompt for some tools, so the adapter resumes the transcript per turn instead of holding a process open. The session-level `AGENTS.md` ([context chain](SESSION_PROTOCOL.md#context-chain)) is what makes the mission reach every harness without a plugin; the pi extension adds tools on top. Second adapter is an M5 item.

Why pi first: scriptable (SDK + RPC + JSON event stream), model-agnostic through OpenRouter, MIT, sessions are JSONL trees that can be forked and resumed, and extensions are plain TypeScript modules that can add tools, system-prompt sections and tool hooks, which is exactly what the session protocol needs. pi 1.0 shipped on 2026-10-01; the experimental **Pi Durable** package (many concurrent conversations in one harness, multiplayer clients, durable "documents" next to transcripts, remote execution environments) is the natural v2 runtime once its API settles: the mission doc would become a durable document and the UI would attach to conversations directly.

### Spinner pi extension (packages/pi-extension)

Loaded into every agent. Injects session context into the system prompt each turn, provides the `mission_*`, `message`, `stack` and `pr` tools, and guards edits outside the agent's owned paths. Specified in [SESSION_PROTOCOL.md](SESSION_PROTOCOL.md#what-the-pi-extension-provides-m2).

### Skills and context files

Two things the operator asked for by name, and the daemon treats them as first-class:

- **Skills.** Your pi skills load unchanged (user skills from `~/.pi/agent/skills/`, project skills from the repo's `.pi/skills/` once the project is trusted, pi packages). A session can add its own under `<session>/skills/`. The daemon asks each agent for `get_commands` and shows the loaded skills, prompt templates and extension commands with their source paths.
- **Context files.** The daemon computes each agent's context chain (user file → session `AGENTS.md` → repo → subdirectory) from its working directory, watches the files, and exposes them read-write through the API. The UI's *Context* tab shows the chain, marks which files git tracks, and edits any of them in place. The daemon regenerates the session `AGENTS.md` whenever the mission, the brief or the stack hostnames change, and reloads the agent's context before its next turn.

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
- `spinner doctor` refuses a `~/.spinner` that sits inside a git repository and warns if a worktree contains session files.

### Stack runner (packages/daemon/src/stack)

One `docker compose` project per session, generated from the project's `spinner.yaml` ([STACK_SPEC.md](STACK_SPEC.md)). Source code is bind-mounted from the session's worktrees so dev servers hot-reload; dependencies live in named volumes keyed by lockfile hash so sessions with the same lockfile share an install.

**No host ports per service.** A single Traefik container (`spinner-proxy`) listens on `:80` and routes by hostname using Docker labels that the runner puts on every service:

```
admin.s17.localhost     → spinner-s17 / admin:5173
insights.s17.localhost  → spinner-s17 / insights:5173
api.s17.localhost       → spinner-s17 / backend:3000
temporal.s17.localhost  → spinner-s17 / temporal:8233
```

This solves three things at once: port collisions vanish (only Traefik binds a host port); **cookies stop colliding** (browsers scope cookies by host, not port, so two branches on `localhost:3000` and `localhost:3001` share a cookie jar and log each other out; `admin.s17.localhost` and `admin.s18.localhost` do not); and URLs become predictable enough to put in agent briefs and PR descriptions. Traefik middleware also strips `X-Frame-Options` / `frame-ancestors` from any service we want to embed, so third-party UIs like Temporal's work in a preview pane without changes.

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
- pi via RPC subprocess per agent; adapter interface kept narrow so another harness can be added.
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
