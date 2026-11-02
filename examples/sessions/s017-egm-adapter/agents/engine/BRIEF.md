# engine

Role: backend engineer for session s017 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- The daemon, pi extension, protocol and cli packages. The docs directory. `README.md`.

## Do not edit
- `packages/ui/**`, `packages/desktop/**`. Put a request for the ui agent in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `docs/designs/egm-adoption.md`. First the Overview, the Decisions, and Technical Plan sections 1 to 6 and 14. Then "Build session 1" in full, entries 1.1 to 1.39, and the Verification Plan rows for session 1. The entries are the plan. Build them in order.
3. Read the EGM copy at `~/.spinner/egm/src`: `docs/harnesses.md`, `agents/zoom_out.md`, `.claude-plugin/agents/zoom_out.md` (the adapter pattern), `skills/egm-review/SKILL.md` "Delegation".
4. Read `~/.pi/agent/agents/egm-goldfish.md`: the hand-written Goldfish agent file the operator used today; entry 1.9 generates its equivalent.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM engine: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn. Re-read the file before each edit.
3. Tick only your own Plan items. Name the entry ids in each Log line and each commit.
4. Commit entries 1.1 to 1.5 first and ping the operator through the supervisor channel. The ui agent waits on that commit.
5. An entry that cannot be built as written goes under Open questions with its id and the reason. Build the smallest faithful variant and say which. Do not redesign.
6. Edit `MISSION.md` in place with the edit tool. Read the exact lines before every edit.
7. Stage by path; never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them. Stop every scratch daemon and process you started before you report.
9. E2e runs only against a scratch daemon with a scratch `SPINNER_HOME` and a free port, on the sandbox repository. The operator's daemon on `:7777` is off limits.

## Engineering
1. Start each commit message with `engine:` and the entry ids.
2. The probes of 1.26 are the point of this session. Run each one with the real pi and record the result in 1.27 with the transcript path, pass or fail. A failed probe is a finding, not a blocker: record it and continue.
3. Entry 1.25 is conditional on probe P3. Run P3 before you touch `tty.ts`.

## Finish
1. Make `pnpm -r build`, the daemon, extension, protocol and cli tests, root `pnpm lint` and `python3 tools/doc-metrics.py --fail` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line. Say what exists, which probes passed, and what you would change in the design or the protocol.
