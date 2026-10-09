import { useCallback, useEffect, useMemo, useState } from "react";

const ALERT_TABLE_ACTIONS_VERSION = 1 as const;
const ACTION_ICON_PX = 30;
const ACTION_PAD_PX = 16;

export const ALERT_TABLE_ACTION_OPTIONS = [
  { id: "claim", label: "Assumir chamado", defaultVisible: true, requiresIncident: true },
  { id: "source_ack", label: "Reconhecer alerta", defaultVisible: true, requiresIncident: false },
  { id: "details", label: "Ver detalhes", defaultVisible: true, requiresIncident: false },
  { id: "work_note", label: "Adicionar anotação", defaultVisible: false, requiresIncident: true },
  { id: "put_on_hold", label: "Colocar em espera", defaultVisible: false, requiresIncident: true },
  { id: "attach_alert", label: "Anexar detalhes do alerta", defaultVisible: false, requiresIncident: true },
] as const;

export type AlertTableActionId = typeof ALERT_TABLE_ACTION_OPTIONS[number]["id"];
export const ALERT_INCIDENT_TABLE_ACTIONS = ["claim", "work_note", "put_on_hold", "attach_alert"] as const;
export type AlertIncidentTableActionId = typeof ALERT_INCIDENT_TABLE_ACTIONS[number];

type StoredAlertTableActions = {
  version: typeof ALERT_TABLE_ACTIONS_VERSION;
  visibility: Record<string, boolean>;
};

function defaultVisibility(): Record<AlertTableActionId, boolean> {
  return Object.fromEntries(
    ALERT_TABLE_ACTION_OPTIONS.map((action) => [action.id, action.defaultVisible]),
  ) as Record<AlertTableActionId, boolean>;
}

function normalizeAlertTableActions(candidate?: Partial<StoredAlertTableActions> | null): StoredAlertTableActions {
  const defaults = defaultVisibility();
  const visibility = Object.fromEntries(
    ALERT_TABLE_ACTION_OPTIONS.map((action) => [
      action.id,
      typeof candidate?.visibility?.[action.id] === "boolean"
        ? candidate.visibility[action.id]
        : defaults[action.id],
    ]),
  ) as Record<AlertTableActionId, boolean>;
  return { version: ALERT_TABLE_ACTIONS_VERSION, visibility };
}

export function oneViewAlertTableActionsKey(actorId?: string | null) {
  const actor = String(actorId || "anonymous").trim().toLowerCase() || "anonymous";
  return `oneview.table.alerts.actions.v${ALERT_TABLE_ACTIONS_VERSION}:${actor}`;
}

function readAlertTableActions(storageKey: string) {
  if (typeof window === "undefined") return normalizeAlertTableActions();
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return normalizeAlertTableActions();
    return normalizeAlertTableActions(JSON.parse(raw) as Partial<StoredAlertTableActions>);
  } catch {
    return normalizeAlertTableActions();
  }
}

export function alertTableActionsColumnWidth(visibleCount: number) {
  return Math.max(96, ACTION_PAD_PX + Math.max(1, visibleCount) * ACTION_ICON_PX);
}

export function useOneViewAlertTableActions({ actorId }: { actorId?: string | null }) {
  const storageKey = oneViewAlertTableActionsKey(actorId);
  const [preferences, setPreferences] = useState(() => readAlertTableActions(storageKey));
  const [readyStorageKey, setReadyStorageKey] = useState(storageKey);

  useEffect(() => {
    setPreferences(readAlertTableActions(storageKey));
    setReadyStorageKey(storageKey);
  }, [storageKey]);

  useEffect(() => {
    if (readyStorageKey !== storageKey) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(preferences));
    } catch {
      // Browser storage is optional; keep the in-memory preference.
    }
  }, [preferences, readyStorageKey, storageKey]);

  const visibility = preferences.visibility as Record<AlertTableActionId, boolean>;
  const orderedActions = useMemo(() => [...ALERT_TABLE_ACTION_OPTIONS], []);
  const visibleCount = orderedActions.filter((action) => visibility[action.id] !== false).length;
  const visibleIncidentActions = useMemo(
    () => ALERT_INCIDENT_TABLE_ACTIONS.filter((id) => visibility[id] !== false),
    [visibility],
  );

  const setVisible = useCallback((id: AlertTableActionId, visible: boolean) => {
    setPreferences((current) => ({
      ...current,
      visibility: { ...current.visibility, [id]: visible },
    }));
  }, []);

  const reset = useCallback(() => setPreferences(normalizeAlertTableActions()), []);

  return {
    orderedActions,
    visibility,
    visibleCount,
    visibleIncidentActions,
    columnWidth: alertTableActionsColumnWidth(visibleCount),
    setVisible,
    reset,
  };
}
