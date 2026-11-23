// Goal: `find_spec` follows the lookup order of docs/STACK_SPEC.md and `load_spec` rejects
// specs the renderer cannot use. Method: a temporary SPINNER_HOME with a project spec, and
// shape checks on small objects.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolve_home } from "../home.js";
import { check_spec_shape, find_spec, load_spec } from "./spec.js";

const repo_root = resolve(import.meta.dirname, "..", "..", "..", "..");

const minimal = {
    name: "x",
    base: "main",
    repos: { app: { path: "." } },
    services: { api: { image: "img", repo: "app", port: 1, host: "api" } },
};

describe("find_spec", () => {
    it("takes a path to a directory or a file, then a name under <home>/projects", () => {
        const root = mkdtempSync(join(tmpdir(), "spinner-spec-"));
        const home = resolve_home({ SPINNER_HOME: root });
        const dir = join(root, "projects", "acme");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "spinner.yaml"), "name: acme\n");
        expect(find_spec(dir, home, root)).toBe(join(dir, "spinner.yaml"));
        expect(find_spec(join(dir, "spinner.yaml"), home, root)).toBe(join(dir, "spinner.yaml"));
        expect(find_spec("acme", home, root)).toBe(join(dir, "spinner.yaml"));
        expect(() => find_spec("nope", home, root)).toThrow(/not found/);
        expect(() => find_spec(undefined, home, root)).toThrow(/no spinner.yaml/);
    });

    it("finds examples/sample-stack by path and resolves its repo to this checkout", () => {
        const home = resolve_home({ SPINNER_HOME: "/nonexistent" });
        const path = find_spec("examples/sample-stack", home, repo_root);
        const { spec } = load_spec(path);
        expect(spec.repos["app"]?.path).toBe(repo_root);
        const seed = join(repo_root, "examples", "sample-stack", "seed.sql");
        expect(spec.database?.seed?.dump).toBe(seed);
    });
});

describe("check_spec_shape", () => {
    it("accepts a minimal spec", () => {
        expect(check_spec_shape(minimal)).toBeNull();
    });

    it("names the first problem", () => {
        expect(check_spec_shape(null)).toMatch(/mapping/);
        expect(check_spec_shape({ ...minimal, name: "Acme Inc" })).toMatch(/name/);
        const bad_repo = { ...minimal, services: { api: { image: "i", repo: "zzz" } } };
        expect(check_spec_shape(bad_repo)).toMatch(/repo "zzz"/);
        const no_port = { ...minimal, services: { api: { image: "i", host: "api" } } };
        expect(check_spec_shape(no_port)).toMatch(/host but no port/);
        const dep = { ...minimal, services: { api: { image: "i", depends_on: ["db"] } } };
        expect(check_spec_shape(dep)).toMatch(/depends_on "db"/);
        const external = { ...minimal, database: { mode: "template", server: "external" } };
        expect(check_spec_shape(external)).toMatch(/database.external/);
    });
});
