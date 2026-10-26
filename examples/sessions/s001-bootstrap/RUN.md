# Running s001 by hand

There is no daemon yet. You are the daemon. The live session lives under `~/.spinner/sessions/`, outside the repo, exactly where `spinner new` will put sessions later. The repo only holds this template. A `.spinner` symlink at the repo root points at the live session; it is gitignored.

## Create the live session

1. Copy the template out of the repo:

```bash
mkdir -p ~/.spinner/sessions
cp -R ~/Spinner/examples/sessions/s001-bootstrap ~/.spinner/sessions/s001-bootstrap
```

2. Link it into the repo root:

```bash
cd ~/Spinner
ln -sfn ~/.spinner/sessions/s001-bootstrap .spinner
```

3. Check that `git status` does not list `.spinner`. If it does, add `.spinner` to `.gitignore`.

## Start the agents

1. Open a terminal for the engine agent and run:

```bash
cd ~/Spinner
pi --session-dir ~/.spinner/sessions/s001-bootstrap/agents/engine/pi --session-id s001-engine --name engine \
   --append-system-prompt ~/.spinner/sessions/s001-bootstrap/agents/engine/BRIEF.md
```

2. Send the first prompt: `Read .spinner/MISSION.md, update your Roster row, and start on your first Plan item.`

3. Open a second terminal for the ui agent and run:

```bash
cd ~/Spinner
pi --session-dir ~/.spinner/sessions/s001-bootstrap/agents/ui/pi --session-id s001-ui --name ui \
   --append-system-prompt ~/.spinner/sessions/s001-bootstrap/agents/ui/BRIEF.md
```

4. Send the same first prompt.

5. To choose a model, add `--model <provider/id>` to either command. Record the model in the live `session.yaml`.

Your user-level pi skills, extensions and `AGENTS.md` load as usual, because pi reads them from `~/.pi/agent`.

## While they run

1. Keep `~/.spinner/sessions/s001-bootstrap/MISSION.md` open.
2. Answer each item under *Open questions* in the file. Then tell the agent: `answered in MISSION.md`.
3. When one agent adds a Contract, tell the other agent to re-read the file.
4. Count how often you do step 3. That count is the backlog for M2.
5. At the end, tick Plan item 8 yourself.
6. Write the *Lessons from s001* section in `docs/SESSION_PROTOCOL.md`.
7. Copy any brief or mission improvements back into `examples/sessions/s001-bootstrap/`. Do not copy the Log or the transcripts.

## Resume later

1. Run the same command again. `--session-id` opens the session if it exists and creates it if not.
2. To branch an experiment, run `pi --fork s001-engine --session-dir ~/.spinner/sessions/s001-bootstrap/agents/engine/pi`.
