import type { OneViewAlert, OperatorReminderInboxItem, OperatorReminderInboxLink } from "@/lib/oneview-api";
import { readOneViewNotificationPreferences } from "@/lib/oneview-notification-preferences";

let audioContext: AudioContext | null = null;

export function operadorasReminderLinkSearchParams(item: Pick<OperatorReminderInboxItem, "id" | "link">) {
  const link: OperatorReminderInboxLink = item.link;
  const params = new URLSearchParams();
  params.set("reminder_id", item.id);
  params.set("ds", link.data_source_id);
  if (link.source_host_id) params.set("host", link.source_host_id);
  if (link.circuit_key) params.set("circuit", link.circuit_key);
  if (link.subject_type) params.set("subject_type", link.subject_type);
  if (link.subject_key) params.set("subject_key", link.subject_key);
  if (link.source_trigger_id) params.set("trigger", link.source_trigger_id);
  return params;
}

export function operadorasReminderLinkPath(item: Pick<OperatorReminderInboxItem, "id" | "link">) {
  return `/operadoras?${operadorasReminderLinkSearchParams(item).toString()}`;
}

export function operadorasAlertLinkPath(alert: Pick<OneViewAlert, "operator_link">) {
  const link = alert.operator_link;
  if (!link) return "/operadoras";
  const params = new URLSearchParams({ ds: link.data_source_id, host: link.source_host_id });
  if (link.circuit_key) params.set("circuit", link.circuit_key);
  params.set("subject_type", link.operational_subject.subject_type);
  params.set("subject_key", link.operational_subject.subject_key);
  if (link.source_trigger_id) params.set("trigger", link.source_trigger_id);
  return `/operadoras?${params.toString()}`;
}

export function reminderInboxEventKey(reminderId: string, phase: "fired" | "delivered") {
  return `${reminderId}:${phase}`;
}

export function playReminderLinkSound(actorId?: string | null, options?: { force?: boolean }) {
  const prefs = readOneViewNotificationPreferences(actorId);
  if (!options?.force && !prefs.reminderLinkSound) return;
  if (typeof window === "undefined") return;
  try {
    const Ctx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    if (!audioContext) audioContext = new Ctx();
    const ctx = audioContext;
    if (ctx.state === "suspended") void ctx.resume();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.36);
  } catch {
    // autoplay policies may block sound until user gesture
  }
}
