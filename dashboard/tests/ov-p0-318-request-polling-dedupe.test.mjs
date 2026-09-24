import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("OV-P0-318 ServiceNow identity e hold options compartilham cache/in-flight", async () => {
  const [api, actions] = await Promise.all([
    read("src/lib/oneview-api.ts"),
    read("src/components/oneview/IncidentActions.tsx"),
  ]);

  assert.match(api, /serviceNowActionResourceCache/);
  assert.match(api, /serviceNowActionResourceInFlight/);
  assert.match(api, /fetchSharedServiceNowActionResource<ServiceNowOperatorIdentity>\("\/oneview\/servicenow\/me"/);
  assert.match(api, /fetchSharedServiceNowActionResource<ServiceNowPutOnHoldOptions>/);
  assert.match(api, /const request = fetchApi<T>\(path\)/);
  assert.match(api, /clearOneViewSessionCaches[\s\S]*serviceNowActionResourceCache\.clear\(\)/);
  assert.match(actions, /fetchServiceNowOperatorIdentity\(controller\.signal\)/);
  assert.match(actions, /fetchServiceNowPutOnHoldOptions\(controller\.signal\)/);
});

test("OV-P0-318 related-alert existe somente sob demanda no drawer e possui cache curto por sys_id", async () => {
  const [cell, drawer, related, api] = await Promise.all([
    read("src/components/oneview/IncidentTableActionsCell.tsx"),
    read("src/components/oneview/IncidentDetailDrawer.tsx"),
    read("src/components/oneview/IncidentRelatedAlertSection.tsx"),
    read("src/lib/oneview-api.ts"),
  ]);

  assert.doesNotMatch(cell, /useIncidentRelatedAlert|fetchIncidentRelatedAlert/);
  assert.match(cell, /const resolvedArtifact = alertArtifact \?\? null/);
  assert.match(drawer, /const relatedAlertState = useIncidentRelatedAlert\(resolved\)/);
  assert.match(related, /fetchIncidentRelatedAlert\(\{ sysId, number, sourceEventId \}\)/);
  assert.match(api, /INCIDENT_RELATED_ALERT_TTL_MS = 15_000/);
  assert.match(api, /`sys:\$\{reference\.sysId\.trim\(\)\.toLowerCase\(\)\}`/);
  assert.match(api, /incidentRelatedAlertInFlight\.get\(key\)/);
});

test("OV-P0-318 Chamados atualiza lista em 15 s sem recarregar metadados em polling", async () => {
  const chamados = await read("src/pages/Chamados.tsx");

  assert.match(chamados, /INCIDENT_LIST_REFRESH_MS = 15_000/);
  assert.match(chamados, /setInterval\(refresh, INCIDENT_LIST_REFRESH_MS\)/);
  assert.match(chamados, /metadataRefreshRef\.current !== metadataRefreshVersion/);
  assert.doesNotMatch(chamados, /metadataRefreshRef\.current !== refreshVersion/);
  assert.match(chamados, /includeCounts: includeMetadata/);
  assert.match(chamados, /includeGlobalCounts: includeMetadata/);
  assert.match(chamados, /includeFacets: includeMetadata/);
  assert.match(chamados, /function refreshAfterIncidentAction\(\)[\s\S]*setMetadataRefreshVersion[\s\S]*setRefreshVersion/);
  assert.match(chamados, /onActionComplete=\{refreshAfterIncidentAction\}/);
  assert.match(chamados, /response\.global_counts \?\? previous\?\.global_counts/);
});

test("OV-P0-318 polling rápido permanece em 10 s e recursos estáveis são desacoplados", async () => {
  const [home, monitoring, alerts, links, facets] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Operadoras.tsx"),
    read("src/lib/oneview-facets-store.ts"),
  ]);

  assert.match(home, /LIST_REFRESH_MS = 10_000/);
  assert.match(monitoring, /REFRESH_MS = 10_000/);
  assert.match(alerts, /ALERTS_REFRESH_MS = 10_000/);
  assert.match(links, /REFRESH_MS = 10_000/);
  assert.match(alerts, /STABLE_SUMMARY_REFRESH_MS = 30_000/);
  assert.match(links, /REMINDERS_REFRESH_MS = 30_000/);
  assert.match(links, /queueRemindersInFlight/);
  assert.match(facets, /FACETS_REFRESH_MS = 60_000/);
});

test("OV-P0-318 writes continuam POST sem cache e actions notificam refresh", async () => {
  const [api, drawer] = await Promise.all([
    read("src/lib/oneview-api.ts"),
    read("src/components/oneview/IncidentDetailDrawer.tsx"),
  ]);

  assert.match(api, /requestServiceNowIncidentClaim[\s\S]*?method: "POST"/);
  assert.match(api, /requestServiceNowIncidentWorkNote[\s\S]*?method: "POST"/);
  assert.match(api, /requestServiceNowIncidentPutOnHold[\s\S]*?method: "POST"/);
  assert.match(drawer, /onActionComplete\?: \(\) => void/);
  assert.match(drawer, /setActionRefresh\(\(value\) => value \+ 1\);[\s\S]*onActionComplete\?\.\(\)/);
});
