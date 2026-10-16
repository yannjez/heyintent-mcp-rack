import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  type AdminGroup,
  type AdminMcp,
  type AdminUser,
  api,
  formatDate,
} from "../../api";
import {
  ConfirmModal,
  Switch,
  Drawer,
  Empty,
  Icon,
  KindBadge,
  McpIcon,
  Modal,
  PageHead,
} from "../../components/ui";

function McpAccessMatrix({
  mcps,
  value,
  onChange,
}: {
  mcps: AdminMcp[];
  value: string[];
  onChange: (slug: string, enabled: boolean) => void;
}) {
  return (
    <div className="access-matrix">
      {mcps.map((mcp) => (
        <div className="access-row" key={mcp.slug}>
          <McpIcon slug={mcp.slug} small />
          <div className="names">
            <strong>{mcp.name}</strong>
            <span>
              {mcp.category ?? "MCP"}
              {!mcp.enabled && " · désactivé"}
            </span>
          </div>
          <Switch
            on={value.includes(mcp.slug)}
            label={`Rendre ${mcp.name} disponible`}
            onChange={(enabled) => onChange(mcp.slug, enabled)}
          />
        </div>
      ))}
    </div>
  );
}

function NewGroupModal({
  mcps,
  onClose,
  onCreated,
}: {
  mcps: AdminMcp[];
  onClose: () => void;
  onCreated: (group: AdminGroup) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [accesses, setAccesses] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api<AdminGroup>("/api/admin/groups", {
        method: "POST",
        body: JSON.stringify({ name, description, mcps: accesses }),
      });
      onCreated(created);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Nouveau groupe" onClose={onClose}>
      <form className="stack" onSubmit={submit} id="new-group">
        {error && <div className="alert error">{error}</div>}
        <p className="small muted">
          Les groupes définissent la disponibilité des ressources. Affectez les groupes aux ressources,
          puis aux utilisateurs qui doivent pouvoir y accéder.
        </p>
        <label className="field">
          Nom
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            placeholder="Équipe Build"
          />
        </label>
        <label className="field">
          Description
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Facultatif"
          />
        </label>
        <div className="field">
          Ressources du groupe
          <McpAccessMatrix
            mcps={mcps}
            value={accesses}
            onChange={(slug, enabled) =>
              setAccesses((prev) =>
                enabled ? [...prev, slug] : prev.filter((item) => item !== slug),
              )
            }
          />
        </div>
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>
            Annuler
          </button>
          <button className="btn accent" disabled={busy || !name.trim()}>
            Créer le groupe
          </button>
        </div>
      </form>
    </Modal>
  );
}

function GroupDrawer({
  group,
  mcps,
  users,
  onClose,
  onChanged,
}: {
  group: AdminGroup;
  mcps: AdminMcp[];
  users: AdminUser[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description);
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(group.name);
    setDescription(group.description);
  }, [group.id, group.name, group.description]);

  const [deleting, setDeleting] = useState(false);

  /** Runs an admin call, surfaces its error in the drawer, and reports success. */
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

  const dirty = name.trim() !== group.name || description.trim() !== group.description;
  const save = () =>
    run(() =>
      api(`/api/admin/groups/${group.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim(), description: description.trim() }),
      }),
    );

  const setAccess = (slug: string, enabled: boolean) =>
    run(() =>
      api(`/api/admin/mcps/${slug}/groups/${group.id}`, {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      }),
    );

  const setMember = (userId: string, groupId: string | null) => {
    const memberships = users.find((user) => user.id === userId)?.groups ?? [];
    const groupIds = memberships.filter((g) => g.id !== group.id).map((g) => g.id);
    if (groupId) groupIds.push(groupId);
    return run(() =>
      api(`/api/admin/users/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ groupIds }),
      }),
    );
  };

  const memberIds = new Set(group.members.map((m) => m.id));
  const candidates = users.filter((u) => !memberIds.has(u.id));

  return (
    <Drawer
      title={group.name}
      subtitle={group.description || "Groupe de ressources"}
      onClose={onClose}
      footer={
        <>
          <span className="tiny muted" style={{ flex: 1 }}>
            Créé le {formatDate(group.createdAt)}
          </span>
          <button className="btn danger small" onClick={() => setDeleting(true)}>
            <Icon name="trash" /> Supprimer
          </button>
        </>
      }
    >
      {deleting && (
        <ConfirmModal
          title="Supprimer le groupe"
          confirmLabel="Supprimer"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            const ok = await run(() =>
              api(`/api/admin/groups/${group.id}`, { method: "DELETE" }),
            );
            setDeleting(false);
            if (ok) onClose();
          }}
        >
          Supprimer le groupe <strong>{group.name}</strong> ?{" "}
          {group.userCount === 0
            ? "Il n'a aucun membre."
            : `Ses ${group.userCount} membre${group.userCount > 1 ? "s" : ""} perd${
                group.userCount > 1 ? "ront" : "ra"
              } l'accès aux ressources accordées par ce groupe, clés API et jetons OAuth compris.`}
        </ConfirmModal>
      )}
      <div className="stack" style={{ gap: 26 }}>
        {error && <div className="alert error">{error}</div>}

        <section className="stack tight">
          <h3>Groupe</h3>
          <div className="row" style={{ gap: 18, alignItems: "flex-end" }}>
            <label className="field" style={{ flex: 1 }}>
              Nom
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field" style={{ flex: 2 }}>
              Description
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <button
              className="btn small"
              disabled={!dirty || !name.trim()}
              onClick={() => void save()}
              style={{ marginBottom: 4 }}
            >
              Enregistrer
            </button>
          </div>
        </section>

        <section className="stack tight">
          <div className="row spread">
            <h3>Ressources du groupe</h3>
            <span className="tiny muted">Disponibilité pour les membres</span>
          </div>
          <McpAccessMatrix mcps={mcps} value={group.mcps} onChange={setAccess} />
        </section>

        <section className="stack tight">
          <div className="row spread">
            <h3>Membres ({group.members.length})</h3>
            <span className="tiny muted">
              Un utilisateur peut appartenir à plusieurs groupes
            </span>
          </div>
          {group.members.length === 0 && (
            <div className="small muted">Aucun membre pour l'instant.</div>
          )}
          {group.members.map((member) => (
            <div className="access-row" key={member.id}>
              <div className="names">
                <strong>{member.name || member.email}</strong>
                <span>{member.email}</span>
              </div>
              <KindBadge kind={member.kind} />
              {member.isAdmin && <span className="badge cyan plain">admin</span>}
              <button
                className="btn ghost small"
                onClick={() => void setMember(member.id, null)}
              >
                Retirer
              </button>
            </div>
          ))}
          <div className="row" style={{ gap: 10 }}>
            <select
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              style={{ flex: 1 }}
            >
              <option value="">Ajouter un utilisateur…</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name ? `${u.name} · ${u.email}` : u.email}
                </option>
              ))}
            </select>
            <button
              className="btn small"
              disabled={!adding}
              onClick={() => {
                void setMember(adding, group.id).then(() => setAdding(""));
              }}
            >
              <Icon name="plus" /> Ajouter
            </button>
          </div>
        </section>
      </div>
    </Drawer>
  );
}

export function AdminGroupsPage() {
  const [groups, setGroups] = useState<AdminGroup[]>([]);
  const [mcps, setMcps] = useState<AdminMcp[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api<AdminGroup[]>("/api/admin/groups")
      .then(setGroups)
      .catch((e: Error) => setError(e.message));
    api<AdminUser[]>("/api/admin/users")
      .then(setUsers)
      .catch(() => {});
  }, []);
  useEffect(() => {
    reload();
    api<AdminMcp[]>("/api/admin/mcps")
      .then((list) => setMcps(list.filter((m) => m.loaded)))
      .catch(() => {});
  }, [reload]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return groups;
    return groups.filter(
      (g) =>
        g.name.toLowerCase().includes(needle) ||
        g.description.toLowerCase().includes(needle),
    );
  }, [groups, search]);

  const current = groups.find((g) => g.id === selected) ?? null;
  const names = Object.fromEntries(mcps.map((m) => [m.slug, m.name]));

  return (
    <>
      <PageHead
        eyebrow="Administration"
        title="Groupes"
        lead="Affectez des groupes aux ressources puis aux utilisateurs. Seuls les membres de ces groupes peuvent accéder aux ressources associées."
        actions={
          <button className="btn accent" onClick={() => setCreating(true)}>
            <Icon name="plus" /> Nouveau groupe
          </button>
        }
      />
      {error && <div className="alert error">{error}</div>}
      <div className="card">
        <div className="card-head" style={{ gap: 10, flexWrap: "wrap" }}>
          <span className="badge off plain">
            {groups.length} groupe{groups.length > 1 ? "s" : ""}
          </span>
          <div style={{ flex: 1 }} />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher un groupe"
            style={{ maxWidth: 300 }}
          />
        </div>
        {filtered.length === 0 ? (
          <Empty icon="group" title="Aucun groupe">
            Créez les groupes qui pourront accéder aux ressources.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Groupe</th>
                  <th>Ressources</th>
                  <th>Membres</th>
                  <th>Créé</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((group) => (
                  <tr
                    key={group.id}
                    className={`clickable ${selected === group.id ? "selected" : ""}`}
                    onClick={() => setSelected(group.id)}
                  >
                    <td>
                      <div className="primary">{group.name}</div>
                      <div className="secondary">{group.description || "—"}</div>
                    </td>
                    <td>
                      {group.mcps.length === 0 ? (
                        <span className="small muted">aucun</span>
                      ) : (
                        <div className="chips">
                          {group.mcps.map((slug) => (
                            <span className="badge off plain" key={slug}>
                              {names[slug] ?? slug}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="num">{group.userCount}</td>
                    <td className="small muted">{formatDate(group.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {current && (
        <GroupDrawer
          group={current}
          mcps={mcps}
          users={users}
          onClose={() => setSelected(null)}
          onChanged={reload}
        />
      )}
      {creating && (
        <NewGroupModal
          mcps={mcps}
          onClose={() => setCreating(false)}
          onCreated={(group) => {
            reload();
            setSelected(group.id);
          }}
        />
      )}
    </>
  );
}
