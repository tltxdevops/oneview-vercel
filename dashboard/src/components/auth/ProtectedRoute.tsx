import type { ReactNode } from "react";
import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { authReturnToFromLocation } from "@/lib/auth/return-url";
import { prefetchOneViewRoute } from "@/lib/oneview-route-prefetch";
import { OperatorReminderInboxProvider } from "@/providers/OperatorReminderInboxProvider";

interface ProtectedRouteProps {
  children?: ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  useEffect(() => {
    if (!user) return;
    prefetchOneViewRoute(location.pathname, { dataImmediate: true });
  }, [user, location.pathname]);
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <div className="flex flex-col items-center gap-3">
          <span className="h-10 w-10 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-primary" />
          <p className="text-sm text-muted-foreground">Carregando painel...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: authReturnToFromLocation(location) }} replace />;
  }

  return (
    <OperatorReminderInboxProvider>
      {children ? <>{children}</> : <Outlet />}
    </OperatorReminderInboxProvider>
  );
}
