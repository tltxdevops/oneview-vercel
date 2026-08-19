import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { Eye, History, Info } from "lucide-react";
import {
  CLASSIFICATION_PENDING_LABEL,
  ClientIdentity,
  canonicalHostName,
  displayHostField,
  isNonCustomerOperationalScope,
  normalizeOperationalScope,
  operationalClientLabel,
} from "@/components/oneview/ClientIdentity";
import {
  interfaceFromAlertTags,
  safeHostIp,
} from "@/components/oneview/AlertOperationalSummary";
import { AlertRecurrenceSignal } from "@/components/oneview/AlertRecurrenceSignal";
import { AlertRecurrenceInvestigation } from "@/components/oneview/AlertRecurrenceInvestigation";
import { AlertRelatedIncidentsSection } from "@/components/oneview/AlertRelatedIncidentsSection";
import { AlertServiceNowReferenceCell } from "@/components/oneview/AlertServiceNowReferenceCell";
import { OperationalErrorBanner } from "@/components/oneview/OperationalErrorBanner";
import { SeverityBadge } from "@/components/badges/SeverityBadge";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  AlertHistoryItem,
  OneViewAlert,
  formatOneViewSeverityLabel,
} from "@/lib/oneview-api";
import { filterOperationalAlertTags } from "@/lib/oneview-inc-correlation";
import { buildAlertOperationalTimeline } from "@/lib/oneview-alert-timeline";

export type AlertDetailDrawerTab = "summary" | "history" | "technical";

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

function isResolvedAlert(alert: OneViewAlert) {
  const sourceStatus = String(alert.status_source || "").trim().toLowerCase();
  const internalStatus = String(alert.status_internal || "").trim().toLowerCase();
  return Boolean(alert.resolved_at) || sourceStatus === "resolved" || ["resolved", "normalized"].includes(internalStatus);
}

function safeActorName(value?: string | null) {
  const actor = String(value || "").trim();
  if (!actor || /^\d+$/.test(actor)) return null;
  if (/worker|oneview|sistema|system|reconcil/i.test(actor)) return null;
  return actor;
}

function collectOperationalTags(alert: OneViewAlert) {
  return filterOperationalAlertTags([
    ...(alert.event_tags ?? []),
    ...(alert.trigger_tags ?? []),
    ...(alert.host_tags ?? []),
    ...((alert as OneViewAlert & { template_tags?: OneViewAlert["event_tags"] }).template_tags ?? []),
  ]);
}

function DetailField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 break-words font-semibold", mono && "font-mono")}>{value}</dd>
    </div>
  );
}

export type AlertDetailDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  alert: OneViewAlert | null;
  historyItems?: AlertHistoryItem[];
  isLoading?: boolean;
  error?: string | null;
  description?: string;
  defaultTab?: AlertDetailDrawerTab;
  alertsQueueHref?: string | null;
  auditEmphasis?: boolean;
};

/**
 * OV-P0-80 / OV-P0-108 — Drawer único de detalhe.
 * Preview permanece visível durante refresh; skeleton só em blocos ainda vazios.
 */
export function AlertDetailDrawer({
  open,
  onOpenChange,
  alert,
  historyItems = [],
  isLoading = false,
  error = null,
  description = "Detalhe operacional do alerta.",
  defaultTab = "summary",
  alertsQueueHref = null,
  auditEmphasis = false,
}: AlertDetailDrawerProps) {
  const timeline = buildAlertOperationalTimeline(alert, historyItems);
  const [activeTab, setActiveTab] = useState<AlertDetailDrawerTab>(
    ["summary", "history", "technical"].includes(defaultTab) ? defaultTab : "summary",
  );

  useEffect(() => {
    const next: AlertDetailDrawerTab = ["summary", "history", "technical"].includes(defaultTab)
      ? defaultTab
      : "summary";
    setActiveTab(next);
  }, [alert?.id, defaultTab]);

  const customer = alert
    ? {
        key: alert.customer_key,
        name: alert.customer_name,
        source: alert.customer_source,
      }
    : null;
  const scope = alert ? normalizeOperationalScope(alert.operational_scope) : null;
  const clientName = alert
    ? operationalClientLabel({
        key: alert.customer_key,
        name: alert.customer_name,
        source: alert.customer_source,
        operational_scope: alert.operational_scope,
        operational_scope_label: alert.operational_scope_label,
      })
    : "";
  const showPending = Boolean(
    alert && (scope === "unknown" || (!scope && !alert.customer_name)),
  );
  const hostName = alert ? canonicalHostName(alert) : "—";
  const resolved = alert ? isResolvedAlert(alert) : false;
  const ackPending = alert ? !alert.acknowledged_source : true;
  const publicIp = alert ? safeHostIp(alert.host_ip) : null;
  const iface = alert ? interfaceFromAlertTags(alert) : null;
  const tags = alert ? collectOperationalTags(alert) : [];
  const ackAt = alert ? (alert.acknowledged_source_at || alert.acknowledged_at) : null;
  const ackBy = alert
    ? safeActorName(alert.acknowledged_source_by || alert.acknowledged_by)
    : null;
  const queueHref = String(alertsQueueHref || "").trim() || null;
  const historyLoading = isLoading && !timeline.length;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full border-l border-border bg-background p-0 sm:max-w-2xl">
        {!alert ? (
          <div className="flex h-full flex-col">
            <SheetHeader className="border-b border-border/70 py-5 pl-6 pr-14 text-left">
              <SheetTitle className="text-xl">Detalhe do alerta</SheetTitle>
              <SheetDescription>{description}</SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-6 py-5">
              {error ? <OperationalErrorBanner message={error} /> : null}
              {isLoading ? (
                <div className="space-y-3"><Skeleton className="h-28 w-full" /><Skeleton className="h-40 w-full" /></div>
              ) : (
                <p className="text-sm text-muted-foreground">Selecione um alerta para ver o detalhe.</p>
              )}
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col">
            <SheetHeader className="border-b border-border/70 py-5 pl-6 pr-14 text-left">
              <SheetTitle className="text-xl">Detalhe do alerta</SheetTitle>
              <SheetDescription>{description}</SheetDescription>
            </SheetHeader>

            <Tabs
              value={activeTab}
              onValueChange={(value) => setActiveTab(value as AlertDetailDrawerTab)}
              className="flex min-h-0 flex-1 flex-col"
            >
              <TabsList className="mx-6 mt-4 grid w-auto grid-cols-3">
                <TabsTrigger value="summary"><Eye className="mr-1.5 h-4 w-4" />Resumo</TabsTrigger>
                <TabsTrigger value="history"><History className="mr-1.5 h-4 w-4" />Histórico</TabsTrigger>
                <TabsTrigger value="technical"><Info className="mr-1.5 h-4 w-4" />Técnico</TabsTrigger>
              </TabsList>

              {error ? <OperationalErrorBanner className="mx-6 mt-4 px-3 py-2" message={error} /> : null}

              <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
                <TabsContent value="summary" className="mt-4 space-y-4">
                  <div className="flex min-w-0 items-start gap-3" aria-label="Cabeçalho do alerta">
                    <ClientIdentity
                      customer={customer}
                      operationalScope={alert.operational_scope}
                      operationalScopeLabel={alert.operational_scope_label}
                      size="lg"
                      className="mt-0.5 shrink-0"
                    />
                    <div className="min-w-0 space-y-1.5">
                      <p className="truncate text-base font-semibold leading-tight text-foreground">{clientName}</p>
                      <p className="truncate text-sm text-foreground/80">{hostName}</p>
                      {showPending ? (
                        <p className="text-xs text-muted-foreground">{CLASSIFICATION_PENDING_LABEL}</p>
                      ) : null}
                      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                        <SeverityBadge severity={alert.severity} />
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
                    </div>
                  </div>

                  <section aria-label="Resumo" className="space-y-3">
                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Problema</p>
                      <p className="mt-1.5 text-base font-semibold leading-6 text-foreground">
                        {String(alert.problem_name || "").trim() || "Alerta sem descrição"}
                      </p>
                    </div>
                    <AlertRecurrenceSignal alert={alert} />
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                      <DetailField label="Início" value={formatDateTime(alert.first_seen_at)} />
                      <DetailField label="Duração" value={formatDurationSeconds(alert.duration_seconds)} />
                      <DetailField label="Última atualização" value={formatDateTime(alert.last_seen_at)} />
                      {alert.resolved_at ? (
                        <DetailField label="Recovery" value={formatDateTime(alert.resolved_at)} />
                      ) : null}
                    </dl>
                  </section>

                  {/* Detalhe correlacionado consultado somente pelo BFF no bloco Chamado relacionado. */}
                  <AlertRelatedIncidentsSection
                    sourceEventId={alert.source_event_id}
                    severity={alert.severity}
                    historyItems={historyItems}
                    alert={alert}
                  />
                </TabsContent>

                <TabsContent value="history" className="mt-4 space-y-4">
                  {historyLoading ? (
                    <div className="space-y-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>
                  ) : (
                    <>
                      <AlertRecurrenceInvestigation alert={alert} />
                      {auditEmphasis ? (
                        <section aria-label="Auditoria temporal" className="space-y-3 rounded-lg border border-border/70 bg-muted/20 p-3">
                          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                            Auditoria temporal
                          </p>
                          <dl className="grid gap-3 text-sm sm:grid-cols-2">
                            <DetailField label="Início" value={formatDateTime(alert.first_seen_at)} />
                            <DetailField label="Duração total" value={formatDurationSeconds(alert.duration_seconds)} />
                            <DetailField label="Reconhecido em" value={formatDateTime(ackAt)} />
                            <DetailField label="Reconhecido por" value={ackBy || "—"} />
                            {alert.resolved_at ? (
                              <DetailField label="Recovery" value={formatDateTime(alert.resolved_at)} />
                            ) : null}
                          </dl>
                        </section>
                      ) : null}

                      <section aria-label="Linha do tempo atual" className="space-y-3">
                        <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">Linha do tempo atual</h3><span className="text-xs text-muted-foreground">Estado final: {resolved ? "Resolvido" : "Ativo"}</span></div>
                      {timeline.length ? (
                        <div className="space-y-3" aria-label="Timeline do alerta">
                          {timeline.map((item) => (
                            <Card key={item.id} className="ov-panel p-3">
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge variant="outline" className="text-[10px]">{item.label}</Badge>
                                <span className="text-[10px] text-muted-foreground">{formatDateTime(item.occurred_at)}</span>
                              </div>
                              {item.description ? <p className="mt-2 text-sm text-muted-foreground">{item.description}</p> : null}
                              {item.comment ? <p className="mt-1 text-xs text-muted-foreground">Comentário: {item.comment}</p> : null}
                              {item.actor ? (
                                <p className="mt-1 text-[10px] text-muted-foreground">
                                  Reconhecido por {item.actor}
                                </p>
                              ) : null}
                              {item.kind === "servicenow" && (item.incident_number || item.incident_url) ? (
                                <div className="mt-2">
                                  <AlertServiceNowReferenceCell
                                    reference={{
                                      number: item.incident_number,
                                      sys_id: null,
                                      url: item.incident_url,
                                      extra_count: 0,
                                    }}
                                  />
                                </div>
                              ) : null}
                            </Card>
                          ))}
                        </div>
                      ) : (
                        <p className="py-10 text-center text-sm text-muted-foreground">
                          Nenhum evento de histórico disponível para este alerta.
                        </p>
                      )}
                      </section>
                    </>
                  )}
                </TabsContent>

                <TabsContent value="technical" className="mt-4 space-y-4">
                  <section aria-label="Fonte" className="space-y-2">
                    <h3 className="text-sm font-semibold">Fonte</h3>
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                      <DetailField label="Fonte Zabbix" value={String(alert.datasource_name || "").trim() || "Fonte não identificada"} />
                      <DetailField label="Tipo de fonte" value={String(alert.source_type || "").trim() || "Não informado"} />
                      <DetailField label="Event ID" value={String(alert.source_event_id || "").trim() || "Não informado"} mono />
                    </dl>
                  </section>

                  <section aria-label="Host técnico" className="space-y-2">
                    <h3 className="text-sm font-semibold">Host</h3>
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                      <DetailField label="Nome visível" value={displayHostField(alert.host_visible_name) || hostName} />
                      <DetailField label="Nome técnico" value={displayHostField(alert.host_technical_name) || "—"} />
                      {publicIp ? <DetailField label="IP" value={publicIp} mono /> : null}
                      {iface ? <DetailField label="Interface" value={iface} /> : null}
                    </dl>
                  </section>

                  <section aria-label="Grupos e tags" className="space-y-2">
                    <h3 className="text-sm font-semibold">Grupos e tags</h3>
                    <div>
                      <p className="text-xs text-muted-foreground">Grupos</p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {alert.host_groups?.length
                          ? alert.host_groups.map((group, index) => (
                              <Badge key={`${group.id ?? group.name}-${index}`} variant="outline">
                                {String(group.name || "").trim() || "Grupo sem nome"}
                              </Badge>
                            ))
                          : <span className="text-xs text-muted-foreground">Nenhum grupo disponível.</span>}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Tags operacionais</p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {tags.length
                          ? tags.map((tag, index) => (
                              <Badge key={`${tag.tag}-${tag.value}-${index}`} variant="secondary">
                                {tag.tag}{tag.value ? `: ${tag.value}` : ""}
                              </Badge>
                            ))
                          : <span className="text-xs text-muted-foreground">Nenhuma tag disponível.</span>}
                      </div>
                    </div>
                  </section>

                  {!isNonCustomerOperationalScope(scope) ? (
                    <section aria-label="Classificação" className="space-y-2">
                      <h3 className="text-sm font-semibold">Classificação</h3>
                      <dl className="grid gap-3 text-sm sm:grid-cols-2">
                        <DetailField label="Origem da classificação" value={customerSourceLabel(alert.customer_source)} />
                        <DetailField label="Confiança" value={confidenceLabel(alert.customer_confidence)} />
                        <DetailField label="Severidade (dado)" value={formatOneViewSeverityLabel(alert.severity)} />
                      </dl>
                    </section>
                  ) : null}
                </TabsContent>
              </div>

              {queueHref ? (
                <div className="shrink-0 border-t border-border/60 px-6 py-3">
                  <Link
                    to={queueHref}
                    className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    Ver na fila de Alertas
                  </Link>
                </div>
              ) : null}
            </Tabs>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
