import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Index from "./pages/Index";
import Login from "./pages/Login";
import NotFound from "./pages/NotFound";
import AlertsPage from "@/pages/Alerts";
import ChamadosPage from "@/pages/Chamados";
import CertificadosPage from "@/pages/Certificados";
import BancoDadosPage from "@/pages/BancoDados";
import WorkspacesPage from "@/pages/Workspaces";
import SettingsPage from "@/pages/Settings";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import SsoCallback from "@/pages/SsoCallback";
import { getBrowserRouterBase } from "@/lib/basePath";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter basename={getBrowserRouterBase()}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/sso/callback" element={<SsoCallback />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<Index />} />
            <Route path="/alertas" element={<AlertsPage />} />
            <Route path="/banco-dados" element={<BancoDadosPage />} />
            <Route path="/certificados" element={<CertificadosPage />} />
            <Route path="/chamados" element={<ChamadosPage />} />
            <Route path="/workspaces" element={<WorkspacesPage />} />
            <Route path="/config" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
