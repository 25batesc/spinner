// The two markdown-it plugins without type declarations of their own.
declare module "markdown-it-footnote" {
    import type { MarkdownIt } from "markdown-it";
    const plugin: (md: MarkdownIt) => void;
    export default plugin;
}

declare module "markdown-it-task-lists" {
    import type { MarkdownIt } from "markdown-it";
    const plugin: (md: MarkdownIt, options?: { enabled?: boolean; label?: boolean }) => void;
    export default plugin;
}
