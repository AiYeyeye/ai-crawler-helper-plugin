import { describe, expect, it } from "vitest";
import { jsonUtf8ByteLength, utf8ByteLength } from "../../src/shared/json-bytes";

describe("byte accounting is UTF-8 accurate, not string length", () => {
  it("ASCII text: bytes equal length", () => {
    expect(utf8ByteLength("hello")).toBe(5);
  });

  it("CJK text: bytes exceed JS string length", () => {
    const text = "青岛到汉堡"; // 5 chars, 15 UTF-8 bytes
    expect(text.length).toBe(5);
    expect(utf8ByteLength(text)).toBe(15);
  });

  it("emoji (surrogate pairs) measured by encoded bytes", () => {
    const text = "🚢"; // length 2, 4 UTF-8 bytes
    expect(text.length).toBe(2);
    expect(utf8ByteLength(text)).toBe(4);
  });

  it("JSON serialization bytes include structural characters", () => {
    expect(jsonUtf8ByteLength({ a: "青" })).toBe(utf8ByteLength('{"a":"青"}'));
  });
});
