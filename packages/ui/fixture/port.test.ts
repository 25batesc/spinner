// The fixture's port: with `SPINNER_PORT` unset it is the fixture's own default, which is not
// the daemon's port, so a driver run can never reach the operator's daemon by omission; a set
// `SPINNER_PORT` wins; a value that is not a port is an error, not a silent default.
import { DAEMON_PORT } from "@spinner/protocol";
import { expect, it } from "vitest";

import { FIXTURE_PORT_DEFAULT, fixturePort } from "./port.ts";

it("defaults to a port that is not the daemon's", () => {
    expect(fixturePort({})).toBe(FIXTURE_PORT_DEFAULT);
    expect(fixturePort({ SPINNER_PORT: "" })).toBe(FIXTURE_PORT_DEFAULT);
    expect(FIXTURE_PORT_DEFAULT).not.toBe(DAEMON_PORT);
});

it("takes SPINNER_PORT when it is set", () => {
    expect(fixturePort({ SPINNER_PORT: "7778" })).toBe(7778);
});

it("refuses a value that is not a port", () => {
    expect(() => fixturePort({ SPINNER_PORT: "daemon" })).toThrow(/SPINNER_PORT/);
    expect(() => fixturePort({ SPINNER_PORT: "70000" })).toThrow(/SPINNER_PORT/);
});
