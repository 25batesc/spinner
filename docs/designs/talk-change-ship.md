# Talk, change, test, ship: Spinner's way of working

* **Author:** the operator and his agent, in conversation
* **Date:** 2026-11-12
* **Status:** Approved by the operator on 2026-11-12. Step 1 is built in v0.25.0, step 2 in v0.26.0, step 3 in v0.27.0, step 4 in v0.28.0. Step 5 is approved in outline, with R10 open; it gets its detail before it is built.
* **Review:** Not reviewed by Goldfish. The operator read the proposal and answered its five decisions. This doc replaces the EGM adoption's rule that the design track is the default (`egm-adoption.md`, D1).

## Overview

Spinner's main job is this: a request goes in, a pull request that is ready to merge comes out, and the agent keeps it ready. The operator talks; the agent changes code, tests it, opens the pull request, and answers failed checks and review comments without waiting. One conversation produces several pull requests. Planning with EGM stays, as a tool the operator picks for a large change, not as the frame of every session.

## Background

Two weeks of daily use showed three things.

1. Most work is a targeted change. Since `egm-adoption.md`, every new session started on the design track: brainstorm, draft, review, approve, then build, with a gate at each step and a lead that waits for an answer. A small goal grew into a large one.
2. The operator compared this with another agent product. There you drop in and talk. The agent starts to change code. One session makes several pull requests. The agent tests them, opens them, watches them, and keeps them mergeable. Every pull request it made is easy to see.
3. Planning is still useful for a large project. But it is a separate activity. A plan made earlier must be usable later: seed a session with it, then implement it.

The cause is in the model. One session is one branch, one pull request per repo, one stack and one EGM track. These are four separate things. Because they are one, a second change needs a `reset` (a "round"), a plan exists only inside the session that builds it, and the process of the large case is the process of every case.

## Goals

1. A new session starts work with no gate, no track to choose and no plan to approve.
2. The agent builds, verifies, opens the pull request, and keeps it ready: it fixes failed checks and answers review comments on its own.
3. One session holds several changes, each with its own branch and pull request.
4. The local stack tests the change the operator points it at.
5. A plan is a document in a library. Planning is optional. EGM's steps are tools on a plan. "Implement this plan" is an action on any session.
6. The operator sees every pull request Spinner made, with its checks, threads and state.

## Non-goals

1. Merging without the operator. Merge, Slack posts and approvals stay his click, unless he tells the agent.
2. Two changes built at the same moment by two agents in one session. One workspace per session; parallel worktrees can come later.
3. Removing EGM, the Goldfish, the mission board, the stack, previews, preview comments, the Reviews panel or the worktree sync. They stay.

## The model

| Thing | What it is | Before |
|---|---|---|
| **Session** | A conversation with an agent in one project. Long-lived. Not tied to a branch. | One branch and its pull requests. |
| **Change** | One unit of shipped work: a branch, and its pull request in each repo it touches. A session has any number. | One per session; the next needed `reset`. |
| **Plan** | A document: what to build, in which steps. It lives in Spinner's library, outside any session. | The design doc of one session's EGM track. |
| **Stack** | The local running app. One per session. It runs the change the operator selects. | Fixed to the session's branch. |

How they join:

* A session **starts** changes as the talk goes on. "Also fix the export button" is a second change and a second pull request. The first stays open and watched.
* A plan is **attached** to a session, at the start or later. `Implement` on a plan makes the agent turn its steps into changes; the steps tick as the changes land. The mission board (planned, doing, done, the timeline, the roster) is the view of a plan in progress.
* A planning session is a session whose product is a plan, not code. EGM is its toolset: `brainstorm`, `review`, `resolve`, each one click, in any order, none required.
* The stack **follows** the selected change: `test locally` on a change.

## Decisions

| # | Question | Decision (2026-11-12) |
|---|---|---|
| R1 | A workspace per session, or per change? | Per session. A change is a branch in it; the agent switches branches. One stack per session. |
| R2 | How far does the agent go without the operator? | It opens pull requests, pushes fixes, and answers review comments from bots and from people. Merge, Slack posts and approvals stay the operator's click. |
| R3 | Where does a plan live? | In Spinner's library (`~/.spinner/plans/`). Saving it to a repo's `docs/designs/` is a later, optional action. |
| R4 | Build step 1 before the rest is detailed? | Yes. |
| R5 | The Agents view design in flight (session s052)? | Paused until steps 2 and 5 are detailed; its findings fold in then. |
| R6 | The database when `test locally` switches to another change? | Kept as it is, until that hurts (2026-11-12). No spec command for a worktree's migrations yet. |
| R7 | Where does planning happen? | In a `Plans` view of the sidebar. A plan opens a planning session: the chat, the plan document, the EGM steps as optional buttons, no worktree needed. An approved design doc of an old session opens there as a plan (2026-11-12). |
| R8 | What does `Implement` do? | It attaches the plan to a session the operator picks, or a new one, and seeds the mission board. The agent makes one change per step or group of steps. The mission view stays as the view of a plan in progress (2026-11-12). |
| R9 | The Agents view (step 5)? | One row per agent: role, state, current action, context, cost; finished agents folded. The draft of s052 folds in, then s052 closes (2026-11-12). |
| R10 | The middle pane and the toolbar (step 5)? | The pull request actions live in the session's PR view (2026-11-13: "a pr view for each session that also shows the CI status, approval status, etc. … and also includes our top action bar for pr's"). The toolbar keeps `run local`, `stop local` and its menu. The view tabs of the middle pane are still open. |

## What the operator sees (after step 5)

```
┌──────────┬──────────────────────────────────┬───────────────────────────┐
│ Sessions │ Chat with the agent              │ Changes           Preview │
│ Plans    │                                  │ ● Parallel exports        │
│ Reviews  │ you: run the two exports         │   backend #482   ✓ CI     │
│ PRs      │      in parallel                 │   2 threads · +84 −31     │
│          │ agent: on it. assumed: …         │   [test locally] [merge]  │
│ session  │ agent: PR #482 opened.           │ ○ Fix the export button   │
│ session ●│ you: also fix the export button  │   web: building…          │
│          │ agent: started a second change.  │ Plan: (none)  [attach]    │
└──────────┴──────────────────────────────────┴───────────────────────────┘
```

* The chat is the centre (dogfood decision 32); the terminal is an opt-in view.
* The Changes rail has one card per change: its pull requests, checks, open threads, lines changed, pushed or not, and its state in plain words (`building`, `PR open`, `fixing CI`, `answering review`, `ready to merge`, `merged`). The card carries one or two actions. It replaces the toolbar's fixed row of buttons.
* The PRs view lists every pull request Spinner made, across sessions.
* The Plans view is the library: each plan's status (draft, reviewed, implementing 3 of 7, done) and the sessions that implement it.

## Build steps

Each step ships on its own.

| Step | What the operator gets | State |
|---|---|---|
| 1 | The fast path as the default, inside the one-change session of today. | Built, v0.25.0. Detail below. |
| 2 | Changes: several pull requests in one session; the Changes rail; the PRs view; `round` and `reset` go away. | Built, v0.26.0. Detail below. |
| 3 | The stack follows the selected change; `test locally` on the card. | Built, v0.27.0, with the database kept across a switch (3.4 is open). Detail below. |
| 4 | Plans: the library, planning sessions with EGM as optional tools, `Implement`. | Built, v0.28.0. Detail below. |
| 5 | The chat as the centre; the old toolbar and view tabs removed; the Agents view redone on the new model. | Built: the chat (v0.29.0), the message box's controls, the PR view and chip, the Agents view (v0.30.0). Open: what becomes of the middle pane's view tabs. |

### Step 1 in detail (built)

**1.1 The track.** `DESIGN_DEFAULT_TRACK` is `direct`. `NewSessionRequest.track` (`design` or `direct`) lets a caller ask for the design track; the composer has a `Plan first (EGM)` box for it. `design` holds only when EGM is ready and no pull request was adopted. The track chip still switches a session later.

**1.2 The lead's brief.** The fast path comes first: start now; decide open points and log each as `assumed: …`; ask only when a wrong guess destroys data, spends money, cannot be undone, or when the lead cannot tell what to build; keep the change the size of the request; a title and a short Goal, a Plan only for more than three steps or more than one agent; commit by path; verify (tests, lint, types, the stack for a visible change); open the pull request; keep it ready; the merge is the operator's. The EGM rules are one section that applies only on the design track, which the lead never proposes and never starts. The Log is for milestones, not turns.

**1.3 The lead's prompt section.** Off the design track it carries four lines of the fast path and, with EGM installed, one line that EGM is off until the operator turns it on. On the design track it carries the Elephant's lines, as before.

**1.4 The lead's tools.**

* `pr` gets the command `open`: the same job as the `create PR` button (push, one pull request per changed repo, the body from the mission), waited for, with its log as the answer.
* `stack` gets the command `up`: the same job as `run local`, waited for.
* `thread_list`, `thread_reply`, `thread_resolve` and `thread_flag` are the lead's too, not only the fixer's.
* `pr open`, `thread_reply` and `thread_resolve` are GitHub writes as the operator. The lead has them only with `settings.agents.github: full`; with `guarded` they answer that the operator must do it.

**1.5 Autopilot.** After each poll of a session's pull requests, with `agents.github: full`, the daemon tells the lead what needs it:

* The checks of a pull request are red at a head the lead was not told about. The message names the pull request, the head and the failing checks.
* Open review threads the lead was not told about, from bots and from people, not flagged. The message names the pull request, the count and the thread file.

One message per session per poll carries everything new. A stopped lead is resumed for it. The daemon remembers what it sent in `session.yaml` (`pipeline.autopilot`: the red head per repo, the count of red rounds in a row, the thread ids told). After `AUTOPILOT_RED_MAX` (5) red heads in a row on one pull request, the daemon stops telling the lead about that pull request's checks and sets the reason for the operator; a green head resets the count. A reviewer's later reply inside a thread the lead already answered is not detected in step 1; the operator steers the lead, or uses `fix`.

**1.6 What step 1 does not change.** One change per session, `reset` for the next. The toolbar, the view tabs, the mission tools. The `fix` button and the fixer agent, for use by hand.

### Step 2 in detail: changes

**2.1 The shape, with no migration.** The top-level fields of `session.yaml` that describe one change stay where they are and mean *the current change*: the branch checked out in the session's worktrees. They are `branch`, `repos[*].changed`, `repos[*].pr`, `pipeline`, `stage` and `needs_human`. Two fields are new:

* `change: { id, title, started, on? }` names the current change. Absent in a file written before, it reads as `c1` with the session's title and creation time.
* `changes: ChangeRecord[]` holds every other change of the session, open or finished: `{ id, title, branch, repos: { <key>: { changed, pr } }, pipeline, stage, needs_human, started, ended?, on? }`. At most `CHANGES_MAX` (200); past it the oldest finished record drops.

A file written before is valid as it is, so nothing migrates and every reader of the top-level fields keeps working. This replaces the outline's "move under a change"; the model is the same. The `rounds` records of earlier resets are read as finished changes. Ids are `c1`, `c2`, …, one more than the highest in use.

**2.2 The focus.** Every pipeline function reads a `Session`. To run one on a change that is not the current one, the daemon *focuses* the session: a copy whose top-level change fields are that change's (`focus_change`). `SessionSummary.focus` carries the change id. `write_session` of a focused summary reads the file again and stores only the change fields, into the top level when that change is current on disk at that moment, else into its record. So a slow job (a `land` that watches the merge queue for an hour) never writes a stale session over a change the lead started meanwhile. The poll and the operator's `land`, `post` and `approve` always run focused. The session-level facts (the design gate, diff comments, preview comments, the review draft) belong to the current change's derivation only.

**2.3 Start and switch.** `POST /sessions/:dir/changes { title, on? }` starts a change; `POST /sessions/:dir/changes/:id/switch` makes another one current. Both are jobs, and both:

* refuse while a worktree has uncommitted changes, with the paths;
* push the current branch first when it has a remote branch and is ahead, so a parked change is never left unpushed;
* then swap: the current change becomes a record, and the new or chosen one becomes the top level.

`start` makes the branch `feat/<slug of the title>` from fresh `origin/<base>` in every worktree, or from the branch of the change named by `on`. A current change with no commit and no pull request is not kept as a record; the new one replaces it. A change started `on` another opens its pull request against that change's branch while that pull request is open, and against the repo's base after. The default is `base`: independent pull requests. The stack is not touched (step 3).

**2.4 The lead's tools.** `change` with the commands `list`, `start { title, on? }` and `switch { id }`, for the lead only. `pr open` takes `body`: the description of this change (what, why, how it was verified). The title of the pull request is the change's title. Without `body`, the first change falls back to the mission's Goal and Log. The extension guard refuses `git checkout -b`, `git switch -c` and `git branch <name>` for every agent and names the `change` tool (dogfood #54: a lead that improvised a branch left the session on the wrong one).

**2.5 When the lead starts a change.** The brief says: one request is one change and one pull request. A new request that does not belong to an open pull request is a new change; a follow-up to an open one is a commit on it; work that needs an unmerged change starts `on` it. The operator can say "put this in the same PR" or "make this its own PR". There is no `new change` button: the operator's way to start work is to talk.

**2.6 Poll, stage, autopilot, threads.** The poller polls the open pull requests of every change, focused, and derives each change's `stage` and `needs_human`. A transition's notice names the change when the session has more than one. The autopilot keeps its state per change (`pipeline.autopilot`). For a change that is not checked out, its message says so and tells the lead to commit, `change switch`, fix, and switch back. Thread files stay `threads/<repo>-<n>.md`: the pull request number already makes them unique, so the outline's `threads/<change>/` is not needed. `thread_list`, the thread tools and the Threads view cover the current change; the lead switches to a change before it answers that change's threads. The worktree sync is unchanged: it pushes what is checked out.

**2.7 The operator's actions per change.** `land`, `post` and `approve` take `?change=<id>` (default: the current one). `land` is not an exclusive job, so a pull request that waits in the merge queue does not hold up the next change. A merge needs no worktree. The one case that does, the rebase after a pop-out of the merge queue, checks that the worktree is on the change's branch and stops with a clear message when it is not. `create PR`, `fix` and `verify` act on the current change. `reset` stays as a route and a CLI command for one release and leaves the UI; a merged change needs nothing from the operator, so `needs_human` of a merged session is null, not `close or reset`.

**2.8 What the view carries.** `SessionView.changes`: every change, oldest first (earlier rounds, records, the current one), each with `id`, `title`, `branch`, `current`, `state` in plain words, `needs_human`, its pull requests and `on`. The states: `empty`, `building`, `PR open`, `fixing CI`, `answering review`, `in review`, `ready to merge`, `in merge queue`, `merged`, `closed`. A pull request carries `diff: { files, additions, deletions }` from the poll.

**2.9 The UI.**

* **The Changes rail** is a tab of the right pane, beside `previews` and `diff`, and the default tab while the stack is down and a pull request exists. One card per change, the current one first, finished ones folded: the title, the state, a line per pull request (repo, number, checks, open threads, `+n −m`), what it needs, and its actions (`merge` with a second click to confirm, `post`, and `create PR` on the current change).
* **The PRs view** is a third icon of the sidebar's rail: every pull request Spinner opened, across sessions, open ones first. A row opens its session; the number links to GitHub.
* **The session card** shows the current change as today, and `+n` for the other open changes. Its needs line is the first change's that needs the operator.

**2.10 Not in step 2.** Two agents on two changes at once (non-goal 2). A reviewer's later reply in a thread already answered. The stack following a change (step 3).

### Step 3 in detail: the stack follows a change

**3.1 `test locally`.** Each open change's card has `test locally`. It runs the `up` job with `{ change: <id> }`. For the current change it is `run local`. For another change the job first makes it the current one (the `switch` of 2.3, with its refusal on uncommitted work), stops a stack that was up, and starts it again, so every service runs the change's code. The job refuses while an agent of the session is in a turn: that agent writes to the worktrees. The lead's `stack up` is unchanged; it runs what is checked out.

**3.2 `tested`.** A card shows `tested` when the operator's `verified` tick stands at the head of every open pull request of the change. The tick is the one of the previews pane; it belongs to the current change, is kept with the change when it is put aside, and a new commit clears it (as before).

**3.3 The lead knows what is checked out.** With more than one change, the lead's prompt section lists the open changes at every turn and marks the one that is checked out, because `test locally` can move the worktrees between two turns.

**3.4 The database is kept (R6).** The outline said the database is re-cloned when the migrations differ. Spinner cannot tell: the spec builds the template with a project command and has no command that applies a worktree's migrations to the session's database; the lead applies them by hand today. So a switch keeps the session's database as it is. The operator decided to keep it so until it hurts; the remedy then is a spec key for that command, so a switch re-clones and migrates.

**3.5 Found on the way.** A branch name the repositories already have (an older session used the same title) gets a number. The stack jobs store only the `stack` field into the file as it is at that moment, as the focused writes of 2.2 do.

### Step 4 in detail: plans

**4.1 The library.** `~/.spinner/plans/<plan id>/` holds one plan: its document (a `.md` file with `## Overview` and `## Detailed Implementation Plan`, as a design doc has) and `plan.json`, its record: `{ id, title, created, updated, project, doc, origin, implementations }`. `origin` names the session the plan was written in. `implementations` lists the sessions that implement it, each with the time and the hash of the document it took. The plan id is the directory name of the session the plan was written in.

**4.2 A planning session.** `POST /plans { text, title?, project? }` makes a session with `kind: plan` on the design track and starts its lead, as `POST /sessions` does. Its product is the plan document, not code. Its designs directory is `~/.spinner/plans/<session dir>/`, with or without a project: the design tracker answers that location for a `kind: plan` session, and `design.repo` is the constant `plans`. A project gives the agent worktrees to read; the brief forbids code changes. The lead writes the document from the talk and names it with `design_doc`. The EGM skills (`brainstorm`, `review`, `resolve`) are the buttons of the session's Brainstorm, Draft and Review views, in any order; none is required. A planning session is listed under Plans, and under Sessions with a `plan` mark. It works without EGM installed: the lead writes the plan from the talk.

**4.3 The list.** `GET /plans` answers every plan: `id`, `title`, `status`, `doc` (whether the document exists), `entries` and `done` (the plan entries and how many are done), `session` (the planning session while it lives), `implementations` and `updated`. The statuses: `draft` (no document yet), `drafted`, `reviewed` (a review ran), `implementing` (`done` of `entries`), `done`. `GET /plans/:id/doc` answers the document.

**4.4 Old designs.** At start the daemon imports every session, live or archived, that has `design/approved.md` and no plan: the copy becomes the plan's document, and the session is its first implementation. Sessions on the design track from before stay as they are.

**4.5 `Implement`.** `POST /plans/:id/implement { session?, project? }` attaches the plan to a session: the one named, or a new one with the plan's title (and the project given, else the plan's). It refuses without a document, for a document the seed cannot read, and for a review or planning session. It then:

1. copies the document to `<session>/design/approved.md` and records it as the session's approved design (`design.doc`, `design.repo: plans`, `design.approved`); the session stays on the `direct` track;
2. seeds the MISSION.md Plan from the document's entries (the seed of `session-workspace.md`), so the mission view shows the plan in progress;
3. writes the Log lines, records the implementation in `plan.json`, and tells the session's lead: implement the plan, one change per step or group of steps, tick each item when its entry is done.

A later edit of the plan's document marks the session's copy as changed, as an edited design doc does; `Implement` again re-seeds.

**4.6 The UI.** The sidebar gets a `Plans` view: one row per plan with its status and the sessions that implement it, and `+ New plan`. A row with a live planning session opens that session, under a bar with the plan's status and `Implement`. A row without one opens the plan's page in the middle pane: the same bar and the document. `Implement` has a choice of session: a new one, or a live code session. The composer's box is now `Make a plan (no code)`; it starts a planning session.

**4.7 Not in step 4.** Removing the track chip and the EGM tabs from code sessions (step 5). Comments on the plan document (the `doc` anchor of preview comments). Saving a plan into a repo's `docs/designs/`.

### Step 5 in detail: the chat as the centre

Step 5 ships in parts. Part A is the chat (5.1 to 5.6). The Agents view (R9) and the removal of the toolbar row and the view tabs (R10, open) follow.

**5.1 The chat is the default surface of every agent.** An agent's tab shows `chat`, `terminal` and `context`. `chat` is the default; a pick of `terminal` is remembered for the window, so an operator who prefers pi's own UI stays in it. A terminal connects to the agent only once its tab was shown. An `rpc` agent has no terminal tab, as before.

**5.2 What the chat shows.** The operator asked for the shape of the agent product he compares with (2026-11-13). The chat is a centred column, oldest message first, read from the agent's pi transcript and then live. A turn is three things:

* The operator's message, as he wrote it, as a pill at the right, with a count of the images it carried.
* The agent's work, folded to one line: `Worked for 2m 29s · 14 steps`, or `Thought for 8s` when it called no tool. A click opens it: the thoughts, the remarks the agent made on the way, and each tool call as a row (a state mark, the tool's name, what it acts on) that opens to its arguments and its result. While the turn runs the line says what the agent does now: `Working · bash pnpm test`.
* The agent's answer, as rendered markdown with the line breaks it wrote. The answer is the turn's last text with no tool call after it.

Under the last message a line says `lead is working`, `lead is awaiting instructions` or that the agent is stopped. The view stays at the newest message while the operator is there, and a round button jumps back once he scrolled up. It draws the newest 150 blocks and `show earlier` adds 300 more. The history holds up to 20 000 entries.

**5.3 One transcript from two sources.** The history is read from the transcript file when the tab opens, when the agent is resumed, and at the start and the end of each turn; live events add to it. A message that both hold shows once: a message is matched by its timestamp, a tool call by its id, and a tool call the history holds as running takes the result the live events bring. The tty extension posts the message events (the start, the text and thinking deltas, the whole message at the end) besides the lifecycle events.

**5.4 The message box.** One rounded card at the bottom of the column: a text area that grows with the text, up to 12 lines, and a row of tools inside the card. Enter sends; Shift+Enter makes a new line; a paste of many lines stays one message. While the agent works, the message is a steer, and with an empty box the send button is `stop`. A message to an agent that is stopped resumes it first (dogfood #57): the daemon's `prompt` and `steer` routes do that for a message marked `source: operator`.

**5.5 Files and images.** The `+` button, a paste and a drop attach files. An image is saved to the session as a PNG (`POST /sessions/:dir/attachments`; the browser converts another format) and goes to the agent as an image. Another file is saved with `POST /sessions/:dir/uploads`; in the desktop app its own path is used and nothing is copied. Each attached file shows as a chip, and the message ends with one `Attached file: <absolute path>` line per file.

**5.6 Skills and commands.** `/` at the start of the box, or the `/` button, lists the agent's skills and prompt templates (from `GET …/agents/:name/context`), filtered as the operator types; the arrows pick, Enter or Tab completes `/skill:name `, Escape closes. The tty extension expands a `/skill:` message into the instruction to read the skill file. Extension commands of pi (`/model`, `/compact`) are not messages; the box has its own controls for those.

**5.7 Model, thinking level, dictation.** The card's tool row has the agent's model and its thinking level as two pickers. A pick calls `POST …/agents/:name/model` or `…/thinking`; the daemon tells pi, records the value in `session.yaml`, and the record follows a change made in pi's own terminal. The microphone button dictates into the box through the browser's speech recognition. The desktop app's shell has no such service: there the button says so and names the system's dictation key.

**5.8 Not in part A.** Editing or resending a past message. Search in the transcript. A searchable model picker (the list is pi's whole catalogue).

**5.9 The PR chip and the PR view (R10).** Beside the session's title the context bar shows a chip: the pull request's number for one, the count for several, coloured by the worst state. A click lists every pull request of the session (title, `repo#n`, size, CI, state); a row opens the PR view on that change, and its arrow opens GitHub. The PR view is the right pane's `PRs` tab (the Changes rail of 2.9 under its new name). Each change is a block: its state, `tested`, `posted` with the Slack link, what it needs. Each pull request shows its state, CI with the failing checks, the approval (who is required, who approved, the approval check), the review decision, the threads, the merge queue, the size, the head and when it was updated. The block ends with the actions that were the toolbar's: `test locally`, `create PR`, `review`, `fix`, `post`, `approve`, `merge`. An action that cannot apply now is disabled and says why; `create PR`, `review` and `fix` act on the change that is checked out.

**5.10 The Agents view (R9).** The head of the view is the agent in focus as one line; a control at its end (`12 more`) drops the list of every agent down over the chat, and a pick there moves the focus (the operator's request of 2026-11-13). The list has one row per agent, in three groups (session agents, reviewers, Goldfish), and `+ add agent` as its last line. A row is a state dot, the name, the role, what it does now, the model, the context use, the cost, and its actions (`interrupt`, `compact`, `stop` with a second click, `resume`). What it does now is the running tool call of the live transcript, else the Roster's `doing`. A change of state never moves a row; finished rows fold under `n finished`. The selected row's chat, terminal and context show below the list. `AgentSpec.ended` (`code`, `by`, `at`) lets a row tell `stopped`, `done` and `failed` apart; a resume clears it.

**5.11 The activity.** The log of the watched job and the event feed are a tab of the right pane, `activity`, beside `PRs`, `previews` and `diff`; the bar under the chat is gone (the operator's request of 2026-11-13). The tab's label says `running` or `failed`. A failed job, a failed action or a new needs-you line shows the tab, and brings the pane back when it is collapsed, until the operator picks another tab; the tab he had picked for the session is kept. The message box has no line under it: the cost is on the agent's row.

**5.13 The lead's question, on the message box.** The card above the agents (`The lead asks`) was large and stood in the way of the work (the operator, 2026-11-13, with a reference for the shape he wants). The question is now a card of the message box's width, right above the box: the question, one numbered row per option (a title and its detail), a `Something else` row to type another answer, and `Skip`, which tells the lead to take the option it recommends and log the assumption. The cross folds the card to one line; the question stays open. The box says `Or reply directly…`: a message to the lead answers the gate. The line under the messages says `lead waits for your answer`. The resolve gate of an EGM review shows the same way. The context bar still names the question, and the Brainstorm and Review views keep their one-line pointer to Agents.

**5.14 The name.** The agent the operator talks to is called Remy (2026-11-13: "to humanize it a bit and make it kinda cute and fun"). The name is one constant, `ASSISTANT_NAME`. The app shows it wherever the operator meets the session's lead: the agent's row, the message box (`Ask Remy to build features…`), the line under the messages (`Remy is on it`, `Remy is ready when you are`, `Remy has a question for you`, `Remy is resting`) with a small round mark that breathes while Remy works, the question card, the needs-you line (`answer Remy: …`), the empty states of the mission view, the settings. The lead's prompt and brief tell it the name, so it answers to it. Under the surface nothing moves: the agent is `lead` in `session.yaml`, in MISSION.md, in the routes and in the tools, and the other agents keep their own names.

**5.15 Projects and stacks.** The operator had no place to see or manage projects, stacks and their settings (2026-11-13). The sidebar has a `Projects` view: one row per project (where it comes from, its repos and services, how many of its sessions have a stack up), `+ New project`, and under the list a `Stacks` section with every live session that has a stack: its state, its memory, `run local` and `stop local`. A project's page in the middle pane has three parts. `Overview` shows the repos (a path that is not a git checkout is marked), the services, the database and the pipeline settings with the daemon's defaults. `Spec` is the `spinner.yaml` in an editor with `Save` and `Revert`; the daemon checks a save as it checks a project an agent makes, and a refusal shows with its reason. `Sessions` lists the live sessions that use the project, with `open`, `run local` or `stop local`, and `update its copy`: a session keeps the copy of the spec it was attached with until then. `Delete` (or `Unlink` for a linked project) asks for a second click and is refused while a live session uses the project. Settings are edited as the file, not as forms. A spec that a home link and the checkout both name is one project.

**5.16 A chat that tells the truth about a turn.** The operator saw two faults (2026-11-13): the chat sometimes did not show the agent's latest message, and the status line said the agent worked when it did not. On the live machine both leads were recorded as `running`. One had written its final message 15 minutes before, and its pi still showed `Working`. The other had been inside one `bash` call for 2 hours and 14 minutes. The chat learned of a turn's end only from pi, so it had nothing else to show. Two changes. The chat asks the daemon every 15 seconds when the transcript was last written; when the transcript moved and then went quiet, the chat reads the history again, so a message whose live event was lost shows within about 30 seconds. When pi reports a turn and the transcript has had no write for 3 minutes, the status line says how long, names the tool call that still runs, and points at `stop`. The daemon does not end a quiet turn alone: a long test run is quiet too. Why a pi stays `Working` after its final message is not known yet.

**5.17 A second design in one session.** A lead that wrote a new design doc in a session with an approved design was refused: `the design is approved; clear the approval first`. The app had no control that clears an approval, so the lead asked the operator for a step he could not take. Now `design_doc` with another doc clears the approval alone, keeps its record in `design.approvals`, and writes one Log line. The new doc is not approved; it goes through review and approval as any design does. The approved doc itself is still refused while its approval stands.

**5.12 A project from inside a session.** A session started without a project has no worktree, no stack and no preview. The operator asked that its lead can make the project for the work it does and attach it (2026-11-13: a game built in a new repo, to run and to see in the session). The lead's `project` tool does it: `help` (the path of `docs/STACK_SPEC.md` and a small example), `list`, `create` and `update` (the whole `spinner.yaml` as text, checked and saved under `<home>/projects/<name>/`), and `attach` (worktrees on the session's branch, as a new session with a project gets). The lead then starts the stack with `stack` `up`. In the UI, the previews tab of a session without a project says so and offers both ways: `ask the agent to make one`, which sends the request to the lead, and a list of the projects that exist with `attach`. A session keeps the project it has; the same project attaches again after its spec changed.

## Risks

1. **An agent that decides instead of asking can decide wrong.** Limits: the change stays the size of the request; every assumption is one Log line; the pull request is the review point; nothing merges without the operator.
2. **Autopilot can loop on a check it cannot fix.** The cap of 5 red heads in a row stops it and tells the operator.
3. **The agent answers people in the operator's name.** That is decision R2, and it holds only with `agents.github: full`. A reply is one line on what changed or why not; a product call is flagged for the operator, not answered.
4. **Step 2 changes the shape of `session.yaml`.** The migration must keep every live session readable; it is the first thing step 2 details.
