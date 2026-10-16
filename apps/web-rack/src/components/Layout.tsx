import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { authClient } from "../auth-client";
import type { Me } from "../api";
import { Icon } from "./ui";

function initials(me: Me) {
  const source = me.name?.trim() || me.email;
  return source
    .split(/[\s.@_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("");
}

export function Layout({ me }: { me: Me }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  async function logout() {
    await authClient.signOut();
    navigate("/login");
  }

  const link = (to: string, icon: string, label: string, end = false) => (
    <NavLink to={to} end={end} className="nav-link" onClick={() => setOpen(false)}>
      <Icon name={icon} />
      {label}
    </NavLink>
  );

  return (
    <div className="shell">
      <header className="topbar">
        <button className="icon-btn" onClick={() => setOpen((o) => !o)} aria-label="Menu">
          <Icon name={open ? "close" : "menu"} />
        </button>
        <strong>Ressource Rack</strong>
        <span className="small" style={{ opacity: 0.6 }}>
          {location.pathname.startsWith("/admin") ? "Administration" : "Mon espace"}
        </span>
      </header>

      <aside className={`sidebar ${open ? "open" : ""}`}>
        <NavLink to="/" className="brand" onClick={() => setOpen(false)}>
          <img src="/intent-logo.svg" alt="Intent" className="brand-logo" />
          <span className="brand-sep" />
          <span className="brand-text">
            <strong>Ressource Rack</strong>
            <small>Intent · Agents IA</small>
          </span>
        </NavLink>

        <nav className="nav-group">
          <div className="nav-group-label">Mon espace</div>
          {link("/", "grid", "Mes ressources", true)}
          {link("/keys", "key", "Mes clés API")}
        </nav>

        {me.isAdmin && (
          <nav className="nav-group">
            <div className="nav-group-label">Administration</div>
            {link("/admin/users", "users", "Utilisateurs")}
            {link("/admin/groups", "group", "Groupes")}
            {link("/admin/ressources", "server", "Ressources")}
            {link("/admin/logs", "logs", "Logs")}
          </nav>
        )}

        <div className="sidebar-footer">
          <div className="user-card">
            <div className="avatar">{initials(me)}</div>
            <div className="who">
              <strong>{me.name || me.email}</strong>
              <span>{me.isAdmin ? "Administrateur" : me.email}</span>
            </div>
            <button
              className="icon-btn"
              onClick={logout}
              title="Déconnexion"
              aria-label="Déconnexion"
            >
              <Icon name="logout" />
            </button>
          </div>
        </div>
      </aside>

      <main className="content">
        <div className="page">
          <Outlet context={me} />
        </div>
      </main>
    </div>
  );
}
