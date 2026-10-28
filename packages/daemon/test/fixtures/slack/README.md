# Slack fixture

The daemon uses this directory when `SLACK_USER_TOKEN` is unset. `spinner post` then writes
the composed message to `<session>/artifacts/slack-post.json` instead of calling Slack, and
the activity poll reads `replies.json` here as the replies and reactions under that post.
The user ids and texts are invented.
