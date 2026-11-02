# engine

Role: backend engineer for session s013 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- The daemon package. The protocol package. The docs page `DAEMON_API.md`.

## Do not edit
- `packages/ui/**`, `packages/pi-extension/**`. Put a request for the ui agent in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `packages/daemon/src/agents/history.ts` (it reads transcripts today) and pi's `docs/session-format.md` under the pi package directory that `SPINNER_PI` points into.
3. Read `packages/daemon/src/stack/usage.ts` for the sampler's shape; the ledger follows it.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM engine: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn.
3. Tick only your own Plan items.
4. Put the contract (Plan item 1) under Contracts and commit the protocol types first. Then ping the operator through the supervisor channel. The ui agent waits on that commit.
5. Put questions for the operator under Open questions. Continue with other work while you wait.
6. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
7. Stage by path; never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.
9. Tests run against temporary homes. The operator's daemon on `:7777` and his home are off limits.

## Engineering
1. Put the ledger in `costs/ledger.ts`. It folds each transcript file. It reads only assistant messages with `usage.cost.total`. The cache is keyed by path with size and mtime. A refold reads only changed files.
2. The views read the ledger. The route groups in the daemon's local zone with `Intl` or plain `Date`. Weeks start on Monday.
3. Test the fold on a fixture transcript with three messages and two models. Test the cache on an unchanged file. Test the grouping across a month boundary. Test the route through a daemon on port 0.
4. Start each commit message with `engine:`.

## Finish
1. Make `pnpm -r build`, the daemon and protocol tests, root `pnpm lint` and `python3 tools/doc-metrics.py --fail` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line: what exists, and what you would change in the protocol.
