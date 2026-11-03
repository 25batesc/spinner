#!/usr/bin/env node
// E2e for the EGM harness adapter with the real pi (docs/designs/egm-adoption.md, entry
// 1.26): a scratch daemon on a scratch SPINNER_HOME and a free port, the sandbox repository
// cloned into the scratch as the one repo of a scratch project. The driver fetches EGM
// through `POST /egm/fetch`, starts a session from a paste, and runs the evidence probes
// against the session's lead:
//
//   P1   the lead sees `subagent` and not `subagents_enable`
//   P2a  a Goldfish does not see a nonce that is only in the lead's context (MISSION.md)
//   P2b  the lead's command channel still answers after a Goldfish ran
//   P2c  a Goldfish cannot write a file
//   P4   pi-subagents lists the adapters from `<home>/egm/pi/agents`
//   P3   `/skill:egm-brainstorm` through `POST …/design/run` reaches the model as the skill
//   P11  brainstorm, draft, review and resolve run end to end from the app's routes, the
//        gates answered through `design.gate` (3.15), and the worktree holds no code
//        change before approval; then P5 and P8
//   P5   the brainstorm's brief is in `<session>/design`, not in the worktree
//   P8   no Goldfish run is `egm-synthesizer`
//
// P4 runs before P3, so the brainstorm that P3 starts is the brainstorm of P11 without a
// listing prompt in the middle. The driver waits on artifacts: the lead's `agent.settled`
// event, then no live async run under `<session>/egm-runs` and no lead event for
// `QUIET_MS`. Never touches the operator's daemon on :7777 or ~/.spinner; nothing is pushed
// or posted. Needs a built daemon (`pnpm -r build`), `git` with read access to the
// repository, and a `pi` with a working model and pi-subagents in its settings.
//
//     node packages/daemon/e2e/egm-harness.ts
//
// SPINNER_E2E_REPO (`owner/name`, default 25batesc/spinner-sandbox) picks the repository.
// SPINNER_E2E_PROBES=short stops after P3 (no P11, P5, P8). The scratch directory is printed
// and kept; the record is `<scratch>/egm-evidence.json`.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const daemon_main = resolve(here, "..", "dist", "main.js");

const REPO = process.env["SPINNER_E2E_REPO"] ?? "25batesc/spinner-sandbox";
const SHORT = process.env["SPINNER_E2E_PROBES"] === "short";
const PASTE = "Add a --version flag to the sandbox CLI";
/** A lead turn counts as finished after this long without a lead event. */
const QUIET_MS = 10_000;
/** One probe prompt's bound, Goldfish included. */
const PROBE_MS = 15 * 60_000;
const P11_TURNS_MAX = 40;
/** "Continue." turns per P11 run; past this the lead is not driving the skill (operator). */
const CONTINUE_MAX = 5;
const P11_MS = 60 * 60_000;

interface Probe {
    id: string;
    pass: boolean;
    detail: string;
}

interface SkillRecord {
    skill: string;
    turns: number;
    wall_s: number;
    session_usd: number | null;
    lead_tokens: number | null;
}

const scratch = execFileSync("mktemp", ["-d", "-t", "spinner-e2e-egm"]).toString().trim();
const home_root = join(scratch, "home");
mkdirSync(home_root, { recursive: true });
const port = await free_port();
const base = `http://127.0.0.1:${port}`;
const probes: Probe[] = [];
const skills: SkillRecord[] = [];
console.log(`scratch: ${scratch}`);
console.log(`scratch daemon: ${base}`);

const project_dir = join(home_root, "projects", "sandbox-egm");
const repo_dir = join(scratch, "repo");
const project = join(project_dir, "spinner.yaml");
const adapter_dir = join(home_root, "egm", "pi", "agents");
let spinnerd: ChildProcess | null = null;
let egm: Record<string, unknown> = {};
let session_dir = "";
let session_path = "";
let worktree = "";

type BusEvent = Record<string, unknown> & { type: string; session?: string; agent?: string };
let lead_settles = 0;
let lead_busy = false;
let lead_last_event = Date.now();
let bus: WebSocket | null = null;
/** The lead's terminal, so a failure can keep what pi drew. */
let last_term: Term | null = null;

try {
    await main();
    await finish(probes.every((probe) => probe.pass) ? 0 : 1);
} catch (error) {
    const what = error instanceof Error ? error.message : String(error);
    console.error(`FAIL: ${what}`);
    // The callbacks assign `last_term`; the compiler cannot see that from here.
    const kept = last_term as Term | null;
    if (kept !== null) {
        writeFileSync(join(scratch, "terminal.txt"), kept.text());
    }
    probes.push({ id: "setup", pass: false, detail: what });
    await finish(1);
}

async function main(): Promise<void> {
    step(`a scratch project over a clone of ${REPO}`);
    make_project(project_dir, repo_dir);
    spinnerd = start_daemon();
    await wait_for(() => health(), "the daemon's /health", 15_000);
    bus = new WebSocket(`ws://127.0.0.1:${port}/events`);
    bus.on("message", (data) => on_event(JSON.parse(String(data)) as BusEvent));
    const socket = bus;
    await new Promise<void>((resolve_) => socket.once("open", () => resolve_()));

    step("POST /egm/fetch");
    const fetched = await post("/egm/fetch", {});
    check(fetched.status === 202, `POST /egm/fetch → ${fetched.status}`);
    const fetch_job = await wait_job(((await fetched.json()) as { job: { id: string } }).job.id);
    fetch_job.log.forEach((line) => console.log(`  job: ${line}`));
    check(fetch_job.state === "ok", `the egm job ${fetch_job.state} ${fetch_job.error ?? ""}`);
    const egm_body = (await (await fetch(`${base}/egm`)).json()) as {
        egm: Record<string, unknown>;
    };
    egm = egm_body.egm;
    check(egm["state"] === "ready", `GET /egm state ${String(egm["state"])}`);
    check(egm["subagents"] === true, "pi-subagents is in the operator's pi settings");

    step("POST /sessions with the paste");
    const started = await post("/sessions", { text: PASTE, project });
    check(started.status === 202, `POST /sessions → ${started.status}`);
    const { job } = (await started.json()) as { job: { id: string; session: string | null } };
    session_dir = job.session ?? "";
    session_path = join(home_root, "sessions", session_dir);
    const new_job = await wait_job(job.id);
    new_job.log.forEach((line) => console.log(`  job: ${line}`));
    check(new_job.state === "ok", `job ${job.id} ${new_job.state} ${new_job.error ?? ""}`);
    const unavailable = new_job.log.find((line) => line.startsWith("EGM unavailable"));
    check(unavailable === undefined, `the lead starts with EGM (${unavailable ?? "no refusal"})`);
    check(existsSync(join(session_path, "egm-runs")), "the spawn made <session>/egm-runs");
    const agents_file = readFileSync(join(session_path, "AGENTS.md"), "utf8");
    check(agents_file.includes(`EGM artifact directory: ${session_path}/design`), "AGENTS.md");
    worktree = join(session_path, "worktrees", "app");
    check(existsSync(worktree), `the worktree ${worktree}`);
    const term = await attach(`/sessions/${session_dir}/agents/lead/tty`);
    await wait_for(() => term.text().length > 0, "the first pty bytes", 20_000);
    term.socket.send(JSON.stringify({ resize: { cols: 140, rows: 45 } }));
    await dismiss_notices(term);
    await wait_for(() => hello_seen(), "the lead extension's hello", 60_000);
    check(await wait_idle(0, PROBE_MS), "the lead settled after the paste");

    await probe_p1();
    await probe_p2a();
    await probe_p2b();
    await probe_p2c();
    await probe_p4();
    const p3_reply = await probe_p3();
    if (!SHORT) {
        await probe_p11(p3_reply);
    }
}

function on_event(event: BusEvent): void {
    if (event.session !== session_dir || event.agent !== "lead") {
        return;
    }
    lead_last_event = Date.now();
    if (event.type === "agent.settled") {
        lead_settles += 1;
        lead_busy = false;
    } else if (event.type === "agent.event") {
        lead_busy = true;
    }
}

// --- probes ----------------------------------------------------------------------------

async function probe_p1(): Promise<void> {
    step("P1: the lead's tools");
    const turn = await prompt_turn(
        "List the names of all tools you can call, one per line, nothing else.",
    );
    const lines = turn.assistant
        .split("\n")
        .map((line) => line.trim().replace(/^[-*`\s]+|`$/g, ""));
    const has_subagent = lines.includes("subagent");
    const has_loader = lines.includes("subagents_enable");
    record("P1", has_subagent && !has_loader, `subagent ${has_subagent}, loader ${has_loader}`);
}

async function probe_p2a(): Promise<void> {
    step("P2a: the canary");
    const nonce = `CANARY-${randomBytes(8).toString("hex")}`;
    const written = await put(`/sessions/${session_dir}/mission/section`, {
        section: "log",
        mode: "append",
        text: nonce,
        author: "operator",
    });
    check(written.status === 200, `the canary Log line → ${written.status}`);
    const since = Date.now();
    const turn = await prompt_turn(
        "Call the subagent tool once with agent egm-zoom-out, context fresh, and this task: " +
            "'List every line of text in your context that contains the word CANARY. " +
            "If there is none, answer NONE.' Then print the child's answer verbatim.",
    );
    // "The answer" is the child's: its output and its whole transcript. The lead may name
    // the nonce itself, because the nonce is in the lead's own context.
    const child = child_runs_since(since);
    const leaked = child.text.includes(nonce);
    const lead_named = turn.assistant.includes(nonce);
    record(
        "P2a",
        !leaked && child.runs.length > 0,
        `nonce ${nonce}; in the child's output or transcript: ${leaked}; child runs ` +
            `${child.runs.join(", ") || "none"} (${child.files.join(", ")}); the lead named ` +
            `the nonce itself: ${lead_named}`,
    );
}

async function probe_p2b(): Promise<void> {
    step("P2b: the command channel");
    const sent = Date.now();
    const turn = await prompt_turn("Reply with the word PONG and nothing else.", 60_000);
    const seconds = Math.round((Date.now() - sent) / 1000);
    const pong = turn.assistant.includes("PONG");
    record("P2b", pong && seconds <= 60, `PONG ${pong} after ${seconds} s`);
}

async function probe_p2c(): Promise<void> {
    step("P2c: the negative write");
    const target = join(scratch, "goldfish-write-probe.txt");
    const since = Date.now();
    const turn = await prompt_turn(
        "Call the subagent tool once with agent egm-zoom-out and the task: " +
            `'Create the file ${target} containing x. Report whether it worked.'`,
    );
    const child = child_runs_since(since);
    const exists = existsSync(target);
    record(
        "P2c",
        !exists && child.runs.length > 0,
        `file exists ${exists}; child runs ${child.runs.join(", ") || "none"}; ` +
            `answer: ${first_line(turn.assistant_after_tools)}`,
    );
}

async function probe_p4(): Promise<void> {
    step("P4: the adapters are listed");
    const turn = await prompt_turn(
        "Use the subagent tool's listing action and print the agent names and their source paths.",
    );
    const text = `${turn.tools}\n${turn.assistant}`;
    const line = text.split("\n").find((entry) => entry.includes("egm-zoom-out")) ?? "";
    const listed = text.includes("egm-zoom-out");
    const from_adapter = text.includes(adapter_dir);
    record(
        "P4",
        listed && from_adapter,
        `listed ${listed}; path under ${adapter_dir}: ` +
            `${from_adapter}; line: ${line.trim().slice(0, 200)}`,
    );
}

async function probe_p3(): Promise<string> {
    step("P3: /skill:egm-brainstorm through POST …/design/run (the brainstorm button)");
    const turn = await send_turn("run", { skill: "egm-brainstorm" });
    const expanded = turn.user.includes("EGM Brainstorm: Interactive Multi-Lens Ideation");
    const literal = turn.user.trim() === "/skill:egm-brainstorm";
    const asks = asks_question(turn.assistant) || (await open_gate()) !== null;
    const branch = expanded ? "expanded by pi" : asks ? "clarifying question" : "neither";
    record(
        "P3",
        expanded || asks,
        `${branch}; the model got ${literal ? "the literal text" : "a rewritten text"}; ` +
            `user entry: ${first_line(turn.user)}; reply: ${first_line(turn.assistant)}`,
    );
    return turn.assistant;
}

type Phase = "brainstorm" | "draft" | "review" | "resolve";

/**
 * P11 (1.26, 3.15): brainstorm, draft, review and resolve, each started from the app's
 * routes. After each settle the driver answers an open `design.gate` through
 * `POST …/design/answer` with the gate's full option that starts with the prefix of its
 * answer table; it uses the text table only when no gate is open. The draft ends when
 * `SessionView.design.doc` is set; the resolve ends when the resolve report's first
 * non-empty line is `Status: resolved`. Stop rules: `P11_MS` in all, `P11_TURNS_MAX` turns
 * per skill, `CONTINUE_MAX` "Continue." turns, and a repeated reply.
 */
async function probe_p11(first_reply: string): Promise<void> {
    step("P11: brainstorm, draft, review, resolve");
    const started_at = Date.now();
    let phase: Phase = "brainstorm";
    let turns = 0;
    let phase_started = Date.now();
    let phase_tokens = await lead_tokens();
    /** `lead_settles` when the "Proceed to /egm-draft" answer went out, else null. */
    let proceed_at: number | null = null;
    /** `lead_settles` when the driver first saw `concepts_brief.md`, else null. */
    let brief_at: number | null = null;
    let draft_sent = false;
    let resolve_answered = false;
    let previous = "";
    let continues = 0;
    let gates = 0;
    let doc: string | null = null;
    let last = first_reply;
    const end_phase = async (): Promise<void> => {
        const tokens = await lead_tokens();
        const record_: SkillRecord = {
            skill: `egm-${phase}`,
            turns,
            wall_s: Math.round((Date.now() - phase_started) / 1000),
            session_usd: await session_usd(),
            lead_tokens: tokens === null || phase_tokens === null ? null : tokens - phase_tokens,
        };
        skills.push(record_);
        console.log(`  ${record_.skill} done: ${JSON.stringify(record_)}`);
        turns = 0;
        phase_started = Date.now();
        phase_tokens = tokens;
    };
    const report = join(session_path, "design", "consolidated_review_report.md");
    const resolve_report = join(session_path, "design", "goldfish_review_report.md");
    for (;;) {
        if (Date.now() - started_at > P11_MS) {
            return record("P11", false, `past 60 minutes in egm-${phase} after ${turns} turns`);
        }
        if (turns >= P11_TURNS_MAX) {
            return record("P11", false, `past ${P11_TURNS_MAX} turns in egm-${phase}`);
        }
        const view = await design_view();
        if (brief_at === null && brief_exists()) {
            brief_at = lead_settles;
        }
        // The brainstorm ends with the "Select next step" answer after the brief exists. A
        // lead that writes the brief and asks no "Select next step" in 2 settled turns also
        // ends it (a driver variant, recorded in the evidence).
        const brief_done = brief_at !== null && lead_settles >= brief_at + 2;
        if (phase === "brainstorm" && brief_exists() && (proceed_at !== null || brief_done)) {
            await end_phase();
            probe_p5();
            phase = "draft";
        }
        if (phase === "draft") {
            if (view.doc !== null) {
                doc = join(worktree, view.doc);
                await end_phase();
                phase = "review";
                last = (await send_turn("run", { skill: "egm-review", preset: "uninterrupted" }))
                    .assistant;
                turns += 1;
                continue;
            }
            const since = proceed_at ?? brief_at;
            const two_later = since !== null && lead_settles >= since + 2;
            if (!draft_sent && !draft_exists() && two_later && view.gate === null) {
                draft_sent = true;
                last = (await send_turn("run", { skill: "egm-draft" })).assistant;
                turns += 1;
                continue;
            }
        }
        if (phase === "review") {
            if (/reading list/i.test(last) && last.trim().endsWith("?")) {
                return record("P11", false, "the lead asked for a reading list in the review");
            }
            if (existsSync(report) && view.gate === null) {
                await end_phase();
                phase = "resolve";
                last = (await send_turn("run", { skill: "egm-resolve", args: report })).assistant;
                turns += 1;
                continue;
            }
        }
        if (phase === "resolve") {
            if (first_nonempty_line(resolve_report) === "Status: resolved") {
                await end_phase();
                probe_p8();
                const built = build_changes();
                const verdict = built.length === 0 ? "no code change" : built.join(", ");
                return record(
                    "P11",
                    built.length === 0,
                    `doc ${doc ?? "?"}; ${skills.length} skills ran; ${gates} gates answered ` +
                        `through design/answer; worktree before approval: ${verdict}`,
                );
            }
            if (!resolve_answered && view.stage === "resolving" && view.needs_resolve) {
                resolve_answered = true;
                last = (await send_turn("answer", { text: "Auto accept" })).assistant;
                turns += 1;
                continue;
            }
        }
        if (view.gate !== null) {
            const choice = gate_answer(view.gate, phase);
            console.log(`  gate: ${first_line(view.gate.question)} → ${choice}`);
            if (choice.startsWith("Proceed to /egm-draft")) {
                proceed_at = lead_settles;
            }
            gates += 1;
            last = (await send_turn("answer", { text: choice })).assistant;
            turns += 1;
            previous = "";
            continue;
        }
        const answer = answer_for(last, phase, doc, report);
        if (answer !== null && answer.startsWith("Proceed to /egm-draft")) {
            proceed_at = lead_settles;
        }
        // No row matches and the lead asked nothing: the design's table has no row for
        // this case, so the driver says "Continue." (recorded in the evidence). The same
        // reply to two of them in a row is a stall.
        if (answer === null && last === previous) {
            return record("P11", false, `stalled in egm-${phase}: ${first_line(last)}`);
        }
        if (answer === null && continues >= CONTINUE_MAX) {
            const reached = skills.map((skill) => skill.skill).join(", ") || "none";
            return record(
                "P11",
                false,
                `${CONTINUE_MAX} "Continue." turns in egm-${phase} without progress; ` +
                    `skills finished: ${reached}; the lead went idle`,
            );
        }
        continues += answer === null ? 1 : 0;
        previous = answer === null ? last : "";
        last = (await prompt_turn(answer ?? "Continue.")).assistant;
        turns += 1;
    }
}

/**
 * The full option of an open gate that starts with the prefix of its row (3.15). In the draft
 * a "How would you like to proceed?" gate takes `Approve`. A gate that no row names takes its
 * first option, which EGM's gates use for "proceed" (a driver variant, in the evidence).
 */
function gate_answer(gate: { question: string; options: string[] }, phase: Phase): string {
    // Each row: a needle in the question, and the prefix of the option to pick. Declared
    // here, not at the top level, because `main` runs before the module's later constants.
    const rows: Array<[string, string]> = [
        ["Anchored feature hypothesis", "Review with Goldfishes"],
        ["Select next step", "Proceed to /egm-draft"],
        ["Where should the design be saved?", "Save to detected directory"],
    ];
    if (phase === "draft") {
        rows.push(["How would you like to proceed?", "Approve"]);
    }
    for (const [needle, prefix] of rows) {
        if (gate.question.includes(needle)) {
            const option = gate.options.find((entry) => entry.startsWith(prefix));
            if (option !== undefined) {
                return option;
            }
        }
    }
    return gate.options[0] ?? "Continue.";
}

/**
 * The design's rule is "text that ends with `?`". EGM's questions end a paragraph that goes
 * on after the question mark ("Describe who runs it ... say that, because ..."), and a list
 * of questions can end with a line such as "Answer in whatever order you like". So the
 * driver reads a question when one of the last 2 paragraphs has a `?` (recorded in the
 * evidence; session 3 widened it from the last paragraph).
 */
function asks_question(text: string): boolean {
    const paragraphs = text.trim().split(/\n\s*\n/);
    return paragraphs.slice(-2).some((paragraph) => paragraph.includes("?"));
}

/**
 * The answer table of entry 1.26, for a lead that asks in chat and opens no gate: the first
 * row whose text the last reply contains.
 */
function answer_for(
    text: string,
    phase: Phase,
    doc: string | null,
    report: string,
): string | null {
    const rows: Array<[string, string]> = [
        ["Anchored feature hypothesis", "Review with Goldfishes"],
        ["Select next step", "Proceed to /egm-draft"],
    ];
    for (const [needle, prefix] of rows) {
        if (text.includes(needle)) {
            return option_line(text, prefix);
        }
    }
    if (phase === "resolve" && /auto accept/i.test(text)) {
        return "Auto accept";
    }
    if (phase === "resolve" && asks_question(text)) {
        // egm-resolve's Step 1 asks for each input it lacks (a driver row, in the evidence).
        return (
            `TargetFile: ${doc ?? "the design doc"}. LineRange: full file. ` +
            `FindingsList: the findings in ${report}.`
        );
    }
    if (phase === "draft" && text.includes("How would you like to proceed?")) {
        return option_line(text, "Approve");
    }
    if (text.includes("Where should the design be saved?")) {
        return option_line(text, "Save to detected directory");
    }
    if (text.includes("contradiction")) {
        return "Keep the draft's version.";
    }
    const asks = asks_question(text);
    if (asks && phase === "brainstorm") {
        return (
            "It is one CLI flag on the sandbox CLI. No other constraints. " +
            "Success: the sandbox CLI's --version prints its package version."
        );
    }
    if (asks && phase === "draft") {
        return "Yes, go ahead.";
    }
    return null;
}

/** The full option line of the reply that starts with `prefix`, else the prefix itself. */
function option_line(text: string, prefix: string): string {
    for (const raw of text.split("\n")) {
        const line = raw
            .trim()
            .replace(/^(?:[-*]|\d+[.)]|[A-Z][.)])\s+/, "")
            .replace(/\*\*/g, "");
        if (line.startsWith(prefix)) {
            return line;
        }
    }
    return prefix;
}

function probe_p5(): void {
    const brief = brief_exists();
    const status = git_status();
    const leaked = status.filter((line) =>
        /concepts_brief\.md|design_draft\.md|_report\.md/.test(line),
    );
    record(
        "P5",
        brief && leaked.length === 0,
        `brief in design/: ${brief}; worktree: ` +
            `${leaked.length === 0 ? "clean of EGM artifacts" : leaked.join(", ")}`,
    );
}

function probe_p8(): void {
    const agents = [
        ...all_runs().flatMap((run) => run.agents),
        ...foreground_runs(0).map((run) => run.agent),
    ];
    const synthesizer = agents.includes("egm-synthesizer");
    record("P8", !synthesizer, `step agents: ${[...new Set(agents)].join(", ") || "none"}`);
}

// --- the lead --------------------------------------------------------------------------

interface Turn {
    /** The user entries of the turn, joined. */
    user: string;
    /** Every assistant text of the turn, joined. */
    assistant: string;
    /** The assistant texts after the last tool result. */
    assistant_after_tools: string;
    /** Every tool result text of the turn, joined. */
    tools: string;
}

async function prompt_turn(text: string, timeout_ms: number = PROBE_MS): Promise<Turn> {
    return send_turn("prompt", { text }, timeout_ms);
}

/**
 * One lead turn through the prompt route, `POST …/design/answer` or `POST …/design/run`
 * (the app's buttons, 3.9). Waits for the lead to settle and go quiet.
 */
async function send_turn(
    route: "prompt" | "answer" | "run",
    body: Record<string, unknown>,
    timeout_ms: number = PROBE_MS,
): Promise<Turn> {
    const before = (await lead_messages()).length;
    const settles = lead_settles;
    const path =
        route === "prompt"
            ? `/sessions/${session_dir}/agents/lead/prompt`
            : `/sessions/${session_dir}/design/${route}`;
    console.log(`  > ${route} ${JSON.stringify(body).slice(0, 120)}`);
    const sent = await post(path, body);
    check(sent.status === 200, `POST ${path} → ${sent.status} ${await error_text(sent)}`);
    const idle = await wait_idle(settles, timeout_ms);
    const messages = (await lead_messages()).slice(before);
    const turn = turn_of(messages);
    console.log(`  < ${first_line(turn.assistant)}${idle ? "" : " (not idle in time)"}`);
    return turn;
}

interface Message {
    role: string;
    content: unknown;
}

function turn_of(messages: Message[]): Turn {
    const user: string[] = [];
    const assistant: string[] = [];
    const tools: string[] = [];
    let after: string[] = [];
    for (const message of messages) {
        const text = text_of(message.content);
        if (message.role === "user") {
            user.push(text);
        } else if (message.role === "assistant") {
            assistant.push(text);
            after.push(text);
        } else {
            tools.push(text);
            after = [];
        }
    }
    return {
        user: user.join("\n"),
        assistant: assistant.join("\n").trim(),
        assistant_after_tools: after.join("\n").trim(),
        tools: tools.join("\n"),
    };
}

function text_of(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return content
        .map((part: unknown) => {
            const record_ = part as { type?: string; text?: string };
            return record_.type === "text" && typeof record_.text === "string" ? record_.text : "";
        })
        .filter((text) => text.length > 0)
        .join("\n");
}

async function error_text(response: Response): Promise<string> {
    if (response.ok) {
        return "";
    }
    return await response.text().catch(() => "");
}

async function lead_messages(): Promise<Message[]> {
    const response = await fetch(`${base}/sessions/${session_dir}/agents/lead/events`);
    const body = (await response.json()) as { events: Array<{ message?: Message }> };
    return body.events.flatMap((event) => (event.message === undefined ? [] : [event.message]));
}

/** True once the lead settled after `settles`, no async run is live, and it is quiet. */
async function wait_idle(settles: number, timeout_ms: number): Promise<boolean> {
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline) {
        const quiet = Date.now() - lead_last_event > QUIET_MS;
        if (lead_settles > settles && !lead_busy && quiet && live_runs() === 0) {
            return true;
        }
        await sleep(1_000);
    }
    return false;
}

// --- pi-subagents runs -----------------------------------------------------------------

interface RunInfo {
    id: string;
    state: string;
    agents: string[];
    files: string[];
}

function runs_dir(): string {
    return join(session_path, "egm-runs", "async-subagent-runs");
}

function all_runs(): RunInfo[] {
    if (!existsSync(runs_dir())) {
        return [];
    }
    return readdirSync(runs_dir()).flatMap((id) => {
        const file = join(runs_dir(), id, "status.json");
        if (!existsSync(file)) {
            return [];
        }
        try {
            const status = JSON.parse(readFileSync(file, "utf8")) as {
                state?: string;
                sessionFile?: string;
                steps?: Array<{ agent?: string; sessionFile?: string }>;
            };
            const steps = status.steps ?? [];
            const files = [status.sessionFile, ...steps.map((s) => s.sessionFile)].filter(
                (path): path is string => typeof path === "string",
            );
            const agents = steps.map((s) => s.agent ?? "?");
            return [{ id, state: status.state ?? "?", agents, files: [...new Set(files)] }];
        } catch {
            return [{ id, state: "unreadable", agents: [], files: [] }];
        }
    });
}

function live_runs(): number {
    return all_runs().filter((run) => run.state === "running" || run.state === "queued").length;
}

interface ForegroundRun {
    id: string;
    agent: string;
    files: string[];
}

/**
 * The foreground (`async: false`) runs: pi-subagents writes no status file for them, only
 * `<lead pi dir>/subagent-artifacts/<runId>_<agent>_<step>_{meta.json,output.md,
 * transcript.jsonl,input.md}`. Runs whose files changed at or after `since_ms`.
 */
function foreground_runs(since_ms: number): ForegroundRun[] {
    const dir = join(session_path, "agents", "lead", "pi", "subagent-artifacts");
    if (!existsSync(dir)) {
        return [];
    }
    const runs = new Map<string, ForegroundRun>();
    for (const name of readdirSync(dir)) {
        const match =
            /^([0-9a-f-]{36})_(.+)_(\d+)_(meta\.json|output\.md|transcript\.jsonl|input\.md)$/.exec(
                name,
            );
        const path = join(dir, name);
        if (match === null || statSync(path).mtimeMs < since_ms) {
            continue;
        }
        const id = match[1] ?? "";
        const run = runs.get(id) ?? { id, agent: match[2] ?? "?", files: [] };
        if (match[4] !== "input.md") {
            run.files.push(path);
        }
        runs.set(id, run);
    }
    return [...runs.values()];
}

/** The child runs, async and foreground, since `since_ms`, with their outputs and transcripts. */
function child_runs_since(since_ms: number): { runs: string[]; files: string[]; text: string } {
    const background = all_runs().filter((run) =>
        run.files.some((file) => existsSync(file) && statSync(file).mtimeMs >= since_ms),
    );
    const foreground = foreground_runs(since_ms);
    const files = [
        ...background.flatMap((run) => run.files),
        ...foreground.flatMap((run) => run.files),
    ].filter((file) => existsSync(file));
    const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
    const runs = [
        ...background.map((run) => `${run.id} (async)`),
        ...foreground.map((run) => `${run.id} ${run.agent} (foreground)`),
    ];
    return { runs, files, text };
}

// --- the session's files ---------------------------------------------------------------

function brief_exists(): boolean {
    return existsSync(join(session_path, "design", "concepts_brief.md"));
}

function draft_exists(): boolean {
    return existsSync(join(session_path, "design", "design_draft.md"));
}

function git_status(): string[] {
    return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: worktree,
    })
        .toString()
        .split("\n")
        .filter((line) => line.trim().length > 0);
}

/**
 * The worktree's changes outside the designs directory: code the lead wrote before
 * approval. The design-track brief (3.13) allows only the design doc and the session's files.
 */
function build_changes(): string[] {
    return git_status()
        .map((line) => line.slice(3).trim())
        .filter((path) => !path.startsWith("docs/designs/"));
}

function first_nonempty_line(path: string): string | null {
    if (!existsSync(path)) {
        return null;
    }
    const line = readFileSync(path, "utf8")
        .split(/\r?\n/)
        .find((entry) => entry.trim().length > 0);
    return line === undefined ? null : line.trim();
}

interface DesignFacts {
    stage: string | null;
    doc: string | null;
    gate: { question: string; options: string[] } | null;
    /** `needs_human` reads `resolve the review findings`: the lead settled while resolving. */
    needs_resolve: boolean;
}

async function design_view(): Promise<DesignFacts> {
    const response = await fetch(`${base}/sessions/${session_dir}`);
    const body = (await response.json()) as {
        session: {
            summary: { session: { needs_human?: string | null } };
            design?: {
                stage: string | null;
                doc: string | null;
                gate: { question: string; options: string[] } | null;
            };
        };
    };
    const design = body.session.design;
    return {
        stage: design?.stage ?? null,
        doc: design?.doc ?? null,
        gate: design?.gate ?? null,
        needs_resolve: body.session.summary.session.needs_human === "resolve the review findings",
    };
}

async function open_gate(): Promise<{ question: string; options: string[] } | null> {
    return (await design_view()).gate;
}

interface CostView {
    cost?: { usd: number; agents: Record<string, { tokens_in: number; tokens_out: number }> };
}

async function session_view(): Promise<CostView> {
    const response = await fetch(`${base}/sessions/${session_dir}`);
    return ((await response.json()) as { session: CostView }).session;
}

async function session_usd(): Promise<number | null> {
    return (await session_view()).cost?.usd ?? null;
}

async function lead_tokens(): Promise<number | null> {
    const lead = (await session_view()).cost?.agents["lead"];
    return lead === undefined ? null : lead.tokens_in + lead.tokens_out;
}

// --- the record ------------------------------------------------------------------------

function record(id: string, pass: boolean, detail: string): void {
    probes.push({ id, pass, detail });
    console.log(`  ${pass ? "PASS" : "FAIL"} ${id}: ${detail}`);
}

async function finish(code: number): Promise<never> {
    const agent_dir = process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
    const subagents_file = join(agent_dir, "npm", "node_modules", "pi-subagents", "package.json");
    const evidence = {
        date: new Date().toISOString(),
        scratch,
        session: session_path,
        lead_transcripts: join(session_path, "agents", "lead", "pi"),
        pi_version: safe(() => execFileSync("pi", ["--version"]).toString().trim()),
        pi_subagents_version: existsSync(subagents_file)
            ? (JSON.parse(readFileSync(subagents_file, "utf8")) as { version: string }).version
            : null,
        egm_sha: egm["fetched_sha"] ?? null,
        session_usd: session_dir === "" ? null : await session_usd().catch(() => null),
        skills,
        runs: session_dir === "" ? [] : all_runs(),
        foreground_runs: session_dir === "" ? [] : foreground_runs(0),
        probes,
    };
    const text = JSON.stringify(evidence, null, 4);
    writeFileSync(join(scratch, "egm-evidence.json"), `${text}\n`);
    console.log(`\n${text}`);
    await stop_everything();
    console.log(`\nscratch kept at ${scratch}; record ${join(scratch, "egm-evidence.json")}`);
    process.exit(code);
}

async function stop_everything(): Promise<void> {
    bus?.close();
    last_term?.socket.close();
    if (session_dir !== "") {
        await post(`/sessions/${session_dir}/agents/lead/stop`, {}).catch(() => undefined);
    }
    const daemon = spinnerd;
    if (daemon === null || daemon.exitCode !== null) {
        return;
    }
    const exited = new Promise<void>((resolve_) => daemon.once("exit", () => resolve_()));
    daemon.kill("SIGTERM");
    await exited;
}

// --- plumbing (as chat-first.ts) -------------------------------------------------------

function make_project(project_: string, repo: string): void {
    execFileSync("git", ["clone", "--quiet", `https://github.com/${REPO}.git`, repo], {
        stdio: "ignore",
    });
    mkdirSync(project_, { recursive: true });
    const owner = REPO.split("/")[0] ?? "";
    writeFileSync(
        join(project_, "spinner.yaml"),
        [
            "name: sandbox-egm",
            "base: main",
            "repos:",
            `  app: { path: ${repo}, base: main }`,
            "services: {}",
            "pipeline:",
            `  github: { org: ${owner}, write_repos: [] }`,
            "",
        ].join("\n"),
    );
}

/**
 * The daemon's environment: this shell's, without the variables a running pi sets for its
 * own children. A driver started from inside a pi session (or a pi-subagents child) would
 * otherwise pass `PI_SUBAGENT_CHILD=1` to every lead, and the Spinner extension would stay
 * off. `PI_CODING_AGENT_DIR` stays: it names the pi settings to use.
 */
function clean_env(): NodeJS.ProcessEnv {
    return Object.fromEntries(
        Object.entries(process.env).filter(
            ([key]) => !key.startsWith("PI_") || key === "PI_CODING_AGENT_DIR",
        ),
    );
}

function start_daemon(): ChildProcess {
    return spawn(process.execPath, [daemon_main], {
        env: {
            ...clean_env(),
            SPINNER_HOME: home_root,
            SPINNER_PORT: String(port),
            SPINNER_PROXY_DIR: join(scratch, "proxy"),
            SPINNER_NOTIFY: "off",
            SPINNER_POLL_SECONDS: "0",
            SPINNER_SESSION_IDS: "home",
            SPINNER_OPERATOR: "off",
        },
        stdio: ["ignore", "inherit", "inherit"],
    });
}

async function health(): Promise<boolean> {
    try {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) });
        return response.ok;
    } catch {
        return false;
    }
}

function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

function put(path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

interface JobView {
    state: string;
    log: string[];
    error: string | null;
}

async function wait_job(id: string): Promise<JobView> {
    let job_: JobView = { state: "running", log: [], error: null };
    await wait_for(
        async () => {
            const response = await fetch(`${base}/jobs/${id}`);
            job_ = ((await response.json()) as { job: JobView }).job;
            return job_.state !== "running";
        },
        `job ${id}`,
        600_000,
    );
    return job_;
}

interface Term {
    socket: WebSocket;
    text(): string;
}

function attach(path: string): Promise<Term> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const chunks: Buffer[] = [];
    socket.on("message", (data, is_binary) => {
        if (is_binary) {
            chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        }
    });
    return new Promise((resolve_, reject) => {
        socket.once("open", () => {
            const term_: Term = { socket, text: () => Buffer.concat(chunks).toString("utf8") };
            last_term = term_;
            resolve_(term_);
        });
        socket.once("unexpected-response", (_request, response) =>
            reject(new Error(`attach ${path} refused: ${response.statusCode}`)),
        );
        socket.once("error", reject);
    });
}

/** pi's startup notices wait for a key; the driver presses Enter, at most 3 times. */
async function dismiss_notices(term_: Term): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
        await sleep(1_500);
        const notices = term_.text().split("Press any key to continue").length - 1;
        if (notices <= i) {
            return;
        }
        term_.socket.send(Buffer.from("\r"), { binary: true });
    }
}

async function hello_seen(): Promise<boolean> {
    const response = await fetch(`${base}/sessions/${session_dir}/agents/lead/context`);
    const body = (await response.json()) as { commands: unknown[] };
    return body.commands.length > 0;
}

function free_port(): Promise<number> {
    return new Promise((resolve_, reject) => {
        const server = createServer();
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
                reject(new Error("no port"));
                return;
            }
            server.close(() => resolve_(address.port));
        });
    });
}

async function wait_for(
    check_: () => boolean | Promise<boolean>,
    what: string,
    timeout_ms: number,
): Promise<void> {
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline) {
        if (await check_()) {
            return;
        }
        await sleep(500);
    }
    throw new Error(`timed out after ${timeout_ms} ms waiting for ${what}`);
}

function step(name: string): void {
    console.log(`\n== ${name}`);
}

function check(ok: boolean, what: string): void {
    if (!ok) {
        throw new Error(what);
    }
    console.log(`  ok: ${what}`);
}

function first_line(text: string): string {
    return (text.trim().split("\n")[0] ?? "").slice(0, 200);
}

function safe(read: () => string): string | null {
    try {
        return read();
    } catch {
        return null;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve_) => setTimeout(resolve_, ms));
}
