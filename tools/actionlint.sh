#!/usr/bin/env bash
# Lints .github/workflows before a push. GitHub reports a bad workflow file as a run with no
# jobs and no logs, so the check has to happen here. Needs Docker.
set -euo pipefail
cd "$(dirname "$0")/.."
docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest "$@"
