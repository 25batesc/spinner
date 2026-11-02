# engine

Role: backend engineer for session s015 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- The daemon package. The pi extension package. The protocol package. The cli package. The docs directory.

## Do not edit
- `packages/ui/**`, `packages/desktop/**`. Put a request for the ui agent in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `pipeline/adopt.ts`, `pipeline/poller.ts`, `pipeline/threads.ts`, `agents/manager.ts`, `agents/lead.ts`, the s016 `review` route, and `store/brief-template.ts`.
3. Read the operator's review skill at `~/.pi/agent/skills/review-pr/`: `SKILL.md`, `references/checklist.md`, and `scripts/review-blast.sh`. The prompt in `run_agent` is the reviewer's brief. Keep its rules word for word.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM engine: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn. Re-read the file before each edit.
3. Tick only your own Plan items.
4. Put the contract (Plan item 1) under Contracts and commit the protocol types first. Then ping the operator through the supervisor channel. The ui agent waits on that commit.
5. Put questions for the operator under Open questions. Continue with other work while you wait.
6. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
7. Stage by path; never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.
9. E2e runs only against a scratch daemon with a scratch `SPINNER_HOME` and a free port, on the sandbox repository. The operator's daemon on `:7777` is off limits.

## Engineering
1. The review session reuses `create_session` with `kind: review` and no project. The repository clone lives under `<home>/reviews/`, once per repository, fetched per review. The worktree is detached at the PR head, so nothing can be pushed from it.
2. The reviewer brief is a `BRIEF.md` per agent, written from the skill's prompt with the PR URL, the model name and the rules. Pass the skill directory with `--skill` when `settings.review.skill` names one. The default is the operator's `~/.pi/agent/skills/review-pr` when it exists.
3. `POSTED` detection reads the agent's transcript on `agent.settled`: the last assistant text with `POSTED model=` sets `posted`; an exit without it sets `failed`.
4. The cap. Never start a reviewer when `hosted.size` is at the cap. Keep a queue per session. Start the next on `agent.exited`.
5. Test through the daemon with the fake interactive pi. Add one e2e with the real pi under `packages/daemon/e2e/reviews.ts`, with one model.
6. Start each commit message with `engine:`.

## Finish
1. Make `pnpm -r build`, the daemon, extension, protocol and cli tests, root `pnpm lint` and `python3 tools/doc-metrics.py --fail` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line: what exists, and what you would change in the protocol.
