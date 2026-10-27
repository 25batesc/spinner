# board

Role: engineer for the pipeline tracker and the board, session s002 of the Spinner repo. The operator is Cullen.

## Owns
- `packages/daemon/src/pipeline/**`
- `packages/cli/src/commands/adopt.ts`, `board.ts`, `verify.ts`
- The pipeline types in `packages/protocol`: `PipelineFacts`, `Stage`, `NeedsHuman`, and the per-PR facts.

## Do not edit
- `packages/daemon/src/stack/**`, `packages/daemon/src/git/**`, `examples/**`. The stack agent owns them.
- Shared files in `packages/protocol` outside the pipeline types. Announce a change under Contracts before you make it.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read these sections of `docs/SESSION_PROTOCOL.md` once: `session.yaml`, "Threads", "Lifecycle and pipeline stages".
3. Read the "Pipeline tracker" section of `docs/ARCHITECTURE.md` once.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM board: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn.
3. Tick only your own Plan items.
4. Put questions for the operator under Open questions. Continue with other work while you wait.
5. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
6. Put a request for the other agent in `inbox/` as `<HHMMSS>-board-<to>.md`, first line the subject. Do not put it under Open questions.
7. Stage by path; never `git add -A`. Commit `pnpm-lock.yaml` with the `package.json` change that caused it. Run `pnpm install --frozen-lockfile` before each commit.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.

## Safety
1. Do not write to GitHub or Slack in this session. Read only. `gh pr create`, `gh pr review`, `gh pr merge`, `gh api -X POST|PATCH|PUT|DELETE` and GraphQL mutations are forbidden.
2. Scrub secrets from every fixture before you save it.

## Stage function
1. Write `derive_stage(facts)` as a pure function. Facts go in; `stage`, `needs_human`, and `stale` come out. Use the repo's snake_case.
2. Write one fixture test per row of the stage table in `docs/SESSION_PROTOCOL.md`.
3. Add a test for a merge-queue pop-out.
4. Add a test that a new push clears `verified_locally`.

## GitHub facts
1. Talk to GitHub only through `gh api graphql`, or `gh pr view --json` where that is simpler. The user's `gh` login is the only credential.
2. Save real responses as fixtures under `packages/daemon/test/fixtures/github/`.
3. Bucket each review thread by the login of its first comment, against `config.github.bot_logins`.
4. Treat top-level PR comments as information. They never block a stage.
5. Split the approval check named in `config.github.approval_check` out of the checks rollup. Store it as `approval_check`.
6. Derive `approvals.required` from the PR author with `config.github.approval_policy`. A human author needs `[peer]`. A bot author needs `[peer, owner]`.
7. Collect approvals on the current head: `approvals.peer` holds logins other than the owner; `approvals.owner` is true or false.
8. Set `needs_human` to `approve <repo>#<n>` only when `owner` is required, the peer has approved, and the owner has not.
9. Record `bot_reviewed_head`, the head SHA of the latest bot review.
10. Do not wait for a bot re-review at any stage. New bot threads re-enter *fixing*.
11. Read `mergeQueueEntry` while a PR is queued.
12. Read `RemovedFromMergeQueueEvent { reason }` from the timeline to detect a pop-out. Store the reason in the facts.

## Commands
1. Make `spinner adopt <pr-url>...` create a session directory with `session.yaml` and a minimal `MISSION.md`. It creates no worktrees.
2. Make `spinner board` print one line per session, sorted with non-null `needs_human` first.
3. Make `spinner board --watch` re-poll and redraw.
4. Make `spinner verify <session>` record the operator's tick and the head SHA per repo.
5. Poll GitHub every 60 seconds per open PR.
6. Send a macOS notification on a stage transition only. Use `osascript` or `terminal-notifier`. Never notify on a plain poll.
7. Start each commit message with `board:`.

## Finish
1. Make *Done when* items 1 to 3 true.
2. Tick all your Plan items.
3. Set your Roster row: Doing = `done`, Blocked? = `no`.
4. Append a final Log line: what exists, and what the protocol got wrong.
