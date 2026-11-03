// Goal: `archive_review_run` moves the current run's reports into `reviews/<id>/` and gives
// the next run an id that no archived or current run has (docs/designs/egm-adoption.md,
// entry 3.8, review v2 M-2), and refuses before any move past `REVIEW_RUNS_MAX` or onto an
// existing directory. Method: a scratch session directory with real files; each assertion
// reads the disk back.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DesignReviewRun } from "@spinner/protocol";
import { archive_review_run } from "./review-runs.js";

let session: string;
let design: string;

beforeEach(() => {
    session = mkdtempSync(join(tmpdir(), "spinner-review-runs-"));
    design = join(session, "design");
    mkdirSync(design, { recursive: true });
    writeFileSync(join(design, "concepts_brief.md"), "brief\n");
});

afterEach(() => {
    rmSync(session, { recursive: true, force: true });
});

function run(id: string): DesignReviewRun {
    return { id, preset: "uninterrupted", started: "2026-11-04T10:02:00Z" };
}

function report(name: string): void {
    writeFileSync(join(design, name), `${name}\n`);
}

describe("archive_review_run", () => {
    it("with no reports and no run: nothing moves, the next run is r1", () => {
        expect(archive_review_run(session, null)).toEqual({ archived: null, next: "r1" });
        expect(existsSync(join(design, "reviews"))).toBe(false);
    });

    it("with no reports after r1: nothing moves, the next run is r2", () => {
        expect(archive_review_run(session, run("r1"))).toEqual({ archived: null, next: "r2" });
    });

    it("with reports of r1: moves only the reports into reviews/r1, the next run is r2", () => {
        report("zoom_out_report.md");
        report("consolidated_review_report.md");
        report("goldfish_review_report.md");
        expect(archive_review_run(session, run("r1"))).toEqual({ archived: "r1", next: "r2" });
        expect(readdirSync(join(design, "reviews", "r1")).sort()).toEqual([
            "consolidated_review_report.md",
            "goldfish_review_report.md",
            "zoom_out_report.md",
        ]);
        expect(readdirSync(design).sort()).toEqual(["concepts_brief.md", "reviews"]);
    });

    it("with reports typed in the terminal and no run: archives as r1, the next run is r2", () => {
        report("critic_report.md");
        expect(archive_review_run(session, null)).toEqual({ archived: "r1", next: "r2" });
        expect(existsSync(join(design, "reviews", "r1", "critic_report.md"))).toBe(true);
    });

    it("with an existing reviews/r1 and no run: archives as r2, the next run is r3", () => {
        mkdirSync(join(design, "reviews", "r1"), { recursive: true });
        report("critic_report.md");
        expect(archive_review_run(session, null)).toEqual({ archived: "r2", next: "r3" });
    });

    it("refuses onto an existing directory, before any move", () => {
        mkdirSync(join(design, "reviews", "r1"), { recursive: true });
        report("critic_report.md");
        expect(() => archive_review_run(session, run("r1"))).toThrow(
            `${join(design, "reviews", "r1")} already exists`,
        );
        expect(existsSync(join(design, "critic_report.md"))).toBe(true);
    });

    it("refuses past 99 runs, before any move", () => {
        const fault = `99 review runs are archived; move ${join(design, "reviews")} aside by hand`;
        mkdirSync(join(design, "reviews", "r98"), { recursive: true });
        report("critic_report.md");
        // r99 would take the reports, and the run after it would be r100.
        expect(() => archive_review_run(session, null)).toThrow(fault);
        expect(existsSync(join(design, "critic_report.md"))).toBe(true);
        expect(existsSync(join(design, "reviews", "r99"))).toBe(false);
        rmSync(join(design, "critic_report.md"));
        expect(archive_review_run(session, null)).toEqual({ archived: null, next: "r99" });
        expect(() => archive_review_run(session, run("r99"))).toThrow(fault);
    });
});
