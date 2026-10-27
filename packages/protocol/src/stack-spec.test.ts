// Goal: prove that `schema/stack-spec.json` is in sync with the `StackSpec` type and that it
// accepts the specs this repo ships and documents. Method: regenerate the schema in memory and
// compare it with the committed file, then validate `examples/sample-stack/spinner.yaml`, the
// YAML example inside docs/STACK_SPEC.md, and `local/*/spinner.yaml` when present, with Ajv.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { createGenerator } from "ts-json-schema-generator";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const package_root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo_root = resolve(package_root, "..", "..");
const schema_path = resolve(package_root, "schema", "stack-spec.json");
const schema = JSON.parse(readFileSync(schema_path, "utf8")) as Record<string, unknown>;

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);

function read_yaml(path: string): unknown {
    return parse(readFileSync(path, "utf8"));
}

/** The first fenced YAML block of a Markdown file. */
function yaml_block(markdown: string): string {
    const match = /```yaml\n([\s\S]*?)```/.exec(markdown);
    if (match?.[1] === undefined) {
        throw new Error("no yaml block");
    }
    return match[1];
}

function local_specs(): string[] {
    const local = resolve(repo_root, "local");
    if (!existsSync(local)) {
        return [];
    }
    return readdirSync(local)
        .map((name) => join(local, name, "spinner.yaml"))
        .filter((path) => existsSync(path));
}

describe("stack-spec.json schema", () => {
    it("matches the StackSpec type (run `pnpm schema` when this fails)", () => {
        const generated = createGenerator({
            path: resolve(package_root, "src", "stack-spec.ts"),
            tsconfig: resolve(package_root, "tsconfig.json"),
            type: "StackSpec",
            additionalProperties: false,
        }).createSchema("StackSpec");
        generated.$id = schema.$id as string;
        generated.title = schema.title as string;
        expect(generated).toEqual(schema);
    });

    it("accepts examples/sample-stack/spinner.yaml", () => {
        const file = resolve(repo_root, "examples", "sample-stack", "spinner.yaml");
        const ok = validate(read_yaml(file));
        expect(validate.errors ?? []).toEqual([]);
        expect(ok).toBe(true);
    });

    it("accepts the example in docs/STACK_SPEC.md", () => {
        const doc = readFileSync(resolve(repo_root, "docs", "STACK_SPEC.md"), "utf8");
        const ok = validate(parse(yaml_block(doc)));
        expect(validate.errors ?? []).toEqual([]);
        expect(ok).toBe(true);
    });

    it.each(local_specs())("accepts the private spec %s", (file) => {
        const ok = validate(read_yaml(file));
        expect(validate.errors ?? []).toEqual([]);
        expect(ok).toBe(true);
    });

    it("rejects a spec without services and one with an unknown key", () => {
        expect(validate({ name: "x", base: "main", repos: {} })).toBe(false);
        const extra = { name: "x", base: "main", repos: {}, services: {}, colour: "red" };
        expect(validate(extra)).toBe(false);
    });
});
