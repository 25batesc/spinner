# A service on the host

## Symptom

One of these:

- The dev image does not build: a Python or native dependency has no wheel for the container's architecture (`linux/arm64` on Apple silicon).
- The container dies with exit 137 or `JavaScript heap out of memory`: a full frontend build needs more than the Docker VM has.
- The page loads but modules fail with `ERR_CONNECTION_REFUSED` on `localhost:<random port>`: the dev server opens a side channel on the host loopback that the browser cannot reach from a container.

## Cause

The team runs that service on the host, with the host's toolchain and memory. A container changes the architecture, the memory ceiling and the network.

## Spec

```yaml
services:
  backend:
    repo: backend
    runtime: host                      # no container; Spinner runs the command on the host
    workdir: apps/api                  # inside the worktree
    wrapper: bin/with-secrets.sh acme  # optional; see secrets-injector.md
    command: .venv/bin/python main.py
    preflight: .venv/bin/python -c "import api"   # must exit 0 before the process starts
    host: api                          # → api.<id>.localhost, routed to the host port
    healthcheck: GET /health/ready
    env:
      PORT: "${PORT}"                  # the per-session port Spinner assigns
      DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:54322/${SESSION_DB}
      TEMPORAL_HOST: 127.0.0.1:${TEMPORAL_7233_HOST_PORT}
```

What Spinner does with it:

- Starts the process detached, in its own process group, with stdout and stderr on `<session>/log/<service>.log`, and records the pid, the group and the port under `stack.processes` in `session.yaml`.
- Routes `<host>.<id>.localhost` through the proxy to `host.docker.internal:<port>`.
- Runs `preflight` first with the same working directory, wrapper and environment. A non-zero exit fails `up` at once with the last 20 lines.
- Treats a process that is alive while its log shows a traceback or a startup failure, and its port stays silent, as a failed start. A reloader keeps its parent alive after a failed import; the log is the signal.
- Stops the whole process group at `down` and `close`, then sweeps strays by working directory.

## Rules

1. Name in `preflight` the module the server imports, not the launcher. `import main` passes while `main.py` only starts uvicorn, which imports `api` in a child.
2. Give every listener a per-session port. A fixed port in the app (a health server on 8080) collides on the second session; pass `${PORT}` or a second port through `env`.
3. Host-side addresses only. A host service reaches containers through published ports on `127.0.0.1`, never through compose service names.
4. A dev server that compiles on the fly also needs its client to use the page's port; see webpack-dev-server.md.
