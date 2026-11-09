// Goal: the page script names the picked element the way an agent can find it: a selector
// that matches it alone, its text and rectangle, and on a React dev build the component and
// its source, from React 18's `_debugSource` and from React 19's `_debugStack`. Method: a
// fake document of a few elements with fiber properties attached, as React attaches them;
// and the source text the main process sends, evaluated with `new Function` against the same
// fake, to prove the function carries all its helpers.
import { describe, expect, it } from "vitest";
import {
    FIBER_DEPTH_MAX,
    SELECTOR_DEPTH_MAX,
    inspect_page,
    inspect_script,
    type InspectDocument,
    type InspectElement,
} from "./inspect-page.js";

interface Fake extends InspectElement {
    children: Fake[];
    attributes: Record<string, string>;
}

function element(tag: string, parent: Fake | null, id = "", text = ""): Fake {
    const node: Fake = {
        tagName: tag.toUpperCase(),
        id,
        parentElement: parent,
        previousElementSibling: parent?.children.at(-1) ?? null,
        textContent: text,
        children: [],
        attributes: {},
        getAttribute: (name) => node.attributes[name] ?? null,
        getBoundingClientRect: () => ({ x: 10, y: 20, width: 30, height: 40 }),
    };
    parent?.children.push(node);
    return node;
}

/** `body > main#app > ul > li, li(target)`; `querySelectorAll` knows only ids and test ids. */
function page(target_text = "  Refund\n 41 ") {
    const body = element("body", null);
    const main = element("main", body, "app");
    const list = element("ul", main);
    element("li", list, "", "Refund 40");
    const target = element("li", list, "", target_text);
    const doc: InspectDocument = {
        elementFromPoint: (x) => (x < 0 ? null : target),
        querySelectorAll: (selector) => {
            const all: Fake[] = [body, main, list, ...list.children];
            if (selector.startsWith("#")) {
                return { length: all.filter((n) => `#${n.id}` === selector).length };
            }
            const test_id = /^\[data-testid="(.*)"\]$/.exec(selector)?.[1];
            return { length: all.filter((n) => n.attributes["data-testid"] === test_id).length };
        },
    };
    return { doc, target };
}

function inspect(doc: InspectDocument) {
    return inspect_page(doc, 5, 5, 200, SELECTOR_DEPTH_MAX, FIBER_DEPTH_MAX);
}

describe("inspect_page", () => {
    it("builds a selector up to the nearest id, with the text folded and the rect", () => {
        const { doc } = page();
        expect(inspect(doc)).toEqual({
            selector: "#app > ul:nth-of-type(1) > li:nth-of-type(2)",
            text: "Refund 41",
            rect: { x: 10, y: 20, width: 30, height: 40 },
            component: null,
            source: null,
        });
        expect(inspect_page(doc, -1, 0, 200, 12, 200)).toBeNull();
    });

    it("prefers a unique data-testid", () => {
        const { doc, target } = page();
        target.attributes["data-testid"] = "refund-41";
        expect(inspect(doc)?.selector).toBe('[data-testid="refund-41"]');
    });

    it("names the component and the JSX line from React 18's _debugSource", () => {
        const { doc, target } = page();
        function RefundRow(): null {
            return null;
        }
        const component = { type: RefundRow, return: null };
        const host = {
            type: "li",
            return: component,
            _debugSource: { fileName: "/app/src/RefundRow.tsx", lineNumber: 41, columnNumber: 7 },
        };
        Object.assign(target, { "__reactFiber$x1y2": host });
        expect(inspect(doc)).toMatchObject({
            component: "RefundRow",
            source: "/app/src/RefundRow.tsx:41:7",
        });
    });

    it("reads React 19's _debugStack, skipping React's and the bundler's frames", () => {
        const { doc, target } = page();
        const memo = { $$typeof: "memo", type: { displayName: "Row" } };
        const stack = [
            "Error: react-stack-top-frame",
            "    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/" +
                "react_jsx-dev-runtime.js?v=1:250:12)",
            "    at Row (http://localhost:5173/src/Row.tsx?t=17:41:7)",
        ].join("\n");
        const host = { type: "li", return: { type: memo, return: null }, _debugStack: { stack } };
        Object.assign(target, { "__reactFiber$z": host });
        expect(inspect(doc)).toMatchObject({ component: "Row", source: "/src/Row.tsx:41:7" });
    });

    it("runs as the source text the main process sends", () => {
        const { doc, target } = page();
        Object.assign(target, { "__reactFiber$q": { type: "li", return: { type: () => null } } });
        const script = inspect_script(5, 5, 200).replace("(document,", "(doc,");
        const run = new Function("doc", `return ${script};`) as (d: InspectDocument) => unknown;
        const selector = "#app > ul:nth-of-type(1) > li:nth-of-type(2)";
        expect(run(doc)).toMatchObject({ selector });
        expect(() => inspect_script(Number.NaN, 0, 1)).toThrow();
    });
});
