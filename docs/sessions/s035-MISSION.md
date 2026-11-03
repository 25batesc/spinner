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
- [x] 1. The reload bug: one persisted focus record `{ panel, session, review }`, restored as one (ui)
- [x] 2. The accordion column: headers, sections, pinned compose boxes, remembered state (ui)
- [x] 3. Width levels, snap-to-rail, the collapsed badges (ui)
- [x] 4. Drivers, screenshots; existing flows updated (ui)
- [x] 5. Round 2: the VS Code shape (rail + one panel, click again collapses, gear bottom left); drivers updated (ui)
- [ ] 6. Lessons → protocol; release (the operator)

## Roster
| Agent | Owns | Doing | Blocked? | Updated |
|-------|------|-------|----------|---------|
| ui    | `packages/ui/**` | done | no | 23:19 |

## Contracts & decisions
- 2026-11-02 the operator: the rail click toggles its section; both sections may be open; collapsed rail shows needs-you counts.
- 2026-11-02 the operator: no daemon or protocol change; everything the sidebar needs is in `SessionView` already.
- 2026-11-02 the operator: rules from s001 to s034 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path; no `git add -A`, no `git stash`; `mktemp -d` scratch, reported, never deleted; never print `.npmrc`, `.env*`, `auth.json`, `~/.spinner/env`, or a file named with `token`, `key` or `secret`; no customer or person in a tracked file; wait on an artifact, never on a Log timestamp; drivers run against the fixture, never against `:7777`, and close their CDP target; re-read `MISSION.md` before each edit; stop every fixture, vite and headless Chrome you started before you report; read the exact lines before an edit.

- 23:01 the operator: steering after v0.12.0 (round 2, the VS Code shape). The accordion goes. The shape is VS Code's: a vertical icon rail always on the far left (`sessions`, `reviews` at the top; the gear at the bottom left); a click on an icon opens its view in one side panel beside the rail; a click on the active icon collapses the panel; only one view shows at a time; the panel has a title row with the view's name and its count/needs pills; the `+ New …` button (commit `52adb82`) stays pinned under the title; the panel is resizable and a drag past the snap folds it, the rail stays; the icons carry the needs-you badge always, not only when collapsed; the settings view opens from the gear in the same panel. Width levels stay. The persisted state becomes `{ view: "sessions" | "reviews" | "settings" | null }`.

## Open questions
- (none yet)

## Log
- 21:27 the operator: session opened after v0.11.0 from the operator's feedback; one pi subagent, brief in agents/ui/BRIEF.md
- 21:28 ui: started; scratch dir /tmp/s035-ui.JQEj (fixture, vite, Chrome profile, driver shots)
- 21:42 ui: reload fault found: no key held the selection (`spinner.layout.v2` is geometry only), so a reload fell back to `sortedSessions()[0]` over sessions and reviews; the fixture's r51 review (needs-you, newest) won. Fix 95fe0bf: `focus.ts`, one `{ panel, session, review }` record in sessionStorage (`spinner.focus.v1`, per window); repro script reloads into the same session and the same review; reviews, review-lead, sessions-panel, compose, panes, narrow pass; build, test (193), lint green
- 21:49 ui: 077a49f accordion column: `Sidebar.tsx` (headers, both sections may open, pinned compose boxes, settings below the headers, collapse icon at the foot), `sidebar.ts` state in sessionStorage (`spinner.sidebar.v1`); new-session box moved from the middle pane into the sessions section (no cancel, no autofocus); rail shows only while the column is folded. Build, test (198), lint green; drivers that click `.activity-bar` or `.compose-new` are updated in item 4
- 21:51 ui: 71d22f8 width levels: `widthLevel()` gives `data-level` = title (<190 px) · pills (<240 px) · full on `.sidebar`, CSS only; snap-to-rail is the existing overshoot rule (min 140 px, `SNAP_PX` 60); the rail shows warn count badges on sessions and reviews. In the open column a header click toggles its section; on the folded rail an icon click opens the column on that section (the column must open to show it). Build, test (199), lint green
- 22:40 ui: c9b8768 drivers: new flows `sidebar` and `reload` pass against the fixture (:17935, vite :5335, CDP :9435); panes, compose, sessions-panel, settings, narrow, operator, reviews, review-lead, lifecycle updated and pass; 31 of 33 fixture flows pass. `pipeline` ("review log") and `history` (needs `E2E_SESSION`) fail the same way on v0.11.0 (checked from a `git archive 31af37f` copy in the scratch dir), so they are not from this session; real-daemon flows not run. Screenshots in `.spinner/artifacts/` (sidebar-1..7, reload-1..2). Build, test (199), lint green. Fixture, vite and Chrome stopped; scratch /tmp/s035-ui.JQEj kept
- 22:40 ui: done. What exists: `focus.ts` (reload focus record), `sidebar.ts` + `Sidebar.tsx` (accordion column, width levels, rail badges), flows `sidebar` and `reload`. Protocol change I would make: give each agent a fixed port block (fixture, vite, CDP) in the brief, and keep a known-failing-flows list in MISSION.md with the release it was checked on, so an agent does not rebuild a baseline copy to tell its own failures from old ones
- 23:04 ui: round 2 started (Plan 5, the VS Code shape); scratch dir /tmp/s035-ui-r2.8EIG (fixture :17935, vite :5335, CDP :9435, shots)
- 23:19 ui: b1ed78c VS Code shape: the rail always shows (sessions, reviews at the top; operator and gear at the bottom), each list icon with its needs-you badge at all times; a click opens that view in the one side panel (title row: name, count, needs pill; `+ New …` from 52adb82 kept under it); the lit icon collapses the panel; a snap fold sets the view to null and the rail stays; width levels kept. `sidebar.ts` is `{ view }` under `spinner.sidebar.v2`. Drivers: `sidebar` rewritten, reload, panes, compose, sessions-panel, settings, narrow, operator, reviews, review-lead, lifecycle updated (52adb82 had left compose, sessions-panel, reviews, review-lead and lifecycle without the `+ New` click). Sweep: 31 of 33 fixture flows pass; `pipeline` and `history` fail as on v0.11.0. Build, test (201), lint green. Screenshots `.spinner/artifacts/sidebar2-1..8`. Fixture, vite, Chrome stopped; scratch kept
- 01:24 the operator: s035 closed. The reload focus bug (no key held the selection) and the sidebar in two rounds: an accordion, then the VS Code shape after the operator's feedback. ui $7.30 + $5.37 (91 min). v0.12.0, v0.12.1.
