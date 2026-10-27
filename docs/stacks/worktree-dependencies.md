# Worktrees: dependencies, local files, and the base branch

A worktree is a fresh checkout of the branch. It has no `node_modules`, no `.venv`, no untracked `.npmrc` or `.env.local`, and it starts from whatever base Spinner picks. Each of those bit once.

## Base branch

`spinner new` fetches `origin/<base>` and branches from it. The operator's local base branch can be months behind (482 commits, once), and a worktree from it imports packages the current base retired. The local branch is left alone.

## Untracked local files

```yaml
repos:
  web:
    path: ~/code/acme-web
    base: dev
    seed_files: [app/.npmrc, app/envs/.env.local]   # copied from the primary checkout when untracked there
```

Registry tokens in `.npmrc`, local overrides in `.env.local`: the primary checkout has them, git does not. `seed_files` copies them into the new worktree. The copy carries whatever the operator keeps there, including tokens; the files are gitignored in the repo and stay in the session directory.

## Installed dependencies

```yaml
repos:
  backend:
    seed_links: [apps/api/.venv]        # link the primary checkout's install when its lockfile matches
services:
  web:
    install: npm install --legacy-peer-deps   # otherwise install in the worktree with the team's command
```

Rules:

1. `seed_links` links the primary checkout's install into the worktree, as the team's own worktree tools do. It is right only when the worktree's lockfile hash equals the primary's; otherwise the link lacks packages the branch added. Spinner compares the hashes and runs `install:` instead when they differ.
2. The primary checkout's install can itself drift from its lockfile. The team usually has a check (`make venv-check`, `npm ls`); run its fix before a session, and let `preflight` catch what remains (`import api`, `test -d node_modules/<package>`).
3. Install from the files the team installs from. One project kept a `uv.lock` nobody used; the real pins were a `requirements-ci.txt`. A venv built from the stale lock failed at import with a confusing version mismatch.
4. The file watcher of a dev server restarts on every file an install writes. Install before the service starts, never under it.
5. A native binding that the team built by hand (a `vendor/<platform>-<abi>` directory with no working prebuilt upstream) does not come back from a fresh install. Add that directory to `seed_files`; the symptom is every stylesheet failing to build and a blank page.
