# Roadmap

Ordered by what is riskiest and most useful at work soonest. Each milestone has an exit test you can run, not a feature list. Spinner is built with Spinner's own protocol from day one: [examples/sessions/s001-bootstrap](../examples/sessions/s001-bootstrap/MISSION.md) is the first session, run by hand; [examples/sessions/s002-board-and-stack](../examples/sessions/s002-board-and-stack/MISSION.md) is the second.

The 10/26 notes reset the priorities: implementation is cheap, the loop *after* implementation (bot review → fix → verify → peer review → approvals → queue → land) is where the day goes. Spinner stays both things, a multi-agent editor and the organizer that pushes the agents' output into the codebase, but the organizer half is what pays off first: the pipeline board moved up to M1 alongside the stack runner, and M2 ships the fixer, approvals and re-queue loop together with the agent plumbing.

## M0 · Bootstrap by hand (done 2026-10-26)

Prove the coordination model with zero code.

- Repo scaffold: `pnpm` workspace, `packages/protocol` with the `session.yaml` and event types, lint/test wiring, MIT license, this `docs/` set.
- `examples/sessions/s001-bootstrap/` with `MISSION.md` and two briefs: `engine` (daemon + CLI skeleton) and `ui` (web UI against the protocol types with a fixture server).
- Run both as plain `pi` terminals, each with `cwd` at the repo root, each told to read `examples/sessions/s001-bootstrap/MISSION.md` first. You are the daemon: relay messages, answer questions, tick the plan.

Exit: the two agents finish the `packages/protocol` contract and a walking skeleton of each package without editing the same file twice, and the protocol doc gets its first revision from things that went wrong.

Record: 17 minutes of wall clock for the agent commits, $5.80 of agent cost, 2 operator relays, 37 tests. The two agents never edited the same file; the lockfile was the one shared write. See *Lessons from s001* in [SESSION_PROTOCOL.md](SESSION_PROTOCOL.md#lessons-from-s001).

## M1 · Pipeline board + stack runner (session s002; done 2026-10-27, see [STATUS.md](STATUS.md))

Two independent tracks with no shared files beyond `packages/protocol`, so they run as two agents in one session.

### Track A · Pipeline board (`board` agent)

The cheapest, highest-value piece: a board that knows the stage of every change in flight, fed by GitHub, with no agents or containers involved.

- GitHub facts collector via `gh api graphql`: PR state, checks, review threads bucketed bot/human by author login, review decision, merge-queue entry and `RemovedFromMergeQueueEvent`.
- Stage derivation as a pure function over a facts object, with fixture tests for every row of the stage table.
- `spinner adopt <pr-url> [<pr-url>...]`: create a session from PRs that already exist (no worktrees, no stack), so the board is useful on day one for features started elsewhere or by hand.
- `spinner board`: one line per session: stage, `needs_human`, per-PR checks / threads / queue. `--watch` refreshes.
- `spinner verify`, cleared on push. macOS notifications on transitions.

Exit: the board shows your real in-flight features (adopted from their PRs) with the right stage for each, and when a PR falls out of the merge queue you get a notification within a minute, before you would have noticed yourself.

### Track B · Stack runner (`stack` agent)

Local testing between branches without touching your main checkout.

- `spinner new / up / down / show / logs / exec / close` driven by a `spinner.yaml`: `examples/sample-stack` in CI, your private `local/<project>/spinner.yaml` at work.
- `examples/sample-stack/`: a tiny API + web + Postgres stack with its own `spinner.yaml`, so the runner has a test vehicle that contains no secrets.
- Worktree per repo on the session branch, `.spinner` symlink into each.
- Traefik on `:80`, hostname routing, frame-header stripping.
- Shared Postgres with template-database cloning; `spinner seed rebuild`.
- Temporal dev server per session.
- Dev images with dependency volumes keyed by lockfile hash.

Exit: `examples/sample-stack` comes up in CI; two feature branches of your own project run side by side on one laptop, both logged in at once in two Chrome tabs (`admin.s1.localhost`, `admin.s2.localhost`), Temporal UI per session, `spinner up` under 15 s warm, `spinner close` leaves nothing behind (`docker ps`, `git worktree list`, `psql \l` all clean).

## M2 · Agents that drive PRs home (done 2026-10-29 except the operator's real feature; see [STATUS.md](STATUS.md))

Replace yourself as the message bus and as the person who relays review comments.

- `spinnerd` as a real daemon with the REST/WS API from `packages/protocol`.
- `PiRpcHarness`: spawn / resume / prompt / steer / abort per agent, event passthrough.
- Spinner pi extension: mission context in the system prompt, `mission_*` / `message` / `stack` / `pr` / `thread_*` tools, out-of-area edit guard.
- Session `AGENTS.md` generated per session (the harness-independent injection); pi runs with your own agent directory so your skills, extensions and `AGENTS.md` apply; `<session>/skills/` passed through.
- File watcher → debounced steer messages; `inbox/` delivery.
- `spinner pr`: push + `gh pr create` per changed repo, body from the mission doc.
- `spinner fix`: the fixer agent over `threads/`, auto-started per `threads.autofix`; flagged threads surface in `needs_human`.
- `spinner post`: compose the Slack post for the PR set, confirm, post, store the post URL, watch replies.
- `spinner approve`: your approving review where the configured approval policy wants it (adopted bot-authored PRs), shown before it is submitted.
- `spinner land`: enqueue with `expectedHeadOid`, watch, rebase + re-enqueue on pop-out (re-requesting approvals for the new head), notify on merge.
- `spinner reset` after merge.

Exit: one real feature of your own project goes `pr → fix → verify → post → approve → land` where your only actions were ticking *verify*, confirming the Slack post, and approving; and session s001's next round runs through the daemon instead of by hand.

## M3 · Web UI (done 2026-10-29; see [STATUS.md](STATUS.md))

The sketch, working, with the board as the left pane.

- Sessions/board pane sorted by `needs_human`; activity feed of pipeline transitions across sessions; new-session form.
- Agent tabs rendering the pi event stream (text, tool calls, cost), prompt / steer / abort, model picker.
- Mission panel: rendered `MISSION.md`, operator sections editable, Roster highlighted, diff flashes on change.
- Context tab per agent: the `AGENTS.md` chain from user level down to the working directory, each file editable, git-tracked ones marked; loaded skills and commands with paths.
- Preview pane: iframe tabs per hostname, grey until healthy, open-in-tab, reload, "report to agent" (URL + note into a message), the **verified** tick next to the previews.
- `create PR / fix / post / land / run local / stop local` buttons; the `threads/` files rendered with resolve and flag state.

Exit: a feature goes from `new session` to merged PRs without opening a terminal, and a new user can follow `README` to get there on their own stack in under an hour.

## M4 · Desktop wrapper (in progress, s007; see [STATUS.md](STATUS.md))

Same UI in Electron, for the things a browser cannot do.

- `WebContentsView` previews with a cookie partition per session.
- Preview console errors and failed requests streamed to the daemon and offered to the agent ("the admin page threw TypeError at RefundQueue.tsx:41, want me to send it?").
- Screenshot-to-agent, pop-out preview windows, per-preview devtools.
- Signed macOS build, auto-update, native notifications for pipeline transitions.

Exit: an agent fixes a frontend bug whose only report was the console error captured from the preview pane.

## M5 · Open-source release

- `examples/sample-stack` polished into the newcomer path: clone, `spinner new --project examples/sample-stack`, `spinner up`, done.
- `spinner init` that writes a starter `spinner.yaml` by inspecting a directory of repos.
- Pluggable review-bot logins and queue backends (GitHub merge queue first; Mergify/Graphite as adapters if someone wants them).
- Docs site from `docs/`, CONTRIBUTING, issue templates, CI on the sample stack.
- Second harness adapter (Claude Code or Codex CLI) to prove the interface.

## Later / maybe

- Pi Durable as the runtime: mission doc as a durable document, UI attached straight to conversations, agents surviving daemon restarts.
- GitHub webhooks through a tunnel for sub-minute board updates.
- Agents running inside the session container (`workspace` service), credential proxy.
- Remote mode: the daemon on a beefy box, the UI on a laptop.
- Review agent per PR with a cheap model, read-only tools, before the operators see it.
- Session templates ("bug fix", "new endpoint + admin page") that pre-populate briefs and plan.

## Suggested first week

1. Create the GitHub repo, push these docs, add the pnpm workspace skeleton and `packages/protocol` with the `session.yaml` type (run s001 for this).
2. Settle the remaining pipeline questions at the bottom of [ARCHITECTURE.md](ARCHITECTURE.md#open-questions): whether the approval action re-runs on pushes, how it identifies the instructing person for bot PRs, which Slack token is acceptable.
3. Fill in the `# TODO`s in your private `local/<project>/spinner.yaml` (schema in [STACK_SPEC.md](STACK_SPEC.md)) by looking at your repos: dev commands, ports, seed path, background workers.
4. Hand-run one `gh api graphql` query against a live PR of yours that returns checks, review threads with authors, and the merge-queue entry. Save the response as the first fixture for the stage function.
5. Hand-build `spinner up` once for one session: a compose file, Traefik, one cloned database. Measure the time.
6. Start s002 with the `board` and `stack` agents. Note every time you had to copy-paste between them; that list is M2's backlog.
