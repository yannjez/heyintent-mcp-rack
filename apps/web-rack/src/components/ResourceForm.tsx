import { type FormEvent, useState } from "react";
import {
  type AdminMcp,
  api,
  KIND_NAMES,
  type RemoteConfigView,
  RESOURCE_KINDS,
  type ResourceKind,
  type ResourceProbe,
  type SiteConfigView,
} from "../api";
import { ConfirmModal, Drawer, Icon, Modal } from "./ui";

/* Forms shared by the catalogue (creation) and the resource page (edition). */

export interface ResourceDraft {
  kind: ResourceKind;
  slug: string;
  name: string;
  description: string;
  /** Site: content API base URL; remote: MCP endpoint. */
  url: string;
  headerName: RemoteConfigView["headerName"];
  /** Empty on edit = keep the stored secret. */
  token: string;
}

const KIND_HELP: Record<ResourceKind, { title: string; text: string; icon: string }> = {
  site: {
    title: "Site",
    text: "Un site public dont le rack pilote le contenu (pages, actualités, événements) via son API REST.",
    icon: "globe",
  },
  remote: {
    title: "MCP distant",
    text: "Un serveur MCP existant (HTTP streamable). Le rack le relaie avec sa propre clé et vos règles d'accès ; le serveur ne sait pas qui appelle.",
    icon: "cloud",
  },
  partner: {
    title: "MCP partenaire",
    text: "Comme un MCP distant, mais le rack transmet aussi l'identité et le niveau d'accès de l'utilisateur (en-têtes X-Rack-*). Clé obligatoire.",
    icon: "users",
  },
};

export function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function draftConfig(draft: ResourceDraft) {
  return draft.kind === "site"
    ? { apiUrl: draft.url, apiToken: draft.token }
    : { url: draft.url, headerName: draft.headerName, token: draft.token };
}

/** Connection fields shared by the creation modal and the edit drawer. */
export function ConnectionFields({
  draft,
  onChange,
  existingSlug,
  hasStoredToken,
}: {
  draft: ResourceDraft;
  onChange: (patch: Partial<ResourceDraft>) => void;
  /** Set when editing: the probe may reuse the stored secret. */
  existingSlug?: string;
  hasStoredToken?: boolean;
}) {
  const [probe, setProbe] = useState<ResourceProbe | null>(null);
  const [probing, setProbing] = useState(false);

  async function runProbe() {
    setProbing(true);
    setProbe(null);
    try {
      setProbe(
        await api<ResourceProbe>("/api/admin/resources/probe", {
          method: "POST",
          body: JSON.stringify({
            kind: draft.kind,
            ...(existingSlug ? { slug: existingSlug } : {}),
            config: draftConfig(draft),
          }),
        }),
      );
    } catch (e) {
      setProbe({ ok: false, message: (e as Error).message });
    } finally {
      setProbing(false);
    }
  }

  const isSite = draft.kind === "site";
  const isPartner = draft.kind === "partner";
  return (
    <>
      <label className="field">
        {isSite ? "URL de l'API de contenu" : "URL du serveur MCP"}
        <input
          type="url"
          value={draft.url}
          onChange={(e) => onChange({ url: e.target.value })}
          required
          placeholder={
            isSite ? "https://www.exemple.fr/api" : "https://mcp.exemple.com/mcp"
          }
        />
        <span className="hint">
          {isSite
            ? "URL de base de l'API : le rack appelle <base>/content avec le jeton ci-dessous."
            : isPartner
              ? "Transport HTTP streamable. Le rack s'y connecte avec la clé ci-dessous, jamais avec celle de l'utilisateur, et transmet l'identité et le niveau d'accès de l'utilisateur dans des en-têtes X-Rack-*."
              : "Transport HTTP streamable. Le rack s'y connecte avec la clé ci-dessous, jamais avec celle de l'utilisateur."}
        </span>
      </label>
      {!isSite && (
        <label className="field">
          En-tête d'authentification
          <select
            value={draft.headerName}
            onChange={(e) =>
              onChange({ headerName: e.target.value as RemoteConfigView["headerName"] })
            }
          >
            <option value="Authorization">Authorization: Bearer …</option>
            <option value="x-api-key">x-api-key</option>
          </select>
        </label>
      )}
      <label className="field">
        {isSite ? "Jeton d'API" : "Clé ou jeton du serveur distant"}{" "}
        <span className="hint">
          {hasStoredToken
            ? "— un secret est enregistré ; laissez vide pour le conserver"
            : isPartner
              ? "— obligatoire : l'identité n'est transmise qu'avec cette clé ; chiffrée côté rack, jamais affichée"
              : "— facultatif, chiffré côté rack, jamais affiché"}
        </span>
        <input
          type="password"
          value={draft.token}
          onChange={(e) => onChange({ token: e.target.value })}
          autoComplete="new-password"
          required={isPartner && !hasStoredToken}
          placeholder={hasStoredToken ? "••••••••" : ""}
        />
      </label>
      <div className="probe">
        <button
          type="button"
          className="btn ghost small"
          disabled={probing || !draft.url}
          onClick={() => void runProbe()}
        >
          <Icon name="bolt" /> {probing ? "Test en cours…" : "Tester la connexion"}
        </button>
        {probe && (
          <span className={`probe-result ${probe.ok ? "ok" : "bad"}`}>
            {probe.ok ? "✓ " : "✗ "}
            {probe.message}
            {probe.tools && probe.tools.length > 0 && (
              <span className="muted">
                {" "}
                ·{" "}
                {probe.tools
                  .map((t) => t.name)
                  .slice(0, 6)
                  .join(", ")}
                {probe.tools.length > 6 ? "…" : ""}
              </span>
            )}
          </span>
        )}
      </div>
    </>
  );
}

export function NewResourceModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (created: AdminMcp) => void;
}) {
  const [draft, setDraft] = useState<ResourceDraft>({
    kind: "site",
    slug: "",
    name: "",
    description: "",
    url: "",
    headerName: "Authorization",
    token: "",
  });
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (patch: Partial<ResourceDraft>) =>
    setDraft((current) => {
      const next = { ...current, ...patch };
      if (patch.name !== undefined && !slugTouched) next.slug = slugify(patch.name);
      return next;
    });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api<AdminMcp>("/api/admin/resources", {
        method: "POST",
        body: JSON.stringify({
          kind: draft.kind,
          slug: draft.slug,
          name: draft.name,
          description: draft.description,
          config: draftConfig(draft),
        }),
      });
      onCreated(created);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Ajouter une ressource" onClose={onClose}>
      <form className="stack" onSubmit={submit} id="new-resource">
        {error && <div className="alert error">{error}</div>}
        <fieldset className="kind-options">
          {RESOURCE_KINDS.map((kind) => (
            <label
              key={kind}
              className={`kind-option ${draft.kind === kind ? "is-selected" : ""}`}
            >
              <input
                type="radio"
                name="kind"
                value={kind}
                checked={draft.kind === kind}
                onChange={() => update({ kind })}
              />
              <Icon name={KIND_HELP[kind].icon} />
              <span>
                <strong>{KIND_HELP[kind].title}</strong>
                <small>{KIND_HELP[kind].text}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="row" style={{ gap: 14, alignItems: "flex-start" }}>
          <label className="field" style={{ flex: 2 }}>
            Nom
            <input
              type="text"
              value={draft.name}
              onChange={(e) => update({ name: e.target.value })}
              required
              autoFocus
              placeholder={
                draft.kind === "site"
                  ? "Site heyintent.com"
                  : draft.kind === "partner"
                    ? "Matière de Lien"
                    : "MCP GitHub"
              }
            />
          </label>
          <label className="field" style={{ flex: 1.3 }}>
            Slug <span className="hint">(URL /mcp/…)</span>
            <input
              type="text"
              value={draft.slug}
              onChange={(e) => {
                setSlugTouched(true);
                update({ slug: slugify(e.target.value) });
              }}
              required
              pattern="[a-z0-9][a-z0-9-]{1,62}"
              placeholder="site-heyintent"
            />
          </label>
        </div>
        <label className="field">
          Description
          <input
            type="text"
            value={draft.description}
            onChange={(e) => update({ description: e.target.value })}
            placeholder="Ce que les utilisateurs verront dans le catalogue"
          />
        </label>
        <ConnectionFields draft={draft} onChange={update} />
        <p className="tiny muted">
          La ressource est servie immédiatement sur /mcp/{draft.slug || "…"}. Elle reste
          invisible tant qu'aucun groupe n'y est associé.
        </p>
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>
            Annuler
          </button>
          <button
            className="btn accent"
            disabled={
              busy ||
              !draft.name.trim() ||
              !draft.slug ||
              !draft.url ||
              (draft.kind === "partner" && !draft.token)
            }
          >
            Ajouter
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ResourceDrawer({
  mcp,
  onClose,
  onChanged,
  onDeleted,
}: {
  mcp: AdminMcp;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const kind = mcp.kind as ResourceKind;
  const config = mcp.config;
  const [draft, setDraft] = useState<ResourceDraft>(() => ({
    kind,
    slug: mcp.slug,
    name: mcp.name,
    description: mcp.description,
    url:
      kind === "site"
        ? ((config as SiteConfigView | null)?.apiUrl ?? "")
        : ((config as RemoteConfigView | null)?.url ?? ""),
    headerName: (config as RemoteConfigView | null)?.headerName ?? "Authorization",
    token: "",
  }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const update = (patch: Partial<ResourceDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/mcps/${mcp.slug}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: draft.name,
          description: draft.description,
          config: draftConfig(draft),
        }),
      });
      onChanged();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={mcp.name}
      subtitle={`${KIND_NAMES[mcp.kind]} · /mcp/${mcp.slug}`}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="btn danger small"
            onClick={() => setDeleting(true)}
          >
            <Icon name="trash" /> Supprimer
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn ghost" onClick={onClose}>
            Annuler
          </button>
          <button
            className="btn accent"
            form="edit-resource"
            disabled={busy || !draft.name.trim() || !draft.url}
          >
            Enregistrer
          </button>
        </>
      }
    >
      {deleting && (
        <ConfirmModal
          title="Supprimer la ressource"
          confirmLabel="Supprimer"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            try {
              await api(`/api/admin/mcps/${mcp.slug}`, { method: "DELETE" });
              setDeleting(false);
              onDeleted();
            } catch (e) {
              setError((e as Error).message);
              setDeleting(false);
            }
          }}
        >
          Supprimer <strong>{mcp.name}</strong> ? Les groupes, droits individuels et
          journaux associés sont effacés ; les clients connectés sur /mcp/{mcp.slug}{" "}
          perdent l'accès immédiatement.
        </ConfirmModal>
      )}
      <form className="stack" onSubmit={save} id="edit-resource">
        {error && <div className="alert error">{error}</div>}
        {mcp.loadError && (
          <div className="alert error small">
            Dernier chargement en erreur : {mcp.loadError}
          </div>
        )}
        <label className="field">
          Nom
          <input
            type="text"
            value={draft.name}
            onChange={(e) => update({ name: e.target.value })}
            required
          />
        </label>
        <label className="field">
          Description
          <input
            type="text"
            value={draft.description}
            onChange={(e) => update({ description: e.target.value })}
          />
        </label>
        <ConnectionFields
          draft={draft}
          onChange={update}
          existingSlug={mcp.slug}
          hasStoredToken={config?.hasToken ?? false}
        />
      </form>
    </Drawer>
  );
}
