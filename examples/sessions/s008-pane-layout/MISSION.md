# s008 · Panes: collapse, hide, pop out

## Goal
The operator's first hours in the desktop app: the preview pane could not grow past a fixed share of the window, and there was no way to hide or pop out a pane. After this session every divider drags to zero and the pane collapses to a strip with a restore click; every pane has hide and pop-out; a popped-out preview in the desktop app keeps its login because it is a window around the same `WebContentsView`. Two agents: `ui` (panes and controls in the web app) and `desktop` (pop-out windows).

## Done when
- [ ] Dragging a divider past a pane's minimum collapses it to a 24 px strip with the pane's name turned sideways; a click on the strip restores the last width; the layout is remembered per browser in `localStorage` (the one UI state the daemon does not own)
- [ ] Each pane (sessions, agents, previews) has `hide` and `pop out`; hidden panes show as strips; pop-out opens the pane as its own window: in a browser `window.open` of the UI with `?pane=previews&session=<dir>`, in the desktop app a `BrowserWindow` that adopts the preview's `WebContentsView` (no reload, login kept) or the agents pane as a page
- [ ] A popped-out pane docks back with one click; closing the window docks it back
- [ ] The operator's web app logged in inside a popped-out preview stays logged in
- [ ] `pnpm -r build && pnpm -r test && pnpm lint` and `doc-metrics --fail` green; Log tells the story

## Plan
- [ ] 1. Bridge additions under Contracts: `previews.popOut(key) / dockBack(key)`, `panes.popOut(pane, session)`; events `pane.docked` (desktop)
- [ ] 2. `useResizable`: minimums become collapse thresholds; a collapsed pane is a strip; width memory per pane; keyboard: double-click a divider restores (ui)
- [ ] 3. Pane header controls `hide` and `pop out` on the three panes; a `?pane=` route that renders one pane alone, for the browser pop-out and the desktop agents window (ui)
- [ ] 4. Desktop: pop-out window per preview key that adopts the view; dock back on click or window close; the agents pane window loads `?pane=agents&session=`; tray menu lists popped-out windows (desktop)
- [ ] 5. End to end: in the desktop app, collapse the agents pane fully, pop out the web preview with the operator's app logged in, dock it back (desktop; the login step is the operator's)
- [ ] 6. Lessons → protocol (Cullen)

## Roster
| Agent   | Owns | Doing | Blocked? | Updated |
|---------|------|-------|----------|---------|
| ui      | `packages/ui/**` | — | no | — |
| desktop | `packages/desktop/**`, `packages/protocol/src/desktop-bridge.ts` | — | no | — |

## Contracts & decisions
- (date) Cullen: layout is the one UI state the daemon does not own; it lives in `localStorage` per browser profile and in the desktop app's own store.
- (date) Cullen: a pop-out never reloads a preview in the desktop app; the window adopts the existing `WebContentsView`.
- (date) Cullen: `Preview.tsx` stays the only file that embeds a preview or talks to the bridge.
- (date) Cullen: UI sessions run as small passes: the operator reviews in the running app after each, sends a screenshot and one paragraph, the agent commits and reports; the mission's Plan is the backlog, not a contract to finish in one run.
- (date) Cullen: rules from s001 to s007 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path; no `git add -A`, no `git stash`; `mktemp -d` scratch, reported, never deleted; never raise or move a window over the operator's; never print `.npmrc`, `.env*`, `auth.json`, `~/.spinner/env`, or a file named with `token`, `key` or `secret`; no customer or person in a tracked file; wait on an artifact (a Contracts entry, a commit), never on a Log timestamp.

## Open questions
- (none yet)

## Log
- (start) Cullen: session opened after s007; two pi subagents from one parent, briefs in agents/*/BRIEF.md
