// The fixture's `POST /sessions/extract`: the PR references of a paste, resolved against a
// project's repos, in the shape the daemon answers. No GitHub: the title and the branch are
// made from the number. The daemon's own extraction lives in `packages/daemon`.
import type { ExtractedPr, ExtractResponse } from "@spinner/protocol";

const OWNER = "example";

/** A reference as the text names it, before the repo is resolved. */
interface Reference {
    match: string;
    /** Where the match starts in the text, so the PRs come out in text order. */
    index: number;
    owner: string | null;
    repo: string | null;
    number: number;
}

const URL_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#][^\s)]*)?/g;
const SHORT_RE = /(?<![\w/])(?:([\w.-]+)\/)?([\w.-]+)#(\d+)\b/g;
const BARE_RE = /(?<![\w/#])#(\d+)\b/g;

function references(text: string): Reference[] {
    const found: Reference[] = [];
    for (const match of text.matchAll(URL_RE)) {
        const [whole, owner = "", repo = "", number = "0"] = match;
        found.push({ match: whole, index: match.index, owner, repo, number: Number(number) });
    }
    // The URLs are blanked with spaces of the same length, so the later indexes still hold.
    const withoutUrls = text.replace(URL_RE, (whole) => " ".repeat(whole.length));
    for (const match of withoutUrls.matchAll(SHORT_RE)) {
        const [whole, owner, repo = "", number = "0"] = match;
        const reference = { match: whole, index: match.index, repo, number: Number(number) };
        found.push({ ...reference, owner: owner ?? null });
    }
    const withoutShort = withoutUrls.replace(SHORT_RE, (whole) => " ".repeat(whole.length));
    for (const match of withoutShort.matchAll(BARE_RE)) {
        const [whole, number = "0"] = match;
        const reference = { match: whole, index: match.index, owner: null, repo: null };
        found.push({ ...reference, number: Number(number) });
    }
    return found.sort((a, b) => a.index - b.index);
}

function resolve(reference: Reference, repos: readonly string[]): ExtractedPr {
    const number = reference.number;
    const owner = reference.owner ?? OWNER;
    const make = (repo: string | null, adoptable: boolean, reason?: string): ExtractedPr => {
        const made: ExtractedPr = {
            ref: reference.match,
            url: repo === null ? null : `https://github.com/${owner}/${repo}/pull/${number}`,
            repo: repo === null ? null : `${owner}/${repo}`,
            key: adoptable ? repo : null,
            number,
            title: repo === null ? null : `PR ${number} of ${repo}`,
            branch: repo === null ? null : `feature/${repo}-${number}`,
            base: repo === null ? null : "main",
            adoptable,
        };
        if (reason !== undefined) {
            made.reason = reason;
        }
        return made;
    };
    if (reference.repo === null) {
        if (repos.length === 1) {
            return make(repos[0] ?? "", true);
        }
        const names = repos.join(" or ");
        return make(null, false, `#${number} could be ${names}; write repo#N`);
    }
    if (repos.includes(reference.repo)) {
        return make(reference.repo, true);
    }
    return make(reference.repo, false, `${reference.repo} is not a repo of the project`);
}

/** The PRs of `text`, duplicates folded by URL, and the text without them. */
export function extract(text: string, repos: readonly string[]): ExtractResponse {
    const seen = new Map<string, ExtractedPr>();
    let rest = text;
    for (const reference of references(text)) {
        const pr = resolve(reference, repos);
        const key = `${pr.repo ?? "?"}#${pr.number}`;
        seen.set(key, seen.get(key) ?? pr);
        rest = rest.split(reference.match).join(" ");
    }
    const tidy = rest.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim());
    const collapsed = tidy.join("\n").replace(/\n{2,}/g, "\n\n").trim();
    return { prs: [...seen.values()], rest: collapsed };
}
