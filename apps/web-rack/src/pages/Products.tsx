import { useEffect, useState } from "react";
import { api, type UserApplication, type UserMcp } from "../api";
import { AccessBadge, Empty, Icon, McpIcon, PageHead } from "../components/ui";
import { ConnectModal } from "./Mcps";

/** A product as this page shows it: one thing, with up to two ways in. */
type Product = {
  key: string;
  name: string;
  description: string;
  /** Where "Ouvrir l'application" goes; null when the product has no UI. */
  url: string | null;
  /** MCP channels this account may reach. */
  channels: UserMcp[];
};

/**
 * « Mes produits » — one card per product, with the two ways in side by side:
 * open the interface, or add the MCP to an agent.
 *
 * The two faces keep their own access rules, so a product may well show an
 * interface and no MCP, or the reverse; each side was filtered for this
 * account before it got here. Resources attached to no application are
 * products in their own right, with no interface to open.
 */
export function ProductsPage() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<UserMcp | null>(null);

  useEffect(() => {
    Promise.all([
      api<UserApplication[]>("/api/applications"),
      api<UserMcp[]>("/api/mcps"),
    ])
      .then(([applications, mcps]) => {
        const owned = new Set(
          applications.flatMap((a) => a.resources.map((r) => r.slug)),
        );
        setProducts([
          ...applications.map((application) => ({
            key: application.clientId,
            name: application.name || application.clientId,
            description:
              application.resources[0]?.description ??
              "Connectez-vous à cette application avec votre compte Rack.",
            url: application.url,
            channels: application.resources,
          })),
          ...mcps
            .filter((mcp) => !owned.has(mcp.slug))
            .map((mcp) => ({
              key: mcp.slug,
              name: mcp.name,
              description: mcp.description,
              url: mcp.appUrl,
              channels: [mcp],
            })),
        ]);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <section className="personal-section" aria-label="Mes produits">
      <PageHead
        title="Mes produits"
        lead="Ouvrez l'interface, ou ajoutez le MCP à votre agent."
      />
      {error && <div className="alert error">{error}</div>}
      {!products && !error && <p className="muted">Chargement des produits…</p>}
      {products?.length === 0 && (
        <div className="card">
          <Empty icon="grid" title="Aucun produit disponible">
            Demandez à un administrateur de vous donner accès aux produits dont vous avez
            besoin.
          </Empty>
        </div>
      )}
      <div className="grid">
        {products?.map((product) => (
          <ProductCard key={product.key} product={product} onConnect={setConnecting} />
        ))}
      </div>
      {connecting && (
        <ConnectModal mcp={connecting} onClose={() => setConnecting(null)} />
      )}
    </section>
  );
}

function ProductCard({
  product,
  onConnect,
}: {
  product: Product;
  onConnect: (mcp: UserMcp) => void;
}) {
  const single = product.channels.length === 1 ? product.channels[0] : undefined;
  return (
    <article className="card product-card">
      <div className="card-body">
        <div className="mcp-title">
          {single ? (
            <McpIcon slug={single.slug} kind={single.kind} />
          ) : (
            <div className="mcp-icon">
              <Icon name="grid" />
            </div>
          )}
          <div className="names">
            <h3>{product.name}</h3>
            <div className="category">
              {[
                product.url ? "Interface web" : null,
                product.channels.length > 0
                  ? `${product.channels.length} MCP`
                  : "sans MCP",
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
          {single && <AccessBadge access={single.access} />}
        </div>
        <p className="mcp-desc">{product.description}</p>
        {product.channels.map((channel) => (
          <ChannelTools
            key={channel.slug}
            channel={channel}
            labelled={product.channels.length > 1}
          />
        ))}
      </div>
      <div className="card-foot product-actions">
        {product.url && (
          <a
            className="btn accent"
            href={product.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Ouvrir l'application <Icon name="arrow-right" />
          </a>
        )}
        {product.channels.map((channel) => (
          <button key={channel.slug} className="btn" onClick={() => onConnect(channel)}>
            <Icon name="plug" />{" "}
            {product.channels.length > 1 ? `Ajouter ${channel.name}` : "Ajouter le MCP"}
          </button>
        ))}
      </div>
    </article>
  );
}

/** The tools of one channel, folded: the list is detail, not the headline. */
function ChannelTools({ channel, labelled }: { channel: UserMcp; labelled: boolean }) {
  const reads = channel.tools.filter((t) => !t.write);
  const writes = channel.tools.filter((t) => t.write);
  const visible = channel.access === "write" ? channel.tools : reads;
  return (
    <details className="tools">
      <summary>
        {labelled ? `${channel.name} · ` : ""}
        {visible.length} outil{visible.length > 1 ? "s" : ""}
        <span className="faint" style={{ fontWeight: 500 }}>
          · {reads.length} lecture
          {channel.access === "write"
            ? ` · ${writes.length} écriture`
            : writes.length > 0
              ? ` · ${writes.length} écriture masqué${writes.length > 1 ? "s" : ""}`
              : ""}
        </span>
      </summary>
      <ul className="tool-list">
        {visible.map((tool) => (
          <li key={tool.name}>
            <span className={`name ${tool.write ? "write" : ""}`}>{tool.name}</span>
            <span className="desc">{tool.description}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
