# Implementation status

This file is the project workbook for Spinner itself. It says what exists, what is proven, what is open, and what it cost. The operator updates it when a session closes. [ROADMAP.md](ROADMAP.md) holds the plan. This file holds the record.

Each exit criterion has one of three states:

- **done**: the criterion holds, and the evidence column names the command, the commit, or the run that shows it.
- **partial**: part of the criterion holds. The evidence column names which part is missing.
- **open**: nothing holds yet.

Updated: 2026-10-27, after session s002.

## Summary

| Milestone | State | Sessions | Agent cost | Wall clock | Tests |
|---|---|---|---|---|---|
| M0 · Bootstrap | done | s001 | $5.80 | 17 min | 37 |
| M1 · Board + stack runner | partial | s002 | $33.43 | 75 min | 108 |
| M2 · Agents drive PRs home | open | | | | |
| M3 · Web UI | open | | | | |
| M4 · Desktop | open | | | | |
| M5 · Release | open | | | | |

The repo holds 26 commits, 6 by the operator and 20 by agents. The code is 6,537 lines of TypeScript in `packages/*/src`, plus 1,831 lines of tests. `pnpm -r build && pnpm lint && pnpm -r test` is green at commit `fc83d1c`.

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
| Two sessions of the operator's project side by side, both logged in, Temporal UI per session | open | see *Open findings* 1 to 3. `spinner new --project knit` creates the three worktrees with the seeded local files; `seed rebuild --copy-only` built the `knit_seed` template (83 tables); `admin.s009.localhost` and `temporal.s009.localhost` answered 200; the backend did not start |
| `spinner up` under 15 s warm | done | 3.2 s on the sample stack. Not measured on Knit |
| `spinner close` leaves no containers, worktrees or databases behind | done | after the run, the operator checked: `docker ps -a --filter name=spinner` empty, `git worktree list` in the three Knit repos shows only the operator's own trees, no `spinner_*` database on the Supabase Postgres, no host processes, no `feat/knit-*` branches |
| `pnpm -r build && pnpm -r test` green | done | 108 tests at `fc83d1c` (protocol 11, daemon 75, ui 9, cli 13) |

### Open findings from the Knit run

| # | Finding | Owner | Next action |
|---|---|---|---|
| 1 | The backend cannot run in a linux/arm64 container: `mediapipe` has no aarch64 wheel. Decided: `runtime: host` (Decisions entry 4) | done | none |
| 2 | On `develop`, `apps/ai/uv.lock` is behind the code: a venv built from the lock lacks `sentry_sdk.integrations.logging.ignore_logger_for_sentry_logs` (lock pins 2.51.0). The operator's primary venv is also behind: it lacks `litellm.exceptions.ModelNotMappedError` (lock pins 1.103.7). Neither venv runs `develop` today | operator, in knit-3.0 | find out how CI builds the AI image; sync the lock or the venv; then Spinner's `seed_links: [apps/ai/.venv]` reuses it |
| 3 | The Doppler wrapper applies its `dev_local` values after Spinner's env, so a Doppler value wins over `DATABASE_URL` and `PORT`, and the worker fails with `socket.gaierror` on a hostname that comes from Doppler or `apps/ai/.env`, not from the spec. The spec's own `env` keys already get host-side addresses for `runtime: host` | stack agent, then operator | apply Spinner's env inside the wrapper (`wrapper -- env K=V command`) so it wins; log the first unresolvable hostname with the variable that holds it, so the operator can override it in the spec's `env` |
| 4 | A host service inherited the caller's stdio, so `spinner up` hung until the operator killed the process by hand, twice | done in `57421b6` | a test now checks that `up` returns while a host service lives |
| 5 | Login on two sessions at once is untested. Supabase auth is shared, so a token from one session is valid on the other | operator | test after finding 3 |

### Record

Board agent $8.83 (claude-fable-5-1, 22 min). Stack agent $24.60 (claude-fable-5-1, 75 min). Operator relays 3 (one decision, two steers). Agent-to-operator calls 2. Full mission record: [sessions/s002-MISSION.md](sessions/s002-MISSION.md).

### Next

1. Stack agent, round 2 of s002: finding 3, then the Knit `up` on one session. Exit: `api.s1.localhost/health/ready` answers 200 through Traefik with the backend on the host and `DATABASE_URL` pointing at `spinner_s1`.
2. Operator: finding 2 in knit-3.0; the seed project UUIDs for the slim template; the live pop-out test (Plan item 9); one day of `spinner board` against real work (Plan item 9).
3. Then the soak week before M2 (ROADMAP).

## Budget

Estimates before the work were "days 1 to 3" for s001 and "weeks 2 to 3" for s002. The actual wall clock was 17 minutes and 75 minutes of agent time, plus the operator's time to relay, verify and write. The cost driver is not implementation. It is the acceptance test against the real project, which needs the operator's repos, logins and data.

| Session | Agents | Agent cost | Agent wall clock | Operator relays |
|---|---|---|---|---|
| s001 | engine, ui | $5.80 | 17 min | 2 |
| s002 | board, stack | $33.43 | 75 min | 3 |
| Total | | $39.23 | 92 min | 5 |

Space per session, measured on the sample stack: 3 containers, one database clone, one network. Not yet measured on Knit.

## Organization

- Architect and operator: Cullen Bates. Owns *Goal* and *Done when*, the protocol, the decisions.
- Agents: `spinner-agent` runs as a pi subagent per session role, from one parent pi session at the repo root. The parent is the message bus until M2.
- Precedence when documents disagree: `SESSION_PROTOCOL.md` > `STACK_SPEC.md` > `ARCHITECTURE.md` > `ROADMAP.md` > this file > session files.
