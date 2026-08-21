/**
 * Byte accounting helpers.
 *
 * All logical byte counters (response-body soft budget, session logical size)
 * are measured on the actual UTF-8 serialization that will be written, never
 * on JavaScript string `length` (PRD 4.13 / research storage-export-capacity
 * section 3).
 */
const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
export const utf8ByteLength = (text: string): number => encoder.encode(text).byteLength;

/**
 * UTF-8 byte length of the JSON serialization of a record.
 * This is the logical-size proxy used for counters and admission estimates.
 * It intentionally measures what would be written, not engine-internal heap.
 */
export const jsonUtf8ByteLength = (value: unknown): number =>
  utf8ByteLength(JSON.stringify(value));
