import { useCallback, useEffect, useState } from "react";
import {
  type Access,
  api,
  type ConsumerGrant,
  formatRelative,
  type UserConsumer,
} from "../api";
import { AccessPicker, Empty, Icon, McpIcon, PageHead } from "../components/ui";

/**
 * The agents this account connected to the rack, with what each may do, MCP
 * by MCP. Unlike applications, they are listed per account: an agent registers
 * itself without any group policy, so only the accounts that actually signed
 * in through it see it.
 */
export function ConsumersPage() {
  const [consumers, setConsumers] = useState<UserConsumer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api<UserConsumer[]>("/api/consumers")
        .then(setConsumers)
        .catch((e: Error) => setError(e.message)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function change(path: string, method: string, body: object) {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method, body: JSON.stringify(body) });
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
    setBusy(false);
  }

  function setLevel(consumer: UserConsumer, grant: ConsumerGrant, next: Access | null) {
    if (next !== null && next === grant.access) return;
    const label = consumer.name || "ce consommateur";
    if (
      next === null &&
      !window.confirm(
        `Retirer ${grant.name} à ${label} ? Il devra redemander votre autorisation pour y revenir.`,
      )
    ) {
      return;
    }
    void change("/api/consumers/grants", "PUT", {
      clientIds: grant.clientIds,
      slug: grant.slug,
      access: next ?? "none",
    });
  }

  function disconnect(consumer: UserConsumer) {
    const label = consumer.name || "ce consommateur";
    if (
      !window.confirm(
        `Déconnecter ${label} ? Toutes ses autorisations sur votre compte sont retirées.`,
      )
    ) {
      return;
    }
    void change("/api/consumers/disconnect", "POST", { clientIds: consumer.clientIds });
  }

  return (
    <section className="personal-section" aria-label="Mes consommateurs">
      <PageHead
        title="Mes consommateurs"
        lead="Les agents que vous avez connectés à votre compte Rack, et ce que chacun peut utiliser en votre nom. Un changement s'applique à son prochain appel, ou sous 15 minutes pour une application hébergée hors du rack."
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
      <div className="stack">
        {consumers?.map((consumer) => (
          <article className="card" key={consumer.clientIds.join(" ")}>
            <div className="card-head">
              <div className="mcp-icon sm">
                <Icon name="plug" />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2>{consumer.name || consumer.clientIds[0]}</h2>
                <span className="small muted">
                  Autorisé {formatRelative(consumer.connectedAt)}
                  {consumer.clientIds.length > 1 &&
                    ` · ${consumer.clientIds.length} connexions`}
                </span>
              </div>
              {consumer.url && (
                <a
                  className="btn small"
                  href={consumer.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Site du client <Icon name="arrow-right" />
                </a>
              )}
              <button
                className="btn small ghost"
                disabled={busy}
                onClick={() => disconnect(consumer)}
              >
                Déconnecter
              </button>
            </div>
            <div className="card-body stack">
              {consumer.grants.length === 0 ? (
                <p className="small muted" style={{ margin: 0 }}>
                  Aucune ressource autorisée : ce consommateur ne peut rien appeler en
                  votre nom.
                </p>
              ) : (
                <div className="access-matrix">
                  {consumer.grants.map((grant) => (
                    <div
                      className={`access-row ${grant.access ? "" : "blocked"}`}
                      key={grant.slug}
                    >
                      <McpIcon slug={grant.slug} kind={grant.kind} small />
                      <div className="names">
                        <strong>{grant.name}</strong>
                        <span>
                          {grant.max
                            ? grant.max === "read"
                              ? "Autorisé en lecture seule"
                              : "Autorisé en lecture et écriture"
                            : "Vous n'avez plus accès à cette ressource"}
                        </span>
                      </div>
                      {grant.max ? (
                        <AccessPicker
                          value={grant.access}
                          max={grant.max}
                          disabled={busy}
                          onChange={(next) => setLevel(consumer, grant, next)}
                        />
                      ) : (
                        // Without access of their own, the only move left is to withdraw.
                        <button
                          className="btn small ghost"
                          disabled={busy}
                          onClick={() => setLevel(consumer, grant, null)}
                        >
                          Retirer
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
