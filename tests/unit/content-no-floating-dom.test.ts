/** @vitest-environment jsdom */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ContentRecordingController } from "../../src/content/recording-controller";
import {
  captureEpochIdSchema,
  extDocumentIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
  sessionIdSchema,
} from "../../src/shared/ids";
import { PROTOCOL_VERSION } from "../../src/shared/messages";
import { defaultSessionConfig } from "../helpers/fixtures";

/**
 * Gate 3 (subtask 06 / PRD 4.14): the extension must never inject a visible
 * floating toolbar or overlay into the recorded page. All plugin UI lives on
 * extension-owned surfaces (Popup, Side Panel).
 *
 * Two layers, because either alone is escapable:
 *  - a static assertion, so a newly added DOM-building call fails review even
 *    if no test happens to exercise that code path;
 *  - a behavioural assertion, so an indirect injection (via a helper, or a
 *    library) still fails.
 */

const CONTENT_DIR = join(process.cwd(), "src", "content");

/** DOM-construction APIs a read-only observer has no reason to call. */
const FORBIDDEN_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "createElement", pattern: /\bdocument\s*\.\s*createElement\b/u },
  { label: "createTextNode", pattern: /\bdocument\s*\.\s*createTextNode\b/u },
  { label: "appendChild", pattern: /\.\s*appendChild\s*\(/u },
  { label: "insertAdjacentHTML", pattern: /\.\s*insertAdjacentHTML\s*\(/u },
  { label: "insertAdjacentElement", pattern: /\.\s*insertAdjacentElement\s*\(/u },
  { label: "innerHTML assignment", pattern: /\.\s*innerHTML\s*=/u },
  { label: "outerHTML assignment", pattern: /\.\s*outerHTML\s*=/u },
  { label: "attachShadow", pattern: /\.\s*attachShadow\s*\(/u },
  { label: "document.write", pattern: /\bdocument\s*\.\s*write(ln)?\s*\(/u },
  { label: "replaceChildren", pattern: /\.\s*replaceChildren\s*\(/u },
  { label: "style mutation", pattern: /\.\s*style\s*\.\s*\w+\s*=/u },
];

const listContentSources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      return listContentSources(full);
    }
    return entry.name.endsWith(".ts") ? [full] : [];
  });

describe("content script injects no visible floating DOM (static)", () => {
  const sources = listContentSources(CONTENT_DIR);

  it("finds content-script sources to check", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(sources)("%s contains no DOM-construction call", (file) => {
    const source = readFileSync(file, "utf8");
    const violations = FORBIDDEN_PATTERNS.filter(({ pattern }) => pattern.test(source)).map(
      ({ label }) => label,
    );
    expect(violations).toEqual([]);
  });
});

describe("content script injects no visible floating DOM (behavioural)", () => {
  it("leaves the page DOM byte-identical across a full recording lifecycle", async () => {
    document.body.innerHTML = '<main id="app"><button id="go">Go</button></main>';
    const before = document.documentElement.outerHTML;
    const beforeNodeCount = document.querySelectorAll("*").length;

    const sendMessage = vi.fn(async (message: unknown): Promise<unknown> => {
      const typed = message as { type?: string };
      if (typed.type === "handshake/contentScript") {
        return Promise.resolve({
          ok: true,
          value: {
            active: true,
            sessionId: sessionIdSchema.parse("ses_no_dom"),
            captureEpochId: captureEpochIdSchema.parse("cep_no_dom"),
            scope: {
              tabId: extTabIdSchema.parse(1),
              documentId: extDocumentIdSchema.parse("doc-no-dom"),
              frameId: extFrameIdSchema.parse(0),
            },
            config: defaultSessionConfig(),
          },
        });
      }
      return Promise.resolve({ ok: true, value: { acks: [] } });
    });

    const controller = new ContentRecordingController({
      document,
      getUrl: () => "https://example.com/",
      sendMessage,
    });

    await controller.start();
    document.getElementById("go")?.click();
    await controller.flush();
    await controller.documentReplaced();

    expect(document.documentElement.outerHTML).toBe(before);
    expect(document.querySelectorAll("*").length).toBe(beforeNodeCount);
    // A handshake really did happen — the assertion above is not vacuous.
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolVersion: PROTOCOL_VERSION,
        type: "handshake/contentScript",
      }),
    );
  });
});
