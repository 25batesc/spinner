# engine

Role: backend engineer for session s014 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- The daemon package. The pi extension package. The protocol package. The cli package. The docs directory.

## Do not edit
- `packages/ui/**`, `packages/desktop/**`. Put a request for the ui agent in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read `pipeline/adopt.ts`, `store/brief-template.ts`, `store/mission-template.ts`, `pipeline/mission-sections.ts`, `store/mission-writer.ts`, `agents/operator.ts` (the tools and the notices you reuse) and `packages/pi-extension/src/tools-operator.ts`.
3. Read one session template under `examples/sessions/` in full: the mission the lead writes has that shape.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM engine: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn.
3. Tick only your own Plan items.
4. Put the contract (Plan item 1) under Contracts and commit the protocol types first. Then ping the operator through the supervisor channel. The ui and design agents wait on that commit.
5. Put questions for the operator under Open questions. Continue with other work while you wait.
6. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
7. Stage by path; never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.
9. E2e runs only against a scratch daemon with a scratch `SPINNER_HOME` and a free port. The operator's daemon on `:7777` is off limits.

## Engineering
1. Extraction is a pure function with tests first (`pipeline/extract.ts`). The GitHub lookups come after, through the existing client, batched, with a 10 s bound.
2. `POST /sessions` keeps its old body working for the templates and the CLI (`title` without `text`). The new body is one job. It creates, attaches, adopts, starts the lead, and sends the first message.
3. The lead's tools reuse the operator host's tool code where the shape is the same. A refused action returns a message that says the operator must do it.
4. The mission format. An item without an id gets one when the parser writes the section. Times are `HH:MM` local. The owner is the agent name in parentheses. Old missions parse unchanged.
5. The structured view is derived on read; nothing new is stored. `mission.changed` carries it.
6. Tests through the daemon with the fake interactive pi; one e2e with the real pi under `packages/daemon/e2e/chat-first.ts`.
7. Start each commit message with `engine:`.

## Finish
1. Make `pnpm -r build`, the daemon, extension, protocol and cli tests, root `pnpm lint` and `python3 tools/doc-metrics.py --fail` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line: what exists, and what you would change in the protocol.
