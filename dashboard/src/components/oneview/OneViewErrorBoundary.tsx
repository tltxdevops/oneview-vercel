import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { getBrowserRouterBase } from "@/lib/basePath";

export type OneViewErrorBoundaryScope = "global" | "route" | "drawer";

type OneViewErrorBoundaryProps = {
  children: ReactNode;
  scope?: OneViewErrorBoundaryScope;
  resetKeys?: ReadonlyArray<unknown>;
};

type OneViewErrorBoundaryState = {
  hasError: boolean;
  nonce: number;
  message: string;
};

function operationalHref(path: string) {
  const base = String(getBrowserRouterBase() || "").replace(/\/$/, "");
  if (!path || path === "/") return base || "/";
  return `${base}${path}`;
}

export class OneViewErrorBoundary extends Component<OneViewErrorBoundaryProps, OneViewErrorBoundaryState> {
  state: OneViewErrorBoundaryState = { hasError: false, nonce: 0, message: "" };

  static getDerivedStateFromError(error: Error): Pick<OneViewErrorBoundaryState, "hasError" | "message"> {
    const message = error instanceof Error && error.message
      ? error.message.slice(0, 300)
      : "Erro de renderização";
    return { hasError: true, message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[oneview] route crash", error, info.componentStack);
  }

  componentDidUpdate(prevProps: OneViewErrorBoundaryProps) {
    if (!this.state.hasError) return;
    const previous = JSON.stringify(prevProps.resetKeys ?? []);
    const next = JSON.stringify(this.props.resetKeys ?? []);
    if (previous !== next) this.reset();
  }

  reset = () => {
    this.setState((current) => ({ hasError: false, nonce: current.nonce + 1, message: "" }));
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const scope = this.props.scope ?? "global";
    const title = scope === "drawer"
      ? "Não foi possível exibir este detalhe"
      : scope === "route"
        ? "Não foi possível exibir esta tela"
        : "Não foi possível exibir o OneView";
    const detail = "A operação continua disponível. Atualize esta área ou navegue para outra tela.";

    return (
      <div
        key={this.state.nonce}
        className={scope === "drawer" ? "space-y-4 px-6 py-5" : "flex min-h-[50vh] flex-col items-start justify-center gap-4 px-6 py-10"}
        role="alert"
      >
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          <p className="max-w-xl text-sm text-muted-foreground">{detail}</p>
          {this.state.message ? (
            <p className="max-w-xl font-mono text-xs text-muted-foreground">{this.state.message}</p>
          ) : null}
        </div>
        {scope !== "drawer" ? (
          <nav className="flex flex-wrap gap-2" aria-label="Navegação operacional">
            <a className="text-sm text-primary underline-offset-2 hover:underline" href={operationalHref("/")}>Início</a>
            <a className="text-sm text-primary underline-offset-2 hover:underline" href={operationalHref("/monitoramento")}>Monitoramento</a>
            <a className="text-sm text-primary underline-offset-2 hover:underline" href={operationalHref("/central-alertas")}>Central de Alertas</a>
            <a className="text-sm text-primary underline-offset-2 hover:underline" href={operationalHref("/chamados")}>Chamados</a>
            <a className="text-sm text-primary underline-offset-2 hover:underline" href={operationalHref("/central-alertas?view=history")}>Histórico</a>
            <a className="text-sm text-primary underline-offset-2 hover:underline" href={operationalHref("/operadoras")}>Operadoras</a>
          </nav>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={this.reset}>
          Tentar novamente
        </Button>
      </div>
    );
  }
}
