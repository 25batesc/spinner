# engine

Role: backend engineer for session s019 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- The daemon, pi extension, protocol and cli packages. The docs directory. `README.md`.

## Do not edit
- `packages/ui/**`, `packages/desktop/**`. Put a request for the ui agent in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `docs/designs/egm-adoption.md`. First the Overview, the Decisions, and Technical Plan sections 8, 9 and 13. Then "Build session 3" in full, entries 3.1 to 3.24, and the Verification Plan rows for session 3. The entries are the plan. Build them in order.
3. Read `packages/daemon/src/egm/` as sessions 1 and 2 left it, `store/brief-template.ts` (the lead brief), `agents/lead.ts`, and `packages/daemon/e2e/egm-harness.ts`.
4. Read the EGM copy at `~/.spinner/egm/src`: every `skills/*/SKILL.md` and `resources/execution_instructions.md`. Note the gates each skill asks, the `ask_question` shape, and the arguments each takes.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM engine: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn. Re-read the file before each edit.
3. Tick only your own Plan items. Name the entry ids in each Log line and each commit.
4. Commit Plan item 1 (the protocol entries and the schemas) first and ping the operator through the supervisor channel. The ui agent waits on that commit.
5. An entry that cannot be built as written goes under Open questions with its id and the reason. Build the smallest faithful variant and say which. Do not redesign.
6. Edit `MISSION.md` in place with the edit tool. Read the exact lines before every edit.
7. Stage by path; never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them. Stop every scratch daemon and process you started before you report.
9. E2e runs only against a scratch daemon with a scratch `SPINNER_HOME` and a free port, on the sandbox repository. The operator's daemon on `:7777` is off limits.

## Engineering
1. Start each commit message with `engine:` and the entry ids.
2. The design-track lead brief (3.13) is the point of this session. With it the lead runs brainstorm, draft, review and resolve, asks through `ask_question`, and does not build before approval. Session 1's P11 failed on exactly this.
3. The session-3 checkpoint and the P11 rerun (3.15) run on a scratch daemon with the real pi. Name the stop rule in the Log before each run. Name the scratch project by the absolute path of its `spinner.yaml`. Never use a name the operator's home resolves (session 2 finding).

## Finish
1. Make `pnpm -r build`, the daemon, extension, protocol and cli tests, root `pnpm lint` and `python3 tools/doc-metrics.py --fail` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line. Say what exists and what you would change in the design or the protocol. Append the session's findings to "Build findings / Session 3" in `docs/designs/egm-adoption.md`.
