// The pipeline board's commands, in the order the usage text lists them.
import { adopt_command } from "./adopt.js";
import { board_command } from "./board.js";
import type { Command } from "./command.js";
import { verify_command } from "./verify.js";

export const PIPELINE_COMMANDS: Command[] = [adopt_command, board_command, verify_command];
