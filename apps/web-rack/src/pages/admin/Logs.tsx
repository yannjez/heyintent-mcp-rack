import { useCallback, useEffect, useMemo, useState } from "react";
import { type AdminMcp, api, formatDate, type LogRow } from "../../api";
import { Empty, Icon, McpIcon, PageHead } from "../../components/ui";

export function AdminLogsPage() {
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [mcps, setMcps] = useState<AdminMcp[]>([]);
  const [slug, setSlug] = useState("");
  const [status, setStatus] = useState<"" | "true" | "false">("");
  const [search, setSearch] = useState("");
  const [auto, setAuto] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const reload = useCallback(() => {
    const params = new URLSearchParams({ limit: "200" });
    if (slug) params.set("slug", slug);
    if (status) params.set("ok", status);
    api<LogRow[]>(`/api/admin/logs?${params}`)
      .then((rows) => {
        setLogs(rows);
        setUpdatedAt(new Date());
      })
      .catch((e: Error) => setError(e.message));
  }, [slug, status]);

  useEffect(reload, [reload]);
  useEffect(() => {
    api<AdminMcp[]>("/api/admin/mcps")
      .then(setMcps)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(reload, 10_000);
    return () => clearInterval(timer);
  }, [auto, reload]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return logs;
    return logs.filter(
      (l) =>
        l.tool.toLowerCase().includes(needle) ||
        (l.userEmail ?? "").toLowerCase().includes(needle) ||
        (l.error ?? "").toLowerCase().includes(needle),
    );
  }, [logs, search]);

  const errors = logs.filter((l) => !l.ok).length;
  const cost = logs.reduce((sum, l) => sum + (l.cost ?? 0), 0);

  return (
    <>
      <PageHead
        eyebrow="Administration"
        title="Logs"
        lead="Journal des appels d'outils des ressources et des services du rack (LLM, image, GitHub), avec l'utilisateur, la durée et le coût."
        actions={
          <>
            <label className="check small">
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => setAuto(e.target.checked)}
              />
              Rafraîchir toutes les 10 s
            </label>
            <button className="btn ghost small" onClick={reload}>
              <Icon name="refresh" /> Actualiser
            </button>
          </>
        }
      />
      {error && <div className="alert error">{error}</div>}
      <div className="card">
        <div className="card-head" style={{ gap: 10, flexWrap: "wrap" }}>
          <select
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            style={{ maxWidth: 220 }}
          >
            <option value="">Toutes les ressources</option>
            {mcps.map((m) => (
              <option key={m.slug} value={m.slug}>
                {m.name}
              </option>
            ))}
          </select>
          <div className="segmented">
            {(
              [
                ["", "Tout"],
                ["true", "Succès"],
                ["false", "Erreurs"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                className={status === value ? "on" : ""}
                onClick={() => setStatus(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Outil, utilisateur, message d'erreur"
            style={{ maxWidth: 300 }}
          />
          <div style={{ flex: 1 }} />
          <span className="tiny muted">
            {logs.length} entrées · {errors} erreur{errors > 1 ? "s" : ""}
            {cost > 0 ? ` · $${cost.toFixed(4)}` : ""}
            {updatedAt ? ` · ${updatedAt.toLocaleTimeString("fr-FR")}` : ""}
          </span>
        </div>
        {filtered.length === 0 ? (
          <Empty icon="logs" title="Aucun appel journalisé" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Ressource</th>
                  <th>Outil</th>
                  <th>Utilisateur</th>
                  <th>Statut</th>
                  <th className="num">Durée</th>
                  <th className="num">Coût</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((log) => (
                  <tr
                    key={log.id}
                    className={log.error ? "clickable" : ""}
                    onClick={() =>
                      log.error && setExpanded(expanded === log.id ? null : log.id)
                    }
                  >
                    <td className="small muted num">{formatDate(log.createdAt)}</td>
                    <td>
                      <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                        <McpIcon slug={log.mcp} small />
                        <span className="small">{log.mcpName}</span>
                      </div>
                    </td>
                    <td>
                      <code>{log.tool}</code>{" "}
                      {log.capability && <span className="badge off plain">service</span>}
                      {expanded === log.id && log.error && (
                        <div className="alert error small" style={{ marginTop: 8 }}>
                          {log.error}
                        </div>
                      )}
                    </td>
                    <td className="small">
                      {log.userEmail ?? (
                        <span className="mono muted">{log.userId?.slice(0, 8)}</span>
                      )}
                      {log.keyId && (
                        <span className="badge off plain" style={{ marginLeft: 6 }}>
                          clé
                        </span>
                      )}
                    </td>
                    <td>
                      {log.ok ? (
                        <span className="badge ok">ok</span>
                      ) : (
                        <span className="badge bad" title={log.error ?? ""}>
                          erreur
                        </span>
                      )}
                    </td>
                    <td className="num small">{log.durationMs} ms</td>
                    <td className="num small">
                      {log.cost != null ? `$${log.cost.toFixed(4)}` : "—"}
                    </td>
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
