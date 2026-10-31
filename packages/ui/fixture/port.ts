// The port the fixture listens on and the dev server proxies to. It is not the daemon's port on
// purpose: a driver run with `SPINNER_PORT` unset must reach a fixture or nothing, never the
// operator's daemon (SESSION_PROTOCOL lesson 30). `SPINNER_PORT` still points both at a
// daemon or a fixture elsewhere.
export const FIXTURE_PORT_DEFAULT = 17777;

/** The port from `SPINNER_PORT`, else the fixture's own default. */
export function fixturePort(env: Record<string, string | undefined>): number {
    const named = env["SPINNER_PORT"];
    if (named === undefined || named === "") {
        return FIXTURE_PORT_DEFAULT;
    }
    const port = Number(named);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`SPINNER_PORT must be a port number, got ${JSON.stringify(named)}`);
    }
    return port;
}
