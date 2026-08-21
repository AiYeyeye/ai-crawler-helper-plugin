import type {
  CaptureCollector,
  CollectorPipeline,
  CollectorStartResult,
} from "../core/collector-contracts";
import type { NavigationContextRepository } from "../persistence/navigation-context-repository";
import type { SessionRepository } from "../persistence/session-repository";
import { sessionRecordSchema } from "../schemas/session";
import { businessError, err, ok, type Result } from "../shared/errors";
import type { CaptureEpochId, ExtTabId, SessionId } from "../shared/ids";

interface PausableObservationProcessor {
  sessionPaused(sessionId: SessionId): Promise<void>;
}

interface PreparableCollector extends CaptureCollector {
  prepare(context: Parameters<CaptureCollector["start"]>[0]): Promise<CollectorStartResult>;
  activate(context: Parameters<CaptureCollector["start"]>[0]): Promise<CollectorStartResult>;
}

export interface PreparedCaptureResume {
  activate(): Promise<Result<void>>;
  rollback(): Promise<void>;
}

const isPreparableCollector = (collector: CaptureCollector): collector is PreparableCollector => {
  const candidate = collector as Partial<PreparableCollector>;
  return typeof candidate.prepare === "function" && typeof candidate.activate === "function";
};

export interface SessionCaptureLifecycleCoordinatorOptions {
  sessions: Pick<SessionRepository, "getSession">;
  contexts: Pick<NavigationContextRepository, "listTabsBySession">;
  pipeline: () => CollectorPipeline | null;
  networkCollector: {
    attachTab(sessionId: SessionId, tabId: ExtTabId): Promise<CollectorStartResult>;
  };
  processorForSession: (sessionId: SessionId) => PausableObservationProcessor | undefined;
  navigation: {
    forgetSession(sessionId: SessionId): Promise<void> | void;
  };
}

/** Keeps the persisted pause/resume transition and live collectors in lockstep. */
export class SessionCaptureLifecycleCoordinator {
  constructor(private readonly options: SessionCaptureLifecycleCoordinatorOptions) {}

  async pause(sessionId: SessionId): Promise<void> {
    let firstFailure: unknown;
    const captureFailure = (cause: unknown): void => {
      firstFailure ??= cause;
    };

    for (const collector of [...(this.options.pipeline()?.collectors ?? [])].reverse()) {
      try {
        await collector.disconnect(sessionId);
      } catch (cause: unknown) {
        captureFailure(cause);
      }
    }

    try {
      await this.options.processorForSession(sessionId)?.sessionPaused(sessionId);
    } catch (cause: unknown) {
      captureFailure(cause);
    }
    try {
      await this.options.navigation.forgetSession(sessionId);
    } catch (cause: unknown) {
      captureFailure(cause);
    }

    if (firstFailure !== undefined) {
      throw firstFailure instanceof Error
        ? firstFailure
        : new Error("capture pause coordination failed", { cause: firstFailure });
    }
  }

  async restoreStopping(sessionId: SessionId): Promise<Result<void>> {
    let session;
    try {
      session = await this.options.sessions.getSession(sessionId);
    } catch {
      return err(
        businessError(
          "PERSISTENCE_TRANSACTION_FAILED",
          "stopping capture restoration could not read the durable session",
          { sessionId },
        ),
      );
    }
    if (session === null) {
      return err(businessError("SESSION_NOT_FOUND", `session ${sessionId} not found`));
    }
    if (session.lifecycle !== "stopping") {
      return err(
        businessError(
          "SESSION_INVALID_TRANSITION",
          `stopping capture restoration is invalid from ${session.lifecycle}`,
          { sessionId, state: session.lifecycle },
        ),
      );
    }
    const pipeline = this.options.pipeline();
    if (pipeline === null) {
      return err(
        businessError(
          "CAPTURE_PIPELINE_UNAVAILABLE",
          "capture pipeline is unavailable while restoring a stopping session",
          { sessionId },
        ),
      );
    }

    const started: CaptureCollector[] = [];
    for (const collector of pipeline.collectors) {
      let result: CollectorStartResult;
      try {
        result = await collector.start({ session });
      } catch {
        result = {
          ok: false,
          error: businessError(
            "DEBUGGER_ATTACH_FAILED",
            `collector ${collector.name} threw while restoring a stopping session`,
            { collector: collector.name, sessionId },
          ),
        };
      }
      if (!result.ok) {
        const rollbackFailures = await this.rollback(started, sessionId);
        return rollbackFailures.length === 0
          ? err(result.error)
          : err(this.rollbackError(sessionId, rollbackFailures));
      }
      started.push(collector);
    }

    try {
      const tabs = await this.options.contexts.listTabsBySession(sessionId);
      for (const tab of tabs) {
        if (tab.tabId === session.rootTabId) {
          continue;
        }
        const attached = await this.options.networkCollector.attachTab(sessionId, tab.tabId);
        if (!attached.ok) {
          const rollbackFailures = await this.rollback(started, sessionId);
          return rollbackFailures.length === 0
            ? err(attached.error)
            : err(this.rollbackError(sessionId, rollbackFailures));
        }
      }
    } catch {
      const rollbackFailures = await this.rollback(started, sessionId);
      return rollbackFailures.length === 0
        ? err(
            businessError(
              "DEBUGGER_ATTACH_FAILED",
              "derived-tab debugger restoration failed for a stopping session",
              { sessionId },
            ),
          )
        : err(this.rollbackError(sessionId, rollbackFailures));
    }
    return ok(undefined);
  }

  async resume(
    sessionId: SessionId,
    captureEpochId: CaptureEpochId,
  ): Promise<Result<PreparedCaptureResume>> {
    let session;
    try {
      session = await this.options.sessions.getSession(sessionId);
    } catch {
      return err(
        businessError(
          "PERSISTENCE_TRANSACTION_FAILED",
          "capture pipeline restart could not read the resumed session",
          { sessionId },
        ),
      );
    }
    if (session === null) {
      return err(businessError("SESSION_NOT_FOUND", `session ${sessionId} not found`));
    }
    const preparedSession = sessionRecordSchema.parse({
      ...session,
      lifecycle: "recording",
      captureEpochIds: session.captureEpochIds.includes(captureEpochId)
        ? session.captureEpochIds
        : [...session.captureEpochIds, captureEpochId],
    });

    const pipeline = this.options.pipeline();
    if (pipeline === null) {
      return err(
        businessError(
          "CAPTURE_PIPELINE_UNAVAILABLE",
          "capture pipeline is unavailable during storage-pressure resume",
          { sessionId },
        ),
      );
    }

    const started: CaptureCollector[] = [];
    for (const collector of pipeline.collectors) {
      let result: CollectorStartResult;
      if (!isPreparableCollector(collector)) {
        result = {
          ok: false,
          error: businessError(
            "CAPTURE_PIPELINE_UNAVAILABLE",
            `collector ${collector.name} does not support two-phase resume`,
            { collector: collector.name, sessionId },
          ),
        };
      } else {
        try {
          result = await collector.prepare({ session: preparedSession });
        } catch {
          result = {
            ok: false,
            error: businessError(
              "DEBUGGER_ATTACH_FAILED",
              `collector ${collector.name} threw during storage-pressure resume`,
              { collector: collector.name, sessionId },
            ),
          };
        }
      }
      if (!result.ok) {
        const rollbackFailures = await this.rollback(started, sessionId);
        return rollbackFailures.length === 0
          ? err(result.error)
          : err(this.rollbackError(sessionId, rollbackFailures));
      }
      started.push(collector);
    }

    try {
      const tabs = await this.options.contexts.listTabsBySession(sessionId);
      for (const tab of tabs) {
        if (tab.tabId === session.rootTabId) {
          continue;
        }
        const result = await this.options.networkCollector.attachTab(sessionId, tab.tabId);
        if (!result.ok) {
          const rollbackFailures = await this.rollback(started, sessionId);
          return rollbackFailures.length === 0
            ? err(result.error)
            : err(this.rollbackError(sessionId, rollbackFailures));
        }
      }
    } catch {
      const rollbackFailures = await this.rollback(started, sessionId);
      if (rollbackFailures.length > 0) {
        return err(this.rollbackError(sessionId, rollbackFailures));
      }
      return err(
        businessError(
          "DEBUGGER_ATTACH_FAILED",
          "derived-tab debugger restart failed after storage-pressure resume",
          { sessionId },
        ),
      );
    }

    let rolledBack = false;
    let activated = false;
    const rollback = async (): Promise<void> => {
      if (rolledBack) {
        return;
      }
      rolledBack = true;
      const failures = await this.rollback(started, sessionId);
      if (failures.length > 0) {
        throw new AggregateError(failures, "storage-pressure resume rollback failed");
      }
    };
    return ok({
      activate: async (): Promise<Result<void>> => {
        if (activated) {
          return ok(undefined);
        }
        for (const collector of started) {
          if (!isPreparableCollector(collector)) {
            continue;
          }
          let result: CollectorStartResult;
          try {
            result = await collector.activate({ session: preparedSession });
          } catch {
            result = {
              ok: false,
              error: businessError(
                "PERSISTENCE_TRANSACTION_FAILED",
                `collector ${collector.name} threw during storage-pressure activation`,
                { collector: collector.name, sessionId },
              ),
            };
          }
          if (!result.ok) {
            try {
              await rollback();
            } catch {
              return err(
                businessError(
                  "PERSISTENCE_TRANSACTION_FAILED",
                  "collector activation and rollback both failed",
                  { sessionId, collector: collector.name },
                ),
              );
            }
            return err(result.error);
          }
        }
        activated = true;
        return ok(undefined);
      },
      rollback,
    });
  }

  private async rollback(
    started: readonly CaptureCollector[],
    sessionId: SessionId,
  ): Promise<unknown[]> {
    const failures: unknown[] = [];
    for (const collector of [...started].reverse()) {
      try {
        await collector.disconnect(sessionId);
      } catch (cause: unknown) {
        failures.push(cause);
      }
    }
    return failures;
  }

  private rollbackError(sessionId: SessionId, failures: readonly unknown[]) {
    return businessError(
      "PERSISTENCE_TRANSACTION_FAILED",
      "storage-pressure resume rollback failed",
      { sessionId, failureCount: failures.length },
    );
  }
}
