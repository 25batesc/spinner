# s002 · Pipeline board + stack runner

## Goal
Make Spinner useful at work before any agent plumbing exists. Two independent tracks: a **board** that knows the pipeline stage of every change in flight (fed by GitHub, including PRs that were opened outside Spinner), and a **stack runner** that brings up an isolated copy of any `spinner.yaml` stack per session on its own hostnames. Both live in `packages/daemon` and `packages/cli` but in separate directories; the only shared files are in `packages/protocol`. Requires s001's skeleton.

## Done when
- [ ] `spinner adopt <pr-url>...` creates a session from existing PRs; `spinner board` shows every session with the right stage and `needs_human`
- [ ] Stage derivation is a pure function with a fixture test per stage-table row (docs/SESSION_PROTOCOL.md)
- [ ] A merge-queue pop-out on a real PR produces a macOS notification within one poll interval
- [ ] `spinner new/up/down/close` runs `examples/sample-stack` and two sessions of the operator's own project side by side: `admin.s1.localhost` and `admin.s2.localhost` both logged in, Temporal UI per session
- [ ] `spinner up` < 15 s warm; `spinner close` leaves no containers, worktrees or databases behind
- [ ] `pnpm -r build && pnpm -r test` green; Log tells the story; protocol doc updated with lessons

## Plan
- [ ] 1. `packages/protocol`: `PipelineFacts`, `Stage`, `NeedsHuman` types in `src/pipeline.ts` and the pr fields of `src/session.ts` (board); the `StackSpec` (spinner.yaml) type in `src/stack-spec.ts` with its own `schema/stack-spec.json` (stack). Whoever changes types regenerates the schema and commits it at once.
- [ ] 2. GitHub collector: `gh api graphql` queries for PR state, checks rollup, review threads with author buckets, review decision, merge-queue entry + removed events; fixtures saved from a real PR (board)
- [ ] 3. `deriveStage(facts): { stage, needsHuman, stale }` with tests for every row of the stage table (board)
- [ ] 4. `spinner adopt`, `spinner board [--watch]`, `spinner verify`; 60 s poller; macOS notifications on transitions (board)
- [ ] 5. `spinner.yaml` loader and compose renderer: services, Traefik labels, env substitution, dependency volumes (stack)
- [ ] 6. Worktree manager: branch per repo, `.spinner` symlink, `git/info/exclude` entry (stack)
- [ ] 7. Postgres template clone + `spinner seed rebuild`; Temporal service; healthcheck wait; `up/down/close` (stack)
- [ ] 8. `local/knit/spinner.yaml` is filled (Cullen, done before the session). Run two Knit sessions side by side (stack, with Cullen for logins and seed data)
- [ ] 9. Adopt Cullen's current in-flight PRs and compare the board against reality for a day (Cullen)
- [ ] 10. Lessons → docs/SESSION_PROTOCOL.md and docs/ARCHITECTURE.md (Cullen)

## Roster
| Agent | Owns                                                                 | Doing         | Blocked? | Updated |
|-------|----------------------------------------------------------------------|-------------|-------|---------|
| board | packages/daemon/src/pipeline, packages/cli/src/commands/{adopt,board,verify}, protocol pipeline types | — | no  | —       |
| stack | packages/daemon/src/stack, packages/daemon/src/git, packages/cli/src/commands/{new,up,down,show,logs,exec,close,seed}, examples/sample-stack | — | no  | —       |

## Contracts & decisions
- (date) Cullen: GitHub access is the local `gh` login (`gh auth status` must pass); no GitHub App in M1. Bot logins: `devin-ai-integration[bot]`, `sonarqubecloud[bot]`. GraphQL `author.login` drops the `[bot]` suffix (`devin-ai-integration`); REST keeps it. Match on both forms.
- (date) Cullen: the base branch is per repo (`repos.<name>.base`, see STACK_SPEC and the protocol's Decisions). The operator's project has a merge queue that is not branch-protected; a PR can be enqueued once its checks pass, and the checks are the same inside and outside the queue. One check is an approval action whose rule depends on the PR author: human-authored → one peer approval; bot-authored → the peer plus the person who instructed the bot. Track it as `approval_check`, derive `approvals.required` from the author with `approval_policy`, and track `approvals.peer` / `approvals.owner` per PR. The real names live in `local/<project>/spinner.yaml`. The owner login is the `gh` login, read at runtime (`gh api user --jq .login`), never hardcoded.
- (date) Cullen: the review bot re-reviews after substantial pushes or after some time. No stage waits for it; new bot threads at any stage re-enter *fixing*. Record `bot_reviewed_head`.
- (date) Cullen: the board never posts anywhere; notifications are local only. Slack comes in M2.
- (date) Cullen: template-clone is the only DB mode in M1. The server is `spinner-postgres` (a container Spinner starts) for `examples/sample-stack`, or `external` (a server Spinner does not manage; for Knit, the Postgres inside `supabase start` on :54322) per the Decisions entry of 2026-10-26. Spinner creates and drops databases there and nothing else.
- (date) Cullen: a service may set `runtime: python`, `wrapper:` and `workdir:` (STACK_SPEC). Frontends that read env at build time through `dotenv-webpack` get an `env_file: <path in the worktree>`; the runner writes the service's `env` block to that file before start. stack: add `env_file` to `StackSpec` and announce it under Contracts.
- (date) Cullen: rules from s001 (protocol, *Lessons from s001*): Log times from `date +%H:%M`; stage by path, never `git add -A`; commit `pnpm-lock.yaml` with the `package.json` that changed it; a request for the other agent is an `inbox/` message, not an Open question; scratch directories from `mktemp -d`, reported, never deleted.
- (date) Cullen: a fixture already exists: `packages/daemon/test/fixtures/github/pr-approving.json` (bot-authored PR, bot threads resolved, every check green except the approval check) and the query that produced it, `pr-facts.graphql`.

## Open questions
- board: which login is "you" for `approvals.owner` in each repo, and are all repos under one GitHub org? → Cullen: the `gh` login at runtime; yes, one org (`pipeline.github.org` in the spec).
- board: for `spinner adopt`, should the login of a bot that opens PRs count as a bot for thread bucketing? → Cullen: yes. Author bucketing and thread bucketing both use `bot_logins`; a bot-authored PR also gets the `[peer, owner]` approval rule.
- stack: do the frontends read the API URL at runtime or at build time? → Cullen: build time. `dotenv-webpack` reads `envs/.env.local` (defaults from `.env.dev`) when the dev server starts; system env is ignored. Hence `env_file` above.

## Log
- (start) Cullen: session opened after s001; two pi subagents from one parent session, briefs in agents/*/BRIEF.md
