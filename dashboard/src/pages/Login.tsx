import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { KeySquare, AlertCircle } from "lucide-react";
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, login, isLoading, error } = useAuth();

  const authState = location.state as { from?: string; authError?: string } | null;
  const redirectTo = authState?.from && authState.from !== "/login" ? authState.from : "/";
  const feedbackError = authState?.authError || error;

  useEffect(() => {
    if (!isLoading && user) {
      navigate(redirectTo, { replace: true });
    }
  }, [user, isLoading, navigate, redirectTo]);

  return (
    <div className="min-h-screen flex">
      {/* Left Side - Hero Image */}
      <div className="hidden md:flex md:w-2/3 relative bg-sidebar overflow-hidden">
        {/* Grid pattern overlay */}
        <div className="absolute inset-0 opacity-10">
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `radial-gradient(circle, #ffffff 1px, transparent 1px)`,
              backgroundSize: "24px 24px",
            }}
          />
        </div>

        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-transparent to-accent/20" />

        {/* Content */}
        <div className="relative z-10 flex flex-col justify-center px-16 text-white">
          <img
            src="/tltx/pfp_servicos_v1.png"
            alt="OneView"
            className="w-24 h-auto mb-8 drop-shadow-lg"
          />
          <h1 className="text-5xl font-bold font-sans mb-4">Plataforma e Serviços</h1>
          <p className="text-xl text-white/80 max-w-md">
            OneView - Central de Monitoramento Inteligente
          </p>
        </div>
      </div>

      {/* Right Side - Login Card */}
      <div className="w-full md:w-1/3 flex items-center justify-center p-8 bg-background">
        <div className="w-full max-w-md space-y-8 animate-fade-in">
          {/* Mobile Logo */}
          <div className="md:hidden text-center mb-8">
            <img
              src="/tltx/pfp_servicos_semfundo.png"
              alt="OneView"
              className="w-24 h-auto mx-auto mb-4 drop-shadow"
            />
            <h1 className="text-3xl font-bold font-sans">Plataforma e Serviços</h1>
            <p className="text-muted-foreground mt-2">Central de Monitoramento</p>
          </div>

          {/* Desktop Title */}
          <div className="hidden md:block">
            <img
              src="/tltx/tltx-logopreto.png"
              alt="OneView"
              className="w-48 h-auto mb-6 drop-shadow-sm"
            />
            <h2 className="text-3xl font-bold font-sans mb-2">Bem-vindo de volta</h2>
            <p className="text-muted-foreground">Entre com sua conta SSO para continuar</p>
          </div>

          {/* Login Form */}
          <div className="space-y-4">
            {feedbackError && (
              <Alert variant="destructive" className="border-destructive/60 bg-destructive/10 text-destructive-foreground">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Não foi possível entrar</AlertTitle>
                <AlertDescription>{feedbackError}</AlertDescription>
              </Alert>
            )}
            <Button
              onClick={login}
              className="w-full h-12 text-base gap-2"
              size="lg"
              disabled={isLoading}
            >
              <KeySquare className="h-5 w-5" />
              {isLoading ? "Conectando..." : "Entrar com SSO"}
            </Button>

          </div>

          {/* Additional Info */}
          <div className="text-center text-sm text-muted-foreground pt-8">
            <p>Acesso exclusivo para equipes autorizadas</p>
          </div>
        </div>
      </div>
    </div>
  );
}
