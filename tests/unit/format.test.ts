import { describe, expect, it } from "vitest";
import { businessError } from "../../src/shared/errors";
import { errorText } from "../../src/ui/format";

describe("errorText", () => {
  it("shows the normalized debugger attach cause so the operator can act on it", () => {
    const error = businessError(
      "DEBUGGER_ATTACH_FAILED",
      "Unable to attach and enable the debugger network collector.",
      { cause: "Error: Another debugger is already attached to the tab" },
    );

    expect(errorText(error)).toBe(
      "DEBUGGER_ATTACH_FAILED：Unable to attach and enable the debugger network collector." +
        "（Error: Another debugger is already attached to the tab）",
    );
  });

  it("does not expose diagnostic details for unrelated business errors", () => {
    const error = businessError("SESSION_NOT_FOUND", "Session does not exist.", {
      cause: "internal lookup detail",
    });

    expect(errorText(error)).toBe("SESSION_NOT_FOUND：Session does not exist.");
  });
});
