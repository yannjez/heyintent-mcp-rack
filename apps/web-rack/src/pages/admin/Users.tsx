import { useNavigate, useParams, Link } from "react-router";
import { DetailPage } from "../../components/DetailPage";
import { UserApplicationsAccess } from "../../components/ApplicationAccess";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  type Access,
  type AdminGroup,
  type AdminApplication,
  type AdminMcp,
  type AdminUser,
  api,
  type ApiKeyRow,
  effectiveMcps,
  formatDate,
  formatRelative,
  KIND_LABELS,
  USER_KINDS,
  type UserKind,
} from "../../api";
import { GrantChips } from "../../components/GrantChips";
import {
  AccessPicker,
  ConfirmModal,
  Empty,
  Icon,
  KindBadge,
  McpIcon,
  PageHead,
  Switch,
} from "../../components/ui";

function NewUserForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<UserKind>("external");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ id: string }>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ email, name, kind }),
      });
      onCreated(created.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DetailPage
      title="Nouvel utilisateur"
      onClose={onClose}
      backLabel="Retour aux utilisateurs"
    >
      <form className="stack" onSubmit={submit} id="new-user">
        {error && <div className="alert error">{error}</div>}
        <p className="small muted">
          Les comptes Intent se créent seuls à la première connexion. Créez ici les
          comptes externes et clients : ils pourront ensuite se connecter par code OTP
          avec leur propre adresse.
        </p>
        <label className="field">
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            placeholder="prenom@partenaire.com"
          />
        </label>
        <label className="field">
          Nom
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label className="field">
          Typologie
          <select value={kind} onChange={(e) => setKind(e.target.value as UserKind)}>
            {USER_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>
            Annuler
          </button>
          <button className="btn accent" disabled={busy || !email || !name}>
            Créer le compte
          </button>
        </div>
      </form>
    </DetailPage>
  );
}

function UserDetails({
  user,
  mcps,
  groups,
  applications,
  meId,
  onClose,
  onChanged,
}: {
  user: AdminUser;
  mcps: AdminMcp[];
  groups: AdminGroup[];
  applications: AdminApplication[];
  meId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isSelf = user.id === meId;

  const loadKeys = useCallback(() => {
    api<ApiKeyRow[]>("/api/admin/keys")
      .then((all) => setKeys(all.filter((k) => k.owner?.id === user.id)))
      .catch(() => setKeys([]));
  }, [user.id]);
  useEffect(loadKeys, [loadKeys]);

  /** Pending confirmation: deleting the account, or revoking one of its keys. */
  const [confirming, setConfirming] = useState<
    { kind: "user" } | { kind: "key"; key: ApiKeyRow } | null
  >(null);

  /** Runs an admin call, surfaces its error on the page, and reports success. */
  async function run(fn: () => Promise<unknown>): Promise<boolean> {
    setError(null);
    try {
      await fn();
      onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  const patch = (body: Record<string, unknown>) =>
    run(() =>
      api(`/api/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    );

  const setAccess = (slug: string, access: Access | null) =>
    run(() =>
      api(`/api/admin/users/${user.id}/mcps/${slug}`, {
        method: "PUT",
        body: JSON.stringify({ access: access ?? "none" }),
      }),
    );

  const names = Object.fromEntries(mcps.map((m) => [m.slug, m.name]));
  // MCPs the user's groups make available, including those blocked individually
  // (so the block can be lifted from here).
  const viaGroups = new Set(user.groups.flatMap((group) => group.mcps));
  const available = mcps.filter((mcp) => viaGroups.has(mcp.slug));

  return (
    <DetailPage
      backLabel="Retour aux utilisateurs"
      title={user.name || user.email}
      subtitle={user.email}
      onClose={onClose}
      footer={
        <>
          <span className="tiny muted" style={{ flex: 1 }}>
            Créé le {formatDate(user.createdAt)}
          </span>
          <button
            className="btn danger small"
            disabled={isSelf}
            onClick={() => setConfirming({ kind: "user" })}
          >
            <Icon name="trash" /> Supprimer
          </button>
        </>
      }
    >
      {confirming?.kind === "user" && (
        <ConfirmModal
          title="Supprimer le compte"
          confirmLabel="Supprimer"
          onClose={() => setConfirming(null)}
          onConfirm={async () => {
            const ok = await run(() =>
              api(`/api/admin/users/${user.id}`, { method: "DELETE" }),
            );
            setConfirming(null);
            if (ok) onClose();
          }}
        >
          Supprimer <strong>{user.email}</strong> ? Ses clés API, ses jetons OAuth et ses
          droits seront révoqués immédiatement. Cette action est définitive.
        </ConfirmModal>
      )}
      {confirming?.kind === "key" && (
        <ConfirmModal
          title="Révoquer la clé"
          confirmLabel="Révoquer"
          onClose={() => setConfirming(null)}
          onConfirm={async () => {
            const ok = await run(() =>
              api(`/api/admin/keys/${confirming.key.id}`, { method: "DELETE" }),
            );
            setConfirming(null);
            if (ok) loadKeys();
          }}
        >
          Révoquer la clé <strong>{confirming.key.name}</strong> ({confirming.key.start}…)
          ? Les clients qui l'utilisent perdront l'accès.
        </ConfirmModal>
      )}
      <div className="stack" style={{ gap: 26 }}>
        {error && <div className="alert error">{error}</div>}

        <section className="stack tight">
          <h3>Profil</h3>
          <div className="row" style={{ gap: 18 }}>
            <label className="field" style={{ flex: 1 }}>
              Typologie
              <select value={user.kind} onChange={(e) => patch({ kind: e.target.value })}>
                {USER_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              Administrateur
              <div className="row" style={{ height: 42 }}>
                <Switch
                  on={user.isAdmin}
                  disabled={isSelf}
                  onChange={(on) => patch({ role: on ? "admin" : "user" })}
                  label="Administrateur"
                />
                <span className="small muted">{user.isAdmin ? "oui" : "non"}</span>
              </div>
            </div>
            <div className="field">
              Compte actif
              <div className="row" style={{ height: 42 }}>
                <Switch
                  on={!user.banned}
                  disabled={isSelf}
                  onChange={(on) => patch({ banned: !on })}
                  label="Compte actif"
                />
                <span className="small muted">{user.banned ? "désactivé" : "actif"}</span>
              </div>
            </div>
          </div>
          <div className="field">
            Groupes
            {groups.length === 0 ? (
              <span className="hint">
                Créez d'abord un groupe depuis la page Groupes.
              </span>
            ) : (
              <div className="checks">
                {groups.map((group) => (
                  <label className="check" key={group.id}>
                    <input
                      type="checkbox"
                      checked={user.groups.some((g) => g.id === group.id)}
                      onChange={(e) =>
                        patch({
                          groupIds: e.target.checked
                            ? [...user.groups.map((g) => g.id), group.id]
                            : user.groups
                                .filter((g) => g.id !== group.id)
                                .map((g) => g.id),
                        })
                      }
                    />
                    {group.name}
                  </label>
                ))}
              </div>
            )}
            <span className="hint">
              Un compte peut appartenir à plusieurs groupes ; il n'accède qu'aux
              ressources associées à au moins un de ses groupes, administrateurs compris.
            </span>
          </div>
        </section>

        <section className="stack tight">
          <div className="row spread">
            <h3>Ressources accessibles</h3>
            <span className="tiny muted">
              Lecture par défaut · « Aucun » retire l'accès malgré le groupe
            </span>
          </div>
          {available.length === 0 ? (
            <div className="small muted">
              Aucune ressource : ce compte n'appartient à aucun groupe associé à une
              ressource.
            </div>
          ) : (
            <div className="access-matrix">
              {available.map((mcp) => {
                const via = user.groups
                  .filter((group) => group.mcps.includes(mcp.slug))
                  .map((group) => group.name)
                  .join(", ");
                const override = user.mcps[mcp.slug];
                const blocked = override === "none";
                return (
                  <div
                    className={`access-row ${blocked ? "blocked" : ""}`}
                    key={mcp.slug}
                  >
                    <McpIcon slug={mcp.slug} kind={mcp.kind} small />
                    <div className="names">
                      <strong>{mcp.name}</strong>
                      <span>
                        {mcp.category ?? "MCP"}
                        {!mcp.enabled && " · désactivé"}
                        {` · via ${via}`}
                        {blocked && " · accès retiré pour ce compte"}
                      </span>
                    </div>
                    <AccessPicker
                      value={blocked ? null : (override ?? "read")}
                      onChange={(access) => setAccess(mcp.slug, access)}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="stack tight">
          <h3>Applications accessibles</h3>
          <UserApplicationsAccess
            applications={applications}
            user={user}
            onChanged={onChanged}
          />
        </section>

        <section className="stack tight">
          <h3>Clés API ({keys?.length ?? "…"})</h3>
          {keys && keys.length === 0 && <div className="small muted">Aucune clé.</div>}
          {keys?.map((key) => (
            <div className="access-row" key={key.id}>
              <div className="names">
                <strong>{key.name}</strong>
                <span className="mono">
                  {key.start}… · {key.requestCount} appels ·{" "}
                  {formatRelative(key.lastRequest)}
                </span>
                <div style={{ marginTop: 6 }}>
                  <GrantChips grants={key.grants} names={names} />
                </div>
              </div>
              <button
                className="btn danger small"
                onClick={() => setConfirming({ kind: "key", key })}
              >
                Révoquer
              </button>
            </div>
          ))}
        </section>
      </div>
    </DetailPage>
  );
}

export function AdminUsersPage({ meId }: { meId: string }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [mcps, setMcps] = useState<AdminMcp[]>([]);
  const [groups, setGroups] = useState<AdminGroup[]>([]);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<UserKind | "all">("all");
  const navigate = useNavigate();
  const { userId: selected } = useParams();
  const creating = selected === "new";
  const [applications, setApplications] = useState<AdminApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    const usersRequest =
      selected && !creating
        ? api<AdminUser>(`/api/admin/users/${encodeURIComponent(selected)}`).then(
            (user) => [user],
          )
        : api<AdminUser[]>("/api/admin/users");
    Promise.all([
      usersRequest,
      api<AdminApplication[]>("/api/admin/applications"),
      api<AdminMcp[]>("/api/admin/mcps"),
      api<AdminGroup[]>("/api/admin/groups"),
    ])
      .then(([rows, apps, resources, groupRows]) => {
        setUsers(rows);
        setApplications(apps);
        setMcps(resources.filter((mcp) => mcp.loaded));
        setGroups(groupRows);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [selected, creating]);
  useEffect(reload, [reload]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return users.filter(
      (u) =>
        (kind === "all" || u.kind === kind) &&
        (!needle ||
          u.email.toLowerCase().includes(needle) ||
          u.name.toLowerCase().includes(needle)),
    );
  }, [users, search, kind]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: users.length };
    for (const u of users) c[u.kind] = (c[u.kind] ?? 0) + 1;
    return c;
  }, [users]);

  const current = users.find((u) => u.id === selected) ?? null;
  const names = Object.fromEntries(mcps.map((m) => [m.slug, m.name]));

  if (creating)
    return (
      <NewUserForm
        onClose={() => navigate("/admin/users")}
        onCreated={(id) => navigate(`/admin/users/${encodeURIComponent(id)}`)}
      />
    );
  if (selected)
    return current ? (
      <>
        {error && <div className="alert error">{error}</div>}
        <UserDetails
          key={current.id}
          user={current}
          mcps={mcps}
          groups={groups}
          applications={applications}
          meId={meId}
          onClose={() => navigate("/admin/users")}
          onChanged={reload}
        />
      </>
    ) : (
      <>
        <Link className="btn ghost" to="/admin/users">
          Retour aux utilisateurs
        </Link>
        <PageHead title="Utilisateur" />
        {error ? (
          <div className="alert error">{error}</div>
        ) : (
          <p className="muted">Chargement…</p>
        )}
      </>
    );

  return (
    <>
      <PageHead
        eyebrow="Administration"
        title="Utilisateurs"
        lead="Gérez les profils, les groupes et les accès aux applications et aux ressources."
        actions={
          <button className="btn accent" onClick={() => navigate("/admin/users/new")}>
            <Icon name="plus" /> Nouvel utilisateur
          </button>
        }
      />
      {error && <div className="alert error">{error}</div>}
      {loading && <p className="muted">Chargement…</p>}
      <div className="card">
        <div className="card-head" style={{ gap: 10, flexWrap: "wrap" }}>
          <div className="segmented">
            {(["all", ...USER_KINDS] as const).map((k) => (
              <button
                key={k}
                className={kind === k ? "on" : ""}
                onClick={() => setKind(k)}
              >
                {k === "all" ? "Tous" : KIND_LABELS[k]}{" "}
                {counts[k] ? `· ${counts[k]}` : ""}
              </button>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher un nom ou un email"
            style={{ maxWidth: 300 }}
          />
        </div>
        {filtered.length === 0 ? (
          <Empty icon="users" title="Aucun utilisateur" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Utilisateur</th>
                  <th>Typologie</th>
                  <th>Rôle</th>
                  <th>Groupes</th>
                  <th>Ressources disponibles</th>
                  <th>Clés</th>
                  <th>Statut</th>
                  <th>Créé</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((user) => (
                  <tr
                    key={user.id}
                    className="clickable"
                    onClick={() =>
                      navigate(`/admin/users/${encodeURIComponent(user.id)}`)
                    }
                  >
                    <td>
                      <Link
                        className="primary"
                        to={`/admin/users/${encodeURIComponent(user.id)}`}
                        onClick={(event) => event.stopPropagation()}
                      >
                        {user.name || user.email}
                      </Link>
                      <div className="secondary">{user.email}</div>
                    </td>
                    <td>
                      <KindBadge kind={user.kind} />
                    </td>
                    <td>
                      {user.isAdmin ? (
                        <span className="badge cyan plain">admin</span>
                      ) : (
                        <span className="badge off plain">utilisateur</span>
                      )}
                    </td>
                    <td>
                      {user.groups.length ? (
                        <div className="chips">
                          {user.groups.map((group) => (
                            <Link
                              key={group.id}
                              className="badge off plain"
                              to={`/admin/groups/${encodeURIComponent(group.id)}`}
                              onClick={(event) => event.stopPropagation()}
                            >
                              {group.name}
                            </Link>
                          ))}
                        </div>
                      ) : (
                        <span className="small muted">—</span>
                      )}
                    </td>
                    <td>
                      {Object.keys(effectiveMcps(user)).length === 0 ? (
                        <span className="small muted">aucun</span>
                      ) : (
                        <div className="chips">
                          {Object.entries(effectiveMcps(user)).map(([slug, access]) => (
                            <span
                              className={`badge ${access}`}
                              key={slug}
                              title={
                                user.mcps[slug]
                                  ? "Droits individuels"
                                  : "Via les groupes autorisés"
                              }
                            >
                              {names[slug] ?? slug}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="num">{user.keyCount}</td>
                    <td>
                      {user.banned ? (
                        <span className="badge bad">désactivé</span>
                      ) : (
                        <span className="badge ok">actif</span>
                      )}
                    </td>
                    <td className="small muted">{formatDate(user.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
