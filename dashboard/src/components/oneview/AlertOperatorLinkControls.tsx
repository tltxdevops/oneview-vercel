import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bell, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  cancelOperatorReminder,
  createOperatorReminder,
  fetchOperatorReminders,
  getCachedOperatorReminders,
  updateOperatorReminder,
  ONEVIEW_SEVERITY_CATALOG,
  type CanonicalLink,
  type OneViewAlert,
  type OneViewSeverity,
  type OperatorReminder,
} from "@/lib/oneview-api";
import { operadorasAlertLinkPath } from "@/lib/oneview-operator-reminder-notification";
import { SNAPSHOT_MUTATION_UNAVAILABLE_REASON } from "@/lib/oneview-snapshot-actions";

function localDateTime(value?: string | null) {
  const date = value ? new Date(value) : new Date(Date.now() + 60 * 60_000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

function alertSeverity(alert: OneViewAlert): OneViewSeverity {
  const value = String(alert.severity || "").toLowerCase();
  if (value === "critical") return "high";
  if (value in ONEVIEW_SEVERITY_CATALOG) return value as OneViewSeverity;
  return "not_classified";
}

function reminderNotifyWebex(reminder: OperatorReminder | null) {
  const snapshot = reminder?.context_snapshot as { reminder?: { notify_webex?: unknown } } | undefined;
  return snapshot?.reminder?.notify_webex === true || reminder?.notify_webex === true;
}

function reminderIdentity(alert: OneViewAlert): CanonicalLink | null {
  const link = alert.operator_link;
  if (!link) return null;
  const active = alert.alert_status !== "resolved" && !alert.resolved_at;
  const severity = alertSeverity(alert);
  return {
    id: link.id,
    circuit_key: link.circuit_key,
    resolution_status: link.resolution_status,
    data_source_id: link.data_source_id,
    datasource: alert.datasource_name || link.data_source_id,
    source_host_id: link.source_host_id,
    host_name: alert.host_visible_name || alert.host_name,
    customer_key: alert.customer_key || "unclassified",
    customer_name: alert.customer_name || alert.client_name || "Cliente não identificado",
    service_name: link.service_name || alert.problem_name,
    classification: "operator_link",
    classification_source: "alert_tags",
    classification_confidence: "high",
    site_key: null,
    site_name: link.site_name,
    link_type: link.link_type,
    member_key: link.member_key,
    healthcheck_key: null,
    uplink_key: link.uplink_key,
    endpoint_ip: null,
    carrier_name: link.carrier_name,
    carrier_source: link.carrier_name ? "alert_evidence" : null,
    carrier_reference: null,
    strategy: "alert_read_model",
    confidence: "high",
    trigger_ids: [link.source_trigger_id],
    alert_ids: [alert.id],
    source_metadata: null,
    updated_at: alert.updated_at,
    active_alerts: active ? 1 : 0,
    unack_alerts: active && !alert.acknowledged_source ? 1 : 0,
    high_alerts: active && severity === "high" ? 1 : 0,
    disaster_alerts: active && severity === "disaster" ? 1 : 0,
    average_alerts: active && severity === "average" ? 1 : 0,
    warning_alerts: active && severity === "warning" ? 1 : 0,
    state: severity === "disaster" ? "critical" : active ? "alert" : "normal",
    max_severity: severity,
    incident_count: alert.servicenow_reference?.number ? 1 : 0,
    operational_subject: link.operational_subject,
  };
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Não foi possível atualizar o lembrete.";
}

export function AlertOperatorLinkControls({ alert, compact = false, mutationsBlocked = false }: { alert: OneViewAlert; compact?: boolean; mutationsBlocked?: boolean }) {
  const link = useMemo(() => reminderIdentity(alert), [alert]);
  const [open, setOpen] = useState(false);
  const [reminders, setReminders] = useState<OperatorReminder[]>(() => link ? getCachedOperatorReminders(link) || [] : []);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initial = localDateTime();
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [message, setMessage] = useState("");
  const [notifyWebex, setNotifyWebex] = useState(false);
  const reminder = reminders[0] || null;
  const active = Boolean(link && Number(link.active_alerts) > 0);

  const load = useCallback(async () => {
    if (!link) return;
    setLoading(true);
    setError(null);
    try {
      setReminders(await fetchOperatorReminders(link, { force: true }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [link]);

  useEffect(() => {
    setReminders(link ? getCachedOperatorReminders(link) || [] : []);
    setOpen(false);
    setError(null);
  }, [alert.id, link]);

  const openEditor = () => {
    if (mutationsBlocked) return;
    const values = localDateTime(reminder?.scheduled_for);
    setDate(values.date);
    setTime(values.time);
    setMessage(reminder?.message || "");
    setNotifyWebex(reminderNotifyWebex(reminder));
    setError(null);
    setOpen(true);
    void load();
  };

  const save = async () => {
    if (mutationsBlocked || !link) return;
    const scheduledFor = new Date(`${date}T${time}:00`);
    if (!date || !time || Number.isNaN(scheduledFor.getTime()) || scheduledFor.getTime() <= Date.now()) {
      setError("Escolha uma data e horário futuros.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const options = { message: notifyWebex ? message.trim() : "", notifyWebex };
      const saved = reminder
        ? await updateOperatorReminder(link, reminder.id, scheduledFor.toISOString(), options)
        : await createOperatorReminder(link, scheduledFor.toISOString(), options);
      setReminders([saved]);
      setOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const cancel = async () => {
    if (mutationsBlocked || !link || !reminder) return;
    setSaving(true);
    setError(null);
    try {
      await cancelOperatorReminder(link, reminder.id);
      setReminders([]);
      setOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  if (!link || !alert.operator_link) return null;
  const path = operadorasAlertLinkPath(alert);
  const meta = [alert.operator_link.carrier_name, alert.operator_link.link_type, alert.operator_link.site_name].filter(Boolean).join(" · ");
  const editor = (
    <Popover open={open} onOpenChange={(next) => { if (!next) setOpen(false); }}>
      <PopoverTrigger asChild>
        <Button type="button" size={compact ? "icon" : "sm"} variant="outline" className={compact ? "h-7 w-7" : undefined} disabled={mutationsBlocked || !active || reminder?.status === "processing"} title={mutationsBlocked ? SNAPSHOT_MUTATION_UNAVAILABLE_REASON : undefined} onClick={openEditor} aria-label={mutationsBlocked ? SNAPSHOT_MUTATION_UNAVAILABLE_REASON : "Lembrar sobre link de operadora"}>
          <Bell className="h-4 w-4" />{compact ? <span className="sr-only">Lembrar</span> : reminder ? "Alterar lembrete" : "Lembrar"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] space-y-3">
        <div>
          <p className="font-medium">Lembrar no horário exato</p>
          <p className="text-xs text-muted-foreground">Pop-up no horário exato; Webex pode sair até 30s antes.</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1 text-xs text-muted-foreground">Data<Input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
          <label className="grid gap-1 text-xs text-muted-foreground">Horário<Input type="time" step="60" value={time} onChange={(event) => setTime(event.target.value)} /></label>
        </div>
        <label className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          Enviar mensagem Webex/Theo
          <Switch checked={notifyWebex} onCheckedChange={setNotifyWebex} aria-label="Enviar mensagem Webex/Theo" />
        </label>
        {notifyWebex ? (
          <label className="grid gap-1 text-xs text-muted-foreground">
            Mensagem opcional
            <Textarea value={message} maxLength={500} onChange={(event) => setMessage(event.target.value)} placeholder="Ex.: Validar retorno com a operadora e atualizar o chamado." />
          </label>
        ) : null}
        {loading ? <p className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Consultando lembrete…</p> : null}
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          {reminder?.status === "scheduled" ? <Button size="sm" variant="ghost" disabled={saving} onClick={() => void cancel()}>Cancelar lembrete</Button> : null}
          <Button size="sm" disabled={saving || loading} onClick={() => void save()}>{saving ? "Salvando..." : reminder ? "Salvar" : "Agendar"}</Button>
        </div>
      </PopoverContent>
    </Popover>
  );

  if (compact) {
    return (
      <div className="flex items-center gap-0.5">
        <Button asChild type="button" size="icon" variant="ghost" className="h-7 w-7">
          <Link to={path} aria-label="Abrir link de operadora"><ExternalLink className="h-4 w-4" /></Link>
        </Button>
        {editor}
      </div>
    );
  }
  return (
    <section aria-label="Link de operadora" className="space-y-2">
      <h3 className="text-sm font-semibold">Link de operadora</h3>
      <div className="rounded-lg border border-border/60 p-3">
        <p className="text-sm font-medium">{alert.operator_link.service_name || alert.problem_name}</p>
        <p className="mt-1 text-xs text-muted-foreground">{meta || "Identidade derivada das tags persistidas"}</p>
        {reminder ? <p className="mt-2 text-xs text-muted-foreground">Lembrete agendado para {new Date(reminder.scheduled_for).toLocaleString("pt-BR")}.</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button asChild size="sm" variant="secondary"><Link to={path}><ExternalLink className="h-4 w-4" />Abrir em Links</Link></Button>
          {editor}
        </div>
      </div>
    </section>
  );
}
