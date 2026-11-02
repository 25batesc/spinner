# s010 · Soak fixes before dogfooding

## Goal
The operator starts daily work in Spinner. This session closes the small faults that bit him in the first days, so none of them interrupts a real session. Two agents: `engine` (daemon, cli, protocol, desktop) and `ui`.

## Done when
- [ ] The daemon serves a snapshot of `packages/ui/dist` copied to `~/.spinner/ui/<commit>/` at start; a rebuild of `dist` does not change a running daemon's UI; `GET /health` names the UI commit it serves
- [ ] `settings.default_model` and `settings.agents.harness` apply: an agent added without a model gets `default_model`, and the harness comes from settings before `config.yaml`
- [ ] `DELETE /sessions/:dir/verify` clears the verify tick; the checkbox toggles both ways
- [ ] The ui fixture and vite default to a port that is not the daemon's (`17777`), so a driver can never reach the operator's daemon by omission
- [ ] A window under 1000 px keeps the terminal usable: the agents pane's minimum wins over the previews, and the side panel folds first
- [ ] Preview cookies are partitioned per session in the desktop app (`persist:<session dir>`), so two sessions of one app hold two logins
- [ ] `plumbing.test.ts` passes ten runs in a row under load (fake the clock or widen the debounce window in the test)
- [ ] Session ids are unique across homes on one machine: `next_session_id` also reads the ids named in the proxy route files
- [ ] `pnpm -r build && pnpm -r test && pnpm lint` and `doc-metrics --fail` green; `docs/sessions/soak-questions.md` rows marked done with the commit; Log tells the story

## Plan
- [x] 1. UI snapshot at daemon start; `health.ui_commit` (engine) — 47faff2
- [x] 2. Settings applied in the agent manager (engine) — 19fa341
- [x] 3. `DELETE /verify` route (engine, cd711f7); the checkbox toggle (ui, a5c4b44)
- [x] 4. Fixture and vite default port (ui) — 87498de
- [x] 5. Narrow window: fold order and minimums (ui) — 6dd5331
- [x] 6. Cookie partition per session (engine, in `packages/desktop`) — 09763ff
- [x] 7. The flaky test; ids across homes (engine) — bf4c836, 0640ae4, 08c902a
- [ ] 8. Soak list rows closed; lessons → protocol (the operator)

## Roster
| Agent  | Owns | Doing | Blocked? | Updated |
|--------|------|-------|----------|---------|
| engine | `packages/daemon/**`, `packages/cli/**`, `packages/protocol/**`, `packages/desktop/**`, `docs/DAEMON_API.md` | done | no | 22:03 |
| ui     | `packages/ui/**` | done | no | 22:04 |

## Contracts & decisions
- 2026-10-30 the operator: each item is one commit with its own test; no item waits on another except 3 (route before checkbox).
- 2026-10-30 the operator: the UI snapshot lives under `~/.spinner/ui/<commit>/`; the daemon removes snapshots of other commits at start.
- 21:41 engine: `DELETE /sessions/:dir/verify` is in commit cd711f7. Synchronous, no job: answers `SessionResponse` (the new view) with 200, 404 without the session. `ROUTES` in `packages/protocol/src/api.ts` has the entry; `pnpm --filter @spinner/protocol build` done so `@spinner/protocol` dist carries it. Files the ui build touches: `packages/protocol/dist/api.{js,d.ts}`.
- 22:04 ui → engine: `inbox/ui-to-engine-soak-rows.md` lists the three soak rows the ui commits close (untick a5c4b44 with cd711f7; fixture port 87498de; narrow window 6dd5331) for `docs/sessions/soak-questions.md`, which 5a28bc5 marked for the route half only. Files touched by the engine's side: `docs/sessions/soak-questions.md`.
- 2026-10-30 the operator: rules from s001 to s011 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path; no `git add -A`, no `git stash`; `mktemp -d` scratch, reported, never deleted; never print `.npmrc`, `.env*`, `auth.json`, `~/.spinner/env`, or a file named with `token`, `key` or `secret`; no customer or person in a tracked file; wait on an artifact, never on a Log timestamp; destructive e2e only on a scratch daemon with a scratch home; the operator's daemon on `:7777` is read-only for agents; a protocol change names the files the other agent's build touches.

## Open questions
- (none yet)

## Log
- 21:39 the operator: session opened after s011; two pi subagents from one parent, briefs in agents/*/BRIEF.md
- 21:41 ui: read the brief, the soak rows, `layout.ts`, `useResizable.ts`, `fixture/server.ts`, `vite.config.ts`, `PipelineActions.tsx`. Order: Plan 4, Plan 5, then the checkbox of 3 once the engine's `DELETE /verify` commit is under Contracts. The README has no fixture line to follow; the fixture is named in `docs/sessions/*` only, so Plan 4 touches `packages/ui` alone.
- 21:42 ui: Plan 4 done, 87498de. `fixture/port.ts` holds the default `17777` and reads `SPINNER_PORT`; vite and the fixture use it. `port.test.ts` (3 tests); `pnpm --filter ui test` 63 passed; `pnpm lint` clean; the fixture without `SPINNER_PORT` answered `/health` on 17777.
- 21:40 engine: read the brief, the mission and the soak list; starting item 3 (the route) first so the ui agent is unblocked soonest
- 21:41 engine: item 3 route landed in cd711f7; test `DELETE /sessions/:dir/verify clears the tick` in server.test.ts passes; starting item 1
- 21:43 engine: item 1 done, 47faff2. `ui-snapshot.ts` copies dist to `<home>/ui/<commit>/` at start (staging dir then rename), removes other snapshots; `HealthResponse.ui_commit` added (protocol dist rebuilt); `spinner daemon status` prints `, ui <commit>` on the build line. server.test.ts 15 passed, cli 24 passed. Starting item 2
- 21:44 engine: item 2 done, 19fa341. Order in `manager.add`: `request.model`, the agent's last run (`session.yaml`), `settings.default_model`, `config.yaml`; harness: `settings.agents.harness`, else `config.yaml`. agents.test.ts 8 passed (the new test failed on the old manager, checked). Starting item 6
- 21:53 ui: Plan 5 done, 6dd5331. `fitLayout(layout, width)` in `layout.ts` derives the layout for the grid's measured width: previews shrink to 200, side panel to 140, previews strip, side panel folds; agents never under 280; stored layout untouched. `useResizable` measures with a ResizeObserver, App renders `fitted`. Driver flow `narrow` (900, 600, 440, back to 1500 px; terminal open at 900 with agents at 280) green; `panes` and `terminal` still green. Screenshots `artifacts/ui/60..64-narrow-*.png`. `pnpm --filter ui build` ok, `test` 68 passed, `pnpm lint` clean at 21:53. Scratch: `/var/folders/vw/z0fc7m2d0hdfhy2_mb1d39780000gp/T/tmp.Hq8yKDmUsH` (fixture :17801, vite :5201, Chrome CDP :9336); left in place. Found: the `terminal` flow needs a fresh fixture after other flows (the echo pty keeps the resize lines and the banner scrolls off). Starting Plan 3's checkbox on cd711f7.
- 21:45 engine: item 6 done, 09763ff. `preview_partition(key)` in `previews.ts` (pure, tested) gives `persist:<session dir>`; `electron-previews.ts` passes `session.fromPartition(...)` to every `WebContentsView`. The Electron side is typechecked, not run: no Electron e2e in this session. Starting item 7
- 21:55 engine: item 7a (the flaky test) done, bf4c836. The race was not the debounce: under load (24 `yes` processes) chokidar 6's per-directory backend (what `depth` selects) missed a directory created right after `ready` in 3 of 25 probe rounds; `ready` means the scan is done, not that FSEvents delivers. `watch/live.ts`: both session watchers resolve `ready` after chokidar reported a probe file under `<home>/sessions`. plumbing.test.ts 10 of 10 under the load that failed 2 of 10 before; daemon suite 210 passed. Starting 7b (ids across homes)
- 21:58 engine: item 7b done, 08c902a: `next_session_id` in machine scope also scans `sessions/` and `archive/` of every other home the route files name (`# home:` header). A home that never ran a stack stays unseen. Follow-up 0640ae4: the probe made `ready` 100 to 200 ms slower and `/health` answered before `daemon.pid` was written (cli daemon.test.ts failed 5 of 5 on the old order); `start_daemon` now opens the port after the watchers are ready; 5 of 5 after.
- 22:03 engine: done. Exists: cd711f7 (DELETE /verify), 47faff2 (UI snapshot, `health.ui_commit`), 19fa341 (settings in `add`), 09763ff (cookie partition), bf4c836 + 0640ae4 (watchers live before the port), 08c902a (ids across homes), 5a28bc5 (soak rows). Checks: `pnpm -r build` 6 done; protocol 18, daemon 211, cli 24, desktop 69 passed; `pnpm -r test` all packages Done; `pnpm lint` clean; `doc-metrics --fail` exit 0. Not run: an Electron e2e for the partition (typecheck and the pure test only). Protocol: (1) a soak row's proposed fix is a hypothesis, not the brief; the brief should say "find the fault first" (the debounce was innocent). (2) a change that slows daemon start touches the cli's `daemon` tests; a brief that names cross-package tests to rerun after a timing change would have caught 0640ae4 before the full run. (3) the scratch dirs: `/tmp/watch-probe.test.ts` and the vitest temp homes under `$TMPDIR/spinner-*` were the only scratch; no scratch daemon was needed.
- 21:58 ui: Plan 3 ui half done, a5c4b44. Unchecking calls `DELETE /sessions/:dir/verify` (`deleteVerify` in `remote.ts`); the tick follows `session.updated` (the daemon's `refresh` publishes the view, `server.ts:644`), never local state; a ticked box clears whatever the stack's state; a failed DELETE shows in the drawer. The fixture serves the route (200 view, 404, `session.updated`); `server.test.ts` covers tick, untick, 404; the `lifecycle` flow ticks, unticks, ticks again (`artifacts/ui/05-verified.png`, `05b-unverified.png`). Also: `drive.ts` closes its CDP target in every flow through one `finish()` (lesson 30; most flows left the tab open on success).
- 22:04 ui: done. Exists: 87498de (fixture port 17777), 6dd5331 (narrow window fit), a5c4b44 (untick, driver targets closed). Checks at 21:58: `pnpm --filter ui build` ok; `pnpm --filter ui test` 69 passed in 14 files; root `pnpm lint` exit 0. Driver flows `lifecycle`, `narrow`, `panes`, `terminal` green on the fixture; no CDP target left after a run. Not run: the checkbox against a real daemon (needs an up stack; the daemon's `session.updated` path is read, not exercised). Scratch kept: `/var/folders/vw/z0fc7m2d0hdfhy2_mb1d39780000gp/T/tmp.Hq8yKDmUsH`; fixture :17801, vite :5201 and Chrome :9336 still running from it. Protocol: (1) the brief's "README's fixture line follows" named a line that does not exist; a brief should cite `file:line` for every out-of-path edit it asks for. (2) the `terminal` flow needs a fresh fixture after other flows (the echo pty keeps every resize line); a brief line "restart the fixture between flows" or a fixture reset route would save a detour. (3) the shared Plan item 3 had one checkbox for two agents; two boxes, one per half, would remove the "who ticks it" question.
- 13:43 the operator: s012 closed. Eight soak items in eight commits: the UI snapshot, settings applied, verify undo, the fixture port, the narrow window, the cookie partition, the watcher race (not the debounce), ids across homes. engine $9.05 (24 min), ui $7.31 (26 min). v0.2.0.
