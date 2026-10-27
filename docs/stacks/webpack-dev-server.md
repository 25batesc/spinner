# A webpack dev server behind the proxy

## Symptoms

- `WebSocket connection to 'ws://web.s1.localhost:3001/ws' failed`: the hot-reload client connects to the dev server's own port, not to the page's port (80 through the proxy). The app works; edits do not reload.
- `GET http://localhost:46595/lazy-compilation-using-... ERR_CONNECTION_REFUSED`, then the app's error boundary ("Something went wrong"): lazy compilation serves modules from a random loopback port that the browser can reach only when the dev server runs on the host.
- `JavaScript heap out of memory`, or exit 137 after raising the heap: a full build does not fit in the Docker VM.
- `npm ci` fails with `ERESOLVE`: the team installs with `--legacy-peer-deps`.

## Spec

```yaml
services:
  web:
    repo: web
    runtime: host                        # memory and lazy compilation both want the host
    workdir: app
    install: npm install --legacy-peer-deps
    command: npm run start:local -- --port $PORT --client-web-socket-url auto://0.0.0.0:0/ws
    preflight: test -d node_modules/webpack-dev-server
    host: web
    healthcheck: GET /                   # passes after the first compile
    env_file: app/envs/.env.local        # the app reads env at build time from this file
    env:
      REACT_APP_API_URL: http://api.${SESSION_ID}.localhost/api/v1
```

## Rules

1. `--client-web-socket-url auto://0.0.0.0:0/ws` makes the hot-reload client use the page's protocol, host and port. Port 0 means "the page's port".
2. `--port $PORT` gives each session its own dev server port; the config's fixed port would collide on the second session.
3. A dev server that reads env at build time (`dotenv-webpack` reading `envs/.env.<env>`) ignores the process environment. `env_file` names the file; Spinner writes the service's `env` into it before each start and removes keys it wrote earlier that are no longer in `env`.
4. Lazy compilation on the host is fine: the browser and the dev server share `localhost`.
5. If the service must stay in a container, give the Docker VM more memory than the build needs, set `NODE_OPTIONS=--max-old-space-size=<MB>`, and turn lazy compilation off. Expect a long first compile.
