import { useCallback, useEffect, useState } from "react";
import { api, type AdminGroup, type AdminUser } from "../../api";
import { useNavigate, useParams, Link } from "react-router";
import { DetailPage } from "../../components/DetailPage";
import { PageHead } from "../../components/ui";
import type { AdminApplication as Application } from "../../api";

function ApplicationEditor({
  application,
  groups,
  users,
  onClose,
  onSaved,
}: {
  application: Application;
  groups: AdminGroup[];
  users: AdminUser[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(application);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
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
          users: draft.users,
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
          État
          <select
            value={draft.disabled ? "disabled" : "enabled"}
            disabled={busy}
            onChange={(e) =>
              setDraft({ ...draft, disabled: e.target.value === "disabled" })
            }
          >
            <option value="enabled">Activée</option>
            <option value="disabled">Désactivée</option>
          </select>
        </label>
        <label className="field">
          Accès à l'application
          <select
            value={draft.accessRestricted ? "restricted" : "all"}
            disabled={busy}
            onChange={(e) =>
              setDraft({ ...draft, accessRestricted: e.target.value === "restricted" })
            }
          >
            <option value="all">Tous les utilisateurs</option>
            <option value="restricted">Groupes et utilisateurs sélectionnés</option>
          </select>
        </label>
        <p className="small muted">
          Un refus individuel est prioritaire sur les groupes. Une application désactivée
          est bloquée pour tous, y compris les administrateurs. Les droits sur les
          ressources restent définis séparément.
        </p>
        <h3>Groupes autorisés</h3>
        {groups.length === 0 && <p className="small muted">Aucun groupe créé.</p>}
        {groups.map((group) => (
          <label key={group.id} className="access-row">
            <input
              type="checkbox"
              disabled={busy || !draft.accessRestricted}
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
        <h3>Exceptions par utilisateur</h3>
        <input
          aria-label="Rechercher un utilisateur"
          placeholder="Rechercher par nom ou email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="access-matrix">
          {users
            .filter((user) =>
              `${user.name} ${user.email}`.toLowerCase().includes(search.toLowerCase()),
            )
            .map((user) => {
              const override = draft.users.find((u) => u.userId === user.id);
              const inherited =
                !draft.accessRestricted ||
                user.groups.some((g) => draft.groupIds.includes(g.id));
              return (
                <label key={user.id} className="access-row">
                  <span className="names">
                    <strong>{user.name || user.email}</strong>
                    <span>{user.email}</span>
                  </span>
                  <select
                    aria-label={`Accès de ${user.email}`}
                    disabled={busy}
                    value={override ? (override.allowed ? "allow" : "deny") : "default"}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        users: [
                          ...draft.users.filter((u) => u.userId !== user.id),
                          ...(e.target.value === "default"
                            ? []
                            : [{ userId: user.id, allowed: e.target.value === "allow" }]),
                        ],
                      })
                    }
                  >
                    <option value="default">
                      Hérité · {inherited ? "autorisé" : "refusé"}
                    </option>
                    <option value="allow">Autoriser</option>
                    <option value="deny">Refuser</option>
                  </select>
                </label>
              );
            })}
        </div>
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
  const [users, setUsers] = useState<AdminUser[]>([]);
  const navigate = useNavigate();
  const { clientId } = useParams();
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [apps, groupRows, userRows] = await Promise.all([
        api<Application[]>("/api/admin/applications"),
        api<AdminGroup[]>("/api/admin/groups"),
        api<AdminUser[]>("/api/admin/users"),
      ]);
      setApplications(apps);
      setGroups(groupRows);
      setUsers(userRows);
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
        users={users}
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
