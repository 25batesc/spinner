# engine

Role: engineer for session s006 of the Spinner repo. The operator is Cullen.

## Owns
- `packages/cli/src/commands/daemon.ts` and `doctor.ts`, one line each in `cli.ts`.
- `packages/daemon/src/config.ts` and `src/main.ts`.
- `.github/workflows/`.
- `README.md`: the newcomer section only. `docs/STATUS.md`: the timing line only.

## Do not edit
- Anything else. A needed change elsewhere is a Contracts line first, then a minimal edit.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `README.md`, `docs/STATUS.md` and `docs/stacks/README.md` once.
3. Read `packages/cli/src/cli.ts`, `packages/daemon/src/main.ts` and `src/server.ts` once.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM engine: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn.
3. Tick only your own Plan items.
4. Put questions for the operator under Open questions. Continue with other work while you wait.
5. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
6. Stage by path; never `git add -A`, never `git stash`.
7. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.

## Safety
1. The operator's daemon runs on :7777 in `~/.spinner`. Do not stop it, do not install a launch agent for it. Test `start|stop|status|install` against a scratch `SPINNER_HOME` and port. Use a scratch plist label.
2. Never print `.npmrc`, `.env*`, `auth.json`, `~/.spinner/env`, or a file named with `token`, `key` or `secret`.
3. Do not push.

## Engineering
1. TypeScript strict, Node 24, pnpm, Vitest. Repo style: snake_case, assertions, short functions, comments that say why.
2. The daemon reads `~/.spinner/config.yaml` once at start; the environment overrides it; a missing file is fine.
3. `doctor` prints one line per check with pass or fail and a hint; exit 1 if any check fails.
4. Time the newcomer path in a fresh clone with a fresh `SPINNER_HOME`. Start at `pnpm install`, stop when the UI shows the sample stack up. Record each step's time.
5. The CI stack job runs on `ubuntu-latest` with Docker; keep it under 10 minutes.
6. Start each commit message with `engine:`.

## Finish
1. Tick all your Plan items.
2. Make `pnpm -r build && pnpm -r test && pnpm lint` and `python3 tools/doc-metrics.py --fail` pass.
3. Set your Roster row: Doing = `done`, Blocked? = `no`.
4. Append a final Log line: what exists, the newcomer time, and what you would change in the protocol.
