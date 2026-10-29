// The tray icon, drawn at runtime so the package ships no binary asset: a ring in black with
// alpha, which macOS tints as a template image. The daemon state is text next to it, set by
// `tray.ts`. The PNG encoder is the minimum: one IDAT with zlib, filter type 0 per row.
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Colour type 6 is RGBA, 8 bits per sample. */
const COLOUR_TYPE_RGBA = 6;
const BIT_DEPTH = 8;

/** An RGBA ring of `size` pixels on a side. `size` is 16 for 1x and 32 for 2x. */
export function tray_icon_png(size: number): Buffer {
    assert.ok(Number.isInteger(size));
    assert.ok(size >= 8);
    assert.ok(size <= 64);
    const rows = Buffer.alloc(size * (1 + size * 4));
    const centre = (size - 1) / 2;
    const outer = size * 0.44;
    const inner = size * 0.26;
    for (let y = 0; y < size; y += 1) {
        const row_start = y * (1 + size * 4);
        rows[row_start] = 0;
        for (let x = 0; x < size; x += 1) {
            const distance = Math.hypot(x - centre, y - centre);
            const alpha = ring_alpha(distance, inner, outer);
            const pixel = row_start + 1 + x * 4;
            rows[pixel] = 0;
            rows[pixel + 1] = 0;
            rows[pixel + 2] = 0;
            rows[pixel + 3] = alpha;
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = BIT_DEPTH;
    header[9] = COLOUR_TYPE_RGBA;
    header[10] = 0;
    header[11] = 0;
    header[12] = 0;
    const png = Buffer.concat([
        PNG_SIGNATURE,
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(rows)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
    assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE));
    return png;
}

/** Opaque inside the ring, with a 1 px soft edge on both sides so the shape is not jagged. */
function ring_alpha(distance: number, inner: number, outer: number): number {
    const edge_outer = Math.min(1, Math.max(0, outer - distance + 0.5));
    const edge_inner = Math.min(1, Math.max(0, distance - inner + 0.5));
    return Math.round(255 * edge_outer * edge_inner);
}

function chunk(type: string, data: Buffer): Buffer {
    assert.equal(type.length, 4);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const type_and_data = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(type_and_data), 0);
    return Buffer.concat([length, type_and_data, crc]);
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
        c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    CRC_TABLE[n] = c >>> 0;
}

export function crc32(data: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
