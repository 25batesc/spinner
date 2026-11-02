// The fixture's extraction answers in the shape of the mission's contract: every reference
// form, duplicates folded, a repo outside the project refused with a reason.
import { expect, it } from "vitest";

import { extract } from "./extract.ts";

const REPOS = ["web", "api"];

it("finds a full URL, owner/repo#N, repo#N and a bare #N, in text order", () => {
    const text = [
        "Refund flow https://github.com/example/web/pull/412/files",
        "also example/api#87 and web#5 and #9",
    ].join("\n");
    const { prs, rest } = extract(text, REPOS);
    expect(prs.map((pr) => [pr.key, pr.number, pr.adoptable])).toEqual([
        ["web", 412, true], ["api", 87, true], ["web", 5, true], [null, 9, false],
    ]);
    expect(prs[3]?.reason).toBe("#9 could be web or api; write repo#N");
    expect(prs[3]?.url).toBeNull();
    expect(prs[1]?.ref).toBe("example/api#87");
    expect(prs[0]?.repo).toBe("example/web");
    expect(prs[0]?.title).toBe("PR 412 of web");
    expect(prs[0]?.branch).toBe("feature/web-412");
    expect(rest).toBe("Refund flow\nalso and and");
});

it("folds a PR named twice in two forms", () => {
    const text = "https://github.com/example/web/pull/412 then web#412 again";
    expect(extract(text, REPOS).prs).toHaveLength(1);
});

it("refuses a repo the project does not list, with the reason", () => {
    const { prs } = extract("https://github.com/example/billing/pull/3", REPOS);
    expect(prs[0]?.adoptable).toBe(false);
    expect(prs[0]?.reason).toBe("billing is not a repo of the project");
    expect(prs[0]?.key).toBeNull();
});

it("resolves a bare #N against a project with one repo", () => {
    const { prs } = extract("#12", ["web"]);
    expect(prs[0]).toMatchObject({ key: "web", number: 12, adoptable: true });
});

it("answers no PRs for a plain sentence", () => {
    const sentence = "Fix the refund copy.";
    expect(extract(sentence, REPOS)).toEqual({ prs: [], rest: sentence });
});
