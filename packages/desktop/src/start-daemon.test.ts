// Goal: the start command runs the checkout's CLI with Node from PATH, falls back to
// Electron-as-Node, and refuses a checkout without a built CLI. Method: a scratch checkout
// with an empty `packages/cli/dist/main.js` and a scratch PATH with or without `node`.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { find_node_on_path, repo_root, start_command } from "./start-daemon.js";

function scratch_checkout(): string {
    const root = mkdtempSync(join(tmpdir(), "spinner-desktop-"));
    mkdirSync(join(root, "packages", "cli", "dist"), { recursive: true });
    writeFileSync(join(root, "packages", "cli", "dist", "main.js"), "");
    return root;
}

function scratch_bin(with_node: boolean): string {
    const bin = mkdtempSync(join(tmpdir(), "spinner-desktop-bin-"));
    if (with_node) {
        const node = join(bin, "node");
        writeFileSync(node, "#!/bin/sh\n");
        chmodSync(node, 0o755);
    }
    return bin;
}

describe("start_command", () => {
    it("uses node from PATH when there is one", () => {
        const root = scratch_checkout();
        const bin = scratch_bin(true);
        const command = start_command(root, { PATH: bin }, "/Electron");
        expect(command.command).toBe(join(bin, "node"));
        expect(command.args).toEqual([join(root, "packages/cli/dist/main.js"), "daemon", "start"]);
        expect(command.cwd).toBe(root);
        expect(command.env["ELECTRON_RUN_AS_NODE"]).toBeUndefined();
    });

    it("falls back to Electron as Node", () => {
        const root = scratch_checkout();
        const bin = scratch_bin(false);
        const command = start_command(root, { PATH: bin }, "/Electron");
        expect(command.command).toBe("/Electron");
        expect(command.env["ELECTRON_RUN_AS_NODE"]).toBe("1");
    });

    it("refuses a checkout without a built CLI", () => {
        const root = mkdtempSync(join(tmpdir(), "spinner-desktop-empty-"));
        expect(() => start_command(root, { PATH: "" }, "/Electron")).toThrow(/pnpm -r build/);
    });
});

describe("find_node_on_path", () => {
    it("is null for an empty or absent PATH", () => {
        expect(find_node_on_path({})).toBeNull();
        expect(find_node_on_path({ PATH: "" })).toBeNull();
    });
});

describe("repo_root", () => {
    it("takes SPINNER_REPO first, then the package's grandparent", () => {
        expect(repo_root({ SPINNER_REPO: "/tmp/x" })).toBe("/tmp/x");
        expect(repo_root({})).toMatch(/\/Spinner$/);
    });
});
