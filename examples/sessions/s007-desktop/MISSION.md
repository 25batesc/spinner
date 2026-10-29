# s007 · Desktop: the same UI in a window, previews as top-level pages

## Goal
M4. An Electron app that shows the existing web UI and renders each preview as a `WebContentsView`, a top-level page in its own right, so an app that keeps its session in `SameSite=Lax` cookies stays logged in inside Spinner. The app connects to a running daemon and starts one when none runs. The web UI in a browser keeps working unchanged. Two agents: `desktop` (the Electron package) and `ui` (the preview bridge in the web app).

## Done when
- [ ] `pnpm desktop` opens a window with the UI from the daemon on `localhost:7777`; when no daemon answers, the app starts one (`spinner daemon start`) and waits for `/health`
- [ ] Each preview tab is a `WebContentsView` positioned over the preview pane; it follows pane resizes, drags, tab switches and window resizes with no visible lag; the hidden tabs keep their state
- [ ] The operator's web app, logged in inside the preview, stays logged in across navigation and reload; Temporal and the admin render without the frame-header middleware
- [ ] Per preview: reload, open in the default browser, devtools; the **verified** tick and the other panes behave as in the browser
- [ ] In a browser the UI still embeds an iframe and says "open in tab" on a preview whose app needs a top-level page
- [ ] A local unsigned `.app` builds with one command; a tray item shows the daemon state and opens the window
- [ ] `pnpm -r build && pnpm -r test && pnpm lint` and `doc-metrics --fail` green; Log tells the story

## Plan
- [ ] 1. `packages/protocol`: nothing new unless the bridge needs a shared type; the bridge contract goes under Contracts first (desktop, ui reviews)
- [ ] 2. `packages/desktop/`: Electron main process, one `BrowserWindow` loading the daemon URL, daemon discovery and start, tray, `electron-vite` or plain Vite for the preload; `pnpm desktop` for development, `pnpm desktop:build` for the `.app` (desktop)
- [ ] 3. `packages/desktop/src/previews.ts`: one `WebContentsView` per preview key (`<session>/<service>`), created on demand, shown or hidden on tab switch, bounds set from the renderer's rectangle, destroyed on session close; reload, open-in-browser, devtools (desktop)
- [ ] 4. Preload bridge `window.spinnerDesktop`: `previews.set(key, url, rect) / show(key) / hide / reload / openExternal / devtools`, `daemon.status()`; typed in one file both packages import (desktop)
- [ ] 5. `packages/ui`: `Preview.tsx` detects the bridge; with it, renders an empty box, measures its rectangle with `ResizeObserver` and on scroll, and calls the bridge; without it, keeps the iframe and shows the "open in tab" note when the service's `preview: top-level` flag is set in the spec (ui)
- [ ] 6. The note's flag: `services.<name>.preview: frame | top-level` in `StackSpec`, default `frame`; `ServiceView` carries it (desktop adds the field in protocol; ui reads it)
- [ ] 7. End to end: the sample stack in the desktop app (new → up → previews → verify → close), then the operator's app logged in inside the preview (operator)
- [ ] 8. Lessons → protocol (Cullen)

## Roster
| Agent   | Owns | Doing | Blocked? | Updated |
|---------|------|-------|----------|---------|
| desktop | `packages/desktop/**`, the bridge type file, `packages/protocol` (the `preview` field only), root scripts `desktop`, `desktop:build` | — | no | — |
| ui      | `packages/ui/**` | — | no | — |

## Contracts & decisions
- (date) Cullen: the app connects to an existing daemon on `localhost:7777` and starts one only when none answers. It never owns the daemon's lifecycle beyond that; `spinner daemon stop` is the operator's.
- (date) Cullen: the web UI stays first-class. Every feature works in a browser; the desktop adds top-level previews and the tray, nothing else.
- (date) Cullen: Electron, not Tauri: previews need independent top-level web contents.
- (date) Cullen: the bridge is the only desktop-specific surface in the web UI, and `Preview.tsx` is the only file that uses it.
- (date) Cullen: previews are `WebContentsView`s with the default session (shared cookies across previews of the same app, like tabs in one browser). A per-session partition is a later option.
- (date) Cullen: no signing, no notarization in M4; a local `.app` for the operator. M5 packages and signs.
- (date) Cullen: rules from s001 to s006 (protocol, *Lessons*): Log times from `date +%H:%M`; stage by path; no `git add -A`, no `git stash`; `mktemp -d` scratch, reported, never deleted; one retry on an environment failure; never print `.npmrc`, `.env*`, `auth.json`, `~/.spinner/env`, or a file named with `token`, `key` or `secret`; no customer or person in a tracked file; a change under `src/stack/` or `src/pipeline/` runs its tests in a `node:24` container before the push; never signal a pid without its identity.

## Open questions
- (none yet)

## Log
- (start) Cullen: session opened after s006; two pi subagents from one parent, briefs in agents/*/BRIEF.md
