import { useCallback, useEffect, useState } from "react";
import { api, type AdminGroup } from "../../api";
import { useNavigate, useParams, Link } from "react-router";
import { DetailPage } from "../../components/DetailPage";
import { PageHead } from "../../components/ui";
import type { AdminApplication as Application } from "../../api";

/** Access policy of an OAuth client: open to everyone, group-gated, or off. */
type Policy = "all" | "groups" | "disabled";

function policyOf(application: { disabled: boolean; accessRestricted: boolean }): Policy {
  if (application.disabled) return "disabled";
  return application.accessRestricted ? "groups" : "all";
}

function ApplicationEditor({
  application,
  groups,
  onClose,
  onSaved,
}: {
  application: Application;
  groups: AdminGroup[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(application);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/applications/${encodeURIComponent(draft.clientId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...(draft.name?.trim() ? { name: draft.name.trim() } : {}),
          uri: draft.uri?.trim() || null,
          disabled: draft.disabled,
          accessRestricted: draft.accessRestricted,
          groupIds: draft.groupIds,
        }),
      });
      onSaved();
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DetailPage
      title={application.name || "Application"}
      subtitle="Connexion et droits d’accès"
      onClose={onClose}
    >
      <form
        className="stack"
        onChange={() => setSaved(false)}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {error && <div className="alert error">{error}</div>}
        {saved && (
          <div className="alert" role="status">
            Modifications enregistrées.
          </div>
        )}
        <code className="small" style={{ overflowWrap: "anywhere" }}>
          {draft.clientId}
        </code>
        <label className="field">
          Nom de l’application
          <input
            value={draft.name ?? ""}
            maxLength={200}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label className="field">
          Adresse de l’application
          <input
            type="url"
            value={draft.uri ?? ""}
            maxLength={2000}
            disabled={busy}
            placeholder="https://application.exemple.com"
            onChange={(e) => setDraft({ ...draft, uri: e.target.value })}
          />
          <span className="hint">
            Cette adresse permet d’ouvrir l’application depuis « Mes applications ».
          </span>
        </label>
        <label className="field">
          Qui peut se connecter via cette application
          <select
            value={policyOf(draft)}
            disabled={busy}
            onChange={(e) => {
              const policy = e.target.value as Policy;
              setDraft({
                ...draft,
                disabled: policy === "disabled",
                accessRestricted:
                  policy === "disabled" ? draft.accessRestricted : policy === "groups",
              });
            }}
          >
            <option value="all">Ouverte à tous les utilisateurs</option>
            <option value="groups">Réservée aux groupes sélectionnés</option>
            <option value="disabled">Désactivée pour tout le monde</option>
          </select>
        </label>
        <p className="small muted">
          Une application désactivée est bloquée pour tous, y compris les administrateurs.
          Ce réglage dit seulement qui peut se connecter par ce canal : les droits sur les
          ressources (lecture, écriture) restent définis sur les utilisateurs et les
          groupes.
        </p>
        <h3>Groupes autorisés</h3>
        {groups.length === 0 && <p className="small muted">Aucun groupe créé.</p>}
        {groups.map((group) => (
          <label key={group.id} className="access-row">
            <input
              type="checkbox"
              disabled={busy || policyOf(draft) !== "groups"}
              checked={draft.groupIds.includes(group.id)}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  groupIds: e.target.checked
                    ? [...draft.groupIds, group.id]
                    : draft.groupIds.filter((id) => id !== group.id),
                })
              }
            />
            <span>{group.name}</span>
          </label>
        ))}
        <h3>Adresses de retour</h3>
        {draft.redirectUris.map((uri) => (
          <code key={uri} className="small" style={{ overflowWrap: "anywhere" }}>
            {uri}
          </code>
        ))}
        <p className="small muted">
          Enregistrer supprime les consentements et les jetons de renouvellement. Les
          accès retirés sont bloqués par Rack.
        </p>
        <button type="submit" className="btn accent" disabled={busy}>
          {busy ? "Enregistrement…" : "Enregistrer"}
        </button>
      </form>
    </DetailPage>
  );
}

export function AdminApplicationsPage() {
  const [applications, setApplications] = useState<Application[] | null>(null);
  const [groups, setGroups] = useState<AdminGroup[]>([]);
  const navigate = useNavigate();
  const { clientId } = useParams();
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [apps, groupRows] = await Promise.all([
        api<Application[]>("/api/admin/applications"),
        api<AdminGroup[]>("/api/admin/groups"),
      ]);
      setApplications(apps);
      setGroups(groupRows);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const selected = applications?.find((app) => app.clientId === clientId);
  if (selected)
    return (
      <ApplicationEditor
        key={selected.clientId}
        application={selected}
        groups={groups}
        onClose={() => navigate("/admin/catalogue")}
        onSaved={() => {
          void load();
        }}
      />
    );
  return (
    <>
      <Link className="btn ghost" to="/admin/catalogue">
        Retour au catalogue
      </Link>
      <PageHead title="Application" />
      {error ? (
        <div className="alert error">{error}</div>
      ) : applications ? (
        <p className="muted">Application introuvable.</p>
      ) : (
        <p className="muted">Chargement…</p>
      )}
    </>
  );
}
