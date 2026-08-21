import type { ReactElement } from "react";

/**
 * Lightweight in-app confirmation dialog (crawler-13 follow-up).
 *
 * Replaces the native `window.confirm`, which renders as a huge browser
 * chrome dialog and crowds the popup. Localized labels are passed in by the
 * caller; the dialog itself is presentation only.
 */

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export const ConfirmDialog = ({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactElement | null => {
  if (!open) {
    return null;
  }
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="confirm-dialog"
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.45)",
      }}
    >
      <div
        onClick={(event) => {
          event.stopPropagation();
        }}
        style={{
          width: "min(280px, calc(100vw - 48px))",
          background: "var(--ach-surface, #ffffff)",
          borderRadius: 10,
          padding: 16,
          boxShadow: "0 8px 30px rgba(0, 0, 0, 0.25)",
        }}
      >
        <h4 style={{ margin: "0 0 8px", fontSize: 14 }}>{title}</h4>
        <p
          style={{
            margin: "0 0 14px",
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--ach-text-dim, #666666)",
          }}
        >
          {message}
        </p>
        <div className="ach-btn-row" style={{ justifyContent: "flex-end" }}>
          <button className="ach-btn ach-btn--sm" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className="ach-btn ach-btn--sm ach-btn--danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
