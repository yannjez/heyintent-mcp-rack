import { useEffect, useMemo, useState } from "react";
import { useLocation, useOutletContext } from "react-router";
import { authClient } from "../auth-client";
import { type Access, api, type Me, type UserMcp } from "../api";
import { AccessPicker, Icon, McpIcon } from "../components/ui";
import { finishOAuth, useClientName } from "../oauth";

/** Non-MCP scopes a client may ask for, in plain words. */
const BASE_SCOPES: Record<string, string> = {
  openid: "Vous identifier",
  profile: "Lire votre nom",
  email: "Lire votre adresse email",
  offline_access: "Rester connecté sans redemander de code",
};

function parseScope(scope: string): { slug: string; access: Access } | null {
  if (!scope.startsWith("mcp:")) return null;
  const [slug, level] = scope.slice(4).split(":");
  if (!slug) return null;
  return { slug, access: level === "read" ? "read" : "write" };
}

interface ScopeGroup {
  slug: string;
  scopes: { read?: string; write?: string };
  /** The MCP as the signed-in user may use it; null when unavailable to them. */
  mcp: UserMcp | null;
}

export function ConsentPage() {
  const me = useOutletContext<Me>();
  const params = new URLSearchParams(useLocation().search);
  const clientId = params.get("client_id");
  const clientName = useClientName(clientId);
  const requested = (params.get("scope") ?? "").split(/\s+/).filter(Boolean);
  const [mcps, setMcps] = useState<UserMcp[] | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set(requested));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<UserMcp[]>("/api/mcps")
      .then(setMcps)
      .catch(() => setMcps([]));
  }, []);

  // Group mcp:<slug>:<access> scopes per MCP, joined with what the user may use.
  const groups = useMemo<ScopeGroup[]>(() => {
    const bySlug = new Map<string, { read?: string; write?: string }>();
    for (const scope of requested) {
      const parsed = parseScope(scope);
      if (!parsed) continue;
      const entry = bySlug.get(parsed.slug) ?? {};
      entry[parsed.access] = scope;
      bySlug.set(parsed.slug, entry);
    }
    return [...bySlug].map(([slug, scopes]) => ({
      slug,
      scopes,
      mcp: mcps?.find((m) => m.slug === slug) ?? null,
    }));
  }, [requested, mcps]);

  // Once the user's MCPs are known, drop what they cannot honour.
  useEffect(() => {
    if (!mcps) return;
    setAccepted((prev) => {
      const next = new Set(prev);
      for (const group of groups) {
        if (!group.mcp) {
          if (group.scopes.read) next.delete(group.scopes.read);
          if (group.scopes.write) next.delete(group.scopes.write);
        } else if (group.mcp.access !== "write" && group.scopes.write) {
          next.delete(group.scopes.write);
        }
      }
      return next;
    });
  }, [mcps, groups]);

  async function answer(accept: boolean) {
    setBusy(true);
    setError(null);
    const result = await authClient.oauth2.consent({
      accept,
      ...(accept ? { scope: requested.filter((s) => accepted.has(s)).join(" ") } : {}),
    });
    const next = (result.data as { redirect?: boolean; url?: string } | null) ?? {};
    if (next.url) {
      if (accept) await finishOAuth(next.url, clientId);
      else window.location.href = next.url;
      return;
    }
    setBusy(false);
    setError(result.error?.message ?? "Réponse inattendue du serveur.");
  }

  /** Level granted on one MCP, derived from its accepted scopes. */
  function levelOf(group: ScopeGroup): Access | null {
    const read = group.scopes.read ? accepted.has(group.scopes.read) : false;
    const write = group.scopes.write ? accepted.has(group.scopes.write) : false;
    if (write) return "write";
    if (read) return "read";
    return null;
  }

  function setLevel(group: ScopeGroup, level: Access | null) {
    setAccepted((prev) => {
      const next = new Set(prev);
      const { read, write } = group.scopes;
      if (read) {
        if (level) next.add(read);
        else next.delete(read);
      }
      if (write) {
        if (level === "write") next.add(write);
        else next.delete(write);
      }
      return next;
    });
  }

  const baseScopes = requested.filter(
    (s) => !s.startsWith("mcp:") && !s.startsWith("cap:"),
  );
  const available = groups.filter((g) => g.mcp);
  const unavailable = groups.filter((g) => !g.mcp);
  const granted = available.map(levelOf).filter(Boolean) as Access[];
  const readCount = granted.filter((a) => a === "read").length;
  const writeCount = granted.filter((a) => a === "write").length;

  return (
    <div className="consent-page">
      <a className="brand" href="https://heyintent.com" target="_blank" rel="noreferrer">
        <img src="/intent-logo.svg" alt="Intent" className="brand-logo" />
        <span className="brand-sep" />
        <span className="brand-text">
          <strong>Ressource Rack</strong>
          <small>Intent · Agents IA</small>
        </span>
      </a>

      <header className="consent-head">
        <span className="consent-eyebrow">Autorisation d'un client MCP</span>
        <h1>
          {clientName} <em>demande l'accès</em> à vos ressources.
        </h1>
        <p>
          Choisissez, ressource par ressource, ce que ce client pourra faire en votre nom. Il n'aura
          jamais plus de droits que vous, et chaque appel est journalisé à votre nom.
        </p>
        <ul className="consent-facts">
          <li>
            <Icon name="users" />
            Connecté en tant que {me.name || me.email}
          </li>
          <li>
            <Icon name="key" />
            Jeton nominatif, limité aux ressources cochées
          </li>
        </ul>
      </header>

      <div className="card consent-card">
        <div className="card-head">
          <div className="mcp-icon sm">
            <Icon name="plug" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>Autoriser {clientName}</h2>
            <code className="small muted ellipsis" style={{ display: "block" }}>
              {clientId ?? "client inconnu"}
            </code>
          </div>
        </div>
        <div className="card-body stack">
          {error && <div className="alert error">{error}</div>}
          <p className="small muted" style={{ margin: 0 }}>
            Le niveau proposé correspond à ce que ce client demande, dans la limite de vos
            droits. « Aucun » exclut la ressource de cette autorisation.
          </p>

          {mcps === null ? (
            <div className="small muted">Chargement de vos ressources…</div>
          ) : available.length === 0 ? (
            <div className="alert error">
              Aucune des ressources demandées ne vous est affectée. Vous pouvez seulement refuser,
              ou demander l'accès à un administrateur.
            </div>
          ) : (
            <div className="access-matrix">
              {available.map((group) => {
                const mcp = group.mcp!;
                const level = levelOf(group);
                const max: Access =
                  group.scopes.write && mcp.access === "write" ? "write" : "read";
                return (
                  <div
                    className={`access-row ${level ? "" : "blocked"}`}
                    key={group.slug}
                  >
                    <McpIcon slug={group.slug} small />
                    <div className="names">
                      <strong>{mcp.name}</strong>
                      <span title={mcp.description}>
                        {mcp.description || mcp.category || "MCP"}
                      </span>
                    </div>
                    <AccessPicker
                      value={level}
                      max={max}
                      onChange={(next) => setLevel(group, next)}
                    />
                  </div>
                );
              })}
            </div>
          )}

          {mcps !== null && unavailable.length > 0 && (
            <div className="tiny muted">
              Non disponible pour votre compte, donc refusé :{" "}
              {unavailable.map((g) => g.slug).join(", ")}.
            </div>
          )}

          {baseScopes.length > 0 && (
            <ul className="consent-base">
              {baseScopes.map((scope) => (
                <li key={scope}>
                  <Icon name="check" />
                  {BASE_SCOPES[scope] ?? scope}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card-foot">
          <span className="consent-summary">
            {granted.length === 0 ? (
              "Aucune ressource sélectionnée"
            ) : (
              <>
                <strong>{granted.length}</strong> ressource{granted.length > 1 ? "s" : ""}
                {readCount > 0 && ` · ${readCount} en lecture`}
                {writeCount > 0 && ` · ${writeCount} en écriture`}
              </>
            )}
          </span>
          <button className="btn ghost" disabled={busy} onClick={() => answer(false)}>
            Refuser
          </button>
          <button
            className="btn accent"
            disabled={busy || !mcps || granted.length === 0}
            onClick={() => answer(true)}
          >
            Autoriser
          </button>
        </div>
      </div>
    </div>
  );
}
