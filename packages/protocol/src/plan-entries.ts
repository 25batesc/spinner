// The entry token of a Plan item. A line of the MISSION.md Plan can link its item to an entry
// of a plan document by an id at its start: `- [ ] 7. [1.5] text (engine)`. The daemon parses
// and writes the token; the `mission_plan` tool sets it with `entry`. This package is
// imported by the browser UI, so it throws plain `Error`s and uses no `node:` module.

/** An entry id in a token is at most this many characters of `[0-9.]`. */
export const ENTRY_TOKEN_MAX = 16;

const ENTRY_ID = /^[0-9.]{1,16}$/;
const TOKEN = /^\[([0-9.]{1,16})\] (.+)$/;
const LEGACY_PREFIX = /^plan ([0-9.]{1,16}): (.+)$/;

/** True for a token id: 1 to `ENTRY_TOKEN_MAX` characters of `[0-9.]`. */
export function is_entry_id(text: string): boolean {
    return ENTRY_ID.test(text);
}

/**
 * The entry link at the start of a Plan item's text: `[1.5] text` or the legacy
 * `plan 1.5: text`. A bracket text that is not a token (`[D7] fix`, a 17-character id, a
 * token with nothing after it) is plain text with `entry` null.
 */
export function parse_entry_token(text: string): { entry: string | null; rest: string } {
    const token = TOKEN.exec(text) ?? LEGACY_PREFIX.exec(text);
    if (token === null) {
        return { entry: null, rest: text };
    }
    return { entry: token[1] ?? null, rest: token[2] ?? "" };
}

/** The canonical text of a linked item: `[1.5] text`; `rest` alone without an entry. */
export function render_entry_token(entry: string | null, rest: string): string {
    if (entry === null) {
        return rest;
    }
    if (!is_entry_id(entry)) {
        throw new Error(`not an entry id: "${entry}"`);
    }
    return `[${entry}] ${rest}`;
}
