#!/bin/sh
# Tags the current commit as a release and pushes the tag.
# Usage: tools/release.sh v0.2.0 "one line on what this release holds"
# The tree must be clean and CI green on the commit. Every package.json takes the version,
# so `spinner --version`, the daemon's /health and the .app agree with the tag.
set -eu
version="${1:?usage: tools/release.sh vX.Y.Z \"summary\"}"
summary="${2:?usage: tools/release.sh vX.Y.Z \"summary\"}"
case "$version" in v[0-9]*.[0-9]*.[0-9]*) ;; *) echo "version must look like v0.2.0" >&2; exit 1 ;; esac
if [ -n "$(git status --porcelain)" ]; then echo "the tree is not clean" >&2; exit 1; fi
bare="${version#v}"
for file in package.json packages/*/package.json; do
    node -e '
const fs = require("fs"); const [file, version] = process.argv.slice(1);
const pkg = JSON.parse(fs.readFileSync(file, "utf8")); pkg.version = version;
fs.writeFileSync(file, JSON.stringify(pkg, null, 4) + "\n");
' "$file" "$bare"
done
git add package.json packages/*/package.json
git commit -q -m "Release $version

$summary"
git tag -a "$version" -m "$version: $summary"
git push && git push origin "$version"
echo "released $version at $(git rev-parse --short HEAD)"
