# Spinner

**One window per feature. Several agents, one mission, a running stack you can click on, and a board that drives every PR home.**

Spinner is a local, open-source workbench. It is two things joined at the hip. The first is a **multi-agent editor**: several coding agents work on one feature against a shared mission and a running copy of the stack you can click on. The second is an **organizer** that pushes what they produce into the codebase: bot review, comment resolution, local verification, peer review, approvals, the merge queue, landing. A *session* is the unit for both halves. It owns a branch across every repo in your stack, a running copy of that stack on its own hostnames, a shared mission document, up to three agents, and a **pipeline** stage. You are the operator. The board tells you what each session needs from you right now.

Spinner does not make one feature faster by adding agents to it. Communication cost grows with the square of the agent count, and the review-to-merge loop is sequential. It lets you run four features at once because the mission doc and the board carry the communication, not you.

> Status: **M2 done except the operator's first real feature; M3 partial** (2026-10-29). `pnpm daemon` serves the web UI at `http://localhost:7777`: sessions and board, stack actions with live job logs, previews, agent tabs backed by pi, the mission panel, review threads, and `create PR / fix / post / approve / land / reset` as jobs. The loop ran live on a throwaway repository: the fixer agent resolved a review thread, the post went to Slack as the operator, the PR merged. The board works on real PRs (`spinner adopt`, `spinner board --watch`; a live merge-queue pop-out notified in 19 s). The stack runner brings up `examples/sample-stack` in 3 s and the operator's own three-repo stack, two sessions side by side on their own hostnames and database clones. The soak week runs before M2. Details in [docs/STATUS.md](docs/STATUS.md).
>
> Try it: [Quick start](#quick-start) below takes you from a clone to the sample stack in the UI. Then read [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/SESSION_PROTOCOL.md](docs/SESSION_PROTOCOL.md).

## Quick start

This is the newcomer path: a fresh clone to a running UI on `examples/sample-stack`, then your own stack. An agent timed it on 2026-10-29 in a fresh clone with a fresh `SPINNER_HOME`; the table is at the end.

You need macOS 14 or newer, Node 24, pnpm 10, Docker Desktop or OrbStack, `gh` logged in, and `pi` 1.x with a provider configured. `.node-version` names the Node version; `fnm use` or `nvm use` picks it. Linux: the `stack` CI job runs this path on `ubuntu-latest`; a Linux laptop is untested.

1. Clone and build.

   ```bash
   git clone https://github.com/25batesc/Spinner.git && cd Spinner
   pnpm install
   pnpm -r build
   ```

   `pnpm spinner` runs the CLI from the repo root. For a plain `spinner` on your PATH, add `alias spinner="node $PWD/packages/cli/dist/main.js"` to your shell.

2. Check the machine.

   ```bash
   pnpm spinner doctor
   ```

   One line per check: the home outside git, Node, Docker, `gh`, `pi`, the shared proxy and Postgres, the `env` file, the Slack token, the daemon. A `FAIL` line says what to do. `pi` not found: put its path in `~/.spinner/config.yaml` (step 3) or set `SPINNER_PI`.

3. Settings. The daemon reads `~/.spinner/config.yaml` once at start. Every key is optional; the environment overrides each one (`SPINNER_PI`, `SPINNER_PORT`, `SPINNER_DEFAULT_MODEL`, `SPINNER_SLACK_CHANNEL`).

   ```yaml
   # ~/.spinner/config.yaml
   pi_bin: /opt/homebrew/bin/pi          # the pi executable; `pi` on PATH when absent
   port: 7777                            # the daemon's port
   default_model: anthropic/claude-fable-5-1   # for an agent tab that names no model
   slack:
     channel: C0123456789                # where `spinner post` posts when a project names none
   ```

   Secrets never go in that file; the daemon refuses a key that looks like one. Put them in `~/.spinner/env`, mode 600, one `NAME=value` per line. The launch agent (step 4) sources it at login; in a terminal, `source ~/.spinner/env` before `spinner daemon start`. Today the only secret is `SLACK_USER_TOKEN`, for `spinner post`. Spinner never writes that file.

   ```bash
   touch ~/.spinner/env && chmod 600 ~/.spinner/env
   ```

4. Start the daemon.

   ```bash
   pnpm spinner daemon start      # background; log in ~/.spinner/daemon.log
   pnpm spinner daemon status     # pid, URL, build (commit and build time)
   open http://localhost:7777
   ```

   `daemon logs` tails the log, `daemon stop` stops it, `start` twice is a no-op. On macOS, `pnpm spinner daemon install` writes `~/Library/LaunchAgents/dev.spinner.daemon.plist`, which starts the daemon at login with your shell's PATH and `~/.spinner/env`; `daemon uninstall` removes it. The daemon runs from this checkout's build, so run `pnpm -r build` and `daemon stop && daemon start` after a `git pull`.

5. Run the sample stack.

   ```bash
   pnpm spinner new --project examples/sample-stack "try it"   # session s001, worktree on feat/try-it
   pnpm spinner seed rebuild s001                              # once per machine; starts spinner-postgres
   pnpm spinner up s001                                        # proxy, 3 containers, a database clone
   ```

   The UI shows `s001` with its services up; the preview pane shows `web.s001.localhost`. The first `up` builds the dev image and pulls Traefik, Postgres and Temporal; the second takes about 3 s. `curl` does not resolve `*.localhost` on macOS, so use `curl -H 'Host: api.s001.localhost' http://127.0.0.1/items`; browsers resolve it.

6. Your own stack. Write a `spinner.yaml` for it ([docs/STACK_SPEC.md](docs/STACK_SPEC.md), recipes in [docs/stacks/](docs/stacks/README.md)) in `local/<name>/` of this checkout (gitignored) or `~/.spinner/projects/<name>/`. Then `pnpm spinner new --project <name> "<title>"`, `seed rebuild`, `up`, as in step 5. Add an agent from the session's tab in the UI, or let the board drive an existing PR with `pnpm spinner adopt <pr-url>`.

7. Clean up.

   ```bash
   pnpm spinner close s001        # containers, network, database clone, worktree; the branch stays
   pnpm spinner daemon stop
   ```

Timed run, 2026-10-29: a fresh clone at commit `8f763c4` and a fresh `SPINNER_HOME`, on a laptop. The pnpm store was warm, the dev image was built, and the shared proxy and Postgres ran already. A cold machine adds the image pulls and one image build: a few minutes on a normal connection.

| Step | Time |
|---|---|
| `git clone` (local) | 0.7 s |
| `pnpm install --frozen-lockfile` | 1.2 s |
| `pnpm -r build` | 3.4 s |
| `spinner doctor` | 2.0 s |
| `spinner daemon start` | 0.7 s |
| `spinner new --project examples/sample-stack` | 0.6 s |
| `spinner seed rebuild s001` | 0.4 s |
| `spinner up s001` | 3.1 s |
| UI `/` 200, session view `stack: up`, `web.s001.localhost` 200 | 0.2 s |
| `spinner close s001` | 2.9 s |
| `spinner daemon stop` | 0.4 s |
| Total | 15.6 s |

## The problem

Writing the code stopped being the expensive part. An agent implements a well-described fix or feature nearly for free; you review the plan, nudge in a couple of places, and the implementation is done. What eats the day is everything after that, repeated for four or more changes in flight at once:

1. Waiting for the review bot on the PR, and noticing when it lands.
2. Telling the agent to resolve every bot comment (a code-review bot, a static-analysis bot).
3. Getting the branch running locally to verify it actually works.
4. Posting the PR(s) in Slack for peer review.
5. Addressing peer comments.
6. Approving and queueing for merge, then noticing when the merge queue pops the PR back out on a conflict, and queueing it again.
7. Confirming it finally landed in `dev`.

Each of those is a small task, but with 4+ features in flight they turn into a mess of agent transcripts, PRs, Slack posts and branches. The current coping strategy is a browser window per feature (agent thread tab, local branch tabs, PR tabs) and a single checkout that has to be switched to test anything. Tabs get lost, the main checkout is always on the wrong branch, and the question "what does this feature need from me right now?" takes minutes to answer.

Specific pains Spinner is built to remove:

- **No single place that knows the state of each change.** Which PR is waiting on a bot, which has three unresolved bot comments, which fell out of the merge queue an hour ago. Today that lives in tab order and memory.
- **The post-implementation loop is manual.** Every "resolve the comments", "post it for review", "re-queue it" is a person relaying between systems that could talk to each other.
- **Local testing between branches is slow.** One checkout, port collisions, cookie collisions (cookies ignore ports, so two branches on `localhost:3000` and `3001` log each other out), seed data drift, Temporal workers from the wrong branch picking up tasks.
- **Hosted agents are slow and single-threaded**, and you can't run the app and poke at it while they work. **Local harnesses are single-worktree** and manage one copy of one repo.
- **Agents don't know about each other.** Two sessions on the same feature share no goal, no plan, no awareness of each other's edits.

## The idea

| Concept | What it is |
|---|---|
| **Session** | A feature-sized unit of work. Has an ID, a slug, a branch name used across all repos, a session directory, a mission doc, a stack, agents and a pipeline stage. Replaces the "browser window per feature" habit. |
| **Pipeline** | The stage the session's PRs are in (`building → bot-review → fixing → verifying → peer-review → addressing → approving → queued → merged`) plus what is blocking, fed live from GitHub and Slack. The board shows every session's stage and the one thing you need to do next. |
| **Stack** | The set of repos and services that make the app work (for a three-repo app: `backend`, `admin`, `web`, plus Postgres and Temporal). Each session gets its own running copy, isolated by container and reachable at predictable hostnames like `admin.s17.localhost`. |
| **Agent** | One coding-agent process (a [pi](https://pi.dev) session) attached to a session, with its own tab, its own transcript, and a brief that says what it owns. Agents also do the review-comment resolution and conflict rebases the pipeline asks for. |
| **Mission doc** | `MISSION.md` in the session directory. The single shared source of truth: goal, plan, roster (who is doing what), decisions, log. Every agent reads it each turn and updates its own roster row. You edit it too. |
| **Preview** | Embedded windows showing the session's running admin, frontend, backend, and Temporal UI. Click around, test the feature, tick "verified locally", file the bug back to the agent in the same screen. |

The UI sketch that started this:

![Sketch](cullen%20agent%20studio.png)

Sessions down the left (now with a stage and a "needs you" indicator each), agent chat tabs in the middle with `create PR / run local / stop local`, live previews on the right.

## How it differs from existing tools

There are good tools for running coding agents in parallel in git worktrees (Conductor, Claude Squad, the late Crystal and Vibe Kanban, Dagger's Container Use). They solve *isolation*: one agent, one worktree, sometimes one container. Spinner starts from the other end:

1. **The session, not the agent, is the unit.** Several agents share one worktree set and one mission; the point is collaboration on one feature, not fan-out of unrelated tasks.
2. **It drives PRs home.** Watches bot reviews, peer comments, checks and the merge queue; has an agent resolve what can be resolved; tells you the moment something needs a human; re-queues after pop-outs. The board is the product as much as the editor is.
3. **The whole stack runs, per session, and you can use it.** Not just the repo under edit: the frontends, the API, the database with seeded data, the workflow engine. Interactive testing is a pipeline stage, not an afterthought.
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

The core is for anyone's repos and anyone's job: sessions, worktrees, a stack described in one `spinner.yaml` ([docs/STACK_SPEC.md](docs/STACK_SPEC.md)), agents, the mission doc, previews. The pipeline tracker is where workflows differ (which bots review, what counts as approved, whether there is a merge queue, where review requests go), so all of it is configuration with plain-GitHub defaults. pi is the first harness; the adapter interface is small enough that Claude Code, Codex and Cursor CLIs can follow.

Where things live:

- `~/.spinner/`: your sessions, your settings, your private project specs. Never inside a repo. No database: every session is a directory of YAML, Markdown and JSONL.
- Your work repos: untouched, apart from a gitignored `.spinner` symlink in each worktree (excluded per clone, not committed).
- This repo: the code, the docs, `examples/sample-stack` (runnable by anyone), `examples/sessions` (templates). `local/` is gitignored for private specs.

Your harness configuration carries over: pi runs with your own agent directory, so your skills, extensions and `AGENTS.md` files apply. Spinner shows each agent's context chain (the `AGENTS.md` files from user level down to the directory it works in) and lets you edit any of them.

## Requirements

- macOS 14 or newer (Linux should work; untested).
- Docker Desktop or OrbStack.
- `gh`, logged in to the GitHub org that holds your repos.
- `pi` 1.x (`@earendil-works/pi-coding-agent`), with a provider configured.
- Node 24 and pnpm.
- A `spinner.yaml` for your stack ([docs/STACK_SPEC.md](docs/STACK_SPEC.md)).

## Planned shape

```
spinner new "payments: refund flow"      # session s17, branch feat/refund-flow in all repos
spinner up s17                            # containers + seeded DB + temporal, ~seconds
spinner agent add s17 backend-api         # a pi tab with a brief
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

A local daemon (`spinnerd`) owns sessions, stacks, agent processes and the pipeline tracker. A web UI (later wrapped in Electron) talks to it over a local socket. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Docs

- [docs/SESSION_PROTOCOL.md](docs/SESSION_PROTOCOL.md): the session directory, the pipeline stages, and the `MISSION.md` contract. Everything else is built against this.
- [docs/STACK_SPEC.md](docs/STACK_SPEC.md): how a project describes its stack (`spinner.yaml`), with a three-repo example.
- [docs/stacks/](docs/stacks/README.md): recipes by stack shape: a service on the host, a secrets injector, Supabase, a webpack dev server, cloud APIs with fixed origins, worktree dependencies.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): daemon, pipeline tracker, CLI, UI, agent adapter, stack runner, hostnames, web vs desktop.
- [docs/ROADMAP.md](docs/ROADMAP.md): milestones, in order, with exit criteria.
- [docs/STATUS.md](docs/STATUS.md): what exists, what is proven, what is open, and what it cost. Updated when a session closes.
- [docs/sessions/](docs/sessions/): the full mission record of each closed session, Log included.
- [docs/WRITING.md](docs/WRITING.md): the house writing rules and the glossary. One word, one meaning.
- [docs/audits/](docs/audits/): dated reviews of the docs against outside yardsticks.
- [examples/sample-stack/](examples/sample-stack/): a tiny API + web + Postgres stack anyone can run; the test vehicle for the stack runner.
- [examples/sessions/s001-bootstrap/](examples/sessions/s001-bootstrap/): the first session template. Spinner builds Spinner, run by hand with two pi terminals until the daemon exists.
- [examples/sessions/s002-board-and-stack/](examples/sessions/s002-board-and-stack/): the second session template: the pipeline board and the stack runner, built in parallel by two agents.
- `local/` (gitignored): your private stack specs, such as `local/<project>/spinner.yaml`.

## How the project is run

- **Architect:** Cullen Bates. The architect owns conceptual integrity: what a session is, what the protocol says, what the operator sees. Agents and contributors implement.
- **Precedence** when documents disagree: `SESSION_PROTOCOL.md` > `STACK_SPEC.md` > `ARCHITECTURE.md` > `ROADMAP.md` > session files. Fix the lower one.
- A change to the protocol needs a dated entry under *Decisions* at the end of `docs/SESSION_PROTOCOL.md` before code follows it.
- Docs are checked with `python3 tools/doc-metrics.py --fail`. Briefs and run sheets must pass.

## License

MIT. See [LICENSE](LICENSE).
