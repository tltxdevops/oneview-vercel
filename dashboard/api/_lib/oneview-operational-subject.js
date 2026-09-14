const SUBJECT_TYPES = new Set(["circuit", "alert_subject"]);
const MAX_SUBJECT_KEY_LENGTH = 512;

function text(value) { return String(value || "").trim(); }
function unique(values) { return [...new Set(values.map(text).filter(Boolean))]; }

export function buildAlertSubjectKey({ sourceHostId, sourceTriggerId } = {}) {
  const host = text(sourceHostId);
  const trigger = text(sourceTriggerId);
  if (!host || !trigger) return null;
  const key = `alert:${host}:${trigger}`;
  return key.length <= MAX_SUBJECT_KEY_LENGTH ? key : null;
}

export function buildCircuitSubjectKey(circuitKey) {
  const circuit = text(circuitKey);
  if (!circuit) return null;
  const key = `circuit:${circuit}`;
  return key.length <= MAX_SUBJECT_KEY_LENGTH ? key : null;
}

export function buildOperationalSubject(link) {
  const dataSourceId = text(link?.data_source_id);
  const sourceHostId = text(link?.source_host_id ?? link?.technical?.source_host_id);
  if (!dataSourceId) return null;

  const circuitKey = text(link?.circuit_key ?? link?.technical?.circuit_key);
  const triggerIds = unique([
    ...(Array.isArray(link?.trigger_ids) ? link.trigger_ids : []),
    ...(Array.isArray(link?.technical?.trigger_ids) ? link.technical.trigger_ids : []),
    link?.current_alert?.source_trigger_id,
  ]);
  const currentTriggerId = text(link?.current_alert?.source_trigger_id);
  const fallbackSubjectKeys = sourceHostId
    ? triggerIds.map((sourceTriggerId) => buildAlertSubjectKey({ sourceHostId, sourceTriggerId })).filter(Boolean)
    : [];

  if (circuitKey && link?.resolution_status === "resolved") {
    const subjectKey = buildCircuitSubjectKey(circuitKey);
    if (!subjectKey) return null;
    return {
      subject_type: "circuit",
      subject_key: subjectKey,
      circuit_key: circuitKey,
      data_source_id: dataSourceId,
      source_host_id: sourceHostId || null,
      source_trigger_id: null,
      fallback_subject_keys: fallbackSubjectKeys,
    };
  }

  const sourceTriggerId = currentTriggerId || (triggerIds.length === 1 ? triggerIds[0] : "");
  if (!sourceHostId || !sourceTriggerId) return null;
  const subjectKey = buildAlertSubjectKey({ sourceHostId, sourceTriggerId });
  if (!subjectKey) return null;
  return {
    subject_type: "alert_subject",
    subject_key: subjectKey,
    circuit_key: null,
    data_source_id: dataSourceId,
    source_host_id: sourceHostId,
    source_trigger_id: sourceTriggerId,
    fallback_subject_keys: [subjectKey],
  };
}

export function parseOperationalSubject(value) {
  const subjectType = text(value?.subject_type);
  const subjectKey = text(value?.subject_key);
  const dataSourceId = text(value?.data_source_id);
  const sourceHostId = text(value?.source_host_id);
  const sourceTriggerId = text(value?.source_trigger_id);
  const circuitKey = text(value?.circuit_key);
  if (!SUBJECT_TYPES.has(subjectType) || !subjectKey || subjectKey.length > MAX_SUBJECT_KEY_LENGTH || !dataSourceId) return null;
  if (subjectType === "circuit") {
    return circuitKey && subjectKey === buildCircuitSubjectKey(circuitKey)
      ? { subject_type: subjectType, subject_key: subjectKey, data_source_id: dataSourceId, source_host_id: sourceHostId || null, source_trigger_id: null, circuit_key: circuitKey }
      : null;
  }
  return !circuitKey && sourceHostId && sourceTriggerId && subjectKey === buildAlertSubjectKey({ sourceHostId, sourceTriggerId })
    ? { subject_type: subjectType, subject_key: subjectKey, data_source_id: dataSourceId, source_host_id: sourceHostId, source_trigger_id: sourceTriggerId, circuit_key: null }
    : null;
}

export function equivalentOperationalSubjects(subject) {
  if (!subject) return [];
  const values = [{ subject_type: subject.subject_type, subject_key: subject.subject_key }];
  if (subject.subject_type === "circuit") {
    for (const subjectKey of subject.fallback_subject_keys || []) values.push({ subject_type: "alert_subject", subject_key: subjectKey });
  }
  return [...new Map(values.map((item) => [`${item.subject_type}:${item.subject_key}`, item])).values()];
}

export const OPERATIONAL_SUBJECT_KEY_MAX_LENGTH = MAX_SUBJECT_KEY_LENGTH;
