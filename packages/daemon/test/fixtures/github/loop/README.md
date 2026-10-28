# GitHub fixture for a full loop without GitHub

`default.json` is `pr-fixing.json` with every check green: a PR with 2 open bot threads
that becomes ready once the threads are resolved. Run a daemon against it:

    DIR=$(mktemp -d) && cp packages/daemon/test/fixtures/github/loop/default.json "$DIR"/
    SPINNER_HOME=$(mktemp -d) SPINNER_PORT=7778 SPINNER_GITHUB_FIXTURE="$DIR" pnpm daemon

Every `gh` query answers from `default.json` plus the writes recorded in `$DIR/state.json`
(replies, resolves, approvals, queue entries, merges); `$DIR/writes.log` lists the writes.
The session's `stack/spinner.yaml` must list `acme/backend` (the repo in the fixture data) under
`pipeline.github.write_repos`, as any repo must.
