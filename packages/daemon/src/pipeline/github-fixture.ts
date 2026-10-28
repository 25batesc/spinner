// A GitHub stand-in for a daemon without `gh`: `SPINNER_GITHUB_FIXTURE=<dir>` makes `spinnerd`
// answer every PR query from `<dir>/pr-<number>.json` (the scrubbed shape of
// `test/fixtures/github/`), or from `<dir>/default.json` when no file matches, and apply
// every write to `<dir>/state.json` instead of GitHub: a reply shows up as a comment, a
// resolve as `isResolved`, an approval as an APPROVED review on the head, an enqueue as a
// queue entry that merges on the next look. `<dir>/writes.log` lists every write. The UI's
// end-to-end run and the extension's tool tests drive the real routes this way (s005, item 8
// deferred until the operator names a throwaway repo).
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GhRunner, PrResponse } from "./github.js";
import type { GithubWriter } from "./github-write.js";

export interface GithubFixture {
    gh: GhRunner;
    writer: GithubWriter;
}

/** Upper bound on bytes of one fixture file; a real response is a few hundred KB. */
const FIXTURE_BYTES_MAX = 8 * 1024 * 1024;

/** What the writes changed, kept between calls in `state.json`. */
interface FixtureState {
    next_number: number;
    replies: Record<string, { login: string; body: string }[]>;
    resolved: string[];
    /** PR number to head SHA the owner approved. */
    approved: Record<number, string>;
    /** PR numbers in the queue, with the number of looks since the enqueue. */
    queued: Record<number, number>;
    merged: number[];
}

const STATE_EMPTY: FixtureState = {
    next_number: 100,
    replies: {},
    resolved: [],
    approved: {},
    queued: {},
    merged: [],
};

export function github_fixture(dir: string, owner_login = "owner-1"): GithubFixture {
    assert.ok(dir.length > 0, "fixture dir must not be empty");
    mkdirSync(dir, { recursive: true });
    const store = new StateStore(dir);
    const gh: GhRunner = async (args) => {
        if (args[0] === "api" && args[1] === "user") {
            return `${owner_login}\n`;
        }
        if (args[0] === "api" && args[1] === "graphql") {
            return JSON.stringify(store.response(number_arg(args), owner_login));
        }
        if (args[0] === "pr" && args[1] === "view") {
            return store.pr_view(args, owner_login);
        }
        throw new Error(`github fixture: no answer for gh ${args.join(" ")}`);
    };
    const writer: GithubWriter = {
        gh: async (args) => {
            store.record(`gh ${args.map(short).join(" ")}`);
            return store.apply_gh(args, owner_login);
        },
        git: async (cwd, args) => {
            store.record(`git -C ${cwd} ${args.join(" ")}`);
            return fake_git(args);
        },
    };
    return { gh, writer };
}

function fake_git(args: string[]): string {
    if (args[0] === "remote") {
        return "https://github.com/acme/backend.git\n";
    }
    if (args[0] === "rev-list") {
        return "1\n";
    }
    if (args[0] === "rev-parse") {
        return "fixturefixturefixturefixturefixturefixture\n";
    }
    return "";
}

class StateStore {
    private readonly path: string;
    private readonly log: string;

    constructor(private readonly dir: string) {
        this.path = join(dir, "state.json");
        this.log = join(dir, "writes.log");
    }

    record(line: string): void {
        appendFileSync(this.log, `${new Date().toISOString()} ${line}\n`);
    }

    private read(): FixtureState {
        if (!existsSync(this.path)) {
            return structuredClone(STATE_EMPTY);
        }
        return { ...structuredClone(STATE_EMPTY), ...read_json<FixtureState>(this.path) };
    }

    private write(state: FixtureState): void {
        writeFileSync(this.path, `${JSON.stringify(state, null, 2)}\n`);
    }

    /** The PR's response with the recorded writes applied. */
    response(number: number, owner_login: string): PrResponse {
        const state = this.read();
        const response = base_response(this.dir, number);
        const node = response.data.repository.pullRequest;
        const head = node.headRefOid;
        for (const thread of node.reviewThreads.nodes) {
            for (const reply of state.replies[thread.id] ?? []) {
                thread.comments.nodes.push({
                    id: `PRRC_fixture_${thread.comments.nodes.length}`,
                    author: { login: reply.login },
                    body: reply.body,
                    createdAt: new Date().toISOString(),
                });
            }
            if (state.resolved.includes(thread.id)) {
                thread.isResolved = true;
            }
        }
        if (state.approved[number] === head) {
            node.reviews.nodes.push({
                author: { login: owner_login },
                state: "APPROVED",
                submittedAt: new Date().toISOString(),
                commit: { oid: head },
            });
        }
        const looks = state.queued[number];
        if (looks !== undefined) {
            // The first look after the enqueue sees the entry; the second sees the merge.
            if (looks >= 1) {
                delete state.queued[number];
                state.merged.push(number);
            } else {
                state.queued[number] = looks + 1;
                node.mergeQueueEntry = { state: "QUEUED", position: 1 };
            }
            this.write(state);
        }
        if (state.merged.includes(number)) {
            node.state = "MERGED";
            node.mergeQueueEntry = null;
        }
        return response;
    }

    pr_view(args: string[], owner_login: string): string {
        if (args.includes(".id")) {
            return "PR_fixture\n";
        }
        const url = args[2] ?? "";
        const number = Number.parseInt(url.split("/").pop() ?? "0", 10);
        const node = this.response(number, owner_login).data.repository.pullRequest;
        const files = Math.max(node.reviewThreads.totalCount, 1);
        return JSON.stringify({ additions: 10, deletions: 2, changedFiles: files });
    }

    /** Applies one `gh` write and answers what `gh` would print. */
    apply_gh(args: string[], owner_login: string): string {
        const state = this.read();
        if (args[0] === "pr" && args[1] === "create") {
            const repo = args[args.indexOf("--repo") + 1] ?? "acme/backend";
            const number = state.next_number;
            state.next_number += 1;
            this.write(state);
            return `https://github.com/${repo}/pull/${number}\n`;
        }
        if (args[0] === "pr" && args[1] === "review") {
            const number = Number.parseInt((args[2] ?? "").split("/").pop() ?? "0", 10);
            const node = this.response(number, owner_login).data.repository.pullRequest;
            state.approved[number] = node.headRefOid;
            this.write(state);
            return "";
        }
        if (args[0] === "pr" && args[1] === "merge") {
            const number = Number.parseInt((args[2] ?? "").split("/").pop() ?? "0", 10);
            state.merged.push(number);
            this.write(state);
            return "";
        }
        if (args[0] === "api" && args[1] === "graphql") {
            this.apply_mutation(state, args);
            this.write(state);
            return "{}";
        }
        throw new Error(`github fixture: unknown write gh ${args.join(" ")}`);
    }

    private apply_mutation(state: FixtureState, args: string[]): void {
        const query = field(args, "query") ?? "";
        const id = field(args, "id") ?? "";
        if (query.includes("addPullRequestReviewThreadReply")) {
            const body = field(args, "body") ?? "";
            state.replies[id] = [...(state.replies[id] ?? []), { login: "owner-1", body }];
            return;
        }
        if (query.includes("resolveReviewThread")) {
            if (!state.resolved.includes(id)) {
                state.resolved.push(id);
            }
            return;
        }
        if (query.includes("enqueuePullRequest")) {
            // The enqueue names a node id and a head, not a number; the fixture has one PR
            // in flight at a time, the last one created.
            state.queued[state.next_number - 1] = 0;
            return;
        }
        throw new Error(`github fixture: unknown mutation ${query.slice(0, 40)}`);
    }
}

function field(args: string[], name: string): string | undefined {
    const prefix = `${name}=`;
    return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function number_arg(args: string[]): number {
    return Number.parseInt(field(args, "number") ?? "0", 10);
}

function short(arg: string): string {
    return arg.length > 80 ? `${arg.slice(0, 77)}...` : arg;
}

/** `pr-<n>.json`, else `default.json` with its number rewritten to `n`. */
function base_response(dir: string, number: number): PrResponse {
    const exact = join(dir, `pr-${number}.json`);
    if (existsSync(exact)) {
        return read_json<PrResponse>(exact);
    }
    const fallback = join(dir, "default.json");
    if (!existsSync(fallback)) {
        throw new Error(`github fixture: no ${exact} and no ${fallback}`);
    }
    const response = read_json<PrResponse>(fallback);
    const node = response.data.repository.pullRequest;
    node.number = number;
    node.url = node.url.replace(/\/pull\/\d+$/, `/pull/${number}`);
    return response;
}

function read_json<T>(path: string): T {
    const text = readFileSync(path, "utf8");
    assert.ok(text.length <= FIXTURE_BYTES_MAX, `${path} is over ${FIXTURE_BYTES_MAX} bytes`);
    return JSON.parse(text) as T;
}
