import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";

interface LocationState {
  from?: string;
}

const SsoCallback = () => {
  const { user, isLoading, error } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state as LocationState) || {};

  useEffect(() => {
    if (!isLoading) return undefined;

    const timeoutId = window.setTimeout(() => {
      navigate("/login", {
        replace: true,
        state: {
          authError: "Tempo excedido ao concluir o SSO. Tente entrar novamente.",
        },
      });
    }, 20_000);

    return () => window.clearTimeout(timeoutId);
  }, [isLoading, navigate]);

  useEffect(() => {
    if (isLoading) return;

    if (user) {
      const redirectTo = state.from && state.from !== "/login" ? state.from : "/";
      navigate(redirectTo, { replace: true });
      return;
    }

    if (error) {
      navigate("/login", { replace: true, state: { authError: error } });
      return;
    }

    navigate("/login", {
      replace: true,
      state: {
        authError: "SSO concluído sem conta ativa. Tente entrar novamente.",
      },
    });
  }, [isLoading, user, error, navigate, state.from]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
      <div className="flex flex-col items-center gap-4 text-center">
        <span className="h-12 w-12 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" />
        <div>
          <p className="text-base font-medium">Conectando ao SSO</p>
          <p className="text-sm text-muted-foreground">Aguarde enquanto validamos as credenciais...</p>
        </div>
      </div>
    </div>
  );
};

export default SsoCallback;
