# stack

Role: engineer for the stack runner, session s002 of the Spinner repo. The operator is Cullen.

## Owns
- `packages/daemon/src/stack/**`
- `packages/daemon/src/git/**`
- `packages/cli/src/commands/new.ts`, `up.ts`, `down.ts`, `show.ts`, `logs.ts`, `exec.ts`, `close.ts`, `seed.ts`
- `examples/sample-stack/**` and `local/**`
- The `StackSpec` types in `packages/protocol` (the `spinner.yaml` schema).

## Do not edit
- `packages/daemon/src/pipeline/**`, the `adopt`, `board`, and `verify` commands, and the pipeline types. The board agent owns them.
- Other shared files in `packages/protocol`. Announce a change under Contracts before you make it.

## Read first
1. Read `.spinner/MISSION.md` in full. Do this at the start of every turn.
2. Read all of `docs/STACK_SPEC.md` once.
3. Read the "Stack runner" section of `docs/ARCHITECTURE.md` once.
4. Read the "Directory layout" and "Commit and branch conventions" sections of `docs/SESSION_PROTOCOL.md` once.

## Protocol
1. Update your Roster row when your task changes or when you become blocked or unblocked.
2. Append one Log line for each change: `HH:MM stack: <what happened>`. Take `HH:MM` from `date +%H:%M` in the same turn.
3. Tick only your own Plan items.
4. Put questions about the operator's real repos under Open questions: ports, dev commands, seed path. Continue with other work while you wait.
5. Edit `MISSION.md` in place with the edit tool. Do not rewrite the file.
6. Put a request for the other agent in `inbox/` as `<HHMMSS>-stack-<to>.md`, first line the subject. Do not put it under Open questions.
7. Stage by path; never `git add -A`. Commit `pnpm-lock.yaml` with the `package.json` change that caused it. Run `pnpm install --frozen-lockfile` before each commit.
8. Create scratch directories with `mktemp -d` and report the path in the Log. Do not delete them.

## Compose
1. Render `spinner.yaml` plus the session into `stack/compose.yaml` and `stack/.env`.
2. Snapshot-test the rendered compose file for `examples/sample-stack`.
3. Give every service with a `host` a Traefik `Host()` label. Do not map host ports.
4. Run one Traefik container, `spinner-proxy`, with the Docker provider, shared by all sessions.
5. Add the response-header middleware for the services listed under `strip_frame_headers`.

## Database
1. Use one shared Postgres server for all sessions. By default it is the `spinner-postgres` container that Spinner starts. With `database.server: external` it is a server Spinner does not manage; host, port and user come from the spec. Spinner creates and drops databases there and nothing else.
2. Make `spinner seed rebuild` create the template database.
3. Make `spinner up` run `CREATE DATABASE spinner_<id> TEMPLATE <template>`.
4. Before step 3, make sure that no client is connected to the template database. Postgres refuses the clone if one is.
5. Make `spinner close` drop the session database.

## Temporal
1. Run one Temporal dev server per session.
2. Give its UI a hostname.

## Worktrees
1. Make `spinner new` run `git worktree add` per repo, on `feat/<slug>` from `base`.
2. Add a `.spinner` symlink in each worktree. List it in `.git/info/exclude`.
3. Make `spinner close` remove the worktrees and keep the branches.

## Operator rules
1. The operator's shell guard blocks some bash commands: recursive or forced `rm`, `docker compose down -v`, `supabase db reset`, and `psql` with DDL or writes. A child session cannot answer its prompt. Run those actions through your own CLI code and its tests, never by hand in bash.
2. Test against `examples/sample-stack` first. Touch the operator's repos only through `spinner new` worktrees, never their primary checkouts.
3. Build the sample stack's images small. The 15-second target is for warm images.
4. Never print these files, in whole or in part: `.npmrc`, `.env`, `.env.*`, `auth.json`, and any file with `token`, `key` or `secret` in its name. Read their variable names only (`cut -d= -f1`, or a grep for `^[A-Z_]+=` with the values dropped). A value that reaches the transcript is a leaked secret, whatever the redaction pattern was meant to do.

## Host services
1. A service with `runtime: host` runs on the host, in the worktree's `workdir`, with `wrapper` in front of `command`.
2. Detach the process. Put its stdout and stderr on `<session>/log/<service>.log`. Record the pid and the port in `session.yaml`.
3. Make `up` return when the healthcheck passes or the bounded wait ends. Test this with a fake service that never exits.
4. Put Spinner's `env` inside the wrapper, after it: `wrapper -- env K=V command`. The session's values must win over an injector's values.
5. Route `<host>.<id>.localhost` through Traefik to `host.docker.internal:<port>`.

## Cleanup
1. Run cleanup only through your own `spinner close` and `spinner down`.
2. Put the proof commands in `tools/stack-proof.sh` and run that script. The shell guard blocks `git branch -D` and recursive deletes in a bash call.
3. When an acceptance test fails on something outside this repo, record the finding under Open questions and stop. Do not retry more than once.

## Quality
1. Measure and print the `up` time. The target is under 15 seconds when images are warm.
2. Key dependency volumes by lockfile hash.
3. Make every command idempotent. `up` twice must succeed.
4. Make every command reversible. `close` after a failed `up` must succeed.
5. Start each commit message with `stack:`.

## Finish
1. Make *Done when* items 4 and 5 true on `examples/sample-stack`, then on the operator's project. `local/<project>/spinner.yaml` is filled.
2. Tick all your Plan items.
3. Set your Roster row: Doing = `done`, Blocked? = `no`.
4. Append a final Log line: what exists, and what `STACK_SPEC.md` got wrong.
