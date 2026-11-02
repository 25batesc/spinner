# Handoff: how to pick Spinner up in a fresh session

This page is for the operator and for an agent that opens a new chat with no memory of the last one. It says what runs, where the state lives, how to resume the work, and what the open decisions are. [STATUS.md](STATUS.md) holds the full record per milestone. This page holds only what you need in the first ten minutes.

Updated: 2026-11-02, after s017 and v0.7.0.

## State in one paragraph

Spinner builds Spinner. M0 to M3 are done; M4 is in daily use. The releases run `v0.1.0` (2026-10-31) to `v0.7.0` (2026-11-02). They added the soak fixes, the operator agent (now off), the diff tab, costs, the design pass, chat-first sessions with the mission workspace, the review step, and the Reviews panel. The repo holds 273 commits, 209 by agents, 536 tests, CI with two jobs. Agent cost to date about $490. Every session since s001 ran as pi subagents from one parent chat. Since s016 the lead agent of each session owns the mission. That is the shape the operator wants.

## What changed since v0.1.0

- `v0.2.0` s012: UI snapshot per daemon commit, settings applied to new agents, verify undo, the narrow window, cookies per session, the watcher race, ids across homes.
- `v0.3.0` s013: the operator agent (one per home, the headset tab). Off by default since s016; the host stays.
- `v0.4.0` s014 and s015: the `diff` tab and costs. The viewer is fetched on first use under `~/.spinner/diffview/`, one per repo. Comments become notices and `needs you`; the tools are `diff_comments` and `diff_reply`. Costs come from the transcripts: `$` on cards and chips, `GET /costs`, Settings → Usage.
- `v0.5.0` the design pass: one button system, type and spacing scales, pills and rings, hairlines, labelled forms (`packages/ui/DESIGN-PASS.md`).
- `v0.6.0` s016: a session starts from one paste and `Start`. `POST /sessions/extract` finds PR references, adoptable or reference-only. The lead agent owns the mission with `session_title`, `mission_goal`, `mission_done_when`, `mission_plan`, `agent_add` and `adopt`. Plan items carry ids and tick times. `GET /sessions/:dir/mission/view` feeds the mission workspace. Also the `review` step, the toolbar in the context bar, markdown in context (mdview's stack, MIT), and expanded previews as one state.
- `v0.7.0` s017: the Reviews panel. A review is a session of kind `review`: a detached checkout at the PR head and one tty reviewer per model in `settings.review.models`. Reviewers follow the review skill's brief and post inline COMMENT reviews only. The cards show CI and decision pills; the pane shows swarm chips with state and cost, and the threads live.

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

## Versions and rollback

Releases are annotated git tags `vX.Y.Z`, made with `tools/release.sh vX.Y.Z "summary"` on a clean tree with CI green; the script writes the version into every `package.json`, commits, tags and pushes. The first is `v0.1.0`, the state in daily use on 2026-10-31, tagged before the s012 soak fixes. Every session that changes behaviour ends with a release, so a change that does not satisfy can be undone:

```
git checkout v0.1.0
pnpm install --frozen-lockfile && pnpm -r build
# then restart the daemon (see "What runs"), and `pnpm desktop` or `pnpm desktop:build` for the app
```

`main` keeps moving; a rollback is a checkout, not a revert. When a tag is the keeper, say so and the next session starts from it.

## Open decisions

1. **Stacked PRs** (option B, 2026-10-29). A session holds an ordered list of PRs per repo, with the worktree at the top. `adopt` walks the base chain. `land` goes bottom-up. `session.yaml` moves to version 2. Waiting for the operator's go after a week of daily use.
2. **Signing and distribution** of the desktop app (M5): an Apple developer account for a notarized `.app`; the local unsigned build works today.
3. **`threads.autofix: all`** stays off until the operator trusts the fixer enough to let it run without the `fix` click.
4. **The Slack token** has been in the chat transcript; the operator chose not to rotate it.
5. **The operator agent** is built and off; delete the host or keep it dormant. Recommended: keep until s016's lead has had a week of use.

## Open work, by size

- Queued next. The `docs` tab: mdview as a host process per session, fetched on first use like the diff viewer, with its comments loop as notices. Preview signals to the agent: console errors, failed requests, screenshot (M4's exit criterion). `spinner init` from the recipes.
- The soak list, `docs/sessions/soak-questions.md`. `plumbing.test.ts` still misses one run in three under full load; a retry keeps CI honest. The machine-memory figure rounds differently in two places (48 vs 52 GB). The e2e drivers leave scratch daemons and Chrome processes when an agent ends by error; the parent kills them by hand today.
- Records: STATUS and the lessons are current through s017; the soak rows closed in s012 are marked; costs in STATUS are from the subagent runs' `status.json`.
- M5: packaging, `spinner init`, the public repository with a changelog, the protocol at v2 if the stacks land.
