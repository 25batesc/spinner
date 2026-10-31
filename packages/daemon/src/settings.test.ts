// Goal: GET /settings answers the defaults without a file and the file's document with one;
// PUT /settings validates the whole document (unknown key, bad harness, unknown theme are
// 400), writes settings.yaml, answers the document and publishes `settings`; GET /themes
// lists the built-ins and every valid ~/.spinner/themes/<name>.json, and names an invalid
// file with its missing keys without listing it. Method: a daemon on port 0 over a scratch
// home, with theme files written by the test.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
    SettingsResponse,
    SpinnerEvent,
    ThemePalette,
    ThemesResponse,
} from "@spinner/protocol";
import { BUILTIN_THEMES, validate_palette } from "@spinner/protocol";
import { resolve_home, type SpinnerHome } from "./home.js";
import { start_daemon, type Daemon } from "./server.js";

let root: string;
let home: SpinnerHome;
let daemon: Daemon;
let events: SpinnerEvent[];

beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "spinner-settings-"));
    home = resolve_home({ SPINNER_HOME: join(root, "home") });
    mkdirSync(home.root, { recursive: true });
    daemon = await start_daemon({
        home,
        port: 0,
        operator: false,
        log: () => undefined,
        poll_seconds: 0,
        notify: async () => undefined,
        ui_dir: null,
        observe_interval_ms: 60_000,
        usage_interval_ms: 60_000,
        pi: "/bin/false",
        cwd: root,
    });
    events = [];
    daemon.bus.subscribe((event) => events.push(event));
});

afterEach(async () => {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
});

function call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${daemon.port}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

function custom_palette(): ThemePalette {
    return JSON.parse(JSON.stringify(BUILTIN_THEMES.dark)) as ThemePalette;
}

describe("settings", () => {
    it("answers the defaults, then the written document; refuses a bad one", async () => {
        const initial = await call("GET", "/settings");
        expect(initial.status).toBe(200);
        expect(await initial.json()).toEqual({
            settings: { theme: "system" },
            path: join(home.root, "settings.yaml"),
        });

        const unknown_key = await call("PUT", "/settings", { theme: "dark", colour: "x" });
        expect(unknown_key.status).toBe(400);
        const unknown_body = (await unknown_key.json()) as { error: string };
        expect(unknown_body.error).toMatch(/unknown key "colour"/);
        const bad_harness = await call("PUT", "/settings", { agents: { harness: "pty" } });
        expect(bad_harness.status).toBe(400);
        const no_theme = await call("PUT", "/settings", { theme: "solarized" });
        expect(no_theme.status).toBe(400);
        expect(((await no_theme.json()) as { error: string }).error).toMatch(/unknown theme/);
        const not_object = await call("PUT", "/settings", ["dark"]);
        expect(not_object.status).toBe(400);
        expect(events.filter((event) => event.type === "settings")).toHaveLength(0);

        const written = await call("PUT", "/settings", {
            theme: "dark",
            default_model: "anthropic/claude-x",
            agents: { harness: "rpc" },
        });
        expect(written.status).toBe(200);
        const body = (await written.json()) as SettingsResponse;
        expect(body.settings).toEqual({
            theme: "dark",
            default_model: "anthropic/claude-x",
            agents: { harness: "rpc" },
        });
        expect(parse(readFileSync(body.path, "utf8"))).toEqual(body.settings);
        const published = events.filter((event) => event.type === "settings");
        expect(published).toHaveLength(1);
        expect(published[0]).toMatchObject({
            type: "settings",
            session: null,
            settings: body.settings,
        });

        const again = await call("GET", "/settings");
        expect(((await again.json()) as SettingsResponse).settings).toEqual(body.settings);
    });

    it("accepts a custom theme once its file validates", async () => {
        mkdirSync(join(home.root, "themes"), { recursive: true });
        writeFileSync(join(home.root, "themes", "ocean.json"), JSON.stringify(custom_palette()));
        const written = await call("PUT", "/settings", { theme: "ocean" });
        expect(written.status).toBe(200);
        expect(((await written.json()) as SettingsResponse).settings.theme).toBe("ocean");
    });
});

describe("themes", () => {
    it("lists built-ins and valid user themes; names an invalid file's missing keys", async () => {
        const dir = join(home.root, "themes");
        mkdirSync(dir, { recursive: true });
        const ocean = custom_palette();
        ocean.accent = "#0ea5e9";
        writeFileSync(join(dir, "ocean.json"), JSON.stringify(ocean));
        const broken = custom_palette() as Partial<ThemePalette> & {
            terminal: Partial<ThemePalette["terminal"]>;
        };
        delete broken.link;
        delete broken.terminal.red;
        delete broken.terminal.cursor;
        writeFileSync(join(dir, "broken.json"), JSON.stringify(broken));
        writeFileSync(join(dir, "dark.json"), JSON.stringify(custom_palette()));
        writeFileSync(join(dir, "notes.txt"), "ignored");
        writeFileSync(join(dir, "garbage.json"), "{ not json");

        const response = await call("GET", "/themes");
        expect(response.status).toBe(200);
        const body = (await response.json()) as ThemesResponse;
        expect(body.themes.map((theme) => `${theme.source}:${theme.name}`)).toEqual([
            "builtin:light",
            "builtin:dark",
            "builtin:rainbow",
            "user:ocean",
        ]);
        expect(body.themes[0]?.palette).toEqual(BUILTIN_THEMES.light);
        expect(body.themes[3]?.palette.accent).toBe("#0ea5e9");
        const invalid_names = body.invalid.map((entry) => entry.name).sort();
        expect(invalid_names).toEqual(["broken", "dark", "garbage"]);
        const failed = body.invalid.find((entry) => entry.name === "broken");
        expect(failed?.missing).toEqual(["link", "terminal.cursor", "terminal.red"]);
        expect(failed?.path).toBe(join(dir, "broken.json"));
        const shadow = body.invalid.find((entry) => entry.name === "dark");
        expect(shadow?.reason).toMatch(/shadows a built-in/);
        expect(body.invalid.find((entry) => entry.name === "garbage")?.reason).toMatch(/not JSON/);
    });

    it("validate_palette accepts both built-ins and names what a palette lacks", () => {
        expect(validate_palette(BUILTIN_THEMES.light).ok).toBe(true);
        expect(validate_palette(BUILTIN_THEMES.dark).ok).toBe(true);
        const check = validate_palette({ bg: "#fff", terminal: { red: "" } });
        expect(check.ok).toBe(false);
        if (!check.ok) {
            expect(check.missing).toContain("surface");
            expect(check.missing).toContain("terminal.red");
            expect(check.missing).toContain("terminal.foreground");
            expect(check.missing).not.toContain("bg");
        }
        expect(validate_palette(null)).toMatchObject({ ok: false, reason: "not an object" });
    });
});
