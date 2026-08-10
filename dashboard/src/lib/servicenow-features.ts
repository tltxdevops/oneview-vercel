/**
 * SN-P0-07 — feature flag de Chamados / ServiceNow incidents (frontend).
 * Espelha SERVICENOW_INCIDENTS_ENABLED via VITE_SERVICENOW_INCIDENTS_ENABLED.
 */
export function isServiceNowIncidentsUiEnabled(): boolean {
  return String(import.meta.env.VITE_SERVICENOW_INCIDENTS_ENABLED || "").trim().toLowerCase() === "true";
}
