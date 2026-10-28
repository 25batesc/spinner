# engine

Role: pipeline engineer for session s005 of the Spinner repo. The operator is Cullen.

## Owns
- `packages/protocol` (all files).
- `packages/daemon/src/pipeline/**` and `packages/daemon/src/actions.ts`.
- `packages/cli/src/commands/{pr,fix,post,approve,land,reset}.ts`, one line each in `cli.ts`.
- Root configs.

## Do not edit
- `packages/pi-extension/**`, `packages/daemon/src/agents/**`, `src/watch/**`. The ext agent owns them. Call their exported functions.
- `packages/ui/**`. The ui agent owns it.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `docs/ARCHITECTURE.md` once: the pipeline tracker, PR authorship, the command list.
3. Read `docs/SESSION_PROTOCOL.md` once: `session.yaml`, Threads, Lifecycle and pipeline stages, the command list, Lessons.
4. Read `packages/daemon/src/pipeline/*.ts`, `src/actions.ts` and `src/jobs/jobs.ts` once. Build on them.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM engine: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn.
3. Put each type, route or event the other agents will use under Contracts before you build it.
4. Tick only your own Plan items.
5. Put questions for the operator under Open questions. Continue with other work while you wait.
6. Put a request for another agent in `inbox/` as `<HHMMSS>-engine-<to>.md`, first line the subject.
7. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
8. Stage by path; never `git add -A`. Commit `pnpm-lock.yaml` with the `package.json` change that caused it.
9. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.

## Safety
1. Open PRs, post, approve, enqueue and merge only on the throwaway repo the operator names. Never on another repo.
2. Every GitHub write goes through one function with the repo allow-list checked first. A test covers the refusal.
3. Post to Slack only with `SLACK_USER_TOKEN` set and only after the confirm step. Without the token, use the fixture.
4. Never print `.npmrc`, `.env*`, `auth.json`, or a file named with `token`, `key` or `secret`.

## Engineering
1. TypeScript strict, Node 24, pnpm, Vitest. Repo style: snake_case, assertions on preconditions, short functions, comments that say why.
2. Every command is an `actions` function the CLI and the route both call, run as a job with log lines.
3. `pr`: push each repo with commits ahead of its base. Run `gh pr create` with a body from Goal, Done when and the Log. Write the PR into `session.yaml`.
4. `threads`: render `threads/<repo>-<pr>.md` from the collector's facts. Reply, resolve and flag through `gh api`. Refuse to resolve a thread without a reply.
5. `post`: compose from the PR set and the Goal, show it, post on confirm. Store `slack_post`. Poll replies and reactions into the facts.
6. `approve`: show head, diff stat and open-thread count, then submit `gh pr review --approve`. Clear it from `needs_human` until the next push.
7. `land`: enqueue with `expectedHeadOid` and watch. On a pop-out, run a rebase job on the worktree and re-enqueue. Stop on a conflict with `needs_human`. Notify on merge.
8. `reset`: new branch from fresh base, worktrees fast-forwarded, stack recreated, facts cleared, mission history under `## Previous rounds`.
9. Start each commit message with `engine:`.

## Finish
1. Tick all your Plan items.
2. Make `pnpm -r build && pnpm -r test && pnpm lint` pass.
3. Set your Roster row: Doing = `done`, Blocked? = `no`.
4. Append a final Log line: what exists, and what you would change in the protocol.
