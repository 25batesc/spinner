# sample-stack

A tiny stack that anyone can run, used by the test suite and by newcomers: an API (Node, two
endpoints), a web page that calls it, Postgres with a seeded table, and a Temporal dev
server. No secrets, no external services.

Contents:

- `api/`: `GET /items` from Postgres, `GET /health`. One dependency (`pg`), so the shared
  dependency volume keyed by the lockfile hash is exercised.
- `web/`: one page that lists the items and shows which session it runs in. It renders on
  the server from the internal API URL, so `curl` through the proxy shows the data.
- `seed.sql`: the `items` table with ten rows. `spinner seed rebuild` loads it into the
  template database `sample_seed`.
- `spinner.yaml`: the stack spec. The "repo" is the Spinner checkout itself (`path: ../..`),
  so `spinner new` makes a worktree of this repo on the session branch and the two services
  run from `examples/sample-stack/{api,web}` inside it.
- `api/Dockerfile.dev`: `node:24-alpine` and nothing else; both services use it.

## Run it

```bash
pnpm -r build
export SPINNER_HOME=$(mktemp -d)                      # or leave it at ~/.spinner
node packages/cli/dist/main.js new --project examples/sample-stack "try it"
node packages/cli/dist/main.js seed rebuild s001      # once per machine; starts spinner-postgres
node packages/cli/dist/main.js up s001                # prints the URLs and the elapsed time
curl -H 'Host: api.s001.localhost' http://127.0.0.1/items
open http://web.s001.localhost                        # browsers resolve *.localhost
node packages/cli/dist/main.js close s001             # containers, network, DB, worktree gone
node packages/cli/dist/main.js down --shared          # removes spinner-proxy and spinner-postgres
```

`curl` and Node do not resolve `*.localhost` on macOS; pass a `Host` header to `127.0.0.1`
instead. Chromium and Firefox resolve it without configuration.

The first `up` builds the dev image and installs the API's dependencies into the shared
volume. After that, `up` for a new session takes about 4 s on a laptop: clone the template
database, start three containers, wait for the healthchecks and for Traefik to publish the
routes. The 15 s target in docs/ARCHITECTURE.md is for warm images.

Note that `spinner new` creates the branch `feat/<slug>` in this checkout and `spinner close`
keeps it, as it does for any project. Delete it with `git branch -D feat/<slug>` when done.
