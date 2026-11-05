// Secret redaction (dogfood #48). Agents inherit the operator's secrets through the daemon's
// environment, and pi records every tool result verbatim in the agent's transcript, so one
// `env` in a shell writes a token into `agents/<name>/pi/*.jsonl`. The pi extension passes
// every tool result through `redact` before pi records it, and the daemon passes every job
// log line through it. Only the values of the variables named here are replaced; the names
// stay, so the reader can tell which secret was there. This package is imported by the
// browser UI, so it uses no `node:` module.

/** Variables redacted by name, whatever their suffix. */
export const SECRET_NAMES: readonly string[] = ["SLACK_USER_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];

/** A variable whose name ends with one of these is a secret too. */
export const SECRET_SUFFIXES: readonly string[] = ["_TOKEN", "_SECRET", "_API_KEY"];

/** A shorter value is not redacted: it would match ordinary text (`true`, `1`, a path). */
export const SECRET_VALUE_MIN = 8;

/** At most this many values are redacted; an environment has a handful of secrets. */
export const SECRETS_MAX = 200;

/** One secret: its variable name and its value. */
export interface SecretValue {
    name: string;
    value: string;
}

/** True when `name` names a secret: a listed name, or one of the suffixes. */
export function is_secret_name(name: string): boolean {
    return SECRET_NAMES.includes(name) || SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * The secrets of an environment, longest value first, so a value that contains another one
 * is replaced whole. Values shorter than `SECRET_VALUE_MIN` are left out. Throws past
 * `SECRETS_MAX`.
 */
export function secret_values(env: Readonly<Record<string, string | undefined>>): SecretValue[] {
    const secrets: SecretValue[] = [];
    for (const [name, value] of Object.entries(env)) {
        if (value === undefined || value.length < SECRET_VALUE_MIN || !is_secret_name(name)) {
            continue;
        }
        secrets.push({ name, value });
        if (secrets.length > SECRETS_MAX) {
            throw new Error(`more than ${SECRETS_MAX} secret variables in the environment`);
        }
    }
    return secrets.sort((a, b) => b.value.length - a.value.length);
}

/** `text` with each secret value replaced by `[redacted:<NAME>]`. */
export function redact_values(text: string, secrets: readonly SecretValue[]): string {
    let out = text;
    for (const secret of secrets) {
        if (out.includes(secret.value)) {
            out = out.split(secret.value).join(`[redacted:${secret.name}]`);
        }
    }
    return out;
}

/** `text` with the values of the secrets of `env` replaced by `[redacted:<NAME>]`. */
export function redact(text: string, env: Readonly<Record<string, string | undefined>>): string {
    return redact_values(text, secret_values(env));
}
