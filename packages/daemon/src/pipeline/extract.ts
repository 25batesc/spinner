// The PR references in a paste (MISSION.md s014, Contracts "extract"): `extract_refs` is pure
// and finds full GitHub PR URLs in any form, `owner/repo#N`, `repo#N` (a project repo key or
// a GitHub repo name) and bare `#N`, resolves each against the project's repos, folds
// duplicates and returns the text without them. `extract_prs` then asks GitHub for each
// resolved reference through the existing client, in parallel under one bound, and applies
// the adoptable rule: only a PR of a repo the project lists gets a worktree. A failed lookup
// is a reason on the entry, never an error for the whole paste.
import assert from "node:assert/strict";
import type { ExtractedPr, ExtractResponse } from "@spinner/protocol";
import { EXTRACT_REFS_MAX, SESSION_TITLE_MAX } from "@spinner/protocol";
import { fetch_pr_response, type GhRunner, type PrResponse } from "./github.js";

/** One repo of the project, as the resolver needs it: the key, the GitHub name and owner. */
export interface ExtractRepo {
    key: string;
    /** From the clone's `origin` or `pipeline.github.org`; null when neither is known. */
    owner: string | null;
    /** The GitHub repo name: the basename of the clone. */
    name: string;
}

/** A reference as written, resolved as far as the paste and the project allow. */
export interface ExtractRef {
    ref: string;
    owner: string | null;
    name: string | null;
    number: number;
    /** The project's repo key when the repo is one of the project's. */
    key: string | null;
    /** Why the reference did not resolve, or is not adoptable; null when it is clean. */
    reason: string | null;
}

export interface Extraction {
    refs: ExtractRef[];
    rest: string;
}

/** The time the whole batch of GitHub lookups gets. */
export const EXTRACT_TIMEOUT_MS = 10_000;

const OWNER = "[A-Za-z0-9][A-Za-z0-9-]*";
const NAME = "[A-Za-z0-9_.-]+";
/** A query or a fragment: up to a space, a bracket, a comma or a semicolon; no trailing dot. */
const TAIL = "(?:[^\\s)>\\],;.]|\\.(?![\\s)>\\],;.]|$))*";

/**
 * One pass over the text, leftmost match first. Groups: 1-3 a URL's owner, name, number;
 * 4-6 `owner/name#N`; 7-8 `name#N`; 9 a bare `#N`. The URL takes `/files`, a query and a
 * fragment; the short forms must not follow a word, a slash or a dot, so `C#` and a path
 * like `a/b#1` inside a longer token stay prose.
 */
const REFERENCE = new RegExp(
    [
        `https?://(?:www\\.)?github\\.com/(${OWNER})/(${NAME})/pull/(\\d+)` +
            `(?:/[\\w./-]*)?(?:\\?${TAIL})?(?:#${TAIL})?`,
        `(?<![\\w/.-])(${OWNER})/(${NAME})#(\\d+)\\b`,
        `(?<![\\w/.-])(${NAME})#(\\d+)\\b`,
        `(?<![\\w/#])#(\\d+)\\b`,
    ].join("|"),
    "g",
);

/** Pure: every reference in `text`, resolved against `repos`, and the text without them. */
export function extract_refs(text: string, repos: readonly ExtractRepo[]): Extraction {
    assert.ok(repos.length <= 100, "a project has at most 100 repos");
    const refs: ExtractRef[] = [];
    const seen = new Set<string>();
    let rest = "";
    let cursor = 0;
    for (const match of text.matchAll(REFERENCE)) {
        rest += text.slice(cursor, match.index);
        cursor = match.index + match[0].length;
        if (refs.length >= EXTRACT_REFS_MAX) {
            continue;
        }
        const ref = resolve_match(match, repos);
        const identity =
            ref.owner === null || ref.name === null
                ? `ref:${ref.ref}`
                : `${ref.owner}/${ref.name}#${ref.number}`.toLowerCase();
        if (seen.has(identity)) {
            continue;
        }
        seen.add(identity);
        refs.push(ref);
    }
    rest += text.slice(cursor);
    return { refs, rest: clean_rest(rest) };
}

function resolve_match(match: RegExpMatchArray, repos: readonly ExtractRepo[]): ExtractRef {
    const ref = match[0];
    const [, u_owner, u_name, u_number, o_owner, o_name, o_number, r_name, r_number, bare] =
        match;
    if (u_owner !== undefined && u_name !== undefined && u_number !== undefined) {
        return resolve_full(ref, u_owner, u_name, Number(u_number), repos);
    }
    if (o_owner !== undefined && o_name !== undefined && o_number !== undefined) {
        return resolve_full(ref, o_owner, o_name, Number(o_number), repos);
    }
    if (r_name !== undefined && r_number !== undefined) {
        return resolve_short(ref, r_name, Number(r_number), repos);
    }
    assert.ok(bare !== undefined, "the pattern matched one of its four forms");
    return resolve_bare(ref, Number(bare), repos);
}

/** `owner/name#N`: the repo of the project with that name and, when known, that owner. */
function resolve_full(
    ref: string,
    owner: string,
    name: string,
    number: number,
    repos: readonly ExtractRepo[],
): ExtractRef {
    const repo = repos.find(
        (entry) =>
            entry.name.toLowerCase() === name.toLowerCase() &&
            (entry.owner === null || entry.owner.toLowerCase() === owner.toLowerCase()),
    );
    if (repo === undefined) {
        return {
            ref,
            owner,
            name,
            number,
            key: null,
            reason: `${owner}/${name} is not a repo of the project; no worktree for it`,
        };
    }
    return { ref, owner, name, number, key: repo.key, reason: null };
}

/** `name#N`: `name` is a repo key or a GitHub repo name of the project. */
function resolve_short(
    ref: string,
    name: string,
    number: number,
    repos: readonly ExtractRepo[],
): ExtractRef {
    const lower = name.toLowerCase();
    const repo = repos.find(
        (entry) => entry.key.toLowerCase() === lower || entry.name.toLowerCase() === lower,
    );
    if (repo === undefined) {
        return {
            ref,
            owner: null,
            name: null,
            number,
            key: null,
            reason: `\`${name}\` is not a repo of the project; write owner/repo#N`,
        };
    }
    if (repo.owner === null) {
        return {
            ref,
            owner: null,
            name: repo.name,
            number,
            key: repo.key,
            reason: `the GitHub owner of \`${repo.key}\` is unknown; write owner/repo#N`,
        };
    }
    return { ref, owner: repo.owner, name: repo.name, number, key: repo.key, reason: null };
}

/** `#N`: the project's one repo; ambiguous with several, unresolved with none. */
function resolve_bare(ref: string, number: number, repos: readonly ExtractRepo[]): ExtractRef {
    const unresolved = { ref, owner: null, name: null, number, key: null };
    if (repos.length === 0) {
        return { ...unresolved, reason: `${ref} needs a project repo; write owner/repo#N` };
    }
    if (repos.length > 1) {
        const keys = repos.map((repo) => repo.key).join(" or ");
        return { ...unresolved, reason: `${ref} could be ${keys}; write repo#N` };
    }
    const only = repos[0];
    assert.ok(only !== undefined);
    return resolve_short(ref, only.key, number, repos);
}

/** Lines trimmed, blank runs collapsed to one, no leading or trailing blank line. */
function clean_rest(text: string): string {
    const lines = text.split("\n").map((line) => line.replace(/\s+/g, " ").trim());
    const out: string[] = [];
    for (const line of lines) {
        if (line.length === 0 && (out.length === 0 || out[out.length - 1] === "")) {
            continue;
        }
        out.push(line);
    }
    while (out.length > 0 && out[out.length - 1] === "") {
        out.pop();
    }
    return out.join("\n");
}

/**
 * The title a session gets from a paste before the lead sets one: the first non-empty line
 * of the text without its references, cut to `SESSION_TITLE_MAX`, else the first PR's title,
 * else `New session`.
 */
export function provisional_title(rest: string, pr_title: string | null): string {
    const line = rest.split("\n").find((entry) => entry.trim().length > 0)?.trim() ?? "";
    if (line.length > 0) {
        return line.slice(0, SESSION_TITLE_MAX);
    }
    if (pr_title !== null && pr_title.trim().length > 0) {
        return pr_title.trim().slice(0, SESSION_TITLE_MAX);
    }
    return "New session";
}

export interface ExtractLookupDeps {
    gh: GhRunner;
    /** The bound on the whole batch; `EXTRACT_TIMEOUT_MS` when absent. */
    timeout_ms?: number;
}

/**
 * `extract_refs`, then one GitHub lookup per resolved reference, all at once, under one
 * bound. An entry whose lookup fails or does not answer in time carries the reason and is
 * not adoptable; the others are adoptable when the repo is in the project.
 */
export async function extract_prs(
    text: string,
    repos: readonly ExtractRepo[],
    deps: ExtractLookupDeps,
): Promise<ExtractResponse> {
    const { refs, rest } = extract_refs(text, repos);
    const timeout_ms = deps.timeout_ms ?? EXTRACT_TIMEOUT_MS;
    const lookups = refs.map((ref) => lookup(ref, deps.gh));
    const results = await Promise.all(
        lookups.map((promise) => within(promise, timeout_ms)),
    );
    const prs: ExtractedPr[] = [];
    for (const [index, ref] of refs.entries()) {
        const result = results[index];
        assert.ok(result !== undefined);
        prs.push(to_extracted(ref, result));
    }
    return { prs, rest };
}

type Lookup =
    | { ok: true; node: PrResponse["data"]["repository"]["pullRequest"] }
    | { ok: false; reason: string }
    | null;

/** Null when the reference has no repo to ask about. */
async function lookup(ref: ExtractRef, gh: GhRunner): Promise<Lookup> {
    if (ref.owner === null || ref.name === null) {
        return null;
    }
    try {
        const response = await fetch_pr_response(gh, {
            owner: ref.owner,
            name: ref.name,
            number: ref.number,
        });
        return { ok: true, node: response.data.repository.pullRequest };
    } catch (error) {
        return { ok: false, reason: lookup_reason(ref, error) };
    }
}

/** The one line a person needs; `gh` prints the whole query before its own message. */
function lookup_reason(ref: ExtractRef, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Could not resolve to a PullRequest")) {
        return `no PR #${ref.number} in ${ref.owner}/${ref.name}`;
    }
    if (message.includes("Could not resolve to a Repository")) {
        return `no repository ${ref.owner}/${ref.name}, or no access to it`;
    }
    const last = message.trim().split("\n").filter((line) => line.trim() !== "").at(-1);
    return last === undefined ? message : last.replace(/^gh: /, "");
}

/** The lookup's answer, or a timeout reason once `timeout_ms` passed. */
function within(promise: Promise<Lookup>, timeout_ms: number): Promise<Lookup> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const late = new Promise<Lookup>((resolve) => {
        timer = setTimeout(
            () => resolve({ ok: false, reason: `GitHub did not answer in ${timeout_ms / 1000} s` }),
            timeout_ms,
        );
    });
    return Promise.race([promise, late]).finally(() => {
        if (timer !== null) {
            clearTimeout(timer);
        }
    });
}

function to_extracted(ref: ExtractRef, result: Lookup): ExtractedPr {
    const repo = ref.owner === null || ref.name === null ? null : `${ref.owner}/${ref.name}`;
    const url = repo === null ? null : `https://github.com/${repo}/pull/${ref.number}`;
    const base: ExtractedPr = {
        ref: ref.ref,
        url,
        repo,
        key: ref.key,
        number: ref.number,
        title: null,
        branch: null,
        base: null,
        adoptable: false,
    };
    if (result === null) {
        return { ...base, reason: ref.reason ?? "the reference did not resolve to a repo" };
    }
    if (!result.ok) {
        return { ...base, reason: result.reason };
    }
    const facts = {
        title: result.node.title,
        branch: result.node.headRefName,
        base: result.node.baseRefName,
    };
    if (ref.reason !== null) {
        return { ...base, ...facts, reason: ref.reason };
    }
    assert.ok(ref.key !== null, "a reference without a reason has a project repo");
    return { ...base, ...facts, adoptable: true };
}
