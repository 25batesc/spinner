// Goal: pin the compose file the renderer produces for `examples/sample-stack`, so a change to
// the renderer shows up as a diff of the compose file, and check the rules the brief states:
// Traefik Host() labels and no host ports, the frame-header middleware, shared dependency
// volumes keyed by the lockfile hash, session variables substituted, env_file rendered.
// Method: load the real sample spec, render it for a fixed session, snapshot and inspect.
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import type { StackSpec } from "@spinner/protocol";
import { render_compose, type RenderInput } from "./compose.js";
import { load_spec } from "./spec.js";

const repo_root = resolve(import.meta.dirname, "..", "..", "..", "..");
const sample = resolve(repo_root, "examples", "sample-stack", "spinner.yaml");

function sample_input(): RenderInput {
    const { spec } = load_spec(sample);
    // The repo path is this checkout; the snapshot must not depend on where it lives.
    for (const repo of Object.values(spec.repos)) {
        repo.path = "/home/me/Spinner";
    }
    return {
        spec,
        session: {
            id: "s17",
            branch: "feat/try-it",
            dir: "/home/me/.spinner/sessions/s17-try-it",
            db: "spinner_s17",
        },
        worktrees: { app: "/home/me/.spinner/sessions/s17-try-it/worktrees/app" },
        deps: {
            api: {
                hash: "0123456789abcdef0123456789abcdef",
                lockfile: "package-lock.json",
                dir: "examples/sample-stack/api",
            },
        },
    };
}

describe("render_compose on examples/sample-stack", () => {
    const rendered = render_compose(sample_input());
    const document = parse(rendered.compose) as {
        services: Record<string, Record<string, unknown>>;
        volumes: Record<string, unknown>;
        networks: Record<string, unknown>;
    };

    it("matches the snapshot", () => {
        expect(rendered.compose).toMatchSnapshot();
        expect(rendered.env).toMatchSnapshot();
    });

    it("routes every service with a host through Traefik and maps no host port", () => {
        for (const [name, service] of Object.entries(document.services)) {
            expect(service["ports"]).toBeUndefined();
            const labels = service["labels"] as Record<string, string> | undefined;
            if (name === "api") {
                expect(labels?.["traefik.http.routers.spinner-s17-api.rule"]).toBe(
                    "Host(`api.s17.localhost`)",
                );
                expect(labels?.["traefik.docker.network"]).toBe("spinner-s17");
            }
        }
        expect(rendered.hosts).toEqual({
            api: "api.s17.localhost",
            web: "web.s17.localhost",
            temporal: "temporal.s17.localhost",
        });
    });

    it("adds the frame-header middleware only to strip_frame_headers services", () => {
        const temporal = document.services["temporal"]?.["labels"] as Record<string, string>;
        expect(temporal["traefik.http.routers.spinner-s17-temporal.middlewares"]).toBe(
            "spinner-s17-temporal-frames",
        );
        const api = document.services["api"]?.["labels"] as Record<string, string>;
        expect(api["traefik.http.routers.spinner-s17-api.middlewares"]).toBeUndefined();
    });

    it("keys the dependency volume by the lockfile hash and installs once", () => {
        const name = "spinner-deps-npm-cache-0123456789ab";
        expect(rendered.deps_volumes).toEqual([name]);
        expect(document.volumes[name]).toEqual({ name, external: true });
        const api = document.services["api"];
        expect(api?.["volumes"]).toContain(
            `${name}:/app/examples/sample-stack/api/node_modules`,
        );
        const command = api?.["command"] as string[];
        expect(command[2]).toContain("npm ci");
        expect(command[2]).toMatch(/exec node --watch server\.js$/);
    });

    it("substitutes the session variables and keeps the session network external", () => {
        const env = document.services["api"]?.["environment"] as Record<string, string>;
        expect(env["DATABASE_URL"]).toBe("postgres://postgres:postgres@postgres:5432/spinner_s17");
        expect(env["SESSION_ID"]).toBe("s17");
        expect(document.networks["default"]).toEqual({ name: "spinner-s17", external: true });
    });

    it("waits for healthy dependencies and started ones otherwise", () => {
        expect(document.services["web"]?.["depends_on"]).toEqual({
            api: { condition: "service_healthy" },
        });
        expect(document.services["api"]?.["depends_on"]).toEqual({
            temporal: { condition: "service_started" },
        });
    });
});

describe("render_compose options", () => {
    it("writes env_file content, prefixes the wrapper and passes host env by reference", () => {
        const input = sample_input();
        const spec: StackSpec = structuredClone(input.spec);
        spec.pass_env = ["OPENAI_API_KEY"];
        const api = spec.services["api"];
        if (api === undefined) {
            throw new Error("sample has an api service");
        }
        api.env_file = "examples/sample-stack/api/.env.local";
        api.wrapper = "bin/run-with-secrets.sh sample";
        const rendered = render_compose({ ...input, spec });
        expect(rendered.env_files).toEqual([
            {
                path:
                    "/home/me/.spinner/sessions/s17-try-it/worktrees/app" +
                    "/examples/sample-stack/api/.env.local",
                content: expect.stringContaining("SESSION_ID=s17") as string,
            },
        ]);
        const document = parse(rendered.compose) as {
            services: Record<string, { command: string[]; environment: Record<string, string> }>;
        };
        expect(document.services["temporal"]?.command).toMatch(/^server start-dev --ip/);
        expect(document.services["api"]?.command[2]).toContain(
            "exec /app/bin/run-with-secrets.sh sample node --watch server.js",
        );
        expect(document.services["temporal"]?.command).toMatch(/^server start-dev --ip/);
        expect(document.services["api"]?.environment["OPENAI_API_KEY"]).toBe("${OPENAI_API_KEY}");
    });
});
