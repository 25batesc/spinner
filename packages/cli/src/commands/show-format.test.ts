// Goal: pin the text of `spinner show` for one session and for the list, with color off, and
// prove that color on adds only the muted codes. Method: fixed data, snapshots.
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@spinner/protocol";
import {
    format_session_detail,
    format_session_table,
    palette_for,
    type ShowData,
} from "./show-format.js";

function entry(
    id: string,
    title: string,
    needs: string | null,
    state: "up" | "down",
): SessionSummary {
    return {
        dir: `${id}-${title}`,
        path: `/home/me/.spinner/sessions/${id}-${title}`,
        session: {
            version: 1,
            id,
            slug: title,
            title,
            created: "2026-10-27T10:00:00-04:00",
            stage: "planned",
            needs_human: needs,
            branch: `feat/${title}`,
            base: "develop",
            repos: {
                backend: {
                    path: "/home/me/code/backend",
                    worktree: "worktrees/backend",
                    changed: false,
                },
            },
            stack: {
                project: `spinner-${id}`,
                state,
                db: `spinner_${id}`,
                hosts: { backend: `api.${id}.localhost` },
            },
            agents: {},
        },
    };
}

const data: ShowData = {
    entry: entry("s016", "a", "write Goal and Done when in MISSION.md", "up"),
    services: [
        { name: "backend", where: "host :21600", state: "up", url: "http://api.s016.localhost" },
        { name: "worker", where: "host :21601", state: "exited", url: "" },
        { name: "admin", where: "container", state: "healthy", url: "http://admin.s016.localhost" },
        { name: "temporal", where: "container", state: "starting", url: "http://temporal.s016.localhost" },
    ],
    worktrees: { backend: "/home/me/.spinner/sessions/s016-a/worktrees/backend" },
};

describe("spinner show", () => {
    it("renders one session without color", () => {
        expect(format_session_detail(data, palette_for(false, {}))).toMatchSnapshot();
    });

    it("renders one session with muted colors on a TTY without NO_COLOR", () => {
        expect(format_session_detail(data, palette_for(true, {}))).toMatchSnapshot();
        const plain = format_session_detail(data, palette_for(true, { NO_COLOR: "1" }));
        expect(plain).not.toContain("\u001b[");
    });

    it("adds the design line for a session with a design block (2.28)", () => {
        const design_entry = entry("s018", "csv", "review the design", "down");
        design_entry.session.design = { track: "design", stage: "drafted" };
        const direct_entry = entry("s019", "fix", null, "down");
        direct_entry.session.design = { track: "direct" };
        const plain = palette_for(false, {});
        const shown = (summary: SessionSummary): string =>
            format_session_detail({ ...data, entry: summary, services: [] }, plain);
        expect(shown(design_entry)).toMatchSnapshot();
        expect(shown(direct_entry)).toContain("\ndesign: direct · -\n");
        expect(format_session_detail(data, palette_for(false, {}))).not.toContain("design:");
    });

    it("lists sessions as a table, the ones that need the operator first", () => {
        const entries = [
            entry("s016", "a", null, "up"),
            entry("s017", "b", "log in and check the report page", "down"),
        ];
        expect(format_session_table(entries, palette_for(false, {}))).toMatchSnapshot();
    });
});
