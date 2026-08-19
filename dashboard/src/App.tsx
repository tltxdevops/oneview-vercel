import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import type { ComponentType, LazyExoticComponent } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Index from "./pages/Index";
import Login from "./pages/Login";
import NotFound from "./pages/NotFound";
import AlertsPage from "@/pages/Alerts";
import HistoricoPage from "@/pages/Historico";
import MonitoringPage from "@/pages/Monitoring";
import ChamadosPage from "@/pages/Chamados";
import SettingsPage from "@/pages/Settings";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import SsoCallback from "@/pages/SsoCallback";
import { getBrowserRouterBase } from "@/lib/basePath";

const queryClient = new QueryClient();

/**
 * OV-P0-141B — páginas sem fonte real permanecem apenas no servidor local.
 * `import.meta.env.DEV` é substituído em build; os imports mock não entram em
 * bundles Production/Preview nem suas rotas são registradas.
 */
const BancoDadosPage = import.meta.env.DEV ? lazy(() => import("@/pages/BancoDados")) : null;
const CertificadosPage = import.meta.env.DEV ? lazy(() => import("@/pages/Certificados")) : null;
const WorkspacesPage = import.meta.env.DEV ? lazy(() => import("@/pages/Workspaces")) : null;

function LocalOnlyRoute({
  Component,
  path,
}: {
  Component: LazyExoticComponent<ComponentType> | null;
  path: string;
}) {
  if (!Component) return null;
  return <Route path={path} element={<Suspense fallback={null}><Component /></Suspense>} />;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter basename={getBrowserRouterBase()}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/sso/callback" element={<SsoCallback />} />
          <Route path="/auth/microsoft/callback" element={<SsoCallback />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<Index />} />
            <Route path="/monitoramento" element={<MonitoringPage />} />
            <Route path="/alertas" element={<AlertsPage />} />
            <Route path="/historico" element={<HistoricoPage />} />
            <LocalOnlyRoute path="/banco-dados" Component={BancoDadosPage} />
            <LocalOnlyRoute path="/certificados" Component={CertificadosPage} />
            <Route path="/chamados" element={<ChamadosPage />} />
            <LocalOnlyRoute path="/workspaces" Component={WorkspacesPage} />
            <Route path="/config" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
