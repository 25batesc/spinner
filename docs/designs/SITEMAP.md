# Design docs

This directory holds Spinner's approved design documents. They follow the Elephant-Goldfish Model (EGM, Google, Apache-2.0, https://github.com/google/elephant-goldfish-model): an Elephant drafts the spec, fresh-context Goldfish reviewers audit it, the operator resolves the findings and approves. `tools/doc-metrics.py` skips this directory, because the docs follow EGM's document standards instead of `WRITING.md`.

A doc on the base branch cannot become a later session's own design doc (`egm-adoption.md`, Technical Plan T7).

| Link | Date | Author | Components | Description |
|---|---|---|---|---|
| [egm-adoption.md](egm-adoption.md) | 2026-11-02 | spinner-agent (the Elephant); approved by the operator | protocol, daemon, pi extension, cli, ui, docs | Spinner adopts EGM: the design doc becomes the session's spec. Reviewed, version 3, with 6 build sessions. |
