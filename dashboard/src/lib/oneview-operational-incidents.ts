/**
 * Fila operacional de chamados (Home / Monitoramento).
 * Cobertura: sem responsável / com analista / todos.
 * Janela opened_from da página em todos os modos. Analistas = assigned_to do read-model.
 */
import {
  fetchIncidents,
  type IncidentAssigneeFacet,
  type IncidentListResponse,
  type OneViewIncident,
} from "@/lib/oneview-api";

export const OPERATIONAL_INCIDENT_STATES = "1,2,3";
export const OPERATIONAL_INCIDENTS_PAGE_SIZE = 100;
export const MAX_ASSIGNED_TO_IDS = 20;

export const INCIDENTS_QUEUE_MODE = {
  unassigned: "unassigned",
  assigned: "assigned",
  all: "all",
} as const;

export type IncidentsQueueMode = (typeof INCIDENTS_QUEUE_MODE)[keyof typeof INCIDENTS_QUEUE_MODE];

const SAFE_SYS_ID = /^[a-f0-9]{32}$/i;
const CLOSED_SN_STATES = new Set(["6", "7"]);

export function parseIncidentsQueueMode(value?: string | null): IncidentsQueueMode {
  if (value === INCIDENTS_QUEUE_MODE.assigned) return INCIDENTS_QUEUE_MODE.assigned;
  if (value === INCIDENTS_QUEUE_MODE.all) return INCIDENTS_QUEUE_MODE.all;
  return INCIDENTS_QUEUE_MODE.unassigned;
}

export function parseAssignedToSysId(value?: string | null): string | null {
  const ids = parseAssignedToSysIds(value);
  return ids[0] ?? null;
}

export function parseAssignedToSysIds(value?: string | string[] | null): string[] {
  const raw = Array.isArray(value) ? value.join(",") : String(value || "");
  const seen = new Set<string>();
  for (const token of raw.split(",")) {
    const id = token.trim().toLowerCase();
    if (!SAFE_SYS_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    if (seen.size >= MAX_ASSIGNED_TO_IDS) break;
  }
  return [...seen];
}

export function openedFromForWindow(windowMs: number, now = Date.now()): string {
  const start = new Date(now - Math.max(Number(windowMs) || 0, 0));
  if (Number.isNaN(start.getTime())) return new Date(now).toISOString().slice(0, 10);
  return start.toISOString().slice(0, 10);
}

export function prioritizeOperationalIncidents(items: OneViewIncident[]): OneViewIncident[] {
  const rank = (state: string) => {
    if (state === "1") return 0;
    if (state === "2") return 1;
    if (state === "3") return 2;
    return 9;
  };
  return items
    .filter((item) => !CLOSED_SN_STATES.has(String(item.state || "").trim()))
    .sort((left, right) => {
      const diff = rank(String(left.state || "").trim()) - rank(String(right.state || "").trim());
      if (diff !== 0) return diff;
      return Date.parse(String(right.opened_at || "")) - Date.parse(String(left.opened_at || ""));
    });
}

export async function fetchOperationalIncidents(params?: {
  mode?: IncidentsQueueMode | string | null;
  assignedTo?: string | string[] | null;
  limit?: number;
  windowMs?: number;
  from?: string;
  to?: string;
  now?: number;
  signal?: AbortSignal;
  sort?: "updated" | "opened" | "number" | "client" | "description" | "state" | "priority" | "group" | "assignee";
  order?: "asc" | "desc";
}): Promise<IncidentListResponse> {
  const mode = parseIncidentsQueueMode(params?.mode);
  const assignedIds = mode === INCIDENTS_QUEUE_MODE.unassigned
    ? []
    : parseAssignedToSysIds(params?.assignedTo);
  const assignedCsv = assignedIds.length ? assignedIds.join(",") : undefined;
  const openedFrom = params?.windowMs
    ? (params.from ?? openedFromForWindow(params.windowMs, params.now))
    : params?.from;

  const response = await fetchIncidents({
    page: 1,
    pageSize: Math.min(Math.max(Math.trunc(params?.limit ?? OPERATIONAL_INCIDENTS_PAGE_SIZE), 1), OPERATIONAL_INCIDENTS_PAGE_SIZE),
    unassigned: mode === INCIDENTS_QUEUE_MODE.unassigned ? true : undefined,
    assignedTo: assignedCsv,
    hasAssignee: mode === INCIDENTS_QUEUE_MODE.assigned && !assignedCsv ? true : undefined,
    includeUnassigned: mode === INCIDENTS_QUEUE_MODE.all && Boolean(assignedCsv) ? true : undefined,
    openedFrom,
    openedTo: params?.to,
    state: OPERATIONAL_INCIDENT_STATES,
    sort: params?.sort,
    order: params?.order,
    signal: params?.signal,
  });

  const openItems = (response.items ?? []).filter(
    (item) => !CLOSED_SN_STATES.has(String(item.state || "").trim()),
  );
  const items = params?.sort
    ? openItems
    : mode === INCIDENTS_QUEUE_MODE.unassigned
      ? prioritizeOperationalIncidents(openItems)
      : openItems.sort((left, right) => (
        Date.parse(String(right.opened_at || "")) - Date.parse(String(left.opened_at || ""))
      ));

  return {
    ...response,
    items,
  };
}

export function buildOperationalChamadosHref(params?: {
  mode?: IncidentsQueueMode | string | null;
  assignedTo?: string | string[] | null;
  from?: string;
  to?: string;
}): string {
  const mode = parseIncidentsQueueMode(params?.mode);
  const search = new URLSearchParams();
  if (mode === INCIDENTS_QUEUE_MODE.unassigned) search.set("unassigned", "true");
  const assignedTo = parseAssignedToSysIds(params?.assignedTo).join(",");
  if (mode !== INCIDENTS_QUEUE_MODE.unassigned && assignedTo) search.set("assigned_to", assignedTo);
  if (params?.from && params?.to) {
    search.set("period", "custom");
    search.set("from", params.from);
    search.set("to", params.to);
  }
  const query = search.toString();
  return `/chamados${query ? `?${query}` : ""}`;
}

export function applyIncidentsQueueToSearchParams(
  params: URLSearchParams,
  mode: IncidentsQueueMode,
  assignedTo?: string | string[] | null,
) {
  const ids = mode === INCIDENTS_QUEUE_MODE.unassigned ? [] : parseAssignedToSysIds(assignedTo);
  if (mode === INCIDENTS_QUEUE_MODE.unassigned) {
    params.delete("incidents");
    params.delete("assigned_to");
    return;
  }
  params.set("incidents", mode);
  if (ids.length) params.set("assigned_to", ids.join(","));
  else params.delete("assigned_to");
}

export function analystFacetOptions(facets?: IncidentAssigneeFacet[] | null): IncidentAssigneeFacet[] {
  return (facets || []).flatMap((item) => {
    const value = parseAssignedToSysId(item.value);
    if (!value) return [];
    return [{ ...item, value }];
  });
}
