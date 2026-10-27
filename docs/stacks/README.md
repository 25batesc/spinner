# Stack recipes

A recipe describes one shape of stack that needs more than the default `spinner.yaml` and says which spec fields handle it. Each recipe came from a real stack. The names in the examples are the fictional *acme* project from [STACK_SPEC.md](../STACK_SPEC.md); the private values of a real project stay in that project's `local/<name>/` directory, which git ignores.

| Recipe | When you need it |
|---|---|
| [host-service.md](host-service.md) | A service cannot run in a container on your machine: a native dependency with no wheel for the container's architecture, a memory need larger than the Docker VM, or a dev server whose side channels only work on the host |
| [secrets-injector.md](secrets-injector.md) | Commands run under a secrets injector (Doppler, 1Password, Vault) that sets its own values over yours |
| [supabase.md](supabase.md) | The database is a local Supabase stack: an external Postgres you do not manage, row-level security, roles with grants, and a `postgres` role that is not a superuser |
| [webpack-dev-server.md](webpack-dev-server.md) | A webpack dev server behind the proxy: hot reload sockets, lazy compilation, and build memory |
| [cloud-apis.md](cloud-apis.md) | The frontend calls cloud services that allow only fixed origins: CORS lists and OAuth callback lists |
| [worktree-dependencies.md](worktree-dependencies.md) | Each worktree needs installed dependencies, untracked local files, and a base branch that is current |

The rules that every recipe follows:

1. Spinner's code knows no vendor. A recipe maps a shape to spec fields; the fields are generic.
2. Secrets never enter a file Spinner writes. The injector's own login on the host is the credential.
3. When a stack fact blocks a session, the agent records it and stops. The operator decides, and the fact becomes a recipe or a spec line, never a special case in code.
