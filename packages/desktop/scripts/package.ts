// Builds the local, unsigned `Spinner.app` with @electron/packager into `dist-app/`. Run
// after `pnpm build`. The app needs the checkout to start a daemon (`spinner daemon start`
// runs the CLI's `dist/main.js`), so the checkout's absolute path is written to
// `dist/repo.json` and baked in; `SPINNER_REPO` overrides it at run time. No signing and no
// notarization in M4 (MISSION Contracts).
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";

const package_root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo_root = resolve(package_root, "..", "..");
const dist = join(package_root, "dist");
const out = join(package_root, "dist-app");

if (!existsSync(join(dist, "main.js"))) {
    throw new Error("dist/main.js is missing: run pnpm build first");
}
writeFileSync(join(dist, "repo.json"), `${JSON.stringify({ root: repo_root })}\n`);

/**
 * Only `dist/`, `package.json` and the protocol package go in. Dev dependencies, sources,
 * tests and the protocol's own dev dependencies stay out; `prune` is off because pnpm's
 * symlinked layout confuses the packager's own module walk.
 */
const KEEP = ["/dist", "/package.json", "/node_modules/@spinner/protocol"];
const DROP = ["/node_modules/@spinner/protocol/node_modules"];

/** `path` is kept when it is one of `KEEP`, inside one, or a directory on the way to one. */
function keep(path: string): boolean {
    if (DROP.some((dropped) => path === dropped || path.startsWith(`${dropped}/`))) {
        return false;
    }
    return KEEP.some(
        (kept) => path === kept || path.startsWith(`${kept}/`) || kept.startsWith(`${path}/`),
    );
}

const paths = await packager({
    dir: package_root,
    out,
    name: "Spinner",
    executableName: "Spinner",
    appBundleId: "dev.spinner.desktop",
    platform: "darwin",
    arch: process.arch === "arm64" ? "arm64" : "x64",
    overwrite: true,
    prune: false,
    derefSymlinks: true,
    asar: true,
    ignore: (path: string) => path !== "" && !keep(path),
});
console.log(`packaged ${paths.join(", ")}`);
