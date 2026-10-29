// Goal: `seed_links` links a directory only when the lockfile next to it is the same in the
// primary checkout and the worktree; a changed lockfile means an install of its own.
// Method: two temporary trees with and without a lockfile difference.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolve_home } from "../home.js";
import { next_session_id } from "../store/session-store.js";
import {
    postgres_version_conflict,
    proxy_mount_of,
    session_numbers_of,
    shared_use_lines,
} from "./docker.js";
import { homes_in_route_files, session_numbers_in_route_files } from "./host-service.js";
import { copy_seed_files, link_seed_dirs } from "./runner.js";

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
        expect(outcome.present).toEqual([]);
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

describe("copy_seed_files", () => {
    it("copies a file once and a directory whole", () => {
        const root = mkdtempSync(join(tmpdir(), "spinner-seed-"));
        const primary = join(root, "primary");
        const worktree = join(root, "worktree");
        mkdirSync(join(primary, "vendor", "darwin-arm64"), { recursive: true });
        mkdirSync(worktree);
        writeFileSync(join(primary, ".env"), "TOKEN=x\n");
        writeFileSync(join(primary, "vendor", "darwin-arm64", "binding.node"), "bin");

        const entries = [".env", "vendor/darwin-arm64", "missing"];
        const first = copy_seed_files(primary, worktree, entries);
        expect(first).toEqual([".env", "vendor/darwin-arm64"]);
        expect(existsSync(join(worktree, "vendor", "darwin-arm64", "binding.node"))).toBe(true);
        const second = copy_seed_files(primary, worktree, [".env", "vendor/darwin-arm64"]);
        expect(second).toEqual(["vendor/darwin-arm64"]);
    });

    it("reports a path the worktree already has and skips a copy into a linked directory", () => {
        const root = mkdtempSync(join(tmpdir(), "spinner-seed-"));
        const primary = join(root, "primary");
        const worktree = join(root, "worktree");
        mkdirSync(join(primary, "node_modules", "sass", "vendor"), { recursive: true });
        writeFileSync(join(primary, "node_modules", "sass", "vendor", "binding.node"), "bin");
        mkdirSync(worktree);

        const links = link_seed_dirs(primary, worktree, ["node_modules"]);
        expect(links.linked).toEqual(["node_modules"]);
        const again = link_seed_dirs(primary, worktree, ["node_modules"]);
        expect(again.present).toEqual(["node_modules"]);
        const copied = copy_seed_files(primary, worktree, ["node_modules/sass/vendor"]);
        expect(copied).toEqual([]);
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

    it("refuses to recreate a running Postgres for another major version", () => {
        const running = { state: "running" as const, image: "postgres:16", config: "" };
        expect(postgres_version_conflict(running, "16")).toBeNull();
        expect(postgres_version_conflict(running, "17")).toMatch(/postgres:16/);
        const stopped = { state: "stopped" as const, image: "postgres:16", config: "" };
        expect(postgres_version_conflict(stopped, "17")).toBeNull();
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
