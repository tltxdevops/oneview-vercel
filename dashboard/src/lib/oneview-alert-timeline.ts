/**
 * OV-P0-112 — timeline operacional unificada do drawer (Histórico).
 * Não consulta ServiceNow. Usa alerta + history items + referência explícita.
 */

export type AlertTimelineKind =
  | "opened"
  | "acknowledged"
  | "comment"
  | "servicenow"
  | "recovery"
  | "other";

export type AlertTimelineEvent = {
  id: string;
  kind: AlertTimelineKind;
  label: string;
  occurred_at: string | null;
  description?: string | null;
  comment?: string | null;
  actor?: string | null;
  incident_number?: string | null;
  incident_sys_id?: string | null;
  incident_url?: string | null;
};

/**
 * Referência já validada pelo BFF para o episódio atual. A timeline nunca
 * recebe a referência bruta projetada do alerta, pois ela pode ser resultado
 * de enriquecimento antigo por host/descrição.
 */
export type AlertTimelineServiceNowReference = {
  number?: string | null;
  sys_id?: string | null;
  url?: string | null;
};

type TimelineOptions = {
  serviceNowReference?: AlertTimelineServiceNowReference | null;
};

type HistoryLike = {
  id?: string | null;
  event_type?: string | null;
  title?: string | null;
  description?: string | null;
  comment?: string | null;
  occurred_at?: string | null;
  actor_name?: string | null;
  ack_actor_name?: string | null;
  origin?: string | null;
};

type AlertLike = {
  id?: string | null;
  first_seen_at?: string | null;
  resolved_at?: string | null;
  acknowledged_source?: boolean | null;
  acknowledged_source_at?: string | null;
  acknowledged_at?: string | null;
  acknowledged_source_by?: string | null;
  acknowledged_by?: string | null;
  source_ack?: { comment?: string | null; actor_name?: string | null; acknowledged_at?: string | null } | null;
  servicenow_reference?: {
    number?: string | null;
    sys_id?: string | null;
    url?: string | null;
    extra_count?: number | null;
  } | null;
};

const INTERNAL_ORIGINS = new Set(["oneview_internal"]);

function safeActor(value?: string | null): string | null {
  const actor = String(value || "").trim();
  if (!actor || /^\d+$/.test(actor)) return null;
  if (/worker|oneview|sistema|system|reconcil/i.test(actor)) return null;
  return actor;
}

function asTime(value?: string | null): number {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

function kindFromHistory(eventType?: string | null): AlertTimelineKind {
  const value = String(eventType || "").toLowerCase();
  if (value === "problem_created" || value === "created_from_zabbix") return "opened";
  if (value === "acknowledged") return "acknowledged";
  if (value === "ack_message") return "comment";
  if (value === "recovered" || value === "recovery" || value === "resolved") return "recovery";
  if (value.includes("servicenow") || value.includes("incident")) return "servicenow";
  return "other";
}

export function historyEventLabel(eventType: string): string {
  const kind = kindFromHistory(eventType);
  if (kind === "opened") return "Abertura do alerta";
  if (kind === "acknowledged") return "ACK";
  if (kind === "comment") return "Comentário";
  if (kind === "recovery") return "Recovery";
  if (kind === "servicenow") return "Vínculo com ServiceNow";
  const value = String(eventType || "").toLowerCase();
  if (value === "severity_changed") return "Mudança de severidade";
  if (value === "maintenance") return "Manutenção";
  if (value === "suppressed") return "Supressão";
  if (value === "unsuppressed") return "Fim da supressão";
  return "Evento operacional";
}

export function filterPublicHistoryItems<T extends HistoryLike>(items: T[] | null | undefined): T[] {
  return (Array.isArray(items) ? items : []).filter((item) => {
    const type = String(item.event_type || "").toLowerCase();
    if (type === "internal_acknowledged") return false;
    if (INTERNAL_ORIGINS.has(String(item.origin || ""))) return false;
    return true;
  });
}

export function buildAlertOperationalTimeline(
  alert: AlertLike | null | undefined,
  historyItems: HistoryLike[] | null | undefined = [],
  { serviceNowReference = null }: TimelineOptions = {},
): AlertTimelineEvent[] {
  const episodeStartedAt = asTime(alert?.first_seen_at);
  const incidentNumber = String(serviceNowReference?.number || "").trim() || null;
  const incidentSysId = String(serviceNowReference?.sys_id || "").trim() || null;
  const incidentUrl = String(serviceNowReference?.url || "").trim() || null;
  const hasValidatedServiceNowReference = Boolean(incidentNumber || incidentSysId);
  const publicItems = filterPublicHistoryItems(historyItems).filter((item) => {
    if (kindFromHistory(item.event_type) !== "servicenow") return true;
    // Um evento histórico ServiceNow só é atual quando o BFF já confirmou uma
    // referência explícita válida e seu horário pertence ao episódio vigente.
    return hasValidatedServiceNowReference
      && episodeStartedAt !== Number.MAX_SAFE_INTEGER
      && asTime(item.occurred_at) >= episodeStartedAt;
  });
  const events: AlertTimelineEvent[] = publicItems.map((item, index) => {
    const kind = kindFromHistory(item.event_type);
    return {
      id: String(item.id || `history-${index}`),
      kind,
      label: String(item.title || "").trim() || historyEventLabel(String(item.event_type || "")),
      occurred_at: item.occurred_at || null,
      description: item.description || null,
      comment: item.comment || null,
      actor: safeActor(item.ack_actor_name || item.actor_name),
    };
  });

  const hasKind = (kind: AlertTimelineKind) => events.some((item) => item.kind === kind);
  const alertId = String(alert?.id || "alert");

  if (alert?.first_seen_at && !hasKind("opened")) {
    events.push({
      id: `${alertId}-opened`,
      kind: "opened",
      label: "Abertura do alerta",
      occurred_at: alert.first_seen_at,
    });
  }

  const ackAt = alert?.acknowledged_source_at || alert?.acknowledged_at || alert?.source_ack?.acknowledged_at || null;
  const ackActor = safeActor(
    alert?.acknowledged_source_by || alert?.acknowledged_by || alert?.source_ack?.actor_name || null,
  );
  if ((alert?.acknowledged_source || ackAt || ackActor) && !hasKind("acknowledged")) {
    events.push({
      id: `${alertId}-ack`,
      kind: "acknowledged",
      label: "ACK",
      occurred_at: ackAt,
      actor: ackActor,
      description: ackActor ? `Reconhecido por ${ackActor}` : "Alerta reconhecido",
    });
  }

  const ackComment = String(alert?.source_ack?.comment || "").trim();
  if (ackComment && !events.some((item) => item.kind === "comment" || String(item.comment || "").trim() === ackComment)) {
    events.push({
      id: `${alertId}-comment`,
      kind: "comment",
      label: "Comentário",
      occurred_at: ackAt,
      actor: ackActor,
      comment: ackComment,
    });
  }

  if (hasValidatedServiceNowReference && episodeStartedAt !== Number.MAX_SAFE_INTEGER && !hasKind("servicenow")) {
    events.push({
      id: `${alertId}-servicenow`,
      kind: "servicenow",
      label: "Vínculo com ServiceNow",
      occurred_at: alert?.first_seen_at || null,
      incident_number: incidentNumber,
      incident_sys_id: incidentSysId,
      incident_url: incidentUrl,
      description: incidentNumber
        ? incidentNumber
        : "Chamado relacionado",
    });
  }

  if (alert?.resolved_at && !hasKind("recovery")) {
    events.push({
      id: `${alertId}-recovery`,
      kind: "recovery",
      label: "Recovery",
      occurred_at: alert.resolved_at,
    });
  }

  return events.sort((left, right) => asTime(left.occurred_at) - asTime(right.occurred_at));
}
