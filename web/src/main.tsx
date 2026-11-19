import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import "@fontsource-variable/inter";
import "./styles.css";
import { AuthProvider, useAuth } from "./auth.tsx";
import { LibraryProvider } from "./library.tsx";
import { ConfirmHost, ThemeProvider, Toaster } from "./components/ui.tsx";
import { Layout } from "./components/Layout.tsx";
import { AuthPage, UnlockScreen } from "./pages/AuthPage.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Machines } from "./pages/Machines.tsx";
import { Admin } from "./pages/Admin.tsx";
import { Account } from "./pages/Account.tsx";
import { Landing } from "./landing/Landing.tsx";

const BoardPage = lazy(() => import("./pages/BoardPage.tsx"));

function RequireAuth() {
  const { user, keys } = useAuth();
  const location = useLocation();
  if (user === undefined) return null;
  // Visitors land on the presentation page; deep links still go through the login.
  if (!user) return location.pathname === "/" ? <Landing /> : <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (!keys) return <UnlockScreen user={user} />;
  return (
    <LibraryProvider>
      <Outlet />
    </LibraryProvider>
  );
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route path="/recover" element={<AuthPage mode="recover" />} />
      <Route element={<RequireAuth />}>
        <Route
          path="/board/:id"
          element={
            <Suspense fallback={<div className="board-overlay">Chargement de l'éditeur…</div>}>
              <BoardPage />
            </Suspense>
          }
        />
        <Route element={<Layout />}>
          <Route index element={<Dashboard view="mine" />} />
          <Route path="/folder/:folderId" element={<Dashboard view="folder" />} />
          <Route path="/shared" element={<Dashboard view="shared" />} />
          <Route path="/trash" element={<Dashboard view="trash" />} />
          <Route path="/machines" element={<Machines />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/account" element={<Account />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
        <Toaster />
        <ConfirmHost />
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>,
);
