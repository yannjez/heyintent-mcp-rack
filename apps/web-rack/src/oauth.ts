import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * Finish an OAuth authorization from the browser.
 *
 * MCP clients (Claude Code, Codex, Cursor…) listen on a loopback port and render
 * a bare "Authentication complete" page when the browser lands on their
 * callback. To keep the user on the rack's own confirmation page instead, the
 * code is delivered to that loopback callback with a background request; if
 * the request cannot be sent (blocked, server gone), fall back to navigating.
 */
export async function finishOAuth(callbackUrl: string, clientId: string | null) {
  let target: URL;
  try {
    target = new URL(callbackUrl, window.location.origin);
  } catch {
    window.location.href = callbackUrl;
    return;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if (!loopback || target.origin === window.location.origin) {
    window.location.href = target.toString();
    return;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    await fetch(target.toString(), {
      mode: "no-cors",
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch {
    window.location.href = target.toString();
    return;
  }
  const params = new URLSearchParams();
  if (clientId) params.set("client", clientId);
  window.location.href = `/connected?${params}`;
}

/** Human label for an OAuth client id (DCR ids and CIMD URLs alike). */
export function clientLabel(clientId: string | null | undefined) {
  if (!clientId) return "cette application";
  const id = clientId.toLowerCase();
  if (id.includes("codex") || id.includes("chatgpt.com")) return "Codex";
  if (id.includes("claude")) return "Claude Code";
  if (id.includes("cursor")) return "Cursor";
  if (id.includes("windsurf")) return "Windsurf";
  try {
    return new URL(clientId).hostname;
  } catch {
    return clientId.length > 24 ? `${clientId.slice(0, 24)}…` : clientId;
  }
}

/** Name registered by the client, falling back to a label derived from its id. */
export function useClientName(clientId: string | null) {
  const [name, setName] = useState<string>(() => clientLabel(clientId));
  useEffect(() => {
    if (!clientId) return;
    api<{ name: string | null }>(`/api/oauth-clients/${encodeURIComponent(clientId)}`)
      .then((client) => {
        if (client.name) setName(client.name);
      })
      .catch(() => {});
  }, [clientId]);
  return name;
}
