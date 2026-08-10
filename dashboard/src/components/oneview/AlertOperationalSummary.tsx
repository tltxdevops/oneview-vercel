import type { ReactNode } from "react";
import {
  CLASSIFICATION_PENDING_LABEL,
  ClientIdentity,
  canonicalHostName,
  isNonCustomerOperationalScope,
  normalizeOperationalScope,
  operationalClientLabel,
} from "@/components/oneview/ClientIdentity";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  OneViewAlert,
  formatOneViewSeverityLabel,
  normalizeOneViewSeverity,
} from "@/lib/oneview-api";

const SEVERITY_TONE: Record<string, string> = {
  disaster: "border-red-600 bg-red-100 text-red-950",
  critical: "border-red-500 bg-red-50 text-red-900",
  high: "border-red-200 bg-red-50 text-red-700",
  average: "border-amber-200 bg-amber-50 text-amber-700",
  warning: "border-yellow-200 bg-yellow-50 text-yellow-800",
  information: "border-sky-200 bg-sky-50 text-sky-700",
  not_classified: "border-slate-200 bg-slate-50 text-slate-700",
};

function formatDateTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("pt-BR");
}

function formatDurationSeconds(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rem = Math.round(seconds % 60);
    return rem ? `${minutes} min ${rem} s` : `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin ? `${hours} h ${remMin} min` : `${hours} h`;
}

function customerSourceLabel(value?: string | null) {
  const labels: Record<string, string> = {
    tag: "Tag",
    host_group: "Grupo do host",
    datasource_fallback: "Fallback da fonte",
  };
  const key = String(value || "").trim();
  if (!key) return "Enriquecimento pendente";
  return labels[key] ?? key;
}

function confidenceLabel(value?: string | null) {
  if (value === "high") return "Alta";
  if (value === "low") return "Baixa";
  if (value === "medium") return "Média";
  return "Não classificado";
}

/** IP público sanitizado — sem inventar; retorna null quando indisponível/protegido. */
export function safeHostIp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || ["-", "[redacted]", "[ip_protegido]"].includes(candidate.toLowerCase())) return null;

  const ipv4 = candidate.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => octet < 0 || octet > 255)) return null;
    const [first, second] = octets;
    if (first === 0 || first === 10 || first === 127 || first >= 224) return null;
    if (first === 100 && second >= 64 && second <= 127) return null;
    if (first === 169 && second === 254) return null;
    if (first === 172 && second >= 16 && second <= 31) return null;
    if (first === 192 && second === 168) return null;
    return candidate;
  }

  const normalizedIpv6 = candidate.toLowerCase();
  if (/^[0-9a-f:]+$/i.test(normalizedIpv6) && normalizedIpv6.includes(":")) {
    if (normalizedIpv6 === "::1" || normalizedIpv6.startsWith("fe8") || normalizedIpv6.startsWith("fe9")
      || normalizedIpv6.startsWith("fea") || normalizedIpv6.startsWith("feb")
      || normalizedIpv6.startsWith("fc") || normalizedIpv6.startsWith("fd")) return null;
    return candidate;
  }

  return null;
}

/** Interface só quando já vier em tags conhecidas — nunca inferida. */
export function interfaceFromAlertTags(alert: Pick<OneViewAlert, "event_tags" | "trigger_tags" | "host_tags">) {
  const tags = [...(alert.event_tags ?? []), ...(alert.trigger_tags ?? []), ...(alert.host_tags ?? [])];
  for (const tag of tags) {
    const name = String(tag.tag || "").trim().toLowerCase();
    const value = String(tag.value || "").trim();
    if (!value) continue;
    if (name === "interface" || name === "if" || name === "ifname" || name === "net.if") return value;
  }
  return null;
}

function isResolvedAlert(alert: OneViewAlert) {
  const sourceStatus = String(alert.status_source || "").trim().toLowerCase();
  const internalStatus = String(alert.status_internal || "").trim().toLowerCase();
  return Boolean(alert.resolved_at) || sourceStatus === "resolved" || ["resolved", "normalized"].includes(internalStatus);
}

type AlertOperationalSummaryProps = {
  alert: OneViewAlert;
  className?: string;
  /** Conteúdo adicional após o bloco de metadados (ACK detalhado, etc.). */
  children?: ReactNode;
};

/**
 * Hierarquia operacional compartilhada (OV-P0-49 / OV-P0-56) — Home / Alertas / Monitoramento→Alertas.
 * Não inferir cliente: usa customer_* + operational_scope do BFF.
 */
export function AlertOperationalSummary({ alert, className, children }: AlertOperationalSummaryProps) {
  const customer = {
    key: alert.customer_key,
    name: alert.customer_name,
    source: alert.customer_source,
  };
  const scope = normalizeOperationalScope(alert.operational_scope);
  const clientName = operationalClientLabel({
    ...customer,
    operational_scope: alert.operational_scope,
    operational_scope_label: alert.operational_scope_label,
  });
  const showPending = scope === "unknown" || (!scope && !alert.customer_name);
  const hostName = canonicalHostName(alert);
  const severityKey = normalizeOneViewSeverity(alert.severity);
  const severityTone = SEVERITY_TONE[severityKey] ?? SEVERITY_TONE.not_classified;
  const resolved = isResolvedAlert(alert);
  const ackPending = !alert.acknowledged_source;
  const publicIp = safeHostIp(alert.host_ip);
  const iface = interfaceFromAlertTags(alert);

  const metaRows: Array<[string, string]> = [
    ["Início", formatDateTime(alert.first_seen_at)],
    ["Duração", formatDurationSeconds(alert.duration_seconds)],
    ["Última atualização", formatDateTime(alert.last_seen_at)],
  ];
  if (publicIp) metaRows.push(["IP", publicIp]);
  if (iface) metaRows.push(["Interface", iface]);
  if (!isNonCustomerOperationalScope(scope)) {
    metaRows.push(
      ["Origem da classificação", customerSourceLabel(alert.customer_source)],
      ["Confiança da classificação", confidenceLabel(alert.customer_confidence)],
    );
  }

  return (
    <div className={cn("space-y-4", className)} aria-label="Resumo operacional">
      <div className="flex min-w-0 items-start gap-3">
        <ClientIdentity
          customer={customer}
          operationalScope={alert.operational_scope}
          operationalScopeLabel={alert.operational_scope_label}
          size="lg"
          className="mt-0.5"
        />
        <div className="min-w-0 space-y-0.5">
          <p className="truncate text-base font-semibold leading-tight text-foreground">{clientName}</p>
          <p className="truncate text-sm text-foreground/80">{hostName}</p>
          {showPending ? (
            <p className="text-xs text-muted-foreground">{CLASSIFICATION_PENDING_LABEL}</p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className={cn("text-[10px]", severityTone)}>
          {formatOneViewSeverityLabel(alert.severity)}
        </Badge>
        <Badge
          variant="outline"
          className={cn(
            "text-[10px]",
            resolved
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-amber-200 bg-amber-50 text-amber-700",
          )}
        >
          {resolved ? "Resolvido" : "Ativo"}
        </Badge>
        <Badge
          variant="outline"
          className={cn(
            "text-[10px]",
            ackPending
              ? "border-amber-200 bg-amber-50 text-amber-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-700",
          )}
        >
          {ackPending ? "ACK pendente" : "ACK"}
        </Badge>
      </div>

      <section aria-label="Problema">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Problema</p>
        <p className="mt-1.5 text-base font-semibold leading-6 text-foreground">
          {String(alert.problem_name || "").trim() || "Alerta sem descrição"}
        </p>
      </section>

      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        {metaRows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className={cn("mt-0.5 break-words font-semibold", label === "IP" && "font-mono")}>{value}</dd>
          </div>
        ))}
      </dl>

      {children}
    </div>
  );
}
