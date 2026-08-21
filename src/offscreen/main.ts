import { z } from "zod";
import { OffscreenExportRunner } from "./export-runner";
import { localeSchema } from "../shared/i18n";
import { sessionIdSchema } from "../shared/ids";

/**
 * Offscreen document entry (design 3.2 & 13).
 *
 * Handles export messages from Service Worker and Side Panel, running ZipWriter
 * and file streaming offscreen.
 */
const exportStartMessageSchema = z.object({
  type: z.literal("offscreen/export/start"),
  sessionId: sessionIdSchema,
  format: z.enum(["zip", "single_json"]).optional(),
  sink: z.enum(["file_system_writable", "opfs_downloads_fallback"]).optional(),
  /** Language snapshot for the export (crawler-12); defaults to zh. */
  locale: localeSchema.optional(),
});

const typedMessageSchema = z.object({ type: z.string() });

const runner = new OffscreenExportRunner();

chrome.runtime.onMessage.addListener((rawMessage: unknown, _sender, sendResponse) => {
  const parsed = typedMessageSchema.safeParse(rawMessage);
  if (!parsed.success) {
    return false;
  }

  if (parsed.data.type === "offscreen/ping") {
    sendResponse({ ok: true, value: { alive: true } });
    return false;
  }

  if (parsed.data.type === "offscreen/export/start") {
    const exportMsg = exportStartMessageSchema.safeParse(rawMessage);
    if (!exportMsg.success) {
      sendResponse({
        ok: false,
        error: { code: "PROTOCOL_MESSAGE_INVALID", message: "Invalid export start message" },
      });
      return false;
    }

    runner
      .runExport({
        sessionId: exportMsg.data.sessionId,
        format: exportMsg.data.format,
        sink: exportMsg.data.sink,
        locale: exportMsg.data.locale,
      })
      .then((res) => {
        if (res.state === "completed") {
          // Wire contract is exportSessionResponseSchema ({ jobId, state },
          // strict). The runner's `result` is internal — sending it would fail
          // the UI boundary's Zod validation with PROTOCOL_MESSAGE_INVALID.
          sendResponse({ ok: true, value: { jobId: res.jobId, state: res.state } });
        } else {
          sendResponse({
            ok: false,
            error: res.error ?? { code: "EXPORT_STREAM_FAILED", message: "Export failed" },
          });
        }
      })
      .catch((err: unknown) => {
        sendResponse({
          ok: false,
          error: {
            code: "EXPORT_STREAM_FAILED",
            message: err instanceof Error ? err.message : "Export failed",
          },
        });
      });

    return true; // async response
  }

  return false;
});
