import { useCallback, useEffect, useState } from "react";
import { api, type ApiKeyRow, formatDate, formatRelative, type UserMcp } from "../api";
import { GrantChips } from "../components/GrantChips";
import { KeyForm } from "../components/KeyForm";
import { ConfirmModal, CopyButton, Empty, Icon, PageHead } from "../components/ui";

export function KeysPage() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [mcps, setMcps] = useState<UserMcp[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api<ApiKeyRow[]>("/api/keys")
      .then(setKeys)
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    reload();
    api<UserMcp[]>("/api/mcps")
      .then(setMcps)
      .catch(() => {});
  }, [reload]);

  async function revoke(key: ApiKeyRow) {
    setError(null);
    try {
      await api(`/api/keys/${key.id}`, { method: "DELETE" });
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRevoking(null);
    }
  }

  const names = Object.fromEntries(mcps.map((m) => [m.slug, m.name]));

  return (
    <>
      <PageHead
        eyebrow="Mon espace"
        title="Mes clés API"
        lead="Une clé donne accès aux ressources choisies, au niveau choisi, sans jamais dépasser ce qui vous est affecté. Le secret n'est affiché qu'une fois."
        actions={
          <button className="btn accent" onClick={() => setCreating(true)}>
            <Icon name="plus" /> Nouvelle clé
          </button>
        }
      />
      {error && <div className="alert error">{error}</div>}
      {secret && (
        <div className="card pad stack" style={{ marginBottom: 22 }}>
          <div className="row spread">
            <strong>Clé créée — copiez-la maintenant, elle ne sera plus affichée.</strong>
            <button className="btn ghost small" onClick={() => setSecret(null)}>
              J'ai copié la clé
            </button>
          </div>
          <div className="secret-box">
            {secret}
            <CopyButton text={secret} />
          </div>
        </div>
      )}
      <div className="card">
        <div className="card-head">
          <h2>Clés actives</h2>
          <span className="badge off plain">{keys.length}</span>
        </div>
        {keys.length === 0 ? (
          <Empty icon="key" title="Aucune clé">
            Créez une clé pour connecter un client sans passer par OAuth.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Clé</th>
                  <th>Périmètre</th>
                  <th>Usage</th>
                  <th>Expire</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id}>
                    <td>
                      <div className="primary">{key.name}</div>
                      <div className="secondary mono">{key.start}…</div>
                    </td>
                    <td>
                      <GrantChips grants={key.grants} names={names} />
                    </td>
                    <td>
                      <div className="num">{key.requestCount} appels</div>
                      <div className="secondary">{formatRelative(key.lastRequest)}</div>
                    </td>
                    <td className="small">{formatDate(key.expiresAt)}</td>
                    <td>
                      <button
                        className="btn danger small"
                        onClick={() => setRevoking(key)}
                      >
                        Révoquer
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {revoking && (
        <ConfirmModal
          title="Révoquer la clé"
          confirmLabel="Révoquer"
          onClose={() => setRevoking(null)}
          onConfirm={() => revoke(revoking)}
        >
          Révoquer la clé <strong>{revoking.name}</strong> ({revoking.start}…) ? Les
          clients qui l'utilisent perdront l'accès immédiatement.
        </ConfirmModal>
      )}
      {creating && (
        <KeyForm
          mcps={mcps}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setSecret(created.key);
            reload();
          }}
        />
      )}
    </>
  );
}
