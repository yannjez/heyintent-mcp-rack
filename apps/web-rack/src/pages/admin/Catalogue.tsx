import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api, type AdminApplication, type AdminMcp } from "../../api";
import { Empty, Icon, McpIcon, PageHead } from "../../components/ui";

type Filter = "all" | "application" | "resource";

export function AdminCataloguePage() {
  const [applications, setApplications] = useState<AdminApplication[]>([]);
  const [resources, setResources] = useState<AdminMcp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  useEffect(() => {
    Promise.all([
      api<AdminApplication[]>("/api/admin/applications"),
      api<AdminMcp[]>("/api/admin/mcps"),
    ])
      .then(([apps, mcps]) => {
        setApplications(apps);
        setResources(mcps);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  const needle = search.trim().toLowerCase();
  const entries = [
    ...applications.map((application) => ({
      id: application.clientId,
      type: "application" as const,
      name: application.name || application.clientId,
      description: application.uri || "Application connectée à Rack",
      enabled: !application.disabled,
      access: application.accessRestricted
        ? `${application.groupIds.length} groupe(s) · ${application.users.filter((user) => user.allowed).length} accès individuel(s)`
        : "Tous les utilisateurs",
      path: `/admin/catalogue/applications/${encodeURIComponent(application.clientId)}`,
    })),
    ...resources.map((resource) => ({
      id: resource.slug,
      type: "resource" as const,
      name: resource.name,
      description: resource.description,
      enabled: resource.enabled && resource.loaded,
      access: `${resource.groupCount} groupe(s) · ${resource.userCount} utilisateur(s)`,
      path: `/admin/catalogue/ressources/${encodeURIComponent(resource.slug)}`,
    })),
  ]
    .filter(
      (entry) =>
        (filter === "all" || entry.type === filter) &&
        `${entry.name} ${entry.id} ${entry.description}`.toLowerCase().includes(needle),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));

  return (
    <>
      <PageHead
        eyebrow="Administration"
        title="Applications et ressources"
        lead="Un catalogue pour gérer les connexions, les ressources et leurs accès."
      />
      <div className="catalogue-toolbar">
        <div className="segmented" aria-label="Type d’entrée">
          {(
            [
              {
                value: "all",
                label: "Tout",
                count: applications.length + resources.length,
              },
              { value: "application", label: "Applications", count: applications.length },
              { value: "resource", label: "Ressources", count: resources.length },
            ] as const
          ).map(({ value, label, count }) => (
            <button
              key={value}
              className={filter === value ? "on" : ""}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label} · {count}
            </button>
          ))}
        </div>
        <input
          type="search"
          aria-label="Rechercher dans le catalogue"
          placeholder="Rechercher une application ou une ressource…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {error && <div className="alert error">{error}</div>}
      {loading ? (
        <p className="muted">Chargement du catalogue…</p>
      ) : !error && entries.length === 0 ? (
        <Empty icon="grid" title="Aucun résultat">
          Les applications enregistrées et les ressources du rack apparaissent ici.
        </Empty>
      ) : (
        <div className="grid">
          {entries.map((entry) => (
            <article className="card catalogue-card" key={`${entry.type}:${entry.id}`}>
              <div className="card-body stack">
                <div className="row spread">
                  {entry.type === "resource" ? (
                    <McpIcon slug={entry.id} />
                  ) : (
                    <div className="mcp-icon">
                      <Icon name="grid" />
                    </div>
                  )}
                  <span className={`badge ${entry.enabled ? "ok" : "bad"}`}>
                    {entry.enabled ? "Actif" : "Désactivé"}
                  </span>
                </div>
                <div>
                  <span className="category">
                    {entry.type === "application" ? "Application" : "Ressource MCP"}
                  </span>
                  <h2>
                    <Link to={entry.path}>{entry.name}</Link>
                  </h2>
                </div>
                <p className="small muted catalogue-description">{entry.description}</p>
                <span className="small muted">{entry.access}</span>
              </div>
              <div className="card-foot">
                <Link className="btn small" to={entry.path}>
                  Gérer les accès <Icon name="arrow-right" />
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
