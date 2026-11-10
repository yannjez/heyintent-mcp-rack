import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, type AdminApplication, type AdminMcp, KIND_NAMES } from "../../api";
import { NewApplicationModal } from "../../components/ApplicationForm";
import { NewResourceModal } from "../../components/ResourceForm";
import { Empty, Icon, KindTag, McpIcon, PageHead } from "../../components/ui";

type Filter = "all" | "application" | "resource" | "consumer";

export function AdminCataloguePage() {
  const navigate = useNavigate();
  const [applications, setApplications] = useState<AdminApplication[]>([]);
  const [resources, setResources] = useState<AdminMcp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState<"resource" | "application" | null>(null);

  const reload = useCallback(() => {
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
  useEffect(reload, [reload]);

  const needle = search.trim().toLowerCase();
  const entries = [
    ...applications.map((application) => ({
      id: application.clientId,
      // Consumers are OAuth clients too, but they are agents calling the MCP
      // endpoints, not products a user opens: they get their own collection.
      type:
        application.kind === "consumer"
          ? ("consumer" as const)
          : ("application" as const),
      kind: null,
      name: application.name || application.clientId,
      description:
        application.uri ||
        (application.kind === "consumer"
          ? "Client MCP enregistré auprès de Rack"
          : "Application connectée à Rack"),
      enabled: !application.disabled,
      access:
        application.kind === "consumer"
          ? `${application.users.length} compte(s) connecté(s)`
          : application.accessRestricted
            ? `Réservée à ${application.groupIds.length} groupe(s)`
            : "Tous les utilisateurs",
      path: `/admin/catalogue/applications/${encodeURIComponent(application.clientId)}`,
    })),
    ...resources.map((resource) => ({
      id: resource.slug,
      type: "resource" as const,
      kind: resource.kind,
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
        lead="Applications déclarées, ressources MCP et consommateurs enregistrés. Les sites et MCP distants s'ajoutent ici, sans redéploiement."
        actions={
          <>
            <button className="btn ghost" onClick={() => setCreating("application")}>
              <Icon name="plus" /> Déclarer une application
            </button>
            <button className="btn accent" onClick={() => setCreating("resource")}>
              <Icon name="plus" /> Ajouter une ressource
            </button>
          </>
        }
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
              {
                value: "application",
                label: "Applications",
                count: applications.filter((a) => a.kind !== "consumer").length,
              },
              { value: "resource", label: "Ressources", count: resources.length },
              {
                value: "consumer",
                label: "Consommateurs",
                count: applications.filter((a) => a.kind === "consumer").length,
              },
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
                    <McpIcon slug={entry.id} kind={entry.kind ?? undefined} />
                  ) : (
                    <div className="mcp-icon">
                      <Icon name={entry.type === "consumer" ? "plug" : "grid"} />
                    </div>
                  )}
                  <span className={`badge ${entry.enabled ? "ok" : "bad"}`}>
                    {entry.enabled ? "Actif" : "Désactivé"}
                  </span>
                </div>
                <div>
                  <span className="category">
                    {entry.type === "application"
                      ? "Application"
                      : entry.type === "consumer"
                        ? "Consommateur"
                        : entry.kind && entry.kind !== "package"
                          ? KIND_NAMES[entry.kind]
                          : "Ressource MCP"}
                    {entry.kind && entry.kind !== "package" && (
                      <KindTag kind={entry.kind} />
                    )}
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
      {creating === "resource" && (
        <NewResourceModal
          onClose={() => setCreating(null)}
          onChooseApplication={() => setCreating("application")}
          onCreated={(created) => {
            reload();
            navigate(`/admin/catalogue/ressources/${encodeURIComponent(created.slug)}`);
          }}
        />
      )}
      {creating === "application" && (
        <NewApplicationModal onClose={() => setCreating(null)} onCreated={reload} />
      )}
    </>
  );
}
