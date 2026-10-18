import { useEffect, useState } from "react";
import { api, type UserApplication } from "../api";
import { Empty, Icon, PageHead } from "../components/ui";

export function ApplicationsPage() {
  const [applications, setApplications] = useState<UserApplication[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<UserApplication[]>("/api/applications")
      .then(setApplications)
      .catch((e: Error) => setError(e.message));
  }, []);
  return (
    <section className="personal-section" aria-label="Mes applications">
      <PageHead
        title="Mes applications"
        lead="Retrouvez les applications auxquelles vous avez accès avec votre compte Rack."
      />
      {error && <div className="alert error">{error}</div>}
      {!applications && !error && <p className="muted">Chargement des applications…</p>}
      {applications?.length === 0 && (
        <div className="card">
          <Empty icon="grid" title="Aucune application disponible">
            Demandez à un administrateur de vous donner accès aux applications dont vous
            avez besoin.
          </Empty>
        </div>
      )}
      <div className="grid">
        {applications?.map((application) => (
          <article className="card catalogue-card" key={application.clientId}>
            <div className="card-body stack">
              <div className="mcp-icon">
                <Icon name="grid" />
              </div>
              <h3>{application.name || application.clientId}</h3>
              <p className="small muted catalogue-description">
                {application.url
                  ? new URL(application.url).hostname
                  : "Connectez-vous depuis cette application avec votre compte Rack."}
              </p>
            </div>
            <div className="card-foot">
              {application.url ? (
                <a
                  className="btn small"
                  href={application.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Ouvrir l'application <Icon name="arrow-right" />
                </a>
              ) : (
                <span className="small muted">Disponible depuis son client</span>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
