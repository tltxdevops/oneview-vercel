import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("timeline: vínculo vem apenas da referência explícita já validada pelo BFF", async () => {
  const [timeline, section, drawer] = await Promise.all([
    read("src/lib/oneview-alert-timeline.ts"),
    read("src/components/oneview/AlertRelatedIncidentsSection.tsx"),
    read("src/components/oneview/AlertDetailDrawer.tsx"),
  ]);

  assert.match(timeline, /serviceNowReference\?: AlertTimelineServiceNowReference/);
  assert.match(timeline, /hasValidatedServiceNowReference/);
  assert.match(timeline, /asTime\(item\.occurred_at\) >= episodeStartedAt/);
  assert.doesNotMatch(timeline, /const reference = alert\?\.servicenow_reference/);

  assert.match(section, /TIMELINE_EXPLICIT_RELATION_SOURCES/);
  assert.match(section, /"zabbix_servicenow_sys_id"/);
  assert.match(section, /"zabbix_servicenow_number"/);
  assert.match(section, /"zabbix_event_id"/);
  assert.doesNotMatch(section, /"operational_host",\s*\n\s*"zabbix_/);
  assert.match(section, /onTimelineServiceNowReferenceChange\?\.\(null\)/);
  assert.match(drawer, /onTimelineServiceNowReferenceChange/);
  assert.match(drawer, /timelineServiceNowReference/);
});

test("INC0084362: vínculo antigo terminal não tem caminho para a timeline do novo episódio", async () => {
  const [section, correlation] = await Promise.all([
    read("src/components/oneview/AlertRelatedIncidentsSection.tsx"),
    read("api/_lib/oneview-incidents-read-model.js"),
  ]);

  assert.match(correlation, /isIncidentCurrentForAlertEpisode/);
  assert.match(correlation, /openedAt < episodeStartedAt/);
  assert.match(section, /timelineReference\(nextRelationSource, nextIncidents\)/);
});

test("timeline: exibição fixa America/Sao_Paulo; comparação permanece por epoch UTC", async () => {
  const [timeline, section, drawer] = await Promise.all([
    read("src/lib/oneview-alert-timeline.ts"),
    read("src/components/oneview/AlertRelatedIncidentsSection.tsx"),
    read("src/components/oneview/AlertDetailDrawer.tsx"),
  ]);

  assert.match(timeline, /Date\.parse/);
  assert.match(section, /timeZone: OPERATIONAL_TIME_ZONE/);
  assert.match(drawer, /timeZone: OPERATIONAL_TIME_ZONE/);
  assert.match(section, /const OPERATIONAL_TIME_ZONE = "America\/Sao_Paulo"/);
  assert.match(drawer, /const OPERATIONAL_TIME_ZONE = "America\/Sao_Paulo"/);
});
