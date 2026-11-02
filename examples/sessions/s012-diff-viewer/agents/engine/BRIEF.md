# engine

Role: backend engineer for session s012 of the Spinner repo. The operator is the human who reads `MISSION.md`.

## Owns
- The daemon package. The pi extension package. The protocol package. The cli package. The docs pages `ARCHITECTURE.md`, `DAEMON_API.md` and `STACK_SPEC.md`.

## Do not edit
- `packages/ui/**`, `packages/desktop/**`. Put a request for the ui agent in `inbox/`.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read the viewer's README and its `bin/diffview.mjs` at the pinned commit. Use `gh api repos/adamsanghera/diff-viewer/contents/<path>`. Learn the flags, the comments CLI, and the HTTP routes the page uses.
3. Read `packages/daemon/src/stack/host-service.ts` (host processes with pid identity), `agents/extension-channel.ts` (`notify`), `pipeline/threads.ts` (`needs_human` from threads), `packages/pi-extension/src/tools.ts`.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM engine: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn.
3. Tick only your own Plan items.
4. Put the contract (Plan item 1) under Contracts and commit the protocol types first. Then ping the operator through the supervisor channel. The ui agent waits on that commit.
5. Put questions for the operator under Open questions. Continue with other work while you wait.
6. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
7. Stage by path; never `git add -A`, never `git stash`.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.
9. E2e runs only against a scratch daemon with a scratch `SPINNER_HOME` and a free port. The operator's daemon on `:7777` is off limits.

## Engineering
1. The dependency: `"diffview": "github:adamsanghera/diff-viewer#<commit>"` in the daemon's `package.json`, under `optionalDependencies`. Resolve its `bin` at runtime; absent means the feature is off.
2. One process per repo: `diffview <worktree> --no-open --port <n>`. The port comes from the session's host-port range. Record the pid and start time under `session.yaml` `diff.repos.<name>`. Reattach on restart by `pid-identity.ts`. Stop with the session's `down` and `close`.
3. The watcher runs one `diffview comments wait --after <last>` per running viewer. Restart it when it returns. Each new thread waiting on the agent is one `notify`. A thread waiting on the operator sets `needs_human` with the file and line. Bound the notices per second as the operator host does.
4. The tools run the CLI in the agent's worktree with a 30 s timeout and return its stdout.
5. Test the process table and the reattach with a fake `diffview` script. Test the watcher with a fake that prints threads. Test the tools against the fake. Add one e2e with the real viewer under `packages/daemon/e2e/diff.ts`.
6. Start each commit message with `engine:`.

## Finish
1. Make `pnpm -r build`, the daemon, extension and cli tests, root `pnpm lint` and `python3 tools/doc-metrics.py --fail` pass.
2. Set your Roster row: Doing = `done`, Blocked? = `no`.
3. Append a final Log line: what exists, and what you would change in the protocol.
