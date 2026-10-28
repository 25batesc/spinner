// One line of per-PR facts, in the words `spinner board` prints (packages/cli board.ts).
import type { PrFacts } from "@spinner/protocol";

export function prLine(pr: PrFacts): string {
    const threads = `threads ${pr.threads.bots_open}b/${pr.threads.humans_open}h open`;
    const given = pr.approvals.peer.length + (pr.approvals.owner ? 1 : 0);
    const approvals = `approvals ${given}/${pr.approvals.required.length}`;
    const queue = pr.queue === "none" ? "" : ` queue ${pr.queue}`;
    const head = `${pr.repo}#${pr.number} ${pr.state} checks ${pr.checks}`;
    return `${head} ${threads} review ${pr.review} ${approvals}${queue}`;
}
