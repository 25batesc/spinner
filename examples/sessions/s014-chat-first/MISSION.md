# s014 · Chat first: a session is a conversation, the agent owns the mission

## Goal
Starting a session takes a form, an empty mission the operator must fill, and then an agent that only ticks its own items; the operator agent was built to fill that gap and the operator does not want it. After this session a new session is one paste and one click: the daemon pulls PR references out of whatever was pasted, starts a lead agent in the worktrees, and shows its terminal. The lead agent owns the mission: it writes Goal, Done when and Plan from the conversation, sets the title, ticks items as they finish, logs, asks, and adds agents when the work splits. The mission view becomes a live workspace instead of a page of markdown. The operator agent is paused. Three agents: `engine` (daemon, extension, protocol, cli), `ui`, and `design` (the mission workspace's look, in `packages/ui` beside the ui agent; one file set each).

## Done when
- [ ] `POST /sessions/extract` takes `{ text, project }` and answers `{ prs: [{ url, repo, number, title, branch, base, adoptable, reason? }], rest }`: full GitHub PR URLs in any form, `owner/repo#N`, `repo#N`, bare `#N` resolved against the project's repos (ambiguous ones carry a reason), duplicates folded, titles and branches from GitHub, `adoptable: false` with a reason for a repo the project does not list
- [ ] `POST /sessions` takes `{ project, text, adopt: [url...] }`: creates the session with a provisional title from the first line of the text, attaches the project, adopts the listed PRs (worktrees on their branches), starts the lead agent (`lead`, the default brief for a lead), and sends it the text with the adopted and the reference PRs as its first message; one job with a log
- [ ] The lead's brief (`store/brief-template.ts`, a `lead` variant) says: you own the mission; ask what the work is if the first message does not say; write Goal, Done when and Plan; set the title with `session_title`; keep Roster and Log current; tick items the moment they are done with `mission_plan`; add agents with `agent_add` when the work is parallel and brief them; product calls are Open questions; never push, post, approve, land, reset or close
- [ ] Extension tools for the lead: `session_title`, `mission_goal`, `mission_done_when` (set the list), `mission_plan` (add, tick, untick, reorder, assign), `agent_add`, `adopt` (PR references, with the adoptable rule), plus the existing `mission_*`, `message`, `stack`, `pr`, `diff_*`; every write is a section write through the daemon
- [ ] The mission format gains ids and times: `- [ ] 3. text (owner)` and `- [x] 3. text (owner, 14:02)`; the parser in `mission-sections.ts` reads and writes them; older missions parse as before
- [ ] `GET /sessions/:dir/mission/view` answers the structured mission (`goal`, `done_when[]`, `plan[]` with `id, text, owner, state, ticked_at`, `roster[]`, `contracts[]`, `questions[]`, `log[]` with `ts, author, text`), and `mission.changed` carries it
- [ ] The UI: the compose card is one box ("paste what this is about") with the extracted PRs as checkboxes under it and one `Start` button; the session opens on the lead's terminal; the `Adopt` block is gone
- [ ] The mission view is a workspace: Goal card; Done when as a checklist with who and when; Plan as three columns `next · doing · done` with owner chips and times; Roster as chips with each agent's doing; Open questions as cards with an inline answer (a steer to the asker); Contracts as a list; the Log as a live feed, newest first, filtered by agent; every item click-to-edit through the section route; a note on an item goes to its owner's inbox; updates arrive live
- [ ] `settings.operator.enabled` defaults to false; the headset tab hides when it is off; the operator host stays
- [ ] E2e on a scratch daemon with the real pi and the sample project: paste a sentence and one PR URL of the sandbox repository, start, the lead writes Goal and three Plan items within two minutes, ticks one after a steer, the workspace shows the tick with the time
- [ ] `pnpm -r build && pnpm -r test && pnpm lint` and `doc-metrics --fail` green; docs updated (`ARCHITECTURE.md` "Chat first", `DAEMON_API.md`, `SESSION_PROTOCOL.md` mission format); templates under `examples/sessions/` keep working; Log tells the story

## Plan
- [ ] 1. Contract under Contracts: extract, the new `POST /sessions` body, the mission view shape, the tool names and arguments, the format change (engine)
- [ ] 2. Extraction and the lookups; the `lead` brief; `POST /sessions` as one job (engine)
- [ ] 3. The mission format with ids and times; the parser; the structured view route and the event (engine)
- [ ] 4. The lead's tools in the extension; the operator default off (engine)
- [ ] 5. The compose box with extraction and checkboxes; the session opens on the terminal (ui)
- [ ] 6. The mission workspace: data flow, editing, the live feed, the answer and note actions (ui)
- [ ] 7. The workspace's look: columns, cards, chips, times, the feed; on the design system of `DESIGN-PASS.md` (design)
- [ ] 8. E2e with the real pi; docs (engine)
- [ ] 9. Lessons → protocol; release (the operator)

## Roster
| Agent  | Owns | Doing | Blocked? | Updated |
|--------|------|-------|----------|---------|
| engine | `packages/daemon/**`, `packages/pi-extension/**`, `packages/protocol/**`, `packages/cli/**`, `docs/**` | — | no | — |
| ui     | `packages/ui/**` except `MissionWorkspace*.tsx` and `mission-workspace.css` | — | no | — |
| design | `packages/ui/src/MissionWorkspace*.tsx`, `packages/ui/src/mission-workspace.css` | — | no | — |

## Contracts & decisions
- (date) the operator: the markdown file stays the source of truth; the workspace reads the structured view and writes through the section route; agents and humans may still edit the file.
- (date) the operator: one way to start a session: a paste and `Start`. The `Adopt` block goes; adoption is the ticked PRs in the paste, or the lead's `adopt` tool later.
- (date) the operator: the lead starts agents on its own; it never pushes, posts, approves, lands, resets or closes.
- (date) the operator: the ui agent owns the data flow and the actions of the workspace (`MissionWorkspace.tsx` receives props and callbacks); the design agent owns its look (`MissionWorkspaceView.tsx`, `mission-workspace.css`); they agree on the props under Contracts before either codes.
- (date) the operator: rules from s001 to s015 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path; no `git add -A`, no `git stash`; `mktemp -d` scratch, reported, never deleted; never print `.npmrc`, `.env*`, `auth.json`, `~/.spinner/env`, or a file named with `token`, `key` or `secret`; no customer or person in a tracked file; wait on an artifact, never on a Log timestamp; destructive e2e only on a scratch daemon with a scratch home; the operator's daemon on `:7777` is read-only for agents; a protocol change names the files the other agent's build touches; find the fault before you fix the proposed one; drivers close their CDP target; the fixture never defaults to the daemon's port.

## Open questions
- (none yet)

## Log
- (start) the operator: session opened after v0.5.0; three pi subagents from one parent, briefs in agents/*/BRIEF.md
