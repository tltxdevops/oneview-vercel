export const ONEVIEW_NOTIFICATION_PREFERENCES_VERSION = 1 as const;
export const ONEVIEW_NOTIFICATION_PREFERENCES_EVENT = "oneview:notification-preferences";

export type OneViewNotificationPreferences = {
  version: typeof ONEVIEW_NOTIFICATION_PREFERENCES_VERSION;
  reminderLinkPopup: boolean;
  reminderLinkSound: boolean;
};

export function defaultOneViewNotificationPreferences(): OneViewNotificationPreferences {
  return {
    version: ONEVIEW_NOTIFICATION_PREFERENCES_VERSION,
    reminderLinkPopup: true,
    reminderLinkSound: false,
  };
}

export function oneViewNotificationPreferencesStorageKey(actorId?: string | null) {
  const actor = String(actorId || "anonymous").trim() || "anonymous";
  return `oneview.notification-preferences.v1:${actor}`;
}

export function readOneViewNotificationPreferences(actorId?: string | null): OneViewNotificationPreferences {
  const fallback = defaultOneViewNotificationPreferences();
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(oneViewNotificationPreferencesStorageKey(actorId));
    if (!raw) return fallback;
    const value = JSON.parse(raw) as Partial<OneViewNotificationPreferences>;
    if (value.version !== ONEVIEW_NOTIFICATION_PREFERENCES_VERSION) return fallback;
    return {
      ...fallback,
      reminderLinkPopup: value.reminderLinkPopup !== false,
      reminderLinkSound: Boolean(value.reminderLinkSound),
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
