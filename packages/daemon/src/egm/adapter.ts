// The pi adapter for EGM (docs/designs/egm-adoption.md, T2). It mirrors EGM's
// `.claude-plugin/agents/*.md`: one pi-subagents agent file per persona of the fetched
// checkout, which names the canonical persona file and restricts the child's tools and
// context. The adapter is generated at fetch time, so a moved pin that renames a persona
// regenerates it. Only `write_adapter` touches the disk.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type AdapterKind = "reviewer" | "synthesizer" | "bootstrap";

/** More persona files than this is not an EGM checkout; the fetch fails. */
export const PERSONA_FILES_MAX = 50;

/** The kind follows the file name; every persona other than the two orchestrators reviews. */
export function kind_of(file: string): AdapterKind {
    if (file === "synthesizer.md") {
        return "synthesizer";
    }
    if (file === "bootstrap_orchestrator.md") {
        return "bootstrap";
    }
    return "reviewer";
}

export interface PersonaHeader {
    name: string;
    description: string;
}

/** The `name` and `description` of a persona's frontmatter, between the first two `---`. */
export function read_persona_header(text: string): PersonaHeader {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const fences = lines.flatMap((line, index) => (line.trim() === "---" ? [index] : []));
    const block = fences.length >= 2 ? lines.slice(fences[0]! + 1, fences[1]) : [];
    let name: string | null = null;
    let description = "";
    for (let index = 0; index < block.length; index += 1) {
        const line = block[index]!;
        const name_match = /^name:\s*(\S+)\s*$/.exec(line);
        if (name_match !== null) {
            name = name_match[1]!;
            continue;
        }
        const description_match = /^description:\s*(.+)$/.exec(line);
        if (description_match === null) {
            continue;
        }
        const value = description_match[1]!.trim();
        if (value !== ">-" && value !== ">") {
            description = value;
            continue;
        }
        // A folded block: the indented lines that follow, joined with spaces.
        const folded: string[] = [];
        while (index + 1 < block.length && /^\s+\S/.test(block[index + 1]!)) {
            index += 1;
            folded.push(block[index]!.trim());
        }
        description = folded.join(" ");
    }
    if (name === null) {
        throw new Error("persona without a name");
    }
    return { name, description };
}

export interface PiAgentInput {
    name: string;
    description: string;
    /** Absolute path of the canonical persona, `<source_root>/agents/<file>.md`. */
    persona_path: string;
    /** Absolute path of the EGM checkout. */
    source_root: string;
    kind: AdapterKind;
}

const TOOLS: Record<AdapterKind, string> = {
    reviewer: "read, grep, find, ls",
    synthesizer: "read, grep, find, ls, write",
    bootstrap: "read, grep, find, ls, write, edit, bash, subagent",
};

/**
 * One pi-subagents agent file. `extensions:` is written with an empty value: pi-subagents
 * documents that form as "no extensions", and its frontmatter parser reads `[]` as one
 * extension named `[]` (finding on entry 1.9, MISSION.md Open questions).
 */
export function render_pi_agent(input: PiAgentInput): string {
    assert.ok(input.name.length > 0, "an agent needs a name");
    assert.ok(input.persona_path.startsWith(input.source_root), "the persona is in the checkout");
    const description = input.description.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const header = [
        "---",
        `name: ${input.name}`,
        `description: "${description}"`,
        `tools: ${TOOLS[input.kind]}`,
        ...(input.kind === "reviewer" ? ["acceptanceRole: read-only"] : []),
        "systemPromptMode: replace",
        "inheritProjectContext: false",
        "inheritGlobalContext: false",
        "inheritSkills: false",
        "extensions:",
        "defaultContext: fresh",
        "---",
    ];
    return `${header.join("\n")}\n\n${render_body(input)}\n`;
}

function render_body(input: PiAgentInput): string {
    const persona = `\`${input.persona_path}\``;
    const root = `\`${input.source_root}\``;
    if (input.kind === "reviewer") {
        return [
            `Read ${persona} before reviewing. Follow that canonical persona's instructions.`,
            "This adapter defines your pi tools and context.",
            `Resolve bundled standards against ${root}. Remain read-only.`,
            "Use only the task and the review context the task names.",
            "Before returning findings, read the target and every supplied standard.",
            "If a required file cannot be read, report an incomplete review instead of a verdict.",
        ].join("\n");
    }
    if (input.kind === "synthesizer") {
        return [
            `Read ${persona} and follow it. This adapter defines your pi tools and context.`,
            `Resolve bundled standards against ${root}.`,
            "You have no subagent tool in this harness.",
            "If the task asks you to spawn reviewers, answer",
            "`This harness cannot nest subagents; use direct dispatch.` and stop.",
        ].join("\n");
    }
    return [
        `Read ${persona} and follow it. This adapter defines your pi tools and context.`,
        `Resolve bundled references against ${root}.`,
        "Write only under the target `path` of the task. Never stage, commit or push.",
    ].join("\n");
}

/**
 * Writes one adapter file per `<source_dir>/agents/*.md` into a fresh `adapter_dir`, under
 * the persona's basename, and returns the agent names written.
 */
export function write_adapter(source_dir: string, adapter_dir: string): string[] {
    const agents_dir = join(source_dir, "agents");
    const files = readdirSync(agents_dir)
        .filter((file) => file.endsWith(".md"))
        .sort();
    if (files.length > PERSONA_FILES_MAX) {
        throw new Error(`more than ${PERSONA_FILES_MAX} persona files`);
    }
    rmSync(adapter_dir, { recursive: true, force: true });
    mkdirSync(adapter_dir, { recursive: true });
    const names: string[] = [];
    for (const file of files) {
        const persona_path = join(agents_dir, file);
        const header = read_persona_header(readFileSync(persona_path, "utf8"));
        const text = render_pi_agent({
            ...header,
            persona_path,
            source_root: source_dir,
            kind: kind_of(file),
        });
        writeFileSync(join(adapter_dir, file), text);
        names.push(header.name);
    }
    return names;
}
