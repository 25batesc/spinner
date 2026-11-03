// The fixture's design workspace routes (entries 5.12, 5.14) against the refusals of entry
// 5.3. Method: start the real fixture server on a free port and read each route with fetch,
// as the UI does: the file list with the archived run, a file, an archived report, the doc,
// a round's Log, and each 400 and 404.
import type { AddressInfo } from "node:net";

import type { DesignFilesResponse, SessionsResponse } from "@spinner/protocol";
import { afterEach, expect, it } from "vitest";

import { outline } from "../src/design-workspace.ts";
import { startFixture } from "./server.ts";

const servers: ReturnType<typeof startFixture>[] = [];
afterEach(() => {
    for (const server of servers.splice(0)) {
        server.close();
        server.closeAllConnections();
    }
});

async function base(): Promise<string> {
    const server = startFixture(0);
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
        server.on("listening", () => resolve((server.address() as AddressInfo).port));
    });
    return `http://127.0.0.1:${port}/sessions`;
}

it("lists the design files and the archived run of the resolving session", async () => {
    const url = await base();
    const body = (await (await fetch(`${url}/s206-csv-resolving/design/files`)).json()) as
        DesignFilesResponse;
    expect(body.review_runs).toEqual(["r1"]);
    expect(body.files.map((file) => file.name)).toContain("consolidated_review_report.md");
});

it("answers files, archived reports and the doc as markdown", async () => {
    const url = await base();
    const draft = await fetch(`${url}/s206-csv-resolving/design/files/design_draft.md`);
    expect(draft.headers.get("content-type")).toContain("text/markdown");
    // Six sections; the seventh `## ` line sits in a code fence.
    expect(outline(await draft.text())).toHaveLength(6);
    const archived = await fetch(
        `${url}/s206-csv-resolving/design/reviews/r1/consolidated_review_report.md`,
    );
    expect(await archived.text()).toContain("run r1");
    const doc = await fetch(`${url}/s210-csv-round-3/design/doc`);
    expect(await doc.text()).toContain("**Status:** Reviewed");
    const drift = await fetch(`${url}/s209-csv-direct/design/files/CSV_EXPORT_DRIFT_REPORT.md`);
    expect(drift.status).toBe(200);
});

it("refuses a bad name or run with 400 and an absent file with 404", async () => {
    const url = await base();
    const status = async (path: string) => (await fetch(`${url}/${path}`)).status;
    expect(await status("s206-csv-resolving/design/files/.hidden.md")).toBe(400);
    expect(await status("s206-csv-resolving/design/files/a%2Fb.md")).toBe(400);
    expect(await status("s206-csv-resolving/design/reviews/x1/critic_report.md")).toBe(400);
    expect(await status("s206-csv-resolving/design/files/absent.md")).toBe(404);
    expect(await status("s206-csv-resolving/design/reviews/r7/critic_report.md")).toBe(404);
    expect(await status("s201-csv-intake/design/doc")).toBe(404);
});

it("serves the round-3 session with two approvals and its round Logs", async () => {
    const url = await base();
    const sessions = (await (await fetch(url)).json()) as SessionsResponse;
    const third = sessions.sessions.find((view) => view.summary.dir === "s210-csv-round-3");
    expect(third?.design?.approvals.map((approval) => approval.round)).toEqual([1, 2]);
    const log = await fetch(`${url}/s210-csv-round-3/rounds/1/log`);
    expect(await log.text()).toContain("web#41 merged");
    expect((await fetch(`${url}/s210-csv-round-3/rounds/0/log`)).status).toBe(400);
    expect((await fetch(`${url}/s210-csv-round-3/rounds/3/log`)).status).toBe(404);
});
