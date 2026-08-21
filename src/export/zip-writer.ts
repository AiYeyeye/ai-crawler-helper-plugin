/**
 * Streaming pure-TypeScript ZipWriter (design 13).
 *
 * Writes local headers and file payloads chunk-by-chunk to a WritableStream or
 * custom chunk handler with minimal memory overhead. Central Directory records
 * (~46 bytes per file) are accumulated in memory and flushed at close().
 */

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

export const computeCrc32 = (data: Uint8Array): number => {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    const tableValue = byte !== undefined ? CRC_TABLE[(crc ^ byte) & 0xff] : undefined;
    if (tableValue !== undefined) {
      crc = (crc >>> 8) ^ tableValue;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

interface ZipEntryMetadata {
  filename: string;
  filenameBytes: Uint8Array;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
  modTime: number;
  modDate: number;
}

export interface ZipWriterTarget {
  write(chunk: Uint8Array): Promise<void>;
}

export class ZipWriter {
  private readonly target: ZipWriterTarget;
  private readonly entries: ZipEntryMetadata[] = [];
  private currentOffset = 0;
  private closed = false;

  constructor(target: ZipWriterTarget) {
    this.target = target;
  }

  /**
   * Add a file to the ZIP archive. Writes local header + content immediately.
   */
  async addFile(
    filename: string,
    content: Uint8Array | string,
    modDate: Date = new Date(),
  ): Promise<void> {
    if (this.closed) {
      throw new Error("ZipWriter is already closed");
    }

    const contentBytes =
      typeof content === "string" ? new TextEncoder().encode(content) : content;
    const filenameBytes = new TextEncoder().encode(filename);

    const crc32 = computeCrc32(contentBytes);
    const uncompressedSize = contentBytes.length;
    const compressedSize = uncompressedSize; // STORE method

    const dosTime = dateToDosTime(modDate);

    const localHeaderOffset = this.currentOffset;

    // Local file header (30 bytes + filename)
    const header = new Uint8Array(30 + filenameBytes.length);
    const view = new DataView(header.buffer);

    view.setUint32(0, 0x04034b50, true); // Local header signature
    view.setUint16(4, 20, true); // Version needed (2.0)
    view.setUint16(6, 0x0800, true); // General purpose flag (UTF-8 filename)
    view.setUint16(8, 0, true); // Compression method (0 = STORE)
    view.setUint16(10, dosTime.time, true);
    view.setUint16(12, dosTime.date, true);
    view.setUint32(14, crc32, true);
    view.setUint32(18, compressedSize, true);
    view.setUint32(22, uncompressedSize, true);
    view.setUint16(26, filenameBytes.length, true);
    view.setUint16(28, 0, true); // Extra field length

    header.set(filenameBytes, 30);

    await this.target.write(header);
    this.currentOffset += header.length;

    await this.target.write(contentBytes);
    this.currentOffset += contentBytes.length;

    this.entries.push({
      filename,
      filenameBytes,
      crc32,
      compressedSize,
      uncompressedSize,
      offset: localHeaderOffset,
      modTime: dosTime.time,
      modDate: dosTime.date,
    });
  }

  /**
   * Finalizes the ZIP file by writing Central Directory records + EOCD.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    const centralDirOffset = this.currentOffset;
    let centralDirSize = 0;

    for (const entry of this.entries) {
      const cdHeader = new Uint8Array(46 + entry.filenameBytes.length);
      const view = new DataView(cdHeader.buffer);

      view.setUint32(0, 0x02014b50, true); // Central directory header signature
      view.setUint16(4, 20, true); // Version made by
      view.setUint16(6, 20, true); // Version needed
      view.setUint16(8, 0x0800, true); // UTF-8 flag
      view.setUint16(10, 0, true); // Compression method (STORE)
      view.setUint16(12, entry.modTime, true);
      view.setUint16(14, entry.modDate, true);
      view.setUint32(16, entry.crc32, true);
      view.setUint32(20, entry.compressedSize, true);
      view.setUint32(24, entry.uncompressedSize, true);
      view.setUint16(28, entry.filenameBytes.length, true);
      view.setUint16(30, 0, true); // Extra field length
      view.setUint16(32, 0, true); // Comment length
      view.setUint16(34, 0, true); // Disk number start
      view.setUint16(36, 0, true); // Internal attributes
      view.setUint32(38, 0, true); // External attributes
      view.setUint32(42, entry.offset, true); // Offset of local header

      cdHeader.set(entry.filenameBytes, 46);

      await this.target.write(cdHeader);
      this.currentOffset += cdHeader.length;
      centralDirSize += cdHeader.length;
    }

    // End of central directory (EOCD) record (22 bytes)
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);

    eocdView.setUint32(0, 0x06054b50, true); // EOCD signature
    eocdView.setUint16(4, 0, true); // Disk number
    eocdView.setUint16(6, 0, true); // Disk with central directory
    eocdView.setUint16(8, this.entries.length, true); // Number of entries on disk
    eocdView.setUint16(10, this.entries.length, true); // Total entries
    eocdView.setUint32(12, centralDirSize, true);
    eocdView.setUint32(16, centralDirOffset, true);
    eocdView.setUint16(20, 0, true); // Comment length

    await this.target.write(eocd);
    this.currentOffset += eocd.length;
  }
}

const dateToDosTime = (date: Date): { time: number; date: number } => {
  const year = Math.max(0, date.getFullYear() - 1980);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  const dosDate = (year << 9) | (month << 5) | day;
  const dosTime = (hours << 11) | (minutes << 5) | seconds;

  return { time: dosTime, date: dosDate };
};
