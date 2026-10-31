import { useEffect, useMemo, useState } from "react";
import { useLocation, useOutletContext } from "react-router";
import { authClient } from "../auth-client";
import { type Access, api, type Me, type UserMcp } from "../api";
import { AccessPicker, Icon, McpIcon } from "../components/ui";
import {
  authErrorMessage,
  isInvalidOAuthQuery,
  oauthRequestExpired,
  restartOAuthPath,
} from "../oauth-recovery";
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
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const [invalidOAuth, setInvalidOAuth] = useState(() =>
    oauthRequestExpired(location.search),
  );
  const restartPath = restartOAuthPath(location.search);
  const clientId = params.get("client_id");
  const clientName = useClientName(clientId);
  const scope = params.get("scope") ?? "";
  const requested = useMemo(() => scope.split(/\s+/).filter(Boolean), [scope]);
  const [applicationAllowed, setApplicationAllowed] = useState<boolean | null>(null);
  const [mcps, setMcps] = useState<UserMcp[] | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set(requested));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setApplicationAllowed(null);
    if (!clientId) {
      setApplicationAllowed(false);
      return;
    }
    api<{ allowed: boolean }>(`/api/oauth-clients/${encodeURIComponent(clientId)}`)
      .then((client) => setApplicationAllowed(client.allowed))
      .catch(() => setApplicationAllowed(false));
  }, [clientId]);

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
    try {
      const result = await authClient.oauth2.consent({
        accept,
        ...(accept ? { scope: requested.filter((s) => accepted.has(s)).join(" ") } : {}),
      });
      const next = (result.data as { redirect?: boolean; url?: string } | null) ?? {};
      if (next.url) {
        const target = new URL(next.url, window.location.origin);
        if (target.origin === window.location.origin && target.pathname === "/consent") {
          setInvalidOAuth(true);
          setBusy(false);
          setError("L’autorisation n’a pas pu aboutir. Reprenez la connexion.");
          return;
        }
        if (accept && !identityOnly) await finishOAuth(next.url, clientId);
        else window.location.href = next.url;
        return;
      }
      setBusy(false);
      if (isInvalidOAuthQuery(result.error)) setInvalidOAuth(true);
      setError(authErrorMessage(result.error, "Réponse inattendue du serveur."));
    } catch (e) {
      setBusy(false);
      setError(
        authErrorMessage(
          e,
          "Impossible de joindre le serveur. Réessayez dans un instant.",
        ),
      );
    }
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

  const identityOnly =
    requested.length > 0 && requested.every((scope) => Object.hasOwn(BASE_SCOPES, scope));
  const hasMcpScopes = groups.length > 0;
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
        <span className="consent-eyebrow">Autorisation d'une application</span>
        <h1>
          {clientName}{" "}
          <em>{identityOnly ? "demande à vous connecter" : "demande l’accès"}</em>
          {!identityOnly && " à vos ressources."}
        </h1>
        <p>
          {identityOnly
            ? "Cette application demande à utiliser votre identité pour vous connecter."
            : "Choisissez les ressources que cette application pourra utiliser en votre nom, dans la limite de vos droits."}
        </p>
        <ul className="consent-facts">
          <li>
            <Icon name="users" />
            Connecté en tant que {me.name || me.email}
          </li>
          <li>
            <Icon name="key" />
            {identityOnly
              ? "Connexion avec votre compte Rack"
              : "Jeton nominatif, limité aux ressources cochées"}
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
          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
          {invalidOAuth && restartPath && (
            <div className="stack tight">
              {!error && (
                <div className="alert error" role="alert">
                  La demande d’autorisation a expiré. Reprenez la connexion pour
                  continuer.
                </div>
              )}
              <a className="btn accent" href={restartPath}>
                Reprendre la connexion
              </a>
            </div>
          )}
          {applicationAllowed === false && (
            <div className="alert error">
              Vous n'avez pas accès à cette application. Contactez un administrateur.
            </div>
          )}
          {hasMcpScopes && (
            <p className="small muted" style={{ margin: 0 }}>
              Le niveau proposé correspond à ce que ce client demande, dans la limite de
              vos droits. « Aucun » exclut la ressource de cette autorisation.
            </p>
          )}

          {hasMcpScopes &&
            (mcps === null ? (
              <div className="small muted">Chargement de vos ressources…</div>
            ) : available.length === 0 ? (
              <div className="alert error">
                Aucune des ressources demandées ne vous est affectée. Vous pouvez
                seulement refuser, ou demander l'accès à un administrateur.
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
                      <McpIcon slug={group.slug} kind={mcp.kind} small />
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
            ))}

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
              identityOnly ? (
                "Connexion uniquement"
              ) : (
                "Aucune ressource sélectionnée"
              )
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
            disabled={
              busy ||
              invalidOAuth ||
              applicationAllowed !== true ||
              (!identityOnly && (!mcps || granted.length === 0))
            }
            onClick={() => answer(true)}
          >
            Autoriser
          </button>
        </div>
      </div>
    </div>
  );
}
