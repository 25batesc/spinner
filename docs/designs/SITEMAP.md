# Design docs

This directory holds Spinner's approved design documents. They follow the Elephant-Goldfish Model (EGM, Google, Apache-2.0, https://github.com/google/elephant-goldfish-model): an Elephant drafts the spec, fresh-context Goldfish reviewers audit it, the operator resolves the findings and approves. `tools/doc-metrics.py` skips this directory, because the docs follow EGM's document standards instead of `WRITING.md`.

A doc on the base branch cannot become a later session's own design doc (`egm-adoption.md`, Technical Plan T7).

| Link | Date | Author | Components | Description |
|---|---|---|---|---|
| [egm-adoption.md](egm-adoption.md) | 2026-11-02 | spinner-agent (the Elephant); approved by the operator | protocol, daemon, pi extension, cli, ui, docs | Spinner adopts EGM: the design doc becomes the session's spec. Reviewed, version 3, with 6 build sessions. |
| [session-workspace.md](session-workspace.md) | 2026-11-04 | lead of s046 (the Elephant) | protocol, daemon, pi extension, ui, docs | One row of tabs in step order, Implement as a phase-first list, the Plan seeded from the doc's entries at approval and linked back to it. Version 2 (4 blockers and 17 majors of the review applied), with 2 build sessions. |
| [talk-change-ship.md](talk-change-ship.md) | 2026-11-12 | the operator and his agent, in conversation | protocol, daemon, pi extension, ui, docs | Spinner's way of working: talk, change, test, ship. The fast path is the default; a session holds several changes; a plan is a document in a library and EGM is its optional toolset. Approved by the operator without a Goldfish review. Step 1 built (v0.25.0); steps 2 to 5 in outline. |
