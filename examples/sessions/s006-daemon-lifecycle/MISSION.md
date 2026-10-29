# s006 · Daemon lifecycle and the newcomer path

## Goal
Close M3. A new user clones the repo, follows the README, and reaches a running UI on their own stack in under an hour, without this chat. That needs the daemon to start and stop like a tool (`spinner daemon start|stop|status|logs`, launch at login on macOS), the binaries and tokens it uses to come from one settings file, the README to show the path, and CI to run what the laptop runs. One agent.

## Done when
- [ ] `spinner daemon start` starts the daemon in the background with its log under `~/.spinner/`, `status` says if it runs and on which build, `stop` stops it, `logs` tails; `start` twice is a no-op; a stale pid file is handled
- [ ] `spinner daemon install` writes a macOS launch agent (`~/Library/LaunchAgents/dev.spinner.daemon.plist`) that starts the daemon at login with the user's environment; `uninstall` removes it
- [ ] `~/.spinner/config.yaml` holds the non-secret settings the daemon needs (`pi_bin`, `port`, `default_model`, `slack.channel`); secrets still come from the environment, and the launch agent reads them from `~/.spinner/env` (mode 600, documented, never created by Spinner with a value)
- [ ] `spinner doctor` checks: `~/.spinner` outside git, Docker up, `gh` logged in, `pi` found, Node version, the proxy and Postgres state, the token present or absent; exit 1 with a list on failure
- [ ] README shows the newcomer path start to finish on `examples/sample-stack`, timed by the agent in a fresh clone under a fresh `SPINNER_HOME`; the time is written into STATUS
- [ ] CI runs `examples/sample-stack` through `new → up → close` in a job with Docker, and runs the daemon's stack and pipeline tests on Linux
- [ ] `pnpm -r build && pnpm -r test && pnpm lint` and `doc-metrics --fail` green; Log tells the story

## Plan
- [ ] 1. `packages/cli/src/commands/daemon.ts`: `start|stop|status|logs|install|uninstall`, pid file and log under `~/.spinner/`, build identity in `GET /health` (engine)
- [ ] 2. `~/.spinner/config.yaml` loader in the daemon (`packages/daemon/src/config.ts`), with environment overrides; `SPINNER_PI`, `SPINNER_PORT`, `SPINNER_DEFAULT_MODEL` keep working (engine)
- [ ] 3. `spinner doctor` (engine)
- [ ] 4. README newcomer path, timed in a fresh clone; STATUS gets the time (engine)
- [ ] 5. CI: a `stack` job with Docker on `examples/sample-stack`, the Linux test run (engine)
- [ ] 6. Lessons → protocol (Cullen)

## Roster
| Agent  | Owns | Doing | Blocked? | Updated |
|--------|------|-------|----------|---------|
| engine | `packages/cli/src/commands/daemon.ts`, `doctor.ts`, `packages/daemon/src/config.ts`, `src/main.ts`, `.github/workflows/`, `README.md` (the newcomer section only), `docs/STATUS.md` (the timing line only) | — | no | — |

## Contracts & decisions
- (date) Cullen: secrets never enter `config.yaml`. The launch agent sources `~/.spinner/env` if it exists; the README says what goes there.
- (date) Cullen: `spinner daemon start` runs the daemon from the repo's build (`packages/daemon/dist/main.js`) in M3; a packaged binary is M5.
- (date) Cullen: the operator's daemon on :7777 must keep running during this session; test against a scratch `SPINNER_HOME` and `SPINNER_PORT`.
- (date) Cullen: rules from s001 to s005 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path; no `git add -A`, no `git stash`; `mktemp -d` scratch, reported, never deleted; one retry on an environment failure; never print `.npmrc`, `.env*`, `auth.json`, `~/.spinner/env` or a file named with `token`, `key` or `secret`; no customer or person in a tracked file; a change under `src/stack/` or `src/pipeline/` runs its tests in a `node:24` container before the push.

## Open questions
- (none yet)

## Log
- (start) Cullen: session opened after s005; one pi subagent from the parent session, brief in agents/engine/BRIEF.md
