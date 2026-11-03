# EGM harness evidence

This file records the evidence probes of build session 1 of [the EGM design](../designs/egm-adoption.md) (entries 1.26 and 1.27), and the P11 rerun of build session 3 (entry 3.15, "Build session 3" below). EGM's own bar for a harness is in `docs/harnesses.md` of the EGM checkout, "Contributing Support": transcripts, a parent-only canary probe and a negative write probe.

## Setup

| Item | Value |
| --- | --- |
| Date | 2026-11-02 |
| pi | 1.4.0 |
| pi-subagents | 0.84.0 (the design cites 0.83.0; the three variables exist at the cited files in 0.84.0) |
| EGM | `a119668d7dc5d558664ba711d4671d11fb7270a8`, fetched by `POST /egm/fetch` into each scratch home |
| Model of the lead and the Goldfish | `anthropic/claude-fable-5-1` (the operator's pi default) |
| Driver | `node packages/daemon/e2e/egm-harness.ts`: a scratch daemon, a scratch `SPINNER_HOME`, a free port, a clone of `25batesc/spinner-sandbox` |
| Paste | `Add a --version flag to the sandbox CLI` |

The driver drops the inherited `PI_*` variables (except `PI_CODING_AGENT_DIR`) from the scratch daemon's environment. The first attempt ran without that step and failed setup. The driver ran inside a pi-subagents child, so every lead inherited `PI_SUBAGENT_CHILD=1`. The Spinner extension then stayed off: no tools, no `hello`.

## Runs

All scratch directories are under `/var/folders/vw/z0fc7m2d0hdfhy2_mb1d39780000gp/T/` and are kept. `<S>` is `home/sessions/s001-add-a-version-flag-to-the-sandbox-cli` inside each one.

| Run | Scratch | What ran | Lead transcript |
| --- | --- | --- | --- |
| A | `spinner-e2e-egm.e3o7MmBCFA` | Setup only; failed on the inherited `PI_SUBAGENT_CHILD` | none written |
| B | `spinner-e2e-egm.FcCrK2ftCP` | P1, P2a, P2b, P2c, P4, P3, before entry 1.25 | `<S>/agents/lead/pi/2026-11-02T23-17-22-906Z_lead.jsonl` |
| C | `spinner-e2e-egm.E2tIS8kMyU` | P1 to P4 and P3 with entry 1.25, then P11 | `<S>/agents/lead/pi/2026-11-02T23-23-19-675Z_lead.jsonl` |
| D | `spinner-e2e-egm.P9SgWcIAwG` | P1 to P4 and P3 again; stopped in the brainstorm on the operator's instruction | `<S>/agents/lead/pi/2026-11-02T23-51-53-275Z_lead.jsonl` |

The driver logs are in `/var/folders/vw/z0fc7m2d0hdfhy2_mb1d39780000gp/T/spinner-e2e-egm-log.scFgtrY39S/` (`short.log`, `short2.log`, `full.log`, `full2.log`). Child transcripts are in `<S>/agents/lead/pi/subagent-artifacts/`. Async run status files are in `<S>/egm-runs/async-subagent-runs/`.

## Probes

| Probe | Result | Detail |
| --- | --- | --- |
| P1 | PASS (B, C, D) | The lead lists `subagent`, `bg_wait` and `subagent_supervisor`, and no `subagents_enable`. |
| P2a | PASS (B, C, D) | The nonce was only in `MISSION.md`, the lead's context. The child's output and transcript do not contain it. The child said the only CANARY line in its context was its task. The lead named the nonce itself, from its own context. |
| P2b | PASS (B, C, D) | `PONG` after 12 to 13 seconds, after a Goldfish ran. The lead's command channel still answers. |
| P2c | PASS (B, C, D) | The file does not exist. The Goldfish reported its tools as `read`, `grep`, `find`, `ls` and `contact_supervisor`, with no write tool. |
| P3 | Literal text, then PASS with entry 1.25 | Run B: the transcript's user entry was the literal `/skill:egm-brainstorm`. The lead read `SKILL.md` on its own and asked a clarifying question. Runs C and D: with entry 1.25 the user entry was `Read the skill file at <home>/egm/src/skills/egm-brainstorm/SKILL.md and follow it in this thread.`, and the lead asked a clarifying question. |
| P4 | PASS (B, C, D) | The listing shows `egm-zoom-out (user, context: fresh)`. pi-subagents prints no paths; the lead found the files under `<home>/egm/pi/agents`. |
| P5 | PASS (C) | `<S>/design/concepts_brief.md` exists. `git status --porcelain` of the worktree lists no `concepts_brief.md`, `design_draft.md` or `*_report.md`. |
| P8 | PASS for the brainstorm only (C) | The 7 async status files name `egm-zoom-out`, `egm-design`, `egm-codebase-details`, `egm-comprehension`, `egm-implementation-readiness` and `egm-structural`; none names `egm-synthesizer`. No review ran, so P8 says nothing about `egm-review`. |
| P11 | Brainstorm PASS; draft and review NOT REACHED | See below. |

### P11

Brainstorm PASS (isolation, the brief, 6 Goldfish); draft and review NOT REACHED: the session-1 lead carries the build brief and implements after the brief; expected until session 3.

Run C, in order:

1. The brainstorm asked clarifying questions, and the driver answered from the table of entry 1.26.
2. The lead launched 6 Goldfish as one async parallel run: zoom-out, design, codebase-details, comprehension, implementation-readiness and structural. All 6 completed. It waited for all of them, read the reports and consolidated.
3. The lead wrote `<S>/design/concepts_brief.md` (0 blockers, 3 open decisions) and asked the open decisions in prose. It never asked "Select next step", so the driver's table did not reach the draft.
4. The lead then applied its own defaults and built the feature. Commit `7ee09d7 feat(cli): add sandbox CLI with a --version flag` in the scratch worktree adds `bin/sandbox.js`, `package.json`, a test, `.gitignore` and README lines. Nothing was pushed (`origin/main: ahead 1`).
5. The lead went idle. The driver of that run answered "Continue." 18 times, and the lead answered "Idle.". The run was stopped by hand.

Run D was stopped in the brainstorm on the operator's instruction. The driver now stops P11 after 5 "Continue." turns and records this outcome.

The design-track lead brief is entry 3.13 of build session 3. Until then a session-1 lead runs EGM's brainstorm and then follows its build brief.

| Skill | Turns | Wall time | Cost |
| --- | --- | --- | --- |
| egm-brainstorm (run C) | 4 driver answers to the brief | about 13 minutes | lead $5.64 for the whole run C, P1 to P4 included; Goldfish $1.79 (8 child runs) |
| egm-draft | not reached | | |
| egm-review | not reached | | |

The cost figures are sums of the transcripts' `usage.cost` and of the child `meta.json` `usage.cost`. `SessionView.cost` counted only the lead, because the child transcripts enter the ledger in build session 4. Run B cost $1.27 for the lead and $0.16 for 2 Goldfish.

## Entry 1.25

Entry 1.25 is built (commit `b8f8e51`), because run B showed the literal `/skill:` text at the model. Technical Plan T9 names that as the condition. The operator's guidance during the run was that P1 to P4 passed, so `tty.ts` is not needed. P1 to P4 do not test the skill expansion; P3 does. The operator decides if `b8f8e51` stays.

## Findings for the design

1. `extensions: []` (T2, 1.9): pi-subagents reads `[]` as one extension named `[]`. Its docs name `extensions:` with an empty value as "no extensions". The adapter writes `extensions:`. The child's `meta.json` shows `disableAmbientExtensions: true`.
2. Foreground runs (T5, P8): the lead used `"async": false` for the single-Goldfish probes. pi-subagents writes no status file for a foreground run, only `subagent-artifacts/<runId>_<agent>_<step>_{meta.json,output.md,transcript.jsonl}`. The GoldfishWatcher of T5 reads only status files. For the brainstorm fan-out the lead used async.
3. Async artifacts: the async run also writes `subagent-artifacts/<runId>_<agent>_{meta.json,output.md,transcript.jsonl}` without a step index.
4. An inherited `PI_SUBAGENT_CHILD=1` turns the Spinner extension off for every agent of a daemon started inside a pi-subagents child (run A).
5. The answer table of 1.26 matches "ends with `?`". EGM's questions end a paragraph that continues after the `?`. The driver reads a question when the last paragraph has a `?`.

## A3 checklist

| # | Item | Status | Shown by |
| --- | --- | --- | --- |
| C1 | Whole-plugin install | met | `POST /egm/fetch`: the pinned checkout and 9 adapter agents |
| C2 | Skills as commands | partly met | pi loads the 7 skills (`--skill`); the tty path needs entry 1.25 (P3) |
| C3 | Plugin-root paths | met | `SPINNER_EGM_ROOT` in the prompt; the lead read `<root>/docs/harnesses.md` |
| C4 | A fresh-context subagent tool | met | P1; `defaultContext: fresh` |
| C5 | Named personas | met | P4 |
| C6 | Host-enforced read-only reviewers | met | P2c; the `tools:` allowlist |
| C7 | No parent context | met | P2a; P2b |
| C8 | Required reads | met | The adapter body; the Goldfish read `zoom_out.md` in P2a |
| C9 | Report as text | met | The child `output.md` files |
| C10 | Nesting or direct dispatch | met | Direct dispatch in run C; P8 for the brainstorm |
| C11 | Parallel reviewers | met | Run C: 6 Goldfish in one async parallel run |
| C12 | Artifact directory | met | P5 |
| C13 | One-question gates | met (session 3) | Run F: 8 gates asked with `ask_question` and answered through `POST …/design/answer` |
| C14 | Design-only scope | met by the brief (session 3) | Run F: the lead held at `approved: false` with no commit; the edit guard is build session 6 |
| C15 | Feedback on the artifact | not met | Build session 5 |
| C16 | Evidence | partly met | This file; brainstorm, draft and review in run F; resolve and approval are build session 6 |

## Build session 3

The P11 rerun after entry 3.13 (the design-track lead brief), with the driver of entry 3.15. The setup is the same as in session 1, at commit `b329a11`. The session got `track: design` (`DESIGN_DEFAULT_TRACK`, 3.1).

| Run | Scratch | What ran | Lead transcript |
| --- | --- | --- | --- |
| E | `spinner-e2e-egm.Knvbha3xqQ` | P1, P2a, P2b, P2c, P4 PASS; P3 FAIL on the driver's question rule; stopped at the first gate by a driver bug (a top-level constant read before its initialization), fixed in `b329a11` | `<S>/agents/lead/pi/2026-11-03T01-33-14-180Z_lead.jsonl` |
| F | `spinner-e2e-egm.yorzFWH9PI` | P1 to P5 PASS, then P11: brainstorm, draft and review end to end | `<S>/agents/lead/pi/*_lead.jsonl` |

The driver logs are `s034-e2e-log.vqZJhBfDlq/run.log` (run E) and `s034-e2e-log.NZFAAUxPuF/run.log` (run F), under the same temporary directory. The record of each run is `<scratch>/egm-evidence.json`.

### The lead's first answer (run E and run F)

The lead proposed the `design` track with a reason, put the stack choice under Open questions with a recommendation, and said: "start `/skill:egm-brainstorm` when you want the design cycle to begin. I will not start an EGM skill on my own."

### P11 in run F

| Step | Result | Detail |
| --- | --- | --- |
| Brainstorm | PASS | Started by `POST …/design/run { skill: "egm-brainstorm" }` (P3). The lead asked the clarifying questions, then the readiness gate and the "Select next step" gate through `ask_question`. The driver answered both through `design/answer`. 6 Goldfish ran in one async run. `concepts_brief.md` is in `<S>/design/` (P5). |
| Draft | PASS | After "Proceed to /egm-draft", the lead ended the brainstorm and waited. It started the draft on the driver's next "Continue." The context gate, 4 section gates and the save gate came through `ask_question`. The lead wrote `docs/designs/sandbox-cli-version-flag.md` in the worktree and called `design_doc`. |
| Review | PASS | Started by `POST …/design/run { skill: "egm-review", preset: "uninterrupted" }`, recorded as `review_run: r1`. It did not stop for a reading list. All five stage reports and the consolidated report are in `<S>/design/`: `zoom_out_report.md`, `comprehension_report.md`, `critic_report.md`, `intermediate_zoom_out_report.md`, `implementation_readiness_report.md` (and `implementation_readiness_report_round2.md`, the one re-audit), `consolidated_review_report.md`. |
| Resolve | NOT EXERCISED | Not a pass criterion of session 3; the resolve step and approval are build session 6's row. The driver of run F started `egm-resolve` after the review and answered `Auto accept`. The lead wrote `goldfish_review_report.md` and applied 22 fixes. Its marker `**Status: resolved** (…)` is on the third line, so the stage rule (first non-empty line `Status: resolved`) kept the stage at `resolving`. The driver counted 5 "Continue." turns as no progress and recorded P11 as failed. |
| Hold for approval | PASS (the design-only rule of the brief) | To each "Continue." the lead answered that the design is not approved (`design/.state.json` `approved: false`) and that it does not build. The worktree has no commit ahead of `origin/main`. Its one change is the untracked design doc. |
| P8 | PASS | The 21 async runs name `egm-zoom-out`, `egm-design`, `egm-comprehension`, `egm-structural`, `egm-style`, `egm-implementation-readiness` and `egm-codebase-details`. None names `egm-synthesizer`. All are `complete`. |

| Skill | Turns | Wall time | Lead tokens | `SessionView.cost` at the end |
| --- | --- | --- | --- | --- |
| egm-brainstorm | 4 | 303 s | 12,264 | $3.00 |
| egm-draft | 7 | 367 s | 21,384 | $6.04 |
| egm-review | 2 | 844 s | 24,449 | $10.08 |

`SessionView.cost` counts the lead only; it was $15.50 at the end of run F, P1 to P4 and the resolve turns included. The child `meta.json` files sum to $10.20 for the Goldfish. The driver now ends P11 when the lead holds for approval after the review (commit after `b329a11`).

## Build session 4

Run G checks the Goldfish rows of entry 4.11 and the workspace reads of build session 5, at commit `ee51605`. The setup is the same as above: pi 1.4.0, pi-subagents 0.84.0, EGM `a119668`, the model `anthropic/claude-fable-5-1`.

| Run | Scratch | What ran | Lead transcript |
| --- | --- | --- | --- |
| G | `spinner-e2e-egm.dhOVKojo8T` | P1, P2a, P2b, P2c, P4, P3, then P11 with P5, P6, P7, P8 and W1; all PASS | `<S>/agents/lead/pi/2026-11-03T04-42-52-115Z_lead.jsonl` |

The driver log is `s036-e2e-log.S68as6NQbx/run.log`, under the same temporary directory. The record is `<scratch>/egm-evidence.json`.

| Probe | Result | Detail |
| --- | --- | --- |
| P6 | PASS | `SessionView.design.goldfish` held 6 new Goldfish with a persona 276 ms after the lead's `subagent` launch: structural, implementation-readiness, comprehension, codebase-details, design and zoom-out. The view reads the run files at each request, so the 2-second poll of the watcher bounds only the push of `session.updated`. |
| P7 | PASS | After the brainstorm: 8 entries in `SessionView.cost.children`, `cost_by_stage.brainstorm` $2.75, 8 chips `done`. The events route served 15 events of one Goldfish transcript. |
| W1 | PASS | After the review, `GET …/design/files` listed 10 files. `…/design/files/concepts_brief.md` (12,960 characters), `…/design/files/consolidated_review_report.md` (15,680 characters) and `…/design/doc` answered 200. The doc text equals the worktree file. |
| P11 | PASS | 3 skills; 8 gates answered through `POST …/design/answer`; the lead held for approval with no code change. The stage at the end was `resolving`: the lead wrote `goldfish_review_report.md` after the driver's "Continue." turn in the review. |
| P5, P8 | PASS | The brief is in `<S>/design/` and not in the worktree. No run names `egm-synthesizer`. |

| Skill | Turns | Wall time | Lead tokens | `SessionView.cost` at the end |
| --- | --- | --- | --- | --- |
| egm-brainstorm | 4 | 430 s | 15,347 | $5.97 |
| egm-draft | 7 | 320 s | 15,923 | $8.01 |
| egm-review | 2 | 1,010 s | 29,963 | $16.89 |

`SessionView.cost` now includes the Goldfish. At the end it was $16.89: $9.02 for the lead and $7.87 for 17 Goldfish steps in `children`. By design step, the Goldfish cost $2.75 in the brainstorm (the 2 probe Goldfish of P2a and P2c included) and $5.13 in the review. The draft ran no Goldfish.
