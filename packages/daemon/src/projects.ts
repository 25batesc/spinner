// `GET /projects`: every `spinner.yaml` the daemon can offer the new-session form, from the
// same places `find_spec` looks (`<home>/projects/<name>`, `local/<name>` in this checkout)
// plus `examples/<name>` for the sample stack. A spec that does not load is reported on the
// log and skipped, so one broken file does not hide the others.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectView } from "@spinner/protocol";
import type { SpinnerHome } from "./home.js";
import { SPEC_FILE, load_spec } from "./stack/spec.js";

/** Upper bound on project directories scanned per source. */
const PROJECT_DIRS_MAX = 200;

/** This file is `packages/daemon/{src,dist}/projects.{ts,js}`; three levels up is the checkout. */
function checkout_root(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function list_projects(home: SpinnerHome, log: (line: string) => void): ProjectView[] {
    const root = checkout_root();
    const sources: { source: ProjectView["source"]; dir: string }[] = [
        { source: "home", dir: join(home.root, "projects") },
        { source: "local", dir: join(root, "local") },
        { source: "examples", dir: join(root, "examples") },
    ];
    const projects: ProjectView[] = [];
    for (const { source, dir } of sources) {
        for (const path of spec_files_in(dir)) {
            try {
                const { spec } = load_spec(path);
                projects.push({
                    name: spec.name,
                    path,
                    source,
                    repos: Object.keys(spec.repos),
                    services: Object.keys(spec.services),
                });
            } catch (error) {
                log(`projects: skipped ${path}: ${describe(error)}`);
            }
        }
    }
    return projects;
}

function spec_files_in(dir: string): string[] {
    if (!existsSync(dir)) {
        return [];
    }
    const entries = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .slice(0, PROJECT_DIRS_MAX);
    return entries
        .map((name) => join(dir, name, SPEC_FILE))
        .filter((path) => existsSync(path));
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
