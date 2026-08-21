import { ContentRecordingController } from "./recording-controller";
import { contentCommandSchema } from "../shared/messages";
import { businessError } from "../shared/errors";

const RETRY_INTERVAL_MS = 2_000;

const controller = new ContentRecordingController({
  document,
  getUrl: () => location.href,
  sendMessage: (message) => chrome.runtime.sendMessage(message),
});

let starting = false;

const startOrReplay = async (): Promise<void> => {
  if (starting) {
    return;
  }
  starting = true;
  try {
    await controller.start();
    await controller.flush();
  } catch {
    // A suspended/restarting Service Worker is expected. The observation
    // outbox remains in this document and the next interval retries it.
  } finally {
    starting = false;
  }
};

void startOrReplay();
const retryTimer = setInterval(() => {
  void startOrReplay();
}, RETRY_INTERVAL_MS);

window.addEventListener("pagehide", () => {
  clearInterval(retryTimer);
  void controller.documentReplaced();
});

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window) {
    return;
  }
  void controller.historyNavigation(event.data);
});

/**
 * Service Worker -> this frame. Page storage can only be read here, so the
 * worker asks each frame in turn rather than merging areas itself.
 */
chrome.runtime.onMessage.addListener(
  (message: unknown, _sender: unknown, sendResponse: (response: unknown) => void): boolean => {
    const command = contentCommandSchema.safeParse(message);
    if (!command.success) {
      return false;
    }
    void controller
      .collectPageStorage()
      .then((value) => {
        sendResponse(
          value === null
            ? {
                ok: false,
                error: businessError(
                  "CONTENT_SESSION_INACTIVE",
                  "This frame is not part of an active recording session.",
                ),
              }
            : { ok: true, value },
        );
      })
      .catch((cause: unknown) => {
        sendResponse({
          ok: false,
          error: businessError("PAGE_STORAGE_READ_FAILED", "Page storage could not be read.", {
            cause: cause instanceof Error ? cause.name : "unknown",
          }),
        });
      });
    // Keeps the message channel open for the async response.
    return true;
  },
);

export { controller };
