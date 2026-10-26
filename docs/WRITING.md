# Writing rules

A subset of ASD-STE100 for Spinner's docs, briefs, run sheets, system-prompt sections and tool descriptions. The reason is practical. Agents read the briefs every turn. Contributors turn the protocol into code. An ambiguous sentence costs on every run.

`python3 tools/doc-metrics.py --fail` checks rule 1 for briefs and run sheets. A person checks the rest.

## Rules

1. Keep sentences short. Procedures: 20 words. Descriptions: 25 words.
2. Write one instruction per sentence. Do not chain instructions with semicolons.
3. Use the imperative for instructions: "Read", "Update", "Do not". Use the simple present for descriptions.
4. Use the active voice. Name the actor: the daemon, the extension, the agent, you.
5. Do not use "-ing" verb forms. Stage names (*fixing*, *approving*) are names, not verbs. Write them in italics or code font.
6. Use one word for one thing. The glossary below is the dictionary. Add a term to the glossary before you use it in a doc.
7. Do not use synonyms for a glossary term. Not "env" or "environment" for *stack*. Not "status" for *stage*.
8. Use a vertical list for more than three items.
9. Put a warning before the step it protects, as its own sentence. Start it with "Do not" or "Make sure".
10. Do not use the words in the left column below. Use the right column.
11. Keep the articles. Write "the daemon", not "daemon".
12. Write a paragraph about one topic, with at most six sentences.

| Do not use | Use |
|---|---|
| via | through, with |
| whether | if |
| may, should, shall | can, must |
| prior to | before |
| in order to | to |
| leverage, utilize | use |
| ensure | make sure |
| as well as | and |

## Document types

| Type | Files | Rules that apply |
|---|---|---|
| Procedure | `BRIEF.md`, `RUN.md`, the protocol's rule lists and command list, system-prompt sections, tool descriptions | All, with the 20-word limit |
| Description | `SESSION_PROTOCOL.md` narrative, `ARCHITECTURE.md`, `STACK_SPEC.md`, `ROADMAP.md`, mission Goal and Contracts | All, with the 25-word limit |
| README | `README.md` | Rules 4, 6, 7, 10. Longer sentences are permitted in the opening |

## Glossary

One meaning each. Capitalize only file names and section names.

| Term | Meaning | Not |
|---|---|---|
| **agent** | One coding-agent process attached to a session. | "thread", "worker", "bot" (a bot is a GitHub review bot) |
| **board** | The pipeline board: every session with its stage and `needs_human`. `spinner board`. | the roster |
| **brief** | `BRIEF.md`: what one agent owns and must do. | "prompt" |
| **context file** | An `AGENTS.md` or `CLAUDE.md` that a harness reads from a directory. | "rules", "memory" |
| **context chain** | The context files an agent sees, from user level down to its working directory. | |
| **fixer** | The agent role that works through threads. | "reviewer" |
| **inbox** | The message directory of a session. | |
| **mission doc** | `MISSION.md`. | "plan", "spec" |
| **operator** | The person who runs the sessions. In docs, "you". In session files, by name. | "human" (a human thread is a thread written by a person, not a bot), "user", "orchestrator" |
| **pipeline** | The stages from *planned* to *closed*. | "workflow" (a Temporal workflow is a workflow) |
| **post** | The Slack message that asks for peer review. `spinner post`. `slack_post`. | "Slack thread", "review request" |
| **preview** | A running service of a session, shown in a **preview pane**. | "preview window", "frame", "iframe" (the implementation) |
| **process** | The daemon-observed state of an agent process: `running`, `idle`, `exited`. | the agent's own report, which is its roster row |
| **roster** | The per-agent table in the mission doc: Owns, Doing, Blocked?, Updated. | "board" |
| **session** | The unit of work. | "task", "ticket", "workspace" |
| **session directory** | The directory of one session under `~/.spinner/sessions/`. | "session dir", "workspace" |
| **skill** | A pi skill: a directory with a `SKILL.md`, loaded from user, project or session scope. | "plugin" (an extension is an extension) |
| **stack** | The repos and services that run together for a session. | "environment", "env", "sandbox" |
| **stage** | The pipeline position of a session, derived by the daemon. | "status", "state", "phase" |
| **state** | A daemon-observed fact: PR state, stack service state. | the pipeline position |
| **thread** | A GitHub review thread. `threads/`, `thread_*` tools. | a Slack thread, an agent transcript |
| **verify** | The operator's local-test tick. `spinner verify`. | "test", "QA", "sign-off" |
| **worktree** | A git worktree of one repo inside a session. | "checkout", "clone" |
