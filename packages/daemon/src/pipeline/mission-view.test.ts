// Goal: the mission format with ids and times (MISSION.md s014, Contracts "format" and
// "view") reads and writes: `- [ ] 3. text (owner)`, `- [x] 3. text (owner, 14:02)`, the
// older forms without an id or an owner, a trailing parenthesis that is prose, and the
// structured view over a whole mission (title, goal, both lists, the roster, contracts with
// nested lines, questions with answers, the log). Method: pure calls on literal lines and on
// the s014 example mission under `examples/sessions/`.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mission_view, parse_item, render_item } from "./mission-sections.js";

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = resolve(here, "..", "..", "..", "..", "examples", "sessions", "s014-chat-first");

describe("parse_item and render_item", () => {
    it("reads ids, owners and times, and the older forms", () => {
        expect(parse_item("- [ ] 3. Extract (engine)")).toEqual({
            checked: false,
            id: 3,
            text: "Extract",
            owner: "engine",
            entry: null,
            ticked_at: null,
        });
        expect(parse_item("- [x] 3. Extract (engine, 14:02)")).toEqual({
            checked: true,
            id: 3,
            text: "Extract",
            owner: "engine",
            entry: null,
            ticked_at: "14:02",
        });
        expect(parse_item("- [ ] 4. Order page button (admin-ui, after 3)")).toEqual({
            checked: false,
            id: 4,
            text: "Order page button (after 3)",
            owner: "admin-ui",
            entry: null,
            ticked_at: null,
        });
        expect(parse_item("- [ ] 9. Lessons (the operator)")?.owner).toBe("the operator");
        expect(parse_item("- [ ] Refund button on the order page (web)")).toEqual({
            checked: false,
            id: null,
            text: "Refund button on the order page",
            owner: "web",
            entry: null,
            ticked_at: null,
        });
        expect(parse_item("- [x] all three PRs green")).toEqual({
            checked: true,
            id: null,
            text: "all three PRs green",
            owner: null,
            entry: null,
            ticked_at: null,
        });
        // A trailing parenthesis with prose in it is part of the text.
        const prose = parse_item("- [ ] bare `#N` resolved (ambiguous ones carry a reason)");
        expect(prose?.text).toBe("bare `#N` resolved (ambiguous ones carry a reason)");
        expect(prose?.owner).toBeNull();
        expect(parse_item("- a plain line")).toBeNull();
        expect(parse_item("- [ ] 1. ")).toBeNull();
    });

    it("renders the canonical line and round-trips", () => {
        const lines = [
            "- [ ] 3. Extract (engine)",
            "- [x] 3. Extract (engine, 14:02)",
            "- [ ] Refund button (web)",
            "- [x] all green",
        ];
        for (const line of lines) {
            const item = parse_item(line);
            expect(item).not.toBeNull();
            expect(render_item(item!)).toBe(line);
        }
        const unowned = {
            checked: true,
            id: 2,
            text: "x",
            owner: null,
            entry: null,
            ticked_at: "09:10",
        };
        expect(render_item(unowned)).toBe("- [x] 2. x (?, 09:10)");
    });

    it("reads the entry token on every form and round-trips it first (T3)", () => {
        expect(parse_item("- [ ] 7. [1.5] packages/protocol/src/plan-entries.ts (engine)")).toEqual({
            checked: false,
            id: 7,
            text: "packages/protocol/src/plan-entries.ts",
            owner: "engine",
            entry: "1.5",
            ticked_at: null,
        });
        const lines = [
            "- [ ] 7. [1.5] plan-entries.ts (engine)",
            "- [x] 7. [1.5] plan-entries.ts (engine, 14:02)",
            "- [ ] [3] retry the probe",
            "- [x] [2.21] done when line (lead, 09:00)",
        ];
        for (const line of lines) {
            const item = parse_item(line);
            expect(item?.entry).not.toBeNull();
            expect(render_item(item!)).toBe(line);
        }
        // The legacy prefix of the old build message parses and renders as the token.
        const legacy = parse_item("- [ ] 4. plan 2.21: `packages/ui/src/styles.css` (ui)");
        expect(legacy).toMatchObject({ entry: "2.21", text: "`packages/ui/src/styles.css`" });
        expect(render_item(legacy!)).toBe("- [ ] 4. [2.21] `packages/ui/src/styles.css` (ui)");
        // A bracket text that is not a token stays text.
        expect(parse_item("- [ ] 4. [D7] fix")).toMatchObject({ entry: null, text: "[D7] fix" });
    });
});

describe("mission_view", () => {
    it("derives the structured view of the s014 example mission", () => {
        const text = readFileSync(resolve(EXAMPLE, "MISSION.md"), "utf8");
        const view = mission_view(text);
        expect(view.title).toBe(
            "Chat first: a session is a conversation, the agent owns the mission",
        );
        expect(view.goal.startsWith("Starting a session takes a form")).toBe(true);
        expect(view.done_when).toHaveLength(11);
        expect(view.done_when[0]).toMatchObject({ id: 1, state: "open", owner: null });
        expect(view.plan).toHaveLength(9);
        expect(view.plan[0]).toMatchObject({ id: 1, owner: "engine", state: "next" });
        expect(view.plan[1]).toMatchObject({ id: 2, owner: "engine", state: "next" });
        expect(view.plan[8]).toMatchObject({ id: 9, owner: "the operator", state: "next" });
        expect(view.roster.map((row) => row.agent)).toEqual(["engine", "ui", "design"]);
        expect(view.roster[0]?.owns).toContain("packages/daemon/**");
        expect(view.contracts).toHaveLength(5);
        expect(view.contracts[0]).toMatchObject({ id: 1, ts: "(date)", author: "the operator" });
        expect(view.questions).toEqual([{ id: 1, author: null, text: "(none yet)", answer: null }]);
        expect(view.log).toHaveLength(1);
        expect(view.log[0]).toMatchObject({ ts: "(start)", author: "the operator" });
    });

    it("marks items done with their times, finds the doing one, and reads answers", () => {
        const text = [
            "# s9 · Refunds",
            "",
            "## Goal",
            "(The lead agent writes this from the conversation.)",
            "",
            "## Done when",
            "- [x] API agreed (lead, 10:01)",
            "- [ ] [1.1] UI done",
            "",
            "## Plan",
            "- [x] 1. contract (lead, 10:01)",
            "- [ ] 2. workflow (backend)",
            "- [ ] 3. tests (backend)",
            "- [ ] 4. [2.3] page (web)",
            "- [ ] 5. review #4 (web)",
            "- [ ] copy (lead)",
            "",
            "## Roster",
            "| Agent | Owns | Doing | Blocked? | Updated |",
            "|-------|------|-------|----------|---------|",
            "| backend | `b/**` | item 3: tests | no | 10:02 |",
            "| web | `w/**` | — | no | 10:00 |",
            "| lead | — | done | no | 10:03 |",
            "",
            "## Contracts & decisions",
            "- 10:01 lead: `POST /refunds` → 202",
            "  ```ts",
            "  type X = 1;",
            "  ```",
            "- 2026-11-02 Cullen: ship Friday",
            "",
            "## Open questions",
            "- web: partial refunds in v1?",
            "  - Cullen: full amount only",
            "- lead: and the admin?",
            "",
            "## Log",
            "- 10:00 lead: started",
            "- 10:01 backend: read mission; starting on 3",
            "",
        ].join("\n");
        const view = mission_view(text);
        expect(view.goal).toBe("");
        expect(view.done_when[0]).toMatchObject({ state: "done", owner: "lead" });
        expect(view.done_when[0]?.ticked_at).toBe("10:01");
        expect(view.plan.map((item) => [item.id, item.state])).toEqual([
            [1, "done"],
            [2, "next"],
            [3, "doing"],
            [4, "next"],
            [5, "next"],
            [6, "next"],
        ]);
        expect(view.plan[0]?.ticked_at).toBe("10:01");
        // The view carries the entry; a token on a Done when line is text with no effect.
        expect(view.plan.map((item) => item.entry)).toEqual([null, null, null, "2.3", null, null]);
        expect(view.plan[3]?.text).toBe("page");
        expect(view.done_when[1]).toMatchObject({ text: "UI done", state: "open" });
        expect("entry" in (view.done_when[1] ?? {})).toBe(false);
        expect(view.contracts[0]?.text).toBe("`POST /refunds` → 202\n```ts\ntype X = 1;\n```");
        expect(view.contracts[1]).toMatchObject({ ts: "2026-11-02", author: "Cullen" });
        expect(view.questions).toEqual([
            {
                id: 1,
                author: "web",
                text: "partial refunds in v1?",
                answer: "Cullen: full amount only",
            },
            { id: 2, author: "lead", text: "and the admin?", answer: null },
        ]);
        expect(view.log[1]).toEqual({
            ts: "10:01",
            author: "backend",
            text: "read mission; starting on 3",
        });
    });
});
