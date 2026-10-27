// Generates `schema/session.json` from the `Session` type in `src/session.ts` and
// `schema/stack-spec.json` from the `StackSpec` type in `src/stack-spec.ts`. This is a
// development step, not a runtime one, so the generator stays a dev dependency and the
// published package keeps zero runtime dependencies. Run with `pnpm schema`.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGenerator } from "ts-json-schema-generator";

const package_root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** One entry per generated schema: the source file, its root type and the output name. */
const SCHEMAS = [
    {
        source: "session.ts",
        type: "Session",
        output: "session.json",
        title: "Spinner session.yaml",
    },
    {
        source: "stack-spec.ts",
        type: "StackSpec",
        output: "stack-spec.json",
        title: "Spinner spinner.yaml",
    },
] as const;

for (const entry of SCHEMAS) {
    const output_path = resolve(package_root, "schema", entry.output);
    const generator = createGenerator({
        path: resolve(package_root, "src", entry.source),
        tsconfig: resolve(package_root, "tsconfig.json"),
        type: entry.type,
        // Properties marked optional in TypeScript may be absent; they may not be `undefined`
        // inside YAML anyway, so the strict form costs nothing and keeps the schema small.
        additionalProperties: false,
        skipTypeCheck: false,
    });
    const schema = generator.createSchema(entry.type);
    schema.$id = `https://spinner.dev/schema/${entry.output}`;
    schema.title = entry.title;
    mkdirSync(dirname(output_path), { recursive: true });
    writeFileSync(output_path, `${JSON.stringify(schema, null, 4)}\n`);
    console.log(`wrote ${output_path}`);
}
