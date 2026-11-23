// The views of a session's middle pane, one row of tabs: the agents with their chat, the
// session's files, and the services of its stack. Every session has the same three; nothing
// about a session adds or hides one.

export const VIEW_IDS = ["agents", "files", "services"] as const;

export type ViewId = (typeof VIEW_IDS)[number];

export const TAB_LABELS: Record<ViewId, string> = {
    agents: "Agents", files: "Files", services: "Services",
};

/** The view a session opens on when nobody picked one: Agents, where the chat is. */
export const DEFAULT_VIEW: ViewId = "agents";

/**
 * The shown view: `shown` when it is a view, else the default. A view remembered from before
 * 2026-11-23 can name a tab that is gone (`review`, `implement`, `threads`).
 */
export function shownView(shown: string): ViewId {
    return (VIEW_IDS as readonly string[]).includes(shown) ? (shown as ViewId) : DEFAULT_VIEW;
}
