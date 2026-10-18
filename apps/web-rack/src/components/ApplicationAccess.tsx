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

export function UserApplicationsAccess({
  applications,
  user,
  onChanged,
}: {
  applications: AdminApplication[];
  user: AdminUser;
  onChanged: () => void;
}) {
  const { busy, error, update } = useAccessUpdate(onChanged);
  return (
    <div className="stack tight">
      {error && <div className="alert error">{error}</div>}
      {applications.length === 0 && (
        <p className="muted small">Aucune application enregistrée.</p>
      )}
      {applications.map((application) => {
        const override = application.users.find((u) => u.userId === user.id);
        const inherited =
          !application.accessRestricted ||
          user.groups.some((g) => application.groupIds.includes(g.id));
        const allowed =
          !application.disabled && !user.banned && (override?.allowed ?? inherited);
        return (
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
                  : user.banned
                    ? "Compte désactivé"
                    : allowed
                      ? "Accès autorisé"
                      : "Accès refusé"}
              </span>
            </div>
            <select
              aria-label={`Accès à ${application.name || application.clientId}`}
              disabled={busy}
              value={override ? (override.allowed ? "allow" : "deny") : "default"}
              onChange={(e) =>
                void update(
                  `/api/admin/users/${encodeURIComponent(user.id)}/applications/${encodeURIComponent(application.clientId)}`,
                  { access: e.target.value },
                )
              }
            >
              <option value="default">
                Hérité · {inherited ? "autorisé" : "refusé"}
              </option>
              <option value="allow">Autoriser</option>
              <option value="deny">Refuser</option>
            </select>
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
