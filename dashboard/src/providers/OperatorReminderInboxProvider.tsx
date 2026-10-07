import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { OperatorReminderInboxToastStack, type ReminderInboxToastRecord } from "@/components/oneview/OperatorReminderInboxToast";
import { useAuthContext } from "@/context/AuthContext";
import { fetchOperatorReminderInbox, type OperatorReminderInboxItem } from "@/lib/oneview-api";
import {
  ONEVIEW_NOTIFICATION_PREFERENCES_EVENT,
  readOneViewNotificationPreferences,
  setOneViewReminderLinkPopup,
} from "@/lib/oneview-notification-preferences";
import {
  operadorasReminderLinkPath,
  playReminderLinkSound,
  reminderInboxEventKey,
} from "@/lib/oneview-operator-reminder-notification";

const POLL_MS = 20_000;

function inboxSinceStorageKey(actorId: string) {
  return `oneview.reminder-inbox.since.${actorId}`;
}

function inboxSeenStorageKey(actorId: string) {
  return `oneview.reminder-inbox.seen.${actorId}`;
}

function inboxOpenStorageKey(actorId: string) {
  return `oneview.reminder-inbox.open.${actorId}`;
}

function readSince(actorId: string) {
  if (typeof window === "undefined") return new Date().toISOString();
  const stored = sessionStorage.getItem(inboxSinceStorageKey(actorId));
  if (stored) return stored;
  const initial = new Date().toISOString();
  sessionStorage.setItem(inboxSinceStorageKey(actorId), initial);
  return initial;
}

function writeSince(actorId: string, value: string) {
  sessionStorage.setItem(inboxSinceStorageKey(actorId), value);
}

function readSeen(actorId: string) {
  if (typeof window === "undefined") return new Set<string>();
  try {
    const raw = sessionStorage.getItem(inboxSeenStorageKey(actorId));
    if (!raw) return new Set<string>();
    const list = JSON.parse(raw) as string[];
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set<string>();
  }
}

function writeSeen(actorId: string, seen: Set<string>) {
  const list = [...seen].slice(-500);
  sessionStorage.setItem(inboxSeenStorageKey(actorId), JSON.stringify(list));
}

function readOpen(actorId: string): ReminderInboxToastRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(inboxOpenStorageKey(actorId));
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.filter((item): item is ReminderInboxToastRecord => (
      item && typeof item === "object" && typeof item.toastId === "string" &&
      typeof item.id === "string" && typeof item.title === "string" &&
      typeof item.body === "string" && (item.phase === "fired" || item.phase === "delivered")
    ));
  } catch {
    return [];
  }
}

function writeOpen(actorId: string, items: ReminderInboxToastRecord[]) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(inboxOpenStorageKey(actorId), JSON.stringify(items));
  } catch {
    // Session storage is optional.
  }
}

function advanceSince(current: string, items: OperatorReminderInboxItem[], checkedAt?: string) {
  const candidates = [...items.map((item) => item.occurred_at), checkedAt].filter(Boolean) as string[];
  if (!candidates.length) return current;
  const max = candidates.reduce((best, value) => (value > best ? value : best), current);
  return max > current ? max : current;
}

export function OperatorReminderInboxProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuthContext();
  const actorId = user?.id || user?.email || "";
  const navigate = useNavigate();
  const [toasts, setToasts] = useState<ReminderInboxToastRecord[]>([]);
  const [popupEnabled, setPopupEnabled] = useState(true);
  const seenRef = useRef<Set<string>>(new Set());
  const sinceRef = useRef<string>("");
  const pollingRef = useRef(false);
  const serverOffsetRef = useRef(0);
  const upcomingTimersRef = useRef(new Map<string, { scheduledFor: string; timer: number }>());

  useEffect(() => {
    if (!actorId) {
      setToasts([]);
      return;
    }
    seenRef.current = readSeen(actorId);
    sinceRef.current = readSince(actorId);
    const preferences = readOneViewNotificationPreferences(actorId);
    setPopupEnabled(preferences.reminderLinkPopup);
    setToasts(preferences.reminderLinkPopup ? readOpen(actorId) : []);
    return () => {
      for (const entry of upcomingTimersRef.current.values()) window.clearTimeout(entry.timer);
      upcomingTimersRef.current.clear();
    };
  }, [actorId]);

  useEffect(() => {
    if (!actorId) return;
    const syncPreferences = () => {
      const enabled = readOneViewNotificationPreferences(actorId).reminderLinkPopup;
      setPopupEnabled(enabled);
      if (!enabled) {
        setToasts([]);
        writeOpen(actorId, []);
      }
    };
    window.addEventListener(ONEVIEW_NOTIFICATION_PREFERENCES_EVENT, syncPreferences);
    return () => window.removeEventListener(ONEVIEW_NOTIFICATION_PREFERENCES_EVENT, syncPreferences);
  }, [actorId]);

  const pushToast = useCallback((item: OperatorReminderInboxItem) => {
    if (!popupEnabled) return;
    const toastId = `${item.id}:${item.phase}:${item.occurred_at}`;
    setToasts((prev) => {
      if (prev.some((entry) => entry.toastId === toastId)) return prev;
      const next = [{ ...item, toastId }, ...prev];
      writeOpen(actorId, next);
      return next;
    });
    playReminderLinkSound(actorId);
  }, [actorId, popupEnabled]);

  const fireUpcoming = useCallback((item: OperatorReminderInboxItem) => {
    const key = reminderInboxEventKey(item.id, "fired");
    upcomingTimersRef.current.delete(item.id);
    if (seenRef.current.has(key)) return;
    seenRef.current.add(key);
    seenRef.current.add(reminderInboxEventKey(item.id, "delivered"));
    writeSeen(actorId, seenRef.current);
    pushToast({ ...item, phase: "fired", occurred_at: item.scheduled_for || item.occurred_at });
  }, [actorId, pushToast]);

  const scheduleUpcoming = useCallback((item: OperatorReminderInboxItem) => {
    const scheduledFor = item.scheduled_for || item.occurred_at;
    const scheduledAt = Date.parse(scheduledFor);
    if (!Number.isFinite(scheduledAt)) return;
    const existing = upcomingTimersRef.current.get(item.id);
    if (existing?.scheduledFor === scheduledFor) return;
    if (existing) window.clearTimeout(existing.timer);
    const serverNow = Date.now() + serverOffsetRef.current;
    const delay = Math.max(0, scheduledAt - serverNow);
    const timer = window.setTimeout(() => fireUpcoming(item), delay);
    upcomingTimersRef.current.set(item.id, { scheduledFor, timer });
  }, [fireUpcoming]);

  const poll = useCallback(async () => {
    if (!actorId || pollingRef.current) return;
    pollingRef.current = true;
    const since = sinceRef.current || readSince(actorId);
    try {
      const result = await fetchOperatorReminderInbox({ since });
      const checkedAt = Date.parse(String(result.checked_at || ""));
      if (Number.isFinite(checkedAt)) serverOffsetRef.current = checkedAt - Date.now();
      const seen = seenRef.current;
      let advanced = since;
      for (const item of result.items) {
        const key = reminderInboxEventKey(item.id, item.phase);
        if (seen.has(key)) continue;
        const scheduledAt = Date.parse(String(item.scheduled_for || ""));
        if (Number.isFinite(scheduledAt) && scheduledAt > Date.now() + serverOffsetRef.current) {
          scheduleUpcoming({ ...item, scheduled_for: item.scheduled_for || item.occurred_at, phase: "fired" });
          continue;
        }
        seen.add(key);
        pushToast(item);
        advanced = advanceSince(advanced, [item], result.checked_at);
      }
      const upcomingIds = new Set((result.upcoming || []).map((item) => item.id));
      for (const item of result.upcoming || []) scheduleUpcoming(item);
      for (const [id, entry] of upcomingTimersRef.current) {
        if (upcomingIds.has(id)) continue;
        const scheduledAt = Date.parse(entry.scheduledFor);
        if (Number.isFinite(scheduledAt) && scheduledAt > Date.now() + serverOffsetRef.current) continue;
        window.clearTimeout(entry.timer);
        upcomingTimersRef.current.delete(id);
      }
      if (!result.items.length && result.checked_at) {
        advanced = advanceSince(advanced, [], result.checked_at);
      }
      sinceRef.current = advanced;
      writeSince(actorId, advanced);
      seenRef.current = seen;
      writeSeen(actorId, seen);
    } catch {
      // silent poll failures; next tick retries
    } finally {
      pollingRef.current = false;
    }
  }, [actorId, pushToast, scheduleUpcoming]);

  useEffect(() => {
    if (!actorId) return;
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
    };
  }, [actorId, poll]);

  const dismissToast = useCallback((toastId: string) => {
    setToasts((prev) => {
      const next = prev.filter((item) => item.toastId !== toastId);
      writeOpen(actorId, next);
      return next;
    });
  }, [actorId]);

  const disablePopups = useCallback(() => {
    setPopupEnabled(false);
    setToasts([]);
    writeOpen(actorId, []);
    setOneViewReminderLinkPopup(false, actorId);
  }, [actorId]);

  const openLink = useCallback((item: ReminderInboxToastRecord) => {
    dismissToast(item.toastId);
    navigate(operadorasReminderLinkPath(item));
  }, [dismissToast, navigate]);

  return (
    <>
      {children}
      {actorId ? (
        <OperatorReminderInboxToastStack
          items={toasts}
          onDismiss={dismissToast}
          onOpenLink={openLink}
          onDisablePopups={disablePopups}
        />
      ) : null}
    </>
  );
}
