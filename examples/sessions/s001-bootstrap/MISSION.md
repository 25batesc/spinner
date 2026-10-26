# s001 · Bootstrap: Spinner builds Spinner

## Goal
Stand up the Spinner monorepo skeleton and the shared `protocol` package, then a walking skeleton of the daemon/CLI (engine) and the web UI (ui) that agree on the same types and can be run against a fixture server. Two agents, one repo, coordinated only through this file and Cullen. No stack runner yet; that is M1.

## Done when
- [ ] `pnpm install && pnpm -r build && pnpm -r test` is green at the repo root
- [ ] `packages/protocol` exports types for `session.yaml`, the event bus, and the REST/WS API, with a JSON schema for `session.yaml`
- [ ] `packages/cli`: `spinner new <title>` creates a session directory per docs/SESSION_PROTOCOL.md (session.yaml + MISSION.md from template + agents/), `spinner show` lists sessions
- [ ] `packages/daemon`: starts, serves `GET /sessions` and a WebSocket that emits `session.created` when a session dir appears
- [ ] `packages/ui`: sessions pane + empty agent tab + empty preview pane, rendering from the daemon (or `pnpm fixture` when the daemon is not running)
- [ ] This file's Log shows how it went, and docs/SESSION_PROTOCOL.md has a "Lessons from s001" section

## Plan
- [ ] 1. Repo skeleton: pnpm workspace, tsconfig base, vitest, eslint, `packages/*` folders with package.json (engine)
- [ ] 2. `packages/protocol`: `Session`, `AgentSpec`, `StackState`, `SpinnerEvent` union, REST/WS route list; JSON schema generated from the types (engine)
- [ ] 3. Review step 2 and post any changes the UI needs under Contracts (ui)
- [ ] 4. `packages/cli`: `spinner new`, `spinner show`, session dir creation from the protocol doc (engine)
- [ ] 5. `packages/daemon`: Fastify (or Hono) server, chokidar watcher on `~/.spinner/sessions`, WS event stream (engine)
- [ ] 6. `packages/ui`: Vite + React, three-pane layout from the sketch, WS client, fixture server emitting the event types (ui)
- [ ] 7. Run cli → daemon → ui end to end; create a session from the UI (both)
- [ ] 8. Write "Lessons from s001" into docs/SESSION_PROTOCOL.md (Cullen)

## Roster
| Agent  | Owns                                                  | Doing              | Blocked? | Updated |
|--------|-------------------------------------------------------|------------------|-------|---------|
| engine | packages/protocol, packages/daemon, packages/cli, root configs | — | no  | —       |
| ui     | packages/ui                                           | —      | no  | —       |

## Contracts & decisions
- (date) Cullen: TypeScript, pnpm workspace, Node 24, Vitest. Daemon HTTP on `localhost:7777`, WS at `/events`. `packages/protocol` is the only thing both agents import; it is published to the workspace as `@spinner/protocol`.
- (date) Cullen: the ui agent does not wait for the daemon. It builds against `@spinner/protocol` types and a fixture server (`packages/ui/fixture/`) that replays canned events.

## Open questions
- Fastify or Hono for the daemon? (engine will pick Hono unless told otherwise)

## Log
- (start) Cullen: session opened; two pi terminals at the repo root, briefs in agents/*/BRIEF.md
