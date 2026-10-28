// Reads the `pipeline:` block of a project's `spinner.yaml` into a `PipelineConfig` with every
// default filled in (docs/ARCHITECTURE.md, "Pipeline tracker" → Config). The block is
// optional: a project without one is a plain GitHub repo with no bots, no approval check and
// no merge queue. The stack runner finds and loads the spec; this module only reads one key.
import assert from "node:assert/strict";
import type { ApprovalRole, PipelineConfig, StackSpec } from "@spinner/protocol";
import { PIPELINE_CONFIG_DEFAULTS } from "@spinner/protocol";
import type { SpinnerHome } from "../home.js";
import { find_spec, load_spec } from "../stack/spec.js";

/**
 * Loads the pipeline configuration of `project` (a name or a path). Without a spec file the
 * defaults apply and `found` is false; a spec that exists but does not parse is an error,
 * because defaults in its place would silently change every stage.
 */
export function load_pipeline_config(
    project: string | undefined,
    home: SpinnerHome,
    cwd: string,
): { config: PipelineConfig; path: string | null } {
    let path: string;
    try {
        path = find_spec(project, home, cwd);
    } catch {
        return { config: PIPELINE_CONFIG_DEFAULTS, path: null };
    }
    const loaded = load_spec(path);
    return { config: pipeline_config_from_spec(loaded.spec), path };
}

/** Pure: the `pipeline:` block of a spec merged over the defaults. Unknown keys are ignored. */
export function pipeline_config_from_spec(spec: Pick<StackSpec, "pipeline">): PipelineConfig {
    const block = spec.pipeline ?? {};
    const github = record(block["github"]);
    const threads = record(block["threads"]);
    const slack = record(block["slack"]);
    const policy = record(github["approval_policy"]);
    const defaults = PIPELINE_CONFIG_DEFAULTS;
    const default_policy = defaults.github.approval_policy;
    const config: PipelineConfig = {
        github: {
            bot_logins: string_list(github["bot_logins"]) ?? defaults.github.bot_logins,
            approval_policy: {
                human_author: roles(policy["human_author"]) ?? default_policy.human_author,
                bot_author: roles(policy["bot_author"]) ?? default_policy.bot_author,
            },
            write_repos: string_list(github["write_repos"]) ?? defaults.github.write_repos,
            merge_queue: github["merge_queue"] === "github" ? "github" : "none",
            poll_seconds: positive_number(github["poll_seconds"]) ?? defaults.github.poll_seconds,
        },
        threads: {
            autofix: autofix(threads["autofix"]) ?? defaults.threads.autofix,
            resolve_human: threads["resolve_human"] === true,
            stale_after_hours:
                positive_number(threads["stale_after_hours"]) ?? defaults.threads.stale_after_hours,
        },
        slack: { post: slack["post"] === "never" ? "never" : "confirm" },
    };
    const org = string_value(github["org"]);
    if (org !== undefined) {
        config.github.org = org;
    }
    const approval_check = string_value(github["approval_check"]);
    if (approval_check !== undefined) {
        config.github.approval_check = approval_check;
    }
    const owner_login = string_value(github["owner_login"]);
    if (owner_login !== undefined) {
        config.github.owner_login = owner_login;
    }
    const channel = string_value(slack["channel"]);
    if (channel !== undefined) {
        config.slack.channel = channel;
    }
    assert.ok(config.github.poll_seconds > 0);
    assert.ok(config.threads.stale_after_hours > 0);
    return config;
}

function record(value: unknown): Record<string, unknown> {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return {};
}

function string_value(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function string_list(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    return value.filter((entry): entry is string => typeof entry === "string");
}

function roles(value: unknown): ApprovalRole[] | undefined {
    const list = string_list(value);
    if (list === undefined) {
        return undefined;
    }
    return list.filter((entry): entry is ApprovalRole => entry === "peer" || entry === "owner");
}

function positive_number(value: unknown): number | undefined {
    return typeof value === "number" && value > 0 ? value : undefined;
}

function autofix(value: unknown): PipelineConfig["threads"]["autofix"] | undefined {
    if (value === "all" || value === "bots" || value === "off") {
        return value;
    }
    return undefined;
}
