/** OV-P0-234 — every browser ServiceNow action must use a canonical Production sys_id link. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { projectServiceNowReferenceFromAlertTags } from "../api/_lib/oneview-inc-correlation.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const production = "https://teletexprod.service-now.com";
const inc74734SysId = "4475122733b2871064bca4989d5c7b2f";
const inc74746SysId = "23b3e6e79732471030f7f796f053af18";

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("OV-P0-234 projects INC0074734 only from its structured sys_id", () => {
  const reference = projectServiceNowReferenceFromAlertTags({
    event_tags: [
      { tag: "__zbx_servicenow_number", value: "INC0074734" },
      { tag: "__zbx_servicenow_sys_id", value: inc74734SysId },
      { tag: "__zbx_servicenow_link", value: "https://oneview.teletexdev.com.br/chamados" },
    ],
  }, { baseUrl: production });

  assert.equal(reference.number, "INC0074734");
  assert.equal(reference.sys_id, inc74734SysId);
  assert.equal(reference.url, `${production}/incident.do?sys_id=${inc74734SysId}`);
  assert.doesNotMatch(reference.url, new RegExp(inc74746SysId));
});

test("OV-P0-234 never turns a legacy URL tag into a ServiceNow browser link", () => {
  const reference = projectServiceNowReferenceFromAlertTags({
    event_tags: [
      { tag: "__zbx_servicenow_number", value: "INC0074734" },
      { tag: "__zbx_servicenow_link", value: "https://oneview.teletexdev.com.br/chamados" },
    ],
  }, { baseUrl: production });

  assert.equal(reference.number, "INC0074734");
  assert.equal(reference.sys_id, null);
  assert.equal(reference.url, null);
});

test("OV-P0-234 client gate regenerates links and timeline preserves sys_id", async () => {
  const [correlation, cell, timeline, drawer, genericLink, related, home, monitoring, chamados] = await Promise.all([
    read("src/lib/oneview-inc-correlation.ts"),
    read("src/components/oneview/AlertServiceNowReferenceCell.tsx"),
    read("src/lib/oneview-alert-timeline.ts"),
    read("src/components/oneview/AlertDetailDrawer.tsx"),
    read("src/components/oneview/ServiceNowDevLink.tsx"),
    read("src/components/oneview/AlertRelatedIncidentsSection.tsx"),
    read("src/pages/Index.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Chamados.tsx"),
  ]);

  assert.match(correlation, /SERVICENOW_PROD_BASE_URL = "https:\/\/teletexprod\.service-now\.com"/);
  assert.match(correlation, /buildServiceNowIncidentDeepLink\(options\.baseUrl \|\| SERVICENOW_PROD_BASE_URL, sys_id\)/);
  assert.doesNotMatch(correlation, /buildServiceNowIncidentDeepLink\(options\.baseUrl, sys_id\) \|\| linkFromTag/);
  assert.match(cell, /buildProductionServiceNowIncidentLink\(reference\.sys_id\)/);
  assert.doesNotMatch(cell, /href=\{reference\.url\}/);
  assert.match(timeline, /incident_sys_id/);
  assert.match(drawer, /sys_id: item\.incident_sys_id/);
  assert.match(genericLink, /canonicalizeServiceNowIncidentLink/);
  assert.match(related, /buildProductionServiceNowIncidentLink\(item\.sys_id\)/);
  assert.doesNotMatch(related, /item\.servicenow_url \|\| projected\?\.url/);
  assert.match(home, /buildProductionServiceNowIncidentLink\(item\.sys_id\)/);
  assert.doesNotMatch(home, /servicenow_url \|\| "\/chamados"/);
  assert.match(monitoring, /sysId=\{selectedIncident\.sys_id\}/);
  assert.match(chamados, /sysId=\{selected\.sys_id\}/);
});
