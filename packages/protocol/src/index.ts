// Entry point of @spinner/protocol. This package holds types, constants and the JSON schema
// for `session.yaml` and nothing else. It has no runtime dependencies so that every other
// package, including the browser UI, can import it.
export const PROTOCOL_VERSION = 1 as const;

export * from "./session.js";
export * from "./events.js";
export * from "./api.js";
