# sample-stack

A tiny stack that anyone can run, used by the test suite and by newcomers: an API (Node, one endpoint), a web page that calls it, and Postgres with a seeded table. No secrets, no external services.

Planned contents (M1, Track B):

- `api/`: `GET /items` from Postgres, `GET /health`.
- `web/`: one page that lists the items and shows which session it runs in.
- `spinner.yaml`: the stack spec for the two services, Postgres in template mode, hostnames `api` and `web`.
- `seed.sql`: ten rows.

`spinner new --project examples/sample-stack "try it"` then `spinner up` must bring it to `http://web.s1.localhost` in under 15 seconds warm. That is the CI test for the stack runner.
