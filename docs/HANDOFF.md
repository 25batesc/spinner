# Handoff: how to pick Spinner up in a fresh session

This page is for the operator and for an agent that opens a new chat with no memory of the last one. It says what runs, where the state lives, how to resume the work, and what the open decisions are. [STATUS.md](STATUS.md) holds the full record per milestone; this page holds only what you need in the first ten minutes.

Updated: 2026-10-29, 15:10, after s008 (pane layout) and the first day of the operator's real PR.

## State in one paragraph

Spinner builds Spinner. M0 to M3 are done, M4 (desktop) is built and in daily use by the operator, M2's last item (the operator's real feature through `pr → land`, which also gives the merge queue its live test) is in progress on his PR session. The repo holds 138 commits, 105 by agents, 329 tests, and CI runs two jobs (unit and lint; the sample stack on Linux with Docker). Agent cost to date is about $260; the operator's time is the larger number. Every session since s001 ran as pi subagents from one parent chat; the parent relayed messages and made the decisions.

## What runs on the operator's machine

| Thing | Where | How to check |
|---|---|---|
| The daemon | `node packages/daemon/dist/main.js` on `127.0.0.1:7777`, home `~/.spinner` | `curl -s localhost:7777/health` shows the build commit |
| The web UI | served by the daemon at `http://localhost:7777` | open it |
| The desktop app | `pnpm desktop` from the repo (dev build) or `packages/desktop/dist-app/Spinner-darwin-arm64/Spinner.app` | the window titled Spinner; it connects to the running daemon |
| The proxy and the managed Postgres | `spinner-proxy` on `:80`, `spinner-postgres` on `:55432`, route files in `~/.spinner/proxy/` | `docker ps --filter name=spinner` |
| The operator's project stack | sessions under `~/.spinner/sessions/`, host services under the session's `log/` and `stack/pids/` | `spinner show <id>` |

The daemon needs three things in its environment: `SLACK_USER_TOKEN` (posting as the operator), `SPINNER_PI` (the pi binary; it lives under the Node version that installed it), and Node 24 on PATH. Restart it from a shell that has them:

```
cd ~/Spinner && pnpm -r build
kill "$(lsof -nP -iTCP:7777 -sTCP:LISTEN -t)"
nohup pnpm --silent daemon > ~/.spinner/daemon.log 2>&1 &
curl -s localhost:7777/health
```

`spinner daemon start|stop|status|logs` does the same with a pid file once `~/.spinner/config.yaml` and `~/.spinner/env` hold the settings; the operator's shell profile is where the token and the pi path belong. A UI change needs a daemon restart and a reload of the window (⌘R); an Electron change needs `pnpm desktop` again or `pnpm desktop:build`.

## Where the state lives

- `~/.spinner/sessions/<id>-<slug>/`: one directory per session, plain files (`session.yaml`, `MISSION.md`, `agents/`, `worktrees/`, `stack/`, `log/`, `inbox/`, `artifacts/`). The Spinner-builds-Spinner sessions live here too (s001, s002, s004, s005, s008, s009, s010 in the operator's home; the template numbering in `examples/sessions/` differs because real sessions share the home).
- `~/.spinner/projects/<name>` → the project spec; `knit` and `sandbox` are links into `local/` (gitignored).
- `~/.spinner/proxy/`: Traefik route files for host services, one per session; shared by every home on the machine.
- `~/.spinner/archive/`: closed sessions.
- The repo: `docs/STATUS.md` (the record), `docs/SESSION_PROTOCOL.md` (the contract, the lessons, the decisions), `docs/sessions/` (the full mission record of each closed session and the soak list), `docs/stacks/` (recipes by stack shape), `examples/sessions/` (the templates), `local/` (private specs and notes, gitignored).

## How to run a building session

1. Read the last entries of `docs/SESSION_PROTOCOL.md` *Decisions* and the whole of `docs/sessions/soak-questions.md`.
2. Write the template under `examples/sessions/s0NN-<slug>/` (mission, briefs, `session.yaml`, `RUN.md`), check it with `python3 tools/doc-metrics.py --fail`, commit.
3. Copy it to `~/.spinner/sessions/<next id>-<slug>/`, point the repo's `.spinner` symlink at it, fill the dates and the Log's first line.
4. Launch one `spinner-agent` subagent per role (`anthropic/claude-fable-5-1`, cwd the repo, the task names the role and the brief). Launch the one that owns the shared contract first; the others when its Contracts entry is committed.
5. Deliver `inbox/` messages with `steer` (a live child) or `resume` (a finished one). Answer Open questions in the mission and in `subagent_supervisor` replies. Count the relays.
6. At the end: root checks (`pnpm -r build && pnpm -r test && pnpm lint`, `doc-metrics --fail`, `tools/actionlint.sh` if a workflow changed, a `node:24` container run if `src/stack/` or `src/pipeline/` changed), push, restart the daemon, close the record (STATUS, lessons, decisions, the session record under `docs/sessions/`, the template copy-back without the Log).

Rules that bit and are now fixed in the briefs: stage by path, never `git add -A` or `git stash`; Log times from `date`; wait on an artifact, not on a Log timestamp; scratch with `mktemp -d`, reported, never deleted; one retry on a repo-side failure, then stop; never print a file that can hold a secret; never raise or move a window over the operator's; destructive e2e only against a scratch daemon; never signal a pid without its identity.

## The operator's current work

The operator adopted a real PR into a session, attached the project (worktrees on the PR's branch), brought the stack up, added an agent, and uses the desktop app. The next milestones on that session are `create PR` is not needed (the PR exists), `fix` when the review bot posts, `verify`, `post`, `approve`, `land`: the last one is the live test of the merge-queue enqueue, the only M2 fact without a live run.

## Open decisions

1. **Stacked PRs** (option B in the chat of 2026-10-29): a session holds an ordered list of PRs per repo, the worktree at the top, `adopt` walks the base chain, `land` goes bottom-up. `session.yaml` moves to version 2. The operator's PR is itself a stack of two. Waiting for the operator's go.
2. **Signing and distribution** of the desktop app (M5): an Apple developer account for a notarized `.app`; the local unsigned build works today.
3. **`threads.autofix: all`** stays off until the operator trusts the fixer enough to let it run without the `fix` click.
4. **The Slack token** has been in the chat transcript; the operator chose not to rotate it.

## Open work, by size

- The soak list, `docs/sessions/soak-questions.md`: the verify toggle, `seed_files` after `install`, the pop-out reason in `needs_human`, `up` under 15 s on a stack with host services, a flaky daemon test under load (`plumbing.test.ts`), session ids unique across homes including session directories.
- M4 leftovers: a signed build, the tray's state detail, a stranger's run of the README.
- M5: packaging, `spinner init` from the recipes, the public repository with a changelog, the protocol at v2 if the stacks land.
