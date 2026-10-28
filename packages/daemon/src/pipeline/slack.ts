// The Slack client behind `spinner post` and the reviewer-activity poll. The real client
// uses the operator's user token from `SLACK_USER_TOKEN` (environment only, never a file)
// and Slack's Web API over `fetch`. Without the token, a fixture client stands in: it records
// the post under the session's `artifacts/` and serves canned replies from
// `test/fixtures/slack/`, so the whole loop runs on a machine with no Slack (s005 Contracts).
// Nothing here posts on its own: `post_message` is called only after the operator confirmed.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SLACK_TOKEN_ENV = "SLACK_USER_TOKEN";

export type SlackTransport = "slack" | "fixture";

export interface SlackPostResult {
    /** Message timestamp, Slack's id for the message within the channel. */
    ts: string;
    /** `https://<team>.slack.com/archives/<channel>/p<ts>`, what `pipeline.slack_post` stores. */
    permalink: string;
}

export interface SlackReply {
    user: string;
    text: string;
    ts: string;
}

export interface SlackReaction {
    name: string;
    count: number;
}

export interface SlackThreadActivity {
    replies: SlackReply[];
    reactions: SlackReaction[];
}

export interface SlackClient {
    transport: SlackTransport;
    post(channel: string, text: string): Promise<SlackPostResult>;
    activity(channel: string, ts: string): Promise<SlackThreadActivity>;
}

/** The real client when the token is set, else the fixture. */
export function slack_client_from_env(
    env: NodeJS.ProcessEnv,
    fixture_record_dir: string,
): SlackClient {
    const token = env[SLACK_TOKEN_ENV];
    if (token !== undefined && token.length > 0) {
        return web_api_client(token);
    }
    return fixture_client(fixture_record_dir);
}

/** Upper bound on replies read under one post; a review thread has a handful. */
const REPLIES_MAX = 200;

const SLACK_API = "https://slack.com/api";

interface SlackEnvelope {
    ok: boolean;
    error?: string;
    ts?: string;
    permalink?: string;
    messages?: { user?: string; text?: string; ts: string; reactions?: SlackReaction[] }[];
}

function web_api_client(token: string): SlackClient {
    const call = async (method: string, body: Record<string, string>): Promise<SlackEnvelope> => {
        const response = await fetch(`${SLACK_API}/${method}`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams(body).toString(),
        });
        const parsed = (await response.json()) as SlackEnvelope;
        if (!parsed.ok) {
            throw new Error(`slack ${method}: ${parsed.error ?? `HTTP ${response.status}`}`);
        }
        return parsed;
    };
    return {
        transport: "slack",
        post: async (channel, text) => {
            const posted = await call("chat.postMessage", { channel, text, unfurl_links: "false" });
            assert.ok(posted.ts !== undefined, "chat.postMessage returned no ts");
            const link = await call("chat.getPermalink", { channel, message_ts: posted.ts });
            assert.ok(link.permalink !== undefined, "chat.getPermalink returned no permalink");
            return { ts: posted.ts, permalink: link.permalink };
        },
        activity: async (channel, ts) => {
            const thread = await call("conversations.replies", {
                channel,
                ts,
                limit: String(REPLIES_MAX),
            });
            const messages = thread.messages ?? [];
            const [root, ...rest] = messages;
            return {
                replies: rest.map((m) => ({ user: m.user ?? "?", text: m.text ?? "", ts: m.ts })),
                reactions: root?.reactions ?? [],
            };
        },
    };
}

const here = dirname(fileURLToPath(import.meta.url));

/** Canned replies the fixture serves after a post: `test/fixtures/slack/replies.json`. */
export const SLACK_FIXTURE_DIR = resolve(here, "..", "..", "test", "fixtures", "slack");

export const FIXTURE_POST_FILE = "slack-post.json";

interface FixturePost {
    channel: string;
    text: string;
    ts: string;
    permalink: string;
    posted_at: string;
}

/**
 * Records the post in `<record_dir>/slack-post.json` and answers activity from the canned
 * replies file, so a post without a token leaves a readable trace and the board can show
 * reviewer activity in a test.
 */
export function fixture_client(
    record_dir: string,
    now: () => Date = () => new Date(),
): SlackClient {
    return {
        transport: "fixture",
        post: async (channel, text) => {
            const at = now();
            const ts = `${Math.floor(at.getTime() / 1000)}.000100`;
            const host = "https://fixture.slack.invalid";
            const permalink = `${host}/archives/${channel}/p${ts.replace(".", "")}`;
            const posted_at = at.toISOString();
            const record: FixturePost = { channel, text, ts, permalink, posted_at };
            mkdirSync(record_dir, { recursive: true });
            const path = join(record_dir, FIXTURE_POST_FILE);
            writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
            return { ts, permalink };
        },
        activity: async () => {
            const path = join(SLACK_FIXTURE_DIR, "replies.json");
            if (!existsSync(path)) {
                return { replies: [], reactions: [] };
            }
            return JSON.parse(readFileSync(path, "utf8")) as SlackThreadActivity;
        },
    };
}

/** `channel` and `ts` from a permalink, for the activity poll. Null for anything else. */
export function parse_permalink(permalink: string): { channel: string; ts: string } | null {
    const match = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:[?#].*)?$/.exec(permalink.trim());
    if (match === null) {
        return null;
    }
    const [, channel, seconds, micros] = match;
    assert.ok(channel !== undefined && seconds !== undefined && micros !== undefined);
    return { channel, ts: `${seconds}.${micros}` };
}
