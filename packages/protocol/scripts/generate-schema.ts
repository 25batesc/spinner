// Generates `schema/session.json` from the `Session` type in `src/session.ts`. This is a
// development step, not a runtime one, so the generator stays a dev dependency and the
// published package keeps zero runtime dependencies. Run with `pnpm schema`.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGenerator } from "ts-json-schema-generator";

const package_root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output_path = resolve(package_root, "schema", "session.json");

const generator = createGenerator({
    path: resolve(package_root, "src", "session.ts"),
    tsconfig: resolve(package_root, "tsconfig.json"),
    type: "Session",
    // Properties marked optional in TypeScript may be absent; they may not be `undefined`
    // inside YAML anyway, so the strict form costs nothing and keeps the schema small.
    additionalProperties: false,
    skipTypeCheck: false,
});

const schema = generator.createSchema("Session");
schema.$id = "https://spinner.dev/schema/session.json";
schema.title = "Spinner session.yaml";

mkdirSync(dirname(output_path), { recursive: true });
writeFileSync(output_path, `${JSON.stringify(schema, null, 4)}\n`);
console.log(`wrote ${output_path}`);
