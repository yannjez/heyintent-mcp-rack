import { useEffect, useState } from "react";
import { api, type Me, type UserMcp } from "../api";
import {
  AccessBadge,
  CopyButton,
  Empty,
  Icon,
  McpIcon,
  Modal,
  PageHead,
  Snippet,
} from "../components/ui";

type Tab = "claude" | "codex" | "json" | "config";

function ConnectModal({ mcp, onClose }: { mcp: UserMcp; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("config");
  const suggestedName = `intent-${mcp.slug}`;
  const envVar = `INTENT_MCP_${mcp.slug.replace(/-/g, "_").toUpperCase()}_KEY`;
  const json = JSON.stringify(
    {
      mcpServers: {
        [suggestedName]: {
          type: "http",
          url: mcp.url,
          headers: { Authorization: "Bearer rk_…" },
        },
      },
    },
    null,
    2,
  );
  const toml = [
    `[mcp_servers.${suggestedName}]`,
    `url = "${mcp.url}"`,
    `# avec une clé API au lieu d'OAuth :`,
    `# bearer_token_env_var = "${envVar}"`,
  ].join("\n");
  const tabs: { id: Tab; label: string }[] = [
    { id: "config", label: "Configuration" },
    { id: "claude", label: "Claude Code" },
    { id: "codex", label: "Codex" },
    { id: "json", label: "Cursor / JSON" },
  ];
  return (
    <Modal
      title={
        <span className="row">
          <McpIcon slug={mcp.slug} small /> Connecter {mcp.name}
        </span>
      }
      onClose={onClose}
      wide
    >
      <div className="stack">
        <div className="tabs" style={{ padding: 0 }}>
          {tabs.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "on" : ""}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "claude" && (
          <>
            <h3>Avec OAuth</h3>
            <p className="small muted">
              Claude Code découvre le serveur OAuth, ouvre votre navigateur pour vous
              connecter et vous demande de confirmer le niveau d'accès. Rien à
              copier-coller.
            </p>
            <Snippet
              code={`claude mcp add --transport http ${suggestedName} ${mcp.url}`}
            />
            <h3>Avec une clé API</h3>
            <p className="small muted">
              Créez une clé dans « Mes clés API », puis passez-la dans l'en-tête
              Authorization.
            </p>
            <Snippet
              code={`claude mcp add --transport http ${suggestedName} ${mcp.url} \\\n  --header "Authorization: Bearer rk_…"`}
            />
          </>
        )}

        {tab === "codex" && (
          <>
            <h3>Avec OAuth</h3>
            <p className="small muted">
              Ajoutez le serveur puis lancez la connexion : Codex ouvre votre navigateur
              sur cette page pour le consentement.
            </p>
            <Snippet
              code={`codex mcp add ${suggestedName} --url ${mcp.url}\ncodex mcp login ${suggestedName}`}
            />
            <h3>Avec une clé API</h3>
            <p className="small muted">
              Codex lit la clé dans une variable d'environnement et l'envoie en Bearer.
            </p>
            <Snippet
              code={`export ${envVar}="rk_…"\ncodex mcp add ${suggestedName} --url ${mcp.url} \\\n  --bearer-token-env-var ${envVar}`}
            />
            <h3>
              Ou dans <code>~/.codex/config.toml</code>
            </h3>
            <Snippet code={toml} />
          </>
        )}

        {tab === "json" && (
          <>
            <p className="small muted">
              Pour Cursor, Windsurf ou tout client acceptant une configuration JSON
              (.cursor/mcp.json).
            </p>
            <Snippet code={json} />
          </>
        )}

        {tab === "config" && (
          <dl className="kv">
            <dt>Nom suggéré</dt>
            <dd className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
              <code className="ellipsis">{suggestedName}</code>
              <CopyButton text={suggestedName} className="btn ghost small" />
            </dd>
            <dt>URL du serveur</dt>
            <dd className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
              <code className="ellipsis">{mcp.url}</code>
              <CopyButton text={mcp.url} className="btn ghost small" />
            </dd>
            <dt>Transport</dt>
            <dd>HTTP streamable (MCP 2025-06-18 et versions antérieures)</dd>
            <dt>Scopes</dt>
            <dd className="row" style={{ gap: 6 }}>
              <code>mcp:{mcp.slug}:read</code>
              {mcp.access === "write" && <code>mcp:{mcp.slug}:write</code>}
            </dd>
            <dt>Votre accès</dt>
            <dd>
              <AccessBadge access={mcp.access} />
            </dd>
            <dt>Outils exposés</dt>
            <dd>
              {mcp.access === "write"
                ? `${mcp.tools.length} (lecture et écriture)`
                : `${mcp.tools.filter((t) => !t.write).length} en lecture seule`}
            </dd>
          </dl>
        )}
      </div>
    </Modal>
  );
}

export function McpsPage({ me, showWelcome = true }: { me: Me; showWelcome?: boolean }) {
  const [mcps, setMcps] = useState<UserMcp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<UserMcp | null>(null);

  useEffect(() => {
    api<UserMcp[]>("/api/mcps")
      .then(setMcps)
      .catch((e: Error) => setError(e.message));
  }, []);

  const tools = mcps?.reduce((sum, mcp) => sum + mcp.tools.length, 0) ?? 0;
  const writable = mcps?.filter((mcp) => mcp.access === "write").length ?? 0;

  return (
    <>
      {showWelcome && (
        <div className="hero">
          <h1>Bonjour {me.name?.split(" ")[0] || me.email.split("@")[0]}</h1>
          <p>
            Branchez Claude Code, Cursor ou tout client MCP sur les ressources Intent :
            chaque ressource ci-dessous vous est affectée avec un niveau d'accès précis,
            en lecture ou en écriture.
          </p>
          <div className="stats">
            <div className="stat">
              <strong>{mcps?.length ?? "–"}</strong>
              <span>Ressources affectées</span>
            </div>
            <div className="stat">
              <strong>{mcps ? writable : "–"}</strong>
              <span>en écriture</span>
            </div>
            <div className="stat">
              <strong>{mcps ? tools : "–"}</strong>
              <span>outils disponibles</span>
            </div>
          </div>
        </div>
      )}

      <PageHead
        title="Mes ressources"
        lead="Connectez un client avec OAuth (connexion automatique via cette page) ou avec une clé API."
      />
      {error && <div className="alert error">{error}</div>}
      {mcps && mcps.length === 0 && (
        <div className="card">
          <Empty icon="shield" title="Aucune ressource ne vous est affectée">
            Demandez à un administrateur de vous ouvrir l'accès aux ressources dont vous
            avez besoin.
          </Empty>
        </div>
      )}
      <div className="grid">
        {mcps?.map((mcp) => {
          const reads = mcp.tools.filter((t) => !t.write);
          const writes = mcp.tools.filter((t) => t.write);
          const visible = mcp.access === "write" ? mcp.tools : reads;
          return (
            <article className="card mcp-card" key={mcp.slug}>
              <div className="card-body">
                <div className="mcp-title">
                  <McpIcon slug={mcp.slug} />
                  <div className="names">
                    <div className="category">
                      {mcp.category ?? "MCP"} · v{mcp.version}
                    </div>
                    <h3>{mcp.name}</h3>
                  </div>
                  <AccessBadge access={mcp.access} />
                </div>
                <p className="mcp-desc">{mcp.description}</p>
                <details className="tools">
                  <summary>
                    {visible.length} outil{visible.length > 1 ? "s" : ""}
                    <span className="faint" style={{ fontWeight: 500 }}>
                      · {reads.length} lecture
                      {mcp.access === "write"
                        ? ` · ${writes.length} écriture`
                        : writes.length > 0
                          ? ` · ${writes.length} écriture masqué${writes.length > 1 ? "s" : ""}`
                          : ""}
                    </span>
                  </summary>
                  <ul className="tool-list">
                    {visible.map((tool) => (
                      <li key={tool.name}>
                        <span className={`name ${tool.write ? "write" : ""}`}>
                          {tool.name}
                        </span>
                        <span className="desc">{tool.description}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
              <div className="card-foot">
                <div className="url-line" style={{ flex: 1 }}>
                  <span>{mcp.url}</span>
                </div>
                <button className="btn small" onClick={() => setConnecting(mcp)}>
                  <Icon name="plug" /> Connecter
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {connecting && (
        <ConnectModal mcp={connecting} onClose={() => setConnecting(null)} />
      )}
    </>
  );
}
