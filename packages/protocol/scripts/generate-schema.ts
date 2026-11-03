// Generates `schema/session.json` from the `Session` type in `src/session.ts`,
// `schema/stack-spec.json` from `StackSpec` in `src/stack-spec.ts`, and the API v1 shapes
// `schema/session-view.json` and `schema/job.json` from `src/api.ts`. This is a
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
    {
        source: "index.ts",
        type: "SessionView",
        output: "session-view.json",
        title: "Spinner SessionView (GET /sessions, session.updated)",
    },
    {
        source: "index.ts",
        type: "Job",
        output: "job.json",
        title: "Spinner Job (POST actions, GET /jobs/:id)",
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
        // `tsc` checks the sources; the generator's own program only lists the root file, so
        // its check rejects imports between files. Types that import skip it.
        skipTypeCheck: entry.source === "index.ts" || entry.source === "session.ts",
    });
    const schema = generator.createSchema(entry.type);
    schema.$id = `https://spinner.dev/schema/${entry.output}`;
    schema.title = entry.title;
    mkdirSync(dirname(output_path), { recursive: true });
    writeFileSync(output_path, `${JSON.stringify(schema, null, 4)}\n`);
    console.log(`wrote ${output_path}`);
}
