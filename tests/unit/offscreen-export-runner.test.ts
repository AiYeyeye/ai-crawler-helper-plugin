import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OffscreenExportRunner } from "../../src/offscreen/export-runner";
import { openDatabase } from "../../src/persistence/database";
import { SessionRepository } from "../../src/persistence/session-repository";
import { extTabIdSchema } from "../../src/shared/ids";
import { T0, defaultSessionConfig } from "../helpers/fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OffscreenExportRunner download boundary", () => {
  it("delegates the fallback download to the service worker instead of reading chrome.downloads", async () => {
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    const requestDownload = vi.fn(() => Promise.resolve(17));
    vi.stubGlobal("chrome", { runtime: { sendMessage: requestDownload } });
    const db = await openDatabase();
    const sessions = new SessionRepository(db);
    const created = await sessions.createSession({
      originUrl: "https://example.com/",
      rootTabId: extTabIdSchema.parse(1),
      startMode: "no_reload",
      config: defaultSessionConfig(),
      now: T0,
    });
    await sessions.applyLifecycleEvent(created.sessionId, "start_completed", { now: T0 });
    const session = await sessions.getSession(created.sessionId);
    if (session === null) {
      throw new Error("session fixture vanished");
    }
    const revokeObjectUrl = vi.fn();
    const runner = new OffscreenExportRunner({
      openDatabase: () => Promise.resolve(db),
      requestDownload,
      createObjectUrl: () => "blob:ai-crawler-helper/export-17",
      scheduleObjectUrlRevoke: (run) => {
        run();
      },
      revokeObjectUrl,
    });

    const result = await runner.runExport({
      sessionId: session.sessionId,
      format: "zip",
      sink: "opfs_downloads_fallback",
    });

    expect(result).toMatchObject({ state: "completed" });
    expect(requestDownload).toHaveBeenCalledOnce();
    expect(requestDownload).toHaveBeenCalledWith({
      url: "blob:ai-crawler-helper/export-17",
      filename: `session-${session.sessionId}.zip`,
      saveAs: true,
    });
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:ai-crawler-helper/export-17");
  });
});
