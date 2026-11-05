# Stack spec (`spinner.yaml`)

A project tells Spinner what its stack is with one file. Spinner renders it, per session, into `stack/compose.yaml` and `stack/.env`. The format is generic: any set of repos and services that Docker Compose can run. Nothing in Spinner knows about a specific company's repos.

## Where the file lives

Spinner looks for the spec in this order:

1. `--project <path-or-name>` on the command line.
2. `spinner.yaml` at the root of the current repo (a monorepo commits it and shares it with the team).
3. `local/<name>/spinner.yaml` inside a Spinner checkout (gitignored; for private multi-repo setups).
4. `~/.spinner/projects/<name>/spinner.yaml` (private, outside any repo).

A multi-repo project (several repos, one app) uses option 3 or 4, because the spec spans repos and should not live in one of them. Everything under `local/` and `~/.spinner/` stays on your machine.

Everything marked `# TODO` below is a placeholder for the real command, port or path.

## Example: a multi-repo project

The fictional *acme* project has an API, an admin app and a customer web app in three repos, plus Postgres and a Temporal dev server.

```yaml
name: acme
base: main                                   # the branch PRs land in

repos:
  backend:
    path: ~/code/acme-backend
    base: develop                            # optional: overrides the top-level base for this repo
  admin:
    path: ~/code/acme-admin
  web:
    path: ~/code/acme-web

services:
  backend:
    repo: backend
    image: spinner/acme-backend-dev          # built once from repos.backend/Dockerfile.dev
    runtime: node                            # node (default) | python; picks the dev image base and deps volume kind
    wrapper: bin/doppler-run.sh acme         # optional: prefix for `command`, run from the worktree (secrets injection)
    workdir: .                               # optional: directory inside the worktree where `command` runs
    command: pnpm dev                        # TODO
    port: 3000                               # the port the dev server listens on
    host: api                                # → api.<session>.localhost
    env:
      DATABASE_URL: postgres://postgres:postgres@postgres:5432/${SESSION_DB}
      TEMPORAL_ADDRESS: temporal:7233
      PUBLIC_URL: http://api.${SESSION_ID}.localhost
    healthcheck: GET /health
    depends_on: [postgres, temporal]
    deps_volume: pnpm-store                  # named volume keyed by lockfile hash

  worker:                                    # a second process from the same repo
    repo: backend
    image: spinner/acme-backend-dev
    command: pnpm worker
    env:
      DATABASE_URL: postgres://postgres:postgres@postgres:5432/${SESSION_DB}
      TEMPORAL_ADDRESS: temporal:7233
    depends_on: [temporal]

  admin:
    repo: admin
    image: spinner/acme-admin-dev
    command: pnpm dev --host
    port: 5173
    host: admin
    env:
      VITE_API_URL: http://api.${SESSION_ID}.localhost
    depends_on: [backend]

  web:
    repo: web
    image: spinner/acme-web-dev
    command: pnpm dev --host
    port: 5173
    host: web
    env:
      VITE_API_URL: http://api.${SESSION_ID}.localhost
    depends_on: [backend]

  temporal:
    image: temporalio/temporal:1.3.0         # pin a version
    command: server start-dev --ip 0.0.0.0 --db-filename /data/temporal.db
    port: 8233                               # Temporal web UI
    host: temporal                           # → temporal.<session>.localhost
    volumes: [temporal-data:/data]

database:
  mode: template                             # template | per-session
  server: spinner-postgres                   # shared container, started once by spinnerd; or `external`
  # external: { host: 127.0.0.1, port: 54322, user: postgres }   # a server Spinner does not manage
  version: "16"
  template: acme_seed
  seed:
    migrate: cd backend && pnpm migrate      # run inside the backend image
    fixtures: cd backend && pnpm seed        # or restore a scrubbed dump
    # dump: ~/dumps/acme-scrubbed.sql.gz

proxy:
  http_port: 80                              # Traefik; falls back to 8080 if 80 is taken
  strip_frame_headers: [temporal]            # services to embed that send X-Frame-Options

harness:
  default: pi                                # the harness new agents use; pi in v1
  pi:
    trust_projects: true                     # pass --approve so project .pi/ skills and extensions load

pipeline: {}                                 # see ARCHITECTURE → Pipeline tracker. Empty = plain GitHub.

designs:                                     # where a session's EGM design doc lives (optional)
  repo: backend                              # a key of repos; default: the first repo
  dir: docs/designs                          # relative to that repo; default: docs/designs
```

A monorepo needs one entry under `repos` and `path: .`. A single-service project needs one service and no `proxy` changes.

## Semantics

**Repos.** Each entry becomes a git worktree per session at `worktrees/<name>` on the session branch. A repo with no commits ahead of its base at `spinner pr` time gets no PR. The base is `repos.<name>.base` when set, otherwise the top-level `base`; worktrees start from it, PRs target it, and the pipeline watches merges into it.

**Services.** Each becomes a compose service in project `spinner-<id>`. If `repo` is set, the worktree is bind-mounted at `/app` and `command` runs there (in `workdir` when set), so edits hot-reload. `runtime: python` selects a Python dev image base and a `venv` dependency volume instead of a package-manager store; the lockfile hash that keys the volume comes from `uv.lock`, `poetry.lock` or `requirements*.txt`. `wrapper` is a command prefix that runs every `command` of that service, for a secrets injector such as Doppler; Spinner never reads or stores the secrets it injects. `spinner build` builds `image` from the repo's dev Dockerfile and caches it; it rebuilds when the Dockerfile or lockfile changes. `port` + `host` produce Traefik labels (`Host(\`<host>.<id>.localhost\`)`); services without `host` are internal only. `healthcheck` gates the preview panes and the `up` command's exit. `preview: top-level` marks a service whose app needs its own top-level page, for example one with a `SameSite=Lax` login cookie: the desktop app shows it in a `WebContentsView`, and the browser UI keeps the iframe but says to open it in a tab. The default, `frame`, is an iframe in both.

**Variables available in `env`.** `${SESSION_ID}` (e.g. `s17`), `${SESSION_DB}` (`spinner_s17`), `${SESSION_BRANCH}`, `${SESSION_DIR}`, plus anything in the host environment allow-listed under a `pass_env:` key (API keys for third-party services the backend needs).

**No database.** A spec without a `database` block has no database: `up` starts no Postgres container, clones no template and joins none to the session network; `close` and `reset` drop nothing; `${SESSION_DB}` still names `spinner_<id>` and nothing uses it. This is the shape of a project whose checks are its own tests, such as Spinner itself.

**Database, `template` mode.** `spinnerd` keeps one Postgres container alive, or, with `server: external`, connects to a server it does not manage (for example the Postgres inside a local Supabase stack). With an external server Spinner only creates and drops databases there; `spinner doctor` checks that the server answers and refuses `up` otherwise. Services that use the server's other APIs (auth, storage) keep sharing them across sessions; only the database is per session. `spinner seed rebuild` creates the template database from scratch (migrations, then fixtures or a dump) and marks it as a template. `spinner up` clones it into the session's database; `spinner db reseed <session>   # planned; today: close and new` drops and re-clones; `spinner close` drops it. Cloning is a file copy inside Postgres, so a few hundred MB takes a couple of seconds. The daemon prompts for a rebuild when the migration directory hash changes on `base`.

**Database, `per-session` mode.** A `postgres` service is added to the session's compose project from a prebuilt image whose data directory already contains the seed (`spinner seed rebuild` builds that image). Slower to start, fully isolated, lets a branch run a different Postgres version.

**The diff viewer.** Not a service, and never in this file. The daemon runs `diffview` per repo
of a session as a host process of the session (`session.yaml` `diff.repos`). The UI's diff tab
starts it; `down` and `close` stop it. A spec that names it has an unknown service.
See [ARCHITECTURE.md](ARCHITECTURE.md#the-diff-tab-packagesdaemonsrcdiff).

**Temporal.** Optional, like any other service. When present, it runs per session, so workflow tasks never cross branches, and its UI gets a preview pane.

**Proxy.** One Traefik container with the Docker provider, started by the daemon on first `up`. Labels on each service do the routing. `strip_frame_headers` adds a response-header middleware that removes `X-Frame-Options` and the `frame-ancestors` CSP directive so the web UI can embed the service.

**Harness.** Which agent harness new agents use, and harness-specific options. For pi, `trust_projects: true` passes `--approve`, so the repo's `.pi/` skills, extensions and settings load. Your user-level pi configuration (`~/.pi/agent`: skills, extensions, `AGENTS.md`) always loads, because Spinner runs pi with your agent directory.

**Pipeline.** Settings for the pipeline tracker: review-bot logins, the approval check and policy, merge-queue kind, Slack. See [ARCHITECTURE.md](ARCHITECTURE.md#pipeline-tracker-packagesdaemonsrcpipeline). An empty block means a plain GitHub repo: PR open → checks → reviews → merged, with no bot stage and no Slack.

**Designs.** Where the design doc of a design-track session lives ([designs/egm-adoption.md](designs/egm-adoption.md), D3). `repo` is a key of `repos` and defaults to the first repo. `dir` is relative to that repo and defaults to `docs/designs`. The lead's `design_doc` tool accepts only a `.md` file directly in that directory of the repo's worktree. `spinner.yaml` is refused when `designs` is not a mapping, when a key is not a non-empty string, or when `repo` is not a key of `repos`.

## Commands this drives

```
spinner build                 # build/refresh dev images for all services with a repo
spinner seed rebuild          # rebuild the template DB (or seed image)
spinner up <session>          # clone DB, compose up -d, wait for healthchecks, print URLs
spinner down <session>        # compose stop (volumes kept)
spinner logs <session> [svc]  # compose logs -f
spinner exec <session> <svc> -- <cmd>
spinner db reseed <session>   # planned; today: close and new
spinner close <session>       # compose down -v, drop DB, remove worktrees
```

## Recipes

Stacks that need more than the defaults are described by shape under [stacks/](stacks/README.md): a service on the host, a secrets injector, Supabase, a webpack dev server, cloud APIs with fixed origins, worktree dependencies.

## What to find out about your repos before M1

- Dev commands and ports for each app, and whether the frontends read the API URL at runtime or at build time.
- How the backend runs migrations and whether a fixture or seed script exists, or whether a scrubbed dump is the practical seed.
- Whether background workers are separate processes.
- Any other service the backend expects locally (Redis, object storage, mail catcher).
- Node version and package manager per repo, for the dev images.
