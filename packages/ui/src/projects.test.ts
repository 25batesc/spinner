// The Projects view's pure half: the list's rows, the stacks from the state, what a session
// row offers, why a delete is refused, and the reason in a daemon's refusal.
import { describe, expect, it } from "vitest";
import type { Job, ProjectDetailResponse, ProjectView, SessionView } from "@spinner/protocol";

import { session, stackView, view } from "../fixture/data.ts";
import {
    daemonReason,
    deleteBlocker,
    deleteLabel,
    projectRowMeta,
    projectRows,
    sessionOffer,
    stackRows,
} from "./projects.ts";
import { initialState, type UiState } from "./state.ts";

const SNAKE: ProjectView = {
    name: "snake", path: "/h/projects/snake/spinner.yaml", source: "home",
    repos: ["game"], services: ["web", "api"],
};

function live(
    id: string,
    project: string | undefined,
    state: "none" | "up" | "down",
    created: string,
): SessionView {
    const base = session({
        id, slug: "work", title: `Work ${id}`, created,
        ...(project === undefined ? {} : { project }),
    });
    return view(`${id}-work`, base, stackView(id, state));
}

function detail(over: Partial<ProjectDetailResponse>): ProjectDetailResponse {
    return {
        project: SNAKE, spec: "name: snake\n", writable: true, linked: false,
        summary: {
            base: "main", repos: [], services: [], database: null,
            pipeline: {
                write_repos: [], bot_logins: [], merge_queue: "none", approval_check: null,
                slack_channel: null, slack_post: "confirm", threads_autofix: "off",
            },
        },
        sessions: [],
        ...over,
    };
}

describe("projectRows", () => {
    it("counts repos, services and the project's sessions with a stack up", () => {
        const sessions = [
            live("s1", "snake", "up", "2026-11-01T00:00:00Z"),
            live("s2", "snake", "down", "2026-11-02T00:00:00Z"),
            live("s3", "other", "up", "2026-11-03T00:00:00Z"),
        ];
        const [row] = projectRows([SNAKE], sessions);
        expect(row).toEqual({ name: "snake", source: "home", repos: 1, services: 2, up: 1 });
        expect(row === undefined ? "" : projectRowMeta(row)).toBe("1 repo · 2 services · 1 up");
        expect(projectRowMeta({ ...SNAKE, repos: 2, services: 0, up: 0 })).toBe(
            "2 repos · 0 services",
        );
    });
});

describe("stackRows", () => {
    it("lists the sessions with a project, newest first, with memory while up", () => {
        const older = live("s1", "snake", "up", "2026-11-01T00:00:00Z");
        const newer = live("s2", "snake", "down", "2026-11-02T00:00:00Z");
        const bare = live("s3", undefined, "none", "2026-11-03T00:00:00Z");
        const job: Job = {
            id: "j1", action: "down", session: "s2-work", state: "running",
            started: "2026-11-02T00:00:00Z", finished: null, log: [], error: null,
        };
        const state: UiState = {
            ...initialState,
            sessions: { "s1-work": older, "s2-work": newer, "s3-work": bare },
            jobs: { j1: job },
        };
        const rows = stackRows(state);
        expect(rows.map((row) => [row.dir, row.state, row.busy])).toEqual([
            ["s2-work", "down", true],
            ["s1-work", "up", false],
        ]);
        expect(rows[0]?.memory).toBeNull();
        expect(rows[1]?.memory).toMatch(/B$/);
    });
});

describe("sessionOffer", () => {
    it("offers run local while the stack is not up, stop local while it is", () => {
        expect(sessionOffer("down")).toEqual({ run: true, stop: false });
        expect(sessionOffer("failed")).toEqual({ run: true, stop: false });
        expect(sessionOffer("up")).toEqual({ run: false, stop: true });
        expect(sessionOffer("starting")).toEqual({ run: false, stop: true });
    });
});

describe("deleteBlocker", () => {
    it("names why the daemon would refuse, and the button says Unlink for a link", () => {
        expect(deleteBlocker(detail({}))).toBeNull();
        expect(deleteLabel(detail({}))).toBe("Delete");
        expect(deleteLabel(detail({ linked: true }))).toBe("Unlink");
        const example = detail({ project: { ...SNAKE, source: "examples" }, writable: false });
        expect(deleteBlocker(example)).toMatch(/examples\//);
        const local = detail({ project: { ...SNAKE, source: "local" }, linked: true });
        expect(deleteBlocker(local)).toMatch(/only under local\//);
        const used = detail({
            sessions: [{ dir: "s1-work", id: "s1", title: "Work", stack: "up" }],
        });
        expect(deleteBlocker(used)).toBe("Used by s1; close it first.");
    });
});

describe("daemonReason", () => {
    it("reads the error of a refusal's body, and keeps any other message", () => {
        const refused = 'Error: PUT /projects/snake/spec failed (400): {"error":"the spec is bad"}';
        expect(daemonReason(refused)).toBe("the spec is bad");
        expect(daemonReason("Error: PUT /x failed (502): Bad gateway")).toBe("Bad gateway");
        expect(daemonReason("TypeError: fetch failed")).toBe("TypeError: fetch failed");
    });
});
