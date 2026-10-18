import type { ReactNode } from "react";
import { Icon, PageHead } from "./ui";

/** Full-page editor shared by catalogue entries, users and groups. */
export function DetailPage({
  title,
  subtitle,
  onClose,
  backLabel = "Retour au catalogue",
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  backLabel?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <>
      <button type="button" className="btn ghost detail-back" onClick={onClose}>
        <Icon name="arrow-left" />
        {backLabel}
      </button>
      <PageHead eyebrow="Administration" title={title} lead={subtitle} />
      <article className="card detail-card">
        <div className="card-body">{children}</div>
        {footer && <div className="card-foot">{footer}</div>}
      </article>
    </>
  );
}
