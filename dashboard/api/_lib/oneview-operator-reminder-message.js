/** Copy para Webex (Theo) e notificações in-app de lembretes de link. */

function text(value) {
  return String(value ?? "").trim();
}

function safe(value, fallback = "") {
  return text(value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 600) || fallback;
}

function snapshotBag(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function circuitLabelFromSnapshot(snapshot, reminder = null) {
  const snap = snapshotBag(snapshot);
  const link = snap.link || {};
  const alert = snap.alert || {};
  const circuit = snap.circuit || {};
  const classifiedService = reminder?.subject_type === "alert_subject"
    && /pendente de classifica/i.test(String(link.service_name || ""))
    ? null
    : link.service_name;
  const service = safe(
    classifiedService || alert.problem_name || circuit.host_name || circuit.circuit_key,
    "Alerta de operadora",
  );
  const detail = safe(link.member_key || link.uplink_key || circuit.host_name);
  return detail && !service.toLowerCase().includes(detail.toLowerCase()) ? `${service} · ${detail}` : service;
}

export function incidentNumberFromReminder(reminder) {
  const snap = snapshotBag(reminder?.context_snapshot);
  return text(reminder?.initial_incident_number) || text(snap.incident?.number) || null;
}

export function severityFromReminder(reminder) {
  const snap = snapshotBag(reminder?.context_snapshot);
  return text(snap.alert?.severity) || null;
}

/**
 * @param {object} reminder — linha operator_reminders (context_snapshot objeto ou JSON)
 * @param {"fired"|"delivered"} phase
 */
export function buildOperatorReminderInAppCopy(reminder, phase) {
  const snap = snapshotBag(reminder?.context_snapshot);
  const customer = safe(snap.customer?.name || snap.customer?.key, "Cliente não informado");
  const circuit = circuitLabelFromSnapshot(snap, reminder);
  const inc = incidentNumberFromReminder(reminder);
  const hasInc = Boolean(inc);

  if (phase === "fired") {
    return {
      title: hasInc ? "Lembrete: link ainda pendente" : "Lembrete: link continua em falha",
      body: `${customer} · ${circuit}. ${hasInc ? `INC ${inc} em aberto.` : "Sem chamado correlacionado."}`,
    };
  }

  return {
    title: "Lembrete enviado no Webex",
    body: `${customer} · ${circuit}. ${hasInc ? `INC ${inc}.` : "Sem chamado correlacionado."} Confirme o acompanhamento na fila de links.`,
  };
}

export function reminderLinkLocator(reminder) {
  return {
    circuit_key: text(reminder?.circuit_key) || null,
    data_source_id: text(reminder?.data_source_id) || null,
    source_host_id: text(reminder?.source_host_id) || null,
    subject_type: text(reminder?.subject_type) || "circuit",
    subject_key: text(reminder?.subject_key) || null,
    source_trigger_id: text(reminder?.source_trigger_id) || null,
  };
}
