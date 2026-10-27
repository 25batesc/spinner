// Goal: `seed_links` links a directory only when the lockfile next to it is the same in the
// primary checkout and the worktree; a changed lockfile means an install of its own.
// Method: two temporary trees with and without a lockfile difference.
import { lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolve_home } from "../home.js";
import { next_session_id } from "../store/session-store.js";
import { proxy_mount_of, session_numbers_of, shared_use_lines } from "./docker.js";
import { homes_in_route_files, session_numbers_in_route_files } from "./host-service.js";
import { link_seed_dirs } from "./runner.js";

describe("link_seed_dirs", () => {
    it("links when the lockfile matches and skips when it differs", () => {
        const root = mkdtempSync(join(tmpdir(), "spinner-links-"));
        const primary = join(root, "primary");
        const worktree = join(root, "worktree");
        for (const base of [primary, worktree]) {
            mkdirSync(join(base, "web"), { recursive: true });
            mkdirSync(join(base, "apps", "api"), { recursive: true });
            writeFileSync(join(base, "apps", "api", "requirements-ci.txt"), "litellm==1\n");
        }
        mkdirSync(join(primary, "web", "node_modules"));
        mkdirSync(join(primary, "apps", "api", ".venv"));
        writeFileSync(join(primary, "web", "package-lock.json"), '{"a":1}');
        writeFileSync(join(worktree, "web", "package-lock.json"), '{"a":1,"b":1}');

        const outcome = link_seed_dirs(primary, worktree, ["web/node_modules", "apps/api/.venv"]);
        expect(outcome.linked).toEqual(["apps/api/.venv"]);
        expect(outcome.skipped).toEqual([
            {
                dir: "web/node_modules",
                lockfile: "package-lock.json",
                cwd: join(worktree, "web"),
            },
        ]);
        expect(lstatSync(join(worktree, "apps", "api", ".venv")).isSymbolicLink()).toBe(true);
    });
});

describe("shared containers are machine-global", () => {
    it("lists every use that down --shared would break", () => {
        expect(shared_use_lines({ projects: [], route_files: [], live_pids: [] })).toEqual([]);
        const lines = shared_use_lines({
            projects: ["spinner-s016", "spinner-s017"],
            route_files: ["spinner-s016.yaml"],
            live_pids: ["s016-a/backend"],
        });
        expect(lines).toEqual([
            "stacks with containers: spinner-s016, spinner-s017",
            "route files in the proxy directory: spinner-s016.yaml",
            "host services alive: s016-a/backend",
        ]);
    });

    it("reads the directory a running proxy mounts, and none for an unlabelled one", () => {
        const config = "traefik:v3.6|-v|/tmp/one/proxy:/dynamic:ro|--log.level=WARN";
        expect(proxy_mount_of(config)).toBe("/tmp/one/proxy");
        expect(proxy_mount_of("")).toBeNull();
        expect(proxy_mount_of("traefik:v3.6|--log.level=WARN")).toBeNull();
        const projects = ["spinner-s016", "spinner-proxy", "spinner-s3"];
        expect(session_numbers_of(projects)).toEqual([16, 3]);
    });

    it("next_session_id counts the proxy directory's route files and the home's own", () => {
        const root = mkdtempSync(join(tmpdir(), "spinner-ids-"));
        const proxy = join(root, "proxy");
        mkdirSync(proxy);
        writeFileSync(join(proxy, "spinner-s042.yaml"), "# home: /elsewhere\nhttp: {}\n");
        writeFileSync(join(proxy, "notes.yaml"), "");
        const machine = resolve_home({
            SPINNER_HOME: join(root, "home"),
            SPINNER_PROXY_DIR: proxy,
            SPINNER_SESSION_IDS: "machine",
        });
        expect(machine.ids_scope).toBe("machine");
        expect(next_session_id(machine).slice(0, 4) >= "s043").toBe(true);
        expect(session_numbers_in_route_files(proxy)).toEqual([42]);
        expect(homes_in_route_files(proxy)).toEqual(["/elsewhere"]);
        const local = resolve_home({
            SPINNER_HOME: join(root, "home"),
            SPINNER_PROXY_DIR: proxy,
            SPINNER_SESSION_IDS: "home",
        });
        expect(next_session_id(local)).toBe("s001");
    });
});
