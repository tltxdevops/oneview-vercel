import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAlertSubjectKey,
  buildCircuitSubjectKey,
  buildOperationalSubject,
  equivalentOperationalSubjects,
  parseOperationalSubject,
} from "../api/_lib/oneview-operational-subject.js";

const base = {
  id: "unresolved-row",
  data_source_id: "ds-1",
  source_host_id: "host-10",
  resolution_status: "unresolved",
  circuit_key: "operator:v1:generic-unresolved:ds-1:host-10",
  trigger_ids: ["trigger-20"],
};

test("OV-P0-299 operational subject keys are readable, deterministic and occurrence-independent", () => {
  assert.equal(buildAlertSubjectKey({ sourceHostId: "host-10", sourceTriggerId: "trigger-20" }), "alert:host-10:trigger-20");
  assert.equal(buildCircuitSubjectKey("circuit-30"), "circuit:circuit-30");
  const first = buildOperationalSubject({ ...base, current_alert: { id: "alert-row-a", source_event_id: "event-a", source_problem_id: "problem-a" } });
  const recurrence = buildOperationalSubject({ ...base, current_alert: { id: "alert-row-b", source_event_id: "event-b", source_problem_id: "problem-b" } });
  assert.deepEqual(first, recurrence);
  assert.equal(first.subject_key, "alert:host-10:trigger-20");
  assert.equal(first.circuit_key, null);
});

test("OV-P0-299 different trigger means another subject and incomplete identity fails closed", () => {
  assert.notEqual(buildOperationalSubject(base).subject_key, buildOperationalSubject({ ...base, trigger_ids: ["trigger-21"] }).subject_key);
  assert.equal(buildOperationalSubject({ ...base, source_host_id: "" }), null);
  assert.equal(buildOperationalSubject({ ...base, trigger_ids: [] }), null);
  assert.equal(buildOperationalSubject({ ...base, trigger_ids: ["trigger-20", "trigger-21"] }), null);
});

test("OV-P0-299 unresolved aggregate uses the exact current alert trigger when several triggers share a host", () => {
  const subject = buildOperationalSubject({ ...base,
    trigger_ids: ["trigger-a", "trigger-b"],
    current_alert: { source_trigger_id: "trigger-b" },
  });
  assert.equal(subject.subject_type, "alert_subject");
  assert.equal(subject.source_trigger_id, "trigger-b");
  assert.equal(subject.subject_key, "alert:host-10:trigger-b");
});

test("OV-P0-299 circuit subject exposes fallback aliases for cross-type deduplication", () => {
  const subject = buildOperationalSubject({ ...base, resolution_status: "resolved", circuit_key: "circuit-30" });
  assert.equal(subject.subject_type, "circuit");
  assert.equal(subject.subject_key, "circuit:circuit-30");
  assert.deepEqual(equivalentOperationalSubjects(subject), [
    { subject_type: "circuit", subject_key: "circuit:circuit-30" },
    { subject_type: "alert_subject", subject_key: "alert:host-10:trigger-20" },
  ]);
});

test("OV-P0-299 persisted subject parsing validates semantic shape", () => {
  assert.ok(parseOperationalSubject({ subject_type: "alert_subject", subject_key: "alert:host-10:trigger-20", data_source_id: "ds-1", source_host_id: "host-10", source_trigger_id: "trigger-20", circuit_key: null }));
  assert.equal(parseOperationalSubject({ subject_type: "alert_subject", subject_key: "alert:host-10:trigger-99", data_source_id: "ds-1", source_host_id: "host-10", source_trigger_id: "trigger-20", circuit_key: null }), null);
  assert.ok(parseOperationalSubject({ subject_type: "circuit", subject_key: "circuit:circuit-30", circuit_key: "circuit-30", data_source_id: "ds-1" }));
});
