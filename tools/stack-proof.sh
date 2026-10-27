#!/usr/bin/env bash
# The cleanup proof for the stack runner, in one script, so an agent whose shell guard blocks
# parts of it by hand runs it as one call. It prints what a `spinner close` must leave
# behind nothing of: containers, session worktrees in every repo of the given specs, the
# session databases on each spec's server, and host-service processes. Exit code 1 when any
# of them remains, 0 when the proof holds.
#
# Usage: tools/stack-proof.sh <spec-or-project>...     with SPINNER_HOME set as for spinner
# Example: SPINNER_HOME=/tmp/spinner-home-X tools/stack-proof.sh examples/sample-stack knit
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
spinner="node $root/packages/cli/dist/main.js"
home="${SPINNER_HOME:-$HOME/.spinner}"
caller="$PWD"
remaining=0

echo "== sessions in $home"
$spinner show || true

echo "== docker ps -a --filter name=spinner"
containers="$(docker ps -a --filter name=spinner --format '{{.Names}} {{.Status}}')"
if [[ -n "$containers" ]]; then
    echo "$containers"
    # The shared proxy and Postgres may stay between sessions; session containers may not.
    if echo "$containers" | grep -qv '^spinner-proxy \|^spinner-postgres '; then
        remaining=1
    fi
else
    echo "(none)"
fi

echo "== docker network ls (spinner-*)"
docker network ls --format '{{.Name}}' | grep '^spinner-' && remaining=1 || echo "(none)"

for project in "$@"; do
    echo "== spec $project"
    # One node call resolves the spec the way `spinner new --project` does and prints the
    # repo paths and the database server, one fact per line.
    facts="$(cd "$root/packages/cli" && node --input-type=module -e '
        import { find_spec, load_spec, resolve_home } from "@spinner/daemon";
        const home = resolve_home(process.env);
        const { spec } = load_spec(find_spec(process.argv[1], home, process.argv[2]));
        for (const repo of Object.values(spec.repos)) console.log(`repo ${repo.path}`);
        const database = spec.database ?? {};
        if (database.server === "external") {
            const { host, port, user } = database.external;
            console.log(`db external ${host} ${port} ${user}`);
        } else {
            console.log("db managed");
        }
    ' "$project" "$caller" 2>&1)" || { echo "$facts"; exit 2; }
    while read -r kind rest; do
        case "$kind" in
            repo)
                echo "-- git worktree list in $rest"
                list="$(git -C "$rest" worktree list)"
                echo "$list"
                if echo "$list" | grep -q "$home/sessions/"; then
                    remaining=1
                fi
                ;;
            db)
                read -r mode host port user <<<"$rest"
                if [[ "$mode" == managed ]]; then
                    if docker inspect spinner-postgres >/dev/null 2>&1; then
                        echo "-- databases on spinner-postgres"
                        databases="$(docker exec spinner-postgres psql -U postgres -At \
                            -c "select datname from pg_database where datname like 'spinner_%'")"
                    else
                        echo "-- spinner-postgres is not running (no session database can be open)"
                        databases=""
                    fi
                else
                    echo "-- databases on $user@$host:$port"
                    databases="$(PGPASSWORD="${PGPASSWORD:-$user}" psql -h "$host" -p "$port" -U "$user" -At \
                        -c "select datname from pg_database where datname like 'spinner_%'")"
                fi
                if [[ -n "$databases" ]]; then
                    echo "$databases"
                    remaining=1
                else
                    echo "(no spinner_* database)"
                fi
                ;;
        esac
    done <<<"$facts"
done

echo "== host-service processes (commands under $home)"
pids="$(pgrep -fl "$home/" || true)"
if [[ -n "$pids" ]]; then
    echo "$pids"
    remaining=1
else
    echo "(none)"
fi

if [[ "$remaining" -eq 0 ]]; then
    echo "PROOF OK: nothing of a session remains"
else
    echo "PROOF FAILED: something listed above remains"
fi
exit "$remaining"
