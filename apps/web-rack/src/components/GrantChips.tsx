import { ACCESS_LABELS, type Grants } from "../api";

export function GrantChips({
  grants,
  names,
}: {
  grants: Grants;
  names?: Record<string, string>;
}) {
  if (grants.mcps === "*") {
    return <span className="badge off plain">Toutes mes ressources (niveau affecté)</span>;
  }
  return (
    <div className="chips">
      {Object.entries(grants.mcps).map(([slug, access]) => (
        <span className={`badge ${access}`} key={slug} title={ACCESS_LABELS[access]}>
          {names?.[slug] ?? slug} · {access === "write" ? "écriture" : "lecture"}
        </span>
      ))}
    </div>
  );
}
