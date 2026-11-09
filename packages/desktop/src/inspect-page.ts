// The script `previews.inspect` runs inside a preview's page (s054). It finds the element
// under a point and describes it: a CSS selector, its visible text, its rectangle, and, on a
// React dev build, the component that rendered it and where that is written. It runs through
// `webContents.executeJavaScript`, in the page's own JavaScript world: the preview has
// `contextIsolation`, so a preload would not see the `__reactFiber$…` properties React sets
// on DOM nodes. `executeJavaScript` takes source text, so `inspect_page` is sent as its own
// `toString()`: it must use nothing outside its body. It takes the document as a parameter so
// a test can drive it with a fake one.
import type { PreviewElement } from "@spinner/protocol";

/** Ancestors a selector climbs at most; deeper paths stop at the nearest id. */
export const SELECTOR_DEPTH_MAX = 12;
/** Fibers the component lookup climbs at most. */
export const FIBER_DEPTH_MAX = 200;

/** Structural types of the DOM and fiber parts the script reads. */
export interface InspectDocument {
    elementFromPoint(x: number, y: number): InspectElement | null;
    querySelectorAll(selector: string): { length: number };
}

export interface InspectElement {
    tagName: string;
    id: string;
    parentElement: InspectElement | null;
    previousElementSibling: InspectElement | null;
    innerText?: string;
    textContent: string | null;
    getAttribute(name: string): string | null;
    getBoundingClientRect(): { x: number; y: number; width: number; height: number };
}

/**
 * The element under `(x, y)`, described. Null when nothing is there. Every helper is inside
 * so `toString()` carries it; see the file comment.
 */
export function inspect_page(
    doc: InspectDocument,
    x: number,
    y: number,
    text_max: number,
    selector_depth_max: number,
    fiber_depth_max: number,
): PreviewElement | null {
    const element = doc.elementFromPoint(x, y);
    if (element === null) {
        return null;
    }

    const css_escape = (value: string): string => value.replace(/([^a-zA-Z0-9_-])/g, "\\$1");

    const unique = (selector: string): boolean => {
        try {
            return doc.querySelectorAll(selector).length === 1;
        } catch {
            return false;
        }
    };

    const step = (node: InspectElement): string => {
        const tag = node.tagName.toLowerCase();
        let index = 1;
        let sibling = node.previousElementSibling;
        while (sibling !== null) {
            if (sibling.tagName === node.tagName) {
                index += 1;
            }
            sibling = sibling.previousElementSibling;
        }
        return `${tag}:nth-of-type(${index})`;
    };

    const selector_of = (node: InspectElement): string => {
        const test_id = node.getAttribute("data-testid");
        if (test_id !== null && unique(`[data-testid="${test_id}"]`)) {
            return `[data-testid="${test_id}"]`;
        }
        const parts: string[] = [];
        let current: InspectElement | null = node;
        for (let depth = 0; current !== null && depth < selector_depth_max; depth += 1) {
            if (current.id !== "" && unique(`#${css_escape(current.id)}`)) {
                parts.unshift(`#${css_escape(current.id)}`);
                break;
            }
            const tag = current.tagName.toLowerCase();
            if (tag === "body" || tag === "html") {
                parts.unshift(tag);
                break;
            }
            parts.unshift(step(current));
            current = current.parentElement;
        }
        return parts.join(" > ");
    };

    type Fiber = {
        type?: unknown;
        return?: Fiber | null;
        _debugSource?: { fileName?: string; lineNumber?: number; columnNumber?: number } | null;
        _debugStack?: { stack?: string } | null;
    };

    const fiber_of = (node: InspectElement): Fiber | null => {
        for (const key of Object.keys(node)) {
            if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) {
                return (node as unknown as Record<string, Fiber>)[key] ?? null;
            }
        }
        return null;
    };

    const name_of = (type: unknown): string | null => {
        if (typeof type === "function") {
            const fn = type as { displayName?: string; name?: string };
            return fn.displayName ?? (fn.name !== "" ? (fn.name ?? null) : null);
        }
        if (typeof type === "object" && type !== null) {
            const wrapped = type as { displayName?: string; render?: unknown; type?: unknown };
            if (typeof wrapped.displayName === "string") {
                return wrapped.displayName;
            }
            // `forwardRef` keeps the component in `render`, `memo` in `type`.
            return name_of(wrapped.render ?? wrapped.type);
        }
        return null;
    };

    // React 19 keeps an Error from where the element was created; the first frame outside
    // React and the bundler's dependency chunks is the component's own module.
    const source_of_stack = (stack: string): string | null => {
        for (const line of stack.split("\n").slice(1)) {
            const match = /\(?((?:https?|file):\/\/[^\s)]+):(\d+):(\d+)\)?\s*$/.exec(line.trim());
            if (match === null) {
                continue;
            }
            const [, url, row, column] = match;
            if (url === undefined || /node_modules|\/\.vite\/deps\/|react[-.]/.test(url)) {
                continue;
            }
            let path = url;
            try {
                path = new URL(url).pathname;
            } catch {
                path = url;
            }
            return `${path}:${row}:${column}`;
        }
        return null;
    };

    const source_of = (fiber: Fiber): string | null => {
        const source = fiber._debugSource;
        if (source !== null && source !== undefined && typeof source.fileName === "string") {
            const column = source.columnNumber === undefined ? "" : `:${source.columnNumber}`;
            return `${source.fileName}:${source.lineNumber ?? 0}${column}`;
        }
        const stack = fiber._debugStack?.stack;
        return typeof stack === "string" ? source_of_stack(stack) : null;
    };

    let component: string | null = null;
    let source: string | null = null;
    let fiber: Fiber | null = fiber_of(element);
    for (let depth = 0; fiber !== null && depth < fiber_depth_max; depth += 1) {
        // The host fiber's own source is the line that writes this element; keep the first.
        source ??= source_of(fiber);
        if (typeof fiber.type !== "string") {
            const name = name_of(fiber.type);
            if (name !== null) {
                component = name;
                source ??= source_of(fiber);
                break;
            }
        }
        fiber = fiber.return ?? null;
    }

    const raw_text = element.innerText ?? element.textContent ?? "";
    const rect = element.getBoundingClientRect();
    return {
        selector: selector_of(element),
        text: raw_text.replace(/\s+/g, " ").trim().slice(0, text_max),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        component,
        source,
    };
}

/** The source text `executeJavaScript` runs: the function applied to the page's document. */
export function inspect_script(x: number, y: number, text_max: number): string {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error("inspect needs a finite point");
    }
    const args = [x, y, text_max, SELECTOR_DEPTH_MAX, FIBER_DEPTH_MAX].join(", ");
    return `(${inspect_page.toString()})(document, ${args})`;
}
