export const CENTRAL_ALERTAS_PATH = "/central-alertas";

export function centralAlertasHref(search?: string | URLSearchParams): string {
  const params = search instanceof URLSearchParams
    ? search
    : new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const query = params.toString();
  return query ? `${CENTRAL_ALERTAS_PATH}?${query}` : CENTRAL_ALERTAS_PATH;
}

export function centralAlertasHistoryHref(search?: string | URLSearchParams): string {
  const params = search instanceof URLSearchParams
    ? new URLSearchParams(search)
    : new URLSearchParams(String(search || "").replace(/^\?/, ""));
  if (!params.get("view")) params.set("view", "history");
  return centralAlertasHref(params);
}
