# ext

Role: agent-plumbing engineer for session s005 of the Spinner repo. The operator is Cullen.

## Owns
- `packages/pi-extension/**` (new package; a pi extension loaded into every agent the daemon starts).
- `packages/daemon/src/agents/**`, `src/watch/**`, `src/store/mission-*.ts`.
- `examples/sessions/*/agents/fixer/BRIEF.md` (the fixer role's brief template).

## Do not edit
- `packages/protocol`, `src/pipeline/**`, `src/actions.ts`. The engine agent owns them; request a type under Contracts and in `inbox/`.
- `packages/ui/**`. The ui agent owns it.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `docs/SESSION_PROTOCOL.md` once: `MISSION.md` editing rules, Messages, Change propagation, Threads and the fixer rules, "What the pi extension provides".
3. Read pi's extension docs once: `docs/extensions.md` under the installed `@earendil-works/pi-coding-agent` package, and the examples under `examples/extensions/`. The daemon's `src/agents/pi-rpc.ts` shows how pi is spawned.
4. Read `packages/daemon/src/agents/*.ts` once. Build on them.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM ext: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn.
3. Put each tool name, argument shape and route you will call under Contracts before you build it.
4. Tick only your own Plan items.
5. Put questions for the operator under Open questions. Continue with other work while you wait.
6. Put a request for another agent in `inbox/` as `<HHMMSS>-ext-<to>.md`, first line the subject.
7. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
8. Stage by path; never `git add -A`. Commit `pnpm-lock.yaml` with the `package.json` change that caused it.
9. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.

## Extension
1. Load the extension with `--extension <path>` (or pi's equivalent) when the daemon spawns an agent. Pass the session directory and the agent name through the environment.
2. Add a system-prompt section: session id, hostnames, the agent's brief, the full `MISSION.md`, one digest line per other agent.
3. Register the tools: `mission_roster`, `mission_log`, `mission_contract`, `mission_question`, `message`, `stack`, `pr`, `thread_list`, `thread_reply`, `thread_resolve`, `thread_flag`. Each calls a daemon route. The extension holds no state.
4. Add a `beforeTool` guard. An `edit` or `write` outside the agent's owned globs gets a warning that asks it to log first.
5. Add a `/spinner-reload` command that calls `ctx.reload()`. The daemon sends it as a steer after a context edit.
6. Make `thread_resolve` refuse a thread without a reply, and refuse human threads when `threads.resolve_human` is off.
7. Test the extension with pi's own test helpers or a fake `ctx`. Test the tools against the daemon's routes with a scratch home.

## Delivery
1. Watch `inbox/`. A new file for a running agent becomes a steer. For an idle agent, it is prepended to the next prompt. For `operator`, it goes to the Log and the UI.
2. Watch `MISSION.md` and `agents/*/NOTES.md`. On a change by agent A, send the other running agents one debounced steer with the sections that changed. Send at most one per 30 s per agent.
3. `spinner fix`: add the fixer agent from the fixer brief, or steer it when it runs. Honour `threads.autofix` in the spec.
4. Keep `NOTES.md` per agent: the long form of its Roster row, rewritten when the row changes.

## Safety
1. Never start an agent on the operator's project repos in this session. Use `examples/sample-stack` and the throwaway repo the operator names.
2. Never print `.npmrc`, `.env*`, `auth.json`, or a file named with `token`, `key` or `secret`.
3. Start each commit message with `ext:`.

## Finish
1. Tick all your Plan items.
2. Make `pnpm -r build && pnpm -r test && pnpm lint` pass.
3. Set your Roster row: Doing = `done`, Blocked? = `no`.
4. Append a final Log line: what exists, and what you would change in the protocol.
