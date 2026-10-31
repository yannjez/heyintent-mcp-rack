import { type FormEvent, useState } from "react";
import { useLocation } from "react-router";
import { authClient } from "../auth-client";
import { Icon } from "../components/ui";
import {
  authErrorMessage,
  isInvalidOAuthQuery,
  oauthRequestExpired,
  restartOAuthPath,
} from "../oauth-recovery";
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
  const [invalidOAuth, setInvalidOAuth] = useState(() =>
    oauthRequestExpired(location.search),
  );
  const restartPath = restartOAuthPath(location.search);
  const canContinue = !inOAuthFlow || !invalidOAuth;

  async function sendCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: "sign-in",
      });
      if (result.error) {
        if (isInvalidOAuthQuery(result.error)) setInvalidOAuth(true);
        setError(
          authErrorMessage(
            result.error,
            "Impossible d’envoyer le code. Réessayez dans un instant.",
          ),
        );
        return;
      }
      setStep("otp");
    } catch (e) {
      setError(
        authErrorMessage(
          e,
          "Impossible de joindre le serveur. Réessayez dans un instant.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.signIn.emailOtp({ email, otp });
      if (result.error) {
        if (isInvalidOAuthQuery(result.error)) setInvalidOAuth(true);
        setError(authErrorMessage(result.error, "Code invalide."));
        return;
      }
      const next = (result.data as { redirect?: boolean; url?: string } | null) ?? {};
      if (inOAuthFlow && next.redirect && next.url) {
        const target = new URL(next.url, window.location.origin);
        if (target.origin === window.location.origin && target.pathname === "/login") {
          setInvalidOAuth(true);
          setError(
            "La connexion n’a pas pu aboutir. Reprenez la demande depuis l’application.",
          );
          return;
        }
        const scopes = new URLSearchParams(location.search).get("scope") ?? "";
        if (scopes.split(/\s+/).some((scope) => scope.startsWith("mcp:")))
          await finishOAuth(next.url, oauthClientId);
        else window.location.href = target.toString();
        return;
      }
      if (inOAuthFlow) {
        setInvalidOAuth(true);
        setError(
          "Impossible de poursuivre la connexion à l’application. Reprenez la demande.",
        );
        return;
      }
      const from = (location.state as { from?: string } | null)?.from;
      const target = new URL(
        typeof from === "string" ? from : "/",
        window.location.origin,
      );
      window.location.href =
        target.origin === window.location.origin ? target.toString() : "/";
    } catch (e) {
      setError(
        authErrorMessage(
          e,
          "Impossible de joindre le serveur. Réessayez dans un instant.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <section className="auth-brand">
        <a
          className="brand"
          href="https://heyintent.com"
          target="_blank"
          rel="noreferrer"
        >
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
        <div className="foot">
          © Intent · Des agents IA qui transforment votre entreprise
        </div>
      </section>

      <section className="auth-form">
        <div className="card pad stack">
          <div>
            <h1 style={{ fontSize: 24 }}>Connexion</h1>
            <p className="muted" style={{ marginTop: 6 }}>
              {inOAuthFlow
                ? "Une application demande à vous connecter avec votre compte Rack."
                : "Recevez un code à usage unique par email."}
            </p>
          </div>
          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
          {invalidOAuth && restartPath && (
            <div className="stack tight">
              {!error && (
                <div className="alert error" role="alert">
                  La demande de connexion a expiré ou n’est plus valide.
                </div>
              )}
              <a className="btn accent" href={restartPath}>
                Reprendre la connexion
              </a>
              <a className="btn ghost" href="/login">
                Se connecter à Rack uniquement
              </a>
            </div>
          )}
          {canContinue &&
            (step === "email" ? (
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
                <p className="tiny muted">Toutes les adresses email sont acceptées.</p>
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
                    onChange={(e) =>
                      setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
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
            ))}
        </div>
      </section>
    </div>
  );
}
