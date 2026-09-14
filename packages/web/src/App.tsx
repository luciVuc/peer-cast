import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
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

export default function App() {
  return (
    <>
      <Toasts />
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<LandingPage />} />
          <Route path="login" element={<LoginPage />} />
          <Route path="register" element={<RegisterPage />} />
          <Route path="verify-email" element={<VerifyEmailPage />} />
          <Route
            path="verify-email-change"
            element={<VerifyEmailChangePage />}
          />
          <Route path="forgot-password" element={<ForgotPasswordPage />} />
          <Route path="reset-password" element={<ResetPasswordPage />} />
          <Route path="watch/:username" element={<ViewerPage />} />

          <Route element={<ProtectedRoute />}>
            <Route path="dashboard" element={<DashboardPage />} />
            <Route path="broadcast" element={<BroadcastPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>

          <Route element={<AdminRoute />}>
            <Route path="admin" element={<AdminPage />} />
          </Route>

          <Route path="404" element={<NotFoundPage />} />
          <Route path="*" element={<Navigate to="/404" replace />} />
        </Route>
      </Routes>
    </>
  );
}
