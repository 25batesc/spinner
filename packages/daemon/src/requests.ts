// Parsers for the JSON bodies of the POST routes. Each returns the typed request or one
// sentence that names the first problem, which the route sends back as a 400.
import type {
    AddAgentRequest,
    AdoptRequest,
    AgentMessageRequest,
    NewSessionRequest,
    UpRequest,
    VerifyRequest,
} from "@spinner/protocol";

/** Upper bound on PR URLs in one adopt request; `adopt_prs` has the same limit. */
const ADOPT_URLS_MAX = 20;

export function parse_new_session(input: unknown): NewSessionRequest | string {
    const record = as_record(input);
    if (typeof record === "string") {
        return record;
    }
    const title = non_empty_string(record, "title");
    if (title === undefined) {
        return "`title` must be a non-empty string";
    }
    const request: NewSessionRequest = { title };
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
    return request;
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
    const build = record["build"];
    if (build === undefined) {
        return {};
    }
    if (typeof build !== "boolean") {
        return "`build` must be a boolean when given";
    }
    return { build };
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
    return { text };
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
