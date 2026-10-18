import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useLocation,
  useOutletContext,
} from "react-router";
import { api, ApiError, type Me } from "./api";
import { Layout } from "./components/Layout";
import { HomePage } from "./pages/Home";
import { ApplicationsPage } from "./pages/Applications";
import { AdminCataloguePage } from "./pages/admin/Catalogue";
import { AdminApplicationsPage } from "./pages/admin/Applications";
import { AdminGroupsPage } from "./pages/admin/Groups";
import { AdminLogsPage } from "./pages/admin/Logs";
import { AdminMcpsPage } from "./pages/admin/Mcps";
import { AdminUsersPage } from "./pages/admin/Users";
import { ConnectedPage } from "./pages/Connected";
import { ConsentPage } from "./pages/Consent";
import { KeysPage } from "./pages/Keys";
import { LoginPage } from "./pages/Login";
import { McpsPage } from "./pages/Mcps";
import "./styles.css";

/** Loads the session and gates the portal; redirects to /login when signed out. */
function Protected({ admin = false, bare = false }: { admin?: boolean; bare?: boolean }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const location = useLocation();

  useEffect(() => {
    api<Me>("/api/me")
      .then(setMe)
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) setMe(null);
        else setMe(null);
      });
  }, []);

  if (me === undefined) return <div className="loader">Chargement…</div>;
  if (me === null)
    return (
      <Navigate
        to={location.pathname === "/consent" ? `/login${location.search}` : "/login"}
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  if (admin && !me.isAdmin) return <Navigate to="/" replace />;
  return bare ? <Outlet context={me} /> : <Layout me={me} />;
}

function Resources() {
  const me = useOutletContext<Me>();
  return <McpsPage me={me} />;
}

function Users() {
  const me = useOutletContext<Me>();
  return <AdminUsersPage meId={me.id} />;
}

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/connected", element: <ConnectedPage /> },
  {
    element: <Protected bare />,
    children: [{ path: "/consent", element: <ConsentPage /> }],
  },
  {
    element: <Protected />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/applications", element: <ApplicationsPage /> },
      { path: "/ressources", element: <Resources /> },
      { path: "/keys", element: <KeysPage /> },
    ],
  },
  {
    element: <Protected admin />,
    children: [
      { path: "/admin/catalogue", element: <AdminCataloguePage /> },
      {
        path: "/admin/catalogue/applications/:clientId",
        element: <AdminApplicationsPage />,
      },
      { path: "/admin/catalogue/ressources/:slug", element: <AdminMcpsPage /> },
      {
        path: "/admin/applications",
        element: <Navigate to="/admin/catalogue" replace />,
      },
      { path: "/admin/users", element: <Users /> },
      { path: "/admin/users/:userId", element: <Users /> },
      { path: "/admin/groups", element: <AdminGroupsPage /> },
      { path: "/admin/groups/:groupId", element: <AdminGroupsPage /> },
      { path: "/admin/ressources", element: <Navigate to="/admin/catalogue" replace /> },
      { path: "/admin/mcps", element: <Navigate to="/admin/catalogue" replace /> },
      { path: "/admin/logs", element: <AdminLogsPage /> },
      { path: "/admin/keys", element: <Navigate to="/admin/users" replace /> },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
