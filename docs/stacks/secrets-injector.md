# Commands under a secrets injector

## Symptom

- The backend connects to the shared database, not to the session's clone, although `DATABASE_URL` is in the spec.
- A worker fails with `socket.gaierror` on a hostname that is not in the spec.
- In a container: `Doppler not authenticated` or an equivalent login error.

## Cause

The team starts services through an injector (`doppler run -- <cmd>`, `op run -- <cmd>`). The injector sets its values **after** the environment it inherits, so its `DATABASE_URL`, `TEMPORAL_HOST` or `PORT` wins over Spinner's. Inside a container the injector has no login.

## Spec

```yaml
services:
  backend:
    runtime: host                        # the injector's login lives on the host
    wrapper: bin/with-secrets.sh acme    # run from the worktree, in front of `command`
    command: .venv/bin/python main.py
    env:
      DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:54322/${SESSION_DB}
      PORT: "${PORT}"
```

What Spinner does with it: it runs `<wrapper> env K=V ... sh -c '<command>'`. The session's values are applied **inside** the wrapper, after the injector, so they win. The injector's own values stay for everything the spec does not name.

## Rules

1. Do not pass the injector's token through `pass_env` or a file. The host login is the credential; a container cannot have it, so the service runs on the host.
2. Every address the service reaches must be in the spec's `env` when the injector's value points at the team's shared setup. Spinner prints the first hostname a host service cannot resolve and the variable that holds it; add that variable to `env`.
3. If the wrapper itself takes `--`, do not add a second one; Spinner's `env` call sits where the wrapper puts the command.
