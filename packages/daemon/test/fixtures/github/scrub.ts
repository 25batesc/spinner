// Scrubs a raw `pr-facts.graphql` response before it is saved as a fixture. Logins other than
// the review bots become `owner-1` (the gh login that fetched it) or `human-N`; bodies, the
// title and the head ref are replaced; URLs are rewritten to the fictional `acme` org. Run:
//
//     node scrub.ts <raw.json> <owner-login> "<shape note>" > pr-<name>.json
//
// The output keeps every structural fact (states, SHAs, timestamps, check names), which is
// what the collector reads. Nothing in it identifies a person or a repository.
import { readFileSync } from "node:fs";

const [raw_path, owner_login, shape] = process.argv.slice(2);
if (raw_path === undefined || owner_login === undefined || shape === undefined) {
    console.error("usage: node scrub.ts <raw.json> <owner-login> <shape note>");
    process.exit(2);
}

const BOT_LOGINS = new Set([
    "devin-ai-integration",
    "sonarqubecloud",
    "dependabot",
    "github-actions",
]);
const humans = new Map<string, string>();

function scrub_login(login: string): string {
    if (BOT_LOGINS.has(login)) {
        return login;
    }
    if (login === owner_login) {
        return "owner-1";
    }
    let name = humans.get(login);
    if (name === undefined) {
        name = `human-${humans.size + 1}`;
        humans.set(login, name);
    }
    return name;
}

/** Keeps the host of a URL and replaces its path, because the path names the org and repo. */
function scrub_url(url: string): string {
    const parsed = new URL(url);
    if (parsed.host === "github.com") {
        return url.replace(/github\.com\/[^/]+\/[^/]+/, "github.com/acme/backend");
    }
    return `${parsed.protocol}//${parsed.host}/scrubbed`;
}

function scrub(value: unknown, key: string): unknown {
    if (Array.isArray(value)) {
        return value.map((entry) => scrub(entry, key));
    }
    if (typeof value === "object" && value !== null) {
        const out: Record<string, unknown> = {};
        for (const [child_key, child] of Object.entries(value)) {
            out[child_key] = scrub(child, child_key);
        }
        return out;
    }
    if (typeof value !== "string") {
        return value;
    }
    if (key === "login") {
        return scrub_login(value);
    }
    if (key === "body") {
        return `[scrubbed, ${value.length} chars]`;
    }
    if (key === "title") {
        return "feat: example feature from a real PR, title scrubbed";
    }
    if (key === "headRefName") {
        return "feat/example-feature";
    }
    if (key === "url" || key === "detailsUrl" || key === "targetUrl") {
        return scrub_url(value);
    }
    return value;
}

const raw = JSON.parse(readFileSync(raw_path, "utf8")) as Record<string, unknown>;
const today = new Date().toISOString().slice(0, 10);
const output = {
    _source: `gh api graphql, ${today}, scrubbed: logins, bodies, title, head ref, URLs`,
    _shape: shape,
    ...scrub(raw, "") as Record<string, unknown>,
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
