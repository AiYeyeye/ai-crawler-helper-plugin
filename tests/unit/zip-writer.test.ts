import { describe, expect, it } from "vitest";
import { ZipWriter, computeCrc32 } from "../../src/export/zip-writer";

describe("ZipWriter unit tests", () => {
  it("computes accurate CRC-32 for known strings", () => {
    const data = new TextEncoder().encode("Hello, World!");
    const crc = computeCrc32(data);
    expect(crc).toBe(0xec4ac3d0);
  });

  it("writes valid ZIP binary structure with local header and EOCD", async () => {
    const chunks: Uint8Array[] = [];
    const writer = new ZipWriter({
      write: (chunk) => {
        chunks.push(chunk);
        return Promise.resolve();
      },
    });

    await writer.addFile("test.txt", "Hello, World!");
    await writer.addFile("sub/data.json", JSON.stringify({ key: "value" }));
    await writer.close();

    const totalBytes = chunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalBytes).toBeGreaterThan(100);

    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    const view = new DataView(merged.buffer);

    // First local file header signature: 0x04034b50
    expect(view.getUint32(0, true)).toBe(0x04034b50);

    // EOCD signature at end (22 bytes from end): 0x06054b50
    const eocdOffset = totalBytes - 22;
    expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50);

    // Total entries in EOCD
    expect(view.getUint16(eocdOffset + 10, true)).toBe(2);
  });
});
