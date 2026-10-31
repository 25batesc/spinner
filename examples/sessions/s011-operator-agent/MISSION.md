# s011 · The operator agent: Spinner talks back

## Goal
Today the operator runs Spinner's own build from a terminal outside the app: a chat with a parent agent that writes missions, starts subagents, relays messages and reports. After this session that chat lives inside Spinner. An operator agent, one per home, always available, sits in its own tab. The operator pastes a PR or a ticket and says what he wants; the agent creates the session, attaches the project, writes the mission and the briefs, starts the agents, and tells him where to click. It is woken by the daemon's events, so it relays and asks the way the parent chat does. Two agents: `engine` (daemon, extension, protocol, cli) and `ui`.

## Done when
- [ ] The daemon hosts one operator agent per home under `~/.spinner/operator/` (its pi transcript, `BRIEF.md`, `inbox/`): a tty pi in the home directory, started with the daemon when `settings.operator.enabled` is true (the default), resumed on restart like a session agent, stopped with `POST /operator/stop`, started with `POST /operator/start`
- [ ] The extension's role `operator` adds the tools `session_new`, `session_adopt`, `session_attach`, `session_list`, `session_show`, `mission_write` (one section of a named session), `brief_write`, `agent_add`, `agent_steer`, `inbox_send`, and keeps `stack` and `pr`; every tool goes through the daemon's routes and is logged in the session's Log
- [ ] The operator agent is woken by events: `needs_human` set, `agent.settled`, `agent.exited`, `job.finished` with state `failed`, an inbox message addressed to `operator`; each arrives as one notice in its terminal with the session and the fact, batched per second so a burst is one notice
- [ ] The operator agent's brief (`packages/daemon/src/store/operator-brief.ts`, written once, editable) says: what Spinner is, how a session is shaped, how to turn a request into a mission and briefs (the shape in `examples/sessions/`), that it starts agents without asking, and that it never pushes, posts, approves, lands or closes without the operator's word; product calls become Open questions and `needs_human`
- [ ] The UI has an operator tab: an icon in the activity bar above the gear; it opens the operator's terminal full width in the middle (the agents pane's terminal component, pointed at `/operator/tty`), with `stop`/`resume` and a line that says what it is waiting on; a notice in the context bar when the operator agent is not running
- [ ] E2e on a scratch daemon with the real pi: the operator agent receives "start a session for the sample stack named Refund flow with one agent `backend` that adds a health endpoint", creates the session, attaches the sample project, writes a mission with a Goal and three Plan items, writes the brief, starts `backend`; the agent's `agent.settled` reaches the operator agent as a notice
- [ ] `pnpm -r build && pnpm -r test && pnpm lint` and `doc-metrics --fail` green; `docs/ARCHITECTURE.md` gains "The operator agent"; `docs/DAEMON_API.md` lists the routes; Log tells the story

## Plan
- [ ] 1. Contract under Contracts: the routes (`/operator`, `/operator/start|stop|tty|prompt|steer`), the tool names and arguments, the notice shape, `settings.operator` (engine)
- [ ] 2. The operator host in the daemon: `agents/operator.ts` over `PiTtyHarness`, the brief writer, start with the daemon, resume on restart (engine)
- [ ] 3. The extension role `operator` and its tools; each tool is a daemon call with the same validation the routes have (engine)
- [ ] 4. The event subscription and the batched notices through the extension channel (engine)
- [ ] 5. The operator tab: activity bar icon, the terminal, stop/resume, the waiting line, the context-bar notice (ui)
- [ ] 6. E2e with the real pi; the operator tries it on a real request (engine, then the operator)
- [ ] 7. Lessons → protocol; `v0.3.0` (the operator)

## Roster
| Agent  | Owns | Doing | Blocked? | Updated |
|--------|------|-------|----------|---------|
| engine | `packages/daemon/**`, `packages/pi-extension/**`, `packages/protocol/**`, `packages/cli/**`, `docs/ARCHITECTURE.md`, `docs/DAEMON_API.md` | — | no | — |
| ui     | `packages/ui/**` | — | no | — |

## Contracts & decisions
- (date) the operator: one operator agent per home; it has no session, no worktree and no stack; its cwd is the home directory; it reads and writes sessions only through the daemon.
- (date) the operator: the operator agent starts agents without asking. It never pushes, posts, approves, lands, resets or closes without the operator's word; the extension refuses those calls in the operator role.
- (date) the operator: notices come through the extension channel of s011 (`notify`), batched per second; a notice is text, with the session dir first.
- (date) the operator: the operator agent's model is `settings.operator.model`, else `settings.default_model`, else the daemon's default.
- (date) the operator: rules from s001 to s012 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path; no `git add -A`, no `git stash`; `mktemp -d` scratch, reported, never deleted; never print `.npmrc`, `.env*`, `auth.json`, `~/.spinner/env`, or a file named with `token`, `key` or `secret`; no customer or person in a tracked file; wait on an artifact, never on a Log timestamp; destructive e2e only on a scratch daemon with a scratch home; the operator's daemon on `:7777` is read-only for agents; a protocol change names the files the other agent's build touches; find the fault before you fix the proposed one.

## Open questions
- (none yet)

## Log
- (start) the operator: session opened after s012; two pi subagents from one parent, briefs in agents/*/BRIEF.md
