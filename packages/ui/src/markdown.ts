// Markdown to safe HTML for the Context tab's files and the mission's source view. The stack
// is mdview's (markdown-it with anchors, footnotes and task lists, highlight.js for fences),
// and DOMPurify strips what a file could smuggle in, since AGENTS.md and MISSION.md are
// written by agents and by hand. Task-list boxes render disabled: the file is edited as text.
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import MarkdownIt, { type RendererRule } from "markdown-it";
import anchor from "markdown-it-anchor";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";

// A short list keeps the bundle small; an unknown language renders as plain escaped text.
const LANGUAGES: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
    bash, sh: bash, shell: bash, css, diff, json, markdown, md: markdown, python, py: python,
    sql, typescript, ts: typescript, javascript: typescript, js: typescript, tsx: typescript,
    jsx: typescript, xml, html: xml, yaml, yml: yaml,
};
for (const [name, language] of Object.entries(LANGUAGES)) {
    hljs.registerLanguage(name, language);
}

const escape = (text: string): string =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

function highlight(code: string, lang: string): string {
    const language = lang !== "" && hljs.getLanguage(lang) !== undefined ? lang : null;
    const body = language === null
        ? escape(code)
        : hljs.highlight(code, { language, ignoreIllegals: true }).value;
    const label = lang === "" ? "" : ` data-lang="${escape(lang)}"`;
    return `<pre class="code"${label}><code class="hljs">${body}</code></pre>`;
}

const md = new MarkdownIt({ html: true, linkify: true, highlight });
md.use(anchor, { level: [1, 2, 3, 4, 5, 6], tabIndex: false });
md.use(footnote);
md.use(taskLists, { enabled: false, label: true });
md.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n';
md.renderer.rules.table_close = () => "</table></div>\n";
// Links leave the app in a new tab; the page keeps its sockets.
const linkOpen: RendererRule = (tokens, idx, options, _env, self) => {
    const token = tokens[idx];
    if (token !== undefined) {
        token.attrSet("target", "_blank");
        token.attrSet("rel", "noopener noreferrer");
    }
    return self.renderToken(tokens, idx, options);
};
md.renderer.rules["link_open"] = linkOpen;

/** `ADD_ATTR` keeps the new-tab links; DOMPurify drops `target` by default. */
const PURIFY = { ADD_ATTR: ["target"] };

/** The markdown-it stage alone, for the node tests; `renderMarkdown` is what the UI calls. */
export function renderMarkdownUnsafe(text: string): string {
    return md.render(text);
}

/**
 * The chat's renderer: as `md`, with a line break for each newline of a paragraph. An agent
 * writes a short list or a count as lines; a document's renderer would join them.
 */
const chat = new MarkdownIt({ html: true, linkify: true, breaks: true, highlight });
chat.use(footnote);
chat.use(taskLists, { enabled: false, label: true });
chat.renderer.rules["link_open"] = linkOpen;

/** The markdown-it stage of the chat's renderer alone, for the node tests. */
export function renderChatMarkdownUnsafe(text: string): string {
    return chat.render(text);
}

/** An agent's answer as HTML that is safe to set as a node's content. Needs a DOM. */
export function renderChatMarkdown(text: string): string {
    return DOMPurify.sanitize(renderChatMarkdownUnsafe(text), PURIFY);
}

/** Renders markdown to HTML that is safe to set as a node's content. Needs a DOM. */
export function renderMarkdown(text: string): string {
    return DOMPurify.sanitize(renderMarkdownUnsafe(text), PURIFY);
}
