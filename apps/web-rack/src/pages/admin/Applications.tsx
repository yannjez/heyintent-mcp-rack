import { useCallback, useEffect, useState } from "react";
import { api, type AdminGroup, type AdminUser } from "../../api";
import { Drawer, Empty, PageHead } from "../../components/ui";

interface Application {
  clientId: string;
  name: string | null;
  uri: string | null;
  disabled: boolean;
  accessRestricted: boolean;
  groupIds: string[];
  users: { userId: string; allowed: boolean }[];
  redirectUris: string[];
  scopes: string[];
}

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

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/applications/${encodeURIComponent(draft.clientId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          disabled: draft.disabled,
          accessRestricted: draft.accessRestricted,
          groupIds: draft.groupIds,
          users: draft.users,
        }),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer title={application.name || "Application"} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {error && <div className="alert error">{error}</div>}
        <code className="small" style={{ overflowWrap: "anywhere" }}>
          {draft.clientId}
        </code>
        {draft.uri && <p className="small muted">{draft.uri}</p>}
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
    </Drawer>
  );
}

export function AdminApplicationsPage() {
  const [applications, setApplications] = useState<Application[] | null>(null);
  const [groups, setGroups] = useState<AdminGroup[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selected, setSelected] = useState<Application | null>(null);
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

  return (
    <>
      <PageHead
        title="Applications"
        lead="Gérez les applications clientes et les personnes autorisées à s'y connecter."
      />
      {error && <div className="alert error">{error}</div>}
      {!applications ? (
        <p className="muted">Chargement…</p>
      ) : applications.length === 0 ? (
        <Empty icon="plug" title="Aucune application enregistrée">
          Les applications apparaissent ici après leur enregistrement OAuth auprès de
          Rack.
        </Empty>
      ) : (
        <div className="access-matrix">
          {applications.map((application) => (
            <div className="access-row" key={application.clientId}>
              <div className="names">
                <strong>{application.name || "Application sans nom"}</strong>
                <span>{application.clientId}</span>
                <span>
                  {application.disabled
                    ? "Désactivée"
                    : application.accessRestricted
                      ? `${application.groupIds.length} groupe(s) · accès restreint`
                      : "Tous les utilisateurs"}
                </span>
              </div>
              <button className="btn" onClick={() => setSelected(application)}>
                Gérer l'accès
              </button>
            </div>
          ))}
        </div>
      )}
      {selected && (
        <ApplicationEditor
          application={selected}
          groups={groups}
          users={users}
          onClose={() => setSelected(null)}
          onSaved={() => {
            void load();
          }}
        />
      )}
    </>
  );
}
