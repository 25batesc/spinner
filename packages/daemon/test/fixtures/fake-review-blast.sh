#!/bin/sh
# A stand-in for the operator's `review-blast` script (MISSION.md s014, Plan item 10): prints
# its arguments and its working directory to stdout, one line to stderr, then exits with
# FAKE_REVIEW_EXIT (0 by default). FAKE_REVIEW_SLEEP (seconds) holds it, so a test can see a
# running review and the timeout.
echo "review-blast args: $*"
echo "cwd: $(pwd)"
echo "a warning" >&2
if [ -n "${FAKE_REVIEW_SLEEP:-}" ]; then
    sleep "$FAKE_REVIEW_SLEEP"
fi
echo "done"
exit "${FAKE_REVIEW_EXIT:-0}"
