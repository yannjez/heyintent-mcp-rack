import { type FormEvent, useState } from "react";
import { useLocation } from "react-router";
import { authClient } from "../auth-client";
import { Icon } from "../components/ui";
import { finishOAuth } from "../oauth";

type Step = "email" | "otp";

export function LoginPage() {
  const location = useLocation();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const oauthClientId = new URLSearchParams(location.search).get("client_id");
  const inOAuthFlow = oauthClientId !== null;

  async function sendCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "sign-in",
    });
    setBusy(false);
    if (error) return setError(error.message ?? "Impossible d'envoyer le code.");
    setStep("otp");
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error } = await authClient.signIn.emailOtp({ email, otp });
    if (error) {
      setBusy(false);
      return setError(error.message ?? "Code invalide.");
    }
    // In an OAuth flow the oauthProviderClient plugin attached the signed
    // query, so the server resumes the authorization and answers with the next
    // hop (consent page or client callback).
    const next = (data as { redirect?: boolean; url?: string } | null) ?? {};
    if (inOAuthFlow && next.redirect && next.url) {
      // Either the consent page, or straight to the client when consent was
      // already given: finishOAuth only intercepts loopback callbacks.
      await finishOAuth(next.url, oauthClientId);
      return;
    }
    if (inOAuthFlow) {
      setBusy(false);
      return setError("Impossible de poursuivre l'autorisation du client MCP.");
    }
    window.location.href = "/";
  }

  return (
    <div className="auth">
      <section className="auth-brand">
        <a className="brand" href="https://heyintent.com" target="_blank" rel="noreferrer">
          <img src="/intent-logo.svg" alt="Intent" className="brand-logo" />
          <span className="brand-sep" />
          <span className="brand-text">
            <strong>Ressource Rack</strong>
            <small>Intent · Agents IA</small>
          </span>
        </a>
        <div>
          <h1>
            Vos ressources, <em>accessibles à vos agents IA</em>.
          </h1>
          <p>
            Un point d'entrée unique pour connecter Claude, Codex, Cursor et vos
            assistants aux ressources de l'entreprise, avec des accès nominatifs en
            lecture ou en écriture.
          </p>
          <ul>
            <li>
              <span className="dot">
                <Icon name="globe" />
              </span>
              Site public — pages, actualités, événements
            </li>
            <li>
              <span className="dot">
                <Icon name="flask" />
              </span>
              Sample — MCP de référence (LLM, image, GitHub, mémoire)
            </li>
            <li>
              <span className="dot">
                <Icon name="key" />
              </span>
              OAuth 2.1 ou clé API, droits par utilisateur et par groupe
            </li>
          </ul>
        </div>
        <div className="foot">© Intent · Des agents IA qui transforment votre entreprise</div>
      </section>

      <section className="auth-form">
        <div className="card pad stack">
          <div>
            <h1 style={{ fontSize: 24 }}>Connexion</h1>
            <p className="muted" style={{ marginTop: 6 }}>
              {inOAuthFlow
                ? "Un client MCP demande l'accès à votre compte. Connectez-vous pour continuer."
                : "Recevez un code à usage unique par email."}
            </p>
          </div>
          {error && <div className="alert error">{error}</div>}
          {step === "email" ? (
            <form className="stack" onSubmit={sendCode}>
              <label className="field">
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="prenom@heyintent.com"
                  required
                  autoFocus
                />
              </label>
              <button className="btn accent" disabled={busy}>
                Recevoir un code
              </button>
              <p className="tiny muted">
                Comptes Intent, ou comptes externes et clients créés par un administrateur.
              </p>
            </form>
          ) : (
            <form className="stack" onSubmit={verify}>
              <div className="alert info">
                Code envoyé à <strong>&nbsp;{email}</strong>
              </div>
              <label className="field">
                Code à 6 chiffres
                <input
                  type="text"
                  className="otp"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  required
                  autoFocus
                />
              </label>
              <button className="btn accent" disabled={busy || otp.length !== 6}>
                Se connecter
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setStep("email")}
              >
                Changer d'email
              </button>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
