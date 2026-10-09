import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  sourceAckRowBadgeStatus,
  sourceAckRowKind,
  sourceAckRowLabel,
} from "../src/lib/oneview-alert-source-ack.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("resolved + source unack -> Sem ACK, never Pendente", () => {
  const alert = {
    source_event_id: "423474784",
    status_source: "resolved",
    acknowledged_source: false,
  };
  assert.equal(sourceAckRowKind(alert), "none");
  assert.equal(sourceAckRowLabel("none"), "Sem ACK");
  assert.equal(sourceAckRowBadgeStatus("none"), "incident-closed");
  assert.notEqual(sourceAckRowLabel(sourceAckRowKind(alert)), "Pendente");
});

test("active + source unack -> Pendente", () => {
  const alert = { status_source: "active", acknowledged_source: false };
  assert.equal(sourceAckRowKind(alert), "pending");
  assert.equal(sourceAckRowLabel("pending"), "Pendente");
  assert.equal(sourceAckRowBadgeStatus("pending"), "incident-waiting");
});

test("source ack -> Reconhecido even if resolved", () => {
  const active = { status_source: "active", acknowledged_source: true };
  const resolved = { status_source: "resolved", acknowledged_source: true };
  assert.equal(sourceAckRowKind(active), "acknowledged");
  assert.equal(sourceAckRowKind(resolved), "acknowledged");
  assert.equal(sourceAckRowLabel("acknowledged"), "Reconhecido");
  assert.equal(sourceAckRowBadgeStatus("acknowledged"), "incident-resolved");
});

test("coluna ACK nas telas usa 3 estados e drawer não chama Pendente em resolved", async () => {
  const [alerts, drawer, historico] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/components/oneview/AlertDetailDrawer.tsx"),
    read("src/pages/Historico.tsx"),
  ]);

  assert.match(alerts, /if \(ack.status === "pending"\) return <OneViewSemanticStatusBadge status="incident-waiting" label="Pendente"/);
  assert.match(alerts, /status="incident-closed" label="Sem ACK"/);
  assert.match(alerts, /sourceAckRowKind\(selectedAlert\)/);
  assert.match(drawer, /sourceAckRowLabel\(originAckKind\)/);
  assert.match(drawer, /DetailField label="ACK origem" value=\{sourceAckLabel\}/);
  assert.match(historico, /sourceAckRowKind\(alert\)/);
  assert.doesNotMatch(historico, /status="incident-waiting" label="Pendente"/);
});
