import { useState } from "react";
import { Link } from "react-router";
import { api, type AdminApplication, type AdminUser } from "../api";
import { Switch } from "./ui";

function useAccessUpdate(onChanged: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function update(path: string, body: object) {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: "PUT", body: JSON.stringify(body) });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, update };
}

/**
 * Effective connection rights of one account, per application. Read-only: the
 * policy lives on the application (open, group-gated or disabled) — individual
 * exceptions no longer exist.
 */
export function UserApplicationsAccess({
  applications,
  user,
}: {
  applications: AdminApplication[];
  user: AdminUser;
}) {
  return (
    <div className="stack tight">
      {applications.length === 0 && (
        <p className="muted small">Aucune application enregistrée.</p>
      )}
      {applications.map((application) => {
        const viaGroups = user.groups.filter((group) =>
          application.groupIds.includes(group.id),
        );
        const allowed =
          !application.disabled &&
          !user.banned &&
          (!application.accessRestricted || viaGroups.length > 0);
        const reason = application.disabled
          ? "Application désactivée pour tout le monde"
          : user.banned
            ? "Compte désactivé"
            : !application.accessRestricted
              ? "Ouverte à tous les utilisateurs"
              : viaGroups.length > 0
                ? `Via ${viaGroups.map((group) => group.name).join(", ")}`
                : "Réservée à des groupes — aucun groupe de ce compte n'est autorisé";
        return (
          <div className="access-row" key={application.clientId}>
            <div className="names">
              <Link
                to={`/admin/catalogue/applications/${encodeURIComponent(application.clientId)}`}
              >
                <strong>{application.name || application.clientId}</strong>
              </Link>
              <span>{reason}</span>
            </div>
            <span className={`badge ${allowed ? "ok" : "bad"}`}>
              {allowed ? "connexion autorisée" : "connexion refusée"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function GroupApplicationsAccess({
  applications,
  groupId,
  onChanged,
}: {
  applications: AdminApplication[];
  groupId: string;
  onChanged: () => void;
}) {
  const { busy, error, update } = useAccessUpdate(onChanged);
  return (
    <div className="stack tight">
      {error && <div className="alert error">{error}</div>}
      {applications.length === 0 && (
        <p className="muted small">Aucune application enregistrée.</p>
      )}
      {applications.map((application) => (
        <div className="access-row" key={application.clientId}>
          <div className="names">
            <Link
              to={`/admin/catalogue/applications/${encodeURIComponent(application.clientId)}`}
            >
              <strong>{application.name || application.clientId}</strong>
            </Link>
            <span>
              {application.disabled
                ? "Application désactivée"
                : application.accessRestricted
                  ? "Accès réservé aux groupes sélectionnés"
                  : "Disponible pour tous les utilisateurs"}
            </span>
          </div>
          <Switch
            on={application.groupIds.includes(groupId)}
            disabled={busy || !application.accessRestricted}
            label={`Autoriser ${application.name || application.clientId} pour ce groupe`}
            onChange={(enabled) =>
              void update(
                `/api/admin/applications/${encodeURIComponent(application.clientId)}/groups/${encodeURIComponent(groupId)}`,
                { enabled },
              )
            }
          />
        </div>
      ))}
    </div>
  );
}
