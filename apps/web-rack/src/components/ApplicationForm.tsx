import { type FormEvent, useState } from "react";
import { api, type CreatedApplication } from "../api";
import { CopyButton, Icon, Modal } from "./ui";

/**
 * Declare an application: a product your users open, which signs them in
 * through the rack. The rack registers it as an OAuth client and hands back
 * credentials — the secret is shown once and never retrievable afterwards.
 *
 * Agents that call the MCP endpoints (Codex, Claude Code…) are not declared
 * here: they register themselves and land in « Consommateurs ».
 */
export function NewApplicationModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (created: CreatedApplication) => void;
}) {
  const [name, setName] = useState("");
  const [uri, setUri] = useState("");
  const [redirectUris, setRedirectUris] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedApplication | null>(null);

  const redirects = redirectUris
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const application = await api<CreatedApplication>("/api/admin/applications", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          ...(uri.trim() ? { uri: uri.trim() } : {}),
          redirectUris: redirects,
        }),
      });
      setCreated(application);
      onCreated(application);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <Modal title="Application déclarée" onClose={onClose}>
        <div className="stack">
          <div className="alert info">
            Notez le secret maintenant : il est stocké haché et ne pourra plus être
            affiché.
          </div>
          <label className="field">
            Client ID
            <div className="row" style={{ gap: 8 }}>
              <input type="text" readOnly value={created.clientId} />
              <CopyButton text={created.clientId} className="btn ghost small" />
            </div>
          </label>
          {created.clientSecret && (
            <label className="field">
              Client secret
              <div className="row" style={{ gap: 8 }}>
                <input type="text" readOnly value={created.clientSecret} />
                <CopyButton text={created.clientSecret} className="btn ghost small" />
              </div>
            </label>
          )}
          <p className="tiny muted">
            L'application reste ouverte à tous les comptes tant que vous ne la réservez
            pas à des groupes depuis sa fiche.
          </p>
          <div className="row end">
            <button type="button" className="btn accent" onClick={onClose}>
              Terminé
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Déclarer une application" onClose={onClose}>
      <form className="stack" onSubmit={submit} id="new-application">
        {error && <div className="alert error">{error}</div>}
        <label className="field">
          Nom
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            placeholder="Veille AO"
          />
        </label>
        <label className="field">
          Adresse publique <span className="hint">(bouton « Ouvrir l'application »)</span>
          <input
            type="url"
            value={uri}
            onChange={(e) => setUri(e.target.value)}
            placeholder="https://veille-ao.heyintent.com"
          />
        </label>
        <label className="field">
          URL de redirection OAuth <span className="hint">(une par ligne)</span>
          <textarea
            rows={3}
            value={redirectUris}
            onChange={(e) => setRedirectUris(e.target.value)}
            required
            placeholder="https://veille-ao.heyintent.com/auth/callback"
          />
        </label>
        <p className="tiny muted">
          <Icon name="shield" /> Les agents MCP (Codex, Claude Code…) n'ont pas à être
          déclarés ici : ils s'enregistrent seuls et apparaissent dans « Consommateurs ».
        </p>
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>
            Annuler
          </button>
          <button
            className="btn accent"
            disabled={busy || !name.trim() || !redirects.length}
          >
            {busy ? "Création…" : "Déclarer"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
