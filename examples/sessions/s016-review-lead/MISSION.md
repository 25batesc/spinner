# s016 · The review lead: one review in one voice

## Goal
The swarm of s015 posts one set of inline comments per model, as `review-blast` did. The operator's better review process is the `pr-review` skill: three read-only reviewers return a verdict, a lead writes the operator a plain-language briefing while they run, then reconciles the verdicts into one review in one voice, shows the draft, and posts only when the operator says so. After this session a review session runs that process: a `lead` agent with the skill's role, reviewers that write verdict files and never post, the briefing and the draft in the review pane, and `post` as the operator's click. The per-model posting goes away. Two agents: `engine` and `ui`.

## Done when
- [ ] A review session starts a `lead` agent at creation (model `settings.default_model`), with a brief from the `pr-review` skill: read the PR and the repository, write the briefing first through `review_briefing`, then wait for the verdicts, apply lead judgment, and write the draft through `review_draft`; never post, never edit files, never name a model in any GitHub text
- [ ] The swarm starts the reviewers as before (one per `settings.review.models`, states `queued|reading|done|failed`) with the `reviewer` role's brief and the skill's rulebook: read only, no posting, end with the `VERDICT` contract; the daemon saves each verdict to `artifacts/reviews/<model-slug>.md` from the transcript on settle and notifies the lead through the extension channel when the last one lands
- [ ] `review_briefing { markdown }` writes `artifacts/briefing.md`; `review_draft { event, body, comments: [{ path, line, body }] }` validates the comment format (one severity label first, lines in the diff) and writes `artifacts/review-draft.json`, sets `needs_human` with a `review_draft` reason
- [ ] `POST /sessions/:dir/review/post` posts the draft as one PR review at the head SHA through the operator's `gh` (`APPROVE` or `COMMENT` as drafted; `APPROVE` rejected for the author's own PR falls back to `COMMENT` and says so); `PUT /sessions/:dir/review/draft` saves the operator's edits; `DELETE` drops it; the posted review's URL lands in `session.yaml` and the Log
- [ ] `SessionView.review` carries `briefing: boolean`, `draft: { event, body, comments } | null`, `posted_url`; `review.updated` on each change
- [ ] The review pane shows the briefing as markdown as soon as it exists, then the draft: the event and the summary body, each line comment as `path:line` with its text editable, `post`, `drop`; `post` asks once in place; after posting, the review URL; the swarm chips read `done` instead of `posted`
- [ ] `review` on an ordinary session runs the same process; its lead is the session's existing lead
- [ ] E2e on a scratch daemon with the real pi and one reviewer model on the sandbox PR: the briefing appears, the verdict file appears, the draft appears with `needs_human`, `post` posts one review and the URL shows
- [ ] Checks green; `ARCHITECTURE.md` "Reviews" and `DAEMON_API.md` updated

## Plan
- [ ] 1. Contract under Contracts: the tools, the routes, the `review` fields, the states (engine)
- [ ] 2. The lead and its brief; the reviewer brief from the `reviewer` role; verdict files; the notify (engine)
- [ ] 3. The draft routes and the post through `gh`; the s016 `review` on ordinary sessions (engine)
- [ ] 4. The briefing and the draft in the review pane (ui)
- [ ] 5. E2e; docs (engine)
- [ ] 6. Lessons → protocol; release (the operator)

## Roster
| Agent  | Owns | Doing | Blocked? | Updated |
|--------|------|-------|----------|---------|
| engine | `packages/daemon/**`, `packages/pi-extension/**`, `packages/protocol/**`, `packages/cli/**`, `docs/**` | — | no | — |
| ui     | `packages/ui/**` | — | no | — |

## Contracts & decisions
- (date) the operator: the review process is the `pr-review` skill, end to end: reviewers never post; the lead drafts one review in one voice; the operator posts. The per-model inline posting of s015 is removed, not kept as an option.
- (date) the operator: the event follows the skill's table (`APPROVE` with no blocking finding, `COMMENT` otherwise); the operator can change it in the draft before posting.
- (date) the operator: the skill's rulebook (`engineer-conventions`, `backend-conventions`, `interrogate/references/lead-judgment.md`) is read from the operator's pi config by path; `settings.review.skill` names the skill directory, default `~/.pi/agent/skills/pr-review`.
- (date) the operator: rules from s001 to s015 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path; no `git add -A`, no `git stash`; `mktemp -d` scratch, reported, never deleted; never print `.npmrc`, `.env*`, `auth.json`, `~/.spinner/env`, or a file named with `token`, `key` or `secret`; no customer or person in a tracked file; wait on an artifact, never on a Log timestamp; destructive e2e only on a scratch daemon with a scratch home; the operator's daemon on `:7777` is read-only for agents; a protocol change names the files the other agent's build touches; find the fault before you fix the proposed one; drivers close their CDP target; re-read `MISSION.md` before each edit, several agents write it; stop every scratch daemon, fixture and headless Chrome you started before you report.

## Open questions
- (none yet)

## Log
- (start) the operator: session opened after v0.7.0; two pi subagents from one parent, briefs in agents/*/BRIEF.md
