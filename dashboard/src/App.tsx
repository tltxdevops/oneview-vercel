import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Login from "./pages/Login";
import NotFound from "./pages/NotFound";
import SettingsPage from "@/pages/Settings";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import SsoCallback from "@/pages/SsoCallback";
import { getBrowserRouterBase } from "@/lib/basePath";

const queryClient = new QueryClient();
const Index = lazy(() => import("./pages/Index")); const MonitoringPage = lazy(() => import("@/pages/Monitoring")); const AlertsPage = lazy(() => import("@/pages/Alerts")); const HistoricoPage = lazy(() => import("@/pages/Historico")); const ChamadosPage = lazy(() => import("@/pages/Chamados")); const OperadorasPage = lazy(() => import("@/pages/Operadoras"));
const UiKitPage = lazy(() => import("@/pages/UiKit"));
const route = (node: ReactNode) => <Suspense fallback={null}>{node}</Suspense>;

/**
 * OV-P0-141B — páginas sem fonte real permanecem apenas no servidor local.
 * `import.meta.env.DEV` é substituído em build; os imports mock não entram em
 * bundles Production/Preview nem suas rotas são registradas.
 */
const BancoDadosPage = import.meta.env.DEV ? lazy(() => import("@/pages/BancoDados")) : null;
const CertificadosPage = import.meta.env.DEV ? lazy(() => import("@/pages/Certificados")) : null;
const WorkspacesPage = import.meta.env.DEV ? lazy(() => import("@/pages/Workspaces")) : null;

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
            <Route path="/" element={route(<Index />)} />
            <Route path="/monitoramento" element={route(<MonitoringPage />)} />
            <Route path="/alertas" element={route(<AlertsPage />)} />
            <Route path="/historico" element={route(<HistoricoPage />)} />
            {BancoDadosPage && <Route path="/banco-dados" element={<Suspense fallback={null}><BancoDadosPage /></Suspense>} />}
            {CertificadosPage && <Route path="/certificados" element={<Suspense fallback={null}><CertificadosPage /></Suspense>} />}
            <Route path="/chamados" element={route(<ChamadosPage />)} />
            <Route path="/operadoras" element={route(<OperadorasPage />)} />
            <Route path="/ui-kit" element={route(<UiKitPage />)} />
            {WorkspacesPage && <Route path="/workspaces" element={<Suspense fallback={null}><WorkspacesPage /></Suspense>} />}
            <Route path="/config" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
