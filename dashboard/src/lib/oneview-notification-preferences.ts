export const ONEVIEW_NOTIFICATION_PREFERENCES_VERSION = 1 as const;
export const ONEVIEW_NOTIFICATION_PREFERENCES_EVENT = "oneview:notification-preferences";

export type SeverityPopupLevel = "disaster" | "high" | "average";

export const SEVERITY_POPUP_LEVELS: SeverityPopupLevel[] = ["disaster", "high", "average"];

export type OneViewNotificationPreferences = {
  version: typeof ONEVIEW_NOTIFICATION_PREFERENCES_VERSION;
  reminderLinkPopup: boolean;
  reminderLinkSound: boolean;
  severityPopup: {
    enabled: boolean;
    severities: SeverityPopupLevel[];
  };
};

export function defaultOneViewNotificationPreferences(): OneViewNotificationPreferences {
  return {
    version: ONEVIEW_NOTIFICATION_PREFERENCES_VERSION,
    reminderLinkPopup: true,
    reminderLinkSound: false,
    severityPopup: {
      enabled: true,
      severities: ["disaster"],
    },
  };
}

export function oneViewNotificationPreferencesStorageKey(actorId?: string | null) {
  const actor = String(actorId || "anonymous").trim() || "anonymous";
  return `oneview.notification-preferences.v1:${actor}`;
}

function sanitizeSeverityList(value: unknown): SeverityPopupLevel[] {
  if (!Array.isArray(value)) return ["disaster"];
  const next = SEVERITY_POPUP_LEVELS.filter((level) => value.includes(level));
  return next.length ? next : ["disaster"];
}

export function readOneViewNotificationPreferences(actorId?: string | null): OneViewNotificationPreferences {
  const fallback = defaultOneViewNotificationPreferences();
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(oneViewNotificationPreferencesStorageKey(actorId));
    if (!raw) return fallback;
    const value = JSON.parse(raw) as Partial<OneViewNotificationPreferences> & {
      operatorDisasterPopup?: boolean;
    };
    if (value.version !== ONEVIEW_NOTIFICATION_PREFERENCES_VERSION) return fallback;
    const migratedEnabled = value.severityPopup?.enabled
      ?? (value.operatorDisasterPopup !== false);
    return {
      ...fallback,
      reminderLinkPopup: value.reminderLinkPopup !== false,
      reminderLinkSound: Boolean(value.reminderLinkSound),
      severityPopup: {
        enabled: migratedEnabled !== false,
        severities: sanitizeSeverityList(value.severityPopup?.severities),
      },
    };
  } catch {
    return fallback;
  }
}

export function writeOneViewNotificationPreferences(
  preferences: OneViewNotificationPreferences,
  actorId?: string | null,
) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(oneViewNotificationPreferencesStorageKey(actorId), JSON.stringify(preferences));
    window.dispatchEvent(new Event(ONEVIEW_NOTIFICATION_PREFERENCES_EVENT));
  } catch {
    // optional persistence
  }
}

export function setOneViewReminderLinkSound(enabled: boolean, actorId?: string | null) {
  const next = { ...readOneViewNotificationPreferences(actorId), reminderLinkSound: enabled };
  writeOneViewNotificationPreferences(next, actorId);
  return next;
}

export function setOneViewReminderLinkPopup(enabled: boolean, actorId?: string | null) {
  const next = { ...readOneViewNotificationPreferences(actorId), reminderLinkPopup: enabled };
  writeOneViewNotificationPreferences(next, actorId);
  return next;
}

export function setOneViewSeverityPopupEnabled(enabled: boolean, actorId?: string | null) {
  const current = readOneViewNotificationPreferences(actorId);
  const next = {
    ...current,
    severityPopup: { ...current.severityPopup, enabled },
  };
  writeOneViewNotificationPreferences(next, actorId);
  return next;
}

export function setOneViewSeverityPopupLevels(severities: SeverityPopupLevel[], actorId?: string | null) {
  const current = readOneViewNotificationPreferences(actorId);
  const next = {
    ...current,
    severityPopup: {
      ...current.severityPopup,
      severities: sanitizeSeverityList(severities),
    },
  };
  writeOneViewNotificationPreferences(next, actorId);
  return next;
}

export function toggleOneViewSeverityPopupLevel(level: SeverityPopupLevel, actorId?: string | null) {
  const current = readOneViewNotificationPreferences(actorId);
  const selected = new Set(current.severityPopup.severities);
  if (selected.has(level)) selected.delete(level);
  else selected.add(level);
  return setOneViewSeverityPopupLevels(SEVERITY_POPUP_LEVELS.filter((item) => selected.has(item)), actorId);
}
