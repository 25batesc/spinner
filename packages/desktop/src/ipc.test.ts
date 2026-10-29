// Goal: the preload's copy of the channel names matches `ipc.ts`, and the bridge name matches
// the protocol constant. Method: read the preload source and look for each value.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_BRIDGE_NAME } from "@spinner/protocol";
import { describe, expect, it } from "vitest";
import { IPC } from "./ipc.js";

const preload = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "preload.cts"),
    "utf8",
);

describe("preload", () => {
    it.each(Object.entries(IPC))("uses channel %s = %s", (name, channel) => {
        expect(preload).toContain(`${name}: "${channel}"`);
    });

    it("exposes the bridge under the protocol's name", () => {
        expect(preload).toContain(`exposeInMainWorld("${DESKTOP_BRIDGE_NAME}"`);
    });
});
