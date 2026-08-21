import { z } from "zod";

/**
 * Branded identifiers.
 *
 * Two disjoint identifier spaces exist in this project and must NEVER be
 * compared or substituted for one another (PRD 3.3 / design 9.1 / type-safety
 * spec):
 *
 *  - Extension space: `ExtTabId` (number), `ExtFrameId` (number),
 *    `ExtDocumentId` (string from chrome.webNavigation).
 *  - CDP space: `CdpTargetId`, `CdpSessionId`, `CdpFrameId`, `CdpLoaderId`,
 *    `CdpRequestId` (strings from the DevTools protocol).
 *
 * They may only be related through the versioned mapping table whose result is
 * `confirmed | ambiguous | unmapped` (see schemas/network.ts). Branding makes
 * cross-space assignment a compile error.
 */

// ---------------------------------------------------------------------------
// Business entity ids
// ---------------------------------------------------------------------------

export const sessionIdSchema = z.string().min(1).brand<"SessionId">();
export type SessionId = z.infer<typeof sessionIdSchema>;

export const stepIdSchema = z.string().min(1).brand<"StepId">();
export type StepId = z.infer<typeof stepIdSchema>;

export const eventIdSchema = z.string().min(1).brand<"EventId">();
export type EventId = z.infer<typeof eventIdSchema>;

/** Ephemeral content-script correlation id; never substitutes for a StepId. */
export const candidateTokenSchema = z.string().min(1).brand<"CandidateToken">();
export type CandidateToken = z.infer<typeof candidateTokenSchema>;

export const gapIdSchema = z.string().min(1).brand<"GapId">();
export type GapId = z.infer<typeof gapIdSchema>;

/** Capture epoch: bumped on every (re)start of fact intake for a session. */
export const captureEpochIdSchema = z.string().min(1).brand<"CaptureEpochId">();
export type CaptureEpochId = z.infer<typeof captureEpochIdSchema>;

/** Debugger attach epoch: bumped on every successful (re)attach of a target. */
export const attachEpochSchema = z.number().int().nonnegative().brand<"AttachEpoch">();
export type AttachEpoch = z.infer<typeof attachEpochSchema>;

export const snapshotIdSchema = z.string().min(1).brand<"SnapshotId">();
export type SnapshotId = z.infer<typeof snapshotIdSchema>;

export const exportJobIdSchema = z.string().min(1).brand<"ExportJobId">();
export type ExportJobId = z.infer<typeof exportJobIdSchema>;

export const domRecordIdSchema = z.string().min(1).brand<"DomRecordId">();
export type DomRecordId = z.infer<typeof domRecordIdSchema>;

export const navigationRecordIdSchema = z.string().min(1).brand<"NavigationRecordId">();
export type NavigationRecordId = z.infer<typeof navigationRecordIdSchema>;

export const storageRecordIdSchema = z.string().min(1).brand<"StorageRecordId">();
export type StorageRecordId = z.infer<typeof storageRecordIdSchema>;

// ---------------------------------------------------------------------------
// Extension identifier space (chrome.tabs / chrome.webNavigation)
// ---------------------------------------------------------------------------

export const extTabIdSchema = z.number().int().nonnegative().brand<"ExtTabId">();
export type ExtTabId = z.infer<typeof extTabIdSchema>;

export const extFrameIdSchema = z.number().int().nonnegative().brand<"ExtFrameId">();
export type ExtFrameId = z.infer<typeof extFrameIdSchema>;

export const extDocumentIdSchema = z.string().min(1).brand<"ExtDocumentId">();
export type ExtDocumentId = z.infer<typeof extDocumentIdSchema>;

// ---------------------------------------------------------------------------
// CDP identifier space (chrome.debugger / DevTools protocol)
// ---------------------------------------------------------------------------

export const cdpTargetIdSchema = z.string().min(1).brand<"CdpTargetId">();
export type CdpTargetId = z.infer<typeof cdpTargetIdSchema>;

export const cdpSessionIdSchema = z.string().min(1).brand<"CdpSessionId">();
export type CdpSessionId = z.infer<typeof cdpSessionIdSchema>;

export const cdpFrameIdSchema = z.string().min(1).brand<"CdpFrameId">();
export type CdpFrameId = z.infer<typeof cdpFrameIdSchema>;

/**
 * CDP loaderId. Workers legitimately report an empty loaderId; that empty
 * string is a protocol fact and is preserved as-is (design 9.1).
 */
export const cdpLoaderIdSchema = z.string().brand<"CdpLoaderId">();
export type CdpLoaderId = z.infer<typeof cdpLoaderIdSchema>;

export const cdpRequestIdSchema = z.string().min(1).brand<"CdpRequestId">();
export type CdpRequestId = z.infer<typeof cdpRequestIdSchema>;

// ---------------------------------------------------------------------------
// Constructors (single place where raw values are branded)
// ---------------------------------------------------------------------------

const randomSuffix = (): string => crypto.randomUUID();

export const newSessionId = (): SessionId => sessionIdSchema.parse(`ses_${randomSuffix()}`);
export const newStepId = (): StepId => stepIdSchema.parse(`stp_${randomSuffix()}`);
export const newEventId = (): EventId => eventIdSchema.parse(`evt_${randomSuffix()}`);
export const newCandidateToken = (): CandidateToken =>
  candidateTokenSchema.parse(`can_${randomSuffix()}`);
export const newGapId = (): GapId => gapIdSchema.parse(`gap_${randomSuffix()}`);
export const newCaptureEpochId = (): CaptureEpochId =>
  captureEpochIdSchema.parse(`cep_${randomSuffix()}`);
export const newSnapshotId = (): SnapshotId => snapshotIdSchema.parse(`snp_${randomSuffix()}`);
export const newExportJobId = (): ExportJobId => exportJobIdSchema.parse(`exj_${randomSuffix()}`);
export const newDomRecordId = (): DomRecordId => domRecordIdSchema.parse(`dom_${randomSuffix()}`);
export const newNavigationRecordId = (): NavigationRecordId =>
  navigationRecordIdSchema.parse(`nav_${randomSuffix()}`);
export const newStorageRecordId = (): StorageRecordId =>
  storageRecordIdSchema.parse(`sto_${randomSuffix()}`);

export const toExtTabId = (raw: number): ExtTabId => extTabIdSchema.parse(raw);
export const toExtFrameId = (raw: number): ExtFrameId => extFrameIdSchema.parse(raw);
export const toExtDocumentId = (raw: string): ExtDocumentId => extDocumentIdSchema.parse(raw);
