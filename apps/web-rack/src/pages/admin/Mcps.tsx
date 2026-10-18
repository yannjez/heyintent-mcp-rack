import { Link, useParams } from "react-router";
import { useCallback, useEffect, useState } from "react";
import {
  type AdminGroup,
  type AdminMcp,
  api,
  formatRelative,
  type SettingSpec,
} from "../../api";
import { CopyButton, Icon, McpIcon, PageHead, Switch } from "../../components/ui";

function SettingRow({ spec, configured }: { spec: SettingSpec; configured: boolean }) {
  return (
    <div className="setting-row">
      <div className="label">
        {spec.label}
        {configured ? (
          <span className="badge ok">configuré</span>
        ) : (
          <span className="badge warn">non configuré · mode démo</span>
        )}
      </div>
      {spec.description && <div className="tiny muted">{spec.description}</div>}
      <div className="controls">
        <code className="ellipsis">{spec.env}</code>
        <CopyButton text={spec.env} className="btn ghost small" />
      </div>
      {spec.example && !configured && (
        <div className="tiny muted mono ellipsis">ex. {spec.example}</div>
      )}
    </div>
  );
}

export function AdminMcpsPage() {
  const { slug } = useParams();
  const [loading, setLoading] = useState(true);
  const [mcps, setMcps] = useState<AdminMcp[]>([]);
  const [groups, setGroups] = useState<AdminGroup[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api<AdminMcp[]>("/api/admin/mcps")
      .then(setMcps)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    reload();
    api<AdminGroup[]>("/api/admin/groups")
      .then(setGroups)
      .catch((e: Error) => setError(e.message));
  }, [reload]);

  async function setGroup(slug: string, groupId: string, enabled: boolean) {
    setError(null);
    try {
      await api(`/api/admin/mcps/${slug}/groups/${groupId}`, {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      });
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function patch(slug: string, body: { enabled: boolean }) {
    setError(null);
    try {
      await api(`/api/admin/mcps/${slug}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <Link className="btn ghost detail-back" to="/admin/catalogue">
        Retour au catalogue
      </Link>
      <PageHead
        eyebrow="Administration"
        title={mcps.find((mcp) => mcp.slug === slug)?.name ?? "Ressource"}
        lead="Gérez les groupes autorisés, la connexion et les outils de cette ressource."
      />
      {loading && <p className="muted">Chargement…</p>}
      {!loading && !error && !mcps.some((mcp) => mcp.slug === slug) && (
        <p className="muted">Ressource introuvable.</p>
      )}
      {error && <div className="alert error">{error}</div>}
      <div className="stack" style={{ gap: 20 }}>
        {mcps
          .filter((mcp) => mcp.slug === slug)
          .map((mcp) => {
            const reads = mcp.tools.filter((t) => !t.write);
            const writes = mcp.tools.filter((t) => t.write);
            const demo =
              mcp.settingsSpec.length > 0 && mcp.configuredSettings.length === 0;
            return (
              <article className="card" key={mcp.slug}>
                <div className="card-head">
                  <McpIcon slug={mcp.slug} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <h2>{mcp.name}</h2>
                      <span className="tiny muted mono">
                        {mcp.slug} · v{mcp.version}
                      </span>
                      {!mcp.loaded && <span className="badge bad">package absent</span>}
                      {demo && mcp.loaded && (
                        <span className="badge warn">mode démo</span>
                      )}
                    </div>
                    <div className="small muted">{mcp.description}</div>
                  </div>
                  <div className="row" style={{ gap: 10 }}>
                    <span className={`badge ${mcp.enabled ? "ok" : "bad"}`}>
                      {mcp.enabled ? "actif" : "désactivé"}
                    </span>
                    <Switch
                      on={mcp.enabled}
                      disabled={!mcp.loaded}
                      onChange={(on) => void patch(mcp.slug, { enabled: on })}
                      label="Activer"
                    />
                  </div>
                </div>
                <div className="card-body">
                  <section className="stack tight" style={{ marginBottom: 24 }}>
                    <h3>Groupes autorisés</h3>
                    <p className="small muted">
                      Seuls les utilisateurs appartenant à au moins un de ces groupes
                      peuvent accéder à cette ressource. Sans groupe, aucun accès.
                    </p>
                    {groups.length === 0 && (
                      <div className="small muted">
                        Créez un groupe depuis la page Groupes.
                      </div>
                    )}
                    {groups.map((group) => (
                      <div className="access-row" key={group.id}>
                        <div className="names">
                          <strong>{group.name}</strong>
                          <span>{group.description}</span>
                        </div>
                        <Switch
                          on={mcp.groups.some((g) => g.id === group.id)}
                          label={`Autoriser ${group.name}`}
                          onChange={(enabled) =>
                            void setGroup(mcp.slug, group.id, enabled)
                          }
                        />
                      </div>
                    ))}
                  </section>
                  <div className="grid two">
                    <section className="stack tight">
                      <h3>Connexion au système cible</h3>
                      {mcp.settingsSpec.length === 0 ? (
                        <div className="small muted">
                          Aucune variable d'environnement requise.
                        </div>
                      ) : (
                        <div className="small muted">
                          Variables lues au démarrage du rack. Modifier une valeur demande
                          un redémarrage.
                        </div>
                      )}
                      <div>
                        {mcp.settingsSpec.map((spec) => (
                          <SettingRow
                            key={spec.key}
                            spec={spec}
                            configured={mcp.configuredSettings.includes(spec.key)}
                          />
                        ))}
                      </div>
                    </section>
                    <section className="stack tight">
                      <h3>
                        Outils{" "}
                        <span className="tiny muted" style={{ fontWeight: 500 }}>
                          {reads.length} lecture · {writes.length} écriture
                        </span>
                      </h3>
                      <ul className="tool-list" style={{ padding: 0 }}>
                        {mcp.tools.map((tool) => (
                          <li key={tool.name}>
                            <span className={`name ${tool.write ? "write" : ""}`}>
                              {tool.name}
                            </span>
                            <span className="desc">{tool.title}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  </div>
                </div>
                <div className="card-foot">
                  <div className="url-line" style={{ flex: 1 }}>
                    <Icon name="plug" size={14} />
                    <span>{mcp.url}</span>
                  </div>
                  <span className="badge off plain">
                    <Icon name="users" size={13} /> {mcp.userCount} autorisé
                    {mcp.userCount > 1 ? "s" : ""}
                  </span>
                  <span className="tiny muted">vu {formatRelative(mcp.lastSeenAt)}</span>
                </div>
              </article>
            );
          })}
      </div>
    </>
  );
}
