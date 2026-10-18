import { useOutletContext } from "react-router";
import type { Me } from "../api";
import { ApplicationsPage } from "./Applications";
import { McpsPage } from "./Mcps";

export function HomePage() {
  const me = useOutletContext<Me>();
  return (
    <>
      <div className="hero">
        <h1>Bonjour {me.name?.split(" ")[0] || me.email.split("@")[0]}</h1>
        <p>Vos applications et vos ressources, réunies dans votre espace personnel.</p>
        <div className="row">
          <a className="btn" href="#mes-applications">
            Mes applications
          </a>
          <a className="btn" href="#mes-ressources">
            Mes ressources
          </a>
        </div>
      </div>
      <div id="mes-applications">
        <ApplicationsPage />
      </div>
      <section
        id="mes-ressources"
        className="personal-section"
        aria-label="Mes ressources"
      >
        <McpsPage me={me} showWelcome={false} />
      </section>
    </>
  );
}
