# s023 · A new session starts in the working area; archive on every card

## Goal
Today a new session is a form in the sidebar. After this session `+ New session` opens the working area as a composer: one large box in the middle of an otherwise empty pane, the project and the PR hints under it, `Start`. On Start the session appears in the list and the middle pane becomes the lead's chat at once, so the operator is talking to the agent in charge, who handles everything. The same for `+ New review`. The empty state (no session selected, or no sessions at all) is that composer. Every session card and review card gets an `archive` action, which runs the existing `close` after one in-place confirm. One agent: `ui`.

## Done when
- [ ] `+ New session` in the sidebar, and the empty middle pane, show the composer in the working area: the large text box with the placeholder "What should this session be about? Paste a ticket, a PR link, or a sentence.", the project select, the PRs found under the box as today, `Start` as the one primary button; the sidebar form is gone
- [ ] `Start` posts `POST /sessions` as today; the created session is selected and the middle pane shows the agents view with the lead's chat selected; the composer's draft survives a switch away and back until Start
- [ ] `+ New review` opens the same composer for PR links with `Start review`; the created review is selected and its pane shows
- [ ] Each session card and review card has an `archive` action (in a card `⋯` menu or as a small button on hover; the context bar's `⋯` keeps `close`, relabelled `archive`), one in-place confirm "Archive this session? It moves to the archive and its agents stop.", then `POST /sessions/:dir/close`; the next session in the list is selected afterwards
- [ ] Driver flows `composer` (open from the sidebar, draft kept across a switch, Start selects the session and shows the lead) and `archive` (confirm, the card goes, the selection moves); existing flows updated; `pnpm --filter ui build`, `pnpm --filter ui test`, root `pnpm lint` green

## Plan
- [ ] 1. The composer in the working area; the sidebar form removed; the empty state (ui)
- [ ] 2. Start → the lead's chat selected; the review composer (ui)
- [ ] 3. `archive` on the cards and in the context bar (ui)
- [ ] 4. Drivers, screenshots; existing flows updated (ui)
- [ ] 5. Lessons → protocol; release (the operator)

## Roster
| Agent | Owns | Doing | Blocked? | Updated |
|-------|------|-------|----------|---------|
| ui    | `packages/ui/**` | — | no | — |

## Contracts & decisions
- (date) the operator: no daemon or protocol change; `archive` is the existing `close` job.
- (date) the operator: the composer is the empty state too; a home with no sessions opens on it.
- (date) the operator: rules from s001 to s037 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path; no `git add -A`, no `git stash`; `mktemp -d` scratch, reported, never deleted; never print `.npmrc`, `.env*`, `auth.json`, `~/.spinner/env`, or a file named with `token`, `key` or `secret`; no customer or person in a tracked file; wait on an artifact, never on a Log timestamp; drivers run against the fixture with `SPINNER_PORT` set on vite too, never against `:7777`, and close their CDP target; re-read `MISSION.md` before each edit; stop every fixture, vite and headless Chrome you started before you report; read the exact lines before an edit; only the driver flows you touched after each commit, the full sweep once before you report.

## Open questions
- (none yet)

## Log
- (start) the operator: session opened after v0.14.1 from the operator's feedback; one pi subagent, brief in agents/ui/BRIEF.md
