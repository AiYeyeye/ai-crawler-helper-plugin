import { ArchiveExporter, type ExportResult } from "../export/archive-exporter";
import type { ZipWriterTarget } from "../export/zip-writer";
import { openDatabase } from "../persistence/database";
import {
  createExportJob,
  createExportSnapshot,
  updateExportJob,
} from "../persistence/export-job-repository";
import type { ExportJobId, SessionId } from "../shared/ids";
import { DEFAULT_LOCALE, type Locale } from "../shared/i18n";
import {
  downloadStartResponseSchema,
  PROTOCOL_VERSION,
  runtimeResponseSchema,
} from "../shared/messages";

export interface ExportStartParams {
  sessionId: SessionId;
  format?: "zip" | "single_json" | undefined;
  sink?: "file_system_writable" | "opfs_downloads_fallback" | undefined;
  writableStream?: WritableStream<Uint8Array> | undefined;
  /** Language snapshot taken by the Service Worker at export start. */
  locale?: Locale | undefined;
}

export interface ExportRunnerResponse {
  jobId: ExportJobId;
  state: string;
  result?: ExportResult | undefined;
  error?: { code: string; message: string } | undefined;
}

interface DownloadStartRequest {
  readonly url: string;
  readonly filename: string;
  readonly saveAs: boolean;
}

export interface OffscreenExportRunnerOptions {
  readonly openDatabase?: () => Promise<IDBDatabase>;
  readonly requestDownload?: (request: DownloadStartRequest) => Promise<number>;
  readonly createObjectUrl?: (blob: Blob) => string;
  readonly revokeObjectUrl?: (url: string) => void;
  readonly scheduleObjectUrlRevoke?: (run: () => void) => void;
}

/**
 * Offscreen Export Runner (design 3.2 & 13).
 *
 * Runs export jobs offscreen to prevent blocking SW event loop or UI thread.
 * Uses streaming ZipWriter to write chunks with backpressure.
 */
export class OffscreenExportRunner {
  private db: IDBDatabase | null = null;
  private readonly openDb: () => Promise<IDBDatabase>;
  private readonly requestDownload: (request: DownloadStartRequest) => Promise<number>;
  private readonly createObjectUrl: (blob: Blob) => string;
  private readonly revokeObjectUrl: (url: string) => void;
  private readonly scheduleObjectUrlRevoke: (run: () => void) => void;

  constructor(options: OffscreenExportRunnerOptions = {}) {
    this.openDb = options.openDatabase ?? (() => openDatabase());
    this.requestDownload = options.requestDownload ?? (async (request) => {
      const raw: unknown = await chrome.runtime.sendMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: "offscreen/download/start",
        ...request,
      });
      const response = runtimeResponseSchema.parse(raw);
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`);
      }
      const value = downloadStartResponseSchema.parse(response.value);
      return value.downloadId;
    });
    this.createObjectUrl = options.createObjectUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectUrl =
      options.revokeObjectUrl ??
      ((url) => {
        URL.revokeObjectURL(url);
      });
    this.scheduleObjectUrlRevoke =
      options.scheduleObjectUrlRevoke ??
      ((run) => {
        setTimeout(run, 10_000);
      });
  }

  private async getDb(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = await this.openDb();
    }
    return this.db;
  }

  async runExport(params: ExportStartParams): Promise<ExportRunnerResponse> {
    const db = await this.getDb();
    const format = params.format ?? "zip";
    const locale = params.locale ?? DEFAULT_LOCALE;
    const sink = params.sink ?? (params.writableStream !== undefined ? "file_system_writable" : "opfs_downloads_fallback");

    // 1. Create ExportSnapshot
    const snapshot = await createExportSnapshot(db, params.sessionId);

    // 2. Create ExportJob
    const job = await createExportJob(db, params.sessionId, snapshot.snapshotId, format, sink);

    try {
      // 3. Mark job state writing
      await updateExportJob(db, job.jobId, { state: "writing" });

      const chunks: Uint8Array[] = [];
      let target: ZipWriterTarget;

      if (params.writableStream !== undefined) {
        const writer = params.writableStream.getWriter();
        target = {
          write: (chunk: Uint8Array) => writer.write(chunk),
        };
      } else {
        // In-memory / OPFS target chunk accumulator
        target = {
          write: (chunk: Uint8Array) => {
            chunks.push(chunk);
            return Promise.resolve();
          },
        };
      }

      const exporter = new ArchiveExporter(db);
      const result = await exporter.exportArchive(params.sessionId, snapshot, job, target, locale);

      // 4. Validate first. A fallback job is not complete until the Service
      // Worker (the context that owns chrome.downloads) accepts the download.
      await updateExportJob(db, job.jobId, { state: "validating" });
      await updateExportJob(db, job.jobId, { state: "ready_to_download" });

      // Handle download fallback if opfs_downloads_fallback
      if (sink === "opfs_downloads_fallback") {
        await this.triggerChromeDownload(params.sessionId, format, chunks, result.singleJsonContent);
      }

      await updateExportJob(db, job.jobId, {
        state: "completed",
        completedEntryCount: result.entryCount,
      });

      return {
        jobId: job.jobId,
        state: "completed",
        result,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Export failed";
      const code = (err as { businessError?: { code?: string } }).businessError?.code ?? "EXPORT_STREAM_FAILED";

      await updateExportJob(db, job.jobId, {
        state: "failed",
        failure: { errorCode: code, detail: message },
      });

      return {
        jobId: job.jobId,
        state: "failed",
        error: { code, message },
      };
    }
  }

  private async triggerChromeDownload(
    sessionId: string,
    format: "zip" | "single_json",
    chunks: Uint8Array[],
    singleJsonContent?: string,
  ): Promise<void> {
    let blob: Blob;
    let filename: string;

    if (format === "single_json" && singleJsonContent !== undefined) {
      blob = new Blob([singleJsonContent], { type: "application/json" });
      filename = `session-${sessionId}.json`;
    } else {
      blob = new Blob(chunks, { type: "application/zip" });
      filename = `session-${sessionId}.zip`;
    }

    const url = this.createObjectUrl(blob);
    try {
      await this.requestDownload({
        url,
        filename,
        saveAs: true,
      });
    } finally {
      // Revoke after delay to allow download start
      this.scheduleObjectUrlRevoke(() => {
        this.revokeObjectUrl(url);
      });
    }
  }
}
