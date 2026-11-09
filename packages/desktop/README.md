# @spinner/desktop

The web UI in an Electron window, with each preview as a `WebContentsView`: a top-level
page, so an app whose login lives in `SameSite=Lax` cookies stays logged in. Each Spinner
session's previews share one cookie partition (`persist:<session dir>`), so two sessions of
one app hold two logins, and a pop-out keeps the view and with it the login. The app
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
`SPINNER_DESKTOP_DEBUG=1` logs every bridge call and the bounds applied to each view,
`SPINNER_DESKTOP_WINDOW=WxH+X+Y` places the main window (a test app beside a real one).

## Pop-out windows

A preview pops out into its own window: the window adopts the preview's `WebContentsView`,
so the page does not reload and its login stays. The window opens 40 px right and down
from the main window at the pane's size (at least 480x360) and follows a resize. Dock back
(a bridge call or the window's close button) puts the view back in the main window, hidden
until the pane's next `set`, and sends `pane.docked` to the renderer. The sessions and
agents panes pop out as a `BrowserWindow` on the UI's `?pane=<pane>&session=<dir>` route,
with the bridge preloaded so the page can dock itself back. One window per preview key or
`(pane, session)`; a second pop-out focuses it. The tray menu lists the popped-out windows.
A session's windows close with it.

## Notifications

The app opens its events socket with `?client=desktop`. While that socket is open, the
daemon does not run its `osascript` banner: it sends a `notify` event, and the app posts it
as an Electron `Notification`. macOS shows the banner under Spinner's name and bundle icon
(`Electron` in a dev run). A click shows the main window and sends the session directory to
the page through `spinnerDesktop.sessions.subscribeFocus`; the page selects that session.
Without the app, the daemon shows the `osascript` banner as before.

## How it fits

| File | Role |
|---|---|
| `src/main.ts` | The main process: window, IPC, daemon link, events socket, tray. |
| `src/previews.ts` | Pure registry: one view per `<session dir>/<service>`, shown one at a time, hidden views kept alive, destroyed on `session.closed`, bounded at 32. |
| `src/electron-previews.ts` | The `WebContentsView` behind each registry entry; a failed load shows the error inside the view; pop-out moves it into a `BaseWindow`. |
| `src/inspect-page.ts` | The script `previews.inspect` runs in the page's main world: selector, text, rect, React component and source. |
| `src/pane-windows.ts` | Pure registry of pane windows: one per `(pane, session)`, closed with the session. |
| `src/window-geometry.ts` | `SPINNER_DESKTOP_WINDOW` parsing. |
| `src/daemon.ts` | Probe `/health`; start a daemon and poll for 30 s; never start one after a loss. |
| `src/start-daemon.ts` | `node packages/cli/dist/main.js daemon start`, with Electron's own Node as the fallback. |
| `src/events.ts` | The app's own `/events` socket (`?client=desktop`), for `session.closed`, `notify` and loss. |
| `src/notifications.ts` | Pure poster: one Electron `Notification` per `notify` event; a click focuses the session. |
| `src/preload.cts` | `contextBridge` for `window.spinnerDesktop`, typed in `@spinner/protocol`'s `desktop-bridge.ts`. |
| `src/tray.ts`, `src/tray-icon.ts` | The tray item; the icon is drawn at runtime. |
| `scripts/package.ts` | The unsigned `.app`. |
| `e2e/cdp.ts` | The DevTools-protocol page the drivers share. |
| `e2e/drive.ts` | Drives a running app over CDP through the sample-stack flow. |
| `e2e/popout.ts` | Drives the pop-out flow through the bridge: no reload across pop out, dock back, close, and session close. |
| `e2e/browser-bar.ts` | Drives the browser-bar half of the bridge: navigate, back, forward, zoom, find, clear storage, and the `navigated` events. |
| `e2e/sample-session.ts` | The sample-stack steps the drivers share; closes a session by dir through the API. |

The renderer never sees an Electron API. `Preview.tsx` in `packages/ui` measures its box and
calls `previews.set(key, url, rect)`; the main process places the view. One preview shows
at a time; a hidden one keeps its page.

## Browser bar

The bridge carries the bar's actions for a view: `navigate`, `back`, `forward`, `zoom`
(one Chromium level per step, per origin), `find` (`findInPage`; the same text again finds
the next match; null clears), and `clearStorage` (the view's current origin only, then a
reload; the renderer confirms first). A `navigated` event through `previews.subscribe`
carries `url`, `title`, `canGoBack`, `canGoForward` and `loading` on `did-navigate`,
`did-navigate-in-page`, `page-title-updated`, `did-start-loading` and `did-stop-loading`.
Navigation stays inside the view; a `target=_blank` link still opens the external browser.

## Preview comments

The bar's comment button (s054) freezes the preview. Nothing the renderer draws can sit
over a live `WebContentsView`, so the renderer hides the view and shows a picture of the
page in its place. The operator marks the picture; the UI sends the comment to the daemon
(DAEMON_API.md, "Preview comments"). Two bridge methods carry it:

- `previews.capture(key)` returns `PreviewCapture`: the visible page as a PNG
  (`webContents.capturePage()`, base64, at the screen's pixel density), the viewport
  `width` and `height` in CSS pixels (the zoom is taken out), the page's `url`, and
  `console_errors`. The view collects each `console-message` at level error from its
  creation, at most `CONSOLE_ERRORS_MAX` (20, the newest kept), each cut at
  `CONSOLE_ERROR_CHARS_MAX` (500) characters. A capture takes the collection and starts a
  new one. Null for an unknown key or a failed capture.
- `previews.inspect(key, point)` returns `PreviewElement` for the element at `point` (CSS
  pixels of the viewport): a CSS `selector` (an id, else a tag path with `:nth-of-type`),
  the visible `text`, the `rect`, the React `component` and its `source`. The script from
  `src/inspect-page.ts` runs through `executeJavaScript` in the page's main world, because
  React's `__reactFiber$*` keys are not visible from an isolated world. `source` is
  `_debugSource` on React 18 and older. React 19 has no `_debugSource`, so `source` is the
  first frame of `_debugStack` outside React: the dev server's module URL and line, which
  can differ from the line in the source file. Null for an unknown key, no element, or a
  page that refuses the script.

Both methods are optional on `SpinnerDesktop`. A desktop build older than v0.21.0 lacks
them, and the UI then shows no comment button.

## Test

```
pnpm --filter @spinner/desktop test                       # Vitest, main-process logic
cd packages/desktop && ./node_modules/.bin/electron . --remote-debugging-port=9345
E2E_CDP_PORT=9345 node e2e/drive.ts <screenshot dir>      # against a running daemon
```

The drivers create their own session on `examples/sample-stack` and close it by dir
through the daemon's API. They refuse the operator's daemon on :7777: start a scratch one
with `SPINNER_HOME=$(mktemp -d) SPINNER_PORT=<port> node packages/cli/dist/main.js daemon
start`, run the app with the same `SPINNER_PORT`, and set `E2E_DAEMON_URL`. With
`E2E_WINDOW_ID=<CGWindowNumber>` it saves a window screenshot per step. An occluded window
(another window in front) does not lay out or paint its views, so the driver skips the size
check then and the `bounds` debug lines are the evidence.

```
cd packages/desktop && ./node_modules/.bin/electron . --remote-debugging-port=9345 \
    --inspect=9347 --disable-backgrounding-occluded-windows --disable-renderer-backgrounding
E2E_CDP_PORT=9345 E2E_INSPECT_PORT=9347 node e2e/popout.ts <screenshot dir>
```

The pop-out driver checks that the preview's CDP target and a hash set in its page survive
every move, that the view's inner size follows the pop-out window and the pane, and that
`panes.list()` and the `pane.docked` events tell the renderer the truth. The two Chromium
switches keep a window behind another one laying out, so the size checks hold when the app
runs behind the operator's windows. `E2E_INSPECT_PORT` lets the driver close the pop-out
from the main process, the close button's path. A window capture never includes a
`WebContentsView`; the inner size over CDP is the evidence.
