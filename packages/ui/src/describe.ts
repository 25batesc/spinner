// One-line, human-readable text for an event, used by the activity feed. Returns null for
// events the feed does not show, such as raw agent output, which would drown the feed.
import type { SpinnerEvent } from "@spinner/protocol";

function assertNever(value: never): never {
    throw new Error(`Unhandled event: ${JSON.stringify(value)}`);
}

export function describeEvent(event: SpinnerEvent): string | null {
    switch (event.type) {
        case "session.created":
            return `created "${event.data.summary.session.title}"`;
        case "session.updated":
            return "session updated";
        case "session.closed":
            return "session closed";
        case "pipeline.updated":
            return `stage ${event.stage}`;
        case "pipeline.transition":
            return `${event.from} \u2192 ${event.to}: ${event.why}`;
        case "pr.updated":
            return `${event.repo}#${event.pr.number} is ${event.pr.state}`;
        case "threads.updated":
            return (
                `${event.repo}#${event.number}: ${event.opened.length} opened, ` +
                `${event.resolved.length} resolved`
            );
        case "queue.popped":
            return `${event.repo}#${event.number} popped out of the queue: ${event.reason}`;
        case "slack.activity":
            return `slack ${event.kind} by ${event.author}`;
        case "agent.spawned":
            return `agent ${event.agent} started`;
        case "agent.settled":
            return `agent ${event.agent} is idle`;
        case "agent.exited":
            return `agent ${event.agent} exited (code ${event.code ?? "none"})`;
        case "stack.state":
            return `stack ${event.state}`;
        case "usage":
            // A sample every few seconds is not a feed line.
            return null;
        case "settings":
            // The operator's own change; every window follows it without a line.
            return null;
        case "operator.updated":
            // Not tied to a session (`session` is null), so the feed never shows it; the
            // operator tab follows the view.
            return null;
        case "mission.changed":
            return `${event.author} changed ${event.sections.join(", ")}`;
        case "inbox.message":
            return `${event.from} \u2192 ${event.to}: ${event.subject}`;
        case "message.delivered":
            return (
                `message ${event.file ?? "mission change"} reached ${event.agent} ` +
                `(${event.how})`
            );
        case "job.started":
            return `${event.data.action} started`;
        case "job.finished":
            return event.ok ? `${event.data.action} finished` : `${event.data.action} failed`;
        case "agent.event":
        case "stack.log":
        case "job.log":
            return null;
        default:
            return assertNever(event);
    }
}
