/**
 * Permission usage map (implement checklist 1: "为每项权限提供实际使用路径").
 *
 * Every manifest permission is declared here with its concrete usage path in
 * this codebase (current or contracted subtask). The Side Panel settings view
 * consumes this map to explain permissions to the user.
 */
export interface PermissionUsage {
  readonly permission: string;
  /** Why the permission exists — concrete API usage path. */
  readonly usagePath: string;
  /** Which module/subtask exercises it. */
  readonly consumer: string;
}

export const MANIFEST_PERMISSION_USAGE: readonly PermissionUsage[] = [
  {
    permission: "activeTab",
    usagePath:
      "User-gesture start flow: read current tab URL/origin before requesting the per-origin host grant. Never a substitute for persistent host permissions.",
    consumer: "background/session-service (start recording preflight)",
  },
  {
    permission: "cookies",
    usagePath:
      "chrome.cookies.getAll on granted origins for initial/final snapshots and per-step diffs.",
    consumer: "subtask 05 storage collector (schema contract: schemas/storage.ts)",
  },
  {
    permission: "debugger",
    usagePath:
      "chrome.debugger.attach + CDP Network domain per recorded tab; root/child flat sessions (Chrome 125+). Required install-time permission, cannot be optional.",
    consumer: "subtask 04 network recorder (schema contract: schemas/network.ts)",
  },
  {
    permission: "scripting",
    usagePath:
      "chrome.scripting.registerContentScripts / executeScript to inject the content script into granted origins and frames.",
    consumer: "subtask 02 content-script bootstrap",
  },
  {
    permission: "sidePanel",
    usagePath: "chrome.sidePanel.open from user gesture; side_panel.default_path in manifest.",
    consumer: "ui/sidepanel",
  },
  {
    permission: "storage",
    usagePath:
      "chrome.storage.local best-effort control-plane mirror of the minimal storage-pressure stop record (NOT the source of truth; IndexedDB is).",
    consumer: "persistence/control-mirror",
  },
  {
    permission: "tabs",
    usagePath:
      "Read tab URL/title/openerTabId for session tab registry and derived-tab evidence (webNavigation.onCreatedNavigationTarget corroboration).",
    consumer: "background/session-service + subtask 03 navigation recorder",
  },
  {
    permission: "unlimitedStorage",
    usagePath:
      "Removes normal quota/eviction for the extension-origin IndexedDB holding recorded facts. CapacityGuard still enforces its own admission rule.",
    consumer: "persistence/database + core/capacity-guard",
  },
  {
    permission: "webNavigation",
    usagePath:
      "onCommitted/onCreatedNavigationTarget/documentId for navigation facts and derived-tab evidence.",
    consumer: "subtask 03 navigation recorder (schema contract: schemas/navigation.ts)",
  },
  {
    permission: "offscreen",
    usagePath:
      "chrome.offscreen.createDocument for streaming ZIP export (Blob/OPFS/Web Streams unavailable in the service worker).",
    consumer: "subtask 07 export runner (entry: offscreen/index.html)",
  },
  {
    permission: "downloads",
    usagePath:
      "Fallback export path only: chrome.downloads.download(objectUrl) when direct FileSystemWritableFileStream is unavailable.",
    consumer: "subtask 07 export runner",
  },
] as const;

export const OPTIONAL_HOST_PERMISSION_USAGE: readonly PermissionUsage[] = [
  {
    permission: "http://*/* , https://*/*",
    usagePath:
      "Per-origin runtime grants (chrome.permissions.request within user gesture) gating content script injection, DOM capture, cookie reads and page storage reads.",
    consumer: "background/session-service permission flow",
  },
  {
    permission: "file:///*",
    usagePath:
      "Only when the user manually enables file-URL access; preflight via chrome.extension.isAllowedFileSchemeAccess().",
    consumer: "background/session-service eligibility preflight",
  },
] as const;
