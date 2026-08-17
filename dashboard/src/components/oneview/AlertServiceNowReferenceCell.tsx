/**
 * OV-P0-109 — referência SN compacta na tabela (sem fetch ServiceNow).
 * Usa somente `servicenow_reference` projetada pelo BFF a partir das tags Zabbix.
 */
import type { AlertServiceNowReference } from "@/lib/oneview-inc-correlation";
import { cn } from "@/lib/utils";

type Props = {
  reference?: AlertServiceNowReference | null;
  className?: string;
};

export function AlertServiceNowReferenceCell({ reference, className }: Props) {
  if (!reference || (!reference.number && !reference.sys_id)) {
    return <span className={cn("text-muted-foreground", className)}>—</span>;
  }

  const label = reference.number || "Chamado";
  const extra = reference.extra_count > 0 ? ` +${reference.extra_count}` : "";
  const title = reference.url
    ? "Abrir no ServiceNow"
    : reference.number
      ? reference.number
      : "Referência ServiceNow";

  const body = (
    <>
      <span className="font-mono text-[11px] font-medium tabular-nums">{label}</span>
      {reference.url ? <span aria-hidden className="text-[10px] leading-none">↗</span> : null}
      {extra ? <span className="text-[10px] text-muted-foreground">{extra}</span> : null}
    </>
  );

  if (reference.url) {
    return (
      <a
        href={reference.url}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        aria-label={`${title}: ${label}${extra}`}
        className={cn(
          "inline-flex max-w-full items-center gap-0.5 text-primary hover:underline",
          className,
        )}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {body}
      </a>
    );
  }

  return (
    <span title={title} className={cn("inline-flex max-w-full items-center gap-0.5", className)}>
      {body}
    </span>
  );
}
