import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { type Access, ACCESS_LABELS, KIND_LABELS, type UserKind } from "../api";

/* ------------------------------------------------------------------ icons */
const paths: Record<string, ReactNode> = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M10.8 12.2 20 3m-3 3 3 3m-6 0 2 2" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4.5-6.2" />
    </>
  ),
  group: (
    <>
      <rect x="3" y="4" width="8" height="8" rx="2" />
      <rect x="13" y="4" width="8" height="8" rx="2" />
      <rect x="8" y="14" width="8" height="7" rx="2" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" />
    </>
  ),
  logs: (
    <>
      <path d="M4 5h16M4 12h10M4 19h7" />
    </>
  ),
  logout: (
    <>
      <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" />
      <path d="m15 8 4 4-4 4M9 12h10" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </>
  ),
  check: <path d="m5 12 4 4L19 7" />,
  "arrow-left": <path d="M19 12H5m7-7-7 7 7 7" />,
  "arrow-right": <path d="M5 12h14m-7-7 7 7-7 7" />,
  database: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
    </>
  ),
  flask: (
    <>
      <path d="M9 3h6M10 3v6l-5.5 9A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-3L14 9V3" />
    </>
  ),
  plug: (
    <>
      <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4-4" />
    </>
  ),
  shield: (
    <path d="M12 3 4.5 6v5.5c0 4.5 3.2 7.8 7.5 9.5 4.3-1.7 7.5-5 7.5-9.5V6L12 3Z" />
  ),
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />,
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <path d="M20 4v5h-5" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 4h16v10l-3 4H7l-3-4V4Z" />
      <path d="M4 14h5l1.5 2h3L15 14h5" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
}: {
  name: keyof typeof paths | string;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.grid}
    </svg>
  );
}

/* -------------------------------------------------------------- MCP icon */
const MCP_ICONS: Record<string, string> = {
  "site-public": "globe",
  sample: "flask",
};

export function McpIcon({ slug, small = false }: { slug: string; small?: boolean }) {
  return (
    <div className={`mcp-icon ${small ? "sm" : ""}`}>
      <Icon name={MCP_ICONS[slug] ?? "plug"} />
    </div>
  );
}

/* ---------------------------------------------------------------- badges */
export function AccessBadge({ access }: { access: Access | null | undefined }) {
  if (!access) return <span className="badge off">Aucun accès</span>;
  return <span className={`badge ${access}`}>{ACCESS_LABELS[access]}</span>;
}

export function KindBadge({ kind }: { kind: UserKind }) {
  return <span className="badge plain off">{KIND_LABELS[kind] ?? kind}</span>;
}

/* ----------------------------------------------------------- page header */
export function PageHead({
  eyebrow,
  title,
  lead,
  actions,
}: {
  eyebrow?: string;
  title: string;
  lead?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {lead && <p className="lead">{lead}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Empty({
  icon = "inbox",
  title,
  children,
}: {
  icon?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <Icon name={icon} size={40} />
      <strong>{title}</strong>
      {children && <span className="small">{children}</span>}
    </div>
  );
}

/* --------------------------------------------------------------- controls */
export function Switch({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`switch ${on ? "on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!on)}
    />
  );
}

export function AccessPicker({
  value,
  max = "write",
  allowNone = true,
  onChange,
  disabled,
}: {
  value: Access | null;
  /** Highest level the picker may grant. */
  max?: Access;
  /** Offer the "Aucun" option (hide it when availability is decided elsewhere). */
  allowNone?: boolean;
  onChange: (next: Access | null) => void;
  disabled?: boolean;
}) {
  const options: { key: Access | null; label: string; cls: string }[] = [
    ...(allowNone ? [{ key: null, label: "Aucun", cls: "" }] : []),
    { key: "read", label: "Lecture", cls: "read" },
    { key: "write", label: "Écriture", cls: "write" },
  ];
  return (
    <div className="segmented" role="radiogroup">
      {options.map((opt) => (
        <button
          type="button"
          key={opt.label}
          role="radio"
          aria-checked={value === opt.key}
          className={`${value === opt.key ? "on" : ""} ${opt.cls}`}
          disabled={disabled || (opt.key === "write" && max !== "write")}
          onClick={() => onChange(opt.key)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function CopyButton({
  text,
  className = "copy-btn",
}: {
  text: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(timer);
  }, [done]);
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setDone(true));
      }}
    >
      {done ? "Copié ✓" : "Copier"}
    </button>
  );
}

export function Snippet({ code }: { code: string }) {
  return (
    <pre>
      <code>{code}</code>
      <CopyButton text={code} />
    </pre>
  );
}

/* ------------------------------------------------------------- overlays */
function useEscape(onClose: () => void) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
}

export function Modal({
  title,
  onClose,
  children,
  wide = false,
  narrow = false,
  footer,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  narrow?: boolean;
  footer?: ReactNode;
}) {
  useEscape(onClose);
  // Rendered at the document root so a modal opened from a drawer sits above it.
  return createPortal(
    <div
      className="backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={`modal ${wide ? "wide" : ""} ${narrow ? "narrow" : ""}`}
        role="dialog"
        aria-modal="true"
      >
        <div className="card-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer">
            <Icon name="close" />
          </button>
        </div>
        <div className="card-body">{children}</div>
        {footer && <div className="card-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Confirmation dialog replacing `window.confirm()`, which some embedded
 * browsers block. `onConfirm` runs while the buttons are disabled; the caller
 * closes the dialog afterwards (so it can keep it open on failure if needed).
 */
export function ConfirmModal({
  title,
  children,
  confirmLabel = "Confirmer",
  danger = true,
  onConfirm,
  onClose,
}: {
  title: ReactNode;
  children: ReactNode;
  confirmLabel?: ReactNode;
  danger?: boolean;
  onConfirm: () => Promise<unknown> | unknown;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      narrow
      footer={
        <div className="row end" style={{ flex: 1 }}>
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
            Annuler
          </button>
          <button
            type="button"
            autoFocus
            className={`btn ${danger ? "danger" : "accent"}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </button>
        </div>
      }
    >
      <div className="small">{children}</div>
    </Modal>
  );
}

export function Drawer({
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEscape(onClose);
  return (
    <>
      <div className="drawer-backdrop" onMouseDown={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="card-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{title}</h2>
            {subtitle && <div className="small muted ellipsis">{subtitle}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer">
            <Icon name="close" />
          </button>
        </div>
        <div className="card-body">{children}</div>
        {footer && <div className="card-foot">{footer}</div>}
      </aside>
    </>
  );
}
