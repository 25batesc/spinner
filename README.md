# Spinner

**One window per feature. Several agents, one mission, a running stack you can click on, and a board that drives every PR home.**

Spinner is a local, open-source workbench. It is two things joined at the hip. The first is a **multi-agent editor**. Several coding agents work on one feature against a shared mission and a running copy of the stack. The second is an **organizer** that pushes what they produce into the codebase. It covers bot review, comment resolution, local verification, peer review, approvals, the merge queue and landing. A *session* is the unit for both halves. It owns a branch across every repo in your stack and a running copy of that stack on its own hostnames. It also owns a shared mission document, up to three agents, and a **pipeline** stage. You are the operator. The board tells you what each session needs from you right now.

Spinner does not make one feature faster by adding agents to it. Communication cost grows with the square of the agent count, and the review-to-merge loop is sequential. It lets you run four features at once because the mission doc and the board carry the communication, not you.

> Status (2026-10-30): M0 to M3 are done. M4, the desktop app, is built and in daily use; each agent tab is now pi's own terminal. M5, the release, is open. The record is in [docs/STATUS.md](docs/STATUS.md); a fresh session starts from [docs/HANDOFF.md](docs/HANDOFF.md).
>
> Try it: the [Quick start](#quick-start) below takes you from a clone to the sample stack in the UI. Then read [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/SESSION_PROTOCOL.md](docs/SESSION_PROTOCOL.md).

## Quick start

This is the newcomer path: a fresh clone to a running UI on `examples/sample-stack`, then your own stack. An agent ran every command below on 2026-10-30 at commit `91307dd`, in a fresh clone with a fresh `SPINNER_HOME`. The timings are at the end.

### Prerequisites

- macOS 14 or newer. Linux: the `stack` CI job runs this path on `ubuntu-latest`; a Linux laptop is untested.
- Node 24 through a version manager. `.node-version` names the version; `fnm use` or `nvm use` picks it.
- pnpm 10 (`corepack enable`, or `npm install -g pnpm`).
- Docker Desktop or OrbStack, running.
- `gh`, logged in.
- `pi` 1.x (`@earendil-works/pi-coding-agent`) with a provider configured. The daemon spawns `pi` by path, not by PATH. If `pi` lives under another Node version, set `SPINNER_PI` to its binary, or put `pi_bin` in `~/.spinner/config.yaml` (step 3).

### 1. Install

```bash
git clone https://github.com/25batesc/Spinner.git && cd Spinner
pnpm install
pnpm -r build
```

`pnpm spinner` runs the CLI from the repo root. For a plain `spinner` on your PATH, add `alias spinner="node $PWD/packages/cli/dist/main.js"` to your shell.

### 2. Check the machine

```bash
pnpm spinner doctor
```

One line per check: the home outside git, Node, Docker, `gh`, `pi`, the shared proxy and Postgres, the `env` file, the Slack token, the daemon. A `FAIL` line says what to do.

### 3. Settings for the daemon

The daemon reads `~/.spinner/config.yaml` once at start. Every key is optional. The environment overrides each one (`SPINNER_PI`, `SPINNER_PORT`, `SPINNER_DEFAULT_MODEL`, `SPINNER_AGENTS_HARNESS`, `SPINNER_SLACK_CHANNEL`).

```yaml
# ~/.spinner/config.yaml
pi_bin: /opt/homebrew/bin/pi          # the pi executable; `pi` on PATH when absent
port: 7777                            # the daemon's port
default_model: anthropic/claude-fable-5-1   # for an agent tab that names no model
agents:
  harness: tty                        # tty (pi's own terminal, the default) or rpc (headless)
slack:
  channel: C0123456789                # where `spinner post` posts when a project names none
```

Secrets never go in that file; the daemon refuses a key that looks like one. Put them in `~/.spinner/env`, mode 600, one `NAME=value` per line. The launch agent (step 9) sources it at login. In a terminal, `source ~/.spinner/env` before `spinner daemon start`. Today the only secret is `SLACK_USER_TOKEN`, for `spinner post`. Spinner never writes that file.

```bash
touch ~/.spinner/env && chmod 600 ~/.spinner/env
```

### 4. Run the sample stack

Start the daemon in the background, then create a session on the sample stack.

```bash
pnpm spinner daemon start      # background; log in ~/.spinner/daemon.log
pnpm spinner daemon status     # pid, URL, build (commit and build time)
pnpm spinner new --project examples/sample-stack "try it"   # session s001, worktree on feat/try-it
pnpm spinner seed rebuild s001                              # once per machine; starts spinner-postgres
pnpm spinner up s001                                        # proxy, 3 containers, a database clone
```

The first `up` builds the dev image and pulls Traefik, Postgres and Temporal; the second takes about 3 s. `curl` does not resolve `*.localhost` on macOS, so use `curl -H 'Host: api.s001.localhost' http://127.0.0.1/items`. Browsers resolve it.

### 5. The web UI

```bash
open http://localhost:7777
```

The daemon serves the web UI. The UI shows `s001` with its services up; the preview pane shows `web.s001.localhost`. `pnpm daemon` runs the daemon in the foreground instead, with its log on the terminal. The daemon runs from this checkout's build. After a `git pull`, run `pnpm -r build`, then `daemon stop` and `daemon start`.

### 6. The desktop app

```bash
pnpm desktop            # a window on the running daemon; starts one when none answers
pnpm desktop:build      # a local, unsigned .app under packages/desktop/dist-app/
```

Previews in the window are top-level pages, so an app's login holds inside Spinner. A preview pops out into its own window and docks back.

### 7. The agent terminal

Add an agent from the `+` chip in the session's agents pane. An agent tab is pi's own terminal. The daemon runs `pi` in a pseudo-terminal in the agent's worktree; the tab renders it with xterm.js. Type in it as you type in pi. Keystrokes, paste, Ctrl and the arrow keys reach pi; `/` opens pi's command list. A `prompt` or a `steer` from the pipeline goes through the Spinner extension inside pi, never through keystrokes. The `×` on the agent's chip stops it. When an agent is not running, the tab offers `resume`, which reopens the same transcript. The `context` sub-tab shows the agent's context files and lets you edit them.

### 8. Settings and themes

The gear at the bottom of the activity bar opens the settings view. It edits `~/.spinner/settings.yaml`: the theme, the default model, the harness for a new agent. A change applies at once in every window.

Themes are `system`, `light`, `dark` and `rainbow`, plus your own. A custom theme is a palette file at `~/.spinner/themes/<name>.json`. Copy `dark` as a starting point: the settings view has a download for it, or copy `packages/protocol/src/themes/dark.json`. A file with a missing key is listed under the select with the key named, and cannot be chosen.

### 9. Resource usage and the daemon service

While a stack is up, the daemon samples every 5 s: `docker stats` for containers, `ps` for host services. Each session card shows the stack's memory and CPU; the context bar shows the machine line. The `services` view of the agents pane shows the six columns per service.

On macOS, `pnpm spinner daemon install` writes `~/Library/LaunchAgents/dev.spinner.daemon.plist`. It starts the daemon at login with your shell's PATH and `~/.spinner/env`. `daemon uninstall` removes it. `daemon logs` tails the log, `daemon stop` stops it, and `start` twice is a no-op.

### 10. Your own stack

Write a `spinner.yaml` for it ([docs/STACK_SPEC.md](docs/STACK_SPEC.md), recipes in [docs/stacks/](docs/stacks/README.md)). Put it in `local/<name>/` of this checkout (gitignored) or in `~/.spinner/projects/<name>/`. Then `pnpm spinner new --project <name> "<title>"`, `seed rebuild`, `up`, as in step 4. Or let the board drive an existing PR with `pnpm spinner adopt <pr-url>`.

### 11. Clean up

```bash
pnpm spinner close s001        # containers, network, database clone, worktree; the branch stays
pnpm spinner daemon stop
```

Timed run, 2026-10-30, commit `91307dd`, a fresh clone and a fresh `SPINNER_HOME` on a laptop. The pnpm store was warm, the dev image was built, and the shared proxy and Postgres ran already. A cold machine adds the image pulls and one image build: a few minutes on a normal connection.

| Step | Time |
|---|---|
| `pnpm install --frozen-lockfile` | 1.1 s |
| `pnpm -r build` | 2.9 s |
| `spinner doctor` | 1.4 s |
| `spinner seed rebuild` | 0.6 s |
| `spinner up` | 3.1 s |
| `spinner close` | 2.6 s |
| `pnpm desktop:build` | 4.7 s |

## The problem

Writing the code stopped being the expensive part. An agent implements a well-described fix or feature nearly for free. You review the plan and nudge in a couple of places. What eats the day is everything after that, repeated for four or more changes in flight at once:

1. Waiting for the review bot on the PR, and noticing when it lands.
2. Telling the agent to resolve every bot comment (a code-review bot, a static-analysis bot).
3. Getting the branch running locally to verify it works.
4. Posting the PRs in Slack for peer review.
5. Addressing peer comments.
6. Approving and queueing for merge. Then noticing when the merge queue pops the PR back out on a conflict, and queueing it again.
7. Confirming it finally landed in `dev`.

Each of those is a small task. With four or more features in flight they turn into a mess of agent transcripts, PRs, Slack posts and branches. The usual coping strategy is a browser window per feature and a single checkout that you switch to test anything. Tabs get lost. The main checkout is always on the wrong branch. The question "what does this feature need from me right now?" takes minutes to answer.

Specific pains Spinner removes:

- **No single place knows the state of each change.** Which PR waits on a bot, which has three unresolved bot comments, which fell out of the merge queue an hour ago.
- **The post-implementation loop is manual.** Every "resolve the comments", "post it for review", "re-queue it" is a person who relays between systems that could talk to each other.
- **Local testing between branches is slow.** One checkout, port collisions, seed data drift, Temporal workers from the wrong branch. Cookies ignore ports, so two branches on `localhost:3000` and `3001` log each other out.
- **Hosted agents are slow and single-threaded**, and you cannot run the app while they work. **Local harnesses are single-worktree** and manage one copy of one repo.
- **Agents do not know about each other.** Two sessions on the same feature share no goal, no plan, no awareness of each other's edits.

## The idea

- **Session.** A feature-sized unit of work. It has an id, a slug, one branch name across all repos, a session directory, a mission doc, a stack, agents and a pipeline stage. It replaces the "browser window per feature" habit.
- **Pipeline.** The stage the session's PRs are in, from `building` to `merged`, plus what blocks, fed live from GitHub and Slack. The board shows every session's stage and the one thing you need to do next.
- **Stack.** The set of repos and services that make the app work: for a three-repo app, `backend`, `admin`, `web`, Postgres and Temporal. Each session gets its own running copy, isolated by container, at predictable hostnames like `admin.s17.localhost`.
- **Agent.** One coding-agent process (a [pi](https://pi.dev) session) attached to a session, with its own tab, its own transcript, and a brief. Agents also resolve review comments and rebase on conflicts when the pipeline asks.
- **Mission doc.** `MISSION.md` in the session directory. The single shared source of truth: goal, plan, roster, decisions, log. Every agent reads it each turn and updates its own roster row. You edit it too.
- **Preview.** A pane with the session's running admin, frontend, backend and Temporal UI. Click around, test the feature, tick "verified locally", and file the bug back to the agent in the same screen.

The UI sketch that started this:

![Sketch](cullen%20agent%20studio.png)

Sessions down the left, each with a stage and a "needs you" indicator. Agent tabs in the middle with `create PR / run local / stop local`. Live previews on the right.

## How it differs from existing tools

There are good tools for coding agents in parallel git worktrees (Conductor, Claude Squad, the late Crystal and Vibe Kanban, Dagger's Container Use). They solve *isolation*: one agent, one worktree, sometimes one container. Spinner starts from the other end:

1. **The session, not the agent, is the unit.** Several agents share one worktree set and one mission. The point is collaboration on one feature, not fan-out of unrelated tasks.
2. **It drives PRs home.** It watches bot reviews, peer comments, checks and the merge queue. An agent resolves what it can. The board tells you the moment something needs a human, and re-queues after a pop-out.
3. **The whole stack runs, per session, and you can use it.** Not only the repo under edit: the frontends, the API, the seeded database, the workflow engine. Interactive testing is a pipeline stage, not an afterthought.
4. **Coordination is a document, not an orchestrator.** Agents communicate through `MISSION.md` and short text messages routed by the daemon. You are the orchestrator and can read everything the agents can.
5. **Multi-repo first.** A feature often touches several repos. A session carries the same branch name across all of them, opens up to three PRs, and posts them to Slack as one set.
6. **Harness-agnostic by design, pi first.** pi is scriptable (SDK and RPC), model-agnostic through OpenRouter, and MIT, so it is the v1 runtime. The agent adapter is an interface so others can follow.

## What Spinner is not

- Not a hosted service. The daemon, the agents and the stacks run on your machine.
- Not CI. It reads checks; it does not run them.
- Not an orchestrator that plans for the agents. You write the goal and the plan; the agents update the roster and the log.
- Not a replacement for review. A peer still approves every PR.
- Not an agent harness. It drives pi; it does not reimplement it.

## Generic by design

The core is for anyone's repos and anyone's job: sessions, worktrees, a stack in one `spinner.yaml` ([docs/STACK_SPEC.md](docs/STACK_SPEC.md)), agents, the mission doc, previews. The pipeline tracker is where workflows differ: which bots review, what counts as approved, if there is a merge queue, where review requests go. So all of it is configuration with plain-GitHub defaults. pi is the first harness. The adapter interface is small enough that the Claude Code, Codex and Cursor CLIs can follow.

Where things live:

- `~/.spinner/`: your sessions, your settings, your private project specs. Never inside a repo. No database: every session is a directory of YAML, Markdown and JSONL.
- Your work repos: untouched, apart from a gitignored `.spinner` symlink in each worktree (excluded per clone, not committed).
- This repo: the code, the docs, `examples/sample-stack` (runnable by anyone), `examples/sessions` (templates). `local/` is gitignored for private specs.

Your harness configuration carries over: pi runs with your own agent directory, so your skills, extensions and `AGENTS.md` files apply. Spinner shows each agent's context chain, the `AGENTS.md` files from user level down to its working directory. You can edit any of them in the tab.

## Requirements

- macOS 14 or newer (Linux can work; untested).
- Docker Desktop or OrbStack.
- `gh`, logged in to the GitHub org that holds your repos.
- `pi` 1.x (`@earendil-works/pi-coding-agent`), with a provider configured.
- Node 24 and pnpm 10.
- A `spinner.yaml` for your stack ([docs/STACK_SPEC.md](docs/STACK_SPEC.md)).

## Planned shape

The CLI today has every command below except `agent add`; agents are added from the UI or `POST /sessions/:dir/agents`.

```
spinner new "payments: refund flow"      # session s17, branch feat/refund-flow in all repos
spinner up s17                            # containers + seeded DB + temporal, ~seconds
spinner agent add s17 backend-api         # a pi tab with a brief (planned; the UI does it today)
spinner agent add s17 admin-ui
spinner pr s17                            # gh pr create in each repo that changed → stage: bot-review
spinner fix s17                           # agent resolves open bot and peer threads
spinner verify s17                        # you tested it in the preview: tick the box
spinner post s17                          # post the PR set to Slack → peer-review
spinner approve s17                       # your approval, where the team policy wants it (adopted bot PRs)
spinner land s17                          # checks pass: enqueue; re-enqueue on pop-out; watch until merged
spinner board                             # every session, its stage, and what it needs from you
spinner close s17                         # merged: tear down, archive session dir
```

A local daemon (`spinnerd`) owns sessions, stacks, agent processes and the pipeline tracker. The web UI and the desktop app talk to it over HTTP and WebSockets on loopback. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Docs

- [docs/SESSION_PROTOCOL.md](docs/SESSION_PROTOCOL.md): the session directory, the pipeline stages, and the `MISSION.md` contract. Everything else is built against this.
- [docs/STACK_SPEC.md](docs/STACK_SPEC.md): how a project describes its stack (`spinner.yaml`), with a three-repo example.
- [docs/stacks/](docs/stacks/README.md): recipes by stack shape. A service on the host, a secrets injector, Supabase, a webpack dev server, cloud APIs with fixed origins, worktree dependencies.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): daemon, pipeline tracker, CLI, UI, agent adapter, stack runner, hostnames, web vs desktop.
- [docs/DAEMON_API.md](docs/DAEMON_API.md): every route of the daemon, the two WebSockets, settings, themes and usage.
- [docs/ROADMAP.md](docs/ROADMAP.md): milestones, in order, with exit criteria.
- [docs/STATUS.md](docs/STATUS.md): what exists, what is proven, what is open, and what it cost. Updated when a session closes.
- [docs/HANDOFF.md](docs/HANDOFF.md): how to pick the work up in a fresh session: what runs, where the state lives, the open decisions.
- [docs/sessions/](docs/sessions/): the full mission record of each closed session, Log included.
- [docs/WRITING.md](docs/WRITING.md): the house writing rules and the glossary. One word, one meaning.
- [docs/audits/](docs/audits/): dated reviews of the docs against outside yardsticks.
- [examples/sample-stack/](examples/sample-stack/): a tiny API + web + Postgres stack anyone can run; the test vehicle for the stack runner.
- [examples/sessions/](examples/sessions/): the session templates, one per building session. Spinner builds Spinner.
- `local/` (gitignored): your private stack specs, such as `local/<project>/spinner.yaml`.

## How the project is run

- **Architect:** Cullen Bates. The architect owns conceptual integrity: what a session is, what the protocol says, what the operator sees. Agents and contributors implement.
- **Precedence** when documents disagree: `SESSION_PROTOCOL.md` > `STACK_SPEC.md` > `ARCHITECTURE.md` > `ROADMAP.md` > session files. Fix the lower one.
- A change to the protocol needs a dated entry under *Decisions* at the end of `docs/SESSION_PROTOCOL.md` before code follows it.
- Docs are checked with `python3 tools/doc-metrics.py --fail`. Briefs and run sheets must pass.

## License

MIT. See [LICENSE](LICENSE).
