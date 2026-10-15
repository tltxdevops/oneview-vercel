import { OneViewButton } from "@/components/oneview/OneViewDesignSystem";

export const SUPPRESS_UNAVAILABLE_REASON = "Supressão indisponível até a homologação do probe e do executor.";

export function AlertSuppressUnavailable({ variant = "button" }: { variant?: "button" | "row" }) {
  return (
    <OneViewButton
      type="button"
      variant={variant === "row" ? "ghost" : "secondary"}
      size="sm"
      disabled
      aria-label="Suprimir alerta"
      title={SUPPRESS_UNAVAILABLE_REASON}
      onClick={(event) => event.stopPropagation()}
    >
      {variant === "row" ? "Suprimir" : "Suprimir alerta"}
    </OneViewButton>
  );
}
