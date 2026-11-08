import { useEffect, useState } from "react";
import { api, formatRelative, type UserConsumer } from "../api";
import { Empty, Icon, PageHead } from "../components/ui";

/**
 * The agents this account connected to the rack. Unlike applications, they
 * are listed per account: an agent registers itself without any group policy,
 * so only the accounts that actually signed in through it see it.
 */
export function ConsumersPage() {
  const [consumers, setConsumers] = useState<UserConsumer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<UserConsumer[]>("/api/consumers")
      .then(setConsumers)
      .catch((e: Error) => setError(e.message));
  }, []);
  return (
    <section className="personal-section" aria-label="Mes consommateurs">
      <PageHead
        title="Mes consommateurs"
        lead="Les agents que vous avez connectés à votre compte Rack : Codex, Claude Code, et les autres clients MCP."
      />
      {error && <div className="alert error">{error}</div>}
      {!consumers && !error && <p className="muted">Chargement des consommateurs…</p>}
      {consumers?.length === 0 && (
        <div className="card">
          <Empty icon="plug" title="Aucun consommateur connecté">
            Connectez un client MCP au rack : il apparaîtra ici après votre première
            autorisation.
          </Empty>
        </div>
      )}
      <div className="grid">
        {consumers?.map((consumer) => (
          <article className="card catalogue-card" key={consumer.clientId}>
            <div className="card-body stack">
              <div className="mcp-icon">
                <Icon name="plug" />
              </div>
              <h3>{consumer.name || consumer.clientId}</h3>
              <p className="small muted catalogue-description">
                Autorisé {formatRelative(consumer.connectedAt)}
              </p>
            </div>
            <div className="card-foot">
              {consumer.url ? (
                <a
                  className="btn small"
                  href={consumer.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Site du client <Icon name="arrow-right" />
                </a>
              ) : (
                <span className="small muted mono ellipsis">{consumer.clientId}</span>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
