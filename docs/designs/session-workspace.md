# Session workspace: one row of phases, one board, one spec

*   **Author:** lead (s046), from the s043 concepts brief (`design/concepts_brief.md`, six Goldfish reports)
*   **Status:** Approved
*   **Version:** 2 (version 2 applies the 4 Blockers and the 17 Majors of `design/consolidated_review_report.md`; `design/goldfish_review_report.md` records the Blockers, the Log of s046 records the Majors)
*   **Date:** 2026-11-04

--------------------------------------------------------------------------------

## Overview

A Spinner session shows the operator four kinds of truth.
The spec says what is being built.
The agents say who builds it.
The board says where the work stands.
The narrative says what happened.

Today these four are spread over the view tabs `agents · design · mission · threads · services`.
The `design` tab has five sub-tabs: Brief, Design, Review, Files, History.
The context bar has its own stepper, `Brainstorm · Draft · Review · Approve · Build`, with names that differ from the tabs.
The plan exists twice: as the design doc's Detailed Implementation Plan, and as the Plan in `MISSION.md`, which the lead retypes after approval and keeps aligned by hand.

After this design ships:

1.  One row of tabs follows the EGM steps left to right: `Agents · Brainstorm · Draft · Review · Implement · History`, with `Files`, `Threads` and `Services` beside.
    The stepper folds into the row: the active step marks its tab.
    The names in the row are the names of the steps.
2.  The `mission` view is renamed **Implement**.
    It is the one place where the operator reads the tasks and their status.
    Its layout is a phase-first list with a side rail (decision L1, Technical Plan T6): one collapsible section per phase, one row per item with a state dot, the roster in a rail.
    A tick shows within one `mission.changed` event.
3.  The plan is one stored list.
    At approval, the daemon seeds the `MISSION.md` Plan from the doc's plan entries, one item per entry, grouped by the doc's build sessions.
    Each item carries a link to its entry.
    The Draft tab draws a done mark beside each entry whose item is ticked.
    The daemon never writes build state into the design doc.
4.  On the design track the goal block on Implement is the doc's Overview and Goals, read-only, with a link to the Draft tab.
5.  A direct-track session, and a session from before EGM adoption, shows no EGM tabs and opens on Implement.
6.  The Activity drawer stops listing `mission.changed` and `agent.settled` events.
    Daemon milestones (approval, seed, PR created) are `spinner` lines in the Log.

The design doc stays the spec; `MISSION.md` stays the run-state file written through the seven `mission_*` tools.
The Timeline alternative (MISSION.md rendered from an event stream) is rejected; see Alternatives Considered.

### How to read this document

*   "The doc" is the session's design doc, `docs/designs/<feature>.md` in the project repo, written by EGM's `egm-draft` skill.
*   "An entry" is one `##### n.n` or `#### n.` heading in the doc's Detailed Implementation Plan.
    "A phase" is one `#### Build session N` heading that groups entries.
*   "The board" is the planned / doing / done view of the `MISSION.md` Plan on the Implement tab.
    "An item" is one Plan line, `- [ ] n. text`, with its id, owner and tick.
*   "The row" is the view tab row of a session.
    "The stepper" is today's step indicator in the context bar.
*   `egm-adoption.md` is the design that made Spinner an EGM harness (`docs/designs/egm-adoption.md`).
    Its decisions, journeys and plan sections are cited with the prefix `EA-`: `EA-D7`, `EA-CUJ 12`, `EA-T10`.
    A bare `D`, `CUJ` or `T` number is this document's.
*   EGM is Google's Elephant-Goldfish Model (Apache-2.0): one long-context agent, the Elephant, drafts the design; fresh-context reviewers, the Goldfish, audit it; the operator approves.
    A "lens" is one Goldfish persona; the brainstorm ran six.
*   `s0NN` is the id of a past Spinner building session.
    s037 built 23 entries as 6 owner-sized items without touching the doc; it is the example cited for free items (D3).
*   K1 to K5 are the operator's choices from the brainstorm; L1 is the operator's layout choice; they are restated under Decisions.
*   "Step" is one of the five EGM steps the row shows: Brainstorm, Draft, Review, Approve, Build.
    "Session stage" is the daemon's derived design state (`intake`, `brainstorm`, `drafting`, `drafted`, `design-review`, `resolving`, `design-ready`, `approved`), which `designSteps` maps to step states.
    "Review stage" is one of the five `egm-review` stages 5 to 9; the Review tab shows one dot per stage.
    "Pipeline stage" is the pill in the context bar (run local, previews, PR, review, post, land).

### Glossary

| Term | Meaning |
|---|---|
| Design track | A session that runs EGM: brainstorm, draft, review, approve, then build. The doc holds the spec. |
| Direct track | A session without a design doc: a small fix or an adopted PR. The lead writes the Goal and Done when in `MISSION.md`. |
| Legacy session | A session created before EGM adoption; its `session.yaml` has no `design` block. |
| Seed | The daemon's write of Plan items into `MISSION.md` from the doc's entries, at approval, after its checks passed. Idempotent: a second run adds only the entries that have no item, and marks items whose entry changed or vanished. |
| Item state | `next` (unticked, nobody on it), `doing` (unticked and the owner's Roster `Doing` cell names `#id` or `item id`, or the owner is active and this is its lowest unticked item; `names_item` in `mission-sections.ts`), `done` (ticked). The board's three states. |
| Gate | A question the lead asks the operator with `ask_question`: one question, 2 to 6 options, stored in `design.gate`. The gate card draws it with answer buttons. |
| Resolve card | The card that shows while `goldfish_review_report.md` exists without `Status: resolved` on its first line; the operator marks the findings resolved there. |
| `needs you` pill | The context-bar pill that shows while `needs_human` is set (a gate, a resolve, a blocked agent); a click opens Agents. |
| Round | One pass of a session through the pipeline to a landed PR. `spinner reset` starts the next round (`archive_round`): it moves the Log and the PR facts under `## Previous rounds` and keeps the Plan. |
| Brief (agent) | `agents/<name>/BRIEF.md`, the text the daemon writes for an agent from `brief-template.ts`: role, owned files, rules. Distinct from the concepts brief, the brainstorm's output. |
| The fixer | The session agent of the fix stage that answers review threads on the PR; it uses the same `mission_*` tools. |
| Direct-to-design switch | The operator moves a session from the direct track to the design track with the track chip; the Plan the lead wrote stays. |
| pi | The coding-agent runtime every session agent runs in; the `mission_*` tools are a pi extension (`packages/pi-extension`). |
| `spinner` (author) | The daemon's own author name (`SPEC_AUTHOR`) on Log lines and Plan items it writes. The Roster has no `spinner` row. |
| Entry link | The token on a Plan line that names the entry the item came from, plus the `entry` field on `PlanItem`. |
| Free item | A Plan item with no entry link: a fix, a test, a split the lead added during the build. |
| Done mark | The mark the Draft tab draws beside an entry heading when its linked items are ticked. Drawn, never stored in the doc. |
| Narration surface | One of the Log (agents' narrative), the Activity drawer (daemon events), the job log (one job's stdout), History (rounds and approvals). |

## The Problem

An operator of a design-track session cannot read where the work stands from one view.

*   **Two vocabularies for one flow.**
    The stepper says `Brainstorm · Draft · Review · Approve · Build`.
    The tabs say `agents · design · mission · threads · services`, and `design` says `Brief · Design · Review · Files · History`.
    A first-time operator sees the word "Design" four times on one screen: the view tab, the sub-tab, the track chip and the stage family.
    The stepper's click opens a sub-tab, so the operator learns a mapping instead of reading a row.
*   **Two plans, aligned by hand.**
    The build message after approval tells the lead to "add one Plan item per `##### n.n` entry" (`approve.ts`).
    The lead retypes up to 166 headings (`egm-adoption.md`) or groups them by hand (s037: 6 items for 23 entries).
    The only link between an item and its entry is the text prefix `plan 2.21: …`, which `mission_plan edit` can erase.
    Nothing shows on the doc which entries are done.
*   **A goal that fails to edit.**
    On the design track, `MISSION.md` refuses `mission_goal` from any author but the daemon (`mission-writer.ts`), so the Goal is a pointer sentence and the edit affordance on the mission view fails with a 400.
    The Done when section holds one placeholder item.
*   **The wrong tabs for the wrong track.**
    A direct-track session opens with Brief, Design and Review tabs whose empty states name a button that does not exist on that track.
*   **Four narration surfaces with overlap.**
    The Log, the Activity drawer, the job log and History all narrate.
    The drawer repeats `lead changed log` and `agent lead is idle` on every event, and the seed has no Log line yet.

The proposed solution keeps the files and the tools and changes what the operator sees: one row in step order, one board seeded from the doc and linked back to it, one read-only goal block, tabs by track, and a trimmed drawer.

## Goals

*   **One stored list for the plan.**
    The Plan in `MISSION.md` is seeded from the doc's entries at approval, with an entry link per item.
    The board on Implement and the done marks on the Draft tab are two renderings of that list.
    No build state is ever written into the doc file.
*   **Tasks and status readable from Implement alone.**
    The operator reads what is `next`, what is `doing`, who owns it and what is `done` from the sticky header and the phase list, without opening a second tab.
    Seeded items appear grouped by phase; free items and sub-items are allowed and never touch the doc.
    A tick shows within one `mission.changed` event.
    The layout is the phase-first list with a side rail (L1, T6).
*   **One home per kind of data, links instead of copies.**
    The spec lives on Draft, the agents on Agents, the status on Implement, the narrative on the Log and History.
    A surface that needs another kind of data links to its home instead of drawing a copy; no card is drawn twice.
*   **A read-only goal block from the doc on the design track.**
    Implement renders the first paragraph of the doc's `## Overview`, clamped as the Goal card is today, with `open in Draft` as the expansion and no edit affordance.
    On the direct track the goal block stays editable.
    The Done when section is hidden on the design track and `entries done n / N` is shown instead.
*   **One row, one vocabulary.**
    The tabs take the step names and the step order.
    The active step marks its tab; the stepper leaves the context bar; Approve is the Review tab's primary button.
    Agents stays a tab, first in the row, the one place with answer controls; the gate card on Brainstorm and the resolve card on Review become one-line links to it.
    Files stays a tab.
*   **Tabs by track.**
    `viewTabs` is a function of the track.
    The direct track and legacy sessions show `Agents · Implement · Files · History · Threads · Services`, Implement default.
*   **Four narration surfaces, each with one job.**
    The drawer drops `mission.changed` and `agent.settled` lines.
    Approval, seed and PR created are `spinner` lines in the Log.
*   **Rollback by tag checkout stays safe.**
    No file format changes except the entry token on the Plan line, which an older daemon reads as plain text.
    An older daemon opens a seeded session without error.
*   **The entry grammar is stated once and tested.**
    One fence-aware heading walker serves the daemon's seed, the daemon's blocker count, and the UI's grouping and done marks (D8).
    Its fixtures are both layouts (`#### n.` from EGM's template, `##### n.n` under `#### Build session N` from Spinner's docs), with the real `egm-adoption.md` as the large fixture.
*   **Bounded size.**
    Two Spinner building sessions: the engine (about 6 hours) and the UI (about 10 hours), with the cut order stated in the Verification Plan.

## Non-Goals

*   **Rendering `MISSION.md` from an event stream**, or replacing the seven `mission_*` tools with a smaller set.
    The bus holds no history (`event-bus.ts`); every agent brief since s001 and the fixer assume the seven tools; `EA-D6` refused the smaller migration.
*   **Writing progress into the design doc during the build.**
    The `Status:` line stays the only daemon-written line.
    A one-shot "write the ticks into the doc at create PR" is a Future Improvement.
*   **A persisted per-session event store** (`log/events.jsonl`).
    It is a later design if History and the drawer still overlap after the trims.
*   **Merging the job log or the Activity feed into History.**
    That needs a per-session job store the daemon does not have.
*   **Snapshotting the board per round** ("earlier boards").
    `archive_round` keeps the Plan, so no earlier board exists; the board persists across rounds with each item's tick time visible.
*   **Agent chips above every tab with a docked chat** (the layout rewrite).
    Rejected for this round by K1; kept as a Future Improvement.
*   **Changing EGM's skills or its design doc template** (`EA-D14`: the pinned EGM checkout is used as is; an upstream pi adapter is EGM's, not Spinner's).
    The seed parses what the template writes today.
*   **Changing the pipeline** (run local, previews, create PR, review, fix, post, approve, land).
*   **Refusing `mission_plan add` before approval.**
    A refusal would break the direct-to-design switch and the lead's planning during the draft.

## Decisions

The brainstorm resolved D1 to D7; the operator chose K1 to K5 on 2026-10-31 and L1 on 2026-11-04.
D8 to D15 are the draft's own, taken from reading the code.
R1 to R3 are the operator's answers to the review's three open Majors (2026-11-05).

| Id | Decision | Why |
|---|---|---|
| D1 | `MISSION.md` stays the run-state file, written through the seven `mission_*` tools. The Timeline is out. | No event store exists; every brief assumes the tools; see Alternatives. |
| D2 | The daemon never writes build state into the design doc. The `Status:` line stays the only daemon-written line. The done mark is the Plan tick, drawn on the Draft tab. | The approval hash strips only `Status:` (`derive-design.ts`); any other byte invalidates the approval and locks the lead. |
| D3 | The board allows free items and sub-items. A split never touches the doc. `mission_plan add` is never refused. | s037 built 23 entries as 6 items; a refusal breaks the direct-to-design switch. |
| D4 | The goal block on Implement is the first paragraph of the doc's `## Overview`, clamped as the Goal card is today, read-only, with `open in Draft`, on the design track; editable on the direct track; one `goalSource(view)` decides. Done when is hidden on the design track. | `mission-writer.ts` refuses Goal and Done when to every author but `spinner` on the design track; the edit affordance fails with a 400 today. The whole Overview would push the phase list below the fold. |
| D5 | `viewTabs` has two cases: the design track shows the EGM tabs; the direct track and a legacy session (no `design` block) show the same shorter row and open on Implement. | A direct-track session must not show Brief, Draft and Review tabs whose empty states name buttons the track does not have. `DesignFiles` and `DesignHistory` render an empty list without a `design` block, so a third case saves nothing (R3). |
| D6 | The drawer drops `mission.changed` and `agent.settled` lines. Daemon milestones (approval, seed, PR created) are `spinner` Log lines. No Goldfish Log line. | `pr`, `post` and `land` write `spinner` Log lines (`pr.ts`, `post.ts`, `land.ts`); approval does too. A Goldfish line needs a writer and a cost source the watcher does not have, and a persisted once-rule across restarts; the cost is in the step tooltip and History. |
| D7 | Four narration surfaces stay. History does not absorb the job log. No earlier boards. | `archive_round` keeps the Plan; a per-session job store does not exist. |
| K1 | Agents stays a tab, first in the row, the one place with answer controls. The gate card on Brainstorm and the resolve card on Review become one-line links to Agents. | The tty terminals stay mounted in Agents so their sockets survive (`AgentsPane.tsx`); a second mount is a layout rewrite. |
| K2 | The seed adds one item per entry, grouped by the doc's phases. (The brainstorm's second clause, a phase picker in the approve dialog, is dropped by R2.) | One item per phase makes the lead retype the entries; link by reference makes the board not the doc's plan. |
| K3 | The entry link is a token on the Plan line plus `entry` on `PlanItem`. The legacy `plan <id>:` prefix is recognised. | A side file is a second store for an item fact. An older daemon reads the token as text. |
| K4 | One vocabulary. The tabs take the step names in the step order; the active step marks its tab; the stepper leaves the context bar. | Two vocabularies for five places confuse a first-time operator. |
| K5 | Files stays a tab. | The direct track lands on it; drift reports live there (`EA-CUJ 12`). |
| L1 | Implement is a phase-first list with a side rail (Option B of the layout question, Alternatives K and L are the other two). The three-column board is removed. | The operator chose it on 2026-11-04: it scales to a 166-entry plan with phases collapsed. |
| D8 | One fence-aware heading walker and the entry scan live in `@spinner/protocol` (`plan-entries.ts`); the walker serves the scan and the daemon's blocker count (`count_listed_blockers`); the scan serves the seed, the Implement grouping and the Draft tab's marks. | `@spinner/protocol` holds pure runtime helpers (`diff.ts`) and both packages import it. Two fence walkers exist today (`headings_of` in `approve.ts`, `docSections` in the UI); a third would make the fence rule differ by caller. |
| D9 | An entry's mark is `done` when every Plan item linked to it is ticked and at least one is linked; else `doing` when any linked item is doing; else `partial` when some are ticked; else `none`. `doing` wins over `partial`. | The rule is defined over all linked items, so a split cannot produce a false `done`. |
| D10 | The seed's owner is `null`; the lead assigns owners. The seed bypasses the writer's `add` default (`owner ?? author`). | With owner `spinner`, no item could ever read `doing`: the Roster has no `spinner` row. |
| D11 | The seed's checks run inside `approve_design` before any write, next to the lead-not-running refusal; a doc the seed cannot honour is refused with 409 and no approval is recorded. The write of the Plan runs after the record through `MissionWriter.rewrite`. There is no seed route and no `seed: null`. | `approve_design` already refuses before any write so that "an approval never stands without its build prompt"; every seed failure (duplicate ids, bounds, empty titles, `existing + added > ITEMS_MAX`) is deterministic over the doc text the route reads before the record (R1). |
| D12 | `stepTab` is total: `brainstorm` lights Brainstorm, `draft` lights Draft, `review` and `approve` light Review, `build` lights Implement. | The Review tab carries the approve button, so Approve is a state of Review, not a tab. |
| D13 | Every tab label is Title case. The folded form of the four EGM tabs is one tab labelled by `compactLabel` (`EGM 3/5 Review`) with a menu. | One label case was asked; the fold reuses the stepper's existing rule and text. |
| D14 | The `doing` state stays derived from the Roster (`parse_plan`): an item is `doing` when its owner's Roster `Doing` cell names `#id` or `item id`, or when the owner is active and the item is its lowest unticked one (`names_item`). The rail's live dot wraps `agentState(spec, hosted)` (`AgentsPane.tsx`) and adds `blocked` from the Roster `Blocked?` cell and `needs-you` from `needs_human`. | No new state; the board keeps reading what agents write; `agentState` exists. |
| D15 | The agents pane fetches the doc once per reload key and passes the text to the Draft and Implement views; the daemon adds no `entries` field to `DesignView`; the fetch key does not include the mission revision. | One fetch per doc change, not per `mission.changed`; the scan is pure and bounded and runs in `useMemo` on the text. |
| R1 | The seed validates before the approval record (D11). The seed route, `DesignSeedRequest`, `seed: null`, the failure Log line and the failure-variant build message are removed. | The operator's answer to review M-1 (2026-11-05): fewer paths; the existing refuse-before-write rule covers it. |
| R2 | No phase picker: the seed adds every phase's entries. A picker is a Future Improvement. | The operator's answer to review M-2: no journey unchecks a phase; re-approval of an unchanged doc is allowed and the seed is idempotent, so "seed later" is one click; L1 handles 166 rows by collapsing. |
| R3 | Two tab-row cases on `design?.track === "design"`: a legacy session takes the direct row. | The operator's answer to review M-3: `DesignFiles` and `DesignHistory` render empty without a design block. |

## Open Questions

*   **Q1 (the Implement layout)** was resolved as L1.
*   **Q2. The synonym heading for the plan section.**
    EGM's template writes `## Detailed Implementation Plan`, and `design_doc` refuses a doc without that heading (`design-doc.ts` `REQUIRED_HEADINGS`), so a named doc always has it.
    The scan still accepts a `## ` heading that ends with `Implementation Plan`, so the scan is usable on a doc that was not named; this costs one regex.
    If an existing doc uses another name, the scan finds no entries and the approval is refused with that reason (D11).
*   **Q3. The fold width of the row.**
    The row folds its four EGM tabs when its content overflows its width, as the stepper does today (`useBarFold`).
    Whether the Threads and Services tabs should also fold on a narrow middle pane is left to the build; the plan reserves the behaviour, not the pixel value.

## Critical User Journeys (CUJs)

### CUJ 1: Read the state of a build in ten seconds

*   **Given**: A design-track session, approved, with 23 entries seeded into 3 phases; two workers hold items.
*   **When**: The operator opens the session and the Implement tab.
*   **Then**: The row shows `Agents · Brainstorm · Draft · Review · Implement · Files · History · Threads · Services`, with Implement marked as the active step.
    Implement opens on the sticky header: `entries done 9 / 23 · 2 in progress · 1 open question`.
    Phases 1 and 2 are collapsed with `9 / 9` and `0 / 8`; phase 3 is open because it holds the doing rows, which sort first.
    The rail shows `lead`, `engine` and `ui` with their live dots; `ui` shows `blocked`.

### CUJ 2: Approve and seed

*   **Given**: A design-track session at `design-ready`; the doc has 3 phases with 23 entries; the Plan holds 2 free items the lead added during the draft.
*   **When**: The operator opens the Review tab, clicks `approve and build`, confirms.
*   **Then**: The seed's checks pass (no duplicate ids, no empty title, 25 items under the bound); the approval is recorded; the Plan gains 23 items with owner `null` and texts `` [1.1] `packages/protocol/src/plan-entries.ts` `` and so on (the backticks stay, as T2 says), after the 2 free items; the Log reads `spinner: plan seeded from docs/designs/x.md (a1b2c3d4e5f6): 23 added, 2 kept, 0 stale, 0 orphaned`.
    The approve dialog shows `23 added, 2 kept` from the response before it closes.
    The lead's build message says the Plan holds the entries and tells it to tick them.
    Implement shows the 3 phases; the Draft tab shows an empty mark beside each entry heading.
    Had the doc two entries with the same id, the dialog would show the 409 text `the plan has duplicate entry ids: 2.3` and nothing would be recorded.

### CUJ 3: A tick moves both renderings

*   **Given**: CUJ 2; the `engine` worker owns item 7 (`[1.5]`).
*   **When**: `engine` calls `mission_plan tick 7`.
*   **Then**: Within one `mission.changed`, Implement's row 7 shows done with the time and phase 1 reads `1 / 9`; the Draft tab's mark beside `##### 1.5` reads done.
    The design doc file is unchanged; `changed_after_approval` stays false.

### CUJ 4: A split without touching the doc

*   **Given**: CUJ 2; entry 2.3 is one file with three distinct changes.
*   **When**: The lead calls `mission_plan add` with `entry: "2.3"` three times and ticks the seeded item 12.
*   **Then**: Three rows appear under phase 2 with token `[2.3]`; the Draft tab's mark for 2.3 reads partial until all four items are ticked, then done.
    The doc is unchanged; no re-approval.

### CUJ 5: Re-approval after a doc change

*   **Given**: CUJ 4; the lead edits the doc: 2.3 is split into 2.3 and 2.4, so the old 2.4 to 2.8 become 2.5 to 2.9.
*   **When**: The operator re-approves.
*   **Then**: The seed finds that items `[2.4]` to `[2.8]` no longer match their entries' titles and marks them `stale`; it adds one item for the new 2.9 (the old 2.8's heading), keeps every tick, and logs `1 added, 23 kept, 5 stale: 2.4, 2.5, 2.6, 2.7, 2.8, 0 orphaned`.
    The five rows show the `stale` badge until the lead re-points each with `mission_plan edit` and the new token.
    An entry the doc dropped leaves its item in place with an `orphan` badge on the row.
    The seed never rewrites a token.

### CUJ 6: The goal on the design track

*   **Given**: A design-track session with a named doc.
*   **When**: The operator opens Implement.
*   **Then**: The top block shows the first paragraph of the doc's `## Overview`, clamped at `GOAL_CLAMP_CHARS` with `show all`, read-only, with `open in Draft`.
    No edit affordance; no Done when section; the header shows `entries done n / N` once approved, or `Approve to seed N entries` before.

### CUJ 7: A direct-track session

*   **Given**: A session adopted from a PR, track `direct`.
*   **When**: The operator opens it.
*   **Then**: The row is `Agents · Implement · Files · History · Threads · Services`; Implement is shown; the goal is editable; the Plan is a flat list under one `Plan` section with no phases; Done when shows.

### CUJ 8: A session from before this design

*   **Given**: A session whose `session.yaml` has no `design` block, and whose Plan has items `plan 2.21: …` from the old build message.
*   **When**: The operator opens it with the new daemon and UI.
*   **Then**: The row is `Agents · Implement · Files · History · Threads · Services`, Files and History empty; the items parse with `entry: "2.21"` and show the token; nothing is rewritten until an agent next writes the Plan section.

### CUJ 9: Rollback to the previous tag

*   **Given**: A session seeded by this design.
*   **When**: The operator checks out the previous tag and starts that daemon and UI.
*   **Then**: The Plan lines read as plain text, `[1.5] packages/...`; the mission view parses; the old UI shows the three-column board with those texts; nothing errors.

### CUJ 10: The lead asks a question during the brainstorm

*   **Given**: A design-track session at `brainstorm`; the lead posts a gate.
*   **When**: The operator is on the Brainstorm tab.
*   **Then**: The tab shows one line, `The lead asks: <question> → answer in Agents`, which opens Agents with `lead` picked; the gate card with its buttons is drawn only there.
    The `needs you` pill routes to Agents, unchanged.

## Technical Plan (Architecture)

### T1. Components

```text
                    packages/protocol
                    ├── plan-entries.ts      headings(); scan(doc) → phases[], entries[]; token parse/render
                    └── api.ts               PlanItem.entry; DesignApproveResponse.seed; SeedResult

 daemon                                                 ui
 ┌──────────────────────────────┐                       ┌──────────────────────────────────┐
 │ egm/approve.ts               │  session.updated      │ App.tsx: row, shown view, agent  │
 │   approve_design             │ ───────────────────▶  │ AgentsPane: fetches the doc once │
 │   ├─ seed checks (before)    │                       │   ViewTabs + tabMarks()          │
 │   └─ seed-plan.ts (after)    │  mission.changed      │   ImplementView(text, mission)   │
 │ store/mission-writer.ts      │ ───────────────────▶  │     GoalBlock ← first paragraph  │
 │   rewrite(), item add        │   (view: MissionView) │     PlanList ← phaseGroups()     │
 │ pipeline/mission-sections.ts │                       │     RosterRail → Agents          │
 │   parse_item: entry token    │                       │   DesignDoc(text, mission)+marks │
 └──────────────────────────────┘                       └──────────────────────────────────┘
          │ reads doc once at approval                              │ fetchDesignDoc, once per reload key
          ▼                                                         ▼
   docs/designs/<feature>.md  ── never written by the build; the Status line only, at approval
```

The daemon reads the doc at approval and writes `MISSION.md`.
The agents pane reads the doc once per reload key and hands the text to the Draft and Implement views; both read `MissionView` from `mission.changed`.
Both sides call the same `scan` from `@spinner/protocol`, so a heading counts as an entry on one side if and only if it counts on the other.

### T2. The entry grammar (`packages/protocol/src/plan-entries.ts`)

`headings(text, lines_max)` is the one fence-aware heading walker: one pass over the lines, bounded at `lines_max`, with the fence rule `docSections` uses today (three or more backticks or tildes open; the same character at the same or greater length closes); it returns `{ level, text, line }` for every `#` heading outside a fence.
`scan` consumes it with `DOC_LINES_MAX = 100_000`; `count_listed_blockers` in `approve.ts` consumes it in place of its private `headings_of`; `docSections` in the UI follows when it is next touched.
The scan's rules, over the headings:

1.  The plan section starts at a `## ` heading whose text ends with `Implementation Plan` and ends at the next `## ` heading or the end of the file.
    Lines outside the plan section are not scanned.
2.  Inside it, a phase is a `#### ` heading whose text matches `^Build session (\d+)\b(?::\s*(.*))?$`.
    `phase.number` is the integer; `phase.title` is the rest or `""`.
3.  An entry is a `#### ` or `##### ` heading whose text matches `^(\d+(?:\.\d+)?)\.?\s+(.*)$`.
    `entry.id` is the first group as written (`1.5` or `3`); `entry.phase` is the number before the dot, or `null` for a flat `#### n.` entry.
    `entry.title` is the second group after three strips, in this order: every `**[…]**` tag; then one trailing parenthetical `( … )`, whatever it holds; then surrounding whitespace.
    `entry.kind` is the first word of the stripped parenthetical when it is `Create`, `Modify`, `Delete` or `Remove`, else null.
    The strip of any trailing parenthetical is what keeps `parse_item` from reading it as the owner (`mission-sections.ts` `TRAILING_PAREN`): `Modify` matches the owner pattern.
    A title that is empty after the strips (`##### 2.5 (Modify)`) is reported in `scan.empty_titles`; the seed refuses such a doc and names the ids, because `render_item` refuses an item without text.
    The backticks around a path stay in the title.
4.  Bounds: `PHASES_MAX = 50`, `ENTRIES_MAX = 500` (equal to `ITEMS_MAX` in `mission-sections.ts`, the per-section total the mission parser asserts); past a bound the scan throws, so a malformed doc is an error, not a partial seed.
5.  A duplicate entry id keeps the first and reports the second in `scan.duplicates`; the approval refuses a doc with duplicates and names them (D11).

```text
scan(doc: string): PlanScan
PlanScan  = { phases: PlanPhase[]; entries: PlanEntry[]; duplicates: string[]; empty_titles: string[] }
PlanPhase = { number: number; title: string; line: number }
PlanEntry = { id: string; phase: number | null; title: string; kind: string | null; line: number }
```

Fixtures, all in `plan-entries.test.ts`:
the real `docs/designs/egm-adoption.md` (6 phases, 166 entries, first `1.1`, last `6.23`);
from that file, 1.25 (`(Modify, only when probe P3 fails)`) gives title `` `packages/pi-extension/src/tty.ts` `` and kind `Modify`, 1.34 (`(Create) **[D13]**`) gives kind `Create`, and 3.12 (`(Modify / Create)`) gives kind `Modify`;
a heading whose title strips to empty (reported in `empty_titles`);
EGM's template layout (`#### 1.` flat);
a `## Implementation Plan` synonym;
an entry heading inside a code fence (not counted);
a two-path heading (`` `a.ts`, `b.ts` (Modify) ``);
a heading with `**[D7]**`;
a doc without a plan section (zero entries);
a doc with 501 entries (throws).

### T3. The item token and `PlanItem.entry`

The Plan line form is `- [ ] 7. [1.5] packages/protocol/src/plan-entries.ts (engine)`.
The token is `[<id>]` followed by one space at the start of the text.
`parse_item` (`mission-sections.ts`) reads it into `MissionItem.entry`, and also reads the legacy prefix `plan <id>: ` into `entry`; the prefix becomes the token form on the next write of the section, as a missing id becomes permanent on the next write today. (No existing session uses the prefix; it is kept because the current build message dictates it until this design ships.)
`parse_item` reads the token on every checklist line; `parse_done_when` ignores `entry`, so a token on a Done when line is text with no effect.
`render_item` writes the token first.
`PlanItem` gains `entry: string | null`, so `mission.changed` carries it and the UI never parses the text.

The token survives `edit`: `apply_item` keeps `target.entry` and writes the new text after it; a new text that itself starts with a token replaces the entry, so the lead can move an item to another entry.
`add` takes `request.entry`; `MissionItemRequest.entry?: string` and the `mission_plan` tool gain the argument.
`assign`, `tick`, `untick` and `reorder` do not touch it.
There is no command to unlink an item; a lead that wants a free item adds one. This is a stated limit, not a gap.

The token character set is `[0-9.]`, bounded at 16 characters; a bracket text that does not match is plain text, so `[D7] fix the guard` stays an unlinked item.
A hand-written `[3] retry the probe` links to a flat entry `3` if the doc has one; that is accepted.

### T4. The seed (`packages/daemon/src/egm/seed-plan.ts`)

The seed has two halves: the checks, which run before the approval record, and the write, which runs after it.

`seed_checks(mission_text, scan): string | null` is pure and returns the refusal reason or null:
`scan.duplicates` non-empty (`the plan has duplicate entry ids: …`); `scan.empty_titles` non-empty (`entries without a title: …`); `scan.entries.length === 0` (`no plan entries found under an Implementation Plan heading`); `existing_items + entries_without_item > ITEMS_MAX` (`the Plan would hold N items; the bound is 500`).
`approve_design` runs `scan` and `seed_checks` after it reads the doc text and before the status rewrite, and throws `ApproveRefusal` (409) on a reason, next to the lead-not-running refusal, so no approval is recorded that the seed cannot honour (D11, R1).

`seed_plan(mission_text, scan): SeedResult & { mission_text: string }` is pure and runs after the record.
Steps, in order:

1.  Read the Plan items with `section_items` and `with_ids`.
2.  Build `by_entry: Map<id, items[]>` from the items that carry a token.
3.  For each item with a token: if no entry has its id, count it `orphaned`; if the entry with its id has a title different from the item's text, count it `stale`.
    Both are left in place; the row shows a badge (`entry <id> is not in the doc`, `entry <id> changed`) and the lead repairs with `mission_plan edit` and a new token.
    The seed never rewrites a token: it detects a renumbered doc, it does not guess.
4.  For each entry with no item: append `- [ ] <next id>. [<entry.id>] <entry.title>` with owner `null`; count `added`.
    Items are appended in doc order after the existing items, so ids keep rising.
    Every Plan item, old and new, is rendered through `render_item`, so a legacy `plan <id>:` prefix becomes the token, a missing id becomes permanent, and the template placeholder `- [ ] 1. ` is dropped; non-item lines (notes under an item) stay where `write_items` keeps them.
    Every appended line satisfies `parse_item(render_item(line))` with `owner === null` and `text === entry.title`; the seed throws otherwise, so a title the grammar cannot carry is an error, not a wrong owner.
5.  Every item that is neither added, stale nor orphaned counts `kept`.
    Nothing is deleted; no tick changes.

```text
SeedResult = { doc_path: string; sha12: string; added: number; kept: number; stale: string[];
               orphaned: string[] }
```

`approve_design` today runs: (1) the refusals (no doc, resolving, open gate, listed blockers, missing doc file, lead not running with `build`); (2) the `Status:` rewrite; (3) the hash and the copy to `approved.md`; (4) the record in `session.yaml`; (5) the approval Log line; (6) the build message.
The seed checks join step 1; the seed write runs between steps 4 and 5 through `writer.rewrite(dir, SPEC_AUTHOR, (text) => seed_plan(text, scan))`, a new `MissionWriter` method that reads `MISSION.md`, applies the function, writes the file and publishes one `mission.changed` with the whole view, so the file path and the publish stay with the writer.
The Log line is `plan seeded from <doc> (<sha12>): <added> added, <kept> kept, <n> stale[: ids], <m> orphaned[: ids]`.
The approve response carries `seed: SeedResult`; the dialog shows the counts before it closes.

The build message changes: it says the Plan holds one item per entry, names the token, tells the lead to tick an item when its entry is done, to split with `mission_plan add` and `entry`, to assign owners, to have a worker's Roster `Doing` cell name `#id` so the item reads `doing`, and to record an entry it cannot build as written under Open questions with the entry id.
`SESSION_PROTOCOL.md` and `brief-template.ts` lose the "add one item per entry" sentences and gain the token, the `entry` argument and the two worker conventions.

### T5. The row

`viewTabs(view)` has two cases on `view.design?.track === "design"` (R3):

| Session | Tabs, in order | Default |
|---|---|---|
| design track | Agents · Brainstorm · Draft · Review · Implement · Files · History · Threads · Services | Agents |
| direct track, or no `design` block (legacy) | Agents · Implement · Files · History · Threads · Services | Implement |

Files and History render empty for a session without a `design` block, as `DesignFiles` and `DesignHistory` do today.
The view ids are `agents`, `brainstorm`, `draft`, `review`, `implement`, `files`, `history`, `threads`, `services`; `TAB_LABELS` maps each to its Title-case label; `ViewTabs` takes `tabs: { id, label }[]` and reports the id.
The design sub-tab state (`designPick`) is removed: Brainstorm, Draft, Review, Files and History are views of the agents pane, each rendering the component the sub-tab rendered (`DesignBrief`, `DesignDoc`, `DesignReview`, `DesignFiles`, `DesignHistory`) with the same `reloadKey`.
`DesignWorkspace.tsx` and its sub-`Tabs` are deleted.

Each EGM tab carries a mark from `tabMarks(steps, design)`, a pure function in `design-workspace.ts`: a dot before the label with a state (todo, active, waiting, done), a tooltip, and an optional suffix.
`stepTab` is defined for all five steps and maps them onto four tabs (D12).
The rule for the Review tab, which carries two steps: its state is Approve's while Approve is active or waiting, else Review's; its tooltip is both `stepTitle`s joined; its suffix is `n/5` (the review stage dots) while the review runs.
Every other EGM tab's tooltip is `stepTitle(step, design)`, which carries the step's Goldfish cost; the running-Goldfish count (`RunningFish`) is the suffix of the Brainstorm or Review tab while a run is live.
The `DesignStepper` leaves the context bar; `compactLabel`, `stepperText`, `stepTitle` and `designSteps` stay in `design.ts`: `stepperText` for the session card's dots tooltip (unchanged), `compactLabel` for the folded row, `stepTitle` for the tab tooltips.
`useCompact` is removed with the stepper.
The pipeline stage pill stays in the context bar.
The `EGM` attribution (`EGM_NOTICE`) moves to the tooltip of the Brainstorm tab and stays in About.

Fold: when the row's `scrollWidth` exceeds its `clientWidth`, the four EGM tabs fold into one tab labelled by `compactLabel` (its Approve form reads `EGM 4/5 Approve` and opens on Review), which opens a menu of the four; `useRowFold` reuses the hysteresis of `useBarFold` with the row as the measured element.

The approve button: `DesignReview` gets a header with the toolbar's `approve` primary when the stage is `design-ready` or the doc changed after approval; the toolbar's design group is unchanged.
The gate card on Brainstorm and the resolve card on Review become the `compact` form of `DesignGate`: one line with the question's first 120 characters and `answer in Agents`, which calls `onOpenAgent("lead")`; the data path (`gateCard` in `design.ts`) is unchanged.
`GateCard` stays in Agents.

### T6. Implement (`packages/ui/src/ImplementView.tsx`, `implement.ts`)

`MissionWorkspace.tsx` keeps the data and the writes and renders `ImplementView` instead of `MissionWorkspaceView`.
It receives the doc text from the agents pane (D15) and the `SessionView`, and passes `ImplementView` the `design` block, the agent specs, `agents_running`, `needs_human`, `onOpenAgent` and `onOpenView`.
`ImplementView` is:

```text
┌ GoalBlock ───────────────────────────────┬ RosterRail ──────────┐
│ Overview, 1st paragraph (design) | goal  │ ● lead     working   │
│ goal (direct)                            │ ● engine   idle      │
├ Header (sticky) ─────────────────────────┤ ● ui       blocked ▸ │
│ entries done 9/23 · 2 in progress ·      │                      │
│ 1 open question · [doing]                ├ Questions ───────────┤
├ PlanList ────────────────────────────────┤ - ui: …   [answer]   │
│ ▸ Build session 1 · 9/9                  ├ Contracts ───────────┤
│ ▾ Build session 2 · 0/8 · 2 doing        │ - 00:46 lead: …      │
│   ● 11 [2.1] packages/… engine           │                      │
│   ● 12 [2.3] packages/… ui               │                      │
│   ○ 13 [2.2] packages/…                  │                      │
│ ▸ Build session 3 · 0/6                  │                      │
│ ▸ Other · 2/2                            │                      │
├ LogFeed (full width) ────────────────────┴──────────────────────┤
│ 00:48 lead: …                                                   │
└─────────────────────────────────────────────────────────────────┘
```

`implement.ts` is pure and tested:

*   `goalSource(design): "doc" | "mission"`: `doc` on the design track with a named doc; `mission` otherwise.
    With `doc`, the block shows the first paragraph of `## Overview` (`docSections`), clamped at `GOAL_CLAMP_CHARS` with `show all`, as the Goal card does today.
*   `phaseGroups(plan, scan | null): PhaseGroup[]`: one group per phase in `scan.phases` with its items (by the `entry` prefix before the dot), then `Other` for items without an entry or with an orphan entry (`orphan: true` on the row); a stale item (`stale: true`, its entry's title differs from the item text) stays in its phase group with a badge; with `scan` null, or with entries and no phases (EGM's flat template), one group `Plan`.
    Inside a group, `doing` rows first, then `next`, then `done`, each in id order.
    A group's counts are `done / total` and `doing`.
    A group opens by default when it holds a `doing` row, or, when no group does, when it is the first with an open row.
*   `implementState(design, scan, plan): "no-doc" | "unapproved" | "approved"` and the header text for each: `No design doc yet`, `Approve to seed N entries`, `entries done n / N` (N is `scan.entries.length`; n counts entries whose mark is `done`, D9).
    The header is `Pulse` extended with the entry counts; its scroll-to-section pills stay.
*   `railState(spec, hosted, blocked, needs): "working" | "idle" | "blocked" | "needs-you" | "off"`: wraps `agentState(spec, hosted)` (`AgentsPane.tsx`) and adds `blocked` from the Roster `Blocked?` cell (`isBlocked`) and `needs-you` from `needs_human` naming the agent; the rail chips reuse the `chip-*` classes.
*   `entryMarks(scan, plan): Map<id, { state: "none" | "doing" | "partial" | "done"; done: number; total: number }>` applies D9; it serves the Draft tab (T7) and the header count.

The view keeps the one-shot tick animation (`useArrivals`), the `pending` and `error` props, the note and answer boxes.
The `doing` filter chip hides every row that is not doing.
An orphan badge's tooltip reads `entry <id> is not in the doc`.
The `open in Draft` link calls `onOpenView("draft")`; a rail chip calls `onOpenAgent(name)`.
Done when renders only when `goalSource` is `mission`.

Reload: the agents pane fetches the doc once per `reloadKey` (design files, doc path) and passes the text down; the view re-renders on `revisions.mission`; the scan runs in `useMemo` on the doc text, the groups and marks in `useMemo` on `[scan, mission.plan]`.
The doc is not refetched on `mission.changed` (D15).

### T7. The Draft tab's marks

`DesignDoc` receives the doc text and `mission: MissionView | undefined`; its reload key is unchanged.
`entryMarks(scan, plan)` (T6) runs in `useMemo` on `[scan, mission.plan]`.
`DocView` gets a `useEffect` keyed on `[marks, sections]`: it walks the `h4` and `h5` elements under its body ref, parses each `textContent` with `parse_entry_heading`, and sets `data-entry`, `data-mark` and a `title` (`done 3 / 3`, `doing`, `partial 1 / 3`) on the ones that are entries.
A heading inside a fence renders as `<pre>`, not `<h5>`, so the walk is fence-safe; no markdown-it rule and no `PURIFY` change.
The effect re-runs after each `DocPart` re-render, so the marks survive a doc reload.
No change to the doc text; no change to the approval hash.

### T8. The drawer and the Log

`describe.ts` returns null for `mission.changed` and `agent.settled`.
One new `spinner` Log line: the seed line (T4).
The approval and `pr:` lines exist today.
No Goldfish Log line (D6).

### T9. Data shapes

```text
PlanItem               += entry: string | null
MissionItem            += entry: string | null
MissionItemRequest     += entry?: string                 (add only)
mission_plan tool args += entry?: string                 (ExtensionToolArgs and the schema)
DesignApproveResponse   = SessionResponse & { seed: SeedResult }   (api.ts, beside SessionResponse)
ROUTES["POST /sessions/:dir/design/approve"] = "DesignApproveResponse"
MissionWriter.rewrite(dir, author, (text) => text): Promise<void>
```

No new route.
No `session.yaml` change.
No change to the design doc file format.
An older daemon reads the token as text; an older UI shows the token in the item text and ignores `seed`.

### T10. Who builds

The Goldfish never write.
They are read-only reviewers in fresh contexts; their value is that they have not seen the conversation (`EA-T4`, `EA-D14`).
The build is done by session agents, as `EA-T10` and s037 set it: the operator approves, the lead's edit guard unlocks, the lead builds alone or adds one worker per owned area with `agent_add` and a brief that names the files the worker owns and must not edit, each worker ticks its items and writes Log lines, verification is the repo's checks and the Verification Plan, then the pipeline runs unchanged, and a doc change during the build invalidates the approval until the operator re-approves (`EA-D7`), at which point the seed re-runs (T4).

This design changes one step: the Plan arrives seeded and linked, so the lead assigns the items with `mission_plan assign` and splits an entry with `mission_plan add` and `entry` instead of retyping headings.
Two worker conventions the board depends on are written into the build message and the agent brief (T4): a worker's Roster `Doing` cell names `#id` so the item reads `doing` (D14), and an entry a worker cannot build as written is recorded under Open questions with the entry id.
Workers, briefs, the guard, the verification and the pipeline are otherwise unchanged.

A bounded builder per entry (a fresh pi process that takes one `[n.n]` item, builds it in a worktree, runs its tests, commits and exits, shown on the board as the item's owner) is a Future Improvement, not this round: it needs its own design for the worktree per builder, the merge and the failure path.

## Alternatives Considered

### Alternative A: Timeline (MISSION.md rendered from an event stream)

One feed replaces the Log, History, the Activity drawer and the job log; four tools (`log`, `decide`, `ask`, `progress`) replace the seven `mission_*` tools; the mission tab is removed.

*   **Pros**: One narration surface; progress is an event, not a hand-ticked line; the roster derives from the agents' last `progress`.
*   **Cons**: The daemon's bus holds no history (`event-bus.ts`), so an event store, a renderer and a migration of every session kind are new work; every agent brief since s001, the review sessions and the fixer assume the seven tools; a rollback needs a dual-write period that is unscoped; three to four build sessions.
*   **Reason for rejection**: All six brainstorm lenses rejected it; `EA-D6` refused the smaller migration (replace the Goal and Done when tools). The one surviving part, a persisted `log/events.jsonl`, is a Future Improvement.

### Alternative B: The done mark written into the doc file

A tick on the board writes `[x]` or a `(done)` tag beside the entry heading in `docs/designs/<feature>.md`, with an exemption in the approval hash.

*   **Pros**: The doc shows progress in the PR and in `git log`; no join between two files.
*   **Cons**: The hash strips only the `Status:` line (`derive-design.ts`); any other byte sets `changed_after_approval`, locks the lead's code writes and steers every agent with "the approval is invalidated". Six places need an exemption (the hash, `changed_sections`, `approved.md`, the watcher, the guard, the notice). The marks ship in the PR. An older daemon after a rollback locks every seeded session.
*   **Reason for rejection**: Five of six lenses called it a blocker. The Plan tick is the done state; the Draft tab draws it (D2).

### Alternative C: The done mark as daemon state in `session.yaml`

`design.progress: { "1.5": "done" }`, written on tick, drawn on the doc.

*   **Pros**: No doc write; no hash exemption.
*   **Cons**: A second store for a fact the Plan line already holds; two writers (the tick and the progress map) can drift; `session.yaml` grows by one key per entry.
*   **Reason for rejection**: One stored list, two renderings (Goals). The Plan tick is the state.

### Alternative D: No seed; link by reference only

The lead writes Plan items by hand, unchanged; the UI matches `n.n` mentions in item text against the doc's headings.

*   **Pros**: No daemon parser of the doc; no grain problem (the lead groups as it likes, as s037 did); nothing to re-key.
*   **Cons**: The board is not the doc's plan; the lead retypes up to 166 headings or groups them into a few items that hide which entries are done; a text edit erases the link.
*   **Reason for rejection**: K2 chose the seed with phases collapsed (L1 solves the grain). This alternative stays the fallback if operators report the grouped list is too long to scan.

### Alternative E: Seed one item per phase

The seed adds one item per `#### Build session N` heading; entries stay in the doc.

*   **Pros**: A six-item board for `egm-adoption.md`.
*   **Cons**: The lead retypes the entries it works on; the Draft tab cannot mark an entry done; a phase with 30 entries reads as one tick.
*   **Reason for rejection**: K2.

### Alternative F: A side file for the entry link (`design/plan-links.json`)

A daemon-owned map from item id to entry id with a heading hash.

*   **Pros**: The Plan line stays free text; the hash detects a renamed heading.
*   **Cons**: A second store for an item fact; an item deleted by hand leaves a stale link; the UI needs a second fetch; a rollback leaves a file the older daemon does not read.
*   **Reason for rejection**: K3. The token on the line is what an older daemon reads as text, and `PlanItem.entry` is what the UI reads.

### Alternative G: Two vocabularies, the stepper kept in the bar

Rename `mission` to Implement and keep `Brief · Design · Review · Files · History` as sub-tabs under a `design` view, with the stepper in the context bar opening the right sub-tab.

*   **Pros**: The smallest UI change; the stepper's fold rule is already built.
*   **Cons**: `Brainstorm · Draft · Review · Approve · Build` in the bar and `Brief · Design · Review · Implement · History` in the row are two names for five places; the word "Design" means four things on one screen; a first-time operator learns a mapping.
*   **Reason for rejection**: K4.

### Alternative H: Agent chips above every tab with a docked chat

The agent row hoisted above the tab row; the picked agent's chat docked beside any tab.

*   **Pros**: Who and talk-to-them are visible from every view; the gate card is drawn once, beside whatever the operator reads.
*   **Cons**: The tty terminals stay mounted in the Agents view so their sockets survive (`AgentsPane.tsx`); a dock beside every tab is a second mount or a layout rewrite of the agents pane; two of six lenses.
*   **Reason for rejection**: K1 for this round; kept as a Future Improvement.

### Alternative I: Fold Files into Draft

The Files tab's list of `<session>/design/` becomes an "other files" footer of the Draft tab.

*   **Pros**: One tab fewer.
*   **Cons**: Files is the direct track's landing tab and the home of drift reports (`EA-CUJ 12`); the direct track would need a new home for them.
*   **Reason for rejection**: K5.

### Alternative J: Refuse `mission_plan add` on the design track before approval

*   **Pros**: The board cannot hold items the doc does not have.
*   **Cons**: A direct-to-design track switch keeps the Plan the lead already wrote; the lead plans during the draft (this session's own Plan is an example); a refusal returns a 400 the agent must handle.
*   **Reason for rejection**: D3.

### Alternative K: Implement as the three-column board grouped by phase (layout Option A)

*   **Pros**: The smallest change (4 to 5 hours); status read by column, unchanged.
*   **Cons**: A phase is split across three columns; past about 40 open items the Next column is a scroll of cards under repeated headers; `egm-adoption.md` seeds 166.
*   **Reason for rejection**: L1. The operator chose the list that scales to the real doc.

### Alternative L: Implement as a split view, board left and the doc's plan right (layout Option C)

*   **Pros**: Spec and status read together without a tab switch.
*   **Cons**: The doc is fetched and rendered twice; the right pane is a copy of a Draft tab section, against the cohesion goal; needs about 1500 px with the previews pane; 166 entries is a long scroll beside a short board.
*   **Reason for rejection**: L1.

### Alternative M: An `entries` field on `DesignView`, scanned by the daemon

The daemon scans the doc on every `session.updated` and sends the phases and entries to the UI.

*   **Pros**: One scan per change, on one side; the UI needs no doc fetch for grouping.
*   **Cons**: The design tracker would read the whole doc on every file event; `DesignView` grows by up to 500 entries per session on every `session.updated`; the UI fetches the doc anyway for the goal block and the Draft tab.
*   **Reason for rejection**: D15. The scan is pure and bounded, and both sides call the same function.

### Alternative N: A seed route and a post-approval failure path

The seed runs after the approval record; a failure leaves the approval standing with `seed: null`, a `spinner` Log line and a `POST …/design/seed` route to re-run it (version 1 of this document).

*   **Pros**: The approval is recorded whatever the seed does.
*   **Cons**: Every seed failure is deterministic over the doc text the route reads before the record, so the route re-runs into the same failure; the lead gets a build message that says the Plan is seeded when it is empty; a 409 rule, a request type, a dialog button, route tests and an API section exist for a path with no scenario.
*   **Reason for rejection**: R1. The checks run before the record and refuse the approval, under the file's existing "refuse before any write" rule.

### Alternative O: A phase picker in the approve dialog

The dialog lists the phases with entry counts as checkboxes; `DesignApproveRequest.phases` seeds a subset (K2's second clause, version 1).

*   **Pros**: A 166-entry doc can be seeded one phase at a time.
*   **Cons**: No journey unchecks a phase; re-approval of an unchanged doc is allowed and the seed is idempotent, so "seed later" is one click; the dialog scans the doc itself and can drift from the daemon's scan; six plan touches for the field, its validation, the flat-entry rule and the header's counting rule.
*   **Reason for rejection**: R2. Phases collapse on Implement (L1); a picker is a Future Improvement.

### Alternative P: A third tab-row case for legacy sessions

A session without a `design` block shows `Agents · Implement · Threads · Services` (version 1).

*   **Pros**: No empty Files and History tabs.
*   **Cons**: `DesignFiles` and `DesignHistory` render an empty list without a `design` block today, so the third case saves nothing and the Goal text disagreed with the table.
*   **Reason for rejection**: R3.

--------------------------------------------------------------------------------

## Risks & Mitigations

| Risk | Mitigation or acceptance |
|---|---|
| A doc's plan headings do not match the grammar (`### Build session`, `#### 1.2.3`, a plan heading not ending in `Implementation Plan`): the scan finds zero entries. | The approval is refused with `no plan entries found under an Implementation Plan heading` (D11), so the operator sees it at the click, not after. The grammar is not widened (Q2). |
| A title ends in a parenthesis that `parse_item` would read as the owner. | The seed strips any trailing parenthetical and asserts the round-trip on every appended line (T2, T4); the fixture tests pin 1.25, 1.34 and 3.12. |
| A renumbered doc leaves items pointing at the wrong headings. | The seed compares titles and badges the rows `stale`; it never rewrites a token (T4, CUJ 5). The lead re-points with `mission_plan edit`. |
| The seeded Plan plus free items exceeds `ITEMS_MAX`, after which every `mission_*` call throws. | `seed_checks` refuses the approval when `existing + to add > 500` (T4). |
| The Log becomes a daemon event sink that every agent reads into context each turn. | One new line, the seed line; no Goldfish line (D6). |
| A direct-to-design switch hides a lead-written Goal behind `goalSource = "doc"`. | Accepted: the doc is the spec on the design track (`EA-D6`); the old Goal text stays in `MISSION.md` and is visible through the `source` toggle. |
| A free item that spans several entries (the s037 pattern) never marks those entries done. | Accepted and stated in the build message: the mark follows linked items only (D9); the lead ticks the seeded items or splits with `entry`. |
| The doc is edited between the approve dialog opening and the approval. | The dialog no longer scans the doc (R2); the daemon's scan at the click is the only one. |
| A worker forgets to name `#id` in its Roster `Doing` cell, so no row reads `doing`. | The fallback rule marks the owner's lowest unticked item `doing` while the owner is active (D14); the convention is in the build message and the brief (T10). |
| The rollback daemon shows `[1.5] …` as text and the old board. | Accepted (CUJ 9); no data migration either way. |

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Rollout and rollback.**
    No `session.yaml` key changes; no design doc format changes.
    The one file format change is the `[n.n]` token at the start of a Plan line, which the previous daemon reads as text and the previous UI shows as text (CUJ 9).
    The legacy `plan <id>:` prefix is read by the new daemon (CUJ 8).
    A rollback is a tag checkout and a daemon restart; no data migration either way.
*   **Bounds.**
    The scan reads at most 100 000 lines, 50 phases and 500 entries and throws past a bound (T2).
    `seed_checks` refuses the approval when the Plan would exceed `ITEMS_MAX` (500, the per-section total that `section_items` in `mission-sections.ts` asserts).
    A Plan line stays under `TEXT_LENGTH_MAX` (4 000 characters): a title is a heading line, not prose.
    The Implement view renders at most 500 rows; phases are collapsed by default, so the DOM holds one open phase's rows plus the headers.
*   **Performance.**
    The seed is one read of the doc and one write of `MISSION.md`, inside the approval request; for `egm-adoption.md` (2 100 lines, 166 entries) it is under 50 ms on the daemon's clock, measured in `seed-plan.test.ts` as an upper bound of 500 ms so the test does not flake.
    The agents pane fetches the doc once per reload key (a design file or the doc path changed), not per `mission.changed`: during a build, agents write the Log and Roster every few seconds, and none of those writes refetches the doc (D15).
    The UI scans the doc in `useMemo` keyed on the doc text; the groups and marks recompute in `useMemo` on `[scan, mission.plan]`.
    `mission.changed` carries the whole `MissionView`, unchanged; no extra round trip for a tick.
*   **Safety of the doc.**
    The build never writes the doc.
    The approval hash is unchanged.
    The seed's doc read is the same read `approve_design` makes; a missing doc is the existing 409.
*   **Security and privacy.**
    No new network surface: no new route; the approve response gains the seed counts.
*   **Accessibility.**
    The row keeps `role="tablist"` and `aria-selected`; a step mark is a `title` and an `aria-label` on the tab, not colour alone.
    A phase header is a `button` with `aria-expanded`; a rail chip is a `button` with the agent's state in its accessible name.

--------------------------------------------------------------------------------

### Additional Resources

*   `design/concepts_brief.md` (this session): the brainstorm's brief from six Goldfish reports; `design/brainstorm_*.md` are the reports; `design/side_by_side.md` compares the three shapes.
*   [`docs/designs/egm-adoption.md`](egm-adoption.md): the EGM harness design; cited as `EA-D1` to `EA-D15`, `EA-CUJ 1` to `EA-CUJ 13`, `EA-T1` to `EA-T14`.
*   `docs/SESSION_PROTOCOL.md`: the editing rules of `MISSION.md` and the tools.
*   `docs/DAEMON_API.md`: the routes and the `item` mode.
*   `docs/sessions/s037-MISSION.md`: 23 entries built as 6 items.
*   EGM, [github.com/google/elephant-goldfish-model](https://github.com/google/elephant-goldfish-model), the pinned checkout under `~/.spinner/egm/`.
*   `design/consolidated_review_report.md` and `design/goldfish_review_report.md` (this session): the review's 118 findings and how version 2 answered them.

### Future Improvements

*   **Write the ticks into the doc at `create PR`**: a one-shot pass that marks each entry done in the doc before the PR is opened, so the PR shows progress; it runs after the build, so the approval lock does not matter.
*   **A persisted per-session event store** (`log/events.jsonl`): if History and the drawer still overlap after the trims of T8.
*   **Agent chips above every tab with a docked chat** (Alternative H): once the agents pane's terminals can mount outside the Agents view.
*   **Link by reference as the fallback** (Alternative D): if operators report the grouped list is too long to scan, the seed becomes optional and the UI matches `n.n` mentions.
*   **A phase picker in the approve dialog** (Alternative O): if a session wants to seed one phase at a time.
*   **A Goldfish Log line** when a run settles: needs a writer and a cost source in the watcher and a persisted once-rule (review M-6).
*   **The rail's agent state from one derived field**: the daemon could send `agent_state` per agent so the UI stops deriving it from four facts (D14).
*   **Automatic re-key of stale items** by title within a phase, if renumbering mid-build proves common; today the seed detects and the lead re-points (T4).
*   **A bounded builder per entry** (T10): a fresh pi process per `[n.n]` item, visible on the board as its owner; needs its own design.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

Two build sessions.
Build session 1 is the engine: the shared scan, the token, the seed, the routes, the tool and the docs; it ships with the old UI, which shows the token as text.
Build session 2 is the UI: the row, the Implement view, the marks, the dialog and the drawer trim.
Each entry names the file, whether it is created, modified or deleted, and what changes and why.
A path is relative to the repo root.

### Target Files to Create/Modify

#### Build session 1: the engine

##### 1.1 `packages/protocol/src/plan-entries.ts` (Create)

*   **Type / Scope**: TypeScript module, pure, shared by the daemon and the UI.
*   **Proposed Changes**: `headings(text: string, lines_max: number): { level: number; text: string; line: number }[]`, the one fence-aware heading walker of T2 (D8).
    `scan(doc: string): PlanScan` per T2 over `headings`: the plan section, the phases, the entries, the duplicates, the empty titles, the bounds, the three title strips.
    `parse_entry_heading(text: string): PlanEntry | null` applies the T2 step 3 rule to one heading text; `scan` uses it, and the UI uses it on a rendered heading (2.12).
    `parse_entry_token(text: string): { entry: string | null; rest: string }` and `render_entry_token(entry, rest)` per T3, so the daemon's `parse_item` and the UI share one token rule.
    `is_entry_id(text: string): boolean` for the writer's validation.
    Constants `DOC_LINES_MAX`, `PHASES_MAX`, `ENTRIES_MAX`, `ENTRY_TOKEN_MAX = 16`.
    Throws `Error` on the bounds and on an empty `entry.id`; no `node:assert`, because `@spinner/protocol` is imported by the browser UI and has no runtime dependencies.

##### 1.2 `packages/protocol/src/plan-entries.test.ts` (Create)

*   **Type / Scope**: Unit test (vitest).
*   **Proposed Changes**: The fixtures of T2: `docs/designs/egm-adoption.md` read from the repo (6 phases, 166 entries, first `1.1`, last `6.23`; from it, 1.25 gives title `` `packages/pi-extension/src/tty.ts` `` and kind `Modify`, 1.34 gives kind `Create`, 3.12 gives kind `Modify`), the flat `#### 1.` layout, the `## Implementation Plan` synonym, a fenced heading, a two-path heading, a `**[D7]**` heading, a heading whose title strips to empty (reported in `empty_titles`), no plan section, 501 entries (throws), a duplicate id.
    Token tests: `[1.5] text`, `plan 1.5: text` (legacy), `[D7] text` (not a token), a 17-character bracket (not a token).

##### 1.3 `packages/protocol/src/api.ts` (Modify)

*   **Type / Scope**: TypeScript types.
*   **Proposed Changes**: `PlanItem.entry: string | null` with a comment that names the token and the legacy prefix.
    `DesignApproveResponse = SessionResponse & { seed: SeedResult }` beside `SessionResponse` (not in `egm.ts`, which `api.ts` imports; a type cycle is avoided).
    `ROUTES["POST /sessions/:dir/design/approve"]` becomes `"DesignApproveResponse"`.

##### 1.4 `packages/protocol/src/extension.ts` (Modify)

*   **Type / Scope**: TypeScript types and the tool schemas.
*   **Proposed Changes**: `MissionItemRequest.entry?: string` (`add` only); `ExtensionToolArgs["mission_plan"].entry?: string`.
    The `mission_plan` tool schema gains `entry` (`string`, "the doc entry this item belongs to, `2.3`; add only") and its description names the token.

##### 1.5 `packages/protocol/src/extension.test.ts` (Modify)

*   **Type / Scope**: Unit test.
*   **Proposed Changes**: A new assertion (the file has only generic manifest checks today): `expect(Object.keys(tool("mission_plan").parameters)).toContain("entry")`, and the `ROUTES` table names `DesignApproveResponse` for the approve route.

##### 1.6 `packages/protocol/src/egm.ts` (Modify)

*   **Type / Scope**: TypeScript types.
*   **Proposed Changes**: `SeedResult` per T4 (`doc_path`, `sha12`, `added`, `kept`, `stale`, `orphaned`).
    `DesignApproveRequest` is unchanged (no `phases`, R2).

##### 1.7 `packages/protocol/src/index.ts` (Modify)

*   **Type / Scope**: Barrel.
*   **Proposed Changes**: Export `plan-entries.ts`; the header comment ("types, constants and the JSON schema … and nothing else") is updated to name the pure runtime helpers the package holds (`diff.ts`, `plan-entries.ts`).

##### 1.8 `packages/daemon/src/pipeline/mission-sections.ts` (Modify)

*   **Type / Scope**: TypeScript module, pure.
*   **Proposed Changes**: `MissionItem.entry: string | null`.
    `parse_item` calls `parse_entry_token` on the text after the owner parenthesis is removed, on every checklist line, so `[1.5] text (engine)` gives `entry: "1.5"`, `text: "text"`, `owner: "engine"`; the legacy `plan 1.5: text` gives the same.
    `render_item` writes the token first.
    `parse_plan` passes `entry` through to `PlanItem`; `parse_done_when` ignores it (T3).
    The existing forms without a token are unchanged.

##### 1.9 `packages/daemon/src/pipeline/mission-view.test.ts` (Modify)

*   **Type / Scope**: Unit test.
*   **Proposed Changes**: `parse_item` and `render_item` round-trip the token; the legacy prefix parses and renders as the token; `mission_view` carries `entry`; a line `- [ ] 4. [D7] fix` has `entry: null`.

##### 1.10 `packages/daemon/src/store/mission-writer.ts` (Modify)

*   **Type / Scope**: TypeScript module.
*   **Proposed Changes**: `validate_item` refuses `entry` on a command other than `add` and an `entry` that fails `is_entry_id`.
    `apply_item` `add` sets `entry` from the request; `edit` keeps `target.entry` unless the new text starts with a token, in which case `entry` is set to that token and the token is stripped from the text.
    `MissionWriter.rewrite(dir, author, (text) => text): Promise<void>` is added: it runs after every earlier write on the session, reads `MISSION.md`, applies the function, writes the file, records the last write and publishes one `mission.changed` with the view (the body of `serialized` plus the read and the write); `serialized` stays for its one caller.
    `PLAN_PLACEHOLDER` and `write_items` are exported for the seed (1.12).
    `tick`, `assign` and `reorder` are unchanged; they go through `render_item`.

##### 1.11 `packages/daemon/src/store/mission-writer.test.ts` (Modify)

*   **Type / Scope**: Unit test.
*   **Proposed Changes**: `add` with `entry` renders the token; `edit` keeps it; `edit` with a new token sets `entry` to the new token and strips it from the text; `tick` keeps it; `entry` on `tick` is refused; `entry: "x"` is refused; `rewrite` applies a function, writes the file and publishes one `mission.changed`.

##### 1.12 `packages/daemon/src/egm/seed-plan.ts` (Create)

*   **Type / Scope**: TypeScript module, pure.
*   **Proposed Changes**: `seed_checks(mission_text, scan): string | null` per T4: the refusal reason or null.
    `seed_plan(mission_text, scan): SeedResult & { mission_text }` per T4 (the five steps, the counters, stale and orphan detection, no token rewritten).
    The seed renders every Plan item through `render_item` and keeps non-item lines as `write_items` does, using `PLAN_PLACEHOLDER` and `write_items` from 1.10 (so legacy prefixes become tokens and the placeholder is removed).
    `seed_log_line(doc_path, result)` renders the Log line.
    Post-condition per T4 step 4: every appended line round-trips through `parse_item` with `owner === null` and `text === entry.title`, else throw.
    Assertions: the result's item count equals the input count plus `added`; no ticked item lost its tick (checked by re-parsing the output).

##### 1.13 `packages/daemon/src/egm/seed-plan.test.ts` (Create)

*   **Type / Scope**: Unit test.
*   **Proposed Changes**: First seed of 23 entries into an empty Plan and into a Plan with 2 free items (ids continue); a second run adds nothing; a renumbered doc marks the shifted items `stale` and adds the new last entry; a doc where five entries share a title does not confuse the detection; a dropped entry is orphaned and kept; the 166-entry fixture seeds with `owner === null` on every line, checked by re-parsing; 1.25, 1.34 and 3.12 seed with their stripped titles; an empty title refuses the doc (`seed_checks`); a flat doc seeds under no phase; a doc with duplicates is refused (`seed_checks`); a Plan that would exceed `ITEMS_MAX` is refused (`seed_checks`); the placeholder `- [ ] 1. ` is removed; a legacy `plan 1.5:` line becomes `[1.5]`; a ticked item keeps its tick and owner; owner is `null` on every added item; the 166-entry fixture seeds under 500 ms.

##### 1.14 `packages/daemon/src/egm/approve.ts` (Modify)

*   **Type / Scope**: TypeScript module.
*   **Proposed Changes**: Run `scan(text)` and `seed_checks` with the current Plan right after the doc is read and before the status rewrite; throw `ApproveRefusal(reason, null)` on a reason, so the route answers 409 and nothing is written.
    After the record, call `deps.writer.rewrite(dir, SPEC_AUTHOR, (mission) => seed_plan(mission, scan).mission_text)` and write the seed Log line after the approval Log line.
    `approve_design` returns `{ summary, seed }`; the route reads `seed` into the response.
    `build_message(doc_path, sha256, seed)` says the Plan holds one item per entry, names the token, the `entry` argument of `mission_plan add`, the tick rule, the `#id` Roster convention and the Open-questions rule for an unbuildable entry (T4, T10); the "add one item per entry" sentences are removed.
    `count_listed_blockers` uses `headings` from `@spinner/protocol`; the private `headings_of` and `REPORT_LINES_MAX` are removed.
    The header comment drops "the daemon does not parse the doc's plan (review B1)" and names T2.

##### 1.15 `packages/daemon/src/egm/approve.test.ts` (Modify)

*   **Type / Scope**: Unit test.
*   **Proposed Changes**: The build message names the token, the `#id` convention and the Open-questions rule, and not "add one Plan item per"; the existing assertion at line 98 (`plan <id>: <heading text>`) is replaced.
    `count_listed_blockers` keeps its cases through the shared walker.
    The approval flow tests (seed, refusal, Log lines) live in `routes.test.ts` (1.17), as this file's header says.

##### 1.16 `packages/daemon/src/egm/routes.ts` (Modify)

*   **Type / Scope**: Hono routes.
*   **Proposed Changes**: The approve route answers `DesignApproveResponse` with `seed` from `approve_design`.
    No new route (R1).

##### 1.17 `packages/daemon/src/egm/routes.test.ts` (Modify)

*   **Type / Scope**: Route test.
*   **Proposed Changes**: An approval seeds the Plan (owner `null`, tokens) and writes two Log lines; the response carries `seed` with the counts; a doc with duplicate ids, an empty title or no entries is refused with 409 and nothing is recorded; a Plan that would exceed `ITEMS_MAX` is refused; the existing assertion at line 849 (`mission_plan add`) stays true with the new build message.

##### 1.18 `packages/daemon/src/egm/goldfish.ts` (No change)

*   **Type / Scope**: TypeScript module.
*   **Proposed Changes**: None. The Goldfish Log line of version 1 is dropped (D6, review M-6); the entry is kept so the numbering of the Plan items stays stable.

##### 1.19 `packages/daemon/src/egm/goldfish.test.ts` (No change)

*   **Type / Scope**: Unit test.
*   **Proposed Changes**: None (see 1.18).

##### 1.20 `packages/pi-extension/src/tools.ts` (Modify)

*   **Type / Scope**: pi tools.
*   **Proposed Changes**: `item_request` reads `entry` (trimmed, non-empty) into the request.

##### 1.21 `packages/pi-extension/src/lead.test.ts` (Modify)

*   **Type / Scope**: Unit test (the `mission_plan` tests live here, lines 219 to 236; `extension.test.ts` covers the worker and fixer roles only).
*   **Proposed Changes**: `mission_plan add` with `entry` posts `item.entry`.

##### 1.22 `packages/daemon/src/store/brief-template.ts` (Modify)

*   **Type / Scope**: Text template.
*   **Proposed Changes**: The lead's brief says the Plan is seeded at approval, names the token and the `entry` argument for a split, and drops the sentence that the build message tells the lead to fill the Plan.
    The worker brief gains the two conventions of T10: the Roster `Doing` cell names `#id`; an entry that cannot be built as written is recorded under Open questions with its id.

##### 1.23 `docs/SESSION_PROTOCOL.md` (Modify)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**: Line 251 ("add one Plan item per `##### n.n` entry") becomes the seed; the Plan row of the sections table (line 316) names the token, that `entry` is kept across `edit`, and relaxes "every item names one owner" for seeded items (owner `null` until assigned); the tools paragraph names `entry` on `mission_plan add`; a dated protocol decision entry is added (the file requires one before code follows a protocol change, line 587): `PlanItem.entry`, `MissionItemRequest.entry`, the `[n.n]` Plan-line form, `DesignApproveResponse.seed`, `MissionWriter.rewrite`.

##### 1.24 `docs/DAEMON_API.md` (Modify)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**: `POST …/design/approve` answers `DesignApproveResponse` (the routes table and the EGM section); the T10 steps list gains the seed checks and the seed write; line 383 ("The daemon does not parse the doc's plan.") is replaced by the scan; the `item` mode section names `entry`; the `plan[]` row of the mission view table (line 573) gains `entry`.

##### 1.25 `packages/ui/fixture/mission-view.ts` (Modify)

*   **Type / Scope**: UI fixture daemon (TypeScript); included in the UI package's `tsconfig`, so it must compile in build session 1.
*   **Proposed Changes**: `PlanItem` literals gain `entry`; the fixture's `parseItem`, `renderItem` and `applyItem` read and write the `[n.n]` token with `parse_entry_token` and `render_entry_token` from `@spinner/protocol`, so an `edit` against the fixture keeps the token as the daemon does.

##### 1.26 `packages/daemon/src/agents/lead.test.ts` (Modify)

*   **Type / Scope**: Unit test.
*   **Proposed Changes**: The `toEqual` on the Plan item at line 291 gains `entry: null`, so `pnpm -r test` stays green in build session 1.

#### Build session 2: the UI

##### 2.1 `packages/ui/src/design-workspace.ts` (Modify)

*   **Type / Scope**: TypeScript module, pure.
*   **Proposed Changes**: `VIEW_IDS`, `TAB_LABELS` (Title case) and `viewTabs(view)` with the two cases of T5; `defaultView(view)`; `shownView` falls back to `defaultView`; `stepTab` defined for all five steps per D12 and returning a view id; `tabMarks(steps, design)` per T5 (the Review rule, the tooltips from `stepTitle`, the suffixes); `reloadKey(dir, design)` unchanged.
    `WORKSPACE_TABS`, `WorkspaceTab` and `defaultTab` are removed.
    `docSections`, `outline`, `stageRows`, `roundRows`, `approvalRows` are unchanged.

##### 2.2 `packages/ui/src/design-workspace.test.ts` (Modify)

*   **Type / Scope**: Unit test.
*   **Proposed Changes**: `viewTabs` for the design track, the direct track and a session without a `design` block (the last two equal); `defaultView`; `stepTab` for all five steps; `tabMarks` at `design-ready` (Review shows Approve's state), at `design-review` (Review active with `n/5`), at `approved` (Implement active); `shownView` of a view the session lacks; the reload key does not change when only the mission revision changes.

##### 2.3 `packages/ui/src/ViewTabs.tsx` (Modify)

*   **Type / Scope**: React component.
*   **Proposed Changes**: The props become `tabs: { id: string; label: string }[]`, `shown: id`, `onSelect(id)`; `ReviewPane` and `PreviewPane` pass `id === label`.
    `marks?: Record<id, { state: StepState; title: string; suffix?: string }>` draws a dot before the label (with `aria-label`) and the tooltip; `fold?: { ids: string[]; label: string; opens: id }` folds the listed tabs into one tab with a menu when the row overflows.
    `useRowFold(ref)` is added here: the hysteresis of `useBarFold` with the measured element being the `.view-tabs` row (`scrollWidth > clientWidth`), not the context bar.

##### 2.4 `packages/ui/src/DesignStepper.tsx` (Delete)

*   **Type / Scope**: React component.
*   **Proposed Changes**: Deleted, with `useBarFold`, `useCompact`'s stepper use and `RunningFish`; the fold rule is re-created in 2.3 and the running count becomes a tab suffix (T5); the labels stay in `design.ts`.

##### 2.5 `packages/ui/src/DesignWorkspace.tsx` (Delete)

*   **Type / Scope**: React component.
*   **Proposed Changes**: Deleted; the five sub-tab bodies become views in 2.7.

##### 2.6 `packages/ui/src/PaneHead.tsx` (Modify)

*   **Type / Scope**: React component (context bar).
*   **Proposed Changes**: The `DesignStepper` branch is removed; every session shows the stage badge; the `onStep` prop is removed from `ContextBar` and from its call in `App.tsx`.

##### 2.7 `packages/ui/src/AgentsPane.tsx` (Modify)

*   **Type / Scope**: React component.
*   **Proposed Changes**: Renders `DesignBrief`, `DesignDoc`, `DesignReview`, `DesignFiles`, `DesignHistory` and `MissionWorkspace` by view id; `ViewTabs` gets `tabMarks` and the fold; the props `designTab` and `onDesignTab` are removed; the props `onOpenAgent(name)` and `onOpenView(id)` are added and passed to the views that open another view or agent (2.10, 2.11, 2.19).
    The pane fetches the doc once with `fetchDesignDoc` keyed on `reloadKey` when `design.doc` is set (D15) and passes `docText` to `DesignDoc` and `MissionWorkspace`; `DesignDoc`'s own fetch is removed.
    The Agents view's terminals and chips are unchanged.

##### 2.8 `packages/ui/src/App.tsx` (Modify)

*   **Type / Scope**: React component.
*   **Proposed Changes**: `designPick` and `openDesign` are removed; `onRound` sets the shown view to `history`; the initial `agentsShown` is `defaultView(view)` per session (a map by `dir`, as `designPick` was), including the view set for a session created from a paste (line 205 sets `"agents"` today); `openCard` is unchanged; `onOpenAgent` sets the view to `agents` and the picked agent; the `onStep` prop to `ContextBar` is removed (2.6).

##### 2.9 `packages/ui/src/DesignGate.tsx` (Modify)

*   **Type / Scope**: React component.
*   **Proposed Changes**: A `compact` prop renders one line instead of the card: `The lead asks: <first 120 characters> → answer in Agents` for a gate, `Findings to resolve → open Agents` for the resolve card; a click calls `onOpenAgent("lead")`. The data path (`gateCard`) is unchanged; no new file.

##### 2.10 `packages/ui/src/DesignBrief.tsx` (Modify)

*   **Type / Scope**: React component.
*   **Proposed Changes**: Renders `DesignGate` with `compact` (K1); the `EGM` attribution lives on the Brainstorm tab's tooltip (T5), not here (the component has no heading).

##### 2.11 `packages/ui/src/DesignReview.tsx` (Modify)

*   **Type / Scope**: React component.
*   **Proposed Changes**: The resolve `DesignGate` becomes `compact`; a header with the `approve` primary (`ApproveDesign` dialog) when the stage is `design-ready` or `changed_after_approval`.

##### 2.12 `packages/ui/src/DesignDoc.tsx` (Modify)

*   **Type / Scope**: React component.
*   **Proposed Changes**: Props `text: string` (from 2.7) and `mission: MissionView | undefined`; the component's own `useLoaded` fetch is removed; `scan(text)` and `entryMarks(scan, mission.plan)` in `useMemo`; a `useEffect` on `DocView` keyed on `[marks, sections]` walks the `h4` and `h5` elements under the body ref, parses `textContent` with `parse_entry_heading`, and sets `data-entry`, `data-mark` and `title` (`done 3 / 3`, `doing`, `partial 1 / 3`) per T7.

##### 2.13 `packages/ui/src/markdown.ts` (No change)

*   **Type / Scope**: markdown-it setup.
*   **Proposed Changes**: None. Version 1's heading rule is replaced by the DOM walk in 2.12 (review M-10); DOMPurify keeps `data-*` attributes by default, so no `PURIFY` change either. The entry is kept for the numbering.

##### 2.14 `packages/ui/src/markdown.test.ts` (No change)

*   **Type / Scope**: Unit test.
*   **Proposed Changes**: None (see 2.13).

##### 2.15 `packages/ui/src/implement.ts` (Create)

*   **Type / Scope**: TypeScript module, pure.
*   **Proposed Changes**: `goalSource(design)`, `goalParagraph(text)` (the first paragraph of `## Overview` through `docSections`), `phaseGroups(plan, scan | null)`, `implementState(design, scan, plan)`, `headerText`, `railState(spec, hosted, blocked, needs)` wrapping `agentState` from `AgentsPane.tsx`, `entryMarks(scan, plan)` returning `{ state, done, total }` with `doing` over `partial` (D9), per T6 and T7, with their types `PhaseGroup`, `PlanRow` (`stale`, `orphan` flags), `RailChip`.

##### 2.16 `packages/ui/src/implement.test.ts` (Create)

*   **Type / Scope**: Unit test.
*   **Proposed Changes**: `phaseGroups` with 3 phases, free items, an orphan, a stale item, a flat doc (one `Plan` group) and no doc; the sort inside a group; which group opens; `implementState` for the three states and the header text; `railState` for each of the five states; `entryMarks` for none, doing, partial, done, an entry with one ticked and one doing item (`doing`), and an entry with no linked item; `goalSource` by track; `goalParagraph` on a doc with and without an Overview.

##### 2.17 `packages/ui/src/ImplementView.tsx` (Create)

*   **Type / Scope**: React component.
*   **Proposed Changes**: The layout of T6: `GoalBlock` (the Overview's first paragraph, clamped, or the editable goal), `Header` (sticky; `Pulse` extended with the entry counts; the `doing` filter), `PlanList` with `PhaseSection` rows (collapsible, `aria-expanded`; `stale` and `orphan` badges), `RosterRail` with live dots (`chip-*` classes), Questions and Contracts in the rail, `LogFeed` full width, `DoneWhen` when `goalSource` is `mission`.
    Reuses `Item`, `EditableText`, `LogFeed`, `Questions`, `Contracts`, `DoneWhen`, `RosterChip`, `Pulse`, `useArrivals`, `isBlocked`, `AgentOrder` and the `RowContext` type from 2.18.
    Props: those of `MissionWorkspaceViewProps` plus `docText: string | null`, `design: DesignView | undefined`, `agentsRunning: readonly string[]`, `agentSpecs: Record<string, AgentSpec>`, `needs: string | null`, `onOpenAgent`, `onOpenView`.

##### 2.18 `packages/ui/src/MissionWorkspaceView.tsx` (Modify)

*   **Type / Scope**: React component.
*   **Proposed Changes**: `MissionWorkspaceView`, `PlanBoard`, `PLAN_COLUMNS` and `GoalCard` are removed; `Pulse` gains a `counts` prop (entries done, in progress) and is kept; `Item`, `EditableText`, `LogFeed`, `Questions`, `Contracts`, `DoneWhen`, `RosterChip`, `Pulse`, `useArrivals`, `isBlocked`, `AgentOrder` and the `RowContext` interface are exported for 2.17.
    The header comment names `ImplementView` as the view.

##### 2.19 `packages/ui/src/MissionWorkspace.tsx` (Modify)

*   **Type / Scope**: React component (data and writes).
*   **Proposed Changes**: New props `view: SessionView`, `docText: string | null` (from 2.7), `onOpenAgent`, `onOpenView`; renders `ImplementView` with `design`, `agentSpecs` (`view.summary.session.agents`), `agentsRunning`, `needs` (`needsHuman(view)`) and the callbacks; the `source` toggle (raw `MISSION.md` behind the view) stays.

##### 2.20 `packages/ui/src/mission-workspace.css` (Modify)

*   **Type / Scope**: CSS.
*   **Proposed Changes**: `.mw-board` and `.mw-column*` are removed; `.im-grid` (main plus rail, rail under the main below 900 px of pane width), `.im-header` (sticky), `.im-phase`, `.im-row`, `.im-dot-{next,doing,done}`, `.im-stale`, `.im-orphan`, `.im-rail` are added; the rail chips use the existing `chip-*` classes plus `chip-blocked` and `chip-needs-you`; the tick animation class stays.

##### 2.21 `packages/ui/src/styles.css` (Modify)

*   **Type / Scope**: CSS.
*   **Proposed Changes**: `.egm-stepper`, `.egm-step`, `.egm-step-mark`, `.egm-dots`, `.egm-dot`, `.egm-fish`, `.egm-label`, `.egm-sep`, `.egm-compact`, `.egm-pipeline` (lines 230 to 257) are removed; `.view-tab-mark`, `.view-tab-suffix`, `.view-tab-fold` are added; the `.dw-*` rules stay for the views that moved.

##### 2.22 `packages/ui/src/ApproveDesign.tsx` (Modify)

*   **Type / Scope**: React component.
*   **Proposed Changes**: Shows the seed counts from the response (`23 added, 2 kept, 0 stale, 0 orphaned`) for one second before closing, or at once when `build` is off; a 409 from the seed checks shows its text as the other refusals do. No phase picker, no doc fetch, no seed button (R1, R2).

##### 2.23 `packages/ui/src/remote.ts` (Modify)

*   **Type / Scope**: Fetch helpers.
*   **Proposed Changes**: `postDesignApprove` returns `DesignApproveResponse`.

##### 2.24 `packages/ui/src/describe.ts` (Modify)

*   **Type / Scope**: TypeScript module, pure.
*   **Proposed Changes**: `mission.changed` and `agent.settled` return null (D6).

##### 2.25 `packages/ui/src/describe.test.ts` (Create)

*   **Type / Scope**: Unit test (`activity-drawer.test.ts` tests `ActivityDrawer.tsx`, not `describe.ts`).
*   **Proposed Changes**: `mission.changed` and `agent.settled` give no line; `job.finished` still does.

##### 2.26 `packages/ui/src/SessionsPane.tsx` (Modify)

*   **Type / Scope**: React component.
*   **Proposed Changes**: No change.
    The card's `CardDots` and their `stepperText` tooltip stay as they are; the entry is listed so the implementer does not look for a step label here.

##### 2.27 `docs/DAEMON_API.md` (Modify)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**: "The mission view" section (line 562) gains one paragraph: the Implement view groups the Plan by the doc's phases through `PlanItem.entry`, and the goal block's source by track; the workspace paragraph at line 357 names the views of the agents pane in place of the design sub-tabs. The file does not describe the stepper; nothing else changes.

##### 2.28 `docs/designs/SITEMAP.md` (Modify)

*   **Type / Scope**: Documentation index.
*   **Proposed Changes**: A row for this design (done at finalization, before build session 1).

##### 2.29 `packages/ui/fixture/design.ts` (Modify)

*   **Type / Scope**: UI fixture daemon.
*   **Proposed Changes**: `POST …/design/approve` answers `DesignApproveResponse` with a `seed` computed by `scan` and `seed_plan`'s counting over the fixture doc and the fixture Plan.

##### 2.30 `packages/ui/fixture/data.ts` (Modify)

*   **Type / Scope**: UI fixture data.
*   **Proposed Changes**: A design-track session whose Plan is seeded (three phases, two free items, one stale and one orphan item), for the Implement flows of the driver.

##### 2.31 `packages/ui/e2e/drive.ts` (Modify)

*   **Type / Scope**: E2E driver.
*   **Proposed Changes**: The `workspace` flow asserts the Implement list (`.im-phase`, `.im-row`, the sticky header) instead of `.mw-column`; `design-stepper` becomes a `view-tabs` flow that asserts the step marks and the fold; `design-workspace`, `design-gate` and `approve-design` target the views by tab id, the compact gate line, and the dialog's seed counts; the view-tab text assertions (`["agents","design","mission",…]`) become the Title-case rows of T5.

### Verification Plan

*   **Compilation/Build**: `pnpm -r build` at the root; both sessions.
*   **Unit Tests**: `pnpm -r test`.
    Build session 1 adds `plan-entries.test.ts`, `seed-plan.test.ts` and the modified daemon, protocol and extension tests; the `egm-adoption.md` fixture must count 166 entries and 6 phases.
    Build session 1 ends with `pnpm -r build`, `pnpm -r test` and `pnpm typecheck` green with the UI package included (1.25, 1.26), the old UI showing the token as text.
    Build session 2 adds `implement.test.ts` and the modified UI tests.
*   **Static Analysis & Linting**: `pnpm lint` and `pnpm typecheck` at the root, zero warnings.
*   **Docs**: `python3 tools/doc-metrics.py --fail` after each session (it skips `docs/designs/`).
*   **E2E (manual, build session 1)**: Approve a design-track session with a doc of 3 phases; the Plan gains the items with owner `null`; the Log shows the two `spinner` lines; a doc with a duplicate id is refused with 409 and nothing is recorded; `mission_plan add` with `entry` from the lead's terminal renders the token; `mission_plan edit` keeps it; the previous tag's daemon opens the session and shows the token as text (CUJ 9).
*   **E2E (manual, build session 2)**: CUJ 1, 3, 4, 6, 7, 8 and 10 on a real session; the row folds in a 1000 px window; a tick on Implement moves the Draft tab's mark without a reload; a direct-track session opens on Implement with no EGM tabs.
*   **E2E (driver, build session 2)**: the flows `workspace`, `view-tabs`, `design-workspace`, `design-gate` and `approve-design` of `packages/ui/e2e/drive.ts` pass against the fixture (2.29 to 2.31).
*   **Size**: Build session 1 engine about 6 hours; build session 2 UI about 10 hours.
    If build session 2 overruns, 2.3's fold and then the `doing` filter chip of 2.17 are the items to cut to a follow-up, in that order; neither blocks the others.

--------------------------------------------------------------------------------

## Build findings

Both build sessions ran in Spinner session s046 on 2026-11-05, in one worktree, by two workers (`engine`, `ui`) under the lead.
Commits on `feat/session-workspace`: `a43e417` (1.1 to 1.7), `ec2e7ec` (1.8 to 1.11), `d6a8c2a` (1.12, 1.13), `22a41a5` (1.14 to 1.19), `252da37` (1.20 to 1.22, 1.25, 1.26), `d12066e` (1.23, 1.24), `824553c` (2.1 to 2.11, 2.21, 2.24, 2.25), `2e6d758` (2.12, 2.15 to 2.20), `12cb787` (2.22, 2.23, 2.29, 2.30), `14d062a` (2.31), `a1d41aa` (2.27).
Root checks at `a1d41aa`, run by the lead with `npm_config_reporter` and `SLACK_USER_TOKEN` unset: `pnpm -r build` exit 0; `pnpm typecheck` exit 0; `pnpm lint` exit 0; `pnpm -r test`: protocol 48, desktop 69, pi-extension 28 passed; ui 262 passed and 1 failed; daemon 457 passed and 1 failed.
The two failures reproduce on the untouched primary checkout at `1f93186` from the same environment: `fixture/server.test.ts` `GET /costs` (a date boundary at this hour) and `agents.test.ts` "gives a lead the EGM spawn" (it asserts a spawned worker's env lacks `PI_SUBAGENTS_TEMP_ROOT`, which the lead's own pi process exports and the test inherits).
Neither is a regression of this design.

Built variants, each the smallest faithful one:

1.  1.12: `seed_plan` returns the counts and the new mission text (`SeedCounts & { mission_text }`); `approve.ts` adds `doc_path` and `sha12` to make the `SeedResult`, since the pure function has no use for them.
2.  1.12, T4 step 3: the stale test is per entry over `by_entry`: an entry is stale when none of its linked items carries its title, so a split item from CUJ 4 does not read stale at re-approval.
3.  1.14: a scan past its bounds (501 entries) is a 409 with the scan's message, not a 500.
4.  2.15: `agentState` moved to `agent-view.ts` (pure) and is re-exported from `AgentsPane.tsx`, so `implement.test.ts` does not import the terminals under vitest's node environment; `railState`'s fourth argument is a boolean from `needsAgent(needs_human, name)`, because `AgentSpec` carries no name.
5.  2.29: the fixture seeds through a host rewrite with its own `seedPlan` counting; `seed_plan` stays the daemon's.
6.  2.31: a legacy session's `?pane=agents` route opens on Implement (D5), so the driver clicks Agents first.
7.  2.22: the approve dialog opened from the Review header or the Draft banner outlives its button, because `session.updated` unmounted it before the counts showed; the compact gate line drops `*` and `` ` `` marks (found by the driver flows).

Findings for the harness and the protocol, outside this design:

1.  `agent_add` starts a worker's process but sends no first prompt; the operator had to message `engine`. The lead steered `ui` right after adding it. Follow-up: the daemon prompts a new agent to read its brief and `MISSION.md`.
2.  The worker role has no `mission_plan` tool, so a worker cannot tick its own items; the lead ticked all 56 after verifying. Follow-up: give workers `tick` and `untick` on their own items, as T10 assumes.
3.  With `seed_links`, a worktree's `packages/*/node_modules` are symlinks into the primary checkout, so `@spinner/protocol` resolved to the primary's stale `dist` and the daemon tests could not see `a43e417`. `engine` replaced those links with directories that point every entry at the primary's install except `@spinner/*`, which point at the worktree (untracked). Follow-up: a worktree that changes a workspace package needs `pnpm install` or this relink at creation.
4.  The daemon's inherited environment carries `npm_config_reporter=silent` (hides all test output) and `SLACK_USER_TOKEN` (flips `loop.test.ts` to the real transport); both must be unset for a worker's `pnpm -r test`.
5.  The row folds in a 1500 px window with the previews pane open (the agents pane is about 660 px wide); Threads and Services still scroll after the fold (Q3 stands as a build observation).

Not run: the manual e2e rows on a real daemon session (no scratch daemon with a real pi was available to the workers); the driver flows `workspace`, `view-tabs`, `design-workspace`, `design-gate`, `approve-design` plus `goldfish`, `agents` and 28 other fixture flows exit 0 against the fixture (`E2E_CDP_PORT=9340 node e2e/drive.ts`, headless Chrome 156), covering CUJ 1, 3, 4, 6, 7, 8, 10 and the fold.

--------------------------------------------------------------------------------

*Drafted with EGM*
