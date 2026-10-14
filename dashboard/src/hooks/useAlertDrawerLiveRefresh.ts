import { useEffect, useRef } from "react";
import {
  ALERT_DRAWER_POLL_MS,
  createAlertDrawerPoller,
  isAckInFlight,
  shouldPollAlertDrawer,
  type AlertLiveTransition,
} from "@/lib/oneview-alert-live-refresh";
import type { OneViewAlert } from "@/lib/oneview-api";

/**
 * Selective 2s drawer refresh. Fetches only the open alert (+ history via
 * `refresh`). Stops when the source is no longer active and ACK is terminal.
 * `fresh` is true only while an ACK is in flight, so the 8s read cache cannot
 * hide its outcome; otherwise reads stay cached.
 */
export function useAlertDrawerLiveRefresh(options: {
  alertId: string | null;
  alert: OneViewAlert | null;
  enabled?: boolean;
  refresh: (alertId: string, signal: AbortSignal, fresh: boolean) => Promise<OneViewAlert | null | undefined>;
  onTransition?: (transition: AlertLiveTransition, next: OneViewAlert) => void;
}) {
  const alertRef = useRef(options.alert);
  alertRef.current = options.alert;
  const refreshRef = useRef(options.refresh);
  refreshRef.current = options.refresh;
  const onTransitionRef = useRef(options.onTransition);
  onTransitionRef.current = options.onTransition;

  const enabled = options.enabled !== false;
  const shouldPoll = Boolean(enabled && options.alertId && shouldPollAlertDrawer(options.alert));

  useEffect(() => {
    const alertId = options.alertId;
    if (!shouldPoll || !alertId) return undefined;
    const poller = createAlertDrawerPoller({
      intervalMs: ALERT_DRAWER_POLL_MS,
      shouldPoll: () => !document.hidden && shouldPollAlertDrawer(alertRef.current),
      currentAlert: () => alertRef.current,
      refresh: (signal) => refreshRef.current(alertId, signal, isAckInFlight(alertRef.current)),
      onTransition: (transition, next) => onTransitionRef.current?.(transition, next),
    });
    poller.start();
    return () => poller.abort();
  }, [options.alertId, shouldPoll]);
}
