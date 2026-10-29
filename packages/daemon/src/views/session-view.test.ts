// Goal: the stack view lists every service of the spec with where it runs, its URL through
// the proxy and the status the observer saw, and the observer maps docker rows and host
// probes to those statuses. Method: pure calls with a spec, a session and fake probes.
import { describe, expect, it } from "vitest";
import type { SessionSummary, StackSpec } from "@spinner/protocol";
import { build_stack, service_url } from "./session-view.js";
import { container_status, observe_stack } from "./stack-observer.js";

const spec: StackSpec = {
    name: "sample",
    base: "main",
    repos: { app: { path: "/repo" } },
    services: {
        api: { port: 3000, host: "api", healthcheck: "GET /health", preview: "top-level" },
        worker: { port: 3001 },
        backend: { port: 8000, host: "backend", runtime: "host", healthcheck: "GET /ping" },
    },
    proxy: { http_port: 8080 },
};

function summary(stack: SessionSummary["session"]["stack"]): SessionSummary {
    return {
        dir: "s017-x",
        path: "/home/x/.spinner/sessions/s017-x",
        session: {
            version: 1,
            id: "s017",
            slug: "x",
            title: "x",
            created: "2026-10-28T13:00:00Z",
            stage: "building",
            needs_human: null,
            branch: "feat/x",
            base: "main",
            repos: {},
            stack,
            agents: {},
        },
    };
}

describe("build_stack", () => {
    it("is empty without a spec", () => {
        expect(build_stack(summary({ state: "none" }), null, null)).toEqual({
            state: "none",
            project: null,
            database: null,
            services: [],
            observed: null,
            last_job: null,
        });
    });

    it("lists services with where, url and the observed status while up", () => {
        const up = summary({
            state: "up",
            project: "spinner-s017",
            db: "spinner_s017",
            hosts: { api: "api.s017.localhost", backend: "backend.s017.localhost" },
            processes: { backend: { pid: 42, port: 65501, log: "log/backend.log" } },
        });
        const view = build_stack(up, spec, {
            observed: "2026-10-28T13:00:05Z",
            statuses: { api: "healthy", worker: "unknown", backend: "starting" },
        });
        expect(view.project).toBe("spinner-s017");
        expect(view.database).toBe("spinner_s017");
        expect(view.observed).toBe("2026-10-28T13:00:05Z");
        expect(view.services).toEqual([
            {
                name: "api",
                where: "container",
                status: "healthy",
                host: "api.s017.localhost",
                url: "http://api.s017.localhost:8080",
                process: null,
                preview: "top-level",
            },
            {
                name: "worker",
                where: "container",
                status: "unknown",
                host: null,
                url: null,
                process: null,
                preview: "frame",
            },
            {
                name: "backend",
                where: "host",
                status: "starting",
                host: "backend.s017.localhost",
                url: "http://backend.s017.localhost:8080",
                process: { pid: 42, port: 65501, log: "log/backend.log" },
                preview: "frame",
            },
        ]);
    });

    it("reports every service stopped once the stack is down, whatever was observed", () => {
        const down = summary({ state: "down", project: "spinner-s017", hosts: { api: "a" } });
        const view = build_stack(down, spec, {
            observed: "2026-10-28T13:00:05Z",
            statuses: { api: "healthy", worker: "unknown", backend: "healthy" },
        });
        expect(view.services.map((service) => service.status)).toEqual([
            "stopped",
            "stopped",
            "stopped",
        ]);
    });

    it("omits the port from the url on port 80", () => {
        expect(service_url("api.s017.localhost", 80)).toBe("http://api.s017.localhost");
    });
});

describe("observe_stack", () => {
    it("maps docker rows and host probes to statuses", async () => {
        const up = summary({
            state: "up",
            project: "spinner-s017",
            processes: { backend: { pid: 42, port: 65501, log: "log/backend.log" } },
        });
        const asked: string[] = [];
        const observation = await observe_stack(up, spec, {
            docker: async (project) => {
                asked.push(project);
                return [
                    { name: "api", state: "running", health: "healthy" },
                    { name: "worker", state: "running", health: "" },
                ];
            },
            answers: async (port, path) => port === 65501 && path === "/ping",
            now: () => new Date("2026-10-28T13:00:05Z"),
        });
        expect(asked).toEqual(["spinner-s017"]);
        expect(observation).toEqual({
            observed: "2026-10-28T13:00:05.000Z",
            statuses: { api: "healthy", worker: "unknown", backend: "healthy" },
        });
    });

    it("container_status covers missing, exited, starting and unhealthy", () => {
        expect(container_status(undefined, true)).toBe("stopped");
        expect(container_status({ name: "a", state: "exited", health: "" }, true)).toBe("stopped");
        const running = { name: "a", state: "running", health: "" };
        expect(container_status(running, true)).toBe("starting");
        expect(container_status(running, false)).toBe("unknown");
        expect(container_status({ name: "a", state: "running", health: "unhealthy" }, true)).toBe(
            "unhealthy",
        );
    });
});
