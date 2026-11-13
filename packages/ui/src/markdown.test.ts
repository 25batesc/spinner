// The markdown-it stage of the renderer (the mdview plugins), on the forms the files use:
// tables, task lists, fenced code, anchors, links. DOMPurify needs a DOM, so the sanitize
// step is checked by the `pipeline` driver flow against the fixture's context files.
import { expect, it } from "vitest";

import {
    renderChatMarkdownUnsafe,
    renderMarkdownUnsafe as renderMarkdown,
} from "./markdown.ts";

it("renders a table in a scroll box, a task list as disabled boxes, a fence with a lang", () => {
    const text = [
        "| Agent | Doing |", "|---|---|", "| ui | the box |", "",
        "- [x] done", "- [ ] open", "",
        "```ts", "const a = 1;", "```", "",
    ].join("\n");
    const html = renderMarkdown(text);
    expect(html).toContain('<div class="table-wrap"><table>');
    expect(html).toContain("<th>Agent</th>");
    expect(html).toMatch(/<input[^>]*class="task-list-item-checkbox"[^>]*checked/);
    expect(html).toMatch(/<input[^>]*disabled/);
    expect(html).toContain('<pre class="code" data-lang="ts"><code class="hljs">');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
});

it("gives a heading its anchor id and opens a link in a new tab", () => {
    const html = renderMarkdown("## Done when\n\n[docs](https://example.test/x)");
    expect(html).toContain('<h2 id="done-when"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
});

it("escapes a fence of an unknown language", () => {
    const html = renderMarkdown("```nope\n<b>x</b>\n```");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>");
});

it("the chat keeps an answer's line breaks; a document joins the lines of a paragraph", () => {
    expect(renderChatMarkdownUnsafe("1\n2\n**done**")).toBe(
        "<p>1<br>\n2<br>\n<strong>done</strong></p>\n",
    );
    expect(renderMarkdown("1\n2")).toBe("<p>1\n2</p>\n");
    expect(renderChatMarkdownUnsafe("[a](https://x.test)")).toContain('target="_blank"');
});
