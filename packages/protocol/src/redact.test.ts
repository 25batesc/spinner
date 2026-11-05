// Goal: the values of secret variables never pass `redact`, the names do, and ordinary text
// is unchanged (dogfood #48). Method: fake environments with listed names, suffixed names,
// short values, a value inside another, and an `env` dump as a shell prints it.
import { describe, expect, it } from "vitest";
import { SECRETS_MAX, is_secret_name, redact, secret_values } from "./redact.js";

const ENV = {
    SLACK_USER_TOKEN: "xoxp-1111-2222-3333-abcdef",
    GH_TOKEN: "ghp_aaaaaaaaaaaaaaaa",
    OPENROUTER_API_KEY: "sk-or-v1-0123456789",
    WEBHOOK_SECRET: "s3cr3t-value",
    SHORT_TOKEN: "abc",
    HOME: "/Users/someone",
    PATH: "/usr/bin:/bin",
    UNNAMED_VALUE: "xoxp-1111-2222-3333-abcdef-but-not-named",
};

describe("redact", () => {
    it("names the secrets by list and by suffix, and nothing else", () => {
        expect(is_secret_name("SLACK_USER_TOKEN")).toBe(true);
        expect(is_secret_name("GITHUB_TOKEN")).toBe(true);
        expect(is_secret_name("ANTHROPIC_API_KEY")).toBe(true);
        expect(is_secret_name("WEBHOOK_SECRET")).toBe(true);
        expect(is_secret_name("TOKEN_PATH")).toBe(false);
        expect(is_secret_name("PATH")).toBe(false);
        expect(secret_values(ENV).map((secret) => secret.name)).toEqual([
            "SLACK_USER_TOKEN",
            "GH_TOKEN",
            "OPENROUTER_API_KEY",
            "WEBHOOK_SECRET",
        ]);
    });

    it("replaces every value with its name and keeps the rest of an env dump", () => {
        const dump = Object.entries(ENV)
            .map(([name, value]) => `declare -x ${name}="${value}"`)
            .join("\n");
        const out = redact(dump, ENV);
        expect(out).toContain('declare -x SLACK_USER_TOKEN="[redacted:SLACK_USER_TOKEN]"');
        expect(out).toContain('declare -x GH_TOKEN="[redacted:GH_TOKEN]"');
        expect(out).toContain('declare -x OPENROUTER_API_KEY="[redacted:OPENROUTER_API_KEY]"');
        expect(out).toContain('declare -x WEBHOOK_SECRET="[redacted:WEBHOOK_SECRET]"');
        // A short value would match ordinary text; it stays.
        expect(out).toContain('declare -x SHORT_TOKEN="abc"');
        expect(out).toContain('declare -x HOME="/Users/someone"');
        // The token inside an unnamed variable's value is still the token.
        expect(out).toContain(
            'declare -x UNNAMED_VALUE="[redacted:SLACK_USER_TOKEN]-but-not-named"',
        );
        for (const secret of secret_values(ENV)) {
            expect(out).not.toContain(secret.value);
        }
        expect(redact("nothing to hide", ENV)).toBe("nothing to hide");
        expect(redact("ghp_aaaaaaaaaaaaaaaa ghp_aaaaaaaaaaaaaaaa", ENV)).toBe(
            "[redacted:GH_TOKEN] [redacted:GH_TOKEN]",
        );
    });

    it("replaces the longer value first when one contains another", () => {
        const env = { A_TOKEN: "abcdefgh", B_TOKEN: "abcdefgh-longer" };
        expect(redact("x abcdefgh-longer y abcdefgh", env)).toBe(
            "x [redacted:B_TOKEN] y [redacted:A_TOKEN]",
        );
    });

    it("throws past the bound", () => {
        const many: Record<string, string> = {};
        for (let index = 0; index <= SECRETS_MAX; index += 1) {
            many[`V${index}_TOKEN`] = `value-${index}-padding`;
        }
        expect(() => secret_values(many)).toThrow(`more than ${SECRETS_MAX}`);
    });
});
