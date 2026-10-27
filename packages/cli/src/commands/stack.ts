// The stack runner's commands, in the order the usage text lists them.
import type { Command } from "./command.js";
import { close_command } from "./close.js";
import { down_command } from "./down.js";
import { exec_command } from "./exec.js";
import { logs_command } from "./logs.js";
import { new_command } from "./new.js";
import { seed_command } from "./seed.js";
import { show_command } from "./show.js";
import { up_command } from "./up.js";

export const STACK_COMMANDS: Command[] = [
    new_command,
    show_command,
    seed_command,
    up_command,
    down_command,
    logs_command,
    exec_command,
    close_command,
];
