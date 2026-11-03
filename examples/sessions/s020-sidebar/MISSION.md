# s020 · The sidebar: the rail pulls out into an accordion

## Goal
The side panel today is a separate panel that the activity rail's buttons open: sessions or reviews, one at a time. After this session the rail is the panel: each icon is an accordion header, its list expands below it in the same column, sessions and reviews can both be open, and the compose box of each section stays pinned at its top. The column resizes left to right and snaps closed to the rail. One bug ships with it: a reload in a session view lands on the last selected review. One agent: `ui`.

## Done when
- [ ] The rail and the panel are one column: `sessions`, `reviews` and `settings` icons as headers; a click on `sessions` or `reviews` toggles its section; both can be open; the state is remembered per window; `settings` opens the settings view as today
- [ ] Each open section shows its compose box pinned at the top (new session: the paste box and `Start`; new review: the paste box and `Start review`) and its list below, scrolling inside the section
- [ ] The column is resizable left to right with the existing drag handle; three detail levels by width (title only · title with pills · the full card); a drag past the snap point collapses it to the rail with the existing overshoot rule, and the rail shows a needs-you count badge on `sessions` and on `reviews` while collapsed
- [ ] A reload restores the panel that was active and its selection: a session view reloads to the same session, a review view to the same review; the two selections no longer compete
- [ ] Driver flows `sidebar` (toggle, both open, resize levels, collapse, badges) and `reload` (session view survives reload; review view survives reload); existing flows updated; `pnpm --filter ui build`, `pnpm --filter ui test`, root `pnpm lint` green

## Plan
- [ ] 1. The reload bug: one persisted focus record `{ panel, session, review }`, restored as one (ui)
- [ ] 2. The accordion column: headers, sections, pinned compose boxes, remembered state (ui)
- [ ] 3. Width levels, snap-to-rail, the collapsed badges (ui)
- [ ] 4. Drivers, screenshots; existing flows updated (ui)
- [ ] 5. Lessons → protocol; release (the operator)

## Roster
| Agent | Owns | Doing | Blocked? | Updated |
|-------|------|-------|----------|---------|
| ui    | `packages/ui/**` | — | no | — |

## Contracts & decisions
- (date) the operator: the rail click toggles its section; both sections may be open; collapsed rail shows needs-you counts.
- (date) the operator: no daemon or protocol change; everything the sidebar needs is in `SessionView` already.
- (date) the operator: rules from s001 to s034 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path; no `git add -A`, no `git stash`; `mktemp -d` scratch, reported, never deleted; never print `.npmrc`, `.env*`, `auth.json`, `~/.spinner/env`, or a file named with `token`, `key` or `secret`; no customer or person in a tracked file; wait on an artifact, never on a Log timestamp; drivers run against the fixture, never against `:7777`, and close their CDP target; re-read `MISSION.md` before each edit; stop every fixture, vite and headless Chrome you started before you report; read the exact lines before an edit.

## Open questions
- (none yet)

## Log
- (start) the operator: session opened after v0.10.0 from the operator's feedback; one pi subagent, brief in agents/ui/BRIEF.md
