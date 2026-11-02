# engine

Role: backend engineer for session s016 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- The daemon package. The pi extension package. The protocol package. The cli package. The docs directory.

## Do not edit
- `packages/ui/**`, `packages/desktop/**`. Put a request for the ui agent in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `agents/swarm.ts`, `store/review-brief.ts`, `agents/lead.ts`, `pipeline/reviews.ts`, `pipeline/review.ts`, `pipeline/github-write.ts` and the extension channel's `notify`.
3. Read the operator's `pr-review` skill at `~/.pi/agent/skills/pr-review/SKILL.md`, the `reviewer` role at `~/.pi/agent/agents/reviewer.md`, and `~/.pi/agent/skills/interrogate/references/lead-judgment.md`. The skill is the lead's brief; the role is the reviewer's brief. Keep their rules word for word.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM engine: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn. Re-read the file before each edit.
3. Tick only your own Plan items.
4. Put the contract (Plan item 1) under Contracts and commit the protocol types first. Then ping the operator through the supervisor channel. The ui agent waits on that commit.
5. Put questions for the operator under Open questions. Continue with other work while you wait.
6. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
7. Stage by path; never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them. Stop every scratch daemon and process you started before you report.
9. E2e runs only against a scratch daemon with a scratch `SPINNER_HOME` and a free port, on the sandbox repository. The operator's daemon on `:7777` is off limits.

## Engineering
1. The lead of a review session is the s014 lead with a different brief and two more tools. The brief replaces the skill's `subagent` calls with one sentence. The daemon runs the reviewers. It notifies the lead when all verdicts are in `artifacts/reviews/`.
2. The reviewer's brief is the `reviewer` role plus the skill's rulebook, the PR URL and the detached checkout. It ends with the `VERDICT` contract. The daemon reads the last assistant text on settle and saves it as the verdict file. A reviewer with no verdict block is `failed`.
3. `review_draft` validates before it writes. Each comment body starts with `BLOCKING:`, `BUG:`, `NIT:` or `SUPER NIT:`. Each `path:line` is on the right side of the PR diff. Run `gh pr diff` once and keep the changed lines per file. A bad draft returns the errors to the lead and writes nothing.
4. The post goes through `gh api repos/:owner/:repo/pulls/:n/reviews` with `commit_id` at the head SHA, `event`, `body` and `comments[]` with `side: RIGHT`. The daemon never posts on its own; only the route does.
5. Test through the daemon with the fake interactive pi. Add one e2e with the real pi under `packages/daemon/e2e/review-lead.ts`, with one reviewer model.
6. Start each commit message with `engine:`.

## Finish
1. Make `pnpm -r build`, the daemon, extension, protocol and cli tests, root `pnpm lint` and `python3 tools/doc-metrics.py --fail` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line: what exists, and what you would change in the protocol.
