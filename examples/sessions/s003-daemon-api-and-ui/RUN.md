# Running s003

The pattern is the same as s002, run as pi subagents from one parent session at the repo root. The live session lives under `~/.spinner/sessions/`; the `.spinner` symlink at the repo root points at it. In the operator's home the id can differ from `s003`, because real sessions share the home. The directory name says which.

## Before you start

1. Run `pnpm -r build && pnpm -r test`. Both must be green.
2. Make sure Docker is running and `spinner-proxy` is up or absent. The ui agent brings up `examples/sample-stack` through the daemon.
3. Make sure `gh auth status` passes. The daemon's poller reads GitHub.

## Create the live session

```bash
cp -R ~/Spinner/examples/sessions/s003-daemon-api-and-ui ~/.spinner/sessions/<id>-daemon-api-and-ui
cd ~/Spinner
ln -sfn ~/.spinner/sessions/<id>-daemon-api-and-ui .spinner
```

## Start the agents

1. Launch engine first. Wait for the Log line that Plan item 1 is committed.
2. Launch ui.
3. Deliver `inbox/` messages with `steer` or `resume`. Count each delivery.
4. A child asks the operator through `contact_supervisor`. Answer in `MISSION.md`, then reply.

## While they run

1. Keep the live `MISSION.md` open.
2. Answer each item under *Open questions*. Then tell the agent: `answered in MISSION.md`.
3. At Plan item 7 and item 10, the operator does the browser steps the agents cannot (login).
4. At the end, copy brief and mission improvements back into `examples/sessions/s003-daemon-api-and-ui/`. Do not copy the Log.
