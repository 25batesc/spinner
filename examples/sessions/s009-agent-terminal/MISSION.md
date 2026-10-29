# s009 · Agent terminals: the pi TUI in each agent tab

## Goal
Today each agent is a `pi --mode rpc` child and the agents pane renders its events as a thin chat (`AgentChat.tsx`, 300-character cells, no tool output, no slash commands, no pi widgets). The operator wants to talk to each agent the way he talks to pi in a terminal. After this session an agent tab is pi's own terminal UI: the daemon runs `pi` interactively in a pseudo-terminal in the agent's worktree, the web UI and the desktop app render it with xterm.js, keystrokes go up and output comes down over one WebSocket, and the Spinner pi extension inside that pi is the daemon's channel for `prompt`, `steer` and state. The RPC harness stays as the headless path (tests, `agents.harness: rpc`). Two agents: `engine` (daemon, extension, protocol) and `ui` (the terminal tab).

## Done when
- [ ] `agents.harness: tty` (the default) spawns `pi` in a pty (`node-pty`) with the same arguments as the RPC harness (worktree cwd, `--session-dir`, `--session-id`, `--extension`, `--skill`, the model); `rpc` keeps today's path; `spinner agent add` and `POST /sessions/:dir/agents` take the harness from `config.yaml`
- [ ] `GET /sessions/:dir/agents/:name/tty` upgrades to a WebSocket: binary frames are the pty's bytes both ways, one text frame `{"resize":{"cols":n,"rows":n}}` resizes; a second client attaches to the same pty (the desktop window and a browser tab show one terminal); a scrollback of 64 KiB replays on attach
- [ ] `prompt` and `steer` on a tty agent go through the extension (`pi.sendUserMessage` for a prompt, the steer queue for a steer), carried by a long-poll the extension opens on `GET /sessions/:dir/agents/:name/commands`; the pipeline's `fix` and the mission's section-write steers work unchanged on a tty agent
- [ ] State on the bus for a tty agent comes from the extension's `agent_start`, `agent_end`, `turn_end` and `tool_execution_*` events, posted to `POST /sessions/:dir/agents/:name/events`, so `agent.event` and `agent.settled` fire as today and the board's `process` and `busy` are correct; cost comes from pi's session file as today
- [ ] A daemon restart reattaches: the pty child survives (it is reparented, the daemon records its pid and start time in `session.yaml`) or, when it is gone, `resume` respawns pi on the same `--session-id` and the transcript continues
- [ ] The agents pane renders the terminal with xterm.js (`@xterm/xterm`, the fit addon, the web-links addon) in the agent tab, resizes with the pane and on pop-out, keeps the chat's `add agent`, `stop`, `resume` and the Context tab; the old chat remains behind `?chat=1` for an `rpc` agent
- [ ] In the desktop app the terminal tab receives keystrokes including Ctrl and the arrow keys, pastes, and renders pi's colours and widgets; Cmd-K and the other window shortcuts still reach the app
- [ ] E2e on a scratch daemon: spawn a tty agent, attach, type `/help` and see pi's command list, send `prompt` through the route and see the turn in the terminal and `agent.settled` on the bus, restart the daemon, attach again and see the scrollback
- [ ] `pnpm -r build && pnpm -r test && pnpm lint` and `doc-metrics --fail` green; `docs/ARCHITECTURE.md` "Agent adapter" and `docs/DAEMON_API.md` updated; Log tells the story

## Plan
- [ ] 1. Contract under Contracts: the tty WebSocket framing, the `commands` long-poll shape, the `events` post shape, `config.yaml` `agents.harness` (engine)
- [ ] 2. `PiTtyHarness` in `packages/daemon/src/agents/tty-harness.ts`: spawn, attach, resize, scrollback, exit; `AgentHandle` implemented over the extension channel; manager picks the harness from config (engine)
- [ ] 3. Extension: the `commands` long-poll with `sendUserMessage` and steer, the `events` posts, both only when `SPINNER_HARNESS=tty` (engine)
- [ ] 4. Routes: the WebSocket upgrade, `commands`, `events`; `session.yaml` `agents.<name>.pid` and `started` for reattach (engine)
- [ ] 5. `AgentTerminal.tsx` with xterm.js, the WebSocket client with reconnect, fit on resize and on the pane's collapse and expand; wired into `AgentsPane.tsx`; the fixture serves a fake pty echo for the driver (ui)
- [ ] 6. Desktop check: keystrokes, paste, shortcuts in the Electron window; the agents pane pop-out window carries the terminal (ui, with the desktop driver)
- [ ] 7. E2e on a scratch daemon, both agents' halves together; the operator tries it on a real session (engine, then the operator)
- [ ] 8. Lessons → protocol (the operator)

## Roster
| Agent  | Owns | Doing | Blocked? | Updated |
|--------|------|-------|----------|---------|
| engine | `packages/daemon/**`, `packages/pi-extension/**`, `packages/protocol/**`, `packages/cli/**`, `docs/ARCHITECTURE.md`, `docs/DAEMON_API.md` | — | no | — |
| ui     | `packages/ui/**` | — | no | — |

## Contracts & decisions
- (date) the operator: the tty harness is the default; the RPC harness stays for headless runs and tests, selected with `agents.harness: rpc` in `config.yaml`.
- (date) the operator: the extension is the daemon's only channel into a tty pi. The daemon never types into the pty on the operator's behalf; a prompt or a steer always goes through `sendUserMessage` or the steer queue, so the transcript records it as a message, not as keystrokes.
- (date) the operator: one pty per agent, many attachments. The pty's size is the last `resize` received; a smaller client sees a reflow, not a second pty.
- (date) the operator: the daemon owns the scrollback (64 KiB per agent, in memory, dropped on `stop`). The transcript on disk stays the record; the scrollback is only for the attach.
- (date) the operator: `node-pty` is the daemon's dependency, not the desktop's; the desktop renders over the same WebSocket as the browser, so there is no native module in Electron.
- (date) the operator: UI work runs as small passes: the operator reviews in the running app after each, sends a screenshot and one paragraph, the agent commits and reports.
- (date) the operator: rules from s001 to s008 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path; no `git add -A`, no `git stash`; `mktemp -d` scratch, reported, never deleted; never raise or move a window over the operator's; never print `.npmrc`, `.env*`, `auth.json`, `~/.spinner/env`, or a file named with `token`, `key` or `secret`; no customer or person in a tracked file; wait on an artifact (a Contracts entry, a commit), never on a Log timestamp; destructive e2e only on a scratch daemon with a scratch home; the operator's daemon on `:7777` is read-only for agents.

## Open questions
- (none yet)

## Log
- (start) the operator: session opened after s008; two pi subagents from one parent, briefs in agents/*/BRIEF.md
