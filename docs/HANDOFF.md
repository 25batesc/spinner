# Handoff: how to pick Spinner up in a fresh session

This page is for the operator and for an agent that opens a new chat with no memory of the last one. It says what runs, where the state lives, how to resume the work, and what the open decisions are. [STATUS.md](STATUS.md) holds the full record per milestone. This page holds only what you need in the first ten minutes.

Updated: 2026-10-30, after s011 (agent terminals, resource usage, settings and themes) and the second day of the operator's real PR.

## State in one paragraph

Spinner builds Spinner. M0 to M3 are done. M4, the desktop app, is built and in daily use by the operator. M2's last item, the operator's real feature through `pr → land`, is in progress on his PR session. The repo holds 172 commits and 386 tests at `91307dd`; CI runs two jobs (unit and lint; the sample stack on Linux with Docker). Every session since s001 ran as pi subagents from one parent chat; the parent relayed messages and made the decisions.

## What changed in s011

- **Agent terminals.** An agent tab is pi's own terminal. The daemon runs `pi` in a pseudo-terminal (`PiTtyHarness`, `node-pty`) and the tab renders it with xterm.js over `GET .../tty`. `prompt`, `steer`, `abort` and a stack-failure `notify` go through the Spinner extension inside pi, over a long-poll on `GET .../commands`. The extension posts pi's lifecycle events to `POST .../events`, so the bus and the board run unchanged. The RPC harness stays for tests and `agents.harness: rpc`. [ARCHITECTURE.md](ARCHITECTURE.md#agent-adapter-packagesdaemonsrcagents), [DAEMON_API.md](DAEMON_API.md).
- **Settings and themes.** `~/.spinner/settings.yaml` (`theme`, `default_model`, `agents.harness`) behind `GET` and `PUT /settings`, edited from the gear in the UI. A theme is a palette file; `light`, `dark` and `rainbow` are built in, `~/.spinner/themes/<name>.json` adds one. The daemon stores `default_model` and `agents.harness` but the manager does not read them yet.
- **Resource usage.** A sampler runs `docker stats` and `ps` every 5 s while a stack is up. The session cards, the context bar and the `services` view show the numbers; `GET /usage` and the `usage` event carry them.
- **The Activity drawer.** One drawer under the agents pane holds the feed and the job log. It resizes, collapses to a one-line bar, and remembers its height.
- **Stack-failure notices.** A failed `up`, `down` or `reset` writes `stack.last_job` and sends one notice to each running tty agent. `GET .../stack/logs/:service` serves a service's last lines.
- **Two fixes.** A page reload in the desktop app no longer leaves old preview views painted over the new page (`5035ffa`). Worktree seeding runs links and installs before file copies, so a `seed_files` entry under `node_modules` no longer skips the link (`64fcc79`).

## What runs on the operator's machine

| Thing | Where | How to check |
|---|---|---|
| The daemon | `node packages/daemon/dist/main.js` on `127.0.0.1:7777`, home `~/.spinner` | `curl -s localhost:7777/health` shows the build commit |
| The web UI | served by the daemon at `http://localhost:7777` | open it |
| The desktop app | `pnpm desktop` from the repo, or `packages/desktop/dist-app/Spinner-darwin-arm64/Spinner.app` | the window titled Spinner; it connects to the running daemon |
| The proxy and the managed Postgres | `spinner-proxy` on `:80`, `spinner-postgres` on `:55432`, route files in `~/.spinner/proxy/` | `docker ps --filter name=spinner` |
| The operator's project stack | sessions under `~/.spinner/sessions/`, host services under the session's `log/` and `stack/pids/` | `spinner show <id>` |

The daemon needs three things in its environment. `SLACK_USER_TOKEN` posts as the operator. `SPINNER_PI` names the pi binary, under the Node version that installed it. Node 24 must be on PATH. Restart it from a shell that has them:

```
cd ~/Spinner && pnpm -r build
pnpm spinner daemon stop && pnpm spinner daemon start
curl -s localhost:7777/health
```

`~/.spinner/config.yaml` and `~/.spinner/env` hold the settings the launch agent needs. A UI change needs a daemon restart and a reload of the window (⌘R). An Electron change needs `pnpm desktop` again or `pnpm desktop:build`. A tty agent dies with the daemon (SIGHUP from the pty); the new daemon resumes each one on its transcript.

## Where the state lives

- `~/.spinner/sessions/<id>-<slug>/`: one directory per session, plain files (`session.yaml`, `MISSION.md`, `agents/`, `worktrees/`, `stack/`, `log/`, `inbox/`, `artifacts/`). The Spinner-builds-Spinner sessions live here too. The template numbering in `examples/sessions/` differs because real sessions share the home.
- `~/.spinner/projects/<name>`: the project spec. The operator's projects are links into `local/` (gitignored).
- `~/.spinner/settings.yaml` and `~/.spinner/themes/`: the operator's preferences and custom palettes.
- `~/.spinner/proxy/`: Traefik route files for host services, one per session; shared by every home on the machine.
- `~/.spinner/archive/`: closed sessions.
- The repo: `docs/STATUS.md` (the record), `docs/SESSION_PROTOCOL.md` (the contract, the lessons, the decisions), `docs/sessions/` (the mission records and the soak list). Also `docs/stacks/` (recipes), `examples/sessions/` (the templates), `local/` (private, gitignored).

## How to run a building session

1. Read the last entries of `docs/SESSION_PROTOCOL.md` *Decisions* and the whole of `docs/sessions/soak-questions.md`.
2. Write the template under `examples/sessions/s0NN-<slug>/` (mission, briefs, `session.yaml`, `RUN.md`), check it with `python3 tools/doc-metrics.py --fail`, commit.
3. Copy it to `~/.spinner/sessions/<next id>-<slug>/`, point the repo's `.spinner` symlink at it, fill the dates and the Log's first line.
4. Launch one `spinner-agent` subagent per role (`anthropic/claude-fable-5-1`, cwd the repo, the task names the role and the brief). Launch the one that owns the shared contract first; the others when its Contracts entry is committed.
5. Deliver `inbox/` messages with `steer` (a live child) or `resume` (a finished one). Answer Open questions in the mission and in `subagent_supervisor` replies. Put each steer you give mid-pass under Contracts as one line. Count the relays.
6. At the end: root checks (`pnpm -r build && pnpm -r test && pnpm lint`, `doc-metrics --fail`, `tools/actionlint.sh` if a workflow changed, a `node:24` container run if `src/stack/` or `src/pipeline/` changed). Then push, restart the daemon, and close the record (STATUS, lessons, decisions, the session record under `docs/sessions/`, the template copy-back without the Log).

Rules that bit and are now in the briefs: stage by path, never `git add -A` or `git stash`. Log times from `date`. Wait on an artifact, not on a Log timestamp. Scratch with `mktemp -d`, reported, never deleted. One retry on a repo-side failure, then stop. Never print a file that can hold a secret. Never raise or move a window over the operator's. Destructive e2e only against a scratch daemon, and a driver never defaults to the operator's port. Never signal a pid without its identity. A driver closes its CDP target when it ends.

## The operator's current work

The operator adopted a real PR into a session, attached the project, brought the stack up, added an agent, and uses the desktop app. The next steps on that session are `fix` when the review bot posts, `verify`, `post`, `approve`, `land`. The last one is the live test of the merge-queue enqueue, the only M2 fact without a live run.

## Open decisions

1. **Stacked PRs** (option B in the chat of 2026-10-29): a session holds an ordered list of PRs per repo, with the worktree at the top. `adopt` walks the base chain; `land` goes bottom-up. `session.yaml` moves to version 2. The operator's PR is itself a stack of two. Waiting for the operator's go.
2. **Signing and distribution** of the desktop app (M5): an Apple developer account for a notarized `.app`; the local unsigned build works today.
3. **`settings.yaml` over `config.yaml`.** The daemon stores `default_model` and `agents.harness` from the settings view. Does the manager apply them at the next `add`? Recommended: yes, one line in the manager.
4. **`spinner agent add`.** The README's planned shape names it; the CLI has no `agent` command. Add it, or strike it.
5. **`threads.autofix: all`** stays off until the operator trusts the fixer enough to let it run without the `fix` click.
6. **The Slack token** has been in the chat transcript; the operator chose not to rotate it.

## Open work, by size

- The soak list, `docs/sessions/soak-questions.md`. Older: the verify toggle, the pop-out reason in `needs_human`, `up` under 15 s with host services, the flaky `plumbing.test.ts`, session ids unique across homes.
- The soak list, newer: a UI snapshot per daemon start, the stored settings the manager ignores.
- The soak list, newest: the ui fixture's default port of 7777, the agents pane under a 1000 px window.
- s011 leftovers: `pnpm.onlyBuiltDependencies: ["node-pty"]` in the root `package.json`. Today the harness sets the exec bit on `spawn-helper` at first spawn. The desktop app's own chrome (tray, pane windows) does not read the palette.
- M4 leftovers: a signed build, the tray's state detail, a stranger's run of the README.
- M5: packaging, `spinner init` from the recipes, the public repository with a changelog, the protocol at v2 if the stacks land.
