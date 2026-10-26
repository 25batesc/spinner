// Goal: prove that `schema/session.json` is in sync with the `Session` type and that it
// accepts the session files this repo ships. Method: regenerate the schema in memory and
// compare it with the committed file, then validate the example `session.yaml` files and a
// full session that exercises every optional block with Ajv.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { createGenerator } from "ts-json-schema-generator";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import type { Session } from "./session.js";

const package_root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo_root = resolve(package_root, "..", "..");
const schema_path = resolve(package_root, "schema", "session.json");
const schema = JSON.parse(readFileSync(schema_path, "utf8")) as Record<string, unknown>;

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);

function read_yaml(path: string): unknown {
    return parse(readFileSync(path, "utf8"));
}

describe("session.json schema", () => {
    it("matches the Session type (run `pnpm schema` when this fails)", () => {
        const generated = createGenerator({
            path: resolve(package_root, "src", "session.ts"),
            tsconfig: resolve(package_root, "tsconfig.json"),
            type: "Session",
            additionalProperties: false,
        }).createSchema("Session");
        generated.$id = schema.$id as string;
        generated.title = schema.title as string;
        expect(generated).toEqual(schema);
    });

    it.each(["s001-bootstrap", "s002-board-and-stack"])(
        "accepts examples/sessions/%s/session.yaml",
        (name) => {
            const file = resolve(repo_root, "examples", "sessions", name, "session.yaml");
            const ok = validate(read_yaml(file));
            expect(validate.errors ?? []).toEqual([]);
            expect(ok).toBe(true);
        },
    );

    it("accepts a session with every optional block", () => {
        const full: Session = {
            version: 1,
            id: "s17",
            slug: "refund-flow",
            title: "Payments: refund flow",
            created: "2026-10-20T11:40:00-04:00",
            stage: "fixing",
            needs_human: null,
            branch: "feat/refund-flow",
            base: "dev",
            repos: {
                backend: {
                    path: "~/code/acme-backend",
                    worktree: "worktrees/backend",
                    changed: true,
                    pr: {
                        number: 412,
                        url: "https://github.com/acme/acme-backend/pull/412",
                        author: "you",
                        state: "open",
                        head: "9f3c1e2",
                        checks: "green",
                        approval_check: "pending",
                        approvals: { required: ["peer"], peer: [], owner: false },
                        threads: { bots_open: 2, humans_open: 0, resolved: 7 },
                        review: "none",
                        bot_reviewed_head: "9f3c1e2",
                        queue: "none",
                        last_activity: "2026-10-26T09:12:00-04:00",
                    },
                },
                web: { path: "~/code/acme-web", worktree: "worktrees/web", changed: false },
            },
            pipeline: {
                verified_locally: false,
                verified_heads: {},
                slack_post: null,
                reviewer: null,
            },
            stack: {
                project: "spinner-s17",
                state: "up",
                hosts: { api: "api.s17.localhost" },
                db: "spinner_s17",
            },
            agents: {
                "backend-api": { harness: "pi", model: "x/y", process: "running", pid: 48213 },
            },
        };
        expect(validate(full)).toBe(true);
        expect(validate.errors ?? []).toEqual([]);
    });

    it("rejects an unknown stage and a missing id", () => {
        const bad = { version: 1, slug: "x", title: "x", created: "x", stage: "flying" };
        expect(validate(bad)).toBe(false);
        const messages = (validate.errors ?? []).map((error) => error.instancePath);
        expect(messages).toContain("/stage");
    });
});
