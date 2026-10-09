import type { DateRange } from "react-day-picker";
import { endOfDay, format, startOfDay } from "date-fns";
import type { FetchAlertsParams, OneViewSeverity } from "@/lib/oneview-api";

export type AlertsStatusFilter = "active" | "resolved" | "all";
export type AlertsAckFilter = "all" | "acknowledged" | "unacknowledged";
export type AlertsOneViewAckFilter = "all" | "pending" | "success" | "cancelled" | "failed";
export type AlertsDateField = "first_seen" | "last_seen" | "acknowledged" | "resolved";
export type AlertsSearchField = "all" | "host" | "problem" | "customer" | "eventid";
export type AlertsDatePreset =
  | "all"
  | "15m"
  | "30m"
  | "1h"
  | "2h"
  | "6h"
  | "24h"
  | "7d"
  | "30d"
  | "custom";
export type AlertsSortKey =
  | "first_seen_at"
  | "last_seen_at"
  | "severity"
  | "duration"
  | "acknowledged_at"
  | "resolved_at";

export const ALERTS_DATE_FIELD_OPTIONS: Array<{ id: AlertsDateField; label: string }> = [
  { id: "first_seen", label: "Início" },
  { id: "last_seen", label: "Última atualização" },
  { id: "acknowledged", label: "ACK" },
  { id: "resolved", label: "Recuperação" },
];

export const ALERTS_SEARCH_FIELD_OPTIONS: Array<{ id: AlertsSearchField; label: string }> = [
  { id: "all", label: "Todos" },
  { id: "host", label: "Host" },
  { id: "problem", label: "Problema" },
  { id: "customer", label: "Cliente" },
  { id: "eventid", label: "Event ID" },
];

export const ALERTS_SORT_OPTIONS: Array<{ id: AlertsSortKey; order: "asc" | "desc"; label: string }> = [
  { id: "first_seen_at", order: "desc", label: "Mais recentes" },
  { id: "first_seen_at", order: "asc", label: "Mais antigos" },
  { id: "severity", order: "desc", label: "Maior severidade" },
  { id: "duration", order: "desc", label: "Maior duração" },
  { id: "acknowledged_at", order: "desc", label: "ACK mais recente" },
  { id: "resolved_at", order: "desc", label: "Recuperação mais recente" },
];

export const ALERTS_DATE_PRESET_OPTIONS: Array<{ id: Exclude<AlertsDatePreset, "all" | "custom">; label: string }> = [
  { id: "15m", label: "Últimos 15 minutos" },
  { id: "30m", label: "Últimos 30 minutos" },
  { id: "1h", label: "Última 1 hora" },
  { id: "2h", label: "Últimas 2 horas" },
  { id: "6h", label: "Últimas 6 horas" },
  { id: "24h", label: "Últimas 24 horas" },
  { id: "7d", label: "Últimos 7 dias" },
  { id: "30d", label: "Últimos 30 dias" },
];

const DATE_PRESET_MS: Record<Exclude<AlertsDatePreset, "all" | "custom">, number> = {
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "2h": 2 * 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

function isCalendarDateOnly(value: Date) {
  return value.getHours() === 0
    && value.getMinutes() === 0
    && value.getSeconds() === 0
    && value.getMilliseconds() === 0;
}

export function alertsDateBounds(preset: AlertsDatePreset, range?: DateRange, now = Date.now()) {
  if (preset === "custom") {
    const from = range?.from
      ? (isCalendarDateOnly(range.from) ? startOfDay(range.from).toISOString() : range.from.toISOString())
      : undefined;
    const to = range?.to
      ? (isCalendarDateOnly(range.to) ? endOfDay(range.to).toISOString() : range.to.toISOString())
      : range?.from && isCalendarDateOnly(range.from)
        ? endOfDay(range.from).toISOString()
        : undefined;
    return { from, to };
  }
  if (preset === "all") return {};
  return { from: new Date(now - DATE_PRESET_MS[preset]).toISOString(), to: new Date(now).toISOString() };
}

export function alertsDateActive(preset: AlertsDatePreset, range?: DateRange) {
  if (preset === "all") return false;
  if (preset === "custom") return Boolean(range?.from || range?.to);
  return true;
}

export function formatAlertsDateUrlValue(value: Date) {
  return isCalendarDateOnly(value) ? format(value, "yyyy-MM-dd") : value.toISOString();
}

export function parseAlertsDateUrlValue(value: string | null) {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function applyDateFieldToFetchParams(
  params: FetchAlertsParams,
  dateField: AlertsDateField,
  bounds: { from?: string; to?: string },
): FetchAlertsParams {
  const next = { ...params };
  if (dateField === "first_seen") {
    next.firstSeenFrom = bounds.from;
    next.firstSeenTo = bounds.to;
  } else if (dateField === "last_seen") {
    next.lastSeenFrom = bounds.from;
    next.lastSeenTo = bounds.to;
  } else if (dateField === "acknowledged") {
    next.acknowledgedFrom = bounds.from;
    next.acknowledgedTo = bounds.to;
  } else {
    next.resolvedFrom = bounds.from;
    next.resolvedTo = bounds.to;
  }
  return next;
}

export function applySearchToFetchParams(
  params: FetchAlertsParams,
  searchField: AlertsSearchField,
  search: string,
): FetchAlertsParams {
  const value = search.trim();
  if (!value) return params;
  const next = { ...params };
  if (searchField === "host") next.hostSearch = value;
  else if (searchField === "problem") next.problemSearch = value;
  else {
    next.search = value;
    next.searchField = searchField === "all" ? undefined : searchField;
  }
  return next;
}

export function sortOptionKey(sort: AlertsSortKey, order: "asc" | "desc") {
  return `${sort}:${order}`;
}

export function parseSortOptionKey(value: string | null): { sort: AlertsSortKey; order: "asc" | "desc" } | null {
  if (!value) return null;
  const [sort, order] = value.split(":");
  if (!sort || (order !== "asc" && order !== "desc")) return null;
  if (!ALERTS_SORT_OPTIONS.some((item) => item.id === sort && item.order === order)) return null;
  return { sort: sort as AlertsSortKey, order };
}

export const FIRST_ALERTS_PAGE_SIZE = 10;
export const ALERT_LIST_INCLUDE_ITEMS = "items";
export const ALERT_LIST_INCLUDE_SUMMARY = "summary,temporal";

export const DEFAULT_ALERTS_FETCH = {
  view: "recent",
  status: "active" as const,
  dateField: "first_seen" as const,
  datePreset: "all" as const,
  sort: "first_seen_at" as const,
  order: "desc" as const,
  page: 1,
  pageSize: 50,
};

export function defaultAlertsFetchParams(now = Date.now()): FetchAlertsParams {
  return applyDateFieldToFetchParams({
    page: DEFAULT_ALERTS_FETCH.page,
    pageSize: DEFAULT_ALERTS_FETCH.pageSize,
    status: DEFAULT_ALERTS_FETCH.status,
    sort: DEFAULT_ALERTS_FETCH.sort,
    order: DEFAULT_ALERTS_FETCH.order,
  }, DEFAULT_ALERTS_FETCH.dateField, alertsDateBounds(DEFAULT_ALERTS_FETCH.datePreset, undefined, now));
}

export function firstAlertsFetchParams(now = Date.now()): FetchAlertsParams {
  return {
    ...defaultAlertsFetchParams(now),
    pageSize: FIRST_ALERTS_PAGE_SIZE,
    include: ALERT_LIST_INCLUDE_ITEMS,
  };
}

export function isDefaultAlertsWarmQuery(state: {
  view?: string;
  status: string;
  dateField: string;
  datePreset: string;
  sort: string;
  order: string;
  page: number;
  pageSize: number;
  customers: string[];
  datasources?: string[];
  severities: string[];
  acknowledgedSource: string;
  oneviewAckStatus?: string;
  ackActor?: string;
  search: string;
}) {
  return (state.view ?? DEFAULT_ALERTS_FETCH.view) === DEFAULT_ALERTS_FETCH.view
    && state.status === DEFAULT_ALERTS_FETCH.status
    && state.dateField === DEFAULT_ALERTS_FETCH.dateField
    && state.datePreset === DEFAULT_ALERTS_FETCH.datePreset
    && state.sort === DEFAULT_ALERTS_FETCH.sort
    && state.order === DEFAULT_ALERTS_FETCH.order
    && state.page === DEFAULT_ALERTS_FETCH.page
    && state.pageSize === DEFAULT_ALERTS_FETCH.pageSize
    && state.customers.length === 0
    && !(state.datasources?.length)
    && state.severities.length === 0
    && state.acknowledgedSource === "all"
    && (state.oneviewAckStatus ?? "all") === "all"
    && !(state.ackActor ?? "").trim()
    && !state.search.trim();
}

export type AlertsUrlState = {
  view?: string;
  customers: string[];
  datasources?: string[];
  severities: OneViewSeverity[];
  status: AlertsStatusFilter;
  incidentState?: "all" | "8";
  incidentStates?: string[];
  incidentNumber?: string;
  acknowledgedSource: AlertsAckFilter;
  oneviewAckStatus: AlertsOneViewAckFilter;
  oneviewAckStatuses?: Array<Exclude<AlertsOneViewAckFilter, "all"> | "processing">;
  ackActor?: string;
  hostSearch?: string;
  problemSearch?: string;
  dateField: AlertsDateField;
  datePreset: AlertsDatePreset;
  dateRange?: DateRange;
  searchField: AlertsSearchField;
  search: string;
  sort: AlertsSortKey;
  order: "asc" | "desc";
  page: number;
  pageSize: number;
  alert?: string | null;
};

export function writeAlertsUrlParams(state: AlertsUrlState) {
  const next = new URLSearchParams();
  if (state.view) next.set("view", state.view);
  for (const customer of state.customers) next.append("customer", customer);
  for (const datasource of state.datasources ?? []) next.append("datasource", datasource);
  for (const severity of state.severities) next.append("severity", severity);
  if (state.status) next.set("status", state.status);
  if (state.incidentStates?.length) for (const value of state.incidentStates) next.append("incident_state", value);
  else if (state.incidentState && state.incidentState !== "all") next.set("incident_state", state.incidentState);
  if (state.incidentNumber?.trim()) next.set("incident_number", state.incidentNumber.trim().toUpperCase());
  if (state.acknowledgedSource === "acknowledged") next.set("acknowledged_source", "true");
  if (state.acknowledgedSource === "unacknowledged") next.set("acknowledged_source", "false");
  if (state.acknowledgedSource === "all") {
    // omit
  }
  if (state.oneviewAckStatuses?.length) for (const value of state.oneviewAckStatuses) next.append("oneview_ack_status", value);
  else if (state.oneviewAckStatus !== "all") next.set("oneview_ack_status", state.oneviewAckStatus);
  if (state.ackActor?.trim()) next.set("ack_actor", state.ackActor.trim());
  if (state.hostSearch?.trim()) next.set("host_search", state.hostSearch.trim());
  if (state.problemSearch?.trim()) next.set("problem_search", state.problemSearch.trim());
  next.set("date_field", state.dateField);
  if (state.datePreset !== "all" && state.datePreset !== "custom") next.set("date_preset", state.datePreset);
  if (state.datePreset === "custom") {
    if (state.dateRange?.from) next.set("date_from", formatAlertsDateUrlValue(state.dateRange.from));
    if (state.dateRange?.to) next.set("date_to", formatAlertsDateUrlValue(state.dateRange.to));
    else if (state.dateRange?.from) next.set("date_to", formatAlertsDateUrlValue(state.dateRange.from));
  }
  if (state.searchField !== "all") next.set("search_field", state.searchField);
  if (state.search.trim()) next.set("search", state.search.trim());
  next.set("sort", state.sort);
  next.set("order", state.order);
  if (state.page > 1) next.set("page", String(state.page));
  if (state.pageSize !== 50) next.set("page_size", String(state.pageSize));
  if (state.alert) next.set("alert", state.alert);
  return next;
}
