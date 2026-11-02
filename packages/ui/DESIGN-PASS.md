# UI design pass 1: audit and plan

This file records the audit of the web UI before the visual pass and the change for each
surface. The reference is Graphite's web app: its PR stack view, its dense but calm tables, its
toolbars with one clear primary action, its status pills, and its type and spacing. The
information architecture stays. Every class, `role` and `aria-label` that `e2e/drive.ts` reads
stays, and every button keeps its text, because the drivers click by text.

The before-screenshots are 1500×900 shots of the fixture (`SPINNER_PORT=17877`, vite on 5277)
in `/tmp/spinner-design-VEjV/before/`; the after-shots go to `/tmp/spinner-design-VEjV/after/`.

## Constraints from the drivers

- A session card and the compose card must keep the same height (`sessions-panel`).
- The column widths, the handle width and the pane minimums come from `layout.ts`. This pass
  does not change them, so `panes`, `narrow` and `drawer` measure the same numbers.
- Button labels, tab labels and `.pr-badge` text stay as they are. CSS must not change their
  case either, because some checks read `innerText`.
- `.pane-head h2`, `.context-title` and the selected view tab keep the `rainbow` gradient.

## Global findings

1. There is no spacing scale and no type scale. Sizes are 11, 12, 13 and 14 px in a random
   mix, and paddings are 2 to 10 px. The page reads as busy because nothing lines up.
2. Most buttons are unstyled native buttons: a grey fill in dark mode. The danger buttons
   (`land`, `reset`, `close`) have an outline only, so they look lighter and safer than the
   normal ones. The hierarchy is inverted.
3. Inputs, selects and textareas are native grey boxes with placeholder text as their only
   label. They do not follow the palette.
4. Pane titles, view tabs and section heads are all upper case. Upper case everywhere removes
   the contrast between a title and a label.
5. The resize handles draw as solid grey bars, about 6 px wide. They are the heaviest lines
   on the page.
6. There is no shared focus ring. Keyboard focus is hard to see on most controls.
7. Empty states are blank: an empty Activity drawer is a large empty box with no text.

## Foundation (applies to every surface)

- Spacing scale as variables: `--space-1` 4 px, `--space-2` 8 px, `--space-3` 12 px,
  `--space-4` 16 px, `--space-5` 24 px. Paddings and gaps use only these and 2 px.
- Type scale: 11 px for meta and labels, 12 px for dense content (tables, chips, buttons,
  logs), 13 px for body, 14 px for titles, 16 px for a form heading. Numbers use
  `font-variant-numeric: tabular-nums`. Paths, SHAs and URLs use the mono stack.
- Radius: 4 px for controls, 6 px for cards and boxes, 999 px for pills.
- Control heights: 24 px in toolbars and rows, 28 px in forms.
- Title case: pane titles and tabs use normal case with weight 600 and `--text`. Section
  labels (inside the drawer, settings, mission) use 11 px, weight 600, `--muted`, a small
  letter-spacing, and upper case only where the text is not read by a driver.
  Graphite pattern: calm sentence-case headers; contrast comes from weight and colour.
- Buttons, one base style for every `button` with no own class, plus four kinds:
  - Secondary (the default): `--fill-soft` background, a 1 px `--border` line, `--text`.
    Hover raises it to `--fill`.
  - Primary (`.primary`): `--accent` background, white text. One per form or dialog.
  - Danger (`.danger`): transparent, `--fail` text, and a `--fail` line at 50 %. Hover fills
    with `--fail-fill`. The colour says "irreversible" before the click.
  - Icon (`.icon-button`): stays as it is, with the shared focus ring.
  - Disabled: 40 % opacity, no hover, `cursor: default`.
  Graphite pattern: one filled primary, quiet secondaries, red text for destructive actions.
- Inputs: `--bg` background, a 1 px `--border` line, 4 px radius, 28 px high. Focus shows an
  `--accent` line and a 2 px `--accent-fill` ring. Placeholders use `--muted`.
- Focus: one `:focus-visible` rule, a 2 px `--accent` outline with a 1 px offset, on every
  button, tab, chip, input and link.
- Pills (`.badge`, `.pr-badge`, stage, thread state): 18 px high, 11 px, weight 500, 999 px
  radius. Neutral pills use `--fill-soft` and `--muted`. State pills use the tint and the
  colour of the state: ok, warn, fail, accent. Graphite pattern: status pills on PR rows.
- Dots: 8 px. Filled `--ok` means up or working. Filled `--warn` means starting or unhealthy.
  Filled `--fail` means failed. A hollow ring in `--muted` means idle or none. A dashed ring
  means off. Today idle and off use two greys that are almost invisible.
- Handles: the hit area keeps its width; the visible line becomes 1 px of `--line-soft` and
  turns `--accent` on hover and on drag. Graphite pattern: hairline panel dividers.
- Hover on rows and cards: `--fill-soft`. Selection: `--accent-tint` plus a 2 px accent bar.

## Context bar (top)

Finding: one run-on line. Stage, stack, two usage numbers, the PR count and the needs-you
text have the same weight, so the eye finds nothing.
Change: 36 px high. The title at 14 px weight 600, then the stage pill, then a stack pill with
its dot. The usage numbers become `--muted` 11 px meta text. The PR badge is a state pill.
The needs-you text becomes a warn pill at the right end, so the one call to action stands
apart. Graphite pattern: the PR header row, title then pills then meta, the action at the right.

## Activity bar (left)

Finding: it works. The selected icon has a 2 px accent line, but the icons are 55 % grey.
Change: 44 px wide, 32 px buttons with a 6 px radius. The selected icon gets `--fill` and
full opacity. Hover gets `--fill-soft`. No change to the order or the labels.

## Sessions panel

Finding: the compose card is two dashed boxes as tall as a session card, the strongest
element in the panel. The cards have a blank line under a one-line title. The selected card
differs from the others only by its border colour.
Change:
- Compose card (same height as a card): `New session` becomes the primary block, a solid
  `--accent-tint` with an accent line and an accent `+`. `Adopt` becomes a secondary block
  with a `--fill-soft` background. No dashed lines.
- Session cards: 6 px radius, `--surface` background, no outer border, a hairline between
  cards. The title at 13 px weight 600. The badge line becomes pills: stage, stack dot and
  state, the PR pill. Usage moves to muted meta at the right. The needs-you line is warn
  text with a small warn dot. The selected card gets `--accent-tint` and a 2 px accent bar
  on the left edge. Hover gets `--fill-soft`.
- The pane head: "Sessions" in normal case, with the count of sessions in muted text.
Graphite pattern: the PR list, where each row is a calm block and the active row has a tint
and a left bar.

## Middle pane: view tabs, toolbar, chips

Finding: the four view tabs are upper case and the same weight as the toolbar under them.
The toolbar is ten grey buttons in a row, where the danger ones look the weakest. At 1000 px
the toolbar wraps onto three lines, and a lone separator starts the third line. The view
tabs clip ("SE…"). The chips, the sub-tabs and the toolbar have no vertical rhythm.
Change:
- View tabs: normal case, 13 px, 36 px high, the 2 px accent underline kept. The row may
  scroll sideways, so a narrow window never clips a tab.
- Toolbar: 40 px row with a hairline under it. Each group is a joined button group: shared
  borders, 4 px radius only at the ends. The groups stay whole when the row wraps
  (`flex-wrap` on the toolbar, `nowrap` in a group). The separators hide, and the gap between
  groups is 12 px. The `reset` and `close` group moves to the right end with
  `margin-left: auto`. `land`, `reset` and `close` use the danger style.
  Graphite pattern: the toolbar of the PR page, actions grouped, destructive ones apart.
- Agent chips: 24 px high, 12 px. The selected chip gets `--accent-tint` and an accent line.
  The dot uses the dot semantics above: working is a green dot, idle a hollow ring, off a
  dashed ring and a muted name. The `×` shows on hover of the selected chip in `--fail`.
  The `+` chip becomes a 24 px round icon chip.
- Sub-tabs (terminal, context): 12 px, 28 px high, 8 px gap above.

## Terminal and Activity drawer

Finding: the terminal has no frame, so it merges with the pane. The drawer is a bordered
box with an upper-case title. With no job it is an empty box. The job state "up · ok" is
plain bold text. The `close` button is a grey native button. The events list uses bullets.
In the operator view the drawer sits outside a `.pane`, so its title falls back to the
browser's `h2` size (about 21 px): a bug.
Change:
- Terminal: a 6 px radius frame with a 1 px `--line-soft` line, 8 px padding.
- Drawer: `--surface` background, 6 px radius, a 1 px `--line-soft` line. The head is 32 px:
  "Activity" at 12 px weight 600 (also in the operator view), then the job state as a pill
  (running accent, ok green, failed red), the `close` button as a small secondary button,
  then the collapse icon.
- Section labels "Job log" and "Events" at 11 px `--muted`.
- The job log in mono 11 px on `--bg` with 8 px padding.
- Events: no bullets, one 20 px row each, the session name `--muted`, the text `--text`.
- Empty state: one muted line, "No job yet. The log of the next action shows here."
- The collapsed bar: 28 px high, the same pill for the state.
Graphite pattern: the CI checks panel, a quiet list with one pill per run.

## Mission view

Finding: bold labels with blue `edit` links, then raw text. The roster table has a full
grid of borders.
Change: each section is a block with an 11 px muted label and the `edit` link as a small
ghost button on the label row, which shows on hover and on focus. 16 px between blocks.
The roster table follows the table style below.

## Threads view

Finding: `refresh from GitHub` is a grey button next to a raw ISO time. Each thread has a
full-width grey reply input and three disabled-looking buttons. The state words are tiny
grey pills.
Change: a header row with the PR link, its CI state as a pill, and the refresh as a
secondary button at the right, with the time as "rendered 05:08" in muted text (the full
time stays in the `title`). Thread cards: 6 px radius, `--surface`, a pill for the state
(open accent, resolved muted) and a neutral pill for bot or human, the file path in mono
muted. The reply row is a themed input with `reply` as primary and `resolve` and `flag` as
secondary buttons.
Graphite pattern: review comments, one card per thread with the location in mono.

## Services view and all tables (`.services`, `.roster`)

Finding: the header row is bold white, the same weight as the data.
Change: the header in 11 px weight 600 `--muted`, a hairline under it and between rows, no
vertical lines. Rows are 28 px with 8 px side padding. Number columns use tabular numerals.
The state cell is a pill with the dot. Row hover `--fill-soft`. The usage line above the
table becomes muted meta.
Graphite pattern: the dense, calm PR table.

## Context tab

Finding: the `collapse all` and `expand all` links float. The scope pills look like the
thread pills but mean something else.
Change: the links become small ghost buttons in a right-aligned row. The file sections
share one bordered list with hairlines between rows, 32 px headers, the path in mono muted.

## Add agent and compose forms

Finding: the fields have no labels, only placeholders. The inputs are grey native boxes.
"No worktree yet" sits on one line with a select and a disabled button, without spacing.
The primary button is outlined and the cancel button is filled, which inverts the order.
Change: a form card (6 px radius, `--surface`, 16 px padding, 520 px max). A 16 px heading,
a visible 11 px label over each field (the `aria-label`s stay), 12 px between fields.
Primary button (`add agent`, `Create session`, `Adopt`) filled with accent and first in the
row; `cancel` secondary. The worktree notice becomes a warn-tint banner with its select and
button on one row.
Graphite pattern: the create-stack dialog, labels above fields and one filled action.

## Previews pane

Finding: the `verified` checkbox floats alone on its own row. The web and api tabs are
boxed buttons, a third tab style. The browser bar is fine. The frame note has a heavy
orange border.
Change: one row with the preview tabs in the underline style of the view tabs (with their
dots), and `verified` at the right end of that row as a compact checkbox. The browser bar is
32 px with a themed 24 px address field. The note becomes a warn-tint banner with a 2 px warn
bar on the left and no full border. The frame gets a 6 px radius and a `--line-soft` line.

## Settings view

Finding: the labels, the select, the swatches and the hint run together with little space.
The hint wraps a long path in the middle of a word.
Change: 16 px between settings. Each setting: an 11 px muted label, a 28 px themed select, a
one-line muted help text. The swatches become 14 px squares with 2 px gaps under the select.
The hint is a muted block with the paths as inline mono code that breaks at slashes.

## Operator view

Finding: the `stop` button is grey and the "waiting on" line is plain text. The drawer title
bug is above.
Change: the toolbar uses the button system (`stop` as danger, `resume` as primary). The
waiting line becomes a muted line with a warn dot.

## Status footer

Finding: a full row with "daemon: open".
Change: a 22 px footer, 11 px muted, with a state dot (green when open, warn when connecting,
red when closed) before the same text.

## Narrow window (1000 px)

Finding: the view tabs clip, the toolbar takes three lines, and the terminal is about 270 px
wide.
Change: the tab row scrolls instead of clipping. The joined button groups wrap as units, so
the toolbar takes two lines at most. The fold order and the widths stay as `layout.ts` sets
them.

## Order of work (phase 2, after approval)

One commit per surface, each with after-screenshots beside the before ones:
1. Foundation: variables, buttons, inputs, focus, pills, dots, handles, footer.
2. Context bar and activity bar. 3. Sessions panel. 4. Middle pane tabs, toolbar and chips.
5. Terminal and drawer. 6. Mission, threads, services, context. 7. Forms. 8. Previews.
9. Settings and operator.
Each commit runs `pnpm --filter ui test`, root `pnpm lint`, and the fixture driver flows.

## Open questions for the operator

1. Moving `reset` and `close` to the right end of the toolbar changes the reading order.
   I recommend it, because it separates the destructive group. Accept or keep in place?
2. Normal case for pane titles and tabs (the text is already lower case in the DOM, so the
   tabs would read "agents", "mission"). I recommend a CSS `text-transform: capitalize`
   only where no driver reads `innerText`, else plain lower case. Which do you prefer?
3. Visible labels in the forms add DOM text. The `aria-label`s stay. Accept?
