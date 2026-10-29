// Goal: `load_config` reads `<home>/config.yaml`, lets the environment win key by key, treats
// a missing file as defaults, and refuses unknown or secret-looking keys. Method: a temporary
// home, the file written per case, the public `load_config` and `parse_config` entries.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { load_config, parse_config } from "./config.js";
import { resolve_home } from "./home.js";

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spinner-config-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("load_config", () => {
    it("is all defaults without a file", () => {
        const loaded = load_config(resolve_home({ SPINNER_HOME: root }), {});
        expect(loaded.found).toBe(false);
        expect(loaded.path).toBe(join(root, "config.yaml"));
        expect(loaded.config).toEqual({ slack: {} });
    });

    it("reads every key and lets the environment override each one", () => {
        writeFileSync(
            join(root, "config.yaml"),
            [
                "pi_bin: /opt/pi/bin/pi",
                "port: 7778",
                "default_model: anthropic/claude-x",
                "slack:",
                "  channel: C0FILE",
                "",
            ].join("\n"),
        );
        const home = resolve_home({ SPINNER_HOME: root });
        const from_file = load_config(home, {});
        expect(from_file.found).toBe(true);
        expect(from_file.config).toEqual({
            pi_bin: "/opt/pi/bin/pi",
            port: 7778,
            default_model: "anthropic/claude-x",
            slack: { channel: "C0FILE" },
        });
        const from_env = load_config(home, {
            SPINNER_PI: "/usr/local/bin/pi",
            SPINNER_PORT: "9000",
            SPINNER_DEFAULT_MODEL: "openai/gpt-y",
            SPINNER_SLACK_CHANNEL: "C0ENV",
        });
        expect(from_env.config).toEqual({
            pi_bin: "/usr/local/bin/pi",
            port: 9000,
            default_model: "openai/gpt-y",
            slack: { channel: "C0ENV" },
        });
        // An empty variable is unset, not an override to nothing.
        expect(load_config(home, { SPINNER_PORT: "" }).config.port).toBe(7778);
    });

    it("refuses a secret-looking key, an unknown key and a bad port", () => {
        expect(() => parse_config("github_token: ghp_x\n", "c.yaml")).toThrow(
            /"github_token" looks like a secret/,
        );
        expect(() => parse_config("slack:\n  api_key: x\n", "c.yaml")).toThrow(
            /"slack.api_key" looks like a secret/,
        );
        expect(() => parse_config("prot: 1\n", "c.yaml")).toThrow(/unknown key "prot"/);
        expect(() => parse_config("port: 70000\n", "c.yaml")).toThrow(/port must be an integer/);
        expect(() => parse_config("port: '7777'\n", "c.yaml")).toThrow(/port must be an integer/);
        expect(() => parse_config("- a\n", "c.yaml")).toThrow(/must be a mapping/);
        const home = resolve_home({ SPINNER_HOME: root });
        expect(() => load_config(home, { SPINNER_PORT: "abc" })).toThrow(/SPINNER_PORT/);
    });

    it("treats an empty file as no settings", () => {
        expect(parse_config("", "c.yaml")).toEqual({ slack: {} });
        expect(parse_config("# only a comment\n", "c.yaml")).toEqual({ slack: {} });
    });
});
