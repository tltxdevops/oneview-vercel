import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import Login from "./pages/Login";
import NotFound from "./pages/NotFound";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { OneViewErrorBoundary } from "@/components/oneview/OneViewErrorBoundary";
import SsoCallback from "@/pages/SsoCallback";
import { getBrowserRouterBase } from "@/lib/basePath";
import { CENTRAL_ALERTAS_PATH, centralAlertasHref } from "@/lib/central-alertas-path";

const queryClient = new QueryClient();
const Index = lazy(() => import("./pages/Index")); const MonitoringPage = lazy(() => import("@/pages/Monitoring")); const AlertsPage = lazy(() => import("@/pages/Alerts")); const ChamadosPage = lazy(() => import("@/pages/Chamados")); const OperadorasPage = lazy(() => import("@/pages/Operadoras")); const SettingsPage = lazy(() => import("@/pages/Settings"));

function PreserveSearchRedirect({ to }: { to: string }) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const query = params.toString();
  return <Navigate to={query ? `${to}?${query}` : to} replace />;
}

function HistoricoRedirect() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  params.set("view", "history");
  const recurrence = params.get("recurrence");
  if (recurrence && !params.get("recurrence_key")) {
    params.set("recurrence_key", recurrence);
    params.delete("recurrence");
  }
  return <Navigate to={centralAlertasHref(params)} replace />;
}
const UiKitPage = lazy(() => import("@/pages/UiKit"));
const routeFallback = (
  <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
    Carregando tela...
  </div>
);
const route = (node: ReactNode) => (
  <OneViewErrorBoundary scope="route">
    <Suspense fallback={routeFallback}>{node}</Suspense>
  </OneViewErrorBoundary>
);

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
        <OneViewErrorBoundary scope="global">
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/sso/callback" element={<SsoCallback />} />
          <Route path="/auth/microsoft/callback" element={<SsoCallback />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={route(<Index />)} />
            <Route path="/monitoramento" element={route(<MonitoringPage />)} />
            <Route path={CENTRAL_ALERTAS_PATH} element={route(<AlertsPage />)} />
            <Route path="/alertas" element={<PreserveSearchRedirect to={CENTRAL_ALERTAS_PATH} />} />
            <Route path="/alerts" element={<PreserveSearchRedirect to={CENTRAL_ALERTAS_PATH} />} />
            <Route path="/historico" element={<HistoricoRedirect />} />
            {BancoDadosPage && <Route path="/banco-dados" element={<Suspense fallback={routeFallback}><BancoDadosPage /></Suspense>} />}
            {CertificadosPage && <Route path="/certificados" element={<Suspense fallback={routeFallback}><CertificadosPage /></Suspense>} />}
            <Route path="/chamados" element={route(<ChamadosPage />)} />
            <Route path="/operadoras" element={route(<OperadorasPage />)} />
            <Route path="/ui-kit" element={route(<UiKitPage />)} />
            {WorkspacesPage && <Route path="/workspaces" element={<Suspense fallback={routeFallback}><WorkspacesPage /></Suspense>} />}
            <Route path="/config" element={route(<SettingsPage />)} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
        </OneViewErrorBoundary>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
