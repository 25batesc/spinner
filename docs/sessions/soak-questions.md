# Soak questions, M1 to M2

The operator uses Spinner on real work between the M1 exit (2026-10-27) and the start of M2. Every friction goes here as one line: what happened, what the operator expected, and the smallest change that would fix it. The M2 plan starts from this list.

| Date | What happened | Expected | Smallest fix |
|---|---|---|---|
| 2026-10-27 | After a merge-queue pop-out the board showed `fixing` with an empty `needs you` | the line says why: "popped out of the queue (manual); 1 bot thread open" | `needs_human` carries the pop-out reason for one poll (STATUS finding 21) |
