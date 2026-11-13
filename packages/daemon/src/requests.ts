// Parsers for the JSON bodies of the POST routes. Each returns the typed request or one
// sentence that names the first problem, which the route sends back as a 400.
import type {
    PlanImplementRequest,
    AddAgentRequest,
    AdoptRequest,
    AgentMessageRequest,
    ExtractRequest,
    NewSessionRequest,
    ReviewsRequest,
    SessionAdoptRequest,
    SessionTitleRequest,
    UpRequest,
    VerifyRequest,
} from "@spinner/protocol";
import { SESSION_TITLE_MAX } from "@spinner/protocol";

/** Upper bound on PR URLs in one adopt request; `adopt_prs` has the same limit. */
const ADOPT_URLS_MAX = 20;

/** Upper bound on a paste; a longer one belongs in a file the lead reads. */
const EXTRACT_TEXT_MAX = 100_000;

/** `title` or `text` (s014, a paste) is required; `adopt` lists PR URLs from an extract. */
export function parse_new_session(input: unknown): NewSessionRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const title = non_empty_string(record, "title");
    const text = non_empty_string(record, "text");
    if (title === undefined && text === undefined) {
        return "`title` or `text` must be a non-empty string";
    }
    const request: NewSessionRequest = {};
    if (title !== undefined) {
        request.title = title;
    }
    if (text !== undefined) {
        request.text = text;
    }
    const adopt = record["adopt"];
    if (adopt !== undefined) {
        const urls = Array.isArray(adopt) ? adopt : null;
        if (urls === null || !urls.every((url) => typeof url === "string" && url.length > 0)) {
            return "`adopt` must be an array of pull request URLs when given";
        }
        if (urls.length > ADOPT_URLS_MAX) {
            return `\`adopt\` holds more than ${ADOPT_URLS_MAX} entries`;
        }
        request.adopt = urls as string[];
    }
    const slug = optional_string(record, "slug");
    if (typeof slug === "string") {
        request.slug = slug;
    } else if (slug !== undefined) {
        return "`slug` must be a non-empty string when given";
    }
    const project = optional_string(record, "project");
    if (typeof project === "string") {
        request.project = project;
    } else if (project !== undefined) {
        return "`project` must be a non-empty string when given";
    }
    const track = record["track"];
    if (track !== undefined) {
        if (track !== "design" && track !== "direct") {
            return "`track` must be one of design, direct when given";
        }
        request.track = track;
    }
    if (record["plan"] !== undefined) {
        if (typeof record["plan"] !== "boolean") {
            return "`plan` must be a boolean when given";
        }
        request.plan = record["plan"];
    }
    return request;
}

/** `POST /plans/:id/implement`: the session that implements the plan, or a new one. */
export function parse_plan_implement(input: unknown): PlanImplementRequest | string {
    if (input === undefined || input === null) {
        return {};
    }
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const request: PlanImplementRequest = {};
    for (const key of ["session", "project"] as const) {
        const value = record[key];
        if (value === undefined) {
            continue;
        }
        if (typeof value !== "string" || value.length === 0) {
            return `\`${key}\` must be a non-empty string when given`;
        }
        request[key] = value;
    }
    return request;
}

/** `POST /sessions/extract`: the paste and, optionally, the project to resolve against. */
export function parse_extract(input: unknown): ExtractRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const text = record["text"];
    if (typeof text !== "string") {
        return "`text` must be a string";
    }
    if (text.length > EXTRACT_TEXT_MAX) {
        return `\`text\` is longer than ${EXTRACT_TEXT_MAX} characters`;
    }
    const request: ExtractRequest = { text };
    const project = optional_string(record, "project");
    if (typeof project === "string") {
        request.project = project;
    } else if (project !== undefined) {
        return "`project` must be a non-empty string when given";
    }
    return request;
}

/** `POST /sessions/:dir/adopt`: PR references in any form the extract takes. */
export function parse_session_adopt(input: unknown): SessionAdoptRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const refs = record["refs"];
    if (!Array.isArray(refs) || refs.length === 0) {
        return "`refs` must be a non-empty array of pull request references";
    }
    if (refs.length > ADOPT_URLS_MAX) {
        return `\`refs\` holds more than ${ADOPT_URLS_MAX} entries`;
    }
    if (!refs.every((ref) => typeof ref === "string" && ref.trim().length > 0)) {
        return "`refs` must hold non-empty strings";
    }
    return { refs: refs as string[] };
}

/** `POST /reviews` (s015): a paste with PR references. */
export function parse_reviews(input: unknown): ReviewsRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const text = non_empty_string(record, "text");
    if (text === undefined) {
        return "`text` is required: the PR references to review";
    }
    if (text.length > EXTRACT_TEXT_MAX) {
        return `\`text\` is longer than ${EXTRACT_TEXT_MAX} characters`;
    }
    return { text };
}

/** `PUT /sessions/:dir/title`: a title, a pin flag, or both (dogfood #27). */
export function parse_session_title(input: unknown): SessionTitleRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const pinned = record["pinned"];
    if (pinned !== undefined && typeof pinned !== "boolean") {
        return "`pinned` must be a boolean";
    }
    if (record["title"] === undefined) {
        return pinned === undefined ? "`title` or `pinned` must be given" : { pinned };
    }
    const title = non_empty_string(record, "title");
    if (title === undefined) {
        return "`title` must be a non-empty string";
    }
    if (title.includes("\n") || title.trim().length > SESSION_TITLE_MAX) {
        return `\`title\` must be one line of at most ${SESSION_TITLE_MAX} characters`;
    }
    return pinned === undefined ? { title: title.trim() } : { title: title.trim(), pinned };
}

export function parse_adopt(input: unknown): AdoptRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const urls = record["urls"];
    if (!Array.isArray(urls) || urls.length === 0) {
        return "`urls` must be a non-empty array of pull request URLs";
    }
    if (urls.length > ADOPT_URLS_MAX) {
        return `\`urls\` holds more than ${ADOPT_URLS_MAX} entries`;
    }
    if (!urls.every((url) => typeof url === "string" && url.length > 0)) {
        return "`urls` must hold non-empty strings";
    }
    const request: AdoptRequest = { urls: urls as string[] };
    const project = optional_string(record, "project");
    if (typeof project === "string") {
        request.project = project;
    } else if (project !== undefined) {
        return "`project` must be a non-empty string when given";
    }
    const title = optional_string(record, "title");
    if (typeof title === "string") {
        request.title = title;
    } else if (title !== undefined) {
        return "`title` must be a non-empty string when given";
    }
    return request;
}

/** An empty or absent body means the defaults. */
export function parse_up(input: unknown): UpRequest | string {
    if (input === undefined || input === null) {
        return {};
    }
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const request: UpRequest = {};
    const build = record["build"];
    if (build !== undefined) {
        if (typeof build !== "boolean") {
            return "`build` must be a boolean when given";
        }
        request.build = build;
    }
    const change = record["change"];
    if (change !== undefined) {
        if (typeof change !== "string" || change.length === 0) {
            return "`change` must be the id of a change when given";
        }
        request.change = change;
    }
    return request;
}

export function parse_verify(input: unknown): VerifyRequest | string {
    if (input === undefined || input === null) {
        return {};
    }
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const by = optional_string(record, "by");
    if (typeof by === "string") {
        return { by };
    }
    if (by !== undefined) {
        return "`by` must be a non-empty string when given";
    }
    return {};
}

export function parse_add_agent(input: unknown): AddAgentRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const name = non_empty_string(record, "name");
    if (name === undefined || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
        return "`name` must be lower-case letters, digits and dashes";
    }
    const request: AddAgentRequest = { name };
    const model = optional_string(record, "model");
    if (typeof model === "string") {
        request.model = model;
    } else if (model !== undefined) {
        return "`model` must be a non-empty string when given";
    }
    const repo = optional_string(record, "repo");
    if (typeof repo === "string") {
        request.repo = repo;
    } else if (repo !== undefined) {
        return "`repo` must be a non-empty string when given";
    }
    const brief = optional_string(record, "brief");
    if (typeof brief === "string") {
        request.brief = brief;
    } else if (brief !== undefined) {
        return "`brief` must be a non-empty string when given";
    }
    const message = optional_string(record, "message");
    if (typeof message === "string") {
        request.message = message;
    } else if (message !== undefined) {
        return "`message` must be a non-empty string when given";
    }
    return request;
}

export function parse_agent_message(input: unknown): AgentMessageRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const text = non_empty_string(record, "text");
    if (text === undefined) {
        return "`text` must be a non-empty string";
    }
    // The UI's message box marks the operator's own steers for the outcome counter (6.20).
    if (record.source === undefined) {
        return { text };
    }
    if (record.source !== "operator") {
        return 'source must be "operator" when given';
    }
    return { text, source: "operator" };
}

function as_record(input: unknown): Record<string, unknown> | string {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return "request body must be a JSON object";
    }
    return input as Record<string, unknown>;
}

function non_empty_string(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** The string, `undefined` when absent, or `null` when present but not a usable string. */
function optional_string(record: Record<string, unknown>, key: string): string | undefined | null {
    const value = record[key];
    if (value === undefined) {
        return undefined;
    }
    return typeof value === "string" && value.length > 0 ? value : null;
}
