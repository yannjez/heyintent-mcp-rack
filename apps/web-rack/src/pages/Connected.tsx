import { useLocation } from "react-router";
import { Icon } from "../components/ui";
import { useClientName } from "../oauth";

export function ConnectedPage() {
  const params = new URLSearchParams(useLocation().search);
  const client = useClientName(params.get("client"));
  return (
    <div className="center">
      <div className="card done">
        <div className="done-mark">
          <Icon name="check" size={28} />
        </div>
        <h1>Connexion établie</h1>
        <p className="muted">
          <strong>{client}</strong> est maintenant autorisé à utiliser vos ressources avec
          le niveau d'accès que vous venez de confirmer.
        </p>
        <p className="muted small">
          Vous pouvez fermer cette fenêtre et retourner dans {client}. Les accès accordés
          se gèrent depuis « Mes ressources ».
        </p>
        <div className="row" style={{ justifyContent: "center" }}>
          <a className="btn ghost" href="/">
            Ouvrir Mes ressources
          </a>
          <button className="btn" onClick={() => window.close()}>
            Fermer la fenêtre
          </button>
        </div>
        <img src="/intent-logo.svg" alt="Intent" className="done-logo" />
      </div>
    </div>
  );
}
