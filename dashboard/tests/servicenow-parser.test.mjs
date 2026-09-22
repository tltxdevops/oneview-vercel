/**
 * SN-P0-06 — testes do parser read-only de description.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeServiceNowIncident,
  parseColonHostProblemLine,
  parseZabbixFieldsFromDescription,
} from "../api/_lib/servicenow-normalize.js";

const SAMPLE_DESCRIPTION = [
  "O problema começou às 09:26:32 em 2026.07.31",
  "Nome do problema: Cisco IOS: Unavailable by ICMP ping",
  "Host: Sanepar - SCA-Centro - Router",
  "Gravidade: High",
  "Dados operacionais: Down (0)",
  "ID original do problema: 327191633",
  "",
  "",
  "Link do problema no Zabbix: http://192.168.252.21/zabbix/tr_events.php?triggerid=688390&eventid=327191633",
].join("\n");

test("parser: extrai host e event_id da description padrão Zabbix", () => {
  const parsed = parseZabbixFieldsFromDescription(SAMPLE_DESCRIPTION);
  assert.equal(parsed.zabbix_host, "Sanepar - SCA-Centro - Router");
  assert.equal(parsed.zabbix_event_id, "327191633");
  assert.equal(parsed.zabbix_ip, null);
});

test("parser: event_id via querystring quando label ausente", () => {
  const parsed = parseZabbixFieldsFromDescription(
    "Host: host-a\nLink: http://zabbix.example/tr_events.php?triggerid=1&eventid=998877",
  );
  assert.equal(parsed.zabbix_host, "host-a");
  assert.equal(parsed.zabbix_event_id, "998877");
});

test("parser: não captura IP do servidor Zabbix no link", () => {
  const parsed = parseZabbixFieldsFromDescription(SAMPLE_DESCRIPTION);
  assert.equal(parsed.zabbix_ip, null);
});

test("parser: captura IP rotulado do host", () => {
  const parsed = parseZabbixFieldsFromDescription(
    "Host: host-b\nIP: 10.20.30.40\nID original do problema: 123",
  );
  assert.equal(parsed.zabbix_host, "host-b");
  assert.equal(parsed.zabbix_ip, "10.20.30.40");
  assert.equal(parsed.zabbix_event_id, "123");
});

test("normalize: inclui campos parseados sem relacionar", () => {
  const normalized = normalizeServiceNowIncident({
    sys_id: "abc",
    number: "INC1",
    description: SAMPLE_DESCRIPTION,
    u_hostname_zabbix: null,
    u_ip_zabbix: null,
  });
  assert.equal(normalized.zabbix_host, "Sanepar - SCA-Centro - Router");
  assert.equal(normalized.zabbix_event_id, "327191633");
  assert.equal(normalized.zabbix_ip, null);
  assert.equal(normalized.description.includes("Host:"), true);
});

test("parser: parseColonHostProblemLine separa host e problema", () => {
  const line = "45548763.ibmmq.rsfn-prd.mapsip.cloud.maps.intranet: MAPS IP 45548763 receiver channel 01 BACEN has WARNING status";
  const parsed = parseColonHostProblemLine(line);
  assert.equal(parsed.host, "45548763.ibmmq.rsfn-prd.mapsip.cloud.maps.intranet");
  assert.match(parsed.problem || "", /BACEN/);
});

test("parser: extrai host do formato MAPS hostname: problema", () => {
  const description = "45548763.ibmmq.rsfn-prd.mapsip.cloud.maps.intranet: MAPS IP 45548763 receiver channel 01 BACEN has WARNING status";
  const parsed = parseZabbixFieldsFromDescription(description);
  assert.equal(
    parsed.zabbix_host,
    "45548763.ibmmq.rsfn-prd.mapsip.cloud.maps.intranet",
  );
  assert.equal(parsed.zabbix_event_id, null);
});

test("parser: description vazia retorna nulls", () => {
  assert.deepEqual(parseZabbixFieldsFromDescription(""), {
    zabbix_event_id: null,
    zabbix_host: null,
    zabbix_ip: null,
  });
});
