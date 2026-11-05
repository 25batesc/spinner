// Entry point of @spinner/protocol. This package holds types, constants, the JSON schema for
// `session.yaml`, and the pure runtime helpers that the daemon and the UI must agree on
// (`diff.ts`: the diff notice text; `plan-entries.ts`: the design doc's plan entry grammar
// and the Plan line's entry token). It has no runtime dependencies so that every other
// package, including the browser UI, can import it.
export const PROTOCOL_VERSION = 1 as const;

export * from "./session.js";
export * from "./stack-spec.js";
export * from "./events.js";
export * from "./api.js";
export * from "./pipeline.js";
export * from "./agent-event.js";
export * from "./threads.js";
export * from "./extension.js";
export * from "./desktop-bridge.js";
export * from "./theme.js";
export * from "./costs.js";
export * from "./diff.js";
export * from "./egm.js";
export * from "./plan-entries.js";
