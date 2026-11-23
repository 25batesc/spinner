// The Files view's pure half. Method: a flat listing as the daemon sends it (sorted by
// path, directories included); check the tree, the filter, the recent documents, the links
// of a document and the block a comment's quote sits in.
import { describe, expect, it } from "vitest";
import type { Comment, SessionFileEntry } from "@spinner/protocol";

import {
    ageLabel,
    blockOfQuote,
    commentsOn,
    dirOpen,
    docStats,
    fileTree,
    filterEntries,
    openCommentCounts,
    rawUrl,
    recentFiles,
    resolveLink,
    sizeLabel,
    viewerOf,
    type FileNode,
} from "./session-files.ts";

function entry(path: string, mtime = "2026-11-23T10:00:00Z", kind?: "dir"): SessionFileEntry {
    return { path, kind: kind ?? "file", bytes: kind === "dir" ? 0 : 100, mtime };
}

const ENTRIES: SessionFileEntry[] = [
    entry("MISSION.md", "2026-11-23T12:59:00Z"),
    entry("agents", undefined, "dir"),
    entry("agents/lead", undefined, "dir"),
    entry("agents/lead/BRIEF.md", "2026-11-23T12:30:00Z"),
    entry("artifacts", undefined, "dir"),
    entry("artifacts/local-test", undefined, "dir"),
    entry("artifacts/local-test/REPORT.md", "2026-11-22T09:00:00Z"),
    entry("artifacts/local-test/run10.log"),
    entry("artifacts/local-test/run2.log"),
    entry("artifacts/team-writeup-2026-11-22.md", "2026-11-23T11:00:00Z"),
    entry("egm", undefined, "dir"),
    entry("egm/concepts_brief.md", "2026-11-23T12:00:00Z"),
    entry("inbox", undefined, "dir"),
    entry("inbox/130849-bot-lead.md", "2026-11-23T12:58:00Z"),
    entry("session.yaml"),
];

/** `dir/` and `file` names of a level, in order. */
function names(nodes: FileNode[]): string[] {
    return nodes.map((node) => (node.kind === "dir" ? `${node.name}/` : node.name));
}

function comment(over: Partial<Comment>): Comment {
    return {
        id: "c1", agent: "lead", state: "open", waiting_on: "agent",
        anchor: { kind: "doc", path: "egm/concepts_brief.md", quote: "x", heading: null, line: 4 },
        messages: [{ author: "operator", text: "why?", created: "t" }],
        created: "2026-11-23T12:00:00Z", updated: "2026-11-23T12:00:00Z",
        ...over,
    };
}

describe("the tree of the session files", () => {
    it("nests the entries, directories first, names in natural order", () => {
        const tree = fileTree(ENTRIES);
        expect(names(tree)).toEqual([
            "agents/", "artifacts/", "egm/", "inbox/", "MISSION.md", "session.yaml",
        ]);
        const artifacts = tree.find((node) => node.name === "artifacts");
        expect(names(artifacts?.children ?? [])).toEqual([
            "local-test/", "team-writeup-2026-11-22.md",
        ]);
        // `run2` before `run10`: by number, not by character.
        expect(names(artifacts?.children[0]?.children ?? [])).toEqual([
            "REPORT.md", "run2.log", "run10.log",
        ]);
        expect(artifacts?.files).toBe(4);
        expect(tree.find((node) => node.name === "agents")?.files).toBe(1);
        // An entry whose directory the walk did not list is dropped, not shown at the root.
        expect(fileTree([entry("lost/deep/file.md")])).toEqual([]);
    });

    it("filters by a part of the path and keeps the directories above a match", () => {
        const kept = filterEntries(ENTRIES, "REPORT").map((item) => item.path);
        expect(kept).toEqual([
            "artifacts", "artifacts/local-test", "artifacts/local-test/REPORT.md",
        ]);
        expect(filterEntries(ENTRIES, "local-test/run").map((item) => item.path)).toHaveLength(4);
        expect(filterEntries(ENTRIES, "  ")).toHaveLength(ENTRIES.length);
        expect(filterEntries(ENTRIES, "nothing-has-this")).toEqual([]);
    });

    it("offers the documents changed last, without the agents' own traffic", () => {
        expect(recentFiles(ENTRIES).map((item) => item.path)).toEqual([
            "egm/concepts_brief.md",
            "artifacts/team-writeup-2026-11-22.md",
            "artifacts/local-test/REPORT.md",
        ]);
        expect(recentFiles(ENTRIES, 1)).toHaveLength(1);
    });

    it("opens the document directories at first, and a toggle wins", () => {
        expect(dirOpen("egm", {})).toBe(true);
        expect(dirOpen("design", {})).toBe(true);
        expect(dirOpen("artifacts", {})).toBe(false);
        expect(dirOpen("egm", { egm: false })).toBe(false);
        expect(dirOpen("artifacts", { artifacts: true })).toBe(true);
    });
});

describe("a file in the reader", () => {
    it("picks the viewer by the name", () => {
        expect(viewerOf("egm/a.md")).toBe("markdown");
        expect(viewerOf("artifacts/shot.PNG")).toBe("image");
        expect(viewerOf("artifacts/run.log")).toBe("text");
        expect(viewerOf("session.yaml")).toBe("text");
        expect(rawUrl("s1-a", "artifacts/a b.png")).toBe(
            "/sessions/s1-a/files/raw?path=artifacts%2Fa%20b.png",
        );
    });

    it("resolves a relative link against the document, never above the session", () => {
        expect(resolveLink("egm/brief.md", "design.md")).toBe("egm/design.md");
        expect(resolveLink("egm/brief.md", "./reviews/r1/report.md#top")).toBe(
            "egm/reviews/r1/report.md",
        );
        expect(resolveLink("egm/brief.md", "../artifacts/shot%201.png")).toBe(
            "artifacts/shot 1.png",
        );
        expect(resolveLink("MISSION.md", "egm/brief.md")).toBe("egm/brief.md");
        for (const href of ["https://x.test/a.md", "#top", "/abs.md", "../../x.md", "mailto:a@b"]) {
            expect([href, resolveLink("egm/brief.md", href)]).toEqual([href, null]);
        }
    });

    it("says the length, the size and the age in a few characters", () => {
        expect(docStats("one two  three\nfour")).toBe("4 words · 1 min read");
        expect(docStats("word ".repeat(1204))).toBe("1,204 words · 6 min read");
        expect([sizeLabel(812), sizeLabel(14_500), sizeLabel(2_400_000)]).toEqual([
            "812 B", "14 KB", "2.3 MB",
        ]);
        const now = new Date("2026-11-23T12:00:00Z");
        const ago = (iso: string) => ageLabel(iso, now);
        expect([
            ago("2026-11-23T11:59:30Z"), ago("2026-11-23T11:55:00Z"), ago("2026-11-23T09:00:00Z"),
            ago("2026-11-21T12:00:00Z"), ago("not a date"),
        ]).toEqual(["now", "5m", "3h", "2d", ""]);
        expect(ago("2026-11-03T12:00:00Z")).toMatch(/^Nov \d$/);
    });
});

describe("the comments on a file", () => {
    it("lists a file's comments by line, the resolved last, and counts the open ones", () => {
        const on = (path: string, line: number | null): Comment["anchor"] =>
            ({ kind: "doc", path, quote: "x", heading: null, line });
        const brief = "egm/concepts_brief.md";
        const comments = [
            comment({ id: "c1", anchor: on(brief, 40) }),
            comment({ id: "c2", anchor: on(brief, 4), state: "resolved" }),
            comment({ id: "c3", anchor: on(brief, null) }),
            comment({ id: "c4", anchor: on(brief, 9), state: "suggested" }),
            comment({ id: "c5", anchor: on("egm/other.md", 1) }),
        ];
        expect(commentsOn(comments, brief).map((item) => item.id)).toEqual([
            "c4", "c1", "c3", "c2",
        ]);
        expect(openCommentCounts(comments)).toEqual({ [brief]: 3, "egm/other.md": 1 });
    });

    it("finds the block of the page that holds the quoted text", () => {
        const blocks = [
            "Overview",
            "The poller reads   every session\nonce a minute.",
            "It skips a session on hold.",
        ];
        expect(blockOfQuote("reads every session once", blocks)).toBe(1);
        // A selection over two blocks sits at the first.
        expect(blockOfQuote("once a minute.\nIt skips a session", blocks)).toBe(1);
        expect(blockOfQuote("It skips a session on hold. And more that left the page", blocks))
            .toBe(2);
        expect(blockOfQuote("nowhere in the page", blocks)).toBe(-1);
        expect(blockOfQuote("", blocks)).toBe(-1);
    });
});
