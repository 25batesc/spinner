# Running s002 by hand

Start after s001 has landed the skeleton. The pattern is the same as s001. The live session lives under `~/.spinner/sessions/`. The repo only holds this template. The `.spinner` symlink at the repo root points at the live session.

## Before you start

1. Run `gh auth status`. It must report a logged-in user.
2. Pick one real PR of yours that has review-bot comments.
3. Save the `gh api graphql` output for it: checks, review threads, approvals, merge-queue entry.
4. Scrub anything sensitive from that output.
5. Put the file under `packages/daemon/test/fixtures/github/`. The board agent builds on it.
6. Fill your private stack spec in `local/<project>/spinner.yaml` (gitignored). Or tell the stack agent to use `examples/sample-stack` first.

## Create the live session

```bash
cp -R ~/Spinner/examples/sessions/s002-board-and-stack ~/.spinner/sessions/s002-board-and-stack
cd ~/Spinner
ln -sfn ~/.spinner/sessions/s002-board-and-stack .spinner
```

## Start the agents

1. Open a terminal for the board agent and run:

```bash
cd ~/Spinner
pi --session-dir ~/.spinner/sessions/s002-board-and-stack/agents/board/pi --session-id s002-board --name board \
   --append-system-prompt ~/.spinner/sessions/s002-board-and-stack/agents/board/BRIEF.md
```

2. Send the first prompt: `Read .spinner/MISSION.md, update your Roster row, and start on Plan item 1.`

3. Open a second terminal for the stack agent and run:

```bash
cd ~/Spinner
pi --session-dir ~/.spinner/sessions/s002-board-and-stack/agents/stack/pi --session-id s002-stack --name stack \
   --append-system-prompt ~/.spinner/sessions/s002-board-and-stack/agents/stack/BRIEF.md
```

4. Send the first prompt: `Read .spinner/MISSION.md, update your Roster row, and start on Plan item 5.`

## While they run

1. Keep the live `MISSION.md` open.
2. Answer each item under *Open questions* in the file. Then tell the agent: `answered in MISSION.md`.
3. When one agent adds a Contract, tell the other agent to re-read the file.
4. Count how often you do step 3.
5. At the end, copy brief and mission improvements back into `examples/sessions/s002-board-and-stack/`. Do not copy the Log or the transcripts.
