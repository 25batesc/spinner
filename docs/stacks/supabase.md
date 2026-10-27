# A local Supabase stack as the database

## Shape

`supabase start` runs about ten containers: Postgres (default port 54322), the API gateway (54321), auth, storage, realtime. The backend uses two of them: `DATABASE_URL` to Postgres, and `SUPABASE_URL` with a key for auth and storage. Often the team keeps auth and storage on a **cloud** project and only the database local; then the key belongs to the cloud project and must not be pointed at the local gateway (`403 Invalid Compact JWS`).

Spinner's choice: one Supabase stack stays up across sessions, one template database holds the seed, each session gets a clone. Auth and storage are shared. A full `supabase start` per session takes 30 to 90 s and about 1.5 GB; one shared database makes branch migrations and workers collide.

## Spec

```yaml
database:
  mode: template
  server: external                         # Spinner creates and drops databases; it never starts the server
  external: { host: 127.0.0.1, port: 54322, user: postgres, admin_user: supabase_admin }
  version: "17"
  template: acme_seed
  seed:
    migrate: bin/pull-dev-snapshot.sh --db-only --yes    # the team's own refresh of the local database
    after:                                 # SQL on the template after the copy
      - GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role
      - GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role
services:
  backend:
    env:
      DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:54322/${SESSION_DB}
      # no SUPABASE_URL here: the team's own value (cloud or local) stays
```

## What Spinner does

- `seed rebuild --copy-only` copies the local `postgres` database into the template. `CREATE DATABASE ... TEMPLATE` needs the source free of clients; Supabase's services never disconnect, and the `postgres` role cannot terminate their sessions. Then the copy goes through `pg_dump` to a file and `pg_restore`, **with privileges** and without ownership.
- `up` clones the template. When a Supabase service briefly holds the template, the clone fails with `permission denied to terminate process`; Spinner retries.
- `close` drops the clone. An interrupted drop leaves an *invalid* template that the `postgres` role cannot alter; Spinner clears `datistemplate` as `admin_user` and drops it.

## Facts that cost a day

1. **The `postgres` role is not a superuser** on a Supabase server. It cannot terminate other roles' sessions, cannot give objects to `supabase_admin`, cannot set some server settings. Restore errors of the kind `permission denied to set ...` are harmless.
2. **The application switches roles per request** (`SET LOCAL ROLE authenticated` plus JWT claims for row-level security). A clone without the grants to `anon`, `authenticated` and `service_role` answers `permission denied for table ...` on every query, with the owner and the connection role both correct. Keep privileges in the dump.
3. **A local snapshot can lack grants that the cloud has.** After the team's own reset-and-restore, 105 public tables had no SELECT for `authenticated` while the cloud had full grants. `seed.after` applies what the cloud has.
4. **Migrations live in the repo, data in the dump.** The local database is as current as the last refresh; a worktree on a newer base queries columns the clone does not have (`UndefinedColumnError`). Refresh the local database and the template when the base moves.
5. **Databases are gigabytes.** A dump through a pipe hits the output cap; write it to a file.
