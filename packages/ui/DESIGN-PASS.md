# UI design pass 1: audit and plan

This file records the audit of the web UI before the visual pass and the change for each
surface. The reference is Graphite's web app: its PR stack view, its dense but calm tables, its
toolbars with one clear primary action, its status pills, and its type and spacing. The
information architecture stays. Every class, `role` and `aria-label` that `e2e/drive.ts` reads
stays, and every button keeps its text, because the drivers click by text.

The before-shots are 1500×900 shots of the fixture (`SPINNER_PORT=17877`, vite on 5277) in
`/tmp/spinner-design-VEjV/before/`. The after-shots go to `/tmp/spinner-design-VEjV/after/`.

## Constraints from the drivers

- A session card and the compose card keep the same height (`sessions-panel`).
- Column widths, handle widths and pane minimums come from `layout.ts` and do not change, so
  `panes`, `narrow` and `drawer` measure the same numbers.
- Button, tab and `.pr-badge` text stays. CSS does not change its case where a check reads
  `innerText`.
- `.pane-head h2`, `.context-title` and the selected view tab keep the `rainbow` gradient.

## Foundation (every surface)

Findings: there is no spacing or type scale (sizes 11 to 14 px and paddings 2 to 10 px in a
random mix). Most buttons are native grey buttons, and the danger ones (`land`, `reset`,
`close`) have only an outline, so they look the safest: the hierarchy is inverted. Inputs are
native grey boxes with a placeholder as their only label. Every title, tab and label is upper
case, so nothing stands out. The resize handles are solid grey bars, the heaviest lines on the
page. There is no shared focus ring.

Changes:
- Spacing variables `--space-1..5`: 4, 8, 12, 16, 24 px. Paddings and gaps use these and 2 px.
- Type: 11 px meta and labels, 12 px dense content (tables, chips, buttons, logs), 13 px body,
  14 px titles, 16 px form headings. Tabular numerals for numbers. Mono for paths, SHAs, URLs.
- Radius: 4 px controls, 6 px cards and boxes, 999 px pills. Heights: 24 px in toolbars and
  rows, 28 px in forms.
- Case: titles and tabs in normal case, weight 600. Section labels 11 px, weight 600,
  `--muted`. Graphite pattern: calm headers where contrast comes from weight and colour.
- Buttons. A base style for every `button` without its own class, plus four kinds:
  secondary (default): `--fill-soft`, a 1 px `--border` line, `--fill` on hover;
  primary (`.primary`): `--accent` fill, white text, one per form or dialog;
  danger (`.danger`): transparent, `--fail` text and line, `--fail-fill` on hover;
  icon (`.icon-button`): as now. Disabled: 40 % opacity, no hover.
  Graphite pattern: one filled primary, quiet secondaries, red text for destructive actions.
- Inputs: `--bg` fill, a 1 px `--border` line, 28 px high. Focus: an `--accent` line and a
  2 px `--accent-fill` ring. Placeholders in `--muted`.
- Focus: one `:focus-visible` rule, a 2 px `--accent` outline, on every interactive element.
- Pills (stage, PR, thread state, job state): 18 px, 11 px, weight 500. Neutral pills use
  `--fill-soft` and `--muted`; state pills use the tint and colour of ok, warn, fail or accent.
  Graphite pattern: status pills on PR rows.
- Dots, 8 px: green is up or working, warn is starting or unhealthy, red is failed, a hollow
  `--muted` ring is idle or none, a dashed ring is off. Today idle and off are two greys that
  are almost invisible.
- Handles: the hit area keeps its width; the visible line is 1 px `--line-soft`, `--accent` on
  hover and drag. Graphite pattern: hairline panel dividers.
- Rows and cards: `--fill-soft` on hover; selection is `--accent-tint` plus a 2 px accent bar.
- Empty states: one muted sentence that says what will show there.

## Context bar (top)

Finding: one run-on line where stage, stack, usage, PR count and the needs-you text all have
the same weight. Change: 36 px high; the title at 14 px weight 600, the stage pill, a stack
pill with its dot, the usage as 11 px muted meta, the PR pill, and the needs-you text as a
warn pill at the right end, so the one call to action stands apart.
Graphite pattern: the PR header, title then pills then meta, the action at the right.

## Activity bar (left)

Finding: it works, but the icons are 55 % grey. Change: 32 px buttons with a 6 px radius; the
selected icon gets `--fill`, full opacity and the accent line; hover gets `--fill-soft`.

## Sessions panel

Finding: the compose card is two dashed boxes as tall as a card, the strongest element in the
panel. A one-line title leaves a blank line. The selected card differs only by its border.
Change: `New session` becomes the primary block (`--accent-tint`, an accent line and `+`);
`Adopt` a secondary block (`--fill-soft`); no dashes; the height stays. Cards: 6 px radius,
`--surface`, title 13 px weight 600, the badge line as pills (stage, stack dot and state, PR),
usage as muted meta, the needs-you line as warn text. Selected card: `--accent-tint` and a
2 px accent bar on the left. The head reads "Sessions" with a muted count.
Graphite pattern: the PR list, calm rows, the active one tinted with a left bar.

## Middle pane: view tabs, toolbar, chips

Finding: upper-case tabs with the same weight as the toolbar. The toolbar is ten grey buttons
where the danger ones look weakest. At 1000 px it wraps to three lines with a lone separator,
and the tabs clip ("SE…"). Chips, sub-tabs and toolbar have no vertical rhythm.
Change:
- View tabs: normal case, 13 px, 36 px row, accent underline kept; the row scrolls sideways
  instead of clipping.
- Toolbar: a 40 px row with a hairline under it. Each group is a joined button group (shared
  borders, radius at the ends) that wraps as a unit. Separators hide; 12 px between groups.
  `reset` and `close` move to the right end. `land`, `reset`, `close` use the danger style.
  Graphite pattern: the PR page toolbar, actions grouped, destructive ones apart.
- Chips: 24 px, 12 px. The selected chip gets `--accent-tint` and an accent line. Dots follow
  the dot rules; off chips show a muted name. The `×` turns `--fail` on hover. The `+` chip is
  a 24 px round icon chip.
- Sub-tabs (terminal, context): 12 px, 28 px row, 8 px above.

## Terminal and Activity drawer

Finding: the terminal has no frame. The drawer is a bordered box with an upper-case title,
and empty it is a blank box. "up · ok" is plain bold text, `close` a grey native button, the
events a bullet list. In the operator view the drawer sits outside `.pane`, so its title falls
back to the browser `h2` size (about 21 px): a bug.
Change: the terminal gets a 6 px radius frame with a `--line-soft` line. The drawer gets
`--surface`, a 6 px radius and a 32 px head: "Activity" at 12 px weight 600 (in the operator
view too), the job state as a pill (running accent, ok green, failed red), `close` as a small
secondary button, the collapse icon. "Job log" and "Events" become muted 11 px labels. The
log is mono 11 px on `--bg`. Events are 20 px rows without bullets, the session name muted.
Empty state: "No job yet. The log of the next action shows here." The collapsed bar is 28 px
with the same pill. Graphite pattern: the CI checks panel, a quiet list with a pill per run.

## Mission view

Finding: bold labels with blue `edit` links over raw text; the roster has a full border grid.
Change: each section is a block with an 11 px muted label and `edit` as a small ghost button
on the label row; 16 px between blocks; the roster follows the table style below.

## Threads view

Finding: `refresh from GitHub` is a grey button beside a raw ISO time. Each thread has a grey
full-width input and three buttons that look disabled. The state words are tiny grey pills.
Change: a header row with the PR link, its CI state as a pill, the time as muted "rendered
05:08" (the full time in `title`), and refresh as a secondary button at the right. Thread
cards: 6 px radius, `--surface`, a state pill (open accent, resolved muted), a neutral pill
for bot or human, the path in mono. The reply row: a themed input, `reply` primary, `resolve`
and `flag` secondary. Graphite pattern: review comments, one card per thread.

## Services view and tables (`.services`, `.roster`)

Finding: the header row is bold white, as heavy as the data. Change: headers 11 px weight 600
`--muted`, hairlines under the header and between rows, no vertical lines, 28 px rows, tabular
numerals, the state as a pill with its dot, row hover `--fill-soft`, the usage line as muted
meta. Graphite pattern: the dense, calm PR table.

## Context tab

Finding: `collapse all` and `expand all` float as links. Change: small ghost buttons in a
right-aligned row; the files share one bordered list with hairlines, 32 px headers, the path
in mono muted.

## Add agent and compose forms

Finding: fields have placeholders but no labels; inputs are grey native boxes; the worktree
notice jams a select and a button into one line; the primary button is outlined and `cancel`
is filled, which inverts the order.
Change: a form card (6 px radius, `--surface`, 16 px padding, 520 px max), a 16 px heading, an
11 px visible label over each field (the `aria-label`s stay), 12 px between fields, the
primary button (`add agent`, `Create session`, `Adopt`) filled and first, `cancel` secondary.
The worktree notice becomes a warn-tint banner. Graphite pattern: the create dialog.

## Previews pane

Finding: `verified` floats alone on a row. The web and api tabs are boxed buttons, a third tab
style. The frame note has a heavy orange border.
Change: one row with the preview tabs in the underline style (with their dots) and `verified`
at its right end. The browser bar is 32 px with a themed 24 px address field. The note becomes
a warn-tint banner with a 2 px warn bar on the left. The frame gets a 6 px radius.

## Settings view

Finding: label, select, swatches and hint run together; the hint breaks a path mid-word.
Change: 16 px between settings; an 11 px muted label, a 28 px themed select, 14 px swatches;
the hint as a muted block with the paths as inline mono code.

## Operator view and status footer

Finding: `stop` is a grey button; "daemon: open" takes a full row. Change: `stop` uses the
danger style and `resume` the primary; the waiting line is muted with a warn dot. The footer is
22 px, 11 px muted, with a state dot (green open, warn connecting, red closed).

## Narrow window (1000 px)

Finding: the tabs clip, the toolbar takes three lines, the terminal is about 270 px wide.
Change: the tab row scrolls; the joined groups wrap as units, so the toolbar takes two lines at
most. The fold order and the widths stay as `layout.ts` sets them.

## Order of work (phase 2, after approval)

One `ui:` commit per surface, each with after-shots: foundation; context and activity bars;
sessions panel; middle pane; terminal and drawer; mission, threads, services and context;
forms; previews; settings and operator. Each commit runs `pnpm --filter ui test`, root
`pnpm lint`, and the fixture driver flows.

## Open questions for the operator

1. Move `reset` and `close` to the right end of the toolbar? I recommend it: it separates the
   destructive group.
2. Pane titles and tabs: plain lower case as the DOM has it ("agents", "mission"), or CSS
   `capitalize` where no check reads `innerText`? I recommend plain lower case: no risk to the
   drivers, and it matches the button labels.
3. Visible labels over form fields add DOM text; the `aria-label`s stay. Accept?
