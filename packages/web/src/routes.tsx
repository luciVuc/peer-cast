import { Suspense, lazy } from "react";
import { Navigate, Outlet } from "react-router-dom";
import type { RouteObject } from "react-router-dom";
import { Layout } from "./components/Layout";
import { RouteErrorPage } from "./components/RouteErrorPage";
import { Toasts } from "./components/Toasts";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { AdminRoute } from "./components/AdminRoute";
import { Spinner } from "./components/Spinner";
import { LandingPage } from "./pages/LandingPage";
import { LoginPage } from "./pages/LoginPage";

// Everything below the landing/auth shell is split out. These routes were
// statically imported, so an anonymous first-time visitor — the overwhelmingly
// common case for a self-hosted instance — downloaded the whole admin console
// (six tabs, three chart series, every admin mutation), the broadcast page, and
// the settings page before rendering anything. None of it can run for them.
const DashboardPage = lazy(() =>
  import("./pages/DashboardPage").then((m) => ({ default: m.DashboardPage })),
);
const BroadcastPage = lazy(() =>
  import("./pages/BroadcastPage").then((m) => ({ default: m.BroadcastPage })),
);
const ViewerPage = lazy(() =>
  import("./pages/ViewerPage").then((m) => ({ default: m.ViewerPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
const AdminPage = lazy(() =>
  import("./pages/AdminPage").then((m) => ({ default: m.AdminPage })),
);
const VerifyEmailPage = lazy(() =>
  import("./pages/VerifyEmailPage").then((m) => ({
    default: m.VerifyEmailPage,
  })),
);
const VerifyEmailChangePage = lazy(() =>
  import("./pages/VerifyEmailChangePage").then((m) => ({
    default: m.VerifyEmailChangePage,
  })),
);
const ForgotPasswordPage = lazy(() =>
  import("./pages/ForgotPasswordPage").then((m) => ({
    default: m.ForgotPasswordPage,
  })),
);
const ResetPasswordPage = lazy(() =>
  import("./pages/ResetPasswordPage").then((m) => ({
    default: m.ResetPasswordPage,
  })),
);
const NotFoundPage = lazy(() =>
  import("./pages/NotFoundPage").then((m) => ({ default: m.NotFoundPage })),
);
const UserProfilePage = lazy(() =>
  import("./pages/UserProfilePage").then((m) => ({
    default: m.UserProfilePage,
  })),
);
const EmbedPage = lazy(() =>
  import("./pages/EmbedPage").then((m) => ({ default: m.EmbedPage })),
);
const RegisterPage = lazy(() =>
  import("./pages/RegisterPage").then((m) => ({ default: m.RegisterPage })),
);

/** Suspense boundary for lazily-loaded routes (see above). */
function Lazy({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<Spinner label="Loading…" />}>{children}</Suspense>
  );
}

/**
 * Root shell. Renders the global toast tray above the routed outlet so it
 * stays mounted across route changes (it used to sit beside <Routes>).
 */
function AppShell() {
  return (
    <>
      <Toasts />
      <Outlet />
    </>
  );
}

/**
 * Application route configuration, as data-router route objects.
 *
 * Data mode (createBrowserRouter + RouterProvider, wired up in App.tsx) is
 * required for the navigation-blocking hooks — `useBlocker` / `usePrompt` are
 * only available in framework + data mode and throw "useBlocker must be used
 * within a data router" under a declarative <BrowserRouter>. SettingsPage
 * blocks navigation while there are unsaved changes, so this is what makes
 * /settings work.
 *
 * It also buys a built-in error boundary: an `errorElement` catches render
 * errors per route instead of unmounting the whole app to a blank page.
 */
export const routes: RouteObject[] = [
  {
    path: "/",
    element: <AppShell />,
    errorElement: <RouteErrorPage />,
    children: [
      // Embed route: no Layout, no auth wall, renders full-height in iframes
      {
        path: "embed/:username",
        element: (
          <Lazy>
            <EmbedPage />
          </Lazy>
        ),
      },

      {
        element: <Layout />,
        children: [
          { index: true, element: <LandingPage /> },
          { path: "login", element: <LoginPage /> },
          { path: "register", element: <RegisterPage /> },
          {
            path: "verify-email",
            element: (
              <Lazy>
                <VerifyEmailPage />
              </Lazy>
            ),
          },
          {
            path: "verify-email-change",
            element: <VerifyEmailChangePage />,
          },
          {
            path: "forgot-password",
            element: (
              <Lazy>
                <ForgotPasswordPage />
              </Lazy>
            ),
          },
          {
            path: "reset-password",
            element: (
              <Lazy>
                <ResetPasswordPage />
              </Lazy>
            ),
          },
          {
            path: "watch/:username",
            element: (
              <Lazy>
                <ViewerPage />
              </Lazy>
            ),
          },
          {
            path: "user/:username",
            element: (
              <Lazy>
                <UserProfilePage />
              </Lazy>
            ),
          },

          {
            element: <ProtectedRoute />,
            children: [
              {
                path: "dashboard",
                element: (
                  <Lazy>
                    <DashboardPage />
                  </Lazy>
                ),
              },
              {
                path: "broadcast",
                element: (
                  <Lazy>
                    <BroadcastPage />
                  </Lazy>
                ),
              },
              {
                path: "settings",
                element: (
                  <Lazy>
                    <SettingsPage />
                  </Lazy>
                ),
              },
            ],
          },

          {
            element: <AdminRoute />,
            children: [
              {
                path: "admin",
                element: (
                  <Lazy>
                    <AdminPage />
                  </Lazy>
                ),
              },
            ],
          },

          {
            path: "404",
            element: (
              <Lazy>
                <NotFoundPage />
              </Lazy>
            ),
          },
          { path: "*", element: <Navigate to="/404" replace /> },
        ],
      },
    ],
  },
];
