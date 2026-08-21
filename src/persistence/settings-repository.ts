import { STORES, getRecord, runAtomicWrite } from "./database";
import { SCHEMA_VERSION } from "../schemas/common";
import { DEFAULT_LOCALE, type Locale } from "../shared/i18n";
import {
  APP_SETTINGS_KEY,
  DEFAULT_SESSION_CONFIG,
  appSettingsSchema,
  type AppSettings,
  type SessionConfigPatch,
} from "../schemas/settings";

/**
 * Application settings (PRD 4.14). Holds the defaults applied to NEW sessions.
 *
 * Deliberately separate from `SessionRecord.config`: a running session keeps
 * the parameters it started with, so changing a default here can never
 * retroactively alter how an existing recording was captured.
 */
export class SettingsRepository {
  constructor(private readonly db: IDBDatabase) {}

  /** Never throws on a missing record — product defaults are the fallback. */
  async getAppSettings(): Promise<AppSettings> {
    const txn = this.db.transaction([STORES.settings], "readonly");
    const raw = await getRecord(txn.objectStore(STORES.settings), APP_SETTINGS_KEY);
    if (raw === undefined) {
      return defaultAppSettings();
    }
    const parsed = appSettingsSchema.parse(raw);
    // Older builds wrote no locale; normalize so callers never handle undefined.
    return { ...parsed, locale: parsed.locale ?? DEFAULT_LOCALE };
  }

  /** Persist the UI/export language (crawler-12). */
  async updateLocale(locale: Locale, now: number): Promise<AppSettings> {
    return runAtomicWrite(this.db, [STORES.settings], async (txn) => {
      const store = txn.objectStore(STORES.settings);
      const raw = await getRecord(store, APP_SETTINGS_KEY);
      const current =
        raw === undefined
          ? defaultAppSettings()
          : appSettingsSchema.parse(raw);
      const next = appSettingsSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        key: APP_SETTINGS_KEY,
        defaultSessionConfig: current.defaultSessionConfig,
        locale,
        updatedAt: now,
      });
      store.put(next);
      return next;
    });
  }

  /** Merge a partial patch over the stored defaults. Validated before write. */
  async updateDefaultSessionConfig(
    patch: SessionConfigPatch,
    now: number,
  ): Promise<AppSettings> {
    return runAtomicWrite(this.db, [STORES.settings], async (txn) => {
      const store = txn.objectStore(STORES.settings);
      const raw = await getRecord(store, APP_SETTINGS_KEY);
      const current =
        raw === undefined
          ? DEFAULT_SESSION_CONFIG
          : appSettingsSchema.parse(raw).defaultSessionConfig;
      const next = appSettingsSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        key: APP_SETTINGS_KEY,
        defaultSessionConfig: { ...current, ...patch },
        updatedAt: now,
      });
      store.put(next);
      return next;
    });
  }
}

export const defaultAppSettings = (): AppSettings =>
  appSettingsSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    key: APP_SETTINGS_KEY,
    defaultSessionConfig: DEFAULT_SESSION_CONFIG,
    locale: DEFAULT_LOCALE,
    updatedAt: 0,
  });
