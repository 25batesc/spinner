# Implementation status

This file is the project workbook for Spinner itself. It says what exists, what is proven, what is open, and what it cost. The operator updates it when a session closes. [ROADMAP.md](ROADMAP.md) holds the plan. This file holds the record.

Each exit criterion has one of three states:

- **done**: the criterion holds, and the evidence column names the command, the commit, or the run that shows it.
- **partial**: part of the criterion holds. The evidence column names which part is missing.
- **open**: nothing holds yet.

Updated: 2026-10-27, during session s002 round 3.

## Summary

| Milestone | State | Sessions | Agent cost | Wall clock | Tests |
|---|---|---|---|---|---|
| M0 · Bootstrap | done | s001 | $5.80 | 17 min | 37 |
| M1 · Board + stack runner | partial | s002 (2 rounds) | $44.66 | 105 min | 117 |
| M2 · Agents drive PRs home | open | | | | |
| M3 · Web UI | open | | | | |
| M4 · Desktop | open | | | | |
| M5 · Release | open | | | | |

The repo holds 37 commits, 9 by the operator and 28 by agents. `pnpm -r build && pnpm lint && pnpm -r test` is green at commit `6afc823` with 117 tests.

## What exists

| Package | Contents | Hides |
|---|---|---|
| `@spinner/protocol` | `Session` (session.yaml), `SpinnerEvent` (17 types), `ROUTES`, `PipelineFacts`, `StackSpec` (spinner.yaml); generated JSON schemas for both files, with a drift test | the file formats |
| `@spinner/daemon` | session store; Hono server on `127.0.0.1:7777` with a WebSocket at `/events`; chokidar watcher; `pipeline/` (GitHub collector, `derive_stage`, poller, notifier, adopt, verify); `stack/` (spec loader, compose renderer, Docker and Traefik, Postgres template clone, host services, runner); `git/` (worktrees) | GitHub, Docker, Postgres, git |
| `@spinner/cli` | `spinner new`, `show`, `adopt`, `board`, `verify`, `seed`, `up`, `down`, `logs`, `exec`, `close` | the daemon's internals |
| `ui` | three resizable panes, WebSocket client, reducer-only state, fixture server, `new session` form | how a preview is embedded (`Preview.tsx`) |
| `examples/sample-stack` | API with `GET /items` and `GET /health`, one web page, Postgres in template mode, Temporal, `seed.sql`, `spinner.yaml` | nothing; it is the test vehicle |

## M0 · Bootstrap (done, 2026-10-26)

| Exit criterion | State | Evidence |
|---|---|---|
| Both agents finish `packages/protocol` and a walking skeleton of each package without editing the same file twice | done | 8 agent commits `6e95caf`..`0e2c597`; the one shared write was `pnpm-lock.yaml` |
| The protocol doc gets its first revision from things that went wrong | done | *Lessons from s001* in [SESSION_PROTOCOL.md](SESSION_PROTOCOL.md#lessons-from-s001), 7 rules |
| `pnpm -r build && pnpm -r test` green | done | 37 tests at `0e2c597` |
| A session created from the UI and one from the CLI appear through `session.created` | done | headless Chrome run against the real daemon, screenshot checked by the operator |

Record: engine agent $5.15 (claude-fable-5-1, 54 turns, 11 min), ui agent $0.65 (claude-sonnet-5-5, 2 runs, 5 min). Operator relays 2, agent notifications 5, blocking decisions 0. Full mission record: [sessions/s001-MISSION.md](sessions/s001-MISSION.md).

## M1 · Pipeline board + stack runner (partial)

### Track A · Board

| Exit criterion | State | Evidence |
|---|---|---|
| `spinner adopt <pr-url>...` creates a session from existing PRs | done | `31181d7`; three real knit-3.0 PRs adopted in a scratch home |
| `spinner board` shows every session with the right stage and `needs_human` | done | #4825 → *fixing* (2 open bot threads), #4815 → *verifying* then *peer-review* after `spinner verify`, #4404 → *merged*; the operator compared each with `gh pr view` and the review threads on 2026-10-26 |
| Stage derivation is a pure function with a fixture test per stage-table row | done | `031d52c`, `derive-stage.test.ts`: 23 tests, one per row plus pop-out, push-clears-verify, new bot threads re-enter *fixing*, multi-PR earliest-wins |
| A merge-queue pop-out on a real PR produces a macOS notification within one poll interval | partial | the real pop-out of #4404 (`failed_checks`) replays through a fake `gh` in `poller.test.ts`, and the `osascript` notifier fired once on a real transition. A live pop-out on a throwaway PR is open: Plan item 9, operator |
| `spinner board --watch` re-polls and redraws | done | polled 2 open-PR sessions every 5 s in the run; `--refresh` takes 2.5 s for 3 sessions |

Fixtures from real PRs, scrubbed, under `packages/daemon/test/fixtures/github/`: `pr-approving`, `pr-fixing`, `pr-bot-authored`, `pr-merged-after-popout`, and the query `pr-facts.graphql`. The scrubber is `scrub.ts`.

### Track B · Stack runner

| Exit criterion | State | Evidence |
|---|---|---|
| `examples/sample-stack` comes up with `spinner new/up/down/close` | done | `07cf8c8`; `up` 3.2 s warm for a fresh session, 2.4 s after `down`; `up` twice succeeds; `close` after a failed `up` succeeds |
| `examples/sample-stack` comes up in CI | open | CI runs the unit tests only. A compose run in GitHub Actions is not wired |
| Two sessions of the sample stack side by side on their own hostnames | done | `api.s003.localhost` and `api.s004.localhost` answered `GET /health` with their own session id through Traefik; `X-Frame-Options` stripped through the proxy |
| Two sessions of the operator's project side by side, both logged in, Temporal UI per session | partial | two sessions (s005, s006 on 2026-10-27): `api`, `web`, `admin`, `temporal` answer 200 on both through Traefik; `web` compiles on the host; the login page renders; Google SSO is blocked by Cognito (finding 12); password login under test. Round 2 state for one session: the backend answers `GET /health/ready` → 200 through Traefik (`api.s003.localhost`) with `database: ok` on the clone `spinner_s003` (`pg_stat_activity` shows 4 backend connections) and `temporal: ok` on the session's Temporal; the worker started with 49 workflows; admin and Temporal UI answer 200. Open: `web` (finding 6), `copilot` (finding 7), the second session (finding 8), login (finding 5) |
| `spinner up` under 15 s warm | partial | 3.2 s on the sample stack. Knit: 20.0 s and 25.9 s with everything warm, with `web` on the host (the backend preflight and start take most of it) |
| `spinner close` leaves no containers, worktrees or databases behind | partial | `tools/stack-proof.sh` passes for containers, worktrees, databases and branches. Host processes: after round 2 the operator found 5 strays (the s003 worker, the s004 copilot) that the proof missed (finding 9) |
| `pnpm -r build && pnpm -r test` green | done | 108 tests at `fc83d1c` (protocol 11, daemon 75, ui 9, cli 13) |

### Open findings from the Knit run

| # | Finding | Owner | Next action |
|---|---|---|---|
| 1 | The backend cannot run in a linux/arm64 container: `mediapipe` has no aarch64 wheel. Decided: `runtime: host` (Decisions entry 4) | done | none |
| 2 | knit-3.0 installs from `requirements-ci.txt`, not `uv.lock`. The operator ran `make venv-sync`; `seed_links: [apps/ai/.venv]` reuses that venv; `preflight: .venv/bin/python -c "import api"` fails `up` fast on drift (`import main` loads nothing; uvicorn imports `api` in its child) | done | none |
| 3 | Doppler's values won over Spinner's env | done in `c6b3495` | none |
| 4 | A host service inherited the caller's stdio | done in `57421b6` | none |
| 5 | Login on two sessions at once is untested. Auth and storage are on the team's cloud dev Supabase (Doppler `dev_local` and `apps/ai/.env` point there); only Postgres is local. The spec no longer overrides `SUPABASE_URL` (a cloud key against the local server gave `403 Invalid Compact JWS`) | operator | test after findings 6 to 8 |
| 6 | `web` (knit-insights) fails to install in the node dev image: `npm ci` hits ERESOLVE, and with the team's `npm install --legacy-peer-deps` (now `install:` in the spec) `node-sass` needs `python3` and build tools in the image | stack agent | add `python3`, `make`, `g++` to `local/knit/images/Dockerfile.node`; one `up` |
| 7 | `copilot` on the host fails with `Cannot find module '@tiptap/extension-unique-id'`: the linked primary `node_modules` of `apps/copilot-runtime` is behind its lockfile | operator | `pnpm install` in `~/knit/knit-3.0`; then `preflight: test -d node_modules` is not enough, use `pnpm exec tsc --noEmit` or a require of the entry module |
| 8 | The worker's health server binds a fixed port 8080 (`WORKER_HEALTH_PORT`), so a second session collides | done in the spec | `WORKER_HEALTH_PORT: "${PORT}"` on the worker |
| 9 | Stray host processes survived `close` and escaped the argv-based sweep | done in `437adf5` | process groups, pid files, strays matched by cwd |
| 10 | `spinner new` branches from the local base branch. The operator's local `dev` in knit-insights was 482 commits behind `origin/dev`, so the worktree still imported antd, which `dev` retired in August | stack agent | `new` fetches and branches from `origin/<base>`, as the team's `wt` tool does; the operator fast-forwarded `dev` by hand for now |
| 11 | `seed_links: [KnitUI/node_modules]` links the primary checkout's install, which belongs to the primary's branch, not the worktree's. `dev` added `fractional-indexing`; the link lacks it | stack agent | link only when the lockfile hash matches the primary's; otherwise run `install:` in the worktree |
| 12 | Google SSO fails with `redirect_mismatch`: the app sends `window.location.origin + '/auth/sso'` and the `knitdev` Cognito app client accepts a fixed list of callback URLs, no wildcards | operator, Cognito admin | add `http://web.s001.localhost/auth/sso` to `s020` to the app client once; Spinner reserves ids in that range. Email and password sign-in works without it |
| 13 | A full webpack build of KnitUI does not fit in the Docker VM (7.7 GB): Node OOM at the default heap, then exit 137 at 6 GB. Lazy compilation (`WEBPACK_LAZY=true`) serves modules from a random `localhost` port, unreachable through Traefik from a container | done in the spec | `web` runs on the host (`runtime: host`), with `--port $PORT` and `--client-web-socket-url auto://0.0.0.0:0/ws` |
| 14 | The seed template was copied without migrations: the backend logs `relation "questionnaire_chat_sessions" does not exist` every minute | stack agent | `seed rebuild` applies `seed.migrate` on the template after the copy |
| 15 | The copied `envs/.env.local` points copilot at `localhost:4100`; each session's copilot has its own host port | stack agent | a `copilot` hostname and `env_file` overrides for the two `REACT_APP_COPILOTKIT_*` keys |

### Record

Round 1: board agent $8.83 (claude-fable-5-1, 22 min), stack agent $24.60 (75 min); operator relays 3 (one decision, two steers); agent-to-operator calls 2. Round 2: stack agent $11.23 (30 min); operator relays 4 (steers); the operator killed hung backends by hand three times (reloader parents that survive a failed startup) and found the Supabase and install facts from the logs. Full mission record: [sessions/s002-MISSION.md](sessions/s002-MISSION.md).

### Next

1. Operator: `pnpm install` in `~/knit/knit-3.0` (finding 7); the seed project UUIDs for the slim template; the live pop-out test (Plan item 9); one day of `spinner board` against real work (Plan item 9).
2. Stack agent, round 3 of s002: findings 6 and 9, then two Knit sessions side by side. Exit: `web.s1.localhost` and `web.s2.localhost` both serve the app, logged in, with `api` 200 on each, and `tools/stack-proof.sh` passes with host processes included.
3. Then the soak week before M2 (ROADMAP).

## Budget

Estimates before the work were "days 1 to 3" for s001 and "weeks 2 to 3" for s002. The actual wall clock was 17 minutes and 75 minutes of agent time, plus the operator's time to relay, verify and write. The cost driver is not implementation. It is the acceptance test against the real project, which needs the operator's repos, logins and data.

| Session | Agents | Agent cost | Agent wall clock | Operator relays |
|---|---|---|---|---|
| s001 | engine, ui | $5.80 | 17 min | 2 |
| s002 round 1 | board, stack | $33.43 | 75 min | 3 |
| s002 round 2 | stack | $11.23 | 30 min | 4 |
| Total | | $50.46 | 122 min | 9 |

Space per session, measured on the sample stack: 3 containers, one database clone, one network. Not yet measured on Knit.

## Organization

- Architect and operator: Cullen Bates. Owns *Goal* and *Done when*, the protocol, the decisions.
- Agents: `spinner-agent` runs as a pi subagent per session role, from one parent pi session at the repo root. The parent is the message bus until M2.
- Precedence when documents disagree: `SESSION_PROTOCOL.md` > `STACK_SPEC.md` > `ARCHITECTURE.md` > `ROADMAP.md` > this file > session files.
