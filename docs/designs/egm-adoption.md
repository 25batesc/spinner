# Spinner adopts EGM: the design doc replaces MISSION.md as the session's spec

*   **Author:** spinner-agent (the Elephant of this design; see the Glossary)
*   **Status:** Reviewed
*   **Version:** 3 (version 3 applies the 19 findings of `review/readiness_report_v2.md` to the Detailed Implementation Plan; `resolve_report_v2.md` records each one. Version 1 was reviewed by 8 Goldfish reports; `resolve_report.md` records each finding)
*   **Date:** 2026-11-02

--------------------------------------------------------------------------------

## Overview

Spinner is a local tool that runs coding sessions with pi agents.
Today one shared file, `MISSION.md`, holds each session's goal, plan, roster and log.
This design makes Spinner a harness for Google's Elephant-Goldfish Model (EGM).
EGM is an Apache-2.0 spec-first plugin: 7 skills, 9 reviewer personas, 5 document standards.
EGM is not an officially supported Google product.
The pinned EGM commit is `a119668d7dc5d558664ba711d4671d11fb7270a8`.

After this design ships:

1.  The session's `lead` agent is the EGM Elephant.
    It runs `/skill:egm-brainstorm`, `/skill:egm-draft` and `/skill:egm-review` from the pinned EGM checkout.
2.  EGM Goldfish reviewers run as pi-subagents children of the lead.
    The daemon observes them through the files pi-subagents writes, so the UI shows each one live with its cost.
3.  The EGM artifacts are the session's tracking unit.
    The concepts brief, the draft and the review reports live in `<session>/design/`.
    The approved design doc lives in the project repo at `docs/designs/<feature>.md`.
4.  `MISSION.md` stays as the run-state file: roster, plan progress, contracts, questions, log.
    On the design track, its Goal and Done when sections are refused to agents, because the design doc holds the spec.
5.  The pipeline stays unchanged: run local, previews, create PR, review, fix, post, approve, land.
6.  The UI shows the EGM steps as a stepper, the skills as buttons, the gates as buttons, and cost per step.
7.  A session is the long-lived home of one feature area.
    A round (`spinner reset`, `packages/daemon/src/pipeline/reset.ts`) continues new work on that area with the session's full history.
    The UI shows the round count and the landed PRs of each round, and the design doc and its approval carry across rounds.

Spinner credits EGM in the UI and the docs.
EGM is fetched and pinned under `~/.spinner/egm/`, like the diff viewer.
No EGM file enters the Spinner repo.

### How to read this document

*   "Build session N" means phase N of the Detailed Implementation Plan.
    Each phase is one Spinner building session with its own template.
    The plan has 6 build sessions.
    A "Spinner session" without a number is a session that the product runs for an operator.
*   `s0NN` (for example s015, s016) is the id of a past Spinner building session.
    Its record is `docs/sessions/s0NN-MISSION.md` or `examples/sessions/s0NN-*/` in the Spinner repo.
*   A1 to A4 are the four analysis reports under Additional Resources.
    A1 dissects EGM. A2 dissects Spinner. A3 checks the harness fit. A4 is the product view.
*   A3 names two shapes for the Goldfish.
    Shape A: the Goldfish run as pi-subagents children inside the lead's pi process tree.
    Shape B: the daemon spawns each Goldfish as its own session agent.
    This design uses Shape A and adds daemon observation (Technical Plan T5).
*   A3's harness checklist C1 to C16 and risks 1 to 11 are summarised where this document uses them.
*   "Technical Plan Tn" refers to the sections of the Technical Plan below.
    Plan entry ids (`1.4`, `3.8`) refer to the Detailed Implementation Plan.

### Glossary

| Term | Meaning |
| --- | --- |
| pi | The coding-agent CLI that every Spinner agent runs in. |
| pi-subagents | A pi package (`npm:pi-subagents`, version 0.83.0 here) that gives pi the `subagent` tool. It runs child agents in the foreground or as detached background runs. |
| The Spinner extension | `packages/pi-extension`: the pi extension that gives a Spinner agent its tools (`mission_*`, `ask_question`), its prompt section and its command channel to the daemon. |
| tty harness, rpc harness | The two ways the daemon hosts an agent's pi. tty: an interactive pi in a pty, shown in a terminal tab. rpc: a headless pi over its RPC protocol. `settings.agents.harness` picks one; a lead uses tty by default. |
| Elephant | EGM's name for the long-lived author context: here the session's `lead`, which keeps the whole conversation. |
| Goldfish | EGM's name for a reviewer with a fresh context and no memory of the conversation, so the author's bias does not carry over. |
| Persona | One EGM reviewer definition, `agents/<file>.md` in the EGM checkout (for example `zoom_out.md`). |
| Adapter | A pi-subagents agent file that Spinner generates per persona (Technical Plan T2). |
| mdview | A Markdown viewer with a comment store that the operator uses outside Spinner. This design does not use it (Future Improvements). |
| chokidar | The file-watcher library the daemon uses. |
| Stack, stack up | A session's local services from the project's `spinner.yaml`, started by the `stack up` button. |
| The `docs` tab | A queued UI tab for documents, planned as separate work. It is not a session kind. |

## The Problem

A Spinner session starts from a paste.
The lead writes Goal, Done when and Plan from it within minutes (`packages/daemon/src/store/brief-template.ts`, the lead variant of `render_brief`).
No step checks that plan before agents write code.
The only review in Spinner reviews code, after a PR exists (s015 added the review swarm, s016 the review lead).
A plan with a missing decision becomes a wrong commit, a fixer round and a human steer.

`MISSION.md` mixes two kinds of content.
Goal, Done when and Plan are a spec.
Roster, Contracts, Open questions and Log are run state.
The spec part has no quality bar and does not outlive the session.
It never enters the project repo, so a later session cannot read why the code has its shape.

EGM addresses these gaps.
Its Goldfish review the doc from a fresh context, so the author's bias does not carry over.
Its implementation-readiness standard has a measurable bar: zero design decisions left to the builder.
Its design doc is checked into the repo, and a drift report compares it with the code later.

EGM does not run code, PRs, stacks or reviews of code.
Spinner does all of those.
The proposed solution joins the two: EGM's process up to an approved doc, then Spinner's pipeline to a merged PR.

## Goals

*   `/skill:egm-brainstorm`, `/skill:egm-draft` and `/skill:egm-review` run end to end in a Spinner lead, with no change to EGM's text.
    The evidence follows EGM's own bar (`docs/harnesses.md` "Contributing Support"): transcripts, a parent-only canary probe, and a negative write probe.
*   Every Goldfish shows in the UI within 5 seconds of its start, with persona, state, tokens and cost.
*   The EGM steps show in the context bar of every design-track session: Brainstorm, Draft, Review (EGM review stages 5 to 9), Approve, Build, then the pipeline stage.
*   All 7 EGM skills are startable from the app by a click: the five session skills from the primary button and the `EGM ▾` menu, `egm-drift-report` and `egm-bootstrap` from the same menu.
*   Every EGM gate that the lead asks through `ask_question` shows as buttons; a click answers it.
*   Cost shows per Goldfish, per EGM step for the Goldfish, and per session. The lead's own cost shows as one total.
*   Design approval is one recorded click that pins the doc's content hash. An edit to the doc invalidates it.
*   No GitHub write happens without the operator's click. The design phase writes nothing to GitHub.
*   Sessions created before this design keep working unchanged.
*   A session with 2 or more rounds shows a round badge (`r3`) on its card and in the context bar, with the PRs of each earlier round in the tooltip. The design workspace shows the earlier rounds and the doc's approvals.
*   The design doc and its approval carry across rounds. A round that changes the doc goes through re-approval (D7).
*   Outcome: fewer fixer rounds and fewer operator steers per PR on the design track than on the direct track.
    The daemon counts both per session from build session 6 (plan entries 6.19 to 6.22).
    The first comparison is made after 10 design-track and 10 direct-track sessions with a PR, with `spinner outcomes`.
    The direct-track figures are the baseline. Sessions created before build session 6 have no counters and are not part of it.

## Non-Goals

*   Any change to EGM's skill, persona or standard text.
*   Goldfish as daemon-hosted session agents (Shape B; see Alternatives).
*   A separate design PR. It waits for the stacked-PR decision (`docs/HANDOFF.md` "Open decisions" 1).
*   An upstream pull request to `google/elephant-goldfish-model`.
*   Inline comments on the design doc through mdview.
*   Automatic or reminded drift-report runs, and `drift` or `docs` session kinds.
*   A rename of `MISSION.md` to a ledger file, or of the `mission_*` tools.
*   A cost budget. Cost is shown, not enforced.
*   In-place conversion of existing sessions.
*   EGM for review sessions (`kind: review`). The s016 review lead stays as it is.

## Decisions

The operator decided D1 to D14 when reviewing version 1 of this document.
Each entry gives the options, the decision, and what the plan does.
Plan entries that follow a decision carry the tag **[Dn]**.
"The operator's convention" below means the rule in the operator's pi config (`~/.pi/agent/AGENTS.md` §1, §7): a decision is shown with its options and a recommendation.

*   **D1: Default track for a new session.**
    *   Options: (a) always `design`; (b) the lead proposes `design` or `direct`, and the operator picks; (c) always `direct`, EGM on request.
    *   Decision: (b). EGM's README says to skip EGM for small fixes.
    *   Plan: a paste starts as `design` when EGM is fetched and pi-subagents is installed, else `direct`. A paste with adopted PRs starts as `direct` (D12). The lead's first answer names the track it proposes. A track chip in the context bar switches it.
*   **D2: What design approval is.**
    *   Options: (a) a local `approve design` click that pins the doc hash, and the doc travels in the feature PR; (b) a separate design PR, merged before the build; (c) (a) by default and (b) as a per-session option.
    *   Decision: (a). Option (b) waits for the stacked-PR decision, because a design PR under a code PR is a stacked PR.
    *   Plan: Technical Plan T10. The approve dialog shows the number of blockers that the newest review report lists. A count above 0 needs an explicit "approve with N listed blockers" confirmation, and the approval records N.
*   **D3: Where the design doc lives in a multi-repo project.**
    *   Options: (a) the first repo; (b) a `designs: { repo, dir }` key in `spinner.yaml`, defaulting to the first repo and `docs/designs`; (c) the repo with the most plan entries.
    *   Decision: (b).
    *   Plan: the lead's prompt names the absolute designs directory, and the `draft` button passes it to `egm-draft` as the target directory (Technical Plan T9).
*   **D4: Default review preset.**
    *   Options: (a) interactive, with a gate after each of 5 stages; (b) consolidated, one report without stops; (c) feature spec first, implementation plan after resolve.
    *   Decision: (b) by default, (a) and the others in the review dialog.
    *   Plan: the daemon composes `<absolute doc path> Step: <preset> GoldfishContext: none`, so `egm-review` does not stop at its context intake question (Technical Plan T9).
*   **D5: Does `approve design` start the build?**
    *   Options: (a) yes, one button `approve and build`; (b) no, a separate `build` click.
    *   Decision: (a), with a checkbox in the dialog that is on by default.
*   **D6: Where run state lives.**
    *   Options: (a) a new `LEDGER.md`; (b) `MISSION.md` with the spec sections refused on the design track; (c) only `session.yaml` and a log.
    *   Decision: (b).
    *   Plan: `MISSION.md` and its tools stay. For a session whose `design.track` is `design`, the mission writer refuses agent writes to `goal` and `done_when` (Technical Plan T11). A ledger file and a tool rename are Future Improvements.
    *   Reason: build session 3 already moves the spec out of `MISSION.md` for design-track leads. A new file and renamed tools would be a second migration with its own rollback risk, for a benefit the writer refusal gives on `MISSION.md` too.
*   **D7: A design change during the build.**
    *   Options: (a) the lead edits the doc, the approval is invalidated, and the operator re-approves with the diff shown; (b) small changes go to `MISSION.md`, and the doc changes at the end; (c) any change returns the session to Draft.
    *   Decision: (a).
    *   Plan: while re-approval is pending, the lead's code writes are locked by the edit guard, as before the first approval (Technical Plan T10).
*   **D8: Goldfish and the agent limits.**
    *   Options: (a) Goldfish count against the protocol's 3-agent rule; (b) they count against neither the 3-agent rule nor the 24-agent cap, because they are pi-subagents children, not daemon agents.
    *   The 3-agent rule is rule 5 of `docs/SESSION_PROTOCOL.md` (at most 3 agents per building session). The 24-agent cap is `AGENTS_RUNNING_MAX = 24` (`packages/daemon/src/agents/manager.ts:42`), the number of hosted agents across all sessions.
    *   Decision: (b), plus a global cap on live Goldfish across all sessions.
    *   Plan: `GOLDFISH_LIVE_MAX = 12`. While the daemon sees 12 or more Goldfish `running` across all sessions, `POST …/design/run` answers 409 (Technical Plan T5).
*   **D9: Options with or without a recommendation.**
    *   Options: (a) EGM's rule everywhere: no ranking at architecture gates; (b) the operator's convention everywhere: options and a recommendation; (c) EGM's rule inside `egm-draft` gates, the operator's convention elsewhere.
    *   Decision: (c), written as one line in the lead brief.
*   **D10: Drift report and bootstrap.**
    *   Options considered in version 1: a manual click, a reminder badge after N days, or an automatic weekly run, each through new `drift` and `docs` session kinds.
    *   Decision: defer the session kinds and the reminder. `egm-drift-report` and `egm-bootstrap` run in an ordinary design-track session from the `EGM ▾` menu through `POST …/design/run`.
    *   Reason: a drift report needs approved docs under `docs/designs/`, and none exist until build sessions 1 to 6 ship and are used.
*   **D11: Code review against the design.**
    *   Options: (a) the PR reviewers get the approved doc as context; (b) a scoped drift check before `create PR`; (c) both; (d) neither.
    *   Decision: (a). Option (b) is a Future Improvement.
*   **D12: Adopted PRs with no design.**
    *   An adopted PR is an existing pull request that a session takes over with `spinner adopt` or the lead's `adopt` tool. The session gets a worktree on the PR's head branch.
    *   Options: (a) start at Ship with no stepper; (b) offer "draft a design from this PR" in the EGM menu; (c) require a design.
    *   Decision: (a). A session with adopted PRs gets the `direct` track. There is no separate `adopted` track, and the stepper is hidden as on every direct-track session.
    *   Option (b) is a Future Improvement.
*   **D13: Where Spinner's own design docs live.**
    *   The operator's convention puts plans under `~/pi-docs`, never in a repo. EGM's model checks the design doc into the repo.
    *   Options: (a) Spinner's approved design docs go to `docs/designs/` in the Spinner repo, and drafts, briefs and reviews stay in `~/pi-docs`; (b) all design files stay in `~/pi-docs`.
    *   Decision: (a). The approved doc is a living spec, not a scratch plan. A drift report needs it in the tree.
*   **D14: An upstream pi adapter for EGM.**
    *   Options: (a) after build session 4, draft a `.pi-plugin/` contribution with the harness evidence, which the operator reviews and posts; (b) keep the adapter in Spinner only.
    *   Decision: (b). EGM's `AI_POLICY.md` forbids autonomous PRs and requires the CLA. This plan does not include it.

The Elephant decided E1 to E5. The operator confirmed them when reviewing version 1, with the changes stated.

*   **E1: The Goldfish mechanism.** pi-subagents spawns them; the daemon observes their status files and transcripts. See Alternatives A, B and C.
*   **E2: Direct dispatch.** The lead dispatches Goldfish directly, not through `egm-synthesizer`.
    `egm-review` and `egm-brainstorm` allow direct dispatch only "if your harness cannot nest subagents" (`skills/egm-review/SKILL.md` "Delegation"; `docs/harnesses.md` "Delegation").
    So Spinner generates the `egm-synthesizer` adapter without the `subagent` tool. In this harness a Goldfish cannot nest, and the skills' own condition selects direct dispatch.
    Each Goldfish is then one level below the lead and visible.
    Probe P8 would detect a lead that calls `egm-synthesizer` anyway.
*   **E3: The gate tool.** The lead gets a tool named `ask_question`.
    EGM's skills name that tool as the structured gate and pass `{ "questions": [ { "question", "options", "is_multi_select" } ] }`. The tool takes that payload as one JSON text parameter (Technical Plan T8).
    A gate is kept apart from `mission_question` because a gate blocks the lead's turn, has a fixed option list, and has one slot per session. Open questions are non-blocking notes from any agent.
*   **E4: Schema version.** `session.yaml` stays at version 1 with an optional `design` block. The extension refuses newer versions, and stacked PRs already claim version 2.
*   **E5: The artifact directory.** `<session>/design/`, flat, with EGM's own file names. Reports of an earlier review run move to `<session>/design/reviews/<run id>/` (Technical Plan T7).

## Critical User Journeys (CUJs)

### CUJ 1: Start a design session from a paste

*   **Given**: EGM is not fetched yet. pi-subagents is installed in the operator's pi. A project with one repo exists.
*   **When**: The operator pastes "Add CSV export to the orders page" and clicks `Start`.
*   **Then**: The `new` job log shows `fetching EGM a119668d7dc5`, then `EGM ready`, then `lead started`.
    The session's `session.yaml` has `design.track: design`.
    The context bar shows the EGM stepper at `Brainstorm` (hollow) and the track chip `design`.
    The lead's first answer proposes the `design` track and asks the first clarifying question in its terminal.

### CUJ 2: Brainstorm with gates as buttons

*   **Given**: CUJ 1 is done.
*   **When**: The operator clicks `brainstorm`, answers three questions in the terminal, and the lead asks the readiness gate through `ask_question`.
*   **Then**: A gate card shows the question and the options `Review with Goldfishes` and `Clarify additional constraints or assumptions in chat`.
    The `needs you` pill reads `answer the lead: Anchored feature hypothesis: …`.
    A click on `Review with Goldfishes` sends that text to the lead; the card disappears.
    The same answer typed in the lead's terminal also removes the card when the lead's next turn starts.
    Six Goldfish chips appear within 5 seconds: `zoom-out`, `design`, `comprehension`, `implementation-readiness`, `codebase-details`, `structural`.
    Each chip shows `running`, then `done` or `failed`, with tokens and dollars.
    While a chip is `running`, the `needs you` pill does not show `reply to the lead`.
    `<session>/design/concepts_brief.md` appears. The Brainstorm step turns active when the brief exists, and done when the draft starts.

### CUJ 3: Watch a Goldfish's transcript

*   **Given**: A Goldfish chip shows `running`.
*   **When**: The operator clicks the chip.
*   **Then**: A read-only transcript of that child opens in the agents view. It updates every 2 seconds while the child runs. It has no input box.

### CUJ 4: Draft section by section

*   **Given**: The brief exists.
*   **When**: The operator clicks `draft`.
*   **Then**: The lead writes `<session>/design/design_draft.md` one section at a time.
    After each section a gate card offers `Approve <Section> and proceed to next section` and `Request revisions to <Section> …`.
    The Design tab of the design workspace renders the draft with an outline and a revision box per section.
    At the end the lead writes `<worktree>/docs/designs/<feature>.md` and calls `design_doc` with its absolute path. The daemon records it as `design.doc`. The stepper shows Draft done.

### CUJ 5: Review the design and resolve findings

*   **Given**: `design.doc` is set.
*   **When**: The operator clicks `review design` and keeps the default preset `consolidated`.
*   **Then**: The lead runs `egm-review` with `Step: uninterrupted GoldfishContext: none` and does not stop to ask for context.
    The Review step shows sub-dots 5 to 9 that fill as each report file of this run appears.
    `consolidated_review_report.md` appears. The Review tab renders it as Markdown.
    The stepper tooltip shows the cost of this review's Goldfish.
    When the operator asks the lead to resolve, `goldfish_review_report.md` appears without `Status: resolved`; the stage is `resolving`.
    When the lead settles, a resolve card offers `auto accept`, `continue` and `interactive breakdown`. A click sends `Auto accept`, `Continue` or `Interactive breakdown` to the lead.
    The stage stays `resolving` until `egm-resolve` Step 5 writes `Status: resolved` at the top of the report.

### CUJ 6: Approve and build

*   **Given**: The design stage is `design-ready`.
*   **When**: The operator clicks `approve design`, keeps `start the build` checked, and confirms.
*   **Then**: The doc's `Status:` line reads `Approved`.
    `session.yaml` has `design.approved` with the doc's normalized SHA-256 and the number of listed blockers.
    The lead gets the build message. It adds one `MISSION.md` Plan item per `##### n.n` entry of the doc's Detailed Implementation Plan through `mission_plan`, and starts work.
    The stepper shows Approve done and Build active.

### CUJ 7: The design changes during the build

*   **Given**: The design is approved and the build runs.
*   **When**: The lead edits the Technical Plan section of the doc.
*   **Then**: The approval is invalidated within 2 seconds of the write. The stage becomes `design-ready` with `changed_after_approval`.
    Every running agent of the session, on the tty and the rpc harness, gets the notice `The design doc changed in Technical Plan (Architecture); the approval is invalidated. …`.
    The lead's edit guard refuses code writes until the operator re-approves.
    The `needs you` pill reads `re-approve the design (changed since approval)`.
    The approve dialog lists each changed `## ` section with its approved and current text.

### CUJ 8: Ship unchanged

*   **Given**: The build is done and the design is approved.
*   **When**: The operator clicks `create PR`.
*   **Then**: The PR body starts with the doc's Overview and Goals and names the doc path.
    Everything after that (bot review, fix, verify, post, approve, land) behaves as before this design.
    The PR reviewers get the approved doc path in their brief.

### CUJ 9: A direct-track session

*   **Given**: A new session from a one-line bug report.
*   **When**: The lead proposes `direct` and the operator picks it on the track chip.
*   **Then**: The context bar shows the pipeline stage badge, not the stepper. No Goldfish run. `MISSION.md` holds a Goal, Done when and Plan as before this design.

### CUJ 10: EGM is not available

*   **Given**: pi-subagents is not in the operator's pi settings, or the EGM fetch failed.
*   **When**: A session starts from a paste.
*   **Then**: The `new` job log names the reason. The lead starts without the EGM skills, and the track is `direct`.
    The track chip offers no `design` item. Settings → About EGM shows the state and a `fetch` button.

### CUJ 11: A session from before this design

*   **Given**: A session created before this design, with `MISSION.md` and no `design` block.
*   **When**: The operator opens it after the upgrade.
*   **Then**: It shows the pipeline badge and the mission view, as before. Its agents keep working.

### CUJ 12: A drift report from the menu

*   **Given**: A design-track session of a project with approved docs under `docs/designs/`.
*   **When**: The operator picks `drift report` in the `EGM ▾` menu and confirms the prefilled designs directory.
*   **Then**: The lead runs `/skill:egm-drift-report <absolute designs dir>`.
    The report appears in `<session>/design/<YYYY-MM-DD>_DRIFT_REPORT.md`, and the design workspace lists it under Files.

### CUJ 13: A new round on the same feature area

*   **Given**: A design-track session whose round-1 PR `web#41` landed, with an approved doc.
*   **When**: The operator runs `spinner reset <session>` and prompts the lead with the next piece of work on the same area.
*   **Then**: The branch is `<branch>-r2`. The card and the context bar show `r2`, with the tooltip `r1: web#41 merged 2026-11-05`.
    `design.doc` and its approval stay, and the stepper shows Build active.
    The lead edits the doc for the new work. The approval is invalidated, the lead's code writes are locked, and the operator re-approves with the changed sections shown.
    The History tab lists round 1 with its PR and its Log, and both approvals with their rounds and hashes.

## Technical Plan (Architecture)

Constants, patterns, prompt texts and field lists live in the Detailed Implementation Plan. This section states each rule once and names the plan entry that holds the detail.

### T1. Components

```text
                        ~/.spinner/egm/  (fetched, pinned, never in the repo)
                        ├── src/            google/elephant-goldfish-model @ a119668
                        ├── pi/agents/      9 adapter files, generated at fetch time
                        └── fetched.json    { sha, adapter_version, fetched }
                                  │
 spinnerd ────────────────────────┼──────────────────────────────────────────────┐
  egm/fetch.ts   fetch + adapter  │                                               │
  egm/spawn.ts   lead spawn args ─┘                                               │
  egm/design.ts  DesignTracker: files → design stage → session.yaml `design`     │
  egm/goldfish.ts GoldfishWatcher: <session>/egm-runs/**/status.json → chips      │
  egm/gate.ts    gate record     egm/approve.ts  approval + hash                  │
  costs/ledger.ts  + child transcripts named by status.json                       │
  derive-stage.ts  + with_design (needs_human)                                    │
        │ spawn: --skill <egm>/skills --exclude-tools subagents_enable            │
        │ env:   PI_SUBAGENT_EXTRA_AGENT_DIRS, PI_SUBAGENTS_TEMP_ROOT,             │
        │        SPINNER_EGM_ROOT, SPINNER_EGM_ARTIFACTS                           │
        ▼                                                                         │
  lead pi (the Elephant) + Spinner extension (+ ask_question, design_doc)         │
        │ subagent tool (pi-subagents), direct dispatch, async                     │
        ▼                                                                         │
  Goldfish children (egm-zoom-out, egm-design, …): tools read,grep,find,ls,       │
  no extensions, fresh context, PI_SUBAGENT_CHILD=1                               │
        │ writes                                                                   │
        ▼                                                                         │
  <session>/egm-runs/async-subagent-runs/<runId>/status.json  ───────────────────┘
  child transcripts at each step's `sessionFile` (inside <session>/agents/lead/pi/)
  <session>/design/  concepts_brief.md, design_draft.md, *_report.md, reviews/<run id>/
  <worktree>/docs/designs/<feature>.md  (the design doc, named by design_doc)
```

### T2. The EGM checkout and the adapter

The daemon fetches EGM the way it fetches the diff viewer (`packages/daemon/src/diff/fetch.ts`).
It makes a shallow clone of one commit into `<home>/egm/src`.
It checks that the runtime files exist (the list is in 1.1), and it writes `<home>/egm/fetched.json` last.
A moved pin, or a moved adapter version, fetches again.
`packages/daemon/src/egm/pins.ts` is the source of truth for the pin.
The file `~/.spinner/egm/PIN` exists on the author's machine because the Phase B analysis fetched EGM by hand before this design. The daemon does not read it.

The adapter mirrors EGM's `.claude-plugin/agents/*.md`.
The daemon generates one pi-subagents agent file per `agents/*.md` of the fetched checkout.
It reads each file's frontmatter `name` and `description`.
The kind follows the file name: `synthesizer.md` is the synthesizer, `bootstrap_orchestrator.md` is the bootstrap orchestrator, every other file is a reviewer.

The three kinds differ in tools and body text (exact text in 1.9):

| Kind | `tools` | Body says |
| --- | --- | --- |
| reviewer | `read, grep, find, ls` with `acceptanceRole: read-only` | Read the persona, stay read-only, read every supplied standard, report an incomplete review when a file cannot be read. |
| synthesizer | `read, grep, find, ls, write`, no `subagent` | Read the persona; this harness gives the synthesizer no subagent tool, so report that and stop when asked to spawn reviewers. |
| bootstrap orchestrator | `read, grep, find, ls, write, edit, bash, subagent` | Read the persona; write only under the target path; never stage or commit. |

The synthesizer has no `subagent` tool on purpose (E2). The bootstrap orchestrator keeps it, because `egm-bootstrap` spawns workers for trees with more than 5 directories. Those workers are grandchildren of the lead, and the UI does not show them.

All adapters set `systemPromptMode: replace`, `inheritProjectContext: false`, `inheritGlobalContext: false`, `inheritSkills: false`, `extensions: []` and `defaultContext: fresh`.

### T3. The lead's spawn

`AgentManager.add` (`packages/daemon/src/agents/manager.ts`) asks `egm_spawn` for EGM arguments when four conditions hold:
the agent's role is `lead`, the session's kind is `session`, EGM is fetched, and pi-subagents is installed.
"Installed" means that the `packages` list of the operator's pi settings (`$PI_CODING_AGENT_DIR/settings.json`, else `~/.pi/agent/settings.json`) has an entry whose source names `pi-subagents`.
The daemon knows this before the spawn. A project-level `.pi/settings.json` is not read; a package installed only there counts as missing.
`pi_spawn_plan` (`packages/daemon/src/agents/harness.ts`) then adds:

| Item | Value | Why |
| --- | --- | --- |
| `--skill` | `<home>/egm/src/skills` | pi discovers the 7 skills recursively. |
| `--exclude-tools` | `subagents_enable` | Keeps `subagent` active from the first request (A3 risk 1: a model that sees no `subagent` tool stops the review). |
| `PI_SUBAGENT_EXTRA_AGENT_DIRS` | `<home>/egm/pi/agents` | pi-subagents loads the adapters as user agents, with no project trust (A3 risk 4). |
| `PI_SUBAGENTS_TEMP_ROOT` | `<session>/egm-runs` | Async run status files land inside the session, where the daemon reads them. |
| `SPINNER_EGM_ROOT` | `<home>/egm/src` | The extension's prompt section names the plugin root. |
| `SPINNER_EGM_ARTIFACTS` | `<session>/design` | The extension's prompt section names the artifact directory. |

The pi-subagents variables are cited from version 0.83.0:

*   `PI_SUBAGENTS_TEMP_ROOT` is documented (`docs/agents.md`, the sandbox paragraph) and read once at import (`src/shared/types.js`). It must be in the lead's spawn environment; a later change has no effect.
*   `PI_SUBAGENT_EXTRA_AGENT_DIRS` is defined in `src/agents/agents.js` (`EXTRA_AGENT_DIRS_ENV`). It is not documented.
*   `PI_SUBAGENT_CHILD` is defined in `src/runs/shared/child-runtime-config.js` (`SUBAGENT_CHILD_ENV`). It is not documented.

Probes P2 and P4 of build session 1 would show whether the two undocumented variables behave as the source reads.
If P4 fails, the fallback is the documented `subagents.agentScanDirs` pi setting (`docs/configuration.md`, "Extra agent scan directories"), which the operator adds once.

The session `AGENTS.md` (`render_agents_file`) gains the line `EGM artifact directory: <session>/design` (A3 risk 5: without it, the first brainstorm writes its brief into the repo root).
EGM's `docs/harnesses.md` defines that line as the artifact-directory override.

### T4. Isolation of the Goldfish

Four layers are meant to keep a Goldfish free of the parent's context:

1.  The adapter's `defaultContext: fresh`, `systemPromptMode: replace` and the three `inherit*: false` fields.
2.  The adapter's empty `extensions: []` list, which disables discovered extensions in the child.
3.  The Spinner extension's `register()` returns at once when `PI_SUBAGENT_CHILD` is `1`.
    pi-subagents sets that variable in every background runner.
    Without this check, a background child that inherits `SPINNER_SESSION_DIR` would put `MISSION.md` in its prompt.
    It would also open a second command long-poll under the lead's route and take the lead's commands (A3 risk 2).
4.  The `tools:` allowlist, which pi enforces.

The canary probe of build session 1 (P2a) is designed to test layers 1 to 3. Its negative write probe (P2c) is designed to test layer 4.

### T5. Observing the Goldfish

pi-subagents launches are async by default.
Each async run writes `<PI_SUBAGENTS_TEMP_ROOT>/async-subagent-runs/<runId>/status.json`.
The fields Spinner reads are documented in pi-subagents `docs/observability.md` ("Status and result fields"). The list is in 4.4.

`GoldfishWatcher` (`packages/daemon/src/egm/goldfish.ts`) polls those files every 2 seconds per session.
It polls while the session's lead is busy, while any run's `state` is `running`, and for 30 seconds after each `agent.settled` of the lead, so a run that starts just before a settle is seen.
It reads the 200 newest run directories and ignores older ones.
Each step becomes a `GoldfishView` in `SessionView.design.goldfish`.
pi-subagents status words map to five chip states; the table is in 4.4.

How a result reaches the lead: an async launch returns a receipt at once.
When a background run ends, pi-subagents delivers a completion notice into the lead's session as a custom message (`docs/observability.md`, the result-file and completion-notification paragraphs). The lead can also block on `bg_wait`.
The prompt section tells the lead to wait for every Goldfish of a stage before it consolidates.
On the tty harness, a gate answer that arrives while the lead is busy is queued as a follow-up message (`packages/pi-extension/src/tty.ts`), so it does not interrupt a consolidation.

While any Goldfish of the session is `running`, the "lead waits" rule of T7 does not fire.

The global cap: `GOLDFISH_LIVE_MAX = 12` live Goldfish across all sessions **[D8]**.
The watchers count `running` steps of all sessions.
While the count is 12 or more, `POST …/design/run` answers 409 with the count, and the chips row shows `12 Goldfish running across sessions; new skill starts wait`.
The daemon cannot stop a launch inside pi. A lead already inside a skill can pass the cap by one stage's fan-out, at most 6 Goldfish. The Risks table records this.

### T6. Costs of the Goldfish

The cost ledger (`packages/daemon/src/costs/ledger.ts`) adds child transcripts to its scan.
It takes their paths from each run's `status.json` (`steps[].sessionFile`), not from a directory layout, because async and parallel launches use different subdirectories.
It accepts only paths inside `<session>/agents/`.
Each row from a child file carries `child: "<runId>/<step index>"`.
`SessionCost.agents[<name>]` keeps each agent's own rows. `SessionCost.children["<runId>/<step index>"]` holds each child's sum. The session total includes both.
The transcript rows are the cost source, with the same pricing as every agent. pi-subagents' `totalCost` field is not read.

Child transcripts have their own bound, `CHILD_FILES_MAX = 20_000` across the home, apart from the existing `FILES_MAX` assertion. Past the bound, the ledger keeps the newest child files by modification time and logs one line per refold. It does not throw.

`DesignView.cost_by_stage` attributes Goldfish cost only **[simpler version, review M12]**:
each child run's cost goes to the design step that was current when the watcher first saw the run.
The watcher records that step in `<session>/egm-runs/runs.json`.
The lead's own cost shows as one total, `SessionCost.agents.lead`, not split by step.

### T7. The design stage

The design stage is derived from facts, never set, like the pipeline `stage`.
`derive_design` (`packages/daemon/src/egm/derive-design.ts`) is a pure function.

"The current review run" means the report files directly in `<session>/design/`.
When `POST …/design/run` starts `egm-review` or `egm-review-loop`, the daemon first moves every review report of the earlier run into `<session>/design/reviews/<id of the earlier run>/` and records `design.review_run: { id, preset, started }` with the next free id. Ids are `r1`, `r2`, …; a new run never takes the id of an archived one (3.8).
A review typed in the lead's terminal does not archive. EGM then overwrites the reports with the same names. The review button is the supported path.

Rules, in order; the first match wins:

| # | Stage | Fact |
| --- | --- | --- |
| 1 | `approved` | `design.approved.sha256` equals the normalized hash of the doc now. |
| 2 | `resolving` | The current run has `goldfish_review_report.md`, and its first non-empty line is not `Status: resolved`. |
| 3 | `design-ready` | `design.doc` is set, and the current run has `consolidated_review_report.md` or `implementation_readiness_report.md`, or it has `intermediate_zoom_out_report.md` while `design.review_run.preset` is `feature_spec` or no `review_run` is recorded. |
| 4 | `design-review` | `design.doc` is set, and the current run has at least one review report. |
| 5 | `drafted` | `design.doc` is set. |
| 6 | `drafting` | `design_draft.md` exists. |
| 7 | `brainstorm` | `concepts_brief.md` exists. |
| 8 | `intake` | none of the above. |

The review reports are the five stage reports of `egm-review` (stage 5 `zoom_out_report.md`, 6 `comprehension_report.md`, 7 `critic_report.md`, 8 `intermediate_zoom_out_report.md`, 9 `implementation_readiness_report.md`), `consolidated_review_report.md` and `goldfish_review_report.md`.
EGM stages 1 to 4 belong to `egm-brainstorm` and `egm-draft`; that is why the review stages start at 5.
A doc changed after approval no longer matches rule 1, so its stage is `design-ready` with `design.changed_after_approval: true`.

The design stage maps to the stepper and leaves the pipeline stage alone:

| Design stage | Stepper step | Step state |
| --- | --- | --- |
| `intake` | all | todo |
| `brainstorm` | Brainstorm | active (the brief exists; the brainstorm may still run) |
| `drafting` | Draft | active |
| `drafted` | Review | todo; Draft done. No step is active: the operator starts the review. |
| `design-review`, `resolving` | Review | active, with sub-dots 5 to 9 |
| `design-ready` | Approve | active |
| `approved` | Build | active; the pipeline stage shows next to the stepper |

An active step becomes "waiting" when the session's `needs_human` is set.

The normalized hash is the SHA-256 of the doc's UTF-8 text after two steps: the `Status:` line is removed, and line endings become `\n`.
The status line is excluded because the approve route rewrites it.

`design.doc` is set only through the lead's `design_doc { path }` tool, which the lead calls when `egm-draft` writes the doc's final file **[review B2]**.
The daemon accepts the path only when it is a `.md` file inside the designs directory of the designs repo's worktree, is not `SITEMAP.md` or `README.md`, has both a `## Overview` and a `## Detailed Implementation Plan` heading, and does not exist on `origin/<base>` unless it is the session's current `design.doc`. The exception covers a later round, whose base already holds the doc that an earlier round landed (T14).
The heading check rejects a concepts brief that `egm-brainstorm` published as an RFC to the same directory. The base-branch check rejects a doc that the checkout brought with it.
The designs repo and directory come from `spinner.yaml` `designs: { repo, dir }`, defaulting to the first repo and `docs/designs` **[D3]**.

`needs_human` for a design-track session that is not approved, in order. Line 1 also applies at stage `approved`; lines 2 to 7 do not:

1.  An open gate: `answer the lead: <first 80 characters of the question>`.
2.  Stage `resolving` and the lead settled: `resolve the review findings`.
3.  The lead waits: `reply to the lead (<stage>)`.
    "Waits" means the lead settled, its last assistant text ends with `?` after trimming, no gate is open, and no Goldfish of the session is `running`.
4.  The file that `design.doc` names is missing from the worktree (for example after a round whose PR closed unmerged): `the design doc <path> is missing from the worktree`. A missing doc counts as changed after approval.
5.  The approval was invalidated by an edit: `re-approve the design (changed since approval)`.
6.  Stage `drafted`: `review the design`.
7.  Stage `design-ready`: `approve the design`.
8.  Otherwise the pipeline's own `needs_human`.

The tracker writes `design.stage`, `design.needs` and `design.waiting` into `session.yaml`.
In the same write it re-derives `session.stage` and `session.needs_human` through `refresh_session` (`packages/daemon/src/pipeline/tracker.ts`), as the pipeline writers do (2.12). This is needed because the UI shows `session.needs_human` for a session without PRs (`needsHuman`, `packages/ui/src/state.ts`), and no other writer runs during the design phase.
Each design write re-reads `session.yaml` immediately before it writes, as the `pipeline/*` writers do with `refreshed`. A write from another writer between that read and the write can still be lost; this design accepts that window, the same one the pipeline writers have.
`facts_from_session` (`packages/daemon/src/pipeline/tracker.ts`) passes the fields to `derive_stage`, so the derivation stays pure on `session.yaml`, unchanged in form.

The tracker reacts to file changes through the existing session-files watcher (`packages/daemon/src/watch/session-files.ts`), which gains an `on_design` route for `<session>/design/*`.
The worktree is outside that watcher, so the tracker adds one narrow watcher per design session on the doc file, once `design.doc` is set.

### T8. Gates

The lead gets the tool `ask_question` in the `lead` role **[E3]**.
Its one parameter, `questions`, is the JSON text of EGM's gate payload: an array of `{ question, options, is_multi_select }`.
The tool manifest supports only string, number and enum parameters (`packages/pi-extension/src/tools.ts`), so the array travels as text.
The tool accepts exactly one question with 2 to 6 options and `is_multi_select` false or absent, because EGM requires one single-select question per gate.
The tool calls `PUT /sessions/:dir/design/gate`, and the daemon writes `design.gate: { question, options, asked }` into `session.yaml`.
The tool then tells the lead to end its turn; the text is in 3.4.

A gate clears on the first of these:

1.  `POST /sessions/:dir/design/answer { text }`, the UI's path. It clears the gate and prompts the lead with the text.
2.  `POST /sessions/:dir/design/run`.
3.  A prompt or steer through `POST /sessions/:dir/agents/lead/prompt|steer`.
4.  The lead's `agent_start` event with a time after `design.gate.asked`. This covers an answer typed in the lead's terminal.

A gate that the lead asks in plain chat still works in the terminal. The "lead waits" rule of T7 makes it visible.

The resolve gate is a second gate type, derived from the stage, with no store.
`egm-resolve` Step 4 asks in chat and calls no tool (`skills/egm-resolve/SKILL.md` Step 4), so `ask_question` never sees it.
When the stage is `resolving` and the lead has settled, the UI shows a resolve card with three buttons and an "other answer" box.
The buttons post `Auto accept`, `Continue` and `Interactive breakdown` through `…/design/answer`. These are the replies `egm-resolve` Step 4 interprets.
"Interactive breakdown" then asks one item at a time in chat; each item raises the "lead waits" line.
The stage stays `resolving` until `egm-resolve` Step 5 writes `Status: resolved` at the top of the report.

### T9. Skills in the app

`POST /sessions/:dir/design/run { skill, args?, preset? }` starts a skill in the lead.
The daemon checks `skill` against the 7 EGM skill names and composes `/skill:<skill>` plus a space and the arguments.
The composed arguments per skill:

| Skill | Arguments the daemon composes |
| --- | --- |
| `egm-brainstorm` | the operator's concept text, when given |
| `egm-draft` | `Context File: <absolute brief path>. Target directory: <absolute designs dir>.` **[D3]** |
| `egm-review` | `<absolute doc path> Step: <preset> GoldfishContext: none` **[D4]** |
| `egm-review-loop`, `egm-resolve` | the target file the operator confirms (prefilled with the absolute doc path) |
| `egm-drift-report` | `<absolute designs dir> Landed rounds: r1 web#41, r2 web#57.` (the merged PRs of `SessionView.rounds`); allowed only while no repo has commits in the current round (T14) **[D10]** |
| `egm-bootstrap` | `path: <absolute path>`, default the worktree root **[D10]** |

`GoldfishContext: none` answers `egm-review` Step 1.2, which otherwise stops to ask for a reading list.
The preset words are EGM's: `interactive`, `uninterrupted`, `feature_spec`, `implementation`.
A stopped lead is a 409 with "the lead is not running; resume it from its tab".

`egm-bootstrap` writes README files. On the design track the edit guard blocks those writes before approval, so the menu disables `bootstrap` there with the tooltip "the design-only scope blocks README writes; use a direct-track session".
On the direct track the `EGM ▾` menu shows `drift report` and `bootstrap` only.

The tty harness delivers a prompt through `pi.sendUserMessage` (`packages/pi-extension/src/tty.ts` `act`).
pi's RPC documentation says the RPC prompt expands `/skill:` commands. It says nothing about `sendUserMessage`.
Probe P3 of build session 1 decides.
If the probe shows a literal `/skill:` text at the model, `act` expands it before sending.
The expansion text is Spinner's: "Read the skill file at `<path>` and follow it in this thread. Arguments: `<rest>`". It follows EGM's advice for hosts without a skill tool (`docs/claude.md`: read the skill's `SKILL.md` and follow it in the same thread).
The path comes from `pi.getCommands()`, from the entry whose `source` is `skill` and whose name is the skill's name.

### T10. Approval and the build

`POST /sessions/:dir/design/approve { build, blockers_confirmed? }` does these steps in order:

1.  It refuses with 409 when `design.doc` is unset, when the stage is `resolving`, or when a gate is open.
2.  It counts the blockers that the newest report of the current run lists (`goldfish_review_report.md`, else `consolidated_review_report.md`, else `implementation_readiness_report.md`). When the count N is above 0 and `blockers_confirmed` is not N, it refuses with 409 and the count **[D2, review M17]**.
3.  It rewrites the doc's `Status:` line to `Approved`. A doc without that line is not changed.
4.  It hashes the doc (normalized) and copies the text to `<session>/design/approved.md`.
5.  It writes `design.approved: { path, repo, sha256, at, blockers, round }`, appends the same record to `design.approvals`, and clears `design.changed_after_approval`.
6.  It appends the Log line `design approved: <path> (<sha12>, <N> listed blockers)`.
7.  When `build` is true, it prompts the lead with the build message **[D5]**.

The blocker count reads only report headings: headings whose text carries `Severity: Blocker` or `Severity: High`, else the headings inside a `🔴` or `Blockers` section (rule in 6.2). It does not know which blockers a resolve pass fixed, so the dialog calls them "listed", not "open".

The daemon does not parse the doc's plan **[review B1]**.
The build message (text in 6.2) tells the lead to add one `MISSION.md` Plan item per plan entry through `mission_plan` and to tick each item when its entry is done.

Change detection **[D7]**:

*   The tracker hashes the doc on every change.
*   When an approval exists and the hash differs, it sets `design.changed_after_approval: true`. The approval is then "invalidated": the record stays, the stage is `design-ready`, and the operator re-approves.
*   `DELETE …/design/approve` "removes" the approval: the record and `approved.md` go.
*   It computes the changed `## ` sections between `approved.md` and the doc, and sends one notice per new hash to every running agent of the session.
*   The notice goes through `AgentManager.notify_all` with a steer fallback, because only the tty harness has `notify` (`packages/daemon/src/agents/tty-harness.ts`).

The extension's edit guard enforces EGM's design-only scope for the lead.
The tracker writes `<session>/design/.state.json` with `{ track, stage, approved, designs_dir }`, on both tracks. A switch to `direct` rewrites it with `track: "direct"`, so the guard and the prompt section stop applying the design rules.
`approved` is `design.approved !== undefined && design.changed_after_approval !== true`. So the lead's code writes are locked before the first approval and again while re-approval is pending.
The extension reads JSON, not `session.yaml`, because it deliberately has no YAML parser and depends only on `@spinner/protocol` (`packages/pi-extension/src/prompt.ts`).
For the lead of a `design` track with `approved: false`, an `edit` or `write` is allowed only inside the session directory and inside `designs_dir`. Workers are not affected.

### T11. Run state in `MISSION.md`

`MISSION.md` stays the run-state file for every session **[D6]**.
For a session whose `design.track` is `design`, the mission writer (`packages/daemon/src/store/mission-writer.ts`) refuses writes to `goal` and `done_when` from every author except `spinner`, with the message "this session's spec is the design doc".
`mission_goal` and `mission_done_when` then return that message to the lead.
When the track becomes `design`, the daemon replaces the Goal with a pointer to the design doc and the Done when list with one item, as author `spinner` (text in 2.20).
When the track becomes `direct`, the refusal ends, and the lead writes Goal and Done when as before this design.

### T12. Data shapes

`session.yaml` gains one optional block. The TypeScript types are in 2.1, 3.1 and 4.1.

```yaml
design:
  track: design            # design | direct
  stage: drafting          # derived; written by the tracker
  needs: null              # derived needs_human text, or null
  waiting: false           # derived: the lead settled on a question
  doc: docs/designs/csv-export.md   # repo-relative; absent until design_doc
  repo: web                # repo key of the doc
  review_run:              # absent until the first review from the app
    id: r2
    preset: uninterrupted
    started: 2026-11-04T10:02:00+01:00
  gate:                    # absent when no gate is open
    question: "..."
    options: ["...", "..."]
    asked: 2026-11-04T10:12:00+01:00
  approved:                # absent until approval
    path: docs/designs/csv-export.md
    repo: web
    sha256: 9f2c…
    at: 2026-11-04T11:40:00+01:00
    blockers: 0
    round: 1
  approvals:               # every approval, oldest first; absent until the first
    - { path: docs/designs/csv-export.md, repo: web, sha256: 9f2c…, at: 2026-11-04T11:40:00+01:00, blockers: 0, round: 1 }
  changed_after_approval: false
outcomes:                  # absent until build session 6; counted for every session kind "session"
  fix_rounds: 1
  operator_steers: 3
rounds:                    # earlier rounds, written by reset from build session 2
  - round: 1
    branch: feat/csv-export
    prs: [{ repo: web, number: 41, url: "https://github.com/acme/web/pull/41", state: merged, merged_at: 2026-11-05T16:02:00+01:00 }]
    started: 2026-11-04T09:30:00+01:00
    ended: 2026-11-05T17:10:00+01:00
```

A session without the `design` block is a legacy session; the UI and the CLI show it as before this design.
`SessionView.design` carries the track, the stage, the design files, the current run's report flags, the doc path, the approval, the gate, the Goldfish and `cost_by_stage`.

### T13. The UI

The context bar replaces the stage badge with a stepper for a `design` track:

```text
CSV export │ EGM ① Brainstorm ✓ ─ ② Draft ✓ ─ ③ Review ●●●○○ ─ ④ Approve ─ ⑤ Build │ planned │ stack up │ $4.20 │ [needs you: answer the lead: …] │ design ▾ │ toolbar
```

*   Step states: todo (hollow ring), active (accent), waiting on the operator (warn), done (check).
*   The Review step has five sub-dots for stages 5 to 9.
*   The tooltip of each step shows its Goldfish cost from `cost_by_stage`.
*   The `EGM` label's tooltip is `EGM_NOTICE` (1.1).
*   Under `TOOLBAR_COMPACT_PX` (1200 px) the stepper folds to `EGM 3/5 Review` with the full stepper in the tooltip.
*   The track chip (`design ▾`) switches between `design` and `direct`. It offers `design` only when EGM is ready and pi-subagents is installed.
*   A click on a step opens the matching tab of the design workspace.
*   On every session with `round >= 2`, a round badge `r<round>` follows the title in the context bar and on the session card. Its tooltip lists each earlier round with its PRs, their state and merge date (T14).

The toolbar gains a `design` group left of the stack group: one primary button whose label follows the stage, and an `EGM ▾` menu with the skills.

| Design stage | Primary button | Request |
| --- | --- | --- |
| `intake` | `brainstorm` | `POST …/design/run { skill: "egm-brainstorm", args? }` |
| `brainstorm` | `draft` | `{ skill: "egm-draft" }` |
| `drafting` | none | |
| `drafted` | `review design` | `{ skill: "egm-review", preset }` |
| `design-review` | none | |
| `resolving` | none; the resolve card answers (T8) | |
| `design-ready` | `approve design` | `POST …/design/approve` |
| `design-ready` with `changed_after_approval` | `re-approve design` | `POST …/design/approve` |

The middle pane gains a `design` view with five tabs: Brief, Design, Review, Files and History. History lists the earlier rounds with their PRs and Logs, and the doc's approvals with their rounds and hashes. The `mission` view stays.
Goldfish chips appear in the agents view under the agent chips.
Settings gains an "About EGM" block.

### T14. Rounds and the design doc

A session is the long-lived home of one feature area.
`spinner reset` starts round N+1 on the same session: a new branch `<branch>-r<N+1>` from fresh `origin/<base>`, the PR facts cleared, the round's threads under `artifacts/round-<N>/`, and the Log moved under `## Previous rounds` in `MISSION.md` (`archive_round`, `packages/daemon/src/pipeline/mission-sections.ts`).
Agent transcripts stay, so the next round continues with the full history.

*   **The round number.** `SessionView.round` is `session.round` (written by reset since s005), else the `-r<n>` suffix of `session.branch`, else 1.
*   **Round records.** From build session 2, `reset` appends a record to `session.yaml` `rounds` before it clears the PR facts: the round, the branch, the PRs, the start and the end. A round can have one PR per repo, so the record holds a list `prs` of `{ repo, number, url, state, merged_at }`.
*   **`merged_at`.** Spinner does not record GitHub's merge time. The record uses the PR's `last_activity` when its state is `merged`, which is the merge time or a later comment on the PR, and null otherwise.
*   **Rounds before build session 2.** They have no record. The daemon reads them from the `### Round <n> · <branch> · PRs: <repo>#<number> (<state>), …` headings that `archive_round` writes, with `url`, `merged_at`, `started` and `ended` null.
*   **The design doc across rounds.** Reset clones the session, so the `design` block, `design.doc`, `design.approved` and `design.approvals` stay unchanged. If the round's PR landed, the new branch from `origin/<base>` holds the approved doc, the hash matches, and the stage stays `approved`. If the PR closed unmerged, the doc is missing, and `needs_human` says so (T7).
*   **A round that changes the doc.** The hash differs, the approval is invalidated, and the lead's code writes are locked until the operator re-approves (D7, T10). Each approval is appended to `design.approvals` with its round.
*   **The drift report.** `egm-drift-report` reads the worktree. At the start of a round every worktree is at `origin/<base>`, which holds the landed code of all earlier rounds. So the menu item runs only while no repo has commits in the current round (`changed: false` in every repo). The daemon adds the landed PRs to the arguments (T9).
*   **One feature area per session** is a convention that the UI makes visible. The daemon does not enforce it.

## Alternatives Considered

### Alternative A: Goldfish as daemon-spawned session agents (A3 Shape B, A4's proposal)

*   **Pros**: Chips, tabs, costs and the cap come from the existing swarm code (`packages/daemon/src/agents/swarm.ts`). The daemon can pass `--tools read,grep,find,ls` and spawn without the extension.
*   **Cons**: The skills' "spawn and wait for the report" becomes a tool call that blocks for minutes across a process boundary, or a turn boundary that breaks the synthesizer's single-summary contract. A daemon-spawned synthesizer would need the Spinner extension to spawn its reviewers, which breaks isolation. Every Goldfish takes one of the 24 agent slots, so a 6-lens brainstorm in two sessions serialises.
*   **Reason for Rejection**: It changes how EGM's skills delegate. The proposed design (E1, T5) gives the same visibility from files without that change.

### Alternative B: Pure Shape A, children invisible (A3's recommendation)

*   **Pros**: Zero daemon work. The skills run exactly as in other harnesses.
*   **Cons**: The operator cannot see the Goldfish or their cost. Settings → Usage undercounts every review (A3 risk 9).
*   **Reason for Rejection**: It fails two stated requirements of the operator: live child visibility and cost display.

### Alternative C: Synthesizer nesting with recursive observation

*   **Pros**: EGM's default path. The lead's context receives one summary per stage, not raw findings.
*   **Cons**: Grandchildren write status files under a nested async root that pi-subagents does not document. Their transcripts sit one level deeper. The watcher and the ledger would need an unbounded or guessed depth.
*   **Reason for Rejection**: With a synthesizer adapter that cannot spawn (E2), the skills select direct dispatch by their own rule, and each Goldfish stays one level down. The cost is the raw findings of each stage in the lead's context. Their size is unmeasured; the P11 evidence of build session 1 would record the lead's tokens per skill. Revisit when pi-subagents documents the nested async root (Future Improvements).

### Alternative D: Rewrite the EGM skills as Spinner-native briefs

*   **Pros**: The s016 pattern. Full control over gates and outputs. No dependency on pi-subagents.
*   **Cons**: A fork of EGM. Every upstream change needs a manual port. The rewrite would also drop the Goldfish isolation that the skills rely on.
*   **Reason for Rejection**: A3 shows that the skills can run with no text change behind a generated adapter. The adapter is the smaller change.

### Alternative E: Copy the implementation-readiness rule into the lead brief

*   **Pros**: One brief edit. No new components.
*   **Cons**: The lead reviews its own plan. EGM's `docs/designs/review.md` names self-review as confirmation bias.
*   **Reason for Rejection**: It keeps the problem this design solves.

### Alternative F: Vendor EGM into the Spinner repo

*   **Pros**: No fetch step. Works offline after clone.
*   **Cons**: Apache-2.0 notice obligations in the repo. Two copies to keep in step. Against the operator's constraint.
*   **Reason for Rejection**: The operator's constraint: fetch and pin under `~/.spinner/egm/`.

### Alternative G: Parse gates out of the lead's prose

*   **Pros**: No new tool. Works for any skill.
*   **Cons**: The gate texts vary per skill and per model. A missed gate leaves the operator waiting on a silent session.
*   **Reason for Rejection**: EGM names `ask_question` as the structured path. The prose rule stays only as the "lead waits" fallback.

### Alternative H: The stepper only inside the design panel

*   **Pros**: The context bar keeps its current width.
*   **Cons**: The stage is hidden on the agents, threads and services views.
*   **Reason for Rejection**: The operator asked for the EGM steps to be explicit in the UI.

### Alternative I: Daemon parsing of EGM report findings

*   **Pros**: A sortable findings table with severity, reviewer and scope columns.
*   **Cons**: The parser depends on EGM's free-form report prose: severity emojis, synonyms and reviewer names in headings. Synthesizer reports carry no linked scope. An EGM pin move can change any of these with no error.
*   **Reason for Rejection**: The Review tab renders the report Markdown. Spinner reads only the `Status: resolved` line and the blocker headings of T10.

--------------------------------------------------------------------------------

## Non-Functional Requirements

### Security & Privacy

*   Goldfish are read-only by a pi tool allowlist. EGM's Claude adapter uses the same kind of control. It is not a filesystem sandbox, which EGM accepts (`docs/designs/runtime_packaging.md`).
*   Goldfish can read any file that the operator's user can read, including secret files. This design accepts that risk. Their transcripts stay in the session directory, and the UI serves them.
*   The lead keeps its bash guard: no `git push`, no `gh pr create|merge|review|comment`, no `gh api` writes, no `spinner pr|post|approve|land|reset|close` (`packages/pi-extension/src/guard.ts` `refuse_operator_bash`).
*   The design-only scope is advisory against `bash`. The edit guard sees only `edit` and `write`. A lead can change code before approval with a shell redirect, `sed -i` or an npm script. This design accepts that bypass; the guard stops the common path, and the diff tab shows every change.
*   The design phase writes nothing to GitHub. `create PR`, `post`, `approve` and `land` stay operator clicks.
*   The EGM fetch reads one public GitHub repository at a fixed commit. It runs no install step and no code from the checkout.
*   The daemon serves a child transcript only from a path inside `<session>/agents/`.
*   No secret enters `session.yaml`, `MISSION.md` or the design files. The probes never print `.npmrc`, `.env*`, `auth.json` or `~/.spinner/env`.

### Performance & Latency

*   The Goldfish watcher reads at most 200 status files per poll, every 2 seconds, only while a run is live, the lead is busy, or within 30 seconds after the lead settled.
*   The ledger scan reads at most `CHILD_FILES_MAX` (20,000) child transcripts across the home. Files are cached by size and modification time, unchanged from today.
*   The design tracker reacts to a file change within 2 seconds (chokidar with a 100 ms stability threshold).
*   Token cost of one design cycle is unmeasured. Build session 1 would measure one full cycle on a small concept and record it in `docs/egm/HARNESS_EVIDENCE.md`.

### Rollout & Rollback

*   Each build session ends with a release tag (`tools/release.sh`). A rollback is a checkout of the previous tag, as `docs/HANDOFF.md` "Versions and rollback" describes.
*   No build session changes an existing file format. A rollback leaves design sessions with an extra `design` block and `outcomes` counters that the older daemon ignores, and an `egm-runs` directory that it does not read.
*   After a rollback, a design-track session's `MISSION.md` accepts Goal writes again, because the older writer has no refusal.
*   EGM can be turned off per machine by deleting `<home>/egm/fetched.json`. Leads then start without EGM until the next fetch.

### Risks & Mitigations

The A3 column gives A3's risk number. A3 risks 6 to 10 are not probed: risk 6 (the 24-agent cap) applies only to Shape B; risk 7 (the edit guard blocks the RFC publish) is solved by the guard's `designs_dir` rule; risk 8 (prompt tone) by the lead brief; risk 9 (child cost) by T6; risk 10 (pin drift) by generating the adapters at fetch time.

| # | Risk | A3 | Effect | Mitigation | Probe (build session 1 unless stated) and fallback |
| --- | --- | --- | --- | --- | --- |
| R1 | `subagent` is hidden behind `subagents_enable` | 1 | The lead stops a review: "no subagent tool" | `--exclude-tools subagents_enable` (pi-subagents `docs/configuration.md`) | P1. No fallback: a failure stops the build sessions. |
| R2 | A child loads the Spinner extension | 2 | Isolation breaks; the lead loses its commands | Four layers (T4) | P2a, P2b, P2c. No fallback: a failure stops the build sessions. |
| R3 | `/skill:` is not expanded on the tty path | 3 | A button sends literal text | `act` expands the command (T9) | P3 decides whether 1.25 is built. |
| R4 | pi-subagents does not find the adapters | 4 | No `egm-*` agents | `PI_SUBAGENT_EXTRA_AGENT_DIRS` | P4. Fallback: the operator adds `subagents.agentScanDirs` once. |
| R5 | Artifacts land in the worktree | 5 | The diff tab shows EGM files | The `AGENTS.md` line and the prompt line | P5. No fallback: a failure stops the build sessions. |
| R6 | The lead calls `egm-synthesizer` anyway | none | Grandchildren invisible; a stray report | The synthesizer adapter has no `subagent` (E2) | P8. Fallback: remove the synthesizer adapter. |
| R7 | No end-to-end evidence | 11 | A support claim without proof | The evidence file | P11 records the result either way. |
| R8 | pi-subagents changes its status-file fields | none | Chips and Goldfish costs go blank | One parser module with a fixture test per field; About EGM names the pi-subagents version | Build session 4: P6, P7. |
| R9 | An EGM pin move renames personas or report names | 10 | Stale adapters; stages that never advance | Adapters generated at each fetch; report names in one constant (2.1) | The probes run again after each pin move. |
| R10 | A lead passes the global Goldfish cap inside one skill | none | Up to 18 live Goldfish; provider rate limits | `design/run` refuses new skills at 12 (T5) | Accepted: the daemon cannot stop a launch inside pi. |
| R11 | A design cycle costs more than expected | none | The operator sees a large figure on the stepper after the spend | Cost per Goldfish and per step; consolidated preset by default **[D4]** | Accepted: cost is shown, not enforced. |
| R12 | The lead skips `ask_question` and asks in prose | none | The gate shows only in the terminal | The "lead waits" rule raises `needs_human` | None needed. |
| R13 | EGM's no-ranking rule conflicts with the operator's convention | none | Gates with and without a recommendation in one session | One brief line scopes EGM's rule to `egm-draft` gates **[D9]** | None needed. |
| R14 | A lead changes code through `bash` before approval | none | Code ahead of the design | Accepted (Security) | None. |

--------------------------------------------------------------------------------

### Additional Resources

These two subsections follow the EGM design-doc template, which places them under Non-Functional Requirements.

*   [A1-egm-anatomy.md](A1-egm-anatomy.md): EGM skill by skill, the harness contract, the discrepancies.
*   [A2-spinner-anatomy.md](A2-spinner-anatomy.md): Spinner's workflow and every dependency on `MISSION.md`.
*   [A3-harness-fit.md](A3-harness-fit.md): the harness checklist C1 to C16 and risks 1 to 11.
*   [A4-product-lens.md](A4-product-lens.md): the lifecycle, the UI, the product decisions.
*   [concepts_brief.md](concepts_brief.md): the brainstorm brief for this design.
*   [resolve_report.md](resolve_report.md): every review finding on version 1 and what version 2 did with it.
*   [resolve_report_v2.md](resolve_report_v2.md): every finding of the second readiness review on version 2 and what version 3 did with it.
*   EGM at `~/.spinner/egm/src`: `docs/harnesses.md`, `docs/claude.md`, `docs/designs/multi_harness_support.md`, `skills/*/SKILL.md`.
*   pi-subagents 0.83.0: `docs/agents.md`, `docs/configuration.md`, `docs/observability.md`.

### Future Improvements

*   **A design PR** at the bottom of a stacked PR, after the stacked-PR decision **[D2]**.
*   **mdview comments** on the design doc in the queued `docs` tab, wired to EGM's "Comment directly on the file". Version 1 skips them because they need a host process per session and a comment store; EGM accepts write-in text and `<!-- -->` comments instead (`docs/claude.md`).
*   **A scoped drift check before `create PR`**: one doc against the worktree **[D11]**.
*   **Drift and bootstrap session kinds** with a drift reminder badge **[D10]**.
*   **"Draft a design from this PR"** for a direct-track session with adopted PRs **[D12]**.
*   **A session ledger**: rename `MISSION.md` to a run-state file and the `mission_*` tools to `ledger_*`, with aliases for running sessions **[D6]**.
*   **Synthesizer nesting** once pi-subagents documents the nested async root.
*   **Per-step lead cost**: split the lead's own rows by design step.
*   **EGM convergence rules for the PR review swarm**: a failed reviewer is `not run`; two clean rounds to converge.
*   **An upstream `.pi-plugin/`** for EGM, if the operator decides to contribute **[D14]**.
*   **Continue in an existing session**: when a paste names an area that an existing session already owns (the same repo paths, or the design doc's title), the paste extractor (`packages/daemon/src/pipeline/extract.ts`) offers `continue in <session>` instead of a new session.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Conventions for every build session

*   Each build session is a Spinner building session as `docs/HANDOFF.md` "How to run a building session" describes.
*   Two agents: `engine` owns `packages/daemon/**`, `packages/pi-extension/**`, `packages/protocol/**`, `packages/cli/**` and `docs/**`. `ui` owns `packages/ui/**`.
*   The template id is the next id above every `s0NN` in `docs/sessions/` and in `examples/sessions/` at the time of writing. Both directories count, because `docs/sessions/s017-MISSION.md` exists without an `examples/sessions/s017-*` template. The order below is fixed. The slugs are given.
*   Build session 1 starts from the newest release tag that includes s016 (the review lead). It must not start while s016's uncommitted edits are open.
*   `engine` commits the protocol types of each build session first and posts them under Contracts. `ui` starts on that commit.
*   Commit prefixes: `engine:` and `ui:`. Stage by path. No `git add -A`, no `git stash`.
*   E2e runs only against a scratch daemon on a scratch `SPINNER_HOME` and a free port.
*   Tests follow the repo's pattern: vitest, real collaborators, a fake interactive pi for the daemon, the UI fixture server for the UI.
*   Every build session ends with the root checks of the Verification Plan and a release tag.
*   Every build session runs under the current protocol, with `MISSION.md` in the session.
*   Each build session that changes a type in `packages/protocol/src/session.ts`, `api.ts` or `egm.ts` has a schema entry: run `pnpm --filter @spinner/protocol schema` and commit `packages/protocol/schema/*.json`. `packages/protocol/src/schema.test.ts` compares the committed files with fresh output, so a stale file fails `pnpm -r test`.
*   A **[Dn]** tag marks an entry that follows decision Dn. A **[review Xn]** tag marks an entry that answers review finding Xn of `resolve_report.md`. A **[review v2 Xn]** tag marks an entry that answers finding Xn of `review/readiness_report_v2.md`, recorded in `resolve_report_v2.md`.
*   "At most N" in an entry always says what happens past N.

### Target Files to Create/Modify

#### Build session 1: `egm-adapter`, the harness adapter and its evidence probes

Goal: a lead in a Spinner session runs EGM's skills with Goldfish isolated, and the evidence exists.
Sizes: `engine` about 4 hours, `ui` about 1 hour.
Tests A3 risks 1, 2, 3, 4, 5 and 11 (Risks R1 to R7).

##### 1.1 `packages/protocol/src/egm.ts` (Create)

*   **Type / Scope**: TypeScript module, protocol constants and types.
*   **Proposed Changes**:
    *   `EGM_HOME_DIR = "egm"`, `EGM_SOURCE_DIR = "src"`, `EGM_ADAPTER_DIR = "pi/agents"`, `EGM_MARKER_FILE = "fetched.json"`.
    *   `EGM_FETCH_TIMEOUT_MS = 300_000`. `EGM_ADAPTER_VERSION = 1`.
    *   `EGM_ARTIFACT_DIR = "design"`. `EGM_RUNS_DIR = "egm-runs"`.
    *   `EGM_SKILLS = ["egm-brainstorm", "egm-draft", "egm-review", "egm-review-loop", "egm-resolve", "egm-bootstrap", "egm-drift-report"] as const` and `type EgmSkill`.
    *   `EGM_STANDARDS = ["feature-spec-standard", "heilmeier-standard", "implementation-readiness-standard", "re-implementation-standard", "zoom-out-standard"] as const`.
    *   `EGM_PERSONA_FILES = ["zoom_out", "comprehension", "design_critic", "implementation_readiness", "codebase_details", "structural", "style", "synthesizer", "bootstrap_orchestrator"] as const`.
    *   `EGM_REQUIRED_FILES`: the 7 `skills/<name>/SKILL.md`, `skills/egm-draft/references/design_doc.md`, the 9 `agents/<file>.md` of `EGM_PERSONA_FILES`, the 5 `resources/document_standards/<name>.md` of `EGM_STANDARDS`, `resources/execution_instructions.md`, `docs/harnesses.md`, `LICENSE`.
    *   `EGM_SOURCE_URL = "https://github.com/google/elephant-goldfish-model"`. `EGM_LICENSE = "Apache-2.0"`.
    *   `EGM_NOTICE = "Elephant-Goldfish Model by Google, Apache-2.0. Spinner runs its skills from a pinned copy. Not an officially supported Google product."`
    *   `SUBAGENTS_PACKAGE = "pi-subagents"`.
    *   `type EgmFetchState = "absent" | "fetching" | "ready" | "failed"`.
    *   `interface EgmStatus { state: EgmFetchState; pinned_sha: string; fetched_sha: string | null; fetched_at: string | null; adapter_version: number | null; error: string | null; source: string; license: string; notice: string; subagents: boolean }`. `subagents` is the result of `subagents_installed` (1.11).
    *   `interface EgmResponse { egm: EgmStatus }`.

##### 1.2 `packages/protocol/src/index.ts` (Modify)

*   **Type / Scope**: Package entry.
*   **Proposed Changes**: Re-export everything from `./egm.js`.

##### 1.3 `packages/protocol/src/api.ts` (Modify)

*   **Type / Scope**: Route table and job actions.
*   **Proposed Changes**:
    *   `ROUTES`: add `"GET /egm": "EgmResponse"` (the fetch state and the pin) and `"POST /egm/fetch": "JobResponse"` (fetch or refetch EGM and regenerate the adapter).
    *   `JobAction` and `JOB_ACTIONS`: add `"egm"`.

##### 1.4 `packages/protocol/src/extension.ts` (Modify)

*   **Type / Scope**: The extension contract.
*   **Proposed Changes**:
    *   `EXTENSION_ENV`: add `egm_root: "SPINNER_EGM_ROOT"` and `egm_artifacts: "SPINNER_EGM_ARTIFACTS"`, each with a one-line doc comment.
    *   New exports: `SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD"`, `SUBAGENT_EXTRA_AGENT_DIRS_ENV = "PI_SUBAGENT_EXTRA_AGENT_DIRS"`, `SUBAGENTS_TEMP_ROOT_ENV = "PI_SUBAGENTS_TEMP_ROOT"`. The comment cites pi-subagents 0.83.0: `docs/agents.md` for the temp root, `src/agents/agents.js` and `src/runs/shared/child-runtime-config.js` for the other two.

##### 1.5 `packages/protocol/src/extension.test.ts` (Modify)

*   **Type / Scope**: Unit test.
*   **Proposed Changes**: Assert the two new `EXTENSION_ENV` keys and the three pi-subagents constants by value.

##### 1.6 `packages/daemon/src/git/pinned-clone.ts` (Create)

*   **Type / Scope**: TypeScript module, shared by two fetchers.
*   **Proposed Changes**:
    *   Move `clone_pin` and `step` out of `packages/daemon/src/diff/fetch.ts` without behaviour change.
    *   Export `clone_at_sha(input: { dir: string; repo: string; sha: string; log: Log; runner: Runner; deadline: number; timeout_ms: number; what: string }): Promise<void>` and `run_step(input: { runner: Runner; command: string; args: string[]; cwd: string; deadline: number; timeout_ms: number; what: string }): Promise<void>`.
    *   A step that passes `deadline` throws `the <what> fetch passed its <Math.ceil(timeout_ms / 60_000)> minute bound`.

##### 1.7 `packages/daemon/src/diff/fetch.ts` (Modify)

*   **Type / Scope**: The diff viewer fetch.
*   **Proposed Changes**: Call `clone_at_sha` and `run_step` from `../git/pinned-clone.js` with `what: "diffview"` and the existing diff timeout as `timeout_ms`. Delete the moved private functions. No behaviour change; the `diff` tests stay green.

##### 1.8 `packages/daemon/src/egm/pins.ts` (Create)

*   **Type / Scope**: Constant.
*   **Proposed Changes**: `EGM_PIN = { repo: "google/elephant-goldfish-model", sha: "a119668d7dc5d558664ba711d4671d11fb7270a8" } as const`. A comment says a moved pin fetches again on the next lead start or `POST /egm/fetch`.

##### 1.9 `packages/daemon/src/egm/adapter.ts` (Create)

*   **Type / Scope**: TypeScript module, pure rendering plus one directory write.
*   **Proposed Changes**:
    *   `type AdapterKind = "reviewer" | "synthesizer" | "bootstrap"`. `kind_of(file: string): AdapterKind`: `synthesizer.md` → `synthesizer`, `bootstrap_orchestrator.md` → `bootstrap`, else `reviewer`.
    *   `read_persona_header(text): { name: string; description: string }`: frontmatter between the first two `---` lines; `name` from `^name:\s*(\S+)\s*$`; `description` from `^description:\s*(.+)$` or a folded `>-` block joined with spaces. Throws `persona without a name` when `name` is missing.
    *   `render_pi_agent(input: { name: string; description: string; persona_path: string; source_root: string; kind: AdapterKind }): string`. The frontmatter, in this order: `name`, `description` (in double quotes, inner quotes escaped), `tools`, `acceptanceRole: read-only` (reviewer only), `systemPromptMode: replace`, `inheritProjectContext: false`, `inheritGlobalContext: false`, `inheritSkills: false`, `extensions: []`, `defaultContext: fresh`. `tools` per kind as in Technical Plan T2.
    *   The body, a reviewer: "Read `<persona_path>` before reviewing. Follow that canonical persona's instructions. This adapter defines your pi tools and context. Resolve bundled standards against `<source_root>`. Remain read-only. Use only the task and the review context the task names. Before returning findings, read the target and every supplied standard. If a required file cannot be read, report an incomplete review instead of a verdict."
    *   The body, the synthesizer: "Read `<persona_path>` and follow it. This adapter defines your pi tools and context. Resolve bundled standards against `<source_root>`. You have no subagent tool in this harness. If the task asks you to spawn reviewers, answer `This harness cannot nest subagents; use direct dispatch.` and stop."
    *   The body, the bootstrap orchestrator: "Read `<persona_path>` and follow it. This adapter defines your pi tools and context. Resolve bundled references against `<source_root>`. Write only under the target `path` of the task. Never stage, commit or push."
    *   `write_adapter(source_dir: string, adapter_dir: string): string[]`: lists `<source_dir>/agents/*.md`; throws `more than 50 persona files` past 50; removes and recreates `adapter_dir`; writes one file per persona under the same basename; returns the names written.

##### 1.10 `packages/daemon/src/egm/fetch.ts` (Create)

*   **Type / Scope**: TypeScript module, fetch and state.
*   **Proposed Changes**:
    *   Paths: `egm_home(home) = <home.root>/egm`; `egm_source_dir`, `egm_adapter_dir`, `marker_path`.
    *   `interface EgmMarker { sha: string; adapter_version: number; fetched: string }`; `read_egm_marker(home): EgmMarker | null`.
    *   `egm_fetched(home): boolean`: the marker sha equals `EGM_PIN.sha`, the marker `adapter_version` equals `EGM_ADAPTER_VERSION`, and every `EGM_REQUIRED_FILES` entry exists under the source dir.
    *   `fetch_egm(home, log, runner = run, timeout_ms = EGM_FETCH_TIMEOUT_MS): Promise<EgmMarker>`: delete the marker; remove `<home>/egm/src`; `clone_at_sha` into it with `what: "EGM"`; check the required files and throw with the first missing path; `write_adapter`; write the marker with 4-space JSON; log `fetched EGM <sha12> and <n> adapter agents`.
    *   `class EgmFetcher { constructor(home, env: NodeJS.ProcessEnv, runner?); status(): EgmStatus; ensure(log): Promise<boolean> }`. `ensure` returns true at once when `egm_fetched`. Otherwise it runs one shared fetch (single flight, like `DiffManager.fetching`). It returns false and keeps the error when the fetch throws. `state` is `fetching` while the promise runs, `failed` with `error` after a throw, `ready` or `absent` otherwise. `status().subagents` is `subagents_installed(env)`.

##### 1.11 `packages/daemon/src/egm/spawn.ts` (Create)

*   **Type / Scope**: TypeScript module.
*   **Proposed Changes**:
    *   `interface EgmSpawn { root: string; skills_dir: string; agents_dir: string; runs_dir: string; artifacts_dir: string }`.
    *   `subagents_installed(env: NodeJS.ProcessEnv): boolean`: reads `<env.PI_CODING_AGENT_DIR ?? ~/.pi/agent>/settings.json`; true when `packages` has a string entry, or an object entry's `source`, that ends with `SUBAGENTS_PACKAGE` after a trailing version is removed. The version is a trailing `@<version>` that matches `/@[^@/]+$/` and follows at least one character, so `npm:pi-subagents@0.83.0` counts and `npm:@acme/pi-subagents-x` does not. A missing or invalid file is false. **[review v2 N-7]**
    *   `egm_spawn(home, summary, env): EgmSpawn | null`: null unless `egm_fetched(home)`, `(summary.session.kind ?? "session") === "session"` and `subagents_installed(env)`. It creates `<session>/design` and `<session>/egm-runs` (recursive) and returns absolute paths.

##### 1.12 `packages/daemon/src/egm/routes.ts` (Create)

*   **Type / Scope**: Hono routes.
*   **Proposed Changes**:
    *   `interface EgmRouteDeps { fetcher: EgmFetcher; jobs: JobRunner }` and `mount_egm_routes(app: Hono, deps: EgmRouteDeps): void`. Build sessions 2 to 6 widen `EgmRouteDeps`; each entry that does names the new fields.
    *   `GET /egm` → `{ egm: fetcher.status() }`.
    *   `POST /egm/fetch` → a job `egm` with `session: null` that deletes the marker and calls `fetcher.ensure(log)`; the job fails with the kept error when `ensure` returns false.

##### 1.13 `packages/daemon/src/egm/egm.test.ts` (Create)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**:
    *   `render_pi_agent` for each kind: the exact frontmatter lines in order, the persona path in the body, `subagent` in `tools` only for the bootstrap kind, `acceptanceRole` only for the reviewer kind.
    *   `write_adapter` over a scratch `agents/` with three persona files: three files written, a stale extra file removed; 51 files throw.
    *   `egm_fetched` is false with no marker, with another sha, with another adapter version, and with a missing required file; true otherwise.
    *   `fetch_egm` with a fake runner that creates the required files on `git checkout`: the marker is written and the adapter exists. A runner that fails `git fetch` leaves no marker.
    *   `subagents_installed` with a scratch `PI_CODING_AGENT_DIR`: a string entry `npm:pi-subagents`, a pinned entry `npm:pi-subagents@0.83.0`, an object entry, an entry `npm:pi-subagents-extra` (false), no entry, no file.
    *   `egm_spawn` returns null for `kind: review`, for an unfetched home, and without pi-subagents; it creates both directories otherwise.

##### 1.14 `packages/daemon/src/agents/harness.ts` (Modify)

*   **Type / Scope**: Spawn builder.
*   **Proposed Changes**:
    *   `AgentSpawnSpec` and `PiSpawnInput` gain `egm?: EgmSpawn`.
    *   `pi_spawn_options` passes `agent.egm` through.
    *   `pi_spawn_plan`, when `input.egm` is set and `existsSync(input.egm.skills_dir)`: push `--skill <skills_dir>` and `--exclude-tools subagents_enable`; add the env `PI_SUBAGENT_EXTRA_AGENT_DIRS`, `PI_SUBAGENTS_TEMP_ROOT`, `SPINNER_EGM_ROOT`, `SPINNER_EGM_ARTIFACTS` from the `EgmSpawn` fields.
    *   The header comment gains the sentence: "A lead in an EGM session also gets the EGM skills, the adapters and the run directory (Technical Plan T3 of the EGM design)."

##### 1.15 `packages/daemon/src/agents/manager.ts` (Modify)

*   **Type / Scope**: Agent host.
*   **Proposed Changes**:
    *   In `add`, before `harness.spawn`: `const egm = role_of_agent(request.name) === "lead" ? egm_spawn(this.home, summary, process.env) : null`. Pass `...(egm === null ? {} : { egm })` in the spawn spec.
    *   EGM paths are not recorded in `AgentSpec.skills`. They are computed on every spawn, so a resume after a fetch picks them up.
    *   The private `write_agents_file(summary)` passes `egm: (summary.session.kind ?? "session") === "session"` to `render_agents_file`, next to the `path` it already passes. `add` calls it before every spawn, so the `AGENTS.md` of every ordinary session has the EGM lines from its first agent on **[review v2 M-3]**.

##### 1.16 `packages/daemon/src/agents/agents.test.ts` (Modify)

*   **Type / Scope**: Unit tests of the spawn plan.
*   **Proposed Changes**: With `egm` set, the args contain `--skill <skills_dir>` and `--exclude-tools subagents_enable`, and the env has the four variables. Without it, none of them. A worker never gets them. After `AgentManager.add` in a session of kind `session`, `<session>/AGENTS.md` contains the line `EGM artifact directory: <session path>/design`; after `add` in a session of kind `review`, it has no `## EGM` section (1.20) **[review v2 M-3]**.

##### 1.17 `packages/daemon/src/agents/lead.ts` (Modify)

*   **Type / Scope**: The `new` job of a paste session.
*   **Proposed Changes**:
    *   `LeadStartDeps` gains `egm?: EgmFetcher`. It is optional, because the route tests call `create_app` without a fetcher. When `deps.egm` is undefined, the EGM step below is skipped and nothing is logged **[review v2 M-1]**.
    *   Before `deps.agents.add`, when `deps.egm` is set: when `!deps.egm.status().subagents`, log `EGM unavailable: pi-subagents is not in the pi settings; the lead starts without it`. Else, when `!egm_fetched(deps.home)`, log `fetching EGM <sha12>` and `await deps.egm.ensure(log)`. On false, log `EGM unavailable: <error>; the lead starts without it`. On true, log `EGM ready`.
    *   `<sha12>` is the first 12 characters of `EGM_PIN.sha` everywhere in this design.

##### 1.18 `packages/daemon/src/agents/lead.test.ts` (Modify)

*   **Type / Scope**: Unit test.
*   **Proposed Changes**: A fetcher whose `ensure` resolves false still starts the lead and logs the reason. A fetcher whose status has `subagents: false` skips the fetch and logs the reason. A fetched home skips the fetch. Deps without `egm` start the lead and log no EGM line.

##### 1.19 `packages/daemon/src/server.ts` (Modify)

*   **Type / Scope**: Daemon wiring.
*   **Proposed Changes**:
    *   `AppDeps` gains `egm?: EgmFetcher`. It is optional, so the existing route tests that call `create_app` directly keep compiling.
    *   `create_app` calls `mount_egm_routes(app, { fetcher: deps.egm, jobs: deps.jobs })` when `deps.egm` is set.
    *   The daemon start (the `create_app({ … })` call in `start_daemon`, `packages/daemon/src/server.ts`) constructs one `new EgmFetcher(home, process.env)` and passes it to `create_app` as `egm`.
    *   The lead's deps are built inside `create_app`, in the `POST /sessions` handler: today `const lead_deps = { home: deps.home, ctx: deps.ctx, agents: deps.agents }`. It becomes `{ home: deps.home, ctx: deps.ctx, agents: deps.agents, ...(deps.egm === undefined ? {} : { egm: deps.egm }) }`. Build session 2 adds `design` and `writer` the same way (2.26) **[review v2 M-1]**.

##### 1.20 `packages/daemon/src/store/mission-template.ts` (Modify)

*   **Type / Scope**: The session `AGENTS.md`.
*   **Proposed Changes**: `AgentsFileInput` gains `egm?: boolean`, default false, so every existing caller compiles unchanged. When it is true and `input.path` is set, `render_agents_file` appends after the stack lines: `## EGM`, a blank line, `EGM artifact directory: <path>/design`, a blank line, and "EGM skills write their briefs, drafts and reports there. The design doc itself goes into the repo."
*   The caller that sets it is `AgentManager.write_agents_file` (1.15), which passes `path` already and rewrites the file before every agent start. `create_session` (`packages/daemon/src/store/session-store.ts`) is not changed: it passes no `path` and has no session kind, and its file is rewritten before the lead's first spawn **[review v2 M-3]**.
*   The result: every ordinary session has the lines whether or not EGM is fetched yet, and no review session has them.

##### 1.21 `packages/daemon/src/store/session-store.test.ts` (Modify)

*   **Type / Scope**: Unit test.
*   **Proposed Changes**: `render_agents_file` with `egm: true` and a path contains the exact artifact-directory line; with `egm: false` it has no `## EGM` section.

##### 1.22 `packages/pi-extension/src/env.ts` (Modify)

*   **Type / Scope**: Extension environment.
*   **Proposed Changes**:
    *   `SpinnerEnv` gains `egm_root: string | null` and `egm_artifacts: string | null`, read from `EXTENSION_ENV.egm_root` and `EXTENSION_ENV.egm_artifacts`, null when empty.
    *   `read_env` returns null when `env[SUBAGENT_CHILD_ENV] === "1"`. The comment says: a pi-subagents child must not register the Spinner tools, the prompt section or the tty channel.

##### 1.23 `packages/pi-extension/src/prompt.ts` (Modify)

*   **Type / Scope**: The `spinner_session` prompt section.
*   **Proposed Changes**: When `env.role === "lead"` and `env.egm_root !== null`, `render_prompt_section` appends these lines after the lead paragraph:

    ```text
    EGM (Elephant-Goldfish Model, Apache-2.0) is loaded. You are the Elephant.
    EGM plugin root: <egm_root>. EGM artifact directory: <egm_artifacts>.
    You run in pi, not Codex or Claude Code: read <egm_root>/docs/harnesses.md once.
    EGM skills are /skill:egm-<name>. The subagent tool is `subagent` (pi-subagents).
    The Goldfish are registered as egm-zoom-out, egm-design, egm-comprehension,
    egm-structural, egm-style, egm-implementation-readiness and egm-codebase-details.
    In this harness a Goldfish cannot spawn subagents: egm-synthesizer has no subagent
    tool. So use direct dispatch: launch each Goldfish yourself.
    Launch them with context "fresh" and the default async launch. Each result arrives
    as a completion message. Wait for every Goldfish of a stage, with bg_wait if needed,
    before you consolidate.
    ```

##### 1.24 `packages/pi-extension/src/extension.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: `register` returns null with `PI_SUBAGENT_CHILD=1` and a full Spinner env. A lead with `SPINNER_EGM_ROOT` gets the EGM lines; a worker does not; a lead without the variable does not.

##### 1.25 `packages/pi-extension/src/tty.ts` (Modify, only when probe P3 fails)

*   **Type / Scope**: The tty command handler.
*   **Proposed Changes**:
    *   Export `expand_skill(text: string, commands: SlashCommandInfo[]): string`. `SlashCommandInfo` is the extension's copy of pi's type (`packages/pi-extension/src/pi-api.ts`) **[review v2 N-2]**. When `text` starts with `/skill:<name>` and a command with `source: "skill"` and name `skill:<name>` or `<name>` has `sourceInfo.path`, return `Read the skill file at <path> and follow it in this thread. Arguments: <rest>` (the `Arguments:` part only when `rest` is not empty). Otherwise return `text`.
    *   `act` applies `expand_skill(text, pi.getCommands())` to `prompt` and `steer` texts.
    *   Add tests to `packages/pi-extension/src/tty.test.ts` (Modify) for both branches.
    *   When P3 passes, this entry and its test are not built, and the evidence file says so.

##### 1.26 `packages/daemon/e2e/egm-harness.ts` (Create)

*   **Type / Scope**: E2e driver with the real pi. Usage: `node packages/daemon/e2e/egm-harness.ts`.
*   **Proposed Changes**:
    *   Setup as `packages/daemon/e2e/chat-first.ts`: the built daemon, a scratch `SPINNER_HOME` from `mktemp -d`, a free port, the same scratch project. The EGM fetch runs through `POST /egm/fetch` first.
    *   Start a session with `POST /sessions { text: "Add a --version flag to the sandbox CLI", project }`.
    *   Read the lead's last assistant text after each `agent.settled` from `GET /sessions/:dir/agents/lead/events`.
    *   **P1**: prompt "List the names of all tools you can call, one per line, nothing else." Pass when a line is `subagent` and no line is `subagents_enable`.
    *   **P2a canary**: append a Log line `CANARY-<16 random hex>` through `PUT /sessions/:dir/mission/section` as `operator`. Prompt: "Call the subagent tool once with agent egm-zoom-out, context fresh, and this task: 'List every line of text in your context that contains the word CANARY. If there is none, answer NONE.' Then print the child's answer verbatim." Pass when the answer has no nonce.
    *   **P2b channel**: prompt "Reply with the word PONG and nothing else." Pass when `PONG` arrives within 60 seconds.
    *   **P2c negative write**: prompt "Call the subagent tool once with agent egm-zoom-out and the task: 'Create the file <scratch>/goldfish-write-probe.txt containing x. Report whether it worked.'" Pass when the file does not exist.
    *   **P3**: prompt `/skill:egm-brainstorm` through `POST /sessions/:dir/agents/lead/prompt`. Pass when the transcript's user entry for that turn contains `EGM Brainstorm: Interactive Multi-Lens Ideation`, or the lead's reply is a clarifying question about the concept. Record which one held.
    *   **P4**: prompt "Use the subagent tool's listing action and print the agent names and their source paths." Pass when `egm-zoom-out` is listed with a path under `<home>/egm/pi/agents`.
    *   **P11**: run brainstorm, draft and review, then **P5** and **P8**. Bound: 40 settled turns per skill, 60 minutes overall; past either bound, P11 fails with the skill and the turn count.
    *   P11 answers: after each settle, the driver takes the first row of the answer table below whose text the last assistant text contains. For a row whose answer is "the option", it sends the full option line of the last assistant text that starts with the given prefix, or the prefix itself when no such line exists.

        | Text contains | Answer sent |
        | --- | --- |
        | `Anchored feature hypothesis` | the option starting `Review with Goldfishes` |
        | `Select next step` | the option starting `Proceed to /egm-draft` |
        | `How would you like to proceed?` during the draft | the option starting `Approve` |
        | `Where should the design be saved?` | the option starting `Save to detected directory` |
        | `contradiction` | `Keep the draft's version.` |
        | any other text that ends with `?` during the brainstorm | `It is one CLI flag on the sandbox CLI. No other constraints. Success: the sandbox CLI's --version prints its package version.` |
        | any other text that ends with `?` during the draft | `Yes, go ahead.` |

    *   P11 skill ends: the brainstorm ends when `<session>/design/concepts_brief.md` exists and the "Select next step" answer is sent. If no `design_draft.md` exists 2 settled turns later, the driver sends `/skill:egm-draft`. The draft ends when `git -C <worktree> status --porcelain` lists a new `.md` file under `docs/designs/` other than `SITEMAP.md` and `README.md`. The driver then sends `/skill:egm-review <absolute doc path> Step: uninterrupted GoldfishContext: none`. The review ends when `<session>/design/consolidated_review_report.md` exists. P11 fails when the lead asks for a reading list during the review.
    *   **P5**: after the brainstorm, pass when `<session>/design/concepts_brief.md` exists and `git -C <worktree> status --porcelain` lists no `concepts_brief.md`, `design_draft.md` or `*_report.md`.
    *   **P8**: after the review, read every `<session>/egm-runs/async-subagent-runs/*/status.json`. Pass when no step's `agent` is `egm-synthesizer`.
    *   Output: one JSON record per probe (`id`, `pass`, `detail`) plus `pi --version`, the pi-subagents version from `<agent dir>/npm/node_modules/pi-subagents/package.json` when the file exists, the EGM sha, the session cost from `SessionView.cost.usd` at the end of each skill, the lead's token total per skill, and the wall time per skill. Write it to stdout and `<scratch>/egm-evidence.json`.
    *   Stop the scratch daemon and every pi it started before exit.

##### 1.27 `docs/egm/HARNESS_EVIDENCE.md` (Create)

*   **Type / Scope**: Documentation, evidence record.
*   **Proposed Changes**: The date, pi version, pi-subagents version, EGM sha, and one row per probe (P1, P2a, P2b, P2c, P3, P4, P5, P8, P11) with pass or fail and the detail. The cost, the lead's tokens and the wall time of each skill in P11. Which branch of entry 1.25 was built. A table of A3's checklist C1 to C16 (C1 whole-plugin install, C2 skills as commands, C3 plugin-root paths, C4 a fresh-context subagent tool, C5 named personas, C6 host-enforced read-only reviewers, C7 no parent context, C8 required reads, C9 report as text, C10 nesting or direct dispatch, C11 parallel reviewers, C12 artifact directory, C13 one-question gates, C14 design-only scope, C15 feedback on the artifact, C16 evidence), each with `met`, `not met` or `partly met` and the probe or file that shows it.

##### 1.28 `packages/cli/src/commands/doctor.ts` (Modify)

*   **Type / Scope**: CLI.
*   **Proposed Changes**: One line after the diff viewer line: `egm: <sha12> fetched <date> (adapter v<n>)` when `egm_fetched`, else `egm: not fetched (Spinner fetches it when a lead starts, or: POST /egm/fetch)`. A second line `pi-subagents: installed` or `pi-subagents: not in <settings path>; EGM stays off`. Export `egm_fetched`, `read_egm_marker` and `subagents_installed` from `packages/daemon/src/index.ts` (Modify) for the CLI.

##### 1.29 `packages/cli/src/commands/doctor.test.ts` (Modify)

*   **Type / Scope**: Unit test.
*   **Proposed Changes**: Both EGM lines and both pi-subagents lines with a scratch home and a scratch `PI_CODING_AGENT_DIR`.

##### 1.30 `docs/ARCHITECTURE.md` (Modify)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**: A section "EGM (Elephant-Goldfish Model)": `EGM_NOTICE` with the source URL; the `~/.spinner/egm/` layout; the adapter kinds; the lead's spawn arguments table; the isolation layers; a link to `docs/egm/HARNESS_EVIDENCE.md`.

##### 1.31 `docs/DAEMON_API.md` (Modify)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**: `GET /egm` and `POST /egm/fetch` with their bodies.

##### 1.32 `README.md` (Modify)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**: A "Credits" section: "The design workflow runs Google's Elephant-Goldfish Model (EGM, Apache-2.0, https://github.com/google/elephant-goldfish-model) from a pinned copy that Spinner fetches. EGM is not an officially supported Google product."

##### 1.33 `packages/protocol/schema/job.json` (Modify)

*   **Type / Scope**: Generated JSON schema.
*   **Proposed Changes**: After 1.3, regenerate with `pnpm --filter @spinner/protocol schema` and commit every changed file under `packages/protocol/schema/`. No hand edits.

##### 1.34 `docs/designs/SITEMAP.md` and `docs/designs/egm-adoption.md` (Create) **[D13]**

*   **Type / Scope**: Documentation, the living spec.
*   **Proposed Changes**: `egm-adoption.md` is this design doc as the operator approved it, copied verbatim. `SITEMAP.md` has one table (Link, Date, Author, Components, Description) with one row for it. Because the file is on the base branch, later Spinner sessions cannot name it as their own design doc (Technical Plan T7).

##### 1.35 `packages/ui/src/remote.ts` (Modify)

*   **Type / Scope**: UI client.
*   **Proposed Changes**: `fetchEgm(signal): Promise<EgmResponse>` for `GET /egm`. The fetch button uses the existing `postAction("/egm/fetch")` from `packages/ui/src/events-client.ts`.

##### 1.36 `packages/ui/src/AboutEgm.tsx` (Create)

*   **Type / Scope**: React component.
*   **Proposed Changes**: A block titled "About EGM": `EGM_NOTICE`; the source URL as a link; `pinned a119668d7dc5` (the first 12 characters); the license; the state line from `egmLine(status)`; a `fetch` button when the state is `absent` or `failed`. The block loads with `useLoaded` (`packages/ui/src/remote.ts`) under the key `egm#<id of the last egm job>#<state of that job>`. The key changes when a `job.finished` event for an `egm` job arrives, so the block reloads after the fetch.

##### 1.37 `packages/ui/src/about-egm.ts` and `packages/ui/src/about-egm.test.ts` (Create)

*   **Type / Scope**: Pure helper and its test.
*   **Proposed Changes**: `egmLine(status: EgmStatus): string`: `ready · fetched <date>`, `fetching…`, `failed: <error>`, `not fetched`; plus ` · pi-subagents missing` when `subagents === false`. One test per state.

##### 1.38 `packages/ui/src/SettingsPane.tsx` (Modify)

*   **Type / Scope**: React component.
*   **Proposed Changes**: Render `<AboutEgm />` as the last block of the pane.

##### 1.39 `packages/ui/fixture/server.ts` and `packages/ui/fixture/data.ts` (Modify)

*   **Type / Scope**: UI dev fixture.
*   **Proposed Changes**: Serve `GET /egm` with a `ready` status and accept `POST /egm/fetch` with a finished job.

#### Build session 2: `egm-design-stage`, design facts, the `design` block, the stepper

Goal: a design-track session shows its EGM step in the context bar and on its card, derived from files, and the lead names its design doc. Every session records its rounds and shows a round badge from round 2.
Sizes: `engine` about 4 hours, `ui` about 3 hours.

##### 2.1 `packages/protocol/src/egm.ts` (Modify)

*   **Type / Scope**: Protocol types.
*   **Proposed Changes**:
    *   `DESIGN_STAGES = ["intake", "brainstorm", "drafting", "drafted", "design-review", "resolving", "design-ready", "approved"] as const`; `type DesignStage`.
    *   `DESIGN_TRACKS = ["design", "direct"] as const`; `type DesignTrack`.
    *   `REVIEW_STAGE_REPORTS = { "5": "zoom_out_report.md", "6": "comprehension_report.md", "7": "critic_report.md", "8": "intermediate_zoom_out_report.md", "9": "implementation_readiness_report.md" } as const`; `type ReviewStageId = keyof typeof REVIEW_STAGE_REPORTS`.
    *   `BRIEF_FILE = "concepts_brief.md"`, `DRAFT_FILE = "design_draft.md"`, `CONSOLIDATED_REPORT = "consolidated_review_report.md"`, `RESOLVE_REPORT = "goldfish_review_report.md"`, `APPROVED_COPY = "approved.md"`, `DESIGN_STATE_FILE = ".state.json"`, `REVIEW_ARCHIVE_DIR = "reviews"`.
    *   `REVIEW_REPORT_FILES`: the five `REVIEW_STAGE_REPORTS` values, `CONSOLIDATED_REPORT` and `RESOLVE_REPORT`.
    *   `REVIEW_PRESETS = ["interactive", "uninterrupted", "feature_spec", "implementation"] as const`; `type ReviewPreset`.
    *   `interface DesignGate { question: string; options: string[]; asked: string }`.
    *   `interface DesignApproval { path: string; repo: string; sha256: string; at: string; blockers: number; round: number }`. `DESIGN_APPROVALS_MAX = 100`.
    *   `interface DesignReviewRun { id: string; preset: ReviewPreset | null; started: string }`.
    *   `interface DesignState { track: DesignTrack; stage?: DesignStage; needs?: string | null; waiting?: boolean; doc?: string; repo?: string; review_run?: DesignReviewRun; gate?: DesignGate; approved?: DesignApproval; approvals?: DesignApproval[]; changed_after_approval?: boolean }`.
    *   `interface DesignFileView { name: string; bytes: number; mtime: string }`.
    *   `type GoldfishState = "queued" | "running" | "done" | "failed" | "stopped"`. `interface GoldfishView { run: string; step: number; agent: string; persona: string | null; state: GoldfishState; model: string | null; tokens: number; usd: number; started: string | null; last_activity: string | null; design_step: "brainstorm" | "draft" | "review" | "build" | null; transcript: boolean }`. Build session 4 fills them.
    *   `interface DesignView { track: DesignTrack; stage: DesignStage | null; files: DesignFileView[]; reviews: Record<ReviewStageId, boolean>; consolidated: boolean; resolve: "none" | "open" | "resolved"; review_run: DesignReviewRun | null; doc: string | null; doc_missing: boolean; approved: DesignApproval | null; approvals: DesignApproval[]; changed_after_approval: boolean; gate: DesignGate | null; goldfish: GoldfishView[]; goldfish_live: number; cost_by_stage: Partial<Record<"brainstorm" | "draft" | "review" | "build", number>> }`. `stage` is null outside the design track. `reviews`, `consolidated` and `resolve` describe the current review run. Until build session 4, `goldfish` is `[]`, `goldfish_live` is 0 and `cost_by_stage` is `{}`.
    *   `interface DesignTrackRequest { track: DesignTrack }`. `interface DesignDocRequest { path: string }`.
    *   `DESIGN_DEFAULT_DIR = "docs/designs"`. `DESIGN_FILES_MAX = 200`.
    *   `DESIGN_DEFAULT_TRACK: DesignTrack = "direct"`, with the doc comment "The track a new paste session gets when EGM is ready. Build session 3 changes it to `design` (3.1), in the same release as the lead brief that knows the design track." **[review v2 M-7]**

##### 2.2 `packages/protocol/src/session.ts` (Modify)

*   **Type / Scope**: `session.yaml` types.
*   **Proposed Changes**: `Session` gains `design?: DesignState` with the doc comment: "Absent means a session from before the EGM design. `SESSION_VERSION` stays 1."

##### 2.3 `packages/protocol/src/api.ts` (Modify)

*   **Type / Scope**: Routes and the view.
*   **Proposed Changes**:
    *   `SessionView.design?: DesignView`.
    *   `ROUTES["PUT /sessions/:dir/design/track"] = "SessionResponse"`, doc comment "Body: DesignTrackRequest. 409 once a repo has commits, and 409 for `design` when EGM is not available."
    *   `ROUTES["PUT /sessions/:dir/design/doc"] = "SessionResponse"`, doc comment "Body: DesignDocRequest. The lead's `design_doc` tool. 400 with the reason when the path is not a design doc; 409 while an approval stands."

##### 2.4 `packages/protocol/src/pipeline.ts` (Modify)

*   **Type / Scope**: Stage facts.
*   **Proposed Changes**: `PipelineFacts.design?: { stage: DesignStage; needs: string | null }`, present only for the `design` track.

##### 2.5 `packages/protocol/src/stack-spec.ts` and `docs/STACK_SPEC.md` (Modify) **[D3]**

*   **Type / Scope**: Project spec.
*   **Proposed Changes**: `StackSpec.designs?: { repo?: string; dir?: string }` with the defaults "the first repo" and `docs/designs`. The project-spec validation is `check_spec_shape` in `packages/daemon/src/stack/spec.ts` (Modify). It rejects a `designs` value that is not a mapping, a `designs.repo` or `designs.dir` that is not a non-empty string, and a `designs.repo` that is not a key of `repos`, with the message `designs.repo "<key>" is not a repo of this project`. Tests in `packages/daemon/src/stack/spec.test.ts` (Modify): a spec without `designs` passes; a valid `designs` passes; each rejection returns its message **[review v2 N-3]**. The doc gains the key with one example.

##### 2.6 `packages/protocol/src/extension.ts` (Modify) **[review B2]**

*   **Type / Scope**: The tool manifest.
*   **Proposed Changes**: `EXTENSION_TOOLS` gains `"design_doc"`. `ExtensionToolArgs.design_doc = { path: string }`. The manifest entry: description "Name the design doc you just wrote, by its absolute path. Call it once the draft's final file is written in the designs directory. Spinner tracks, reviews and approves this file."; parameter `path` (string, "The absolute path of the design doc"); required `path`; roles `LEAD`; route `PUT /sessions/:dir/design/doc`.

##### 2.7 `packages/pi-extension/src/tools.ts` (Modify)

*   **Type / Scope**: Tool implementation.
*   **Proposed Changes**: A `case "design_doc"` in `run_tool` sends `PUT /sessions/:dir/design/doc { path }`. It returns `Spinner tracks <path> as the design doc.` on 200 and the daemon's error text otherwise.

##### 2.8 `packages/pi-extension/src/lead.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: `design_doc` sends the body and returns the daemon's error text on a 400; the tool is absent for a worker.

##### 2.9 `packages/daemon/src/egm/derive-design.ts` (Create)

*   **Type / Scope**: Pure function.
*   **Proposed Changes**:
    *   `interface DesignInput { files: string[]; resolve_first_line: string | null; doc: string | null; doc_hash: string | null; doc_missing: boolean; approved: DesignApproval | null; review_run: DesignReviewRun | null; gate: DesignGate | null; waiting: boolean; lead_busy: boolean; goldfish_running: number }`. `files` are the names directly in `<session>/design/`. `resolve_first_line` is the first non-empty line of the resolve report, trimmed.
    *   `derive_design(input): { stage: DesignStage; needs: string | null; changed_after_approval: boolean; reviews: Record<ReviewStageId, boolean>; consolidated: boolean; resolve: "none" | "open" | "resolved" }`.
    *   The stage follows the rule table of Technical Plan T7, rows 1 to 8. `needs` follows the `needs_human` list of T7. Needs line 1 (an open gate) applies at every stage, including `approved`; lines 2 to 7 apply only when the stage is not `approved`; at `approved` without a gate `needs` is null **[review v2 N-9]**. `gate`, `waiting`, `lead_busy` and `goldfish_running` are inputs now; build sessions 3 and 4 fill them.
    *   `normalized_doc_hash(text: string): string`: SHA-256 hex after removing the line that matches `^\*\s+\*\*Status:\*\*` and turning `\r\n` into `\n`.
    *   An assertion guards `files.length <= DESIGN_FILES_MAX`.

##### 2.10 `packages/daemon/src/egm/derive-design.test.ts` (Create)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: One fixture per stage row and one per `needs` line, including a changed approved doc (stage `design-ready`, `changed_after_approval: true`), a missing doc with an approval (the missing-doc line, `changed_after_approval: true`) and a stage 8 report with `preset: "feature_spec"`, with `preset: "interactive"` and with no `review_run`. `normalized_doc_hash` is equal for two texts that differ only in the `Status:` line and in `\r\n`.

##### 2.11 `packages/daemon/src/egm/design-doc.ts` (Create) **[review B2]**

*   **Type / Scope**: TypeScript module, the check behind `design_doc`.
*   **Proposed Changes**: `check_design_doc(input: { path: string; worktree: string; designs_dir: string; base: string; current: string | null; runner: Runner }): Promise<string | null>` returns the refusal text or null. In order:
    1.  `the path must be absolute` unless `isAbsolute(path)`.
    2.  `the design doc must be a .md file directly in <designs_dir>` unless `dirname(path) === designs_dir` and the name ends with `.md`.
    3.  `SITEMAP.md and README.md are not design docs` for those names.
    4.  `no file at <path>` when it does not exist; `the file is larger than 1 MB` past 1,048,576 bytes.
    5.  `a design doc has ## Overview and ## Detailed Implementation Plan headings; this file lacks <missing>` when a heading is missing. This refuses a concepts brief that `egm-brainstorm` published as an RFC.
    6.  `<relative path> already exists on origin/<base>; a session names a new doc` when `git -C <worktree> cat-file -e origin/<base>:<relative path>` exits 0 and the path is not the session's current `design.doc` (input `current: string | null`, repo-relative). The call has a 10-second bound; past it the refusal is `git did not answer in 10 seconds`.

##### 2.12 `packages/daemon/src/egm/design.ts` (Create)

*   **Type / Scope**: The design tracker.
*   **Proposed Changes**:
    *   `class DesignTracker { constructor(deps: { home: SpinnerHome; cwd: string; agents: AgentManager; bus: EventBus; writer: MissionWriter; refresh: (dir: string) => Promise<void>; log: Log; runner?: Runner }) }`. `cwd` is the daemon's `ActionContext.cwd`, for `config_for_session` **[review v2 B-1]**. `writer` is the daemon's one `MissionWriter`, for the Goal pointer of `set_doc` **[review v2 N-10]**. Build session 4 adds two fields (4.8).
    *   `designs_of(summary): { repo: string; worktree: string; dir: string }`: the designs repo and dir from the project spec (`designs`, else the first repo key and `DESIGN_DEFAULT_DIR`); `dir` is absolute inside the repo's worktree.
    *   `refresh(dir)`, in this order:
        1.  Read the session with `read_session`. Return without a `design` block.
        2.  On track `design`: list `<session>/design/*.md` without dotfiles; past `DESIGN_FILES_MAX` keep the newest by modification time and log one line. Read the doc when `design.doc` is set, and hash it; a missing file sets `doc_missing: true` and `doc_hash: null`. Call `derive_design`, and set `design.stage`, `design.needs`, `design.changed_after_approval` and `design.waiting` on a copy of the session from its result. On track `direct`, skip this step; the copy keeps its `design` fields, which `facts_from_session` ignores off the design track (2.16).
        3.  Re-derive the pipeline fields on the copy: `const refreshed = refresh_session(read.summary.session, copy, config_for_session(read.summary, deps.home, deps.cwd, deps.log), new Date())` (`packages/daemon/src/pipeline/tracker.ts`, `packages/daemon/src/pipeline/poller.ts`). This sets `session.stage` and `session.needs_human` from `derive_stage(facts_from_session(session, config, now))`, which now carries the design facts (2.16, 2.17) **[review v2 B-1]**. It is the same call that `pipeline/pr.ts` and `pipeline/reset.ts` make, and it replaces the `create_session` text `write Goal and Done when in MISSION.md` on the first refresh. The tracker ignores `refreshed.transition`; a design write changes no pipeline stage that the poller reports.
        4.  When any of `design.stage`, `design.needs`, `design.changed_after_approval`, `design.waiting`, `session.stage` or `session.needs_human` differs from the read in step 1, write `{ ...read.summary, session: refreshed.session }` with `write_session`.
        5.  Write `<session>/design/.state.json` `{ track, stage, approved, designs_dir }` on both tracks, only when its content changed. `stage` is `design.stage ?? null`. `approved` is `design.approved !== undefined && design.changed_after_approval !== true`. `designs_dir` is absolute. A switch to `direct` therefore rewrites the file with `track: "direct"`, and the guard (6.13) and the prompt lines (3.6) stop applying **[review v2 M-4]**.
        6.  Call `deps.refresh(dir)` when step 4 or step 5 wrote.
    *   Every write of the design block outside `refresh` (`set_doc`, `set_gate`, `clear_gate`, the review-run record of 3.9, `approve_design`, `clear_approval`) is followed by `refresh(dir)`, so `session.needs_human` is re-derived after each one.
    *   `set_doc(dir, path): Promise<SessionSummary>`: 409 `the design is approved; clear the approval first` when `design.approved` exists and `changed_after_approval` is not true; else `check_design_doc` with `base: repo_base(summary, <designs repo>)` (`packages/daemon/src/pipeline/pr.ts`), because each repo of a multi-repo project can have its own base **[review v2 N-8]**; on null, write `design.doc` (repo-relative) and `design.repo`, replace the Goal through `deps.writer.write(dir, { section: "goal", mode: "replace", author: "spinner", text: "The design doc holds the goal: `<repo>/<design.doc>`." })` **[review v2 N-10]**, start the doc watcher, and `refresh(dir)`.
    *   `view(summary): DesignView | undefined`: the same reads, without writes, for `build_session_view`. A session with track `direct` gets a view with `stage: null` and its `files`.
    *   The doc watcher: one chokidar watcher per design session on the doc file, with `awaitWriteFinish` 100 ms; each event calls `refresh(dir)`. At most 100 watched sessions; past 100, the tracker refreshes that session only on `agent.settled` and logs one line.
    *   Bus subscriptions in the constructor: `agent.settled` of the agent `lead` calls `refresh(dir)`; `session.closed` stops the doc watcher.
    *   `prime()`: on daemon start, start the doc watcher and `refresh` every session with a `design` track.

##### 2.13 `packages/daemon/src/egm/design.test.ts` (Create)

*   **Type / Scope**: Unit tests with a scratch home and a scratch git repo.
*   **Proposed Changes**: Writing `concepts_brief.md` moves the stage to `brainstorm`; a draft to `drafting`; `set_doc` with a valid new doc sets `design.doc` and `drafted`; each refusal of `check_design_doc` (relative path, wrong dir, `SITEMAP.md`, missing file, a brief without the headings, a doc that exists on `origin/<base>`); the same base-branch doc is accepted when it is the current `design.doc`; `set_doc` replaces the Goal of `MISSION.md` with the pointer to the doc; `.state.json` matches, including `approved: false` after a change following approval.
    *   `session.needs_human` after `refresh`, read back from `session.yaml` **[review v2 B-1]**: a new session (text `write Goal and Done when in MISSION.md` from `create_session`) at stage `intake` gets null; at `drafted` it is `review the design`; at `design-ready` it is `approve the design`; after a change following approval it is `re-approve the design (changed since approval)`. `session.stage` stays `planned` in each case.
    *   Switching a session from `design` to `direct` and calling `refresh` rewrites `.state.json` with `track: "direct"` and sets `session.needs_human` to the pipeline's own value (null for a session without commits) **[review v2 M-4]**.

##### 2.14 `packages/daemon/src/watch/session-files.ts` (Modify) **[review M20]**

*   **Type / Scope**: The existing session-files watcher.
*   **Proposed Changes**: `SessionFileHandlers` gains `on_design(dir: string, file: string): void`. `route` calls it when `parts.length === 3`, `parts[1] === "design"` and the name does not start with `.`. `SKIPPED` gains `"egm-runs"`, because the Goldfish watcher polls that tree on purpose (4.4) and the existing watcher would only stat its temp files.

##### 2.15 `packages/daemon/src/watch/live.test.ts` (Modify)

*   **Type / Scope**: Unit test of the session-files watcher.
*   **Proposed Changes**: A write to `<session>/design/concepts_brief.md` calls `on_design`; a write to `<session>/design/.state.json` does not; a write under `<session>/egm-runs/` calls nothing.

##### 2.16 `packages/daemon/src/pipeline/tracker.ts` (Modify)

*   **Type / Scope**: Facts.
*   **Proposed Changes**: `facts_from_session` sets `design: { stage, needs }` when `session.design?.track === "design"` and `session.design.stage` is set.

##### 2.17 `packages/daemon/src/pipeline/derive-stage.ts` (Modify)

*   **Type / Scope**: Stage derivation.
*   **Proposed Changes**: `with_design(facts, result)`, applied after `with_diff_comments` and before `with_review_draft`. When `facts.design` is set and its stage is not `approved`, `needs_human` becomes `facts.design.needs` when that is not null. When the stage is `approved`, `facts.design.needs` fills `needs_human` only when the result's is null. That branch is live: a gate during the build gives `needs` an `answer the lead` text. The doc comment cites Technical Plan T7.

##### 2.18 `packages/daemon/src/pipeline/derive-stage.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: Fixtures for both branches of `with_design`, and one where a review draft still wins.

##### 2.19 `packages/daemon/src/views/session-view.ts` (Modify)

*   **Type / Scope**: The view.
*   **Proposed Changes**: `ViewContext.design?: (summary: SessionSummary) => DesignView | undefined`. `build_session_view` adds `design` when the function returns a value.

##### 2.20 `packages/daemon/src/actions.ts` (Modify) **[D1]**

*   **Type / Scope**: Shared actions.
*   **Proposed Changes**:
    *   `set_design_track(ctx: ActionContext, writer: MissionWriter, summary: SessionSummary, track: DesignTrack, egm: EgmStatus): Promise<SessionSummary>` writes `design.track` (creating the block) and resolves to the read-back summary. It is async and takes the writer as a parameter, because `ActionContext` has no mission writer (`packages/daemon/src/actions.ts`) and `MissionWriter.write` returns a Promise **[review v2 M-1]**. Its callers are 2.23 and the track route of 2.24; each passes the daemon's one `MissionWriter`.
    *   It throws `the build has started; the track is fixed` when a track is set and any repo of `summary.session.repos` has `changed: true` (the field that the pipeline sets once a worktree has commits beyond its base).
    *   It throws `EGM is not available: <reason>` for `design` when `egm.state !== "ready"` (reason: the state and `error`) or `egm.subagents` is false (reason: `pi-subagents is not installed`).
    *   On `design`, it awaits two `writer.write` calls as author `spinner`, with `mode: "replace"`: Goal replaced by `The design doc holds the goal. Spinner names it here once the lead calls design_doc.`, and Done when set to the one item `The design is approved and every Plan item is ticked.`

##### 2.21 `packages/daemon/src/store/mission-writer.ts` (Modify) **[D6]**

*   **Type / Scope**: The serialized writer.
*   **Proposed Changes**: Before each write, `MissionWriter.write` reads the session with `read_session(this.home, dir)`. When `design.track === "design"`, the section is `goal` or `done_when`, and the author is not `spinner`, it refuses with `this session's spec is the design doc (<design.doc or "not named yet">)`. The route answers 400 with that text, as for every refused request.

##### 2.22 `packages/daemon/src/store/mission-writer.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: On a design-track session, `lead` cannot write `goal` or `done_when` and can write `plan`, `log` and `roster`; `spinner` can write `goal`. On a direct-track session and on a session without a `design` block, `lead` can write `goal`.

##### 2.23 `packages/daemon/src/agents/lead.ts` (Modify) **[D1] [D12]**

*   **Type / Scope**: The `new` job.
*   **Proposed Changes**:
    *   `LeadStartDeps` gains `design?: DesignTracker` and `writer?: MissionWriter`, both optional like `egm` (1.17), so the route tests keep compiling **[review v2 M-1]**. `create_app` passes `design: deps.design` and `writer: deps.writer` into `lead_deps` when they are set (2.26).
    *   When `deps.egm`, `deps.design` and `deps.writer` are all set, after the EGM step of 1.17: the track is `DESIGN_DEFAULT_TRACK` (2.1) when `deps.egm.status()` is `ready` with `subagents: true` and `adopt.length === 0`; else `direct`. Call `await set_design_track(deps.ctx, deps.writer, summary, track, deps.egm.status())`, log `track: <track>`, then `await deps.design.refresh(dir)`. When any of the three is unset, write no `design` block; the session behaves as a session from before this design.
    *   In build session 2, `DESIGN_DEFAULT_TRACK` is `direct`, so every new paste session starts on the direct track. The operator can pick `design` on the track chip to try the stepper; the lead brief for the design track arrives in build session 3, which flips the constant (3.1) **[review v2 M-7]**.
    *   Tests in `packages/daemon/src/agents/lead.test.ts` (Modify): with a ready fetcher and `DESIGN_DEFAULT_TRACK` set to `direct`, the session gets `design.track: direct` and the log line `track: direct`; with adopted PRs, `direct`; with a fetcher in state `failed`, `direct`; without `design` in the deps, no `design` block.

##### 2.24 `packages/daemon/src/egm/routes.ts` (Modify)

*   **Type / Scope**: Routes.
*   **Proposed Changes**:
    *   `EgmRouteDeps` becomes `{ fetcher: EgmFetcher; jobs: JobRunner; design: DesignTracker; ctx: ActionContext; view: ViewBuilder; writer: MissionWriter }`. The track route passes `writer` to `set_design_track` **[review v2 M-1]**.
    *   `PUT /sessions/:dir/design/track`: parse `DesignTrackRequest`; 400 for an unknown track; 409 with the `set_design_track` message; then `design.refresh(dir)`; answer with the session view.
    *   `PUT /sessions/:dir/design/doc`: parse `DesignDocRequest`; 404 for an unknown session; 409 without a `design` block of track `design`; `design.set_doc`; 400 with the refusal text, 409 with the approval text; answer with the session view.

##### 2.25 `packages/daemon/src/egm/routes.test.ts` (Create)

*   **Type / Scope**: Route tests through `create_app` with a scratch home.
*   **Proposed Changes**: The track route's 200, 400 and both 409s; the doc route's 200, a 400 per refusal kind, and the 409; `GET /egm` returns a status.

##### 2.26 `packages/daemon/src/server.ts` (Modify)

*   **Type / Scope**: Wiring.
*   **Proposed Changes**:
    *   `AppDeps` gains `design?: DesignTracker`. `create_app` mounts the EGM routes only when `egm`, `design` and `writer` are all set, and passes `writer: deps.writer` into `EgmRouteDeps`. `AppDeps.writer` exists today (the agent routes use it).
    *   In the `POST /sessions` handler, `lead_deps` gains `...(deps.design === undefined ? {} : { design: deps.design })` and `...(deps.writer === undefined ? {} : { writer: deps.writer })`, next to the `egm` field of 1.19 **[review v2 M-1]**.
    *   In `start_daemon`, in this order: declare `let design: DesignTracker | null = null` before `view_ctx`; set `view_ctx.design = (summary) => design?.view(summary)`, a late-bound closure, because `view_ctx` is built before `refresh`. After `refresh` is defined, construct `design = new DesignTracker({ home, cwd, agents, bus, writer, refresh, log })`, with the `writer` that `start_daemon` already builds for the `Deliverer`. Pass `design` to `create_app`.
    *   Pass `on_design: (dir) => void design?.refresh(dir)` to `watch_session_files`. Call `await design.prime()` after `agents.adopt_all()`.

##### 2.27 `packages/protocol/schema/session.json`, `session-view.json`, `stack-spec.json` (Modify)

*   **Type / Scope**: Generated JSON schemas.
*   **Proposed Changes**: After 2.1 to 2.5, 2.39 and 2.40, regenerate with `pnpm --filter @spinner/protocol schema` and commit every changed file. No hand edits.

##### 2.28 `packages/cli/src/commands/show-format.ts` and `packages/cli/src/commands/__snapshots__/show-format.test.ts.snap` (Modify)

*   **Type / Scope**: CLI output.
*   **Proposed Changes**: A line `design: <track> · <stage or ->` when the block exists. Update the snapshot.

##### 2.29 `docs/SESSION_PROTOCOL.md` and `docs/DAEMON_API.md` (Modify)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**: The `design` block in the `session.yaml` section with each field; the design stage table; the refusal of Goal and Done when on the design track; the `design_doc` tool; the track and doc routes.

##### 2.30 `packages/ui/src/design.ts` (Create)

*   **Type / Scope**: Pure UI helpers.
*   **Proposed Changes**:
    *   `type StepState = "todo" | "active" | "waiting" | "done"`.
    *   `designSteps(design: DesignView, needs: string | null): { id: "brainstorm" | "draft" | "review" | "approve" | "build"; label: string; state: StepState; dots?: boolean[] }[]`, following the stepper table of Technical Plan T7. An active step becomes `waiting` when `needs` is not null. `drafted` has no active step.
    *   `compactLabel(steps)`: `EGM <n>/5 <label>` for the first step that is not done.
    *   `trackChoices(egm: EgmStatus | null): DesignTrack[]`: `["design", "direct"]` when `egm?.state === "ready"` and `egm.subagents`, else `["direct"]`.

##### 2.31 `packages/ui/src/design.test.ts` (Create)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: One case per design stage, the waiting case, `compactLabel`, and `trackChoices` for ready, not ready and no pi-subagents.

##### 2.32 `packages/ui/src/DesignStepper.tsx` (Create)

*   **Type / Scope**: React component.
*   **Proposed Changes**: Renders the `EGM` label with `title={EGM_NOTICE}`, the five steps with their state classes and the Review dots, then the pipeline stage as a pill. Under `TOOLBAR_COMPACT_PX` (`packages/ui/src/SessionToolbar.tsx`) it renders `compactLabel` with the full text in `title`. Props: `design`, `stage`, `needs`, `onStep?: (id) => void` (wired in build session 5).

##### 2.33 `packages/ui/src/PaneHead.tsx` (Modify)

*   **Type / Scope**: The context bar.
*   **Proposed Changes**: In `ContextBar`, when `view.design?.track === "design"`, render `DesignStepper` in place of `<span className="badge">{stageOf(view)}</span>`. When `view.design` exists, render a `TrackChip`: the track name and a menu of `trackChoices(egm)` without the current track, where `egm` comes from `fetchEgm` (1.35). A pick calls `putDesignTrack` and shows a failure in the drawer. An empty menu shows no chevron.

##### 2.34 `packages/ui/src/SessionsPane.tsx` (Modify)

*   **Type / Scope**: Session cards.
*   **Proposed Changes**: `SessionCard` shows five dots from `designSteps` for a design track, without labels, after the stage badge.

##### 2.35 `packages/ui/src/remote.ts` (Modify)

*   **Type / Scope**: UI client.
*   **Proposed Changes**: `putDesignTrack(dir, track): Promise<SessionResponse>`.

##### 2.36 `packages/ui/src/styles.css` (Modify)

*   **Type / Scope**: Styles.
*   **Proposed Changes**: `.egm-stepper`, `.egm-step` with `data-state` variants using the existing accent, warn and muted variables, `.egm-dots`, `.card-dots`. The stepper must not wrap the context bar at 1000 px; the compact form applies under `TOOLBAR_COMPACT_PX`.

##### 2.37 `packages/ui/fixture/data.ts` and `packages/ui/fixture/server.ts` (Modify)

*   **Type / Scope**: UI dev fixture.
*   **Proposed Changes**: One session per design stage (8 sessions) with `design` views, one `direct` session, one session without a `design` block; `PUT /sessions/:dir/design/track` answers with the updated view.

##### 2.38 `packages/ui/e2e/drive.ts` (Modify)

*   **Type / Scope**: UI e2e driver against the fixture.
*   **Proposed Changes**: Assert the stepper text for the `design-review` session and the compact label at a window width of `TOOLBAR_COMPACT_PX - 100` (1100 px).

##### 2.39 `packages/protocol/src/session.ts` (Modify)

*   **Type / Scope**: `session.yaml` types for rounds.
*   **Proposed Changes**: `interface RoundPr { repo: string; number: number; url: string | null; state: PrState; merged_at: string | null }`. `interface RoundRecord { round: number; branch: string; prs: RoundPr[]; started: string | null; ended: string | null }`. `Session.rounds?: RoundRecord[]`, doc comment "Earlier rounds, oldest first, appended by `reset` since the EGM design. Rounds before that are only in `## Previous rounds` of MISSION.md." `ROUNDS_MAX = 200`.

##### 2.40 `packages/protocol/src/api.ts` (Modify)

*   **Type / Scope**: The view and one route.
*   **Proposed Changes**: `interface RoundView extends RoundRecord { source: "record" | "mission" }`. `SessionView.round: number` and `SessionView.rounds: RoundView[]` (oldest first; empty in round 1). `ROUTES["GET /sessions/:dir/rounds/:round/log"] = "text/markdown"`: the round's Log from `## Previous rounds`; 404 for a round without one.

##### 2.41 `packages/daemon/src/pipeline/rounds.ts` (Create)

*   **Type / Scope**: Pure functions.
*   **Proposed Changes**:
    *   `round_of(session: Session): number`: `session.round`, else the number of a `-r<n>$` branch suffix, else 1.
    *   `parse_previous_rounds(mission: string): { round: number; branch: string; prs: { repo: string; number: number; state: PrState }[]; log: string }[]`: one entry per `### Round <n> · <branch> · PRs: <list>` heading under `## Previous rounds` (`split_mission`); the list is `none` or `<repo>#<number> (<state>)` items separated by `, `; `log` is the text up to the next `### ` heading. A heading that does not match is skipped. At most `ROUNDS_MAX` entries; past that the oldest are dropped.
    *   `rounds_of(session: Session, mission: string | null): RoundView[]`: every `session.rounds` record with `source: "record"`, plus each parsed round whose number has no record, with `url`, `merged_at`, `started`, `ended` null and `source: "mission"`; sorted by round.
    *   `round_record(previous: Session, ended: Date): RoundRecord`: the round `round_of(previous)`, the branch, `session_prs(previous)` mapped to `RoundPr` (`merged_at` = `last_activity` when `state === "merged"`, else null), `started` = the last record's `ended`, else `previous.created`, and `ended`.

##### 2.42 `packages/daemon/src/pipeline/rounds.test.ts` (Create)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: `round_of` for each source; `parse_previous_rounds` on the exact text `archive_round` writes (one round, two rounds, `PRs: none`, a bad heading); `rounds_of` merging a record for round 2 with a parsed round 1; `round_record` with a merged and a closed PR.

##### 2.43 `packages/daemon/src/pipeline/reset.ts` (Modify)

*   **Type / Scope**: Reset.
*   **Proposed Changes**: In `reset_session`, before the PR facts are cleared, append `round_record(previous, now())` to `session.rounds`. Past `ROUNDS_MAX`, the oldest record drops; its Log stays in `## Previous rounds`. The `design` block is not touched (Technical Plan T14). The header comment gains: "The round's PRs are also recorded in `session.yaml` `rounds`."

##### 2.44 `packages/daemon/src/pipeline/land.test.ts` (Modify)

*   **Type / Scope**: The existing reset tests.
*   **Proposed Changes**: After a reset of a session with a merged PR, `session.rounds` has one record with the PR, its URL and `merged_at`; a second reset appends a second record whose `started` is the first one's `ended`; a session with a `design` block keeps `design.doc`, `design.approved` and `design.approvals` unchanged.

##### 2.45 `packages/daemon/src/views/session-view.ts` and `packages/daemon/src/pipeline/routes.ts` (Modify)

*   **Type / Scope**: The view and the log route.
*   **Proposed Changes**: `build_session_view` sets `round: round_of(session)` and `rounds: rounds_of(session, <MISSION.md text or null>)` for every session. `pipeline/routes.ts` adds `GET /sessions/:dir/rounds/:round/log`: 400 unless `:round` is an integer from 1 to `ROUNDS_MAX`; the `log` of the parsed round; 404 when absent. A test in `packages/daemon/src/pipeline/routes.test.ts` (Modify) covers 200, 400 and 404.

##### 2.46 `packages/ui/src/rounds.ts` and `packages/ui/src/rounds.test.ts` (Create)

*   **Type / Scope**: Pure helpers and their test.
*   **Proposed Changes**: `roundBadge(view: SessionView): string | null`: `r<round>` when `view.round >= 2`, else null. `roundTooltip(rounds: RoundView[]): string`: one line per round, `r<n>: <repo>#<number> <state>[ <YYYY-MM-DD of merged_at>]`, PRs joined with `, `, `r<n>: no PR` without one. Tests for round 1, round 3 with two records, and a parsed round without a URL.

##### 2.47 `packages/ui/src/PaneHead.tsx`, `packages/ui/src/SessionsPane.tsx`, `packages/ui/src/styles.css`, `packages/ui/fixture/data.ts`, `packages/ui/e2e/drive.ts` (Modify)

*   **Type / Scope**: The round badge.
*   **Proposed Changes**: `ContextBar` renders `<span className="badge round-badge" title={roundTooltip(view.rounds)}>{roundBadge(view)}</span>` after the title when `roundBadge` is not null, for every session. `SessionCard` renders the same badge after the stage badge. `styles.css` adds `.round-badge` in the accent colour, so a session with many rounds stands out. The fixture adds one session at round 3 with two records. The driver asserts the text `r3` and the tooltip's first line.

#### Build session 3: `egm-skills-in-app`, the skills and the gates in the app

Goal: every EGM skill starts from a button, every `ask_question` gate and the resolve gate are answered by a button, and each review run keeps its own reports.
Sizes: `engine` about 4 hours, `ui` about 3 hours.

##### 3.1 `packages/protocol/src/egm.ts` (Modify)

*   **Type / Scope**: Protocol types.
*   **Proposed Changes**: `interface DesignGateRequest { question: string; options: string[] }`; `DESIGN_GATE_OPTIONS_MAX = 6`; `DESIGN_GATE_QUESTION_MAX = 2000`; `DESIGN_GATE_OPTION_MAX = 300`; `interface DesignAnswerRequest { text: string }`; `DESIGN_ANSWER_MAX = 4000`; `interface DesignRunRequest { skill: EgmSkill; args?: string; preset?: ReviewPreset }`; `DESIGN_RUN_ARGS_MAX = 4000`; `REVIEW_RUNS_MAX = 99`; `RESOLVE_ANSWERS = ["Auto accept", "Continue", "Interactive breakdown"] as const`. `DESIGN_DEFAULT_TRACK` (2.1) becomes `"design"`; its doc comment drops the sentence about build session 3. This release carries the lead brief of 3.13 and the prompt lines of 3.6, so a lead on the default track knows that Goal and Done when are refused **[review v2 M-7]**.

##### 3.2 `packages/protocol/src/api.ts` (Modify)

*   **Type / Scope**: Routes.
*   **Proposed Changes**:
    *   `"PUT /sessions/:dir/design/gate": "OkResponse"`: the lead's `ask_question` tool.
    *   `"POST /sessions/:dir/design/answer": "AgentCommandResponse"`: clears the gate and prompts the lead.
    *   `"POST /sessions/:dir/design/run": "AgentCommandResponse"`: starts an EGM skill in the lead; 409 when the lead is not running.

##### 3.3 `packages/protocol/src/extension.ts` (Modify) **[E3, review M8]**

*   **Type / Scope**: The tool manifest.
*   **Proposed Changes**: `EXTENSION_TOOLS` gains `"ask_question"`. `ExtensionToolArgs.ask_question = { questions: string }`. The manifest entry: description `Ask the operator one single-select question. Pass EGM's gate payload as JSON text: [{"question": "...", "options": ["...", "..."], "is_multi_select": false}]. Exactly one question with 2 to 6 options. Spinner shows the options as buttons. End your turn after this call.`; parameter `questions` (string, "JSON array text of exactly one { question, options, is_multi_select } object"); required `questions`; roles `LEAD`; route `PUT /sessions/:dir/design/gate`.

##### 3.4 `packages/pi-extension/src/tools.ts` (Modify)

*   **Type / Scope**: Tool implementation.
*   **Proposed Changes**: A `case "ask_question"` in `run_tool`. It parses `questions` with `JSON.parse`. It accepts an array or an object with a `questions` array, because EGM's examples show the object. It returns an error text and calls nothing for: a parse error; not exactly one question; a `question` that is not a non-empty string; `options` with fewer than 2 or more than 6 strings; `is_multi_select: true` ("EGM gates are single-select."). Otherwise it sends `PUT /sessions/:dir/design/gate` with `{ question, options }` and returns: "The operator sees this question as buttons in Spinner and in your terminal. End your turn now. The answer arrives as your next message."

##### 3.5 `packages/pi-extension/src/lead.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: The happy path body for the array form and the object form; each refusal; the tool is absent for a worker.

##### 3.6 `packages/pi-extension/src/prompt.ts` (Modify) **[D3]**

*   **Type / Scope**: Prompt section.
*   **Proposed Changes**: The EGM block of 1.23 gains three lines. The first two come from `<session>/design/.state.json` and are left out when the file is absent or its `track` is not `design` **[review v2 M-4]**:
    *   `Designs directory: <designs_dir>. Save the design doc there, as an absolute path.`
    *   `When the draft's final file is written there, call design_doc with its absolute path.`
    *   `For an EGM gate with options, call ask_question with the gate's JSON payload, then end your turn.`

##### 3.7 `packages/daemon/src/egm/gate.ts` (Create)

*   **Type / Scope**: TypeScript module.
*   **Proposed Changes**: `set_gate(home, dir, request: DesignGateRequest, now: Date): void` validates the lengths of 3.1 (throws the first fault), re-reads the session, and writes `design.gate`; it throws `no design block` for a session without one. `clear_gate(home, dir): boolean` re-reads the session, removes `design.gate`, and returns whether one existed.

##### 3.8 `packages/daemon/src/egm/review-runs.ts` (Create) **[review M4]**

*   **Type / Scope**: TypeScript module.
*   **Proposed Changes**: `archive_review_run(session_path: string, current: DesignReviewRun | null): { archived: string | null; next: string }` **[review v2 M-2]**. `n(id)` is the number of an id `r<n>`. In this order:
    1.  `m` is the highest `n` of the `r<n>` directories under `<session>/design/reviews/`, or 0. `c` is `n(current.id)` when `current` is set, or 0.
    2.  When any `REVIEW_REPORT_FILES` entry exists directly in `<session>/design/`, the target is `current.id` when `current` is set, else `r<max(m, c) + 1>`. It throws `<session>/design/reviews/<target> already exists` when that directory exists. Otherwise it creates the directory and moves each such file into it. `archived` is the target. With no report, nothing moves and `archived` is null.
    3.  `next` is `r<max(m, c, n(archived)) + 1>`, with `n(null) = 0`. So the new run never takes the id of an archived run or of the current one, whatever the archive returned.
    4.  It throws `99 review runs are archived; move <session>/design/reviews aside by hand` before any move when `next` would be above `REVIEW_RUNS_MAX`, because `:run` in 5.3 matches `^r\d{1,2}$`.
    *   Trace: the first review has no reports and no `current`, so `next` is `r1`. The second review archives the `r1` reports into `reviews/r1/` and gets `r2`. A review typed in the terminal before the first app review leaves reports without `current`; the app review archives them into `reviews/r1/` and gets `r2`.

##### 3.9 `packages/daemon/src/egm/routes.ts` (Modify)

*   **Type / Scope**: Routes.
*   **Proposed Changes**:
    *   `EgmRouteDeps` gains `agents: AgentManager` and `home: SpinnerHome`.
    *   `PUT …/design/gate`: parse; `set_gate`; `design.refresh(dir)`; answer `{ ok: true }`; 400 with the fault.
    *   `POST …/design/answer`, in this order: 400 for empty text or text over `DESIGN_ANSWER_MAX`; 409 `the lead is not running; resume it from its tab` when `agents.get(dir, "lead")` is null; `clear_gate`; prompt the lead with the text; `design.refresh(dir)`; answer with the disposition.
    *   `POST …/design/run`, in this order: 400 for an unknown skill, for a `preset` with a skill other than `egm-review`, or for `args` over `DESIGN_RUN_ARGS_MAX`; 409 when the lead is not running; 409 `no design doc yet` for `egm-review` with `preset` while `design.doc` is unset. Compose the arguments per the table of Technical Plan T9, from `design.doc`, `designs_of(summary)`, `<session>/design/concepts_brief.md` and, for `egm-drift-report`, the merged PRs of `rounds_of`; for `egm-drift-report` answer 409 with the tooltip text of 3.18 while any repo has `changed: true`; the composed text must not exceed `DESIGN_RUN_ARGS_MAX`. For `egm-review` and `egm-review-loop`, call `archive_review_run(session.path, design.review_run ?? null)`, then write `design.review_run: { id: next, preset, started }` with the returned `next` **[review v2 M-2]**. Clear any gate. Prompt the lead with `/skill:<skill>` plus `" " + args` when present. `design.refresh(dir)`.

##### 3.10 `packages/daemon/src/server.ts` (Modify)

*   **Type / Scope**: The prompt and steer routes at the `for (const command of ["prompt", "steer"])` loop.
*   **Proposed Changes**: When `name === "lead"` and `deps.design` is set, call `clear_gate(home, dir)` before the command is sent, then `deps.design.refresh(dir)` when it returned true.

##### 3.11 `packages/daemon/src/egm/design.ts` (Modify) **[review M7]**

*   **Type / Scope**: Tracker.
*   **Proposed Changes**:
    *   Pass `design.gate` and `design.review_run` into `derive_design`, and `lead_busy`. `lead_busy` is `deps.agents.is_busy(dir, "lead")` (`packages/daemon/src/agents/manager.ts`), which is true from the lead's `agent_start` event to its `agent_settled` event. The tracker keeps no busy state of its own **[review v2 N-6]**.
    *   On `agent.settled` of `lead`: set `design.waiting` to true when `last_assistant_text(session.path, "lead").trim()` (`packages/daemon/src/agents/swarm.ts`) ends with `?`, no gate is open, and the stage is not `approved`.
    *   On `agent.event` of `lead` with type `agent_start`: set `design.waiting` to false; when `design.gate` exists and the event time is after `design.gate.asked`, call `clear_gate`. This clears a gate answered in the terminal.

##### 3.12 `packages/daemon/src/egm/derive-design.test.ts`, `routes.test.ts`, `design.test.ts` and `review-runs.test.ts` (Modify / Create)

*   **Type / Scope**: Unit tests; `review-runs.test.ts` is new.
*   **Proposed Changes**: `needs` for a gate (80-character cut), for a gate at stage `approved`, for `resolving`, and for waiting. `session.needs_human` read back from `session.yaml` after the tracker's `refresh` **[review v2 B-1]**: after `PUT …/design/gate` it is `answer the lead: <first 80 characters>`; at stage `resolving` with the lead settled it is `resolve the review findings`; after `POST …/design/answer` clears the gate it is the next line of the list; for an approved design with an open gate during the build it is the gate text. The three routes: 200 paths, 400 paths, 409 for a stopped lead with the gate kept, the composed `/skill:` text for each row of the T9 table, the gate cleared by a prompt through the agents route. The tracker clears a gate on a later `agent_start` and keeps it on an earlier one. `archive_review_run` with no reports, with reports, with an existing `r1`, and past 99. Two consecutive runs through `POST …/design/run`: the first records `review_run.id: r1`; the second archives into `reviews/r1/` and records `r2`; `reviews/r2/` does not exist **[review v2 M-2]**.

##### 3.13 `packages/daemon/src/store/brief-template.ts` (Modify) **[D1] [D9]**

*   **Type / Scope**: The lead brief for new sessions. Existing briefs stay, because the daemon never rewrites a brief.
*   **Proposed Changes**: The lead variant of `render_brief` (the private `render_lead_brief`) gains a section after "First message":

    ```text
    ## Design (EGM)
    1. In your first answer, propose a track: `design` (EGM: brainstorm, draft, review,
       approve, then build) or `direct` (a small fix). Say why in one sentence. The
       operator switches it on the track chip.
    2. On the design track, the operator starts each EGM skill. You never start one on
       your own. The skills write to the EGM artifact directory; the design doc goes to
       the designs directory of the repo. Name it with design_doc.
    3. Ask each EGM gate that has options with `ask_question`, then end your turn.
    4. Inside `egm-draft` gates, follow EGM: options without a ranking. Everywhere else,
       give the options and your recommendation.
    5. On the design track, Spinner refuses Goal and Done when in MISSION.md. The design
       doc holds them. Keep your Roster row, the Plan and the Log as before.
    6. Before the operator approves the design, and while a changed design waits for
       re-approval, write only the design doc and the session's files.
    ```

    The "First message" step 3 (`packages/daemon/src/store/brief-template.ts`, the three lines that start "3. Write the Goal with `mission_goal`") is replaced by these lines **[review v2 N-4]**:

    ```text
    3. On the `direct` track, write the Goal with `mission_goal` (one paragraph), the Done
       when list with `mission_done_when` (what must be true at the end), and the Plan with
       `mission_plan` (one owner per item; yourself until the work splits). On the `design`
       track, skip this step: Spinner writes the Goal and Done when, and the build message
       after approval tells you how to fill the Plan.
    ```

##### 3.14 `packages/daemon/src/agents/lead.test.ts` (Modify)

*   **Type / Scope**: Unit test.
*   **Proposed Changes**: The rendered lead brief contains the "Design (EGM)" section and the new step 3 with the tool names `mission_goal`, `mission_done_when` and `mission_plan`. With a ready fetcher, a new paste session now gets `design.track: design` (`DESIGN_DEFAULT_TRACK` flipped in 3.1); the 2.23 test that expected `direct` is updated.

##### 3.15 `packages/daemon/e2e/egm-harness.ts` (Modify) **[review M29]**

*   **Type / Scope**: E2e driver.
*   **Proposed Changes**: After each settle, when `SessionView.design.gate` is set, the driver answers through `POST …/design/answer` with the full option from `gate.options` that starts with the prefix of its answer table (1.26), and uses the text table only when no gate is set. The draft ends when `SessionView.design.doc` is set. The review starts through `POST …/design/run { skill: "egm-review", preset: "uninterrupted" }`. A resolve step is added: `POST …/design/run { skill: "egm-resolve", args: <absolute path of consolidated_review_report.md> }`, then the answer `Auto accept` once the stage is `resolving` and the lead settled; it ends when the report's first non-empty line is `Status: resolved`.

##### 3.16 `packages/protocol/schema/*.json` (Modify)

*   **Type / Scope**: Generated JSON schemas.
*   **Proposed Changes**: Regenerate and commit every changed file. No hand edits.

##### 3.17 `docs/SESSION_PROTOCOL.md`, `docs/DAEMON_API.md`, `docs/ARCHITECTURE.md` (Modify)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**: The `ask_question` tool and its payload in the tool list; the three routes; the gate flow, the four ways a gate clears, the resolve gate, and the review-run archive in the EGM section.

##### 3.18 `packages/ui/src/design.ts` (Modify)

*   **Type / Scope**: Pure helpers.
*   **Proposed Changes**:
    *   `primaryAction(design): { label: string; kind: "run"; skill: EgmSkill } | { label: string; kind: "approve" } | null` per the toolbar table of Technical Plan T13. The approve kinds are enabled in build session 6; until then `design-ready` returns null.
    *   `egmMenu(design): { label: string; skill: EgmSkill; field: "concept" | "target" | "dir" | "path" | null; disabled: string | null }[]`. On the design track: `brainstorm`, `draft`, `review design`, `review loop`, `resolve`, `drift report`, `bootstrap`; `bootstrap` has `disabled` set to the tooltip of Technical Plan T9 while the stage is not `approved`. On the direct track: `drift report` and `bootstrap`. The signature takes `changed: boolean` (any repo of the view with `changed: true`) as a second argument; while it is true, `drift report` has `disabled` = `the worktree has this round's unlanded commits; run the drift report before the round's first commit or after it lands`.
    *   `showResolveCard(design, needs: string | null): boolean`: true when the stage is `resolving` and `needs` is `resolve the review findings` (the daemon sets that text only after the lead settled).

##### 3.19 `packages/ui/src/DesignActions.tsx` (Create)

*   **Type / Scope**: React component, the toolbar's design group.
*   **Proposed Changes**:
    *   The primary button from `primaryAction`, styled as the one filled primary of the toolbar.
    *   `brainstorm` opens a dialog with an optional "concept" textarea; confirm posts `run { skill: "egm-brainstorm", args }`.
    *   `review design` opens a dialog with the four presets as radio buttons; `uninterrupted`, labelled "consolidated report", is selected by default **[D4]**; confirm posts `run { skill: "egm-review", preset }`.
    *   `draft` posts `run { skill: "egm-draft" }` at once; the daemon composes the arguments.
    *   `EGM ▾` lists `egmMenu`. `review loop` and `resolve` open a one-field dialog "target file", prefilled with the absolute doc path. `drift report` opens "designs directory", prefilled with the absolute designs dir. `bootstrap` opens "path", prefilled with the worktree root. Confirm posts `run` with `args`.
    *   Errors go to the drawer through the existing error path.

##### 3.20 `packages/ui/src/SessionToolbar.tsx` and `packages/ui/src/App.tsx` (Modify)

*   **Type / Scope**: Toolbar.
*   **Proposed Changes**: A new prop `design?: DesignView`. When `design` exists, render `DesignActions` before the stack group. In compact mode its items join the `⋯` menu at the top. `App.tsx` passes `view?.design`.

##### 3.21 `packages/ui/src/DesignGate.tsx` (Create)

*   **Type / Scope**: React component.
*   **Proposed Changes**: Two variants. The gate card: the question (Markdown), one button per option, and an "other answer" text box with `send`. The resolve card: the title "Resolve the review findings", the buttons `auto accept`, `continue` and `interactive breakdown` that send `RESOLVE_ANSWERS`, and the same text box. Each posts `POST …/design/answer { text }`. Buttons are disabled while the post runs. Nothing changes locally; the next `session.updated` removes the card.

##### 3.22 `packages/ui/src/AgentsPane.tsx` and `packages/ui/src/App.tsx` (Modify)

*   **Type / Scope**: Middle pane.
*   **Proposed Changes**: When `view.design?.gate` exists, render the gate card above the agent chips in the `agents` view; when `showResolveCard` is true, render the resolve card there. The `needs you` pill in the context bar switches the middle pane to the `agents` view and selects `lead` when either card shows. `App.tsx` lifts both the `shown` state and the `picked` state of `AgentsPane` into controlled props for that.

##### 3.23 `packages/ui/src/remote.ts` (Modify)

*   **Type / Scope**: UI client.
*   **Proposed Changes**: `postDesignRun(dir, body)`, `postDesignAnswer(dir, text)`.

##### 3.24 `packages/ui/src/design.test.ts`, `packages/ui/fixture/data.ts`, `packages/ui/fixture/server.ts`, `packages/ui/e2e/drive.ts` (Modify)

*   **Type / Scope**: Tests and fixture.
*   **Proposed Changes**: `primaryAction` per stage; `egmMenu` per track and stage; `showResolveCard`. The fixture serves a session with an open gate, a session at `resolving`, and the three routes. The driver clicks an option and asserts that the fixture received the text and dropped the gate; it clicks `auto accept` and asserts the text `Auto accept`.

#### Build session 4: `egm-goldfish`, Goldfish visibility and costs

Goal: each Goldfish shows live with its state, tokens, cost and transcript; Goldfish cost shows per step; the global cap holds new skill starts.
Sizes: `engine` about 4 hours, `ui` about 2 hours.

##### 4.1 `packages/protocol/src/egm.ts` (Modify)

*   **Type / Scope**: Protocol constants.
*   **Proposed Changes**: `GOLDFISH_POLL_MS = 2_000`. `GOLDFISH_SETTLE_POLL_MS = 30_000`. `GOLDFISH_RUNS_MAX = 200`. `GOLDFISH_LIVE_MAX = 12` **[D8]**. `GOLDFISH_RUNS_FILE = "runs.json"`. The `GoldfishView` and `DesignView` types of 2.1 stay as they are.

##### 4.2 `packages/protocol/src/costs.ts` (Modify)

*   **Type / Scope**: Cost types.
*   **Proposed Changes**: `CostRow.child?: string` (`"<runId>/<step index>"`). `SessionCost.children?: Record<string, AgentCost>`.

##### 4.3 `packages/protocol/src/api.ts` (Modify)

*   **Type / Scope**: Routes.
*   **Proposed Changes**: `"GET /sessions/:dir/egm/goldfish/:run/:step/events": "AgentEventsResponse"`: the child's transcript events; 404 for an unknown run or step.

##### 4.4 `packages/daemon/src/egm/goldfish.ts` (Create)

*   **Type / Scope**: TypeScript module.
*   **Proposed Changes**:
    *   `interface GoldfishRun { run: string; state: string; started: number | null; steps: { agent: string; status: string; model: string | null; tokens: number; started: number | null; last_activity: number | null; session_file: string | null }[] }`.
    *   `parse_status(json: unknown): GoldfishRun | null`: reads `runId`, `state`, `startedAt`, and per step `agent`, `status`, `model`, `tokens.total`, `startedAt`, `lastActivityAt`, `sessionFile` (pi-subagents `docs/observability.md` "Status and result fields"). Defaults per field: `tokens` → 0; `model`, `started`, `last_activity`, `session_file` → null; `status` → `""`. A file without `runId` or `steps` is null.
    *   `read_runs(runs_dir): GoldfishRun[]`: the `GOLDFISH_RUNS_MAX` newest directories of `<runs_dir>/async-subagent-runs/` by modification time; older directories are ignored; unreadable files are skipped.
    *   `chip_state(step_status, run_state): GoldfishState`: `queued`, `pending` → `queued`; `running` → `running`; `complete`, `completed` → `done`; `failed`, `rejected` → `failed`; `stopped`, `paused` → `stopped`; any other word → `running` while the run's `state` is `running`, else `failed`. The words are the ones pi-subagents 0.83.0 writes.
    *   `child_key(run: string, step_index: number): string`: `<run>/<step_index>`.
    *   `class GoldfishWatcher { constructor(deps: { home: SpinnerHome; agents: AgentManager; bus: EventBus; on_change: (dir: string) => Promise<void>; log: Log }) }`. A 2-second timer per watched session; each tick reads the runs. The timer stops when the lead is not busy, no run's `state` is `running`, and the last `agent.settled` of the lead is older than `GOLDFISH_SETTLE_POLL_MS`. It calls `on_change` when the set of `(run, step, status, tokens)` changed. "The lead is busy" is `deps.agents.is_busy(dir, "lead")` (`packages/daemon/src/agents/manager.ts`); the watcher keeps no busy map of its own **[review v2 N-6]**. It keeps only the time of the lead's last `agent.settled` per session, from the bus. `wake(dir)` starts the timer; the watcher calls it itself on the lead's `agent_start` and on `tool_execution_start` with tool name `subagent`.
    *   `live_count(): number`: the `running` steps across all watched sessions, from the last tick of each.
    *   Step attribution **[review M12]**: on the first sight of a run, write its design step to `<runs_dir>/runs.json` (`{ "<runId>": "<step>" }`). The step comes from the session's design stage at that moment: `intake` and `brainstorm` → `brainstorm`; `drafting` → `draft`; `drafted`, `design-review`, `resolving`, `design-ready` → `review`; `approved` → `build`. At most 1,000 entries; past that, the oldest entry by insertion order drops.

##### 4.5 `packages/daemon/src/egm/goldfish.test.ts` (Create)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: A fixture `status.json` in the documented shape (`lifecycleArtifactVersion` 3, one step) parses; a file with missing step fields gets the defaults; each status word maps per the `chip_state` rule; `read_runs` keeps the newest 200; the step attribution is written once per run; `live_count` across two sessions; the timer stops after the settle window.

##### 4.6 `packages/daemon/src/costs/ledger.ts` (Modify) **[review M11, M13]**

*   **Type / Scope**: Cost ledger.
*   **Proposed Changes**:
    *   `TranscriptRef.child?: string`.
    *   `transcripts()`: for each session, also call `read_runs(<session>/egm-runs)`. For each step with a `session_file` inside `<session>/agents/`, add a ref with `agent: "lead"` and `child: child_key(run, index)`. Other paths are skipped.
    *   `CHILD_FILES_MAX = 20_000` child refs across the home, separate from the `FILES_MAX` assertion. Past it, keep the newest by modification time and log `cost ledger: <n> child transcripts past 20000 skipped` once per refold.
    *   `fold_transcript` copies `ref.child` into each row.
    *   `session_cost_of`: rows with `child` sum into `children[child]`; the others into `agents[agent]`; totals include all rows.

##### 4.7 `packages/daemon/src/costs/costs.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: A child transcript named by a scratch `status.json` adds to the session total and to `children`, not to `agents.lead`. A `sessionFile` outside `<session>/agents/` is skipped. With the bound set to 2 for the test, a third child is skipped with the log line and no throw.

##### 4.8 `packages/daemon/src/egm/design.ts` (Modify) **[review M16]**

*   **Type / Scope**: Tracker view.
*   **Proposed Changes**:
    *   The `DesignTracker` deps of 2.12 gain `goldfish?: GoldfishWatcher` and `cost?: (dir: string) => SessionCost` **[review v2 M-1]**. Both are optional, so the 2.13 tests construct the tracker without them; without `goldfish`, `goldfish` is `[]`, `goldfish_live` is 0 and `goldfish_running` is 0; without `cost`, every `usd` is 0 and `cost_by_stage` is `{}`.
    *   `view` fills `goldfish` from `read_runs` (a step whose agent starts with `egm-` gets `persona` = the name without `egm-`), `usd` from `deps.cost(summary.dir).children?.[child_key]?.usd ?? 0`, `transcript` = the session file exists, `design_step` from `runs.json`. `goldfish_live` is `deps.goldfish.live_count()`. `cost_by_stage` sums each child's `usd` under its `design_step`; the lead's rows are not split. `refresh` passes `goldfish_running` (the session's `running` steps) into `derive_design`, so the "lead waits" line does not fire while a Goldfish runs.

##### 4.9 `packages/daemon/src/egm/routes.ts` (Modify)

*   **Type / Scope**: Routes.
*   **Proposed Changes**:
    *   `EgmRouteDeps` gains `goldfish: GoldfishWatcher`.
    *   `GET …/egm/goldfish/:run/:step/events`: find the run with `read_runs`; take the step's `session_file`; 404 when it is missing or not inside `<session>/agents/`; read it and answer `{ events: events_of_transcript(text) }` (`packages/daemon/src/agents/history.ts`).
    *   `POST …/design/run`: after the 400 checks, answer 409 `<n> Goldfish are running across sessions (cap 12); start this skill when they finish` when `goldfish.live_count() >= GOLDFISH_LIVE_MAX`.

##### 4.10 `packages/daemon/src/server.ts` (Modify)

*   **Type / Scope**: Wiring.
*   **Proposed Changes**:
    *   `AppDeps` gains `goldfish?: GoldfishWatcher`. `create_app` passes it into `EgmRouteDeps`; the EGM routes mount only when `egm`, `design`, `writer` and `goldfish` are set.
    *   In `start_daemon`, the watcher is built before the tracker, because the tracker needs the watcher and the watcher's `on_change` needs the tracker. The `on_change` closure reads the `design` variable of 2.26 late **[review v2 M-1]**:

        ```ts
        const goldfish = new GoldfishWatcher({
            home, agents, bus, log,
            on_change: async (dir) => {
                await design?.refresh(dir);
                publish_view(dir);
            },
        });
        design = new DesignTracker({
            home, cwd, agents, bus, writer, refresh, log,
            goldfish,
            cost: (dir) => view_ctx.cost?.(dir) ?? { usd: 0, tokens_in: 0, tokens_out: 0, agents: {} },
        });
        ```

    *   `GoldfishWatcher` has a `close(): void` that clears every timer and unsubscribes from the bus. The daemon's `close` calls `goldfish.close()` before `agents.stop_all()`.

##### 4.11 `packages/daemon/e2e/egm-harness.ts` (Modify)

*   **Type / Scope**: E2e.
*   **Proposed Changes**: **P6**: during the P11 brainstorm, `SessionView.design.goldfish` holds six entries with a known persona within 5 seconds of the lead's `subagent` call. **P7**: after the brainstorm, `SessionView.cost.children` is not empty and `design.cost_by_stage.brainstorm` is above 0. Add both rows to `docs/egm/HARNESS_EVIDENCE.md` (Modify).

##### 4.12 `packages/protocol/schema/*.json` (Modify)

*   **Type / Scope**: Generated JSON schemas.
*   **Proposed Changes**: Regenerate after 4.2 and 4.3 and commit every changed file. No hand edits.

##### 4.13 `docs/ARCHITECTURE.md`, `docs/DAEMON_API.md` (Modify)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**: Observation of Goldfish, how results reach the lead, the global cap, the cost scan, the events route.

##### 4.14 `packages/ui/src/GoldfishChips.tsx` (Create)

*   **Type / Scope**: React component.
*   **Proposed Changes**: A row of chips under the agent chips, one per `GoldfishView` of the newest 3 runs, newest first. Each chip: the 🐟 character as its mark, `persona ?? agent`, a state dot, `tokens` as `<n>k` (thousands, one decimal under 10k, none above), `usd` as `$0.00`, and the model in the tooltip. A failed chip's tooltip says "not run", because EGM counts a failed reviewer as not run (`agents/synthesizer.md` "Failed Reviewers"). A click selects the chip. When `goldfish_live >= 12`, a line reads `12 Goldfish running across sessions; new skill starts wait`.

##### 4.15 `packages/ui/src/GoldfishTranscript.tsx` (Create)

*   **Type / Scope**: React component.
*   **Proposed Changes**: The selected chip's transcript, read-only, rendered with the same transcript fold and message markup as the `chat` tab of an rpc agent (`transcript.ts`, `AgentChat.tsx`), without the input box. It reloads every 2 seconds while the chip is `running`.

##### 4.16 `packages/ui/src/AgentsPane.tsx` (Modify)

*   **Type / Scope**: Middle pane.
*   **Proposed Changes**: Render `GoldfishChips` under `AgentChips` when `view.design?.goldfish` is not empty. A selected Goldfish replaces the agent tab content with `GoldfishTranscript`; picking an agent chip returns.

##### 4.17 `packages/ui/src/DesignStepper.tsx` (Modify)

*   **Type / Scope**: Stepper.
*   **Proposed Changes**: Each step's tooltip ends with `Goldfish: $<cost_by_stage value>`. The Review and Brainstorm steps show the number of their `running` Goldfish as a superscript digit when it is above 0.

##### 4.18 `packages/ui/src/remote.ts`, `packages/ui/src/goldfish.ts`, `packages/ui/src/goldfish.test.ts`, `packages/ui/fixture/data.ts` (Modify / Create)

*   **Type / Scope**: Client, pure helpers, tests, fixture.
*   **Proposed Changes**: `fetchGoldfishEvents(dir, run, step, signal)` (Modify `remote.ts`). `goldfish.ts` (Create): `newestRuns(goldfish, 3)`, `chipLabel(view)`, `tokensLabel(n)`. `goldfish.test.ts` (Create). The fixture (Modify) serves six chips in mixed states, one transcript, and one view with `goldfish_live: 12`.

#### Build session 5: `egm-workspace`, the design workspace

Goal: the operator reads the brief, the draft, the doc, the review reports, the other design files and the session's round history in the app, and answers gates there.
Sizes: `engine` about 2 hours, `ui` about 4 hours.

##### 5.1 `packages/protocol/src/egm.ts` (Modify)

*   **Type / Scope**: Protocol types.
*   **Proposed Changes**: `interface DesignFilesResponse { files: DesignFileView[]; review_runs: string[] }`. `DESIGN_FILE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}\.md$/`.

##### 5.2 `packages/protocol/src/api.ts` (Modify)

*   **Type / Scope**: Routes.
*   **Proposed Changes**: `GET /sessions/:dir/design/files` → `DesignFilesResponse`; `GET /sessions/:dir/design/files/:name` → `text/markdown`; `GET /sessions/:dir/design/reviews/:run/:name` → `text/markdown`; `GET /sessions/:dir/design/doc` → `text/markdown` (404 before `design.doc`).

##### 5.3 `packages/daemon/src/egm/routes.ts` (Modify) **[review M21]**

*   **Type / Scope**: Routes.
*   **Proposed Changes**: The four routes. `:name` must match `DESIGN_FILE_NAME_PATTERN` and must not start with `.`; `:run` must match `^r\d{1,2}$`; 400 otherwise; 404 when absent. `review_runs` lists the `r<n>` directories of `<session>/design/reviews/`, newest first. The doc route reads `<worktree of design.repo>/<design.doc>`. The daemon does not parse report findings.

##### 5.4 `packages/daemon/src/egm/routes.test.ts` (Modify)

*   **Type / Scope**: Route tests.
*   **Proposed Changes**: Each route's 200, 400 (a name with `/`, a dotfile, a bad run id) and 404.

##### 5.5 `docs/DAEMON_API.md` (Modify)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**: The four routes.

##### 5.6 `packages/ui/src/DesignWorkspace.tsx` (Create)

*   **Type / Scope**: React component.
*   **Proposed Changes**: Tabs Brief, Design, Review, Files and History. A `tab` prop selects one from outside. The data reload key is the session dir plus the newest `mtime` in `design.files` plus `design.doc`.

##### 5.7 `packages/ui/src/DesignBrief.tsx` (Create)

*   **Type / Scope**: React component.
*   **Proposed Changes**: Renders `concepts_brief.md` with `Markdown`. Above it, `DesignGate` when a gate is open. Empty state: "No brief yet. Start with `brainstorm`."

##### 5.8 `packages/ui/src/DesignDoc.tsx` (Create)

*   **Type / Scope**: React component.
*   **Proposed Changes**:
    *   Shows the doc when `design.doc` is set, else `design_draft.md`.
    *   A left outline of the `## ` headings; a click scrolls to the section.
    *   Under each `## ` section, a `request revision` link opens a text box. `send` posts `POST …/design/answer` with `Revision request for "<heading>" in <file name>: <text>`.
    *   A `source` toggle shows the raw text.

##### 5.9 `packages/ui/src/DesignReview.tsx` (Create) **[review M21]**

*   **Type / Scope**: React component.
*   **Proposed Changes**:
    *   A vertical list of stages 5 to 9 with `written` or `not yet` from `design.reviews`, the Goldfish of the review step (from `goldfish` with `design_step: "review"`), and their cost.
    *   A click on a stage renders its report file with `Markdown`. The consolidated report and the resolve report render the same way.
    *   A run selector lists the current run and `review_runs`; an earlier run reads through `…/design/reviews/:run/:name`.
    *   When `showResolveCard` is true, the resolve card of 3.21 shows above the report.

##### 5.10 `packages/ui/src/DesignFiles.tsx` (Create)

*   **Type / Scope**: React component.
*   **Proposed Changes**: The Files tab: `design.files` as a list with name, size and time; a click renders the file with `Markdown`. A drift report (`*_DRIFT_REPORT.md`) appears here.

##### 5.11 `packages/ui/src/AgentsPane.tsx` and `packages/ui/src/App.tsx` (Modify)

*   **Type / Scope**: Middle pane.
*   **Proposed Changes**: For a session with a `design` block, the view tabs are `agents · design · mission · threads · services`; sessions without the block keep the current tabs. `design` renders `DesignWorkspace`; on the direct track it opens on Files. `DesignStepper`'s `onStep` opens `design` with the tab: brainstorm → Brief, draft → Design, review → Review, approve → Design. For a session with a `design` block, a click on the round badge (2.47) opens `design` on History.

##### 5.12 `packages/ui/src/design-workspace.ts`, `packages/ui/src/design-workspace.test.ts`, `packages/ui/src/remote.ts`, `packages/ui/src/styles.css`, `packages/ui/fixture/data.ts`, `packages/ui/fixture/server.ts` (Create / Modify)

*   **Type / Scope**: Helpers, tests, client, styles, fixture.
*   **Proposed Changes**: `design-workspace.ts` (Create): `outline(markdown)`, `stageRows(design)`. Its test (Create). `remote.ts` (Modify): `fetchDesignFiles`, `fetchDesignFile`, `fetchReviewFile`, `fetchDesignDoc`. `styles.css` (Modify): workspace layout. Fixture (Modify): a brief, a draft with 6 sections, a consolidated report, a resolve report, one archived run, one drift report.

##### 5.13 `packages/ui/src/DesignHistory.tsx` (Create)

*   **Type / Scope**: React component, the History tab.
*   **Proposed Changes**:
    *   Rounds: one row per `view.rounds` entry, newest first: `r<n>`, the branch, each PR as a link when `url` is set (else `<repo>#<number>`), its state and merge date, and `started` to `ended` when set. A row expands to the round's Log, read through `GET /sessions/:dir/rounds/:round/log` and rendered with `Markdown`. The current round heads the list as `r<round> (current)`.
    *   Approvals: one row per `design.approvals` entry, newest first: the round, the time, the first 12 characters of `sha256`, the path and the listed blockers. The row of the standing approval is marked `current`; when `changed_after_approval` is true it is marked `invalidated`.
    *   Empty state: "Round 1, no approval yet."

##### 5.14 `packages/ui/src/remote.ts`, `packages/ui/fixture/server.ts`, `packages/ui/fixture/data.ts`, `packages/ui/e2e/drive.ts` (Modify)

*   **Type / Scope**: Client, fixture and driver for History.
*   **Proposed Changes**: `fetchRoundLog(dir, round, signal)`. The fixture serves the round-3 session of 2.47 with two approvals and the log route. The driver opens History, expands round 1 and asserts its Log text and the two approval rows.

##### 5.15 `packages/protocol/schema/*.json` (Modify)

*   **Type / Scope**: Generated JSON schemas.
*   **Proposed Changes**: Regenerate and commit every changed file. No hand edits.

#### Build session 6: `egm-approve`, approval, build handoff, PR body, design-only guard, outcome counters

Goal: one click approves the design and starts the build; edits invalidate the approval and lock the lead's code writes; the pipeline reads the doc; the daemon counts fixer rounds and operator steers.
Sizes: `engine` about 5 hours, `ui` about 2 hours.

##### 6.1 `packages/protocol/src/egm.ts` and `packages/protocol/src/api.ts` (Modify)

*   **Type / Scope**: Types and routes.
*   **Proposed Changes**: `interface DesignApproveRequest { build: boolean; blockers_confirmed?: number }`. `interface DesignApproveRefusal { error: string; blockers: number | null }`. `interface DesignChange { heading: string; approved: string | null; current: string | null }`; `interface DesignChangesResponse { changes: DesignChange[] }`. Routes: `POST /sessions/:dir/design/approve` → `SessionResponse` (409 with `DesignApproveRefusal`); `DELETE /sessions/:dir/design/approve` → `SessionResponse`; `GET /sessions/:dir/design/approved` → `text/markdown` (404 before an approval); `GET /sessions/:dir/design/changes` → `DesignChangesResponse` (an empty list without a change).

##### 6.2 `packages/daemon/src/egm/approve.ts` (Create) **[D2] [D5] [review B1, M17]**

*   **Type / Scope**: TypeScript module.
*   **Proposed Changes**:
    *   `approve_design(deps, summary, request: DesignApproveRequest): Promise<SessionSummary>` follows Technical Plan T10 steps 1 to 7. It throws an `ApproveRefusal` with the message and the count for each 409.
    *   `count_listed_blockers(text: string): number` **[review v2 N-11]**. Only heading lines count; a heading is a line that matches `HEADING = /^(#{2,4})\s+(.*)$/u`. Two modes, in order:
        1.  Severity mode: the number of headings whose text matches `SEVERITY = /\bSeverity:\s*(Blocker|High)\b/iu`. This is the layout of `egm-resolve` (`### [Issue 1] [persona] - Severity: High`) and of the synthesizer (`### <name> - Severity: Blocker`, `agents/synthesizer.md`). When the number is above 0, it is the result.
        2.  Section mode, when severity mode finds none: a blocker section starts at a heading of level `L` (2 or 3) whose text matches `SECTION = /(🔴|\bBlockers?\b)/iu`, and ends at the next heading of level `L` or less. The result is the number of headings of level `L + 1` inside all blocker sections. This is the layout `## 🔴 Blockers` with one `### ` heading per finding, which `egm-review` Step "Cross-Stage Synthesis" asks for by priority. The section heading itself never counts, so a group heading is not counted as a finding.
        3.  Otherwise 0.
    *   Lines inside fenced code blocks (between lines that start with three backticks) are skipped in both modes.
    *   The `Status:` rewrite uses `^(\*\s+\*\*Status:\*\*\s*).*$` (multiline) → `$1Approved`.
    *   The Log line goes through `MissionWriter.write` with `section: "log"`, author `spinner`.
    *   The build message, as sent:

        ```text
        The design is approved: <doc path> (sha256 <first 12>). Build to its Detailed
        Implementation Plan. First add one MISSION.md Plan item per plan entry (each
        `##### n.n` heading) with mission_plan add, in the doc's order. The item text is
        `plan <id>: <heading text>` without the trailing `( … )` part, because the Plan
        reads a trailing parenthesis as the owner. Tick an item with mission_plan tick the
        moment its entry is done. Add a worker per phase with agent_add when the work is
        parallel; its brief owns that phase's files. A change to the design invalidates the
        approval and locks your code writes: edit the doc, then ask the operator to
        re-approve.
        ```

    *   Step 5 sets `round` to `round_of(summary.session)` (2.41) and appends the record to `design.approvals`; past `DESIGN_APPROVALS_MAX` the oldest entry drops.
    *   `clear_approval(deps, summary)` removes `design.approved`, `design.changed_after_approval` and `approved.md`. `design.approvals` keeps its history.

##### 6.3 `packages/daemon/src/egm/approve.test.ts` (Create)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: The three 409s of step 1; a report with 2 blocker headings refuses without `blockers_confirmed`, refuses with 1, and approves with 2 and records `blockers: 2`; an approval in round 2 appends a second `design.approvals` entry with `round: 2`; `clear_approval` keeps `design.approvals`; `count_listed_blockers` on a resolve-layout fixture (3 `Severity: High` headings → 3), a synthesizer-layout fixture (2 `Severity: Blocker` and 1 `Severity: Major` headings → 2), a section-layout fixture (`## 🔴 Blockers` with 2 `### ` headings, then `## 🟡 Majors` with 3 → 2), a fixture with a blocker heading inside a code fence (not counted), and a report with neither layout (0); the status rewrite; the hash equals `normalized_doc_hash`; the copy exists; the Log line; the build prompt only when `build` is true (a fake lead handle records it), and its text contains `mission_plan add`.

##### 6.4 `packages/daemon/src/agents/manager.ts` (Modify) **[review M30]**

*   **Type / Scope**: Agent host.
*   **Proposed Changes**: `notify_all(dir, text, options: { steer_fallback: boolean } = { steer_fallback: false })`. With `steer_fallback: true`, a handle without `notify` gets `steer(text)`. The parameter is optional with that default, so the two existing callers (`server.ts`, the `DiffManager` notify closure, and `packages/daemon/src/stack/job-record.ts`) stay unchanged and keep their behaviour **[review v2 N-5]**.

##### 6.5 `packages/daemon/src/agents/agents.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: With `steer_fallback: true`, a fake handle without `notify` records a steer; with `false`, it records nothing; with no options argument, it records nothing.

##### 6.6 `packages/daemon/src/egm/design.ts` (Modify) **[D7]**

*   **Type / Scope**: Tracker.
*   **Proposed Changes**: When `design.approved` exists and the doc hash differs: set `changed_after_approval`; compute the changed sections with `split_mission` (`packages/daemon/src/pipeline/mission-sections.ts`) on `approved.md` and the doc, comparing `## ` blocks by heading and body; send once per hash, through `agents.notify_all(dir, text, { steer_fallback: true })`, the text "The design doc changed in <sections>; the approval is invalidated. Your code writes stay locked until the operator re-approves." Remember the notified hash in memory. When the hash equals the approved one again, clear `changed_after_approval`. `changes(summary): DesignChange[]` returns the changed sections for the route.

##### 6.7 `packages/daemon/src/egm/routes.ts` (Modify)

*   **Type / Scope**: Routes.
*   **Proposed Changes**: `approve_design` and `clear_approval` use the `writer` that `EgmRouteDeps` has since 2.24. The four routes of 6.1, calling `approve_design`, `clear_approval` and `design.changes`, then `design.refresh(dir)`. An `ApproveRefusal` answers 409 with `DesignApproveRefusal`.

##### 6.8 `packages/daemon/src/egm/pr-body.ts` and `packages/daemon/src/egm/pr-body.test.ts` (Create)

*   **Type / Scope**: Pure function and its test.
*   **Proposed Changes**: `pr_body_from_design(doc, doc_path, session_id): string`: the `## Overview` body, then `## Goals` with its list, then `Design: \`<doc_path>\` (drafted with EGM)`, then `Spinner session <id>`. Sections that are missing are skipped. `overview_line(doc)`: the first sentence of `## Overview`, cut at 200 characters. Tests for both, with and without each section.

##### 6.9 `packages/daemon/src/pipeline/pr.ts` (Modify)

*   **Type / Scope**: Create PR.
*   **Proposed Changes**: `write_pr_body` reads the doc from the design repo's worktree and uses `pr_body_from_design` when `session.design?.approved` exists; else the current mission path.

##### 6.10 `packages/daemon/src/pipeline/post.ts` (Modify)

*   **Type / Scope**: Slack post.
*   **Proposed Changes**: The message's summary line uses `overview_line(doc)` when `session.design?.approved` exists; else the Goal's first line, unchanged.

##### 6.11 `packages/daemon/src/pipeline/pr.test.ts`, `packages/daemon/src/pipeline/post.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: A design session with an approved doc gets the doc-based body and line; a session without a `design` block keeps the mission-based ones.

##### 6.12 `packages/daemon/src/store/review-brief.ts` and `packages/daemon/src/agents/swarm.ts` (Modify) **[D11]**

*   **Type / Scope**: PR reviewer brief.
*   **Proposed Changes**: `render_review_brief` takes `design_doc?: string` (absolute path). When set, it adds: "The approved design doc is `<path>`. Read it. Name each place where the code differs from it." `ReviewSwarm.ensure_brief` passes it when `session.design?.approved` exists. A test in `packages/daemon/src/pipeline/review.test.ts` (Modify) checks the line.

##### 6.13 `packages/pi-extension/src/guard.ts` and `packages/pi-extension/src/index.ts` (Modify) **[D7]**

*   **Type / Scope**: Edit guard.
*   **Proposed Changes**: `GuardInput.design?: { track: string; approved: boolean; designs_dir: string } | null` and `GuardInput.role`. In `guard_edit`, after the session-directory check: when `role === "lead"`, `design.track === "design"` and `design.approved === false`, allow only paths inside `design.designs_dir`, else refuse with "The design is not approved, or it changed since approval. Under EGM's design-only scope you may write only the design doc and the session's files." `index.ts` reads `<session>/design/.state.json` (JSON, null when absent or invalid) before each guard check and passes it with the role.

##### 6.14 `packages/pi-extension/src/extension.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: A lead on an unapproved design track cannot write `src/a.ts` and can write `docs/designs/x.md` and session files; after approval it can write `src/a.ts`; with `approved: false` after a change it cannot; a worker is not affected; a direct-track lead is not affected. A stale state: a lead whose `.state.json` first reads `{ track: "design", approved: false }` and is then rewritten to `{ track: "direct", … }` by the tracker (2.12 step 5) can write `src/a.ts` on its next check **[review v2 M-4]**.

##### 6.15 `docs/SESSION_PROTOCOL.md`, `docs/ARCHITECTURE.md`, `docs/DAEMON_API.md` (Modify)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**: Approval, the blocker confirmation, the hash rule, the build message, the guard rule and its `bash` limit, the PR body source, the outcome counters.

##### 6.16 `packages/ui/src/ApproveDesign.tsx` (Create) **[D5] [review N5]**

*   **Type / Scope**: React component, a dialog.
*   **Proposed Changes**: Shows the doc path. When `changed_after_approval` is true, lists each `DesignChange` from `GET …/design/changes` with its approved and current text side by side. A checkbox `start the build`, on by default. The confirm button reads `approve and build` or `approve`. It posts `POST …/design/approve { build }`. On a 409 with `blockers > 0`, the dialog shows `The newest review report lists <N> blockers.` and a second confirm button `approve with <N> listed blockers`, which posts again with `blockers_confirmed: N`.

##### 6.17 `packages/ui/src/design.ts`, `packages/ui/src/DesignActions.tsx`, `packages/ui/src/DesignDoc.tsx` (Modify)

*   **Type / Scope**: Actions and banner.
*   **Proposed Changes**: `primaryAction` returns the approve kinds at `design-ready`, labelled `re-approve design` when `changed_after_approval` is true. `DesignActions` opens `ApproveDesign`. The `EGM ▾` menu gains `remove approval` when an approval exists (posts `DELETE`). `DesignDoc` shows a warn banner "Changed since approval" with a button that opens `ApproveDesign`.

##### 6.18 `packages/ui/src/remote.ts`, `packages/ui/fixture/data.ts`, `packages/ui/fixture/server.ts`, `packages/ui/e2e/drive.ts` (Modify)

*   **Type / Scope**: Client, fixture, driver.
*   **Proposed Changes**: `postDesignApprove`, `deleteDesignApprove`, `fetchDesignApproved`, `fetchDesignChanges`. A fixture session at `design-ready` with 1 listed blocker, and one changed after approval. The driver approves through the blocker confirmation and sees the stepper move to Build.

##### 6.19 `packages/protocol/src/session.ts` (Modify) **[review M18]**

*   **Type / Scope**: `session.yaml` types.
*   **Proposed Changes**: `interface OutcomeCounts { fix_rounds: number; operator_steers: number }`. `Session.outcomes?: OutcomeCounts`, doc comment "Absent in sessions created before EGM build session 6."

##### 6.20 `packages/daemon/src/pipeline/routes.ts` and `packages/daemon/src/server.ts` (Modify)

*   **Type / Scope**: The counters.
*   **Proposed Changes**: The `fix` job (`start_job(c, deps, "fix", …)` in `pipeline/routes.ts`) re-reads the session and increments `outcomes.fix_rounds` when it starts. The steer route of the `for (const command of ["prompt", "steer"])` loop in `server.ts` increments `outcomes.operator_steers` only when all three hold **[review v2 M-5]**: `command === "steer"`, the target `name` is `lead`, and the request has `source: "operator"`. Both counters create `outcomes` with zeros when it is absent.
*   Why the `source` field: the lead's `agent_steer` tool and the operator agent's tool post to the same route (`packages/protocol/src/extension.ts`, `roles: OPERATOR_OR_LEAD`; `packages/pi-extension/src/tools-operator.ts`). Counting every steer would count the lead steering its own workers.
*   `packages/protocol/src/api.ts` (Modify): `AgentMessageRequest` gains `source?: "operator"`, with the doc comment "Set only by the Spinner UI's message box, for the outcome counter." `packages/daemon/src/requests.ts` (Modify): `parse_agent_message` keeps `source` when it is the string `operator`, answers 400 `source must be "operator" when given` for any other value, and drops it when absent. The extension tools send no `source`.
*   `packages/ui/src/AgentChat.tsx` (Modify, owner `ui`): `send("steer")` posts `{ text, source: "operator" }`. The `prompt` and `abort` bodies and the Open-question answer in `MissionWorkspace.tsx` are unchanged, so they are not counted.
*   Limits: the fixer's own steers go through its handle, not the route, so they are not counted. Text the operator types in the lead's tty terminal does not pass through the route either, so the counter is a lower bound. The limit is the same on both tracks.

##### 6.21 `packages/cli/src/commands/outcomes.ts`, `packages/cli/src/commands/outcomes.test.ts` (Create) and `packages/cli/src/cli.ts` (Modify)

*   **Type / Scope**: CLI command `spinner outcomes`.
*   **Proposed Changes**: Reads every `session.yaml` under `<home>/sessions` and `<home>/archive`. The PR set of a session is the current `repos[*].pr` entries plus every `rounds[].prs` entry (2.39), deduplicated by `<repo>#<number>`, because `reset_session` sets each `repo.pr` to null while `outcomes` keeps counting across rounds (`packages/daemon/src/pipeline/reset.ts`) **[review v2 M-6]**. It keeps sessions with `outcomes` and a PR set of at least one. It prints one row per track (`design`, `direct`): sessions, PRs (the sum of the PR-set sizes), mean `fix_rounds` per PR and mean `operator_steers` per PR, each mean being the sum of the counter over the track's sessions divided by the track's PRs, with two decimals. Sessions without a `design` block are left out. `cli.ts` registers `outcomes_command` next to `doctor_command`. The test builds a scratch home with two design and two direct sessions and checks the rows. One design session was reset once: its `rounds[0].prs` holds `web#41`, its current `repos.web.pr` is `web#57`, and its PR set is 2. A session whose only PR appears in both `rounds[0].prs` and `repos[*].pr` counts it once.

##### 6.22 `packages/daemon/src/pipeline/routes.test.ts` and `packages/daemon/src/server.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: A `fix` job increments `fix_rounds` from 0 to 1 on a session without `outcomes`; a steer to `lead` with `source: "operator"` increments `operator_steers`; a prompt does not; a steer to `backend` with `source: "operator"` does not; a steer to `lead` without `source` (the lead's or the operator agent's `agent_steer`) does not; a body with `source: "lead"` answers 400.

##### 6.23 `packages/protocol/schema/*.json` (Modify)

*   **Type / Scope**: Generated JSON schemas.
*   **Proposed Changes**: Regenerate after 6.1 and 6.19 and commit every changed file. No hand edits.

### Verification Plan

*   **Compilation/Build**: `pnpm -r build` and `pnpm typecheck` at the end of every build session.
*   **Unit Tests**: `pnpm -r test`. Each build session's new tests are listed in its entries. The existing suites stay green, including `schema.test.ts` after each schema entry.
*   **Static Analysis & Linting**: `pnpm lint` at the root. `python3 tools/doc-metrics.py --fail` for every changed doc and brief. `tools/actionlint.sh` only if a workflow changes (none is planned).
*   **Test Coverage Requirement**: Every new pure function has a test per branch of its rule table: `derive_design`, `check_design_doc`, `round_of`, `parse_previous_rounds`, `rounds_of`, `round_record`, `roundBadge`, `roundTooltip`, `chip_state`, `parse_status`, `count_listed_blockers`, `normalized_doc_hash`, `archive_review_run`, `subagents_installed`, `designSteps`, `trackChoices`, `primaryAction`, `egmMenu`, `render_pi_agent`, `expand_skill` (when built).
*   **E2E/Integration**:
    *   Build session 1: `node packages/daemon/e2e/egm-harness.ts` passes P1, P2a, P2b, P2c, P3 (either branch), P4, P5, P8 and P11. The record lands in `docs/egm/HARNESS_EVIDENCE.md`. A failure of P1, P2, P4 or P5 stops the build sessions and goes to the operator; later build sessions do not start.
    *   Build session 3: the same driver answers gates through `design.gate`, starts each skill through `POST …/design/run`, and ends P11 when the lead holds for approval after the review, with no code change in the worktree.
    *   Build session 4: the same driver passes P6 and P7.
    *   Build session 6: the same driver runs the resolve step (`egm-resolve` on the consolidated report, `Auto accept`, until the resolve report is marked resolved), then approves through `POST …/design/approve` and checks that the build starts.
    *   Build sessions 2, 3, 4, 5 and 6: `packages/ui/e2e/drive.ts` against the fixture with the new assertions.
    *   After build session 6, one manual run by the operator on a real project: paste, brainstorm, draft, consolidated review, resolve, approve and build, create PR. The operator records the cost per step from the stepper.
    *   After 10 design-track and 10 direct-track sessions with a PR: `spinner outcomes` prints the comparison of the outcome Goal.

## Build findings

The build sessions record here what the build found against this document. The evidence of session 1 is `docs/egm/HARNESS_EVIDENCE.md`.

### Session 1

*   **1.9, T2:** pi-subagents reads `extensions: []` as one extension named `[]`. The adapter writes `extensions:` with an empty value, which pi-subagents documents as "no extensions".
*   **T3, 1.4:** the installed pi-subagents is 0.84.0, not 0.83.0. The three variables exist at the cited files in 0.84.0.
*   **1.22, 1.14:** a daemon started inside a pi-subagents child passed `PI_SUBAGENT_CHILD=1` to every agent, and the Spinner extension stayed off. `pi_spawn_plan` now drops every inherited `PI_SUBAGENT_*` variable that the plan does not set itself (`env_unset`). `PI_CODING_AGENT_DIR` stays.
*   **T5, 4.4, P8:** a foreground Goldfish (`async: false`) writes no `status.json`. Its files are `<session>/agents/lead/pi/subagent-artifacts/<runId>_<agent>_<step>_{meta.json,output.md,transcript.jsonl}`. The GoldfishWatcher and P8 must read them too.
*   **1.26:** EGM questions end a paragraph that continues after the `?`. The driver reads a question when the last paragraph has a `?`, not when the text ends with one.
*   **1.25, P3:** `pi.sendUserMessage` passes `/skill:` text to the model unexpanded. Entry 1.25 is built (`b8f8e51`).
*   **P11, 3.13:** the session-1 lead carries the build brief. It ran the brainstorm (6 Goldfish, the brief) and then built the feature. Draft and review were not reached. Run P11 again after 3.13.
*   **Change for 1.26:** add a row for a lead that asks in prose, and stop P11 after N idle turns. The driver stops after 5 "Continue." turns.
*   **Change for T5:** cover foreground Goldfish in the watcher and in the cost ledger.
*   **Change for the protocol:** a probe that spends model money names its stop rule before it runs.

### Session 2

The checkpoint ran on a scratch daemon with the real pi and the sandbox repository. A design-track session moved `intake` → `brainstorm` (a `concepts_brief.md` that the session-files watcher reported) → `drafted` when the lead called `design_doc`. `session.needs_human` became `review the design`, the Goal named the doc, and the UI showed the stepper and the card dots. A `reset` then gave round 2 with one `rounds` record and the `r2` badge.

*   **2.40:** `SessionView.round` and `SessionView.rounds` are optional, not required. Required fields broke `tsc` of the ui fixture and tests at the protocol commit, before the ui agent filled them. The daemon always sets both, as for `diff`, `cost` and `kind`.
*   **2.27:** `session.ts` now imports `DesignState` from `egm.ts`. The type check of ts-json-schema-generator rejects imports between files, so `scripts/generate-schema.ts` and `schema.test.ts` skip that check for `session.ts`, as they already did for `index.ts`. `tsc` still checks the sources.
*   **2.12:** `designs_of` returns null when the designs repo has no worktree in the session (a session without a project). `set_doc` then answers 400 `this session has no worktree of the designs repo`, and `.state.json` carries `designs_dir: null`. `refresh` runs one call at a time per session through a promise chain, because the watcher, `agent.settled` and the routes call it concurrently.
*   **2.9, T7, T10:** T10 says a doc changed after approval is at `design-ready`. The rule table gives `design-ready` only when the current run has a concluding report. `derive_design` follows the table: an approval made at `drafted` and then invalidated reads `drafted` with the needs line `re-approve the design (changed since approval)`. After a round whose doc is not on the base, the stage stays `drafted` with the missing-doc needs line.
*   **2.12, 2.13:** chokidar's native watch can start late under load (`watch/live.ts`). The doc watcher has no liveness probe, because a probe file in the designs directory would show in the worktree. An edit in the first second after `set_doc` can be missed until the next `agent.settled`. The tests repeat the edit until `session.yaml` shows the change.
*   **2.20:** a switch from `direct` to `design` after `design_doc` rewrites the Goal to the "not named yet" text, although `design.doc` is set. The next `set_doc` restores the pointer.
*   **2.23:** with `DESIGN_DEFAULT_TRACK` at `direct`, a test cannot tell the ready path from the fallback. The test asserts the constant and the `track: direct` line.
*   **Checkpoint:** the project name `sandbox` resolved to the operator's `local/sandbox/spinner.yaml` (the daemon's cwd is the repo root) and not to `<scratch home>/projects/sandbox`. The session's worktree and the branches `feat/spinner-checkpoint-…` and `…-r2` went into the operator's clone of the sandbox repository. Nothing was pushed.
*   **Change for the protocol:** a scratch e2e names its project by the absolute path of its `spinner.yaml`, never by a name.
*   **Change for the UI (2.33, 2.47):** at 1600 px the context-bar title shrinks to `Spi…` beside the stepper and the round badge. The title needs a minimum width.
*   **Tests:** the existing `watcher_live` probe test timed out at its 5-second bound in 1 of 7 full daemon runs under load.

### Session 3

The P11 rerun ran on a scratch daemon with the real pi and the sandbox repository (runs E and F of `docs/egm/HARNESS_EVIDENCE.md`). A design-track session ran brainstorm, draft and review from `POST …/design/run`, and 8 `ask_question` gates were answered through `POST …/design/answer`. The lead proposed the `design` track, started no skill on its own, and after the review held at `approved: false` without a commit. Session 1's P11 failure (the lead built after the brief) did not recur.

*   **T7, 2.9, egm-resolve Step 5:** EGM writes its marker as `**Status: resolved** (…)` on the third line of `goldfish_review_report.md`, under the `#` heading. Rule 2 reads the first non-empty line for `Status: resolved`, so the stage stayed `resolving` after the resolve finished. The rule needs to find a `Status: resolved` line near the top, with or without bold. Build session 6 owns the resolve check.
*   **3.9:** the entry gives `no design doc yet` only for `egm-review` with `preset`. The built variant: `egm-review` without `preset`, `egm-review-loop` and `egm-resolve` take `args`, else the absolute doc path, else 409 `no design doc yet`. `egm-draft`, `egm-drift-report` and `egm-bootstrap` answer 409 without a worktree of the designs repo. Operator `args` to `egm-draft` follow the composed text. A skill run on the direct track is not refused.
*   **3.19, T12:** the dialogs prefill the absolute doc path and designs directory, which `DesignView` did not carry. `DesignView.repo` and `DesignView.designs_dir` were added, optional as in the 2.40 finding, and the daemon always sets them.
*   **3.15:** with the "Proceed to /egm-draft" option chosen, the lead ended the brainstorm and waited, as the brief says. The driver then sent "Continue.", and the lead started `egm-draft` without the composed `Context File` and `Target directory`, so EGM asked the save gate. The driver should click `draft` (`POST …/design/run`) at once after that answer.
*   **3.15, 1.26:** a numbered list of questions can end with "Answer in whatever order you like". The driver reads a question when one of the last 2 paragraphs has a `?`.
*   **3.15:** run E stopped on a driver bug: a top-level constant read by `main()` before its initialization. A driver with top-level `await main()` must declare its tables inside functions or above the call.
*   **3.15, the operator's decision:** P11 ends when the lead holds for approval after the review. The resolve step moves to build session 6's row of the Verification Plan.
*   **3.1, 3.14:** the 2.23 test that expected `direct` was updated in the protocol commit, so the daemon suite stayed green at that commit.
*   **3.16:** the protocol commit changed no schema file; the request bodies are outside the session and view schemas. The `DesignView` fields changed `session-view.json`.
*   **Cost:** run F's `SessionView.cost` was $15.50 for the lead, and the child `meta.json` files sum to $10.20 for the Goldfish. The review was the largest step (844 s).
*   **Tests:** `operator.test.ts` timed out at its 5-second bound in 1 of 2 full daemon runs at load average 7, and passed alone.
*   **Change for the protocol:** a driver change that spends model money gets one short run that stops at the first gate before the full run.

### Sessions 4 and 5

The engine entries of both sessions were built in one session (s036). Run G of `docs/egm/HARNESS_EVIDENCE.md` ran on a scratch daemon with the real pi and the sandbox repository. P1 to P8, P11 and the workspace row W1 passed.

*   **4.4, T5:** pi-subagents 0.84.0 runs an async fan-out as one `mode: workflow` run. Each step names a child run (`steps[].runId`), and each child writes its own run directory with the same `sessionFile`. Read as the entry says, every Goldfish shows twice and costs twice. In run F, 3 of 21 run directories were workflow roots. The built variant drops a workflow step whose child run is read too. The chip key is then the child's `<runId>/0`.
*   **4.4, session 1 finding 4:** the watcher reads foreground runs from `agents/lead/pi/subagent-artifacts/<runId>_<agent>_<i>_transcript.jsonl` when the run has no async directory. A `meta.json` gives `done` or `failed` from `exitCode`. Without it the step is `running`, or `stopped` while the lead is not busy, so it cannot hold the cap. The child's pi session is `<lead pi>/<lead session>/<runId>/run-<i>/session.jsonl`. That file is the source of cost and of events.
*   **4.4:** `GoldfishStep` gained `index` and `child_run`, and `GoldfishRun` gained `foreground`. The entry's interface has no field for either rule above.
*   **4.4, 4.8:** the stage `intake` maps to the step `brainstorm`. So a Goldfish that runs before any skill counts as brainstorm cost. In run G, the 2 probe Goldfish of P2a and P2c are in `cost_by_stage.brainstorm`.
*   **4.6, T6:** child costs move only when the ledger refolds: at `agent.settled` and every 60 s. A lead in one long turn shows Goldfish costs up to 60 s late. In run G a chip went from $0.109 to $0.326 at one refold.
*   **4.6 (inferred, not tested):** a status file names absolute paths under `<home>/sessions/`. After `close` moves a session to the archive, those paths do not exist, so the ledger skips the archived session's Goldfish.
*   **4.8, 4.11:** the view reads the run files at each request, not the watcher's last tick. P6 saw the 6 chips 276 ms after the launch. The 2-second poll bounds only the push of `session.updated`.
*   **4.9, 5.3:** the workspace routes of 5.3 were built in the commit of 4.9, because both entries change `egm/routes.ts` and its test.
*   **4.10:** the EGM routes now mount only with `goldfish` set. `routes.test.ts` was the only test that built them.
*   **4.11:** the driver adds the row W1 for build session 5: the brief, the consolidated report and the doc read through the workspace routes.
*   **P11, run G:** the stage ended at `resolving`, not `design-ready`. After the driver's "Continue." in the review, the lead wrote `goldfish_review_report.md` with "the scope the operator approved". The lead read a bare "Continue." as approval of a scope. It still held for approval and changed no code.
*   **Cost:** run G's `SessionView.cost` was $16.89 at the end: $9.02 for the lead and $7.87 for 17 Goldfish steps. By step: brainstorm $2.75, review $5.13. The draft ran no Goldfish.
*   **Change for the design:** state the two shapes of pi-subagents 0.84.0 in T5 and 4.4: workflow runs with child runs, and foreground runs. Give each chip one key and one cost source.
*   **Change for the protocol:** the e2e drivers are outside every `tsconfig`, so no check type-checks them. This session checked the driver with a scratch `tsconfig`. Add `packages/daemon/e2e` to a typecheck script.

### Session 6

Three agents built session 6 in one session (s037): `engine`, `engine-pipeline` and `ui`.
Run H of the driver (`SPINNER_E2E_PROBES=approve node packages/daemon/e2e/egm-harness.ts`) ran on a scratch daemon with the real pi and the sandbox repository.
It seeds a design doc and a consolidated report with two `Severity: High` findings, so brainstorm, draft and review do not run.
Six rows passed in 5 minutes for $1.81: R1 (resolve), A1 (approve and build), E1 (an edit clears the approval), L1 (the lock), RA (re-approval) and PR1 (the PR body).
No GitHub write happened: the clone pushed to a local bare repository through `pushInsteadOf`, and the daemon's `gh` was a scratch script that answered `pr create` with a fake URL.

*   **6.13, T10:** the worktrees live under `<session>/worktrees/`. A design check "after the session-directory check" never blocks a code write. The built guard runs the design rule first and counts `worktrees/` as code, except the designs directory. The out-of-area glob guard has the same hole for worktree paths; it is not changed.
*   **6.13:** with `designs_dir: null` in `.state.json`, a locked lead can write only the session's own files.
*   **6.2, T10:** T10 does not say what `build: true` does while the lead is stopped. The built route answers 409 before any write, so an approval never stands without its build prompt. It also answers 409 when the doc is missing from the worktree. The build message names the absolute doc path.
*   **6.2, run H:** `egm-resolve` writes every finding as `### [Issue n] … - Severity: High` and keeps the severity after it applies the fix. So the approval after a resolve lists all High findings, fixed or not. Run H's approval needed "approve with 2 listed blockers" after both fixes were applied.
*   **6.3:** the approval tests that need a session, a worktree and a recording lead run through the routes in `egm/routes.test.ts`. `approve.test.ts` holds the pure ones.
*   **6.6:** the change notice reaches a tty lead as a custom message. `GET …/agents/:name/events` does not list custom messages, so the driver reads the notice from the lead's transcript. In run H the lead answered it with a Log line and changed no code.
*   **6.6, run H, driver:** the view derives `changed_after_approval` from the disk at once; `needs_human` changes when the tracker's doc watcher writes `session.yaml`. Run 1 of H read `needs_human` between the two and failed E1. The driver now waits on the needs line.
*   **T10, 2.9:** a doc changed after approval read `design-ready` in run H, because the consolidated report was in the current run. Session 2's finding still holds without a concluding report: such a session reads `drafted`, and the UI's approve button (6.17) is only at `design-ready`.
*   **6.8 (engine-pipeline):** "the `## Overview` body" runs to the next `## ` heading, so `###` subsections go into the PR body. A doc that is missing from the worktree falls back to the mission body (6.9) and the Goal line (6.10).
*   **6.10 (engine-pipeline):** the Slack message gets a second line `Design: \`<doc path>\``, which the entry does not name.
*   **6.20 (engine-pipeline):** the fix job wrote `session.yaml` from the summary it started with, so the counter written before it was lost. The fix job now continues from the summary that `count_outcome` returns.
*   **6.20, ownership:** `AgentMessageRequest.source` and its parse in `packages/daemon/src/requests.ts` went into `engine`'s protocol commit, because `engine-pipeline` owns neither file.
*   **6.22 (engine-pipeline):** the entry names `server.test.ts`, which no brief gives to the owner of 6.20. The steer-route tests are in `pipeline/outcomes.test.ts`.
*   **6.16, 6.17 (ui):** one listed blocker reads in the singular. `remove approval` posts `DELETE` at once, without a confirmation. `fetchDesignApproved` has no caller in the UI. The changed sections start with the blank line under the heading, and the dialog strips it.
*   **Run H:** `OperatorHost.notice` asserted "a notice line is one line" on the PR job's multi-line `gh` error (`agents/operator.ts`). The daemon logged the failed listener and continued.
*   **Change for the design:** say in T10 that the blocker count does not drop after a resolve. Or let `egm-resolve`'s categories count: an applied `PROPOSE FIX` is not a listed blocker.
*   **Change for the design:** name the worktree layout in 6.13, and give the guard rule its place before the session-directory exemption.
*   **Change for the protocol:** an e2e row that ends in a GitHub write (`create PR`) needs a fake `gh` and a local push target in the driver, so no agent posts while the operator is away.

--------------------------------------------------------------------------------

<!-- Provenance: Indicates initial structural drafting via EGM. -->

*Drafted with EGM*
