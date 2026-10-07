import type { SeverityPopupLevel } from "@/lib/oneview-notification-preferences";
import { readOneViewNotificationPreferences } from "@/lib/oneview-notification-preferences";

export const SEVERITY_POPUP_LABELS: Record<SeverityPopupLevel, string> = {
  disaster: "Disaster",
  high: "High",
  average: "Average",
};

export function normalizeSeverityPopupLevel(value?: string | null): SeverityPopupLevel | null {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "disaster") return "disaster";
  if (raw === "high" || raw === "critical") return "high";
  if (raw === "average") return "average";
  return null;
}

export function severityPopupMatches(level: SeverityPopupLevel | null, actorId?: string | null) {
  if (!level) return false;
  const preferences = readOneViewNotificationPreferences(actorId);
  return preferences.severityPopup.enabled && preferences.severityPopup.severities.includes(level);
}

function seenStorageKey(scope: string, actorId?: string | null) {
  const actor = String(actorId || "anonymous").trim() || "anonymous";
  return `oneview.severity-popup.seen.${scope}.${actor}`;
}

export function readSeverityPopupSeen(scope: string, actorId?: string | null) {
  if (typeof window === "undefined") return new Set<string>();
  try {
    const raw = window.localStorage.getItem(seenStorageKey(scope, actorId));
    const values = raw ? JSON.parse(raw) : [];
    return new Set<string>(Array.isArray(values) ? values.filter((value) => typeof value === "string") : []);
  } catch {
    return new Set<string>();
  }
}

export function writeSeverityPopupSeen(scope: string, seen: Set<string>, actorId?: string | null) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(seenStorageKey(scope, actorId), JSON.stringify([...seen].slice(-500)));
  } catch {
    // optional persistence
  }
}
