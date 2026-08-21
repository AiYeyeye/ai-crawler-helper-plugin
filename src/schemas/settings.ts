import { z } from "zod";
import {
  DEFAULT_RESPONSE_BODY_MAX_BYTES,
  DEFAULT_RESPONSE_BODY_SOFT_BUDGET_BYTES,
  HOVER_DWELL_THRESHOLD_MS,
  NETWORK_QUIET_WINDOW_MS,
  STEP_MAX_WINDOW_MS,
} from "../core/config";
import { localeSchema } from "../shared/i18n";
import { epochMsSchema, schemaVersionSchema } from "./common";
import { sessionConfigSchema, type SessionConfig } from "./session";

/**
 * Persisted application settings (PRD 4.14 settings panel).
 *
 * These are the DEFAULTS applied to newly created sessions. An already-running
 * session keeps the config it started with — changing a default never
 * retroactively rewrites a recording's own parameters.
 */

export const APP_SETTINGS_KEY = "app";

export const appSettingsSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    /** `settings` store keyPath. */
    key: z.literal(APP_SETTINGS_KEY),
    defaultSessionConfig: sessionConfigSchema,
    /**
     * UI/export language (crawler-12). Optional for records written by older
     * builds; readers normalize to DEFAULT_LOCALE (see SettingsRepository).
     */
    locale: localeSchema.optional(),
    updatedAt: epochMsSchema,
  })
  .strict();
export type AppSettings = z.infer<typeof appSettingsSchema>;

/** Product defaults, sourced from the single calibration module. */
export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  responseBodySoftBudgetBytes: DEFAULT_RESPONSE_BODY_SOFT_BUDGET_BYTES,
  responseBodyMaxBytes: DEFAULT_RESPONSE_BODY_MAX_BYTES,
  hoverDwellThresholdMs: HOVER_DWELL_THRESHOLD_MS,
  networkQuietWindowMs: NETWORK_QUIET_WINDOW_MS,
  stepMaxWindowMs: STEP_MAX_WINDOW_MS,
  userFilterRules: [],
  extraCookieDomains: [],
};

/** Partial update accepted from the settings UI. */
export const sessionConfigPatchSchema = sessionConfigSchema.partial().strict();
export type SessionConfigPatch = z.infer<typeof sessionConfigPatchSchema>;
