import { type FormEvent, useState } from "react";
import { type Access, api, type ApiKeyRow, type UserMcp } from "../api";
import { AccessPicker, McpIcon, Modal } from "./ui";

/** Modal form creating a self-service API key. */
export function KeyForm({
  mcps,
  onClose,
  onCreated,
}: {
  mcps: UserMcp[];
  onClose: () => void;
  onCreated: (key: ApiKeyRow & { key: string }) => void;
}) {
  const [name, setName] = useState("");
  const [selection, setSelection] = useState<Record<string, Access>>({});
  const [expiresInDays, setExpiresInDays] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function setAccess(slug: string, access: Access | null) {
    setSelection((current) => {
      const next = { ...current };
      if (access) next[slug] = access;
      else delete next[slug];
      return next;
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api<ApiKeyRow & { key: string }>("/api/keys", {
        method: "POST",
        body: JSON.stringify({
          name,
          mcps: selection,
          ...(expiresInDays ? { expiresInDays: Number(expiresInDays) } : {}),
        }),
      });
      onCreated(created);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const restricted = Object.keys(selection).length > 0;

  return (
    <Modal title="Nouvelle clé" onClose={onClose}>
      <form className="stack" onSubmit={submit} id="new-key">
        {error && <div className="alert error">{error}</div>}
        <label className="field">
          Nom
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            placeholder="Claude Code sur mon poste"
          />
        </label>
        <div className="field">
          <span>
            Périmètre{" "}
            <span className="hint">
              {restricted
                ? "— limité aux ressources choisies"
                : "— par défaut, toutes vos ressources avec le niveau qui vous est affecté"}
            </span>
          </span>
          <div className="access-matrix">
            {mcps.map((mcp) => (
              <div className="access-row" key={mcp.slug}>
                <McpIcon slug={mcp.slug} kind={mcp.kind} small />
                <div className="names">
                  <strong>{mcp.name}</strong>
                  <span>
                    {mcp.access === "write"
                      ? "Vous avez l'écriture"
                      : "Lecture seule pour vous"}
                  </span>
                </div>
                <AccessPicker
                  value={selection[mcp.slug] ?? null}
                  max={mcp.access}
                  onChange={(access) => setAccess(mcp.slug, access)}
                />
              </div>
            ))}
            {mcps.length === 0 && (
              <div className="small muted">
                Aucune ressource ne vous est affectée pour le moment.
              </div>
            )}
          </div>
        </div>
        <label className="field">
          Expiration <span className="hint">(jours, vide = jamais)</span>
          <input
            type="number"
            min={1}
            max={3650}
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
            placeholder="90"
          />
        </label>
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>
            Annuler
          </button>
          <button className="btn accent" disabled={busy || !name || mcps.length === 0}>
            Créer la clé
          </button>
        </div>
      </form>
    </Modal>
  );
}
