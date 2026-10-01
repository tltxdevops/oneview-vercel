/**
 * OV-P0-307 — resumo operacional seguro para impressão/cópia no drawer de alerta.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildAlertClientCommunication,
  buildAlertClientSharePlainText,
  buildAlertOperationalShareDocument,
  buildAlertRelatedIncidentsFetchParams,
  formatAlertClientCommunication,
  resolveAlertClientFollowUp,
} from "../src/lib/oneview-alert-operational-share.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

const ALERT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const DATA_SOURCE_ID = "11111111-2222-3333-4444-555555555555";
const SOURCE_EVENT_ID = "zbx-event-999888777";
const INCIDENT_SYS_ID = "abcdefabcdefabcdefabcdefabcdefab";
const RECURRENCE_KEY = "ds-host-trigger-secret-key";

function alert(overrides = {}) {
  return {
    id: ALERT_ID,
    data_source_id: DATA_SOURCE_ID,
    datasource_name: "http-teletex",
    client_name: "Havan",
    customer_name: "Havan",
    customer_key: "havan",
    customer_source: "tag",
    customer_confidence: "high",
    operational_scope: "customer",
    enrichment_status: "enriched",
    enrichment_state: "complete",
    source_type: "zabbix",
    source_event_id: SOURCE_EVENT_ID,
    source_problem_id: "problem-1",
    source_trigger_id: "trigger-1",
    source_host_id: "host-1",
    host_name: "HAVAN-WAN1",
    host_visible_name: "HAVAN-WAN1",
    host_technical_name: "havan-wan1.local",
    host_ip: "200.1.2.3",
    host_group: "Havan",
    host_groups: [{ id: "g1", name: "Havan" }],
    event_tags: [
      { tag: "interface", value: "wan1" },
      { tag: "operadora", value: "Vivo" },
      { tag: "__zbx_servicenow_sys_id", value: INCIDENT_SYS_ID },
    ],
    trigger_tags: [],
    host_tags: [],
    servicenow_reference: {
      number: "INC0012345",
      sys_id: INCIDENT_SYS_ID,
      url: `https://teletexprod.service-now.com/incident.do?sys_id=${INCIDENT_SYS_ID}`,
      extra_count: 0,
    },
    problem_name: "Unavailable by ICMP ping",
    trigger_description: "ICMP ping",
    severity: "high",
    status_source: "problem",
    status_internal: "active",
    acknowledged_source: true,
    acknowledged_internal: false,
    acknowledged_source_at: "2026-09-21T12:10:00.000Z",
    acknowledged_source_by: "Ana NOC",
    acknowledged_at: "2026-09-21T12:10:00.000Z",
    acknowledged_by: "Ana NOC",
    suppressed: false,
    suppressed_until: null,
    maintenance_status: null,
    first_seen_at: "2026-09-21T12:00:00.000Z",
    last_seen_at: "2026-09-21T12:20:00.000Z",
    resolved_at: null,
    source_recovery_event_id: null,
    duration_seconds: 1200,
    created_at: "2026-09-21T12:00:00.000Z",
    updated_at: "2026-09-21T12:20:00.000Z",
    is_recurrent: true,
    recurrence_count_24h: 2,
    recurrence_count_7d: 4,
    previous_occurrence_at: "2026-09-20T08:00:00.000Z",
    previous_recovery_at: "2026-09-20T08:40:00.000Z",
    recurrence_key: RECURRENCE_KEY,
    recurrence_previous: {
      occurrence_at: "2026-09-20T08:00:00.000Z",
      recovery_at: "2026-09-20T08:40:00.000Z",
      duration_seconds: 2400,
      acknowledged_by: "Ana NOC",
      incident: { number: "INC0011111", sys_id: INCIDENT_SYS_ID, url: null, extra_count: 0 },
    },
    ...overrides,
  };
}

const historyItems = [
  {
    id: "hist-open",
    event_type: "problem_created",
    title: "Abertura do alerta",
    description: "Host parou de responder",
    occurred_at: "2026-09-21T12:00:00.000Z",
    actor_name: "worker",
  },
  {
    id: "hist-ack",
    event_type: "acknowledged",
    title: "ACK",
    comment: "Em atendimento",
    occurred_at: "2026-09-21T12:10:00.000Z",
    actor_name: "Ana NOC",
  },
];

test("OV-P0-307 documento contém cliente, host, problema, tempos, recorrência e histórico", () => {
  const generatedAt = new Date("2026-09-21T19:34:00.000-03:00");
  const doc = buildAlertOperationalShareDocument({
    alert: alert(),
    historyItems,
    relatedIncidents: [{
      sys_id: INCIDENT_SYS_ID,
      number: "INC0012345",
      state: "2",
      state_display: "Em andamento",
      priority: "2",
      assignment_group: "NOC",
      assignment_group_display: "N1 - Serviços - NOC",
      assigned_to: "ana",
      assigned_to_display: "Ana NOC",
      sys_updated_on: "2026-09-21T12:15:00.000Z",
      short_description: "Link Havan indisponível",
    }],
    generatedAt,
  });

  for (const content of [doc.plainText, doc.html]) {
    assert.match(content, /Havan/);
    assert.match(content, /HAVAN-WAN1/);
    assert.match(content, /Unavailable by ICMP ping/);
    assert.match(content, /High/);
    assert.match(content, /Ativo/);
    assert.match(content, /INC0012345/);
    assert.match(content, /Link Havan indisponível/);
    assert.match(content, /N1 - Serviços - NOC/);
    assert.match(content, /Ana NOC/);
    assert.match(content, /Recorrente/);
    assert.match(content, /Abertura do alerta/);
    assert.match(content, /Em atendimento/);
    assert.match(content, /Vivo/);
    assert.match(content, /wan1/);
    assert.match(content, /Gerado pelo OneView — uso operacional interno/);
  }
  assert.ok(doc.plainText.includes(generatedAt.toLocaleString("pt-BR")));
  assert.match(doc.html, /@media print/);
});

test("OV-P0-307 documento não vaza IDs internos nem tags técnicas", () => {
  const doc = buildAlertOperationalShareDocument({
    alert: alert(),
    historyItems,
    relatedIncidents: [{
      sys_id: INCIDENT_SYS_ID,
      number: "INC0012345",
      state: "2",
      assignment_group: "NOC",
      assigned_to: "ana",
      sys_updated_on: null,
      short_description: "Link Havan indisponível",
    }],
  });

  for (const content of [doc.plainText, doc.html]) {
    assert.doesNotMatch(content, new RegExp(ALERT_ID));
    assert.doesNotMatch(content, new RegExp(DATA_SOURCE_ID));
    assert.doesNotMatch(content, new RegExp(SOURCE_EVENT_ID));
    assert.doesNotMatch(content, new RegExp(INCIDENT_SYS_ID));
    assert.doesNotMatch(content, /sys_id/i);
    assert.doesNotMatch(content, /source_event_id/);
    assert.doesNotMatch(content, /data_source_id/);
    assert.doesNotMatch(content, new RegExp(RECURRENCE_KEY));
    assert.doesNotMatch(content, /__zbx_servicenow/);
    assert.doesNotMatch(content, /Auditoria da identidade/);
  }
});

test("OV-P0-307 texto para cliente segue o cartão canônico e o fuso operacional", () => {
  const relatedIncidents = [{
    sys_id: INCIDENT_SYS_ID,
    number: "INC0012345",
    state: "2",
    state_display: "Em andamento",
    priority: "2",
    assignment_group: "NOC",
    assignment_group_display: "N1 - Serviços - NOC",
    assigned_to: "ana",
    assigned_to_display: "Ana NOC",
    sys_updated_on: "2026-09-21T12:15:00.000Z",
    short_description: "Link Havan indisponível",
  }];
  const doc = buildAlertOperationalShareDocument({
    alert: alert(),
    historyItems,
    relatedIncidents,
  });
  const clientText = buildAlertClientSharePlainText({
    alert: alert(),
    relatedIncidents,
  });

  assert.equal(clientText, [
    "🔴 HAVAN-WAN1 - Unavailable by ICMP ping",
    "📟 Equipamento: havan-wan1.local (200.1.2.3)",
    "📅 Data/Hora: 21/09/2026 - 09:00:00",
    "🛠️ Ação: Aberto chamado INC0012345 para acompanhamento de alerta.",
    "🔄 Próximos Passos: Acompanhando alerta.",
    "🔎 Acompanhamento: Ana NOC",
  ].join("\n"));
  assert.doesNotMatch(clientText, /Gerado pelo OneView — uso operacional interno/);
  assert.doesNotMatch(clientText, /Tags operacionais/);
  assert.doesNotMatch(clientText, /Abertura do alerta/);
  assert.doesNotMatch(clientText, /Histórico/);
  assert.ok(clientText.length < doc.plainText.length);
});

test("OV-P0-307 acompanhamento usa incidente atual, ACK canônico e Equipe NOC", () => {
  const activeOwned = {
    sys_id: INCIDENT_SYS_ID,
    number: "INC0012345",
    state: "2",
    state_display: "Em andamento",
    priority: "2",
    assignment_group: "NOC",
    assigned_to: "ana",
    assigned_to_display: "Ana NOC",
    sys_updated_on: "2026-09-21T12:15:00.000Z",
  };
  const activeUnassigned = {
    ...activeOwned,
    assigned_to: "abcdefabcdefabcdefabcdefabcdefab",
    assigned_to_display: null,
  };
  const terminalOld = {
    ...activeOwned,
    number: "INC0009999",
    state: "6",
    state_display: "Resolvido",
    assigned_to_display: "Ana NOC",
  };
  const ackAlert = alert({
    servicenow_reference: null,
    acknowledged_source: true,
    acknowledged_source_by: "Bruno ACK",
    acknowledged_by: "Bruno ACK",
    source_ack: {
      acknowledged: true,
      actor_name: "Bruno ACK",
      acknowledged_at: "2026-09-21T12:10:00.000Z",
      comment: null,
      acknowledge_id: "ack-1",
      history_available: true,
    },
  });
  const noAckAlert = alert({
    servicenow_reference: null,
    acknowledged_source: false,
    acknowledged_source_by: null,
    acknowledged_by: null,
    acknowledged_source_at: null,
    acknowledged_at: null,
    source_ack: null,
  });

  assert.equal(resolveAlertClientFollowUp(alert(), [activeOwned]), "Ana NOC");
  assert.equal(buildAlertClientCommunication({ alert: alert(), relatedIncidents: [activeOwned] }).followUp, "Ana NOC");

  assert.equal(resolveAlertClientFollowUp(ackAlert, [activeUnassigned]), "Bruno ACK");
  assert.equal(buildAlertClientCommunication({ alert: ackAlert, relatedIncidents: [activeUnassigned] }).followUp, "Bruno ACK");

  assert.equal(resolveAlertClientFollowUp(ackAlert, []), "Bruno ACK");
  assert.equal(buildAlertClientCommunication({ alert: ackAlert, relatedIncidents: [] }).followUp, "Bruno ACK");

  assert.equal(resolveAlertClientFollowUp(ackAlert, [terminalOld]), "Bruno ACK");
  assert.equal(buildAlertClientCommunication({
    alert: ackAlert,
    relatedIncidents: [terminalOld],
  }).followUp, "Bruno ACK");

  assert.equal(resolveAlertClientFollowUp(noAckAlert, []), "Equipe NOC");
  const noOwner = buildAlertClientCommunication({ alert: noAckAlert, relatedIncidents: [] });
  assert.equal(noOwner.followUp, "Equipe NOC");
  assert.equal(noOwner.incidentNumber, null);
  assert.doesNotMatch(formatAlertClientCommunication(noOwner), /INC\d+/);

  const senderDifferent = buildAlertClientCommunication({
    alert: alert(),
    relatedIncidents: [activeOwned],
  });
  assert.equal(senderDifferent.followUp, "Ana NOC");
  assert.notEqual(senderDifferent.followUp, "Guilherme Franco");
  assert.match(formatAlertClientCommunication(senderDifferent), /🔎 Acompanhamento: Ana NOC/);
});

test("OV-P0-307 identidade ambígua ou conflitante não escolhe outro chamado", () => {
  const incident = (number, identityConflict = false) => ({
    sys_id: `${number}-sys-id`,
    number,
    identity_conflict: identityConflict,
    state: "2",
    priority: "2",
    assignment_group: "NOC",
    assigned_to: "ana",
    assigned_to_display: "Ana NOC",
    sys_updated_on: null,
  });
  const ambiguous = buildAlertClientCommunication({
    alert: alert({ servicenow_reference: null }),
    relatedIncidents: [incident("INC0010001"), incident("INC0010002")],
  });
  const conflict = buildAlertClientCommunication({
    alert: alert({ servicenow_reference: null }),
    relatedIncidents: [incident("INC0010003", true)],
  });
  assert.equal(ambiguous.incidentNumber, null);
  assert.equal(conflict.incidentNumber, null);
  assert.equal(ambiguous.action, "Alerta em análise.");
  assert.equal(conflict.action, "Alerta em análise.");
});

test("OV-P0-307 alerta resolvido usa ícone de severidade e acompanhamento concluído", () => {
  const communication = buildAlertClientCommunication({
    alert: alert({ status_source: "resolved", status_internal: "resolved", resolved_at: "2026-09-21T12:30:00.000Z" }),
    relatedIncidents: [],
  });
  assert.equal(communication.statusIcon, "🔴");
  assert.equal(communication.messageType, "resolved");
  assert.equal(communication.action, "Alarme normalizado.");
  assert.equal(communication.nextSteps, "Acompanhamento concluído.");
});

test("OV-P0-307 responsável prioriza display canônico e edições locais são refletidas", () => {
  const base = buildAlertClientCommunication({
    alert: alert(),
    relatedIncidents: [{
      sys_id: INCIDENT_SYS_ID,
      number: "INC0012345",
      state: "2",
      priority: "2",
      assignment_group: "NOC",
      assigned_to: "abcdefabcdefabcdefabcdefabcdefab",
      assigned_to_display: "Bruno NOC",
      sys_updated_on: null,
    }],
  }, {
    action: "Cliente acionado.",
    nextSteps: "Aguardando retorno.",
    followUp: "Carla NOC",
  });
  assert.equal(base.followUp, "Carla NOC");
  assert.match(formatAlertClientCommunication(base), /Cliente acionado/);
  assert.match(formatAlertClientCommunication(base), /Aguardando retorno/);
  assert.doesNotMatch(formatAlertClientCommunication(base), new RegExp(INCIDENT_SYS_ID));
});

test("OV-P0-307 chamado ausente vira texto operacional, fetch params não entram no documento", () => {
  const quiet = alert({
    source_event_id: "",
    event_tags: [],
    servicenow_reference: null,
    is_recurrent: false,
    recurrence_count_24h: 0,
    recurrence_count_7d: 0,
    previous_occurrence_at: null,
    previous_recovery_at: null,
    recurrence_key: null,
    recurrence_previous: null,
  });
  const doc = buildAlertOperationalShareDocument({ alert: quiet, historyItems: [] });
  assert.match(doc.plainText, /Nenhum chamado correlacionado/);
  assert.equal(buildAlertRelatedIncidentsFetchParams(quiet, []), null);

  const params = buildAlertRelatedIncidentsFetchParams(alert(), historyItems);
  assert.equal(params?.sourceEventId, SOURCE_EVENT_ID);
  assert.ok(params?.incidentSysIds?.includes(INCIDENT_SYS_ID));
});

test("OV-P0-307 print do resumo é a imagem do cartão; texto do detalhe continua no Copiar resumo", async () => {
  const [drawer, actions, preview, clientPreview, clientDialog, card, printCard, capture] = await Promise.all([
    read("src/components/oneview/AlertDetailDrawer.tsx"),
    read("src/components/oneview/AlertOperationalShareActions.tsx"),
    read("src/components/oneview/AlertSharePreviewDialog.tsx"),
    read("src/components/oneview/AlertClientSharePreviewDialog.tsx"),
    read("src/components/oneview/ClientShareDialog.tsx"),
    read("src/components/oneview/AlertClientCommunicationCard.tsx"),
    read("src/components/oneview/AlertSummaryPrintCard.tsx"),
    read("src/lib/oneview-alert-summary-capture.ts"),
  ]);
  assert.match(drawer, /AlertOperationalShareActions/);
  assert.doesNotMatch(drawer, /historyReady/);
  assert.doesNotMatch(actions, /historyReady/);
  assert.doesNotMatch(actions, /Aguarde o histórico/);
  assert.match(drawer, /Situação rápida/);
  assert.match(drawer, /Identificação/);
  assert.match(drawer, /label="Host"/);
  assert.match(drawer, /label="Equipamento"/);
  assert.match(drawer, /Problema/);
  assert.match(drawer, /label="ACK"/);
  assert.match(drawer, /label="Recorrência"/);
  assert.doesNotMatch(drawer, /AlertClientCommunicationCard/);
  assert.doesNotMatch(drawer, /Ajustar mensagem/);
  assert.doesNotMatch(drawer, /bg-\[#111214\]/);
  assert.match(drawer, /onRelatedIncidentsChange=\{handleRelatedIncidentsChange\}/);
  assert.doesNotMatch(drawer, /summaryCaptureRef/);
  assert.match(actions, /\n\s+Copiar resumo\n/);
  assert.match(actions, /\n\s+Print\n/);
  assert.doesNotMatch(actions, /\n\s+Imprimir\n/);
  assert.doesNotMatch(actions, /\n\s+Imagem\n/);
  assert.match(actions, /\n\s+Enviar\n/);
  assert.doesNotMatch(actions, /\n\s+Copiar\n/);
  assert.match(actions, /setClientPreviewOpen\(true\)/);
  assert.match(actions, /Enviar ao cliente ou copiar imagem/);
  assert.match(actions, /Copiar resumo do detalhe do alerta/);
  assert.match(actions, /shareDocument\.plainText/);
  assert.match(actions, /captureElementToPng\(target\)/);
  assert.match(actions, /AlertSummaryPrintCard/);
  assert.match(actions, /Este print está ok\?|AlertSharePreviewDialog/);
  assert.doesNotMatch(actions, /openAlertOperationalSharePrint/);
  assert.doesNotMatch(actions, /fetchAlertRelatedIncidents/);
  assert.doesNotMatch(actions, /title="Copiar texto para o cliente"/);
  assert.match(preview, /Este print está ok\?/);
  assert.match(preview, /Copiar imagem/);
  assert.match(preview, /Copiar resumo/);
  assert.doesNotMatch(preview, /Copiar texto do cliente/);
  assert.match(preview, /printPngBlob/);
  assert.match(preview, /Preview do resumo operacional/);
  assert.match(clientPreview, /Prévia da comunicação ao cliente/);
  assert.match(clientPreview, /Ajustar mensagem antes de compartilhar/);
  assert.match(clientPreview, /data-alert-client-communication-card|AlertClientCommunicationCard/);
  assert.match(clientPreview, /Copiar imagem/);
  assert.match(clientPreview, /Enviar ao cliente/);
  assert.doesNotMatch(clientPreview, /Copiar texto/);
  assert.match(clientDialog, /Copiar texto/);
  assert.doesNotMatch(clientDialog, /AlertClientCommunicationCard/);
  assert.match(clientDialog, /formatAlertClientCommunication/);
  assert.match(card, /data-alert-client-communication-card/);
  assert.match(card, /formatAlertClientCommunication/);
  assert.match(card, /bg-\[#0f1012\]/);
  assert.doesNotMatch(card, /Abrir no OneView|Abrir no ServiceNow/);
  assert.match(printCard, /data-alert-summary-print-card/);
  assert.match(printCard, /Identidade/);
  assert.match(printCard, /Estado/);
  assert.match(printCard, /Fonte Zabbix/);
  assert.match(printCard, /Chamado relacionado/);
  assert.match(capture, /document\.fonts\?\.ready/);
  assert.match(capture, /CAPTURE_SCALE = 5/);
  assert.match(capture, /letterRendering: true/);
  assert.match(capture, /cloneNode\(true\)/);
  assert.match(capture, /print-color-adjust: exact/);
  assert.match(capture, /printPngBlob/);
  assert.doesNotMatch(capture, /window\.open/);
});
