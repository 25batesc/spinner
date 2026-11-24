// Linear's GraphQL API as `LinearApi` (`linear.ts`). One POST per call to
// `https://api.linear.app/graphql`, with the personal API key as the `Authorization` header.
// The key comes from `LINEAR_API_KEY` in the daemon's environment (`<home>/env`); it is
// never logged and never written to a session. A failed call throws with Linear's message.
import assert from "node:assert/strict";
import type {
    LinearApi,
    LinearIssue,
    LinearIssueChange,
    LinearIssueInput,
    LinearTeam,
} from "./linear.js";

export const LINEAR_URL = "https://api.linear.app/graphql";
/** A call that takes longer is given up; the next poll round tries again. */
const LINEAR_TIMEOUT_MS = 20_000;
/** A team's states and labels are read again after this long. */
const TEAM_CACHE_MS = 10 * 60_000;

/** `fetch`, or a test's stand-in for it. */
export type LinearTransport = (
    url: string,
    init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const ISSUE = "id identifier url title state { name type } parent { identifier }";

interface IssueNode {
    id: string;
    identifier: string;
    url: string;
    title: string;
    state: { name: string; type: string };
    parent: { identifier: string } | null;
}

function issue_of(node: IssueNode): LinearIssue {
    return {
        id: node.id,
        identifier: node.identifier,
        url: node.url,
        title: node.title,
        state: node.state,
        parent: node.parent?.identifier ?? null,
    };
}

export function linear_client(key: string, transport: LinearTransport = fetch): LinearApi {
    assert.ok(key.length > 0, "a Linear client needs an API key");
    const teams = new Map<string, { at: number; team: LinearTeam }>();

    async function call<Data>(query: string, variables: Record<string, unknown>): Promise<Data> {
        const response = await transport(LINEAR_URL, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: key },
            body: JSON.stringify({ query, variables }),
            signal: AbortSignal.timeout(LINEAR_TIMEOUT_MS),
        });
        const text = await response.text();
        let parsed: { data?: Data; errors?: { message?: string }[] };
        try {
            parsed = JSON.parse(text) as typeof parsed;
        } catch {
            throw new Error(`Linear answered ${response.status}: ${text.slice(0, 200)}`);
        }
        const first = parsed.errors?.[0]?.message;
        if (first !== undefined || parsed.data === undefined || !response.ok) {
            throw new Error(`Linear: ${first ?? `status ${response.status}`}`);
        }
        return parsed.data;
    }

    return {
        async team(team_key) {
            const known = teams.get(team_key);
            if (known !== undefined && Date.now() - known.at < TEAM_CACHE_MS) {
                return known.team;
            }
            const data = await call<{
                viewer: { id: string };
                teams: { nodes: { id: string; states: { nodes: LinearTeam["states"] } }[] };
                issueLabels: { nodes: LinearTeam["labels"] };
            }>(
                `query Team($key: String!) {
                    viewer { id }
                    teams(filter: { key: { eq: $key } }) {
                        nodes { id states { nodes { id name type } } }
                    }
                    issueLabels(first: 250, filter: { or: [
                        { team: { key: { eq: $key } } }, { team: { null: true } }
                    ] }) { nodes { id name } }
                }`,
                { key: team_key },
            );
            const node = data.teams.nodes[0];
            if (node === undefined) {
                throw new Error(`Linear has no team with the key ${team_key}`);
            }
            const team: LinearTeam = {
                id: node.id,
                viewer_id: data.viewer.id,
                states: node.states.nodes,
                labels: data.issueLabels.nodes,
            };
            teams.set(team_key, { at: Date.now(), team });
            return team;
        },

        async issue_for_url(url) {
            const data = await call<{ attachmentsForURL: { nodes: { issue: IssueNode }[] } }>(
                `query ForUrl($url: String!) {
                    attachmentsForURL(url: $url, first: 1) { nodes { issue { ${ISSUE} } } }
                }`,
                { url },
            );
            const node = data.attachmentsForURL.nodes[0];
            return node === undefined ? null : issue_of(node.issue);
        },

        async issue(id) {
            try {
                const data = await call<{ issue: IssueNode | null }>(
                    `query Issue($id: String!) { issue(id: $id) { ${ISSUE} } }`,
                    { id },
                );
                return data.issue === null ? null : issue_of(data.issue);
            } catch (error) {
                // Linear answers a deleted issue with an error, not with null.
                if (error instanceof Error && /not found/i.test(error.message)) {
                    return null;
                }
                throw error;
            }
        },

        async create_issue(input: LinearIssueInput) {
            const data = await call<{ issueCreate: { success: boolean; issue: IssueNode } }>(
                `mutation Create($input: IssueCreateInput!) {
                    issueCreate(input: $input) { success issue { ${ISSUE} } }
                }`,
                {
                    input: {
                        teamId: input.team_id,
                        title: input.title,
                        description: input.description,
                        stateId: input.state_id,
                        assigneeId: input.assignee_id,
                        labelIds: input.label_ids,
                        ...(input.parent_id === null ? {} : { parentId: input.parent_id }),
                    },
                },
            );
            assert.ok(data.issueCreate.success, "Linear did not create the issue");
            return issue_of(data.issueCreate.issue);
        },

        async update_issue(id, change: LinearIssueChange) {
            const input: Record<string, string> = {};
            if (change.title !== undefined) {
                input["title"] = change.title;
            }
            if (change.description !== undefined) {
                input["description"] = change.description;
            }
            if (change.state_id !== undefined) {
                input["stateId"] = change.state_id;
            }
            if (change.parent_id !== undefined) {
                input["parentId"] = change.parent_id;
            }
            const data = await call<{ issueUpdate: { success: boolean } }>(
                `mutation Update($id: String!, $input: IssueUpdateInput!) {
                    issueUpdate(id: $id, input: $input) { success }
                }`,
                { id, input },
            );
            assert.ok(data.issueUpdate.success, `Linear did not update the issue ${id}`);
        },

        async link_pr(issue_id, url) {
            const data = await call<{ attachmentLinkGitHubPR: { success: boolean } }>(
                `mutation Link($issueId: String!, $url: String!) {
                    attachmentLinkGitHubPR(issueId: $issueId, url: $url) { success }
                }`,
                { issueId: issue_id, url },
            );
            assert.ok(data.attachmentLinkGitHubPR.success, `Linear did not link ${url}`);
        },

        async create_label(team_id, name) {
            const data = await call<{
                issueLabelCreate: { success: boolean; issueLabel: { id: string } };
            }>(
                `mutation Label($input: IssueLabelCreateInput!) {
                    issueLabelCreate(input: $input) { success issueLabel { id } }
                }`,
                { input: { teamId: team_id, name } },
            );
            assert.ok(data.issueLabelCreate.success, `Linear did not create the label ${name}`);
            return data.issueLabelCreate.issueLabel.id;
        },
    };
}
