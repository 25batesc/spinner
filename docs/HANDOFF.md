# Handoff: how to pick Spinner up in a fresh session

This page is for the operator and for an agent that opens a new chat with no memory of the last one. It says what runs, where the state lives, how to resume the work, and what the open decisions are. [STATUS.md](STATUS.md) holds the full record per milestone. This page holds only what you need in the first ten minutes.

Updated: 2026-11-12, after v0.25.0 and the approved redesign.

## State in one paragraph

Spinner is in daily use on real work. Since 2026-11-12 its way of working is the fast path: the operator talks, the lead changes code, tests it, opens the pull request and keeps it ready. EGM planning is a tool he picks. The design is `docs/designs/talk-change-ship.md`; step 1 of 5 is built. The releases run `v0.1.0` to `v0.25.2`. The daemon suite has 502 tests.

## What changed since v0.1.0

- `v0.2.0` to `v0.7.0` (2026-11-01 to 02): soak fixes, the operator agent (off by default), the diff tab, costs, the design pass, chat-first sessions with the mission workspace, the Reviews panel.
- `v0.8.0` s018: a review runs the operator's `pr-review` skill end to end. Headless reviewers return verdicts. A headless lead writes the briefing and drafts one review in one voice. The operator posts with one click.
- `v0.9.0` to `v0.14.0`, EGM sessions 1 to 6. Session 1: EGM fetched and pinned under `~/.spinner/egm/`, with generated Goldfish agent files. Session 2: the design stage derived from files, `design_doc`, the stepper, rounds. Session 3: the design-track lead brief, skill buttons, the `EGM ▾` menu, gate cards. Session 4: Goldfish chips with live state and cost, transcripts. Session 5: the design workspace with Brief, Design, Review, Files and History. Session 6: `approve and build`, re-approval on edits with the guard, the PR body from the doc, outcome counters. The evidence is in `docs/egm/HARNESS_EVIDENCE.md`: runs A to H with the real pi.
- `v0.12.0` to `v0.13.1`: the sidebar in VS Code's shape (rail, one panel per view, `+ New …`), the reload focus fix, the needs-you badges count only unseen sessions.
- `v0.15` to `v0.19`: the composer in the working area; the session workspace (one row of views, Implement, the Plan seeded from the doc), built by Spinner sessions on the `spinner` project.
- `v0.20` to `v0.23`: the previews pop-out with every tab, file drop on the terminal, the working dot and recency in the sidebar, the worktree sync, preview comments.
- `v0.24`: `settings.agents.github` (`guarded` or `full`), a daemon that survives a failed probe, agents that resume after a restart, `resume` on the chip.
- `v0.25`: the fast path as the default, `pr open` and `stack up` for the lead, the autopilot.

## What runs on the operator's machine

| Thing | Where | How to check |
|---|---|---|
| The daemon | `node packages/daemon/dist/main.js` on `127.0.0.1:7777`, home `~/.spinner` | `curl -s localhost:7777/health` shows the build commit |
| The web UI | served by the daemon at `http://localhost:7777` | open it |
| The desktop app | `pnpm desktop` from the repo, or `packages/desktop/dist-app/Spinner-darwin-arm64/Spinner.app` | the window titled Spinner; it connects to the running daemon |
| The proxy and the managed Postgres | `spinner-proxy` on `:80`, `spinner-postgres` on `:55432`, route files in `~/.spinner/proxy/` | `docker ps --filter name=spinner` |
| The operator's project stack | sessions under `~/.spinner/sessions/`, host services under the session's `log/` and `stack/pids/` | `spinner show <id>` |

The daemon needs three things in its environment. `SLACK_USER_TOKEN` posts as the operator. `SPINNER_PI` names the pi binary, under the Node version that installed it. Node 24 must be on PATH. `~/.spinner/env` holds the first two; never print that file. Check first that no agent is in a turn (`process: running` in `GET /sessions`), then restart:

```
cd ~/Spinner && pnpm -r build
pid=$(lsof -nP -iTCP:7777 -sTCP:LISTEN -t); kill $pid; sleep 5
unset SPINNER_HOME; set -a; . ~/.spinner/env; set +a
(nohup pnpm --silent daemon > ~/.spinner/daemon.log 2>&1 &)
sleep 40; curl -s localhost:7777/health
```

Always unset `SPINNER_HOME`. A daemon started with a stray one reads an empty home, and the app then shows no sessions. The Sessions panel names a home that is not `~/.spinner`.

A UI change needs a daemon restart and a reload of the window (⌘R). An Electron change needs the app quit and `pnpm desktop` again. A restart stops every agent; the new daemon resumes each tty agent on its transcript, but a turn in flight is lost.

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
   From a session agent's shell, run the tests as `env -u npm_config_reporter -u SLACK_USER_TOKEN pnpm -r test`.
   A daemon started with `pnpm daemon` passes pnpm's `npm_config_reporter=silent` to every agent, and pnpm then prints nothing but the exit code.
   With `SLACK_USER_TOKEN` set, `loop.test.ts` takes the real Slack transport and fails.
   The spawn of an agent drops the other agent's `SPINNER_*` and `PI_SUBAGENT*` variables (s046 r3.7), so `agents.test.ts` passes from a lead's shell.

Rules that bit and are now in the briefs: stage by path, never `git add -A` or `git stash`. Log times from `date`. Wait on an artifact, not on a Log timestamp. Scratch with `mktemp -d`, reported, never deleted. One retry on a repo-side failure, then stop. Never print a file that can hold a secret. Never raise or move a window over the operator's. Destructive e2e only against a scratch daemon, and a driver never defaults to the operator's port. Never signal a pid without its identity. A driver closes its CDP target when it ends.

## The direction since 2026-11-12

Read `docs/designs/talk-change-ship.md` first. The operator approved it. Spinner's main job is a request in and a mergeable pull request out, kept ready by the agent. The fast path is the default; EGM planning is a tool he picks.

Steps 1 to 4 of 5 are built. Step 1 (`v0.25.0`) is the fast path, the lead's `pr open` and `stack up`, and the autopilot. Step 2 (`v0.26.0`) is several changes in one session: the `change` tool, the poll and the autopilot per change, the Changes rail, the Pull requests view. Step 3 (`v0.27.0`) is `test locally` on a change. Step 4 (`v0.28.0`) is the plans library: planning sessions, the Plans view, `Implement`. `docs/DAEMON_API.md` has the sections "The fast path and the autopilot", "Changes" and "Plans". Step 5 is built in parts (`v0.29.0`, `v0.30.0`): the chat as the default surface of an agent, its message box (files, skills, model, thinking level, dictation), the session's PR view and chip, the Agents view as rows. Open in step 5: what becomes of the middle pane's view tabs.

## The operator's current work

The operator is dogfooding on real work (knit sessions s039 to s044 in `~/.spinner/sessions/`; the pre-EGM sessions are under `~/.spinner/archive/`). His notes go to `~/pi-docs/domain/spinner/dogfood-2026-11-03.md` (outside the repo): 33 numbered rows, each with the note, the cause, the proposed change and a status. The agent collects notes there and fixes only what the operator calls blocking. Fixed on the day. The review models, in settings. `write_repos` for the knit repos, in the project spec and the live sessions' copies. The Slack post shape and the verified tick (`v0.15.1`). pi's "Trust project folder?" dialog, which blocked every new agent (`--approve`, `v0.15.2`). The quiet pi startup, in the operator's pi settings.

The revision pass comes after the dogfooding: read the notes file first. The decided direction is #32: Spinner's own chat as the primary surface for every agent, the terminal opt-in; it folds #7, #20, #26, #30, #31. The large design items: #9, Focus mode per project. #13, the diff pane follows the selection, and reviews need a branch. #16 and #17, one workspace (Brief · Design · Review · Implement · History) with the mission view kept as Implement and its Log grown into the timeline. #28, a `fish` view. #29, file editing. #33, environments per project (`run local` against dev or prod). Each is a candidate for the design track on the Spinner repo, which is also the first real use of EGM on its own repo.

## Versions and rollback

Releases are annotated git tags `vX.Y.Z`, made with `tools/release.sh vX.Y.Z "summary"` on a clean tree with CI green; the script writes the version into every `package.json`, commits, tags and pushes. The first is `v0.1.0`, the state in daily use on 2026-10-31, tagged before the s012 soak fixes. Every session that changes behaviour ends with a release, so a change that does not satisfy can be undone:

```
git checkout v0.1.0
pnpm install --frozen-lockfile && pnpm -r build
# then restart the daemon (see "What runs"), and `pnpm desktop` or `pnpm desktop:build` for the app
```

`main` keeps moving; a rollback is a checkout, not a revert. When a tag is the keeper, say so and the next session starts from it.

## Open decisions

1. **Stacked PRs** (option B, 2026-10-29): waiting for the operator's go. A design PR under a code PR is the same shape (D2 in the EGM design).
2. **Signing and distribution** of the desktop app (M5).
3. **`threads.autofix: all`** stays off.
4. **The Slack token** has been in the chat transcript; the operator chose not to rotate it.
5. **The operator agent** is built and off; the host stays dormant.
6. **An upstream pi adapter for EGM** (D14): not now; EGM's `AI_POLICY.md` forbids autonomous PRs and needs the CLA.

## Open work, by size

- The dogfooding notes, `~/pi-docs/domain/spinner/dogfood-2026-11-03.md`: the revision pass works from that file, status column `open`.
- Small, from before. `docs/designs/README.md` duplicates `SITEMAP.md`; the guard blocks `rm` on READMEs, so the operator removes it. The context-bar title shrinks at 1600 px. `packages/desktop/e2e/sample-session.ts` clicks a label that no longer exists. The driver flows `pipeline` and `history` fail on the fixture.
- Records: `docs/sessions/` has s001 to s037; s038 (the composer) has none yet; lessons 37 to 42 are in; STATUS stops at s037.
- Queued, each its own session. The `docs` tab (mdview). Preview signals to the agent (M4's exit criterion). `spinner init`. The first live `land`. The drift report badge (D10). The stacked-PRs decision.
- M5: packaging, the public repository with a changelog.
