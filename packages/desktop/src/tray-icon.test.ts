// Goal: the generated icon is a PNG a decoder accepts: signature, IHDR size, and a CRC that
// matches the reference value for "IEND". Method: parse the bytes; check crc32 against the
// known constant 0xae426082 for an empty IEND chunk.
import { describe, expect, it } from "vitest";
import { crc32, tray_icon_png } from "./tray-icon.js";

describe("tray_icon_png", () => {
    it("writes a PNG with the asked size and a transparent corner", () => {
        const png = tray_icon_png(16);
        expect(png.subarray(0, 8)).toEqual(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        );
        expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");
        expect(png.readUInt32BE(16)).toBe(16);
        expect(png.readUInt32BE(20)).toBe(16);
        expect(png.subarray(-8, -4).toString("latin1")).toBe("IEND");
        expect(png.readUInt32BE(png.length - 4)).toBe(0xae426082);
    });

    it("rejects sizes outside the tray range", () => {
        expect(() => tray_icon_png(4)).toThrow();
        expect(() => tray_icon_png(16.5)).toThrow();
    });
});

describe("crc32", () => {
    it("matches the reference value for IEND", () => {
        expect(crc32(Buffer.from("IEND", "latin1"))).toBe(0xae426082);
    });
});
