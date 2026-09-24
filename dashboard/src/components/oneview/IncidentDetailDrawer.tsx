import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Eye, Info, Siren } from "lucide-react";
import { OneViewIncidentStatusBadge } from "@/components/badges/OneViewIncidentStatusBadge";
import { IncidentDetailActions } from "@/components/oneview/IncidentDetailActions";
import { IncidentDetailField, IncidentRelatedAlertContent, useIncidentRelatedAlert } from "@/components/oneview/IncidentRelatedAlertSection";
import { OperationalErrorBanner } from "@/components/oneview/OperationalErrorBanner";
import { displayIncidentField } from "@/components/oneview/OperationalIncidentsQueueList";
import { ServiceNowDevLink } from "@/components/oneview/ServiceNowDevLink";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { buildAlertArtifactFromIncidentRelatedAlert, type AlertArtifactModel } from "@/lib/oneview-alert-artifact";
import { buildProductionServiceNowIncidentLink } from "@/lib/oneview-inc-correlation";
import { fetchIncidentDetail, type OneViewIncident } from "@/lib/oneview-api";
import { cn } from "@/lib/utils";

export type IncidentDetailDrawerTab = "summary" | "alert" | "technical";

function formatDateTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("pt-BR");
}

function present(value?: string | null) {
  const text = String(value || "").trim();
  return Boolean(text && text !== "—" && text !== "undefined" && text !== "null");
}

export function IncidentDetailDrawer({
  incident,
  onOpenChange,
  description = "Detalhe operacional do chamado.",
  footerContent,
  stacked = false,
  alertArtifact: alertArtifactProp,
  showActions = true,
  onActionComplete,
}: {
  incident: OneViewIncident | null;
  onOpenChange: (open: boolean) => void;
  description?: string;
  footerContent?: ReactNode | ((incident: OneViewIncident) => ReactNode);
  stacked?: boolean;
  /** When omitted, related alert is resolved automatically for attachment. Pass null to disable. */
  alertArtifact?: AlertArtifactModel | null;
  showActions?: boolean;
  onActionComplete?: () => void;
}) {
  const [activeTab, setActiveTab] = useState<IncidentDetailDrawerTab>("summary");
  const [detail, setDetail] = useState<OneViewIncident | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionRefresh, setActionRefresh] = useState(0);
  const [liveAssignee, setLiveAssignee] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<{ state: string | null; state_display?: string | null } | null>(null);

  useEffect(() => {
    setActiveTab("summary");
    setLiveAssignee(null);
    setLiveState(null);
    setActionRefresh(0);
  }, [incident?.sys_id, incident?.number]);

  useEffect(() => {
    const sysId = String(incident?.sys_id || "").trim();
    if (!sysId) {
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    let active = true;
    setDetailLoading(true);
    setDetailError(null);
    void fetchIncidentDetail(sysId)
      .then((item) => {
        if (active) setDetail(item);
      })
      .catch((error: unknown) => {
        if (active) setDetailError(error instanceof Error ? error.message : "Não foi possível atualizar o chamado.");
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [incident?.sys_id, actionRefresh]);

  // Não reutiliza o detalhe do chamado anterior enquanto o próximo carrega.
  // O item da lista mantém o drawer responsivo e evita lookup correlato com sys_id antigo.
  const detailForSelectedIncident = detail?.sys_id === incident?.sys_id ? detail : null;
  const baseResolved = detailForSelectedIncident ?? incident;
  const resolved = useMemo(() => {
    if (!baseResolved) return null;
    return {
      ...baseResolved,
      assigned_to_display: liveAssignee ?? baseResolved.assigned_to_display ?? baseResolved.assigned_to,
      assigned_to: liveAssignee ?? baseResolved.assigned_to,
      state: liveState?.state ?? baseResolved.state,
      state_display: liveState?.state_display ?? baseResolved.state_display,
    };
  }, [baseResolved, liveAssignee, liveState]);

  // Uma única relação inicia ao abrir o drawer e atende a aba Alerta e o
  // artefato usado pelas ações, evitando duas consultas idênticas ao BFF.
  const relatedAlertState = useIncidentRelatedAlert(resolved);
  const autoResolveArtifact = alertArtifactProp === undefined;
  const { relatedAlert } = relatedAlertState;
  const alertArtifact = useMemo(() => {
    if (alertArtifactProp !== undefined) return alertArtifactProp;
    if (!resolved || !relatedAlert) return null;
    return buildAlertArtifactFromIncidentRelatedAlert(relatedAlert, resolved);
  }, [alertArtifactProp, relatedAlert, resolved]);

  const bumpRefresh = useCallback(() => {
    setActionRefresh((value) => value + 1);
    onActionComplete?.();
  }, [onActionComplete]);

  const descriptionText = resolved
    ? displayIncidentField(resolved.short_description, resolved.description)
    : "—";
  const company = resolved ? displayIncidentField(resolved.company_display, resolved.company) : "—";
  const number = resolved ? displayIncidentField(resolved.number) : "—";
  const identityConflict = Boolean(resolved?.identity_conflict);
  const snUrl = resolved && !identityConflict ? buildProductionServiceNowIncidentLink(resolved.sys_id) : null;
  const extraFooter = resolved
    ? (typeof footerContent === "function" ? footerContent(resolved) : footerContent)
    : null;

  return (
    <Sheet open={incident !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        overlayClassName={stacked ? "z-[60]" : undefined}
        className={cn("flex h-full w-full flex-col border-l border-border bg-background p-0 sm:max-w-2xl", stacked && "z-[60]")}
      >
        {!resolved ? (
          <div className="flex h-full flex-col">
            <SheetHeader className="border-b border-border/70 py-5 pl-6 pr-14 text-left">
              <SheetTitle className="text-xl">Detalhe do chamado</SheetTitle>
              <SheetDescription>{description}</SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-6 py-5">
              <p className="text-sm text-muted-foreground">Selecione um chamado para ver o detalhe.</p>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <SheetHeader className="shrink-0 border-b border-border/70 py-5 pl-6 pr-14 text-left">
              <SheetTitle className="text-xl">Detalhe do chamado</SheetTitle>
              <SheetDescription>{description}</SheetDescription>
            </SheetHeader>

            <Tabs
              value={activeTab}
              onValueChange={(value) => setActiveTab(value as IncidentDetailDrawerTab)}
              className="flex min-h-0 flex-1 flex-col"
            >
              <TabsList className="mx-6 mt-4 grid w-auto shrink-0 grid-cols-3">
                <TabsTrigger value="summary"><Eye className="mr-1.5 h-4 w-4" />Resumo</TabsTrigger>
                <TabsTrigger value="alert"><Siren className="mr-1.5 h-4 w-4" />Alerta</TabsTrigger>
                <TabsTrigger value="technical"><Info className="mr-1.5 h-4 w-4" />Técnico</TabsTrigger>
              </TabsList>

              {detailError ? <OperationalErrorBanner className="mx-6 mt-4 shrink-0 px-3 py-2" message={detailError} /> : null}

              <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
                <TabsContent value="summary" className="mt-4 space-y-4">
                  <div className="flex min-w-0 items-start gap-3" aria-label="Cabeçalho do chamado">
                    <div className="min-w-0 space-y-1.5">
                      {snUrl && number !== "—" ? (
                        <a
                          href={snUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 font-mono text-lg font-semibold text-primary hover:underline"
                        >
                          {number}
                          <span aria-hidden className="text-[10px] leading-none">↗</span>
                        </a>
                      ) : (
                        <p className="font-mono text-lg font-semibold">{number}</p>
                      )}
                      <p className="truncate text-sm text-foreground/80">{company}</p>
                      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                        <OneViewIncidentStatusBadge state={resolved.state} display={resolved.state_display} />
                        <Badge variant="secondary" className="text-[10px]">
                          {displayIncidentField(resolved.priority_display, resolved.priority)}
                        </Badge>
                      </div>
                    </div>
                  </div>

                  {detailLoading && !detailForSelectedIncident ? <Skeleton className="h-16 w-full" /> : null}

                  <section aria-label="Descrição" className="space-y-2">
                    <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Descrição</h3>
                    <p className="whitespace-pre-wrap break-words text-sm font-semibold">{descriptionText}</p>
                  </section>

                  <section aria-label="Atribuição" className="space-y-2">
                    <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Atribuição</h3>
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                      <IncidentDetailField label="Responsável" value={displayIncidentField(resolved.assigned_to_display, resolved.assigned_to)} />
                      <IncidentDetailField label="Grupo" value={displayIncidentField(resolved.assignment_group_display, resolved.assignment_group)} />
                      <IncidentDetailField label="Abertura" value={formatDateTime(resolved.opened_at)} />
                      <IncidentDetailField label="Atualização" value={formatDateTime(resolved.sys_updated_on)} />
                      <IncidentDetailField label="Encerramento" value={formatDateTime(resolved.closed_at || resolved.resolved_at)} />
                    </dl>
                  </section>

                  <section aria-label="Origem ServiceNow" className="space-y-2">
                    <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Origem ServiceNow</h3>
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                      <IncidentDetailField label="Empresa" value={company} />
                      <IncidentDetailField label="Caller" value={displayIncidentField(resolved.caller_id_display, resolved.caller_id)} />
                      <IncidentDetailField label="Canal" value={displayIncidentField(resolved.contact_type_display, resolved.contact_type)} />
                    </dl>
                  </section>
                </TabsContent>

                <TabsContent value="alert" className="mt-4 space-y-4">
                  <IncidentRelatedAlertContent {...relatedAlertState} />
                </TabsContent>

                <TabsContent value="technical" className="mt-4 space-y-4">
                  <section aria-label="Dados Zabbix" className="space-y-2">
                    <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Zabbix</h3>
                    {present(resolved.u_hostname_zabbix) || present(resolved.u_ip_zabbix) || present(resolved.zabbix_event_id) ? (
                      <dl className="grid gap-3 text-sm sm:grid-cols-2">
                        {present(resolved.u_hostname_zabbix) ? <IncidentDetailField label="Hostname Zabbix" value={displayIncidentField(resolved.u_hostname_zabbix)} /> : null}
                        {present(resolved.u_ip_zabbix) ? <IncidentDetailField label="IP Zabbix" value={displayIncidentField(resolved.u_ip_zabbix)} mono /> : null}
                        {present(resolved.zabbix_event_id) ? <IncidentDetailField label="Event ID" value={displayIncidentField(resolved.zabbix_event_id)} mono /> : null}
                      </dl>
                    ) : (
                      <p className="text-sm text-muted-foreground">Dados Zabbix indisponíveis neste chamado.</p>
                    )}
                  </section>

                  <Accordion type="single" collapsible className="rounded-md border border-border/60 px-3">
                    <AccordionItem value="extra" className="border-0">
                      <AccordionTrigger className="py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground hover:no-underline">
                        Detalhes adicionais
                      </AccordionTrigger>
                      <AccordionContent>
                        <dl className="grid gap-3 text-sm sm:grid-cols-2">
                          <IncidentDetailField label="Categoria" value={displayIncidentField(resolved.category_display, resolved.category)} />
                          <IncidentDetailField label="Subcategoria" value={displayIncidentField(resolved.subcategory_display, resolved.subcategory)} />
                          <IncidentDetailField label="Impacto" value={displayIncidentField(resolved.impact_display, resolved.impact)} />
                          <IncidentDetailField label="Urgência" value={displayIncidentField(resolved.urgency_display, resolved.urgency)} />
                          <IncidentDetailField label="Correlation ID" value={displayIncidentField(resolved.correlation_id)} mono />
                          <IncidentDetailField label="Contrato" value={displayIncidentField(resolved.contract)} />
                          <IncidentDetailField label="Código de encerramento" value={displayIncidentField(resolved.close_code)} />
                          {present(resolved.close_notes) ? (
                            <div className="sm:col-span-2">
                              <IncidentDetailField label="Notas de resolução" value={displayIncidentField(resolved.close_notes)} pre />
                            </div>
                          ) : null}
                        </dl>
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                </TabsContent>
              </div>
            </Tabs>

            <div className="sticky bottom-0 shrink-0 space-y-3 border-t border-border/70 bg-background/95 px-6 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
              {extraFooter}
              {identityConflict ? (
                <p className="text-sm text-destructive">
                  Inconsistência de identidade ServiceNow. Ações temporariamente indisponíveis.
                </p>
              ) : null}
              {showActions && !identityConflict && resolved.sys_id && resolved.number ? (
                <IncidentDetailActions
                  incident={{
                    sys_id: resolved.sys_id,
                    number: resolved.number,
                    state: resolved.state,
                    identity_conflict: identityConflict,
                  }}
                  alertArtifact={alertArtifact}
                  placement="drawer-footer"
                  onClaimed={(result) => {
                    setLiveAssignee(result.incident.assigned_to_name);
                    bumpRefresh();
                  }}
                  onWorkNoteAdded={bumpRefresh}
                  onAttachmentAdded={bumpRefresh}
                  onPutOnHold={(result) => {
                    setLiveState({ state: result.incident.state, state_display: "Em espera" });
                    bumpRefresh();
                  }}
                />
              ) : null}
              {resolved.sys_id && !identityConflict ? (
                <ServiceNowDevLink href={resolved.servicenow_url} sysId={resolved.sys_id} fullWidth />
              ) : (
                <p className="text-center text-xs text-muted-foreground">
                  Link do ServiceNow indisponível para este incidente.
                </p>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
