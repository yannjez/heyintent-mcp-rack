import { useOutletContext } from "react-router";
import type { Me } from "../api";
import { ConsumersPage } from "./Consumers";
import { ProductsPage } from "./Products";

export function HomePage() {
  const me = useOutletContext<Me>();
  return (
    <>
      <div className="hero">
        <h1>Bonjour {me.name?.split(" ")[0] || me.email.split("@")[0]}</h1>
        <p>Vos produits et les agents que vous y avez connectés.</p>
        <div className="row">
          <a className="btn" href="#mes-produits">
            Mes produits
          </a>
          <a className="btn" href="#mes-consommateurs">
            Mes consommateurs
          </a>
        </div>
      </div>
      <div id="mes-produits">
        <ProductsPage />
      </div>
      <div id="mes-consommateurs">
        <ConsumersPage />
      </div>
    </>
  );
}
