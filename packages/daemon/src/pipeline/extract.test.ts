// Goal: prove that `extract_refs` finds every PR reference form in a paste (full URLs in any
// form, `owner/repo#N`, `repo#N`, bare `#N`), resolves each against the project's repos,
// folds duplicates, bounds the count, and leaves the rest of the text clean; and that
// `extract_prs` turns the refs into `ExtractedPr`s with the GitHub facts, the adoptable rule
// and the 10 s bound. Method: pure calls with a fixed repo table; the lookup runs with a
// fake `gh` that answers from the saved fixtures or hangs.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXTRACT_REFS_MAX } from "@spinner/protocol";
import { extract_prs, extract_refs, provisional_title, type ExtractRepo } from "./extract.js";
import type { GhRunner } from "./github.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "..", "..", "test", "fixtures", "github");

const repos: ExtractRepo[] = [
    { key: "app", owner: "acme", name: "spinner-sandbox" },
    { key: "web", owner: "acme", name: "web" },
];

describe("extract_refs", () => {
    it("finds URLs in any form, owner/repo#N, repo#N and #N; resolves against the project", () => {
        const text = [
            "Ship the refund flow.",
            "See https://github.com/acme/spinner-sandbox/pull/12/files#diff-abc and",
            "http://www.github.com/acme/web/pull/7?tab=checks, plus acme/other#3, web#8 and app#9.",
            "Also #10 is related.",
        ].join("\n");
        const { refs, rest } = extract_refs(text, repos);
        expect(refs.map((ref) => [ref.ref, ref.owner, ref.name, ref.number, ref.key])).toEqual([
            ["https://github.com/acme/spinner-sandbox/pull/12/files#diff-abc", "acme", "spinner-sandbox", 12, "app"],
            ["http://www.github.com/acme/web/pull/7?tab=checks", "acme", "web", 7, "web"],
            ["acme/other#3", "acme", "other", 3, null],
            ["web#8", "acme", "web", 8, "web"],
            ["app#9", "acme", "spinner-sandbox", 9, "app"],
            ["#10", null, null, 10, null],
        ]);
        expect(refs[2]?.reason).toContain("not a repo of the project");
        expect(refs[5]?.reason).toContain("could be app or web");
        expect(rest).toBe("Ship the refund flow.\nSee and\n, plus , and .\nAlso is related.");
    });

    it("resolves a bare #N when the project has one repo, and refuses it without any", () => {
        const one = extract_refs("fix #4 please", [repos[0] as ExtractRepo]);
        expect(one.refs).toEqual([
            {
                ref: "#4",
                owner: "acme",
                name: "spinner-sandbox",
                number: 4,
                key: "app",
                reason: null,
            },
        ]);
        expect(one.rest).toBe("fix please");
        const none = extract_refs("fix #4 please", []);
        expect(none.refs[0]?.key).toBeNull();
        expect(none.refs[0]?.reason).toContain("needs a project repo");
    });

    it("needs the owner for repo#N: a repo key without an origin asks for owner/repo#N", () => {
        const { refs } = extract_refs("app#2", [{ key: "app", owner: null, name: "sandbox" }]);
        expect(refs[0]?.owner).toBeNull();
        expect(refs[0]?.key).toBe("app");
        expect(refs[0]?.reason).toContain("owner/repo#N");
        const unknown = extract_refs("zzz#2", repos);
        expect(unknown.refs[0]?.reason).toContain("`zzz` is not a repo of the project");
    });

    it("folds duplicates on owner/name#number, keeps first appearance, bounds the count", () => {
        const text = "https://github.com/acme/web/pull/7 web#7 acme/web#7 and #7 twice: #7";
        const { refs } = extract_refs(text, repos);
        expect(refs.map((ref) => ref.ref)).toEqual(["https://github.com/acme/web/pull/7", "#7"]);
        const many = Array.from({ length: EXTRACT_REFS_MAX + 5 }, (_, i) => `web#${i + 1}`).join(
            " ",
        );
        expect(extract_refs(many, repos).refs).toHaveLength(EXTRACT_REFS_MAX);
    });

    it("leaves text without references as it is apart from trimming and blank runs", () => {
        const { refs, rest } = extract_refs("  a line  \n\n\n  another\n\n", repos);
        expect(refs).toEqual([]);
        expect(rest).toBe("a line\n\nanother");
        // A fragment or a hash in prose is not a reference.
        expect(extract_refs("the #1 priority is C#", repos).refs.map((ref) => ref.number)).toEqual(
            [1],
        );
    });
});

describe("provisional_title", () => {
    it("takes the first non-empty line of the rest, cut to the bound, else the PR title", () => {
        expect(provisional_title("\n  Ship refunds  \nmore", null)).toBe("Ship refunds");
        expect(provisional_title("", "PR title")).toBe("PR title");
        expect(provisional_title("", null)).toBe("New session");
        expect(provisional_title("x".repeat(200), null)).toHaveLength(80);
    });
});

/** A `gh` that answers the saved fixture for `#number`, 404s for 99, and hangs for 98. */
function fake_gh(): GhRunner {
    return async (args) => {
        const number = Number(args.find((arg) => arg.startsWith("number="))?.slice(7));
        if (number === 98) {
            return new Promise(() => undefined);
        }
        if (number === 99) {
            throw new Error("Could not resolve to a PullRequest with the number of 99");
        }
        const text = readFileSync(resolve(fixtures, "pr-fixing.json"), "utf8");
        const parsed = JSON.parse(text) as {
            data: { repository: { pullRequest: { number: number } } };
        };
        parsed.data.repository.pullRequest.number = number;
        return JSON.stringify(parsed);
    };
}

describe("extract_prs", () => {
    it("looks the resolved refs up in parallel and applies the adoptable rule", async () => {
        const text = "Refunds: https://github.com/acme/web/pull/7 acme/other#3 and #5";
        const response = await extract_prs(text, repos, { gh: fake_gh(), timeout_ms: 5_000 });
        expect(response.rest).toBe("Refunds: and");
        expect(response.prs.map((pr) => [pr.url, pr.repo, pr.key, pr.adoptable])).toEqual([
            ["https://github.com/acme/web/pull/7", "acme/web", "web", true],
            ["https://github.com/acme/other/pull/3", "acme/other", null, false],
            [null, null, null, false],
        ]);
        const web = response.prs[0];
        expect(web?.title).toBe("feat: example feature from a real PR, title scrubbed");
        expect(web?.branch).toBe("feat/example-feature");
        expect(web?.base).toBe("develop");
        expect(response.prs[1]?.title).toBe("feat: example feature from a real PR, title scrubbed");
        expect(response.prs[1]?.reason).toContain("not a repo of the project");
        expect(response.prs[2]?.reason).toContain("could be app or web");
    });

    it("reports a failed lookup and one past the bound with a reason, not an error", async () => {
        const text = "web#99 web#98 web#1";
        const response = await extract_prs(text, repos, { gh: fake_gh(), timeout_ms: 100 });
        expect(response.prs.map((pr) => [pr.number, pr.adoptable, pr.title])).toEqual([
            [99, false, null],
            [98, false, null],
            [1, true, "feat: example feature from a real PR, title scrubbed"],
        ]);
        expect(response.prs[0]?.reason).toBe("no PR #99 in acme/web");
        expect(response.prs[1]?.reason).toContain("did not answer");
        expect(response.prs[0]?.url).toBe("https://github.com/acme/web/pull/99");
    });
});
