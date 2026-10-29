# @spinner/desktop

The web UI in an Electron window, with each preview as a `WebContentsView`: a top-level
page, so an app whose login lives in `SameSite=Lax` cookies stays logged in. The app
connects to the daemon on `localhost:7777` and starts one with `spinner daemon start` when
none answers. The web UI in a browser keeps working unchanged.

## Run

```
pnpm -r build          # the daemon's UI and the CLI must be built
pnpm desktop           # build this package and open the window
pnpm desktop:build     # also package packages/desktop/dist-app/Spinner-darwin-<arch>/Spinner.app
```

Environment: `SPINNER_PORT` picks the daemon port, `SPINNER_REPO` the checkout the app
starts a daemon from (default: this checkout, baked into the `.app` at package time),
`SPINNER_DESKTOP_DEBUG=1` logs every bridge call and the bounds applied to each view.

## How it fits

| File | Role |
|---|---|
| `src/main.ts` | The main process: window, IPC, daemon link, events socket, tray. |
| `src/previews.ts` | Pure registry: one view per `<session dir>/<service>`, shown one at a time, hidden views kept alive, destroyed on `session.closed`, bounded at 32. |
| `src/electron-previews.ts` | The `WebContentsView` behind each registry entry; a failed load shows the error inside the view. |
| `src/daemon.ts` | Probe `/health`; start a daemon and poll for 30 s; never start one after a loss. |
| `src/start-daemon.ts` | `node packages/cli/dist/main.js daemon start`, with Electron's own Node as the fallback. |
| `src/events.ts` | The app's own `/events` socket, for `session.closed` and loss. |
| `src/preload.cts` | `contextBridge` for `window.spinnerDesktop`, typed in `@spinner/protocol`'s `desktop-bridge.ts`. |
| `src/tray.ts`, `src/tray-icon.ts` | The tray item; the icon is drawn at runtime. |
| `scripts/package.ts` | The unsigned `.app`. |
| `e2e/drive.ts` | Drives a running app over CDP through the sample-stack flow. |

The renderer never sees an Electron API. `Preview.tsx` in `packages/ui` measures its box and
calls `previews.set(key, url, rect)`; the main process places the view. One preview shows
at a time; a hidden one keeps its page.

## Test

```
pnpm --filter @spinner/desktop test                       # Vitest, main-process logic
cd packages/desktop && ./node_modules/.bin/electron . --remote-debugging-port=9345
E2E_CDP_PORT=9345 node e2e/drive.ts <screenshot dir>      # against a running daemon
```

The driver creates its own session on `examples/sample-stack` and closes it. With
`E2E_WINDOW_ID=<CGWindowNumber>` it saves a window screenshot per step. An occluded window
(another window in front) does not lay out or paint its views, so the driver skips the size
check then and the `bounds` debug lines are the evidence.
