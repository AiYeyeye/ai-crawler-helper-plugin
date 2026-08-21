import {
  PROTOCOL_VERSION,
  appSettingsResponseSchema,
  exportSessionResponseSchema,
  listSessionsResponseSchema,
  runtimeResponseSchema,
  sessionSnapshotSchema,
  startRecordingResponseSchema,
  stepDetailSchema,
  type ExportSessionResponse,
  type SessionSnapshot,
  type StepDetail,
} from "../shared/messages";
import type { SessionRecord } from "../schemas/session";
import type { AppSettings, SessionConfigPatch } from "../schemas/settings";
import type { Locale } from "../shared/i18n";
import { businessError, type Result } from "../shared/errors";
import type { SessionId, StepId } from "../shared/ids";

/**
 * Typed client for UI -> service worker requests. Decodes responses once at
 * this boundary; components consume typed values only.
 */

const request = async (message: unknown): Promise<Result<unknown>> => {
  try {
    const raw: unknown = await chrome.runtime.sendMessage(message);
    const parsed = runtimeResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: businessError("PROTOCOL_MESSAGE_INVALID", "response failed protocol validation"),
      };
    }
    return parsed.data.ok
      ? { ok: true, value: parsed.data.value }
      : { ok: false, error: parsed.data.error };
  } catch {
    return {
      ok: false,
      error: businessError("PROTOCOL_MESSAGE_INVALID", "service worker unreachable"),
    };
  }
};

/** Structural view of a Zod schema — enough to decode, no zod import needed. */
interface PayloadDecoder<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: unknown };
}

/** Decode a response payload once, at this boundary. */
const decode = <T>(
  schema: PayloadDecoder<T>,
  value: unknown,
  label: string,
): Result<T> => {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        error: businessError("PROTOCOL_MESSAGE_INVALID", `${label} payload invalid`),
      };
};

export const listSessions = async (): Promise<Result<SessionRecord[]>> => {
  const response = await request({ protocolVersion: PROTOCOL_VERSION, type: "query/listSessions" });
  if (!response.ok) {
    return response;
  }
  const parsed = listSessionsResponseSchema.safeParse(response.value);
  return parsed.success
    ? { ok: true, value: parsed.data.sessions }
    : {
        ok: false,
        error: businessError("PROTOCOL_MESSAGE_INVALID", "listSessions payload invalid"),
      };
};

export const getSessionSnapshot = async (
  sessionId: SessionId,
): Promise<Result<SessionSnapshot>> => {
  const response = await request({
    protocolVersion: PROTOCOL_VERSION,
    type: "query/sessionSnapshot",
    sessionId,
  });
  return response.ok ? decode(sessionSnapshotSchema, response.value, "sessionSnapshot") : response;
};

export const startRecording = async (
  tabId: number,
  mode: "no_reload" | "reload",
): Promise<Result<{ sessionId: SessionId }>> => {
  const response = await request({
    protocolVersion: PROTOCOL_VERSION,
    type: "command/startRecording",
    tabId,
    mode,
  });
  return response.ok ? decode(startRecordingResponseSchema, response.value, "startRecording") : response;
};

export const stopRecording = (sessionId: SessionId): Promise<Result<unknown>> =>
  request({ protocolVersion: PROTOCOL_VERSION, type: "command/stopRecording", sessionId });

export const deleteSession = (sessionId: SessionId): Promise<Result<unknown>> =>
  request({ protocolVersion: PROTOCOL_VERSION, type: "command/deleteSession", sessionId });

export const exportSession = async (
  sessionId: SessionId,
  format?: "zip" | "single_json",
  sink?: "file_system_writable" | "opfs_downloads_fallback",
): Promise<Result<ExportSessionResponse>> => {
  const response = await request({
    protocolVersion: PROTOCOL_VERSION,
    type: "command/exportSession",
    sessionId,
    format,
    sink,
  });
  return response.ok ? decode(exportSessionResponseSchema, response.value, "exportSession") : response;
};

export const resumeAfterStoragePressure = (sessionId: SessionId): Promise<Result<unknown>> =>
  request({
    protocolVersion: PROTOCOL_VERSION,
    type: "command/resumeAfterStoragePressure",
    sessionId,
  });

export const getStepDetail = async (stepId: StepId): Promise<Result<StepDetail>> => {
  const response = await request({
    protocolVersion: PROTOCOL_VERSION,
    type: "query/stepDetail",
    stepId,
  });
  return response.ok ? decode(stepDetailSchema, response.value, "stepDetail") : response;
};

/**
 * Review-layer write. Raw facts stay immutable: this only flips `excluded`
 * or sets/clears `note`, and it goes through the message protocol — the UI
 * never touches a repository directly.
 */
export const updateStepReview = (input: {
  stepId: StepId;
  excluded?: boolean;
  note?: string | null;
}): Promise<Result<unknown>> =>
  request({
    protocolVersion: PROTOCOL_VERSION,
    type: "command/updateStepReview",
    stepId: input.stepId,
    ...(input.excluded === undefined ? {} : { excluded: input.excluded }),
    ...(input.note === undefined ? {} : { note: input.note }),
  });

export const getAppSettings = async (): Promise<Result<AppSettings>> => {
  const response = await request({
    protocolVersion: PROTOCOL_VERSION,
    type: "query/appSettings",
  });
  return response.ok ? decode(appSettingsResponseSchema, response.value, "appSettings") : response;
};

export const updateAppSettings = async (
  patch: SessionConfigPatch,
): Promise<Result<AppSettings>> => {
  const response = await request({
    protocolVersion: PROTOCOL_VERSION,
    type: "command/updateAppSettings",
    patch,
  });
  return response.ok ? decode(appSettingsResponseSchema, response.value, "appSettings") : response;
};

export const updateLocale = async (
  locale: Locale,
): Promise<Result<AppSettings>> => {
  const response = await request({
    protocolVersion: PROTOCOL_VERSION,
    type: "command/updateLocale",
    locale,
  });
  return response.ok ? decode(appSettingsResponseSchema, response.value, "appSettings") : response;
};
