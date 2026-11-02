# Implementation status

This file is the project workbook for Spinner itself. It says what exists, what is proven, what is open, and what it cost. The operator updates it when a session closes. [ROADMAP.md](ROADMAP.md) holds the plan. This file holds the record.

Each exit criterion has one of three states:

- **done**: the criterion holds, and the evidence column names the command, the commit, or the run that shows it.
- **partial**: part of the criterion holds. The evidence column names which part is missing.
- **open**: nothing holds yet.

Updated: 2026-11-02, after s017 and v0.7.0. A fresh session starts from [HANDOFF.md](HANDOFF.md).

## Summary

| Milestone | State | Sessions | Agent cost | Wall clock | Tests |
|---|---|---|---|---|---|
| M0 · Bootstrap | done | s001 | $5.80 | 17 min | 37 |
| M1 · Board + stack runner | done, 2026-10-27 | s002 (5 rounds) | $77.68 | 161 min | 132 |
| M2 · Agents drive PRs home | done except the operator's real feature | s003, s005 | $75.53 | 170 min | 233 |
| M3 · Web UI | done (record), 2026-10-29 | s003, s005, s006 | (in s003, s005, s006) | | |
| M4 · Desktop | built, in daily use; signing open | s007, s008, s011 | $65.98 + s011 | 198 min + s011 | 386 |
| M4b · Daily use: soak, diff, costs, chat first, reviews | done (v0.2.0 to v0.7.0) | s012 to s017, design | $240 | 11 h | 536 |
| M5 · Release | open | | | | |

The repo holds 171 commits at `91307dd`, 130 of them by agents. `pnpm -r build && pnpm lint && pnpm -r test` is green at that commit with 386 tests: protocol 16, daemon 206, desktop 68, pi-extension 12, ui 60, cli 24. One daemon test, `plumbing.test.ts`, is flaky under a loaded machine; it failed once in the 2026-10-30 run and passed alone.

## What exists

| Package | Contents | Hides |
|---|---|---|
| `@spinner/protocol` | `Session` (session.yaml), `SpinnerEvent` (17 types), `ROUTES`, `PipelineFacts`, `StackSpec` (spinner.yaml); generated JSON schemas for both files, with a drift test | the file formats |
| `@spinner/daemon` | session store; Hono server on `127.0.0.1:7777` with a WebSocket at `/events`; serves the UI at `/`; `jobs/` (one job per action, bounded log); `actions.ts` (shared by the CLI and the routes); `views/` (`SessionView` from the store, the tracker and a stack observer); the poller and the notifier as a daemon loop; `pipeline/` (GitHub collector, `derive_stage`, adopt, verify); `stack/` (spec loader, compose renderer, Docker and Traefik, Postgres template clone, host services, runner); `git/` (worktrees); `agents/` (`PiTtyHarness` over a pty and the extension channel, `PiRpcHarness` over pi's RPC mode, manager, models, history); `settings.ts` (`settings.yaml`, themes); `stack/usage.ts` (the sampler) | GitHub, Docker, Postgres, git, pi |
| `@spinner/cli` | `spinner new`, `show`, `adopt`, `board`, `verify`, `seed`, `up`, `down`, `logs`, `exec`, `close`; the actions call the daemon's `actions` module | the daemon's internals |
| `@spinner/desktop` | Electron 45: a window on the daemon's UI, a tray, daemon discovery and start, one `WebContentsView` per preview (hidden tabs kept, destroyed on close, pop-out into a window that adopts the view), the browser-bar actions (navigate, back, forward, zoom, find, clear storage) and the `navigated` event, a DevTools-protocol e2e driver, `pnpm desktop:build` → a local unsigned `.app` | Electron |
| `ui` | the sketch: sessions and board pane (sorted by `needs_human`, stage badge, per-PR lines, new and adopt forms), session view (service table, action buttons, job log drawer), previews (grey until healthy, open-in-tab, reload, the verified tick), agent tabs (pi's terminal over the tty socket for a `tty` agent, the chat from `agent.event` for an `rpc` one, the context sub-tab, stop and resume); the Activity drawer; the services view with usage; the settings view with themes; fixture server; a DevTools-protocol driver for end-to-end runs | how a preview is embedded (`Preview.tsx`) |
| `examples/sample-stack` | API with `GET /items` and `GET /health`, one web page, Postgres in template mode, Temporal, `seed.sql`, `spinner.yaml` | nothing; it is the test vehicle |

## M0 · Bootstrap (done, 2026-10-26)

| Exit criterion | State | Evidence |
|---|---|---|
| Both agents finish `packages/protocol` and a walking skeleton of each package without editing the same file twice | done | 8 agent commits `6e95caf`..`0e2c597`; the one shared write was `pnpm-lock.yaml` |
| The protocol doc gets its first revision from things that went wrong | done | *Lessons from s001* in [SESSION_PROTOCOL.md](SESSION_PROTOCOL.md#lessons-from-s001), 7 rules |
| `pnpm -r build && pnpm -r test` green | done | 37 tests at `0e2c597` |
| A session created from the UI and one from the CLI appear through `session.created` | done | headless Chrome run against the real daemon, screenshot checked by the operator |

Record: engine agent $5.15 (claude-fable-5-1, 54 turns, 11 min), ui agent $0.65 (claude-sonnet-5-5, 2 runs, 5 min). Operator relays 2, agent notifications 5, blocking decisions 0. Full mission record: [sessions/s001-MISSION.md](sessions/s001-MISSION.md).

## M1 · Pipeline board + stack runner (done, 2026-10-27)

### Track A · Board

| Exit criterion | State | Evidence |
|---|---|---|
| `spinner adopt <pr-url>...` creates a session from existing PRs | done | `31181d7`; three real PRs of the operator's project adopted in a scratch home |
| `spinner board` shows every session with the right stage and `needs_human` | done | one PR with 2 open bot threads → *fixing*, one bot-authored PR with green checks → *verifying* then *peer-review* after `spinner verify`, one merged PR → *merged*; the operator compared each with `gh pr view` and the review threads on 2026-10-26 |
| Stage derivation is a pure function with a fixture test per stage-table row | done | `031d52c`, `derive-stage.test.ts`: 23 tests, one per row plus pop-out, push-clears-verify, new bot threads re-enter *fixing*, multi-PR earliest-wins |
| A merge-queue pop-out on a real PR produces a macOS notification within one poll interval | done | live test on 2026-10-27: the operator removed a queued PR by hand at 15:51:03; the board's next poll at 15:51:22 moved the session and sent the notification: 19 s, inside the 30 s interval in use. Also a replay of a real `failed_checks` pop-out in `poller.test.ts` |
| `spinner board --watch` re-polls and redraws | done | polled 2 open-PR sessions every 5 s in the run; `--refresh` takes 2.5 s for 3 sessions |

Fixtures from real PRs, scrubbed, under `packages/daemon/test/fixtures/github/`: `pr-approving`, `pr-fixing`, `pr-bot-authored`, `pr-merged-after-popout`, and the query `pr-facts.graphql`. The scrubber is `scrub.ts`.

### Track B · Stack runner

| Exit criterion | State | Evidence |
|---|---|---|
| `examples/sample-stack` comes up with `spinner new/up/down/close` | done | `07cf8c8`; `up` 3.2 s warm for a fresh session, 2.4 s after `down`; `up` twice succeeds; `close` after a failed `up` succeeds |
| `examples/sample-stack` comes up in CI | open | CI runs the unit tests only. A compose run in GitHub Actions is not wired |
| Two sessions of the sample stack side by side on their own hostnames | done | `api.s003.localhost` and `api.s004.localhost` answered `GET /health` with their own session id through Traefik; `X-Frame-Options` stripped through the proxy |
| Two sessions of the operator's project side by side, both logged in, Temporal UI per session | done | two sessions (s016, s017 on 2026-10-27, after s005 to s010): the 2.0 cloud API answers through the session's own origin (`upstreams`); the 3.0 API serves data from a fresh dev snapshot clone per session; password login on both; earlier: `api`, `web`, `admin`, `temporal` answer 200 on both through Traefik; `web` compiles on the host; the login page renders; Google SSO is blocked by Cognito (finding 12); password login under test. Round 2 state for one session: the backend answers `GET /health/ready` → 200 through Traefik (`api.s003.localhost`) with `database: ok` on the clone `spinner_s003` (`pg_stat_activity` shows 4 backend connections) and `temporal: ok` on the session's Temporal; the worker started with 49 workflows; admin and Temporal UI answer 200. Open: `web` (finding 6), `copilot` (finding 7), the second session (finding 8), login (finding 5) |
| `spinner up` under 15 s warm | partial | 3.2 s on the sample stack. the operator's project: 20.0 s and 25.9 s with everything warm, with `web` on the host (the backend preflight and start take most of it) |
| `spinner close` leaves no containers, worktrees or databases behind | done | `tools/stack-proof.sh` → `PROOF OK` after the last two-session run on 2026-10-27, host processes included (process groups and cwd match since `437adf5`) |
| `pnpm -r build && pnpm -r test` green | done | 108 tests at `fc83d1c` (protocol 11, daemon 75, ui 9, cli 13) |

### Open findings from the the operator's project run

| # | Finding | Owner | Next action |
|---|---|---|---|
| 1 | The backend cannot run in a linux/arm64 container: `mediapipe` has no aarch64 wheel. Decided: `runtime: host` (Decisions entry 4) | done | none |
| 2 | The backend repo installs from `requirements-ci.txt`, not `uv.lock`. The operator ran `make venv-sync`; `seed_links: [apps/ai/.venv]` reuses that venv; `preflight: .venv/bin/python -c "import api"` fails `up` fast on drift (`import main` loads nothing; uvicorn imports `api` in its child) | done | none |
| 3 | Doppler's values won over Spinner's env | done in `c6b3495` | none |
| 4 | A host service inherited the caller's stdio | done in `57421b6` | none |
| 5 | Login on two sessions at once is untested. Auth and storage are on the team's cloud dev Supabase (Doppler `dev_local` and `apps/ai/.env` point there); only Postgres is local. The spec no longer overrides `SUPABASE_URL` (a cloud key against the local server gave `403 Invalid Compact JWS`) | operator | test after findings 6 to 8 |
| 6 | `web` (the frontend) fails to install in the node dev image: `npm ci` hits ERESOLVE, and with the team's `npm install --legacy-peer-deps` (now `install:` in the spec) `node-sass` needs `python3` and build tools in the image | stack agent | add `python3`, `make`, `g++` to `local/<project>/images/Dockerfile.node`; one `up` |
| 7 | `copilot` on the host fails with `Cannot find module '@tiptap/extension-unique-id'`: the linked primary `node_modules` of `apps/copilot-runtime` is behind its lockfile | operator | `pnpm install` in the backend repo; then `preflight: test -d node_modules` is not enough, use `pnpm exec tsc --noEmit` or a require of the entry module |
| 8 | The worker's health server binds a fixed port 8080 (`WORKER_HEALTH_PORT`), so a second session collides | done in the spec | `WORKER_HEALTH_PORT: "${PORT}"` on the worker |
| 9 | Stray host processes survived `close` and escaped the argv-based sweep | done in `437adf5` | process groups, pid files, strays matched by cwd |
| 10 | `spinner new` branches from the local base branch. The operator's local frontend base branch was 482 commits behind `origin/dev`, so the worktree still imported antd, which `dev` retired in August | stack agent | `new` fetches and branches from `origin/<base>`, as the team's `wt` tool does; the operator fast-forwarded `dev` by hand for now |
| 11 | `seed_links` on the frontend's `node_modules` links the primary checkout's install, which belongs to the primary's branch, not the worktree's. `dev` added `fractional-indexing`; the link lacks it | stack agent | link only when the lockfile hash matches the primary's; otherwise run `install:` in the worktree |
| 12 | Google SSO fails with `redirect_mismatch`: the app sends `window.location.origin + '/auth/sso'` and the Cognito app client accepts a fixed list of callback URLs, no wildcards | operator, Cognito admin | add `http://web.s001.localhost/auth/sso` to `s020` to the app client once; Spinner reserves ids in that range. Email and password sign-in works without it |
| 13 | A full webpack build of the frontend does not fit in the Docker VM (7.7 GB): Node OOM at the default heap, then exit 137 at 6 GB. Lazy compilation (`WEBPACK_LAZY=true`) serves modules from a random `localhost` port, unreachable through Traefik from a container | done in the spec | `web` runs on the host (`runtime: host`), with `--port $PORT` and `--client-web-socket-url auto://0.0.0.0:0/ws` |
| 14 | The seed template was copied without migrations: the backend logs `relation "questionnaire_chat_sessions" does not exist` every minute | stack agent | `seed rebuild` applies `seed.migrate` on the template after the copy |
| 15 | The copied `envs/.env.local` pointed copilot at a fixed localhost port | done in the spec | a `copilot` hostname and `env_file` overrides |
| 16 | `spinner down --shared` and the proxy directory are scoped to one `SPINNER_HOME`, while `spinner-proxy` and `spinner-postgres` are machine-global containers. A second home's `down --shared` removed the proxy under a live session of the first home; a second home's `up` starts a proxy without the first home's route files. Found by a review agent | stack agent | one proxy directory per machine regardless of home (`~/.spinner/proxy` or a volume); `down --shared` refuses while any `spinner-*` compose project has containers or any route file exists; `ensure_proxy` never recreates a running proxy; session ids unique per machine |
| 17 | The frontend's `node-sass` binary is for Node 18 (ABI 108); under Node 24 its install fails. The frontend's host service runs with the project's Node version | done in the spec | `wrapper` and `install` prefix the right `fnm` binary path; a `node_version:` field would be cleaner |
| 18 | The stack agent printed a registry token from an untracked `.npmrc` into its own transcript while debugging an install. No tracked file holds it | operator | rotate the tokens if the transcript leaves the machine; the brief now names the files an agent never prints |
| 19 | The admin app reads the 3.0 API from its own variable, and the copied `.env.local` pointed it at the primary's `localhost:8000`; its three hosted APIs need `upstreams` too; one of them does not resolve in DNS from this machine | done in the spec | the private README records the hosts |
| 20 | A hand-built native binding (`node-sass`) does not come back from a fresh worktree install; every stylesheet failed and the page was blank | done in the spec | `seed_files` copies the binding; recipe updated |
| 22 | `close` signalled the process group of a reused pid and killed the operator's browser windows and an agent runner | done in `68e8ccf` | identity is pid plus start time; a legacy record needs its cwd inside the session |
| 23 | An adopted session had no worktrees and `add agent` wanted a brief nothing could write | done in s006 | `adopt --project`, `attach`, the default brief |
| 24 | The preview was blank again on the operator's PR: the `node-sass` binding entry had been lost in a spec rewrite, and `seed_files` ran before `install` | spec fixed by hand; ordering open | `seed_files` after `install` |
| 25 | Login inside the preview frame loops: the app's cookies are `SameSite=Lax`; `*.localhost` labels are separate sites | M4 (s007) | `WebContentsView` previews; the web UI says "open in tab" on such a service |
| 26 | `verify` has no undo | open | `DELETE /sessions/:dir/verify`, the checkbox toggles |
| 21 | After a pop-out the board shows the next stage by the table (`fixing`, because a bot thread was open), and `needs_human` stays empty. The operator wants the cause in the line: "popped out of the queue (manual); 1 bot thread open" | board agent, M2 | `needs_human` carries the pop-out reason for one poll after a `queue: popped` transition |

### Record

Round 1: board agent $8.83 (claude-fable-5-1, 22 min), stack agent $24.60 (75 min); operator relays 3 (one decision, two steers); agent-to-operator calls 2. Round 2: stack agent $11.23 (30 min); operator relays 4 (steers). Round 3: $7.30; round 4: $12.36; round 5: $13.36; relays 0. A review agent in a second home audited the newcomer path and the shared state, found findings 16, E and F, and committed one change (`aeeb9ca`). The operator killed hung backends by hand three times, refreshed the local database from the team's snapshot, and found the auth, grants and install facts from the logs. Full mission record: [sessions/s002-MISSION.md](sessions/s002-MISSION.md).

### Next

1. Operator: `pnpm install` in the backend repo (finding 7); the seed project UUIDs for the slim template; the live pop-out test (Plan item 9); one day of `spinner board` against real work (Plan item 9).
2. Stack agent, round 3 of s002: findings 6 and 9, then two the operator's project sessions side by side. Exit: `web.s1.localhost` and `web.s2.localhost` both serve the app, logged in, with `api` 200 on each, and `tools/stack-proof.sh` passes with host processes included.
3. Then the soak week before M2 (ROADMAP).

## M2 · Agents that drive PRs home (done except the operator's real feature)

| Exit criterion or item | State | Evidence |
|---|---|---|
| `spinnerd` as a real daemon with the REST/WS API | done | API v1 (`ea0600c`); jobs with `job.*` events; the poller and the notifier in the daemon |
| `PiRpcHarness` | done | `170586b`; resume by id after a daemon restart |
| Spinner pi extension: mission in the prompt, 11 tools, out-of-area guard, reload | done | `ef3b632`; a real pi ran six tools in one turn serialized through the daemon; the guard blocked an edit outside the brief's globs until a Log line named it; `/spinner-reload` after a context edit |
| File watcher → steers; `inbox/` delivery | done | `638a131`; a mission change reached a busy agent as a mid-turn steer, at most one per 30 s |
| Session `AGENTS.md` generated | done | regenerated at `new` and `up` |
| `spinner pr` | done, live | `spinner-sandbox#1` opened as the operator, body from the mission |
| `spinner fix` and the thread tools | done, live | the fixer replied, fixed, pushed, resolved a human thread on GitHub |
| `spinner post` | done, live | posted to the test channel as the operator after the confirm; a reply appeared in the facts on the next poll |
| `spinner approve` | done, live | shows head, diff stat, open threads; GitHub refuses an author's own approval (recorded); asked again after any push |
| `spinner land` | done, live without a queue | zero checks count as green; `merge_queue: none` merged by direct merge. The enqueue mutation with `expectedHeadOid` is tested on the fixture only; personal repositories cannot have a merge queue |
| `spinner reset` | done, live | next round's branch from fresh base, facts cleared, round 1 archived |
| One real feature of the operator's project through the loop | open | Plan 9 of s005; the operator's call |

Record: engine $36.60 (claude-fable-5-1, 58 min), ext $15.23 (claude-fable-5-1, 32 min), ui $1.74 (claude-sonnet-5-5, 12 min). Operator relays 3, decisions 1, inbox messages 2. A throwaway public repository `spinner-sandbox` under the operator's account holds the live run; the Slack app is a user-token app named Spinner. Full record: [sessions/s005-MISSION.md](sessions/s005-MISSION.md).

## M4 · Desktop (built, in daily use)

| Exit criterion or item | State | Evidence |
|---|---|---|
| The same UI in a window, connected to the running daemon, starting one when none answers | done | s007 `0755ff5`; `pnpm desktop`, `pnpm desktop:build` |
| Previews as top-level pages; the operator's app keeps its login | done | the operator logged in inside the window on his real session; `SameSite=Lax` cookies hold because the view is a top-level page |
| Geometry: previews follow drags, resizes and tab switches | done | main-process log of every rectangle received and applied; the operator: "drag works great" |
| Pane layout: side panel with an activity bar and a toggle, agents never fold, previews collapse to the edge or expand to the window, a deliberate snap on drag, uniform session cards, a compose card for new and adopt, a context bar | done | s008, seven passes on the operator's screenshots |
| Browser bar on previews: back, forward, reload, URL, external, devtools, zoom, find, clear storage | done | `ad2d526`, `f60fad4`; 16 e2e checks on a scratch daemon |
| Pop-out: a preview into its own window that adopts the view; dock back | done | `66ce18f`..`8ffd028`; the CDP target survives pop out, dock back, close |
| Tray item with the daemon state | done, minimal | lists popped-out windows |
| A signed, notarized `.app` | open | M5; needs an Apple developer account |
| s011: an agent tab is pi's own terminal (`PiTtyHarness`, the tty WebSocket, the extension channel for `prompt`, `steer`, `abort`, `notify`; reattach after a daemon restart) | done | `542c646`..`d506e09`; `tty.test.ts` (7) through a real daemon and a fake pi; `e2e/tty.ts` PASS against the real pi; the terminal in the desktop window, 11 checks (`e2e/desktop-terminal.ts`) |
| s011, the passes of 2026-10-30: the Activity drawer, the toolbar, view tabs and agent chips, resource usage on cards and in the services view, settings and themes | done | `9fe3395`, `272ef59`..`46281e1`, `04e73e0`; driver flows `terminal`, `drawer`, `usage`, `settings` and ten others green on the fixture; screenshots in the session's `artifacts/` |
| s011 checks | done | `pnpm -r test` at `91307dd`: protocol 16, daemon 206, desktop 68, pi-extension 12, ui 60, cli 24; `pnpm lint` exit 0; `doc-metrics --fail` exit 0 |

Record: s007 desktop $14.21 (50 min), ui $4.55 (38 min); s008 desktop $20.67 (68 min), ui $25.54 (80 min, seven passes). Operator relays 5, decisions 2. One incident: a destructive e2e driver on the shared daemon archived the operator's merged s003; restored within minutes; lesson 27.

s011 record: engine and ui; the operator fills the cost. Mission record: [sessions/s011-MISSION.md](sessions/s011-MISSION.md).

### Next

1. The manager reads `settings.yaml` (`default_model`, `agents.harness`) at `add`.
2. `pnpm.onlyBuiltDependencies: ["node-pty"]` in the root `package.json`, so the prebuilt's `spawn-helper` has its exec bit after `pnpm install`.
3. The ui fixture's default port off 7777; the agents pane under a 1000 px window; the desktop chrome on the palette.
4. A UI snapshot per daemon start, so a ui rebuild does not change the operator's window under a daemon without the matching routes.

## M3 · Web UI (done, 2026-10-29)

| Exit criterion or item | State | Evidence |
|---|---|---|
| Sessions and board pane, new-session form, activity feed | done | `945d444`; sorted by `needs_human`, stage badge, per-PR lines, project select, adopt form |
| Agent tabs rendering the pi event stream, prompt / steer / abort, model picker | done | `45f3e86`, `241c8ed`; history on reload from `GET .../agents/:name/events` |
| Preview pane: iframe tabs per hostname, grey until healthy, open-in-tab, reload, the verified tick | done | the sample stack from new to close in headless Chrome, screenshots in the session's `artifacts/` |
| Mission panel, Context tab, `threads/` rendering, `create PR / fix / post / land` buttons | done | s005 (`fd271f5`, `88df4dd`): editable Goal and Done when through the daemon, threads with reply, resolve and flag, confirm dialogs for `post` and `approve`, the context tab with editable files; verified on the real daemon with screenshots |
| A feature goes from new session to merged PRs without a terminal; a new user follows the README on their own stack in under an hour | partial | s006: the README's Quick start, timed by the agent on 2026-10-29 in a fresh clone (`8f763c4`) with a fresh `SPINNER_HOME`: `pnpm install` to the sample stack up in the UI in 15.6 s, warm caches (`up` 3.1 s, build 3.4 s, `close` 2.9 s). Open: a new user on their own stack, and the terminal-free feature |

Record: engine $19.40 (claude-fable-5-1, 38 min), ui $2.56 (claude-sonnet-5-5, 30 min in two runs). Operator relays 2, inbox messages 2, blocking decisions 0. The operator deferred the two-session run of his own stack from the UI; the stack side is proven in s002. Full record: [sessions/s003-MISSION.md](sessions/s003-MISSION.md).

### Next

1. The operator's real PR, in the desktop app: `fix` when the bot posts, `verify`, `post`, `approve`, `land` (the merge-queue enqueue's live test).
2. Stacked PRs (decision pending; option B): ordered PRs per repo, worktree at the top, `adopt` walks the base chain, `land` bottom-up; `session.yaml` v2.
3. Soak fixes: the verify toggle, `seed_files` after `install`, finding 21, `up` under 15 s with host services, the flaky `plumbing.test.ts`, ids unique across homes.
4. M5: signing and packaging, `spinner init` from the recipes, the public repository.

## Budget

Estimates before the work were "days 1 to 3" for s001 and "weeks 2 to 3" for s002. The actual wall clock was 17 minutes and 75 minutes of agent time, plus the operator's time to relay, verify and write. The cost driver is not implementation. It is the acceptance test against the real project, which needs the operator's repos, logins and data.

| Session | Agents | Agent cost | Agent wall clock | Operator relays |
|---|---|---|---|---|
| s001 | engine, ui | $5.80 | 17 min | 2 |
| s002 round 1 | board, stack | $33.43 | 75 min | 3 |
| s002 round 2 | stack | $11.23 | 30 min | 4 |
| s002 round 3 | stack | $7.30 | 10 min | 0 |
| s002 round 4 | stack | $12.36 | 16 min | 0 |
| s002 round 5 | stack | $13.36 | 10 min | 0 |
| s003 | engine, ui | $21.96 | 70 min | 2 |
| s005 | engine, ext, ui | $53.57 | 102 min | 3 |
| s006 | engine, soak | $12.63 | 56 min | 1 |
| s007 | desktop, ui | $18.76 | 88 min | 3 |
| s008 | desktop, ui | $46.21 | 148 min | 3 |
| s011 | engine, ui | $55 | 4 h | 12 |
| s012 | engine, ui | $16.36 | 50 min | 1 |
| s013 | engine, ui | $30.35 | 75 min | 2 |
| s014 | engine, ui | $28.93 | 99 min | 4 |
| s015 | engine, ui | $20.12 | 22 min | 1 |
| design | design (Opus) | $6.70 | 29 min | 1 |
| docs | docs | $8.54 | 17 min | 0 |
| s016 | engine, ui, design | $56.89 | 191 min | 12 |
| s017 | engine, ui | $30.47 | 71 min | 2 |
| Total | | $490 | 20 h | 56 |

Agent minutes are the model's own run time from the run records; wall clock with builds, installs and waits was about three times that. The operator's own time on 2026-10-27 was about 7 hours: reading logs the agents could not interpret (cloud auth keys, grants, the team's install commands), refreshing the local database, killing hung processes, and testing in the browser. That is the cost driver, not the agents.

Space per session, measured on the sample stack: 3 containers, one database clone, one network. Not yet measured on the operator's project.

## Organization

- Architect and operator: Cullen Bates. Owns *Goal* and *Done when*, the protocol, the decisions.
- Agents: `spinner-agent` runs as a pi subagent per session role, from one parent pi session at the repo root. The parent is the message bus until M2.
- Precedence when documents disagree: `SESSION_PROTOCOL.md` > `STACK_SPEC.md` > `ARCHITECTURE.md` > `ROADMAP.md` > this file > session files.
