import { Navigate, Outlet } from "react-router-dom";
import type { RouteObject } from "react-router-dom";
import { Layout } from "./components/Layout";
import { RouteErrorPage } from "./components/RouteErrorPage";
import { Toasts } from "./components/Toasts";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { AdminRoute } from "./components/AdminRoute";
import { LandingPage } from "./pages/LandingPage";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { DashboardPage } from "./pages/DashboardPage";
import { BroadcastPage } from "./pages/BroadcastPage";
import { ViewerPage } from "./pages/ViewerPage";
import { SettingsPage } from "./pages/SettingsPage";
import { AdminPage } from "./pages/AdminPage";
import { VerifyEmailPage } from "./pages/VerifyEmailPage";
import { VerifyEmailChangePage } from "./pages/VerifyEmailChangePage";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { UserProfilePage } from "./pages/UserProfilePage";
import { EmbedPage } from "./pages/EmbedPage";

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
      { path: "embed/:username", element: <EmbedPage /> },

      {
        element: <Layout />,
        children: [
          { index: true, element: <LandingPage /> },
          { path: "login", element: <LoginPage /> },
          { path: "register", element: <RegisterPage /> },
          { path: "verify-email", element: <VerifyEmailPage /> },
          {
            path: "verify-email-change",
            element: <VerifyEmailChangePage />,
          },
          { path: "forgot-password", element: <ForgotPasswordPage /> },
          { path: "reset-password", element: <ResetPasswordPage /> },
          { path: "watch/:username", element: <ViewerPage /> },
          { path: "user/:username", element: <UserProfilePage /> },

          {
            element: <ProtectedRoute />,
            children: [
              { path: "dashboard", element: <DashboardPage /> },
              { path: "broadcast", element: <BroadcastPage /> },
              { path: "settings", element: <SettingsPage /> },
            ],
          },

          {
            element: <AdminRoute />,
            children: [{ path: "admin", element: <AdminPage /> }],
          },

          { path: "404", element: <NotFoundPage /> },
          { path: "*", element: <Navigate to="/404" replace /> },
        ],
      },
    ],
  },
];
