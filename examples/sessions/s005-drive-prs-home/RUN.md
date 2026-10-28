# Running s005

The pattern is the same as s002, run as pi subagents from one parent session at the repo root. The live session lives under `~/.spinner/sessions/`; the `.spinner` symlink at the repo root points at it. In the operator's home the id can differ from `s003`, because real sessions share the home. The directory name says which.

## Before you start

1. Run `pnpm -r build && pnpm -r test`. Both must be green.
2. Make sure Docker is running and `spinner-proxy` is up or absent. The agents use `examples/sample-stack` and a throwaway GitHub repo the operator owns.
3. Make sure `gh auth status` passes. The daemon's poller reads GitHub.

## Create the live session

```bash
cp -R ~/Spinner/examples/sessions/s005-drive-prs-home ~/.spinner/sessions/<id>-daemon-api-and-ui
cd ~/Spinner
ln -sfn ~/.spinner/sessions/<id>-daemon-api-and-ui .spinner
```

## Start the agents

1. Launch engine first. Wait for the Log line that Plan item 1 is committed.
2. Launch ext and ui.
3. Deliver `inbox/` messages with `steer` or `resume`. Count each delivery.
4. A child asks the operator through `contact_supervisor`. Answer in `MISSION.md`, then reply.

## While they run

1. Keep the live `MISSION.md` open.
2. Answer each item under *Open questions*. Then tell the agent: `answered in MISSION.md`.
3. At Plan item 8 the operator names the throwaway repo and confirms the Slack post. At item 9 the operator runs a real feature.
4. At the end, copy brief and mission improvements back into `examples/sessions/s005-drive-prs-home/`. Do not copy the Log.
