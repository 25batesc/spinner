# Talk, change, test, ship: Spinner's way of working

* **Author:** the operator and his agent, in conversation
* **Date:** 2026-11-12
* **Status:** Approved by the operator on 2026-11-12. Step 1 is built in v0.25.0. Steps 2 to 5 are approved in outline; each gets its detail before it is built.
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
| 2 | Changes: several pull requests in one session; the Changes rail; the PRs view; `round` and `reset` go away. | Outline. |
| 3 | The stack follows the selected change; `test locally` on the card. | Outline. |
| 4 | Plans: the library, planning sessions with EGM as optional tools, `Implement`. | Outline. |
| 5 | The chat as the centre; the old toolbar and view tabs removed; the Agents view redone on the new model. | Outline. |

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

### Step 2 in outline: changes

* `session.yaml` gets `changes[]`: `{ id, title, branch, base, repos: { <key>: { pr } }, state, plan_step? }`. `session.branch`, `session.repos[*].pr`, `pipeline` and `round` move under a change. Files written before migrate forward: the session's one branch becomes its first change.
* The pipeline tracker, the thread files (`threads/<change>/<repo>-<n>.md`), the worktree sync, the autopilot and the fixer work per change.
* Lead tools: `change_start` (a branch from base, or on top of another change, in the session's worktrees), `change_switch`, and `pr open` per change. Switching refuses on uncommitted work.
* The UI: the Changes rail on the session; the PRs view in the sidebar; the context bar's stage becomes the selected change's state.
* Open point for the detail: a change that spans two repos is one change with two pull requests, as a session is today.

### Step 3 in outline: the stack follows a change

* `run local` takes the selected change: the worktrees switch to its branch (refused on uncommitted work), the database is re-cloned when the migrations differ, the services restart.
* The card of a change shows `tested locally` with the head it was tested at; a new commit clears it.

### Step 4 in outline: plans

* `~/.spinner/plans/<id>/`: `plan.md`, the EGM artifacts, the review runs. `POST /plans`, `GET /plans`, `POST /plans/:id/run` (an EGM skill), `POST /plans/:id/implement { session? }`.
* A planning session is a session with `kind: plan`: an agent, the chat, the plan document with comments, and the EGM tools as buttons. No worktree is required; a project gives the agent the code to read.
* `Implement` attaches the plan to a session and seeds the board from its steps (the seed of `session-workspace.md`). The agent makes a change per step or group of steps.
* The design track of a code session, the stepper and the design gate become the planning session. An approved doc of an old session opens as a plan.

### Step 5 in outline: the chat as the centre

* Spinner's own chat for every agent: markdown, tool calls as rows, images by drop and paste, Shift+Enter, whole pastes, the full history. The terminal is a toggle.
* The toolbar's fixed buttons and the view tabs give way to the Changes rail and the plan.
* The Agents view (one row per agent with role, state, current action, context and cost; finished agents folded) is redone on this model from the findings of session s052.

## Risks

1. **An agent that decides instead of asking can decide wrong.** Limits: the change stays the size of the request; every assumption is one Log line; the pull request is the review point; nothing merges without the operator.
2. **Autopilot can loop on a check it cannot fix.** The cap of 5 red heads in a row stops it and tells the operator.
3. **The agent answers people in the operator's name.** That is decision R2, and it holds only with `agents.github: full`. A reply is one line on what changed or why not; a product call is flagged for the operator, not answered.
4. **Step 2 changes the shape of `session.yaml`.** The migration must keep every live session readable; it is the first thing step 2 details.
