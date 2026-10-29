# Soak questions, M1 to M2

The operator uses Spinner on real work between the M1 exit (2026-10-27) and the start of M2. Every friction goes here as one line: what happened, what the operator expected, and the smallest change that would fix it. The M2 plan starts from this list.

| Date | What happened | Expected | Smallest fix |
|---|---|---|---|
| 2026-10-27 | After a merge-queue pop-out the board showed `fixing` with an empty `needs you` | the line says why: "popped out of the queue (manual); 1 bot thread open" | `needs_human` carries the pop-out reason for one poll (STATUS finding 21) |
| 2026-10-29 | `run local` after a session was adopted: no worktrees, then `add agent` wanted a brief with no way to write one | adopt a PR and work on it | `attach project` and a default brief (done in s006) |
| 2026-10-29 | `verify` ticked by mistake; no way to untick | a toggle | `DELETE /sessions/:dir/verify`, the checkbox toggles |
| 2026-10-29 | the web preview was blank: `node-sass` binding missing in a fresh worktree install | the app renders | `seed_files` copied after `install`, not before; the entry had been lost in a spec rewrite |
| 2026-10-29 | login inside the preview frame loops back to the login page; in a tab it holds | log in once in the frame | the app's auth cookies are `SameSite=Lax`, which a cross-site frame never sends; `*.localhost` labels are separate sites in Chrome. The UI says "open in tab" on such a preview; the real fix is M4's `WebContentsView` |
| 2026-10-29 | `close` of a scratch session killed the operator's browser windows and apps | nothing outside the session is touched | a reused pid was signalled as a process group; fixed in 68e8ccf: identity is pid plus start time |
| 2026-10-29 | `run local` opened a browser tab at the dev server's own port | nothing opens on its own | the dev server's `open: true`; `--no-open` in the service command, and the recipe notes it |
| 2026-10-29 | the preview pane cannot grow past a fixed share of the window | drag the divider all the way; the middle pane collapses | collapsible panes with a restore strip |
| 2026-10-29 | no way to hide or pop out a pane | hide and pop-out per pane; a popped-out preview keeps its login | pane controls; in the desktop app a pop-out is a window with the `WebContentsView` |
