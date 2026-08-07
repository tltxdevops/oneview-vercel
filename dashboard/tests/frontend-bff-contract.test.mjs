import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const list = (path) => readdir(new URL(`../${path}`, import.meta.url));

test("frontend sempre consulta BFF com no-store e token preservado", async () => {
  const [api, index, alerts] = await Promise.all([
    read("src/lib/oneview-api.ts"),
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
  ]);
  assert.doesNotMatch(api, /demo-oneview-data|oneview-real-snapshot|NEXT_PUBLIC_DEMO_MODE|ONEVIEW_SNAPSHOT_MODE|VITE_API_BASE_URL/);
  assert.match(api, /const API_BASE_URL = "\/api"/);
  assert.match(api, /cache:\s*"no-store"/);
  assert.match(api, /Authorization:\s*`Bearer \$\{token\}`/);
  assert.match(api, /search\.append\("client", client\)/);
  assert.match(api, /search\.append\("customer", customer\)/);
  assert.match(api, /search\.append\("datasource", datasource\)/);
  assert.match(api, /search\.append\("customer_confidence", confidence\)/);
  assert.match(api, /search\.append\("severity", severity\)/);
  assert.match(api, /\/oneview\/alerts\/\$\{encodeURIComponent\(id\)\}/);
  assert.match(api, /\/oneview\/alerts\/\$\{encodeURIComponent\(id\)\}\/history/);
  assert.match(api, /"\/oneview\/operations\/health"/);
  assert.match(api, /search\.set\("first_seen_from", params\.firstSeenFrom\)/);
  assert.match(api, /search\.set\("first_seen_to", params\.firstSeenTo\)/);
  assert.match(api, /search\.set\("last_seen_from", params\.lastSeenFrom\)/);
  assert.match(api, /search\.set\("last_seen_to", params\.lastSeenTo\)/);
  assert.match(api, /search\.set\("resolved_from", params\.resolvedFrom\)/);
  assert.match(api, /search\.set\("resolved_to", params\.resolvedTo\)/);
  assert.match(api, /search\.set\("acknowledged_from", params\.acknowledgedFrom\)/);
  assert.match(api, /search\.set\("acknowledged_to", params\.acknowledgedTo\)/);
  assert.match(api, /search\.set\("host_search", params\.hostSearch\)/);
  assert.match(api, /search\.set\("problem_search", params\.problemSearch\)/);
  assert.match(index, /PRIORITY_PAGE_SIZE = 6/);
  assert.match(index, /fetchRecentPriorityAlerts/);
  assert.match(index, /fetchRecentOperationalEvents/);
  assert.doesNotMatch(index, /SyncsStatusPanel/);
  assert.match(api, /canonicalizeSeveritiesForApi/);
  assert.match(api, /disasterFamilySeverities/);
  assert.match(alerts, /setPagination\(normalized\.pagination\)/);
  assert.match(alerts, /Array\.isArray\(runtimeResponse\.items\)/);
});

test("alertas usa paginação BFF, debounce e cancelamento", async () => {
  const [api, alerts] = await Promise.all([read("src/lib/oneview-api.ts"), read("src/pages/Alerts.tsx")]);
  assert.match(alerts, /const \[pageSize, setPageSize\] = useState/);
  assert.match(alerts, /const \[statusFilter, setStatusFilter\] = useState<StatusFilter>/);
  assert.match(alerts, /window\.setTimeout\(\(\) => \{/);
  assert.match(alerts, /setDebouncedSearch\(searchQuery\.trim\(\)\)/);
  assert.match(alerts, /, 300\)/);
  assert.match(alerts, /alertsRequestRef\.current\?\.abort\(\)/);
  assert.match(alerts, /requestId !== alertsRequestIdRef\.current/);
  assert.match(alerts, /if \(summaryRequestRef\.current\) return summaryRequestRef\.current/);
  assert.match(alerts, /<SelectItem value="25">25<\/SelectItem>/);
  assert.match(alerts, /<SelectItem value="50">50<\/SelectItem>/);
  assert.match(alerts, /<SelectItem value="100">100<\/SelectItem>/);
  assert.match(alerts, /Exibindo \$\{firstVisible\.toLocaleString\("pt-BR"\)\}–\$\{lastVisible\.toLocaleString\("pt-BR"\)\} de \$\{listTotal\.toLocaleString\("pt-BR"\)\}/);
  assert.match(alerts, /hasTemporalFilter/);
  assert.match(api, /Math\.min\(params\?\.pageSize \?\? 100, 100\)/);
  assert.doesNotMatch(`${api}\n${alerts}`, /limit:\s*(?:250|500|5000)|offset:\s*0/);
});

test("um único controle coordena refresh e timers sem Pausar", async () => {
  const [alerts, appLayout] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/components/layout/AppLayout.tsx"),
  ]);
  assert.match(alerts, /SUMMARY_REFRESH_MS = 60_000/);
  assert.match(alerts, /ALERTS_REFRESH_MS = 120_000/);
  assert.match(alerts, /if \(document\.hidden\) return/);
  assert.doesNotMatch(alerts, /topbarRightSection=\{<PlatformHealthStrip/);
  assert.doesNotMatch(alerts, /showHealthStrip=\{false\}/);
  assert.match(alerts, /text-xl font-semibold tracking-tight text-foreground">Alertas</);
  assert.match(alerts, /\{clientSelector\}/);
  assert.match(alerts, /enableAutoRefresh=\{false\}/);
  assert.doesNotMatch(alerts, /aria-label="Atualizar dados"/);
  assert.doesNotMatch(alerts, /Atualizar dados em segundo plano|Atualizar agora/);
  assert.match(alerts, /\["Última atualização",/);
  assert.doesNotMatch(alerts, /Pausar|Retomar|setIsPaused|isPaused|Resumo em|Alertas em \{/);
  assert.doesNotMatch(appLayout, /Pausar|Retomar|setIsPaused|isPaused|initiallyPaused/);
  assert.match(appLayout, /PlatformHealthStrip/);
  assert.doesNotMatch(alerts, /PlatformHealthStrip/);
  assert.match(alerts, /sortableHeader\("Severidade", "severity"\)/);
  assert.match(alerts, /sortableHeader\("Host", "host"\)/);
  assert.match(alerts, /sortableHeader\("Início", "first_seen_at"\)/);
  assert.match(alerts, /sortableHeader\("ACK", "acknowledged_source"\)/);
  assert.match(alerts, /sortableHeader\("Estado", "status"\)/);
  assert.doesNotMatch(alerts, /sortableHeader\("Cliente", "client"\)/);
  assert.doesNotMatch(alerts, /sortableHeader\("Fonte", "datasource"\)/);
  assert.match(alerts, /ALERTS_SORT_OPTIONS/);
  assert.doesNotMatch(alerts, /Atualizar visualização|onRefresh=\{/);
});

test("SSO server-side só restaura sessão iniciada explicitamente nesta aba", async () => {
  const [context, serverAuth, api] = await Promise.all([
    read("src/context/AuthContext.tsx"),
    read("src/lib/server-auth.ts"),
    read("src/lib/oneview-api.ts"),
  ]);
  assert.match(context, /useState<AuthUser \| null>\(null\)/);
  assert.match(context, /hasActiveServerSession\(\) \? await fetchServerAuthUser\(\) : null/);
  assert.match(serverAuth, /SERVER_SESSION_ACTIVE_KEY/);
  assert.match(serverAuth, /setActiveServerSession\(true\)/);
  assert.match(serverAuth, /setActiveServerSession\(false\)/);
  assert.match(context, /msalInstance\.clearCache\(\)/);
  assert.doesNotMatch(`${context}\n${api}`, /getAllAccounts\(\)\[0\]/);
});

test("filtros ficam na barra e continuam server-side", async () => {
  const [alerts, query] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/lib/alerts-query.ts"),
  ]);
  assert.doesNotMatch(alerts, /Filtros de alertas|Ocultar filtros|Mostrar filtros|FILTERS_STORAGE_KEY/);
  assert.match(alerts, /selectedCustomerKeys/);
  assert.match(alerts, /ClientIdentity/);
  assert.doesNotMatch(alerts, /confidenceFilter|Baixa confiança/);
  assert.match(alerts, /ClientFilterCombobox/);
  assert.match(alerts, /Mais filtros/);
  assert.match(alerts, /ALERTS_DATE_FIELD_OPTIONS/);
  assert.match(alerts, /ALERTS_SEARCH_FIELD_OPTIONS/);
  assert.match(alerts, /ALERTS_SORT_OPTIONS/);
  assert.match(alerts, /dateField/);
  assert.match(alerts, /datePreset/);
  assert.match(alerts, /searchField/);
  assert.match(alerts, /debouncedSearch/);
  assert.match(query, /"30m"/);
  assert.match(query, /"15m"/);
  assert.match(alerts, /Personalizado/);
  assert.match(alerts, /toggleColumnSort/);
  assert.match(alerts, /sortableHeader\("Host", "host"\)/);
  assert.match(alerts, /sortableHeader\("Severidade", "severity"\)/);
  assert.match(alerts, /sortableHeader\("Problema", "problem"\)/);
  assert.match(alerts, /aria-label="Pesquisar host"/);
  assert.match(alerts, /aria-label="Pesquisar problema"/);
  assert.match(alerts, /aria-label="ACK da origem"/);
  assert.match(alerts, /ALERTS_SORT_OPTIONS/);
  assert.doesNotMatch(alerts, /Saúde operacional/);
  assert.doesNotMatch(alerts, /localStorage\.(?:setItem|getItem)/);
});

test("filtros temporais usam um campo, persistem na URL e atualizam os cards", async () => {
  const [alerts, index, api, query, db, fallback] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/pages/Index.tsx"),
    read("src/lib/oneview-api.ts"),
    read("src/lib/alerts-query.ts"),
    read("api/_lib/oneview-db.js"),
    read("api/_lib/oneview-fallback.js"),
  ]);

  assert.match(alerts, /applyDateFieldToFetchParams/);
  assert.match(alerts, /applySearchToFetchParams/);
  assert.match(alerts, /alertsDateBounds\(datePreset, dateRange, requestTime\)/);
  assert.match(alerts, /request\.firstSeenTo = dateBounds\.to/);
  assert.match(alerts, /const requestTime = Date\.now\(\)/);
  assert.match(alerts, /writeAlertsUrlParams/);
  assert.match(alerts, /setSearchParams\(next, \{ replace: true \}\)/);
  assert.match(alerts, /setDatePreset\("all"\)/);
  assert.match(alerts, /setFilteredSummary\(safeResponse\.filtered_summary\)/);
  assert.match(alerts, /hasTemporalFilter/);
  assert.match(alerts, /filteredSummary\s*\n\s*\? filteredSummary\.active/);
  assert.match(alerts, /listTotal\.toLocaleString\("pt-BR"\)/);
  assert.match(alerts, /setPage\(1\)/);
  assert.match(api, /filtered_summary\?:/);
  assert.match(api, /by_severity: \{\s*information: number;\s*warning: number;\s*average: number;\s*high: number;\s*disaster: number;\s*\}/s);
  assert.match(api, /\/\*\* Fora da faixa visual das cinco severidades\. \*\/\s*not_classified: number;/s);
  assert.doesNotMatch(api, /by_severity: \{ disaster: number; high: number; average: number; low: number \}/);
  assert.match(db, /a\.severity = 'information'\)::int as information/);
  assert.match(db, /a\.severity = 'warning'\)::int as warning/);
  assert.match(db, /a\.severity in \('high', 'critical'\)\)::int as high/);
  assert.match(db, /a\.severity = 'disaster'\)::int as disaster/);
  assert.match(db, /a\.severity = 'not_classified'\)::int as not_classified/);
  assert.doesNotMatch(db, /a\.severity in \('warning', 'information', 'not_classified'\)\)::int as low/);
  assert.match(fallback, /information: filteredItems\.filter\(\(item\) => item\.severity === "information"\)\.length/);
  assert.match(fallback, /warning: filteredItems\.filter\(\(item\) => item\.severity === "warning"\)\.length/);
  assert.match(fallback, /high: filteredItems\.filter\(\(item\) => item\.severity === "high" \|\| item\.severity === "critical"\)\.length/);
  assert.match(fallback, /not_classified: filteredItems\.filter\(\(item\) => item\.severity === "not_classified"\)\.length/);
  assert.match(fallback, /items: filteredItems\.slice\(offset, offset \+ pageSize\)/);
  assert.doesNotMatch(fallback, /\["warning", "information", "not_classified"\]\.includes\(item\.severity\)\)\.length/);
  assert.match(api, /search\.set\("search_field"/);
  assert.match(query, /date_field/);
  assert.match(query, /acknowledged_source/);
  assert.match(query, /search_field/);
  assert.match(db, /search_field/);
  assert.match(db, /acknowledged_at: "a\.acknowledged_at"/);
  assert.match(index, /params\.set\("status", options\.status\)/);
  assert.match(index, /params\.set\("source_ack", options\.sourceAck\)/);
  assert.match(index, /\/alertas\?alert=\$\{encodeURIComponent\(selectedAlert\.id\)\}&from=home/);
  assert.match(index, /onOpen=\{openAlert\}/);
  assert.match(index, /defaultValue="summary"/);
  assert.match(index, /topbarRightSection=\{headerControls\}/);
  assert.match(alerts, /Sheet open=\{selectedAlertId !== null\}/);
});

test("V1 filtra somente ACK real da origem e mantém reconhecimento interno fora da interface", async () => {
  const [alerts, api] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/lib/oneview-api.ts"),
  ]);

  assert.match(alerts, /acknowledgedSource: sourceAckFilter === "all" \? undefined : sourceAckFilter === "acknowledged"/);
  assert.match(alerts, /Com ACK/);
  assert.match(alerts, /Sem ACK/);
  assert.match(alerts, /ACK da origem/);
  assert.doesNotMatch(alerts, /internalRecognitionFilter|Reconhecidos no OneView|Pendentes no OneView|Reconhecer no OneView/);
  assert.match(api, /search\.set\("acknowledged_source", String\(params\.acknowledgedSource\)\)/);
  // Contrato interno permanece disponível no cliente, mas não é usado pela V1.
  assert.match(api, /search\.set\("acknowledged_internal", String\(params\.acknowledgedInternal\)\)/);
});

test("início apresenta Syncs (Banco/Worker/Teletex) sem inventar PgBouncer", async () => {
  const [index, alerts, healthLib, strip, appLayout] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/lib/platform-health.ts"),
    read("src/components/oneview/PlatformHealthStrip.tsx"),
    read("src/components/layout/AppLayout.tsx"),
  ]);
  assert.doesNotMatch(index, /fetchOperationsHealth\(\)/);
  assert.doesNotMatch(index, /SyncsStatusPanel/);
  assert.doesNotMatch(index, /Saúde da plataforma|PlatformHealthStrip/);
  assert.doesNotMatch(index, /fetchOneViewHealth/);
  assert.match(appLayout, /showHealthStrip \? <PlatformHealthStrip/);
  assert.match(healthLib, /name: "Banco"/);
  assert.match(healthLib, /name: "Worker"/);
  assert.match(healthLib, /name: "Teletex"/);
  assert.match(healthLib, /TELETEX_DATASOURCE_NAME = "teletex-http"/);
  assert.match(healthLib, /toLowerCase\(\) === TELETEX_DATASOURCE_NAME/);
  assert.doesNotMatch(healthLib, /items\?\.\[0\]|items\[0\]/);
  assert.match(strip, /fetchOneViewHealth/);
  assert.match(strip, /fetchOperationsHealth/);
  assert.match(strip, /fetchSyncLogs/);
  assert.match(strip, /fetchDataSources/);
  assert.match(index, /Tela atualizada:/);
  assert.match(index, /topbarRightSection=\{headerControls\}/);
  assert.doesNotMatch(index, /operations\?\.items \?\? \[\]/);
  assert.match(strip, /Última sincronização/);
  assert.match(strip, /Último sync:/);
  assert.doesNotMatch(index, /PgBouncer|PGBOUNCER|6432/);
  assert.doesNotMatch(`${healthLib}\n${strip}`, /PgBouncer|PGBOUNCER|6432|castrolanda|fraport|zurich/i);
  assert.doesNotMatch(index, /disponibilidade\s*100%|uptime\s*100%/i);
  assert.doesNotMatch(alerts, /Saúde operacional|Saúde da plataforma|SyncsStatusPanel|PlatformHealthStrip/);
});

test("OV-P0-26 saúde Teletex-only e shell denso sem zoom/scale", async () => {
  const [strip, healthLib, appLayout, sidebar, topbar, pageHeader, metricStrip, filterBar, monitoring, index, alerts, historico] = await Promise.all([
    read("src/components/oneview/PlatformHealthStrip.tsx"),
    read("src/lib/platform-health.ts"),
    read("src/components/layout/AppLayout.tsx"),
    read("src/components/layout/Sidebar.tsx"),
    read("src/components/layout/Topbar.tsx"),
    read("src/components/oneview/PageHeader.tsx"),
    read("src/components/oneview/CompactMetricStrip.tsx"),
    read("src/components/oneview/FilterBar.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
  ]);

  assert.match(healthLib, /name: "Banco"/);
  assert.match(healthLib, /name: "Worker"/);
  assert.match(healthLib, /name: "Teletex"/);
  assert.match(healthLib, /technicalName: TELETEX_DATASOURCE_NAME/);
  assert.match(healthLib, /toLowerCase\(\) === TELETEX_DATASOURCE_NAME/);
  assert.doesNotMatch(`${strip}\n${healthLib}`, /castrolanda|fraport|zurich/i);
  assert.match(healthLib, /levelFromDatabase|database_reachable/);
  assert.match(healthLib, /Sem informação/);
  assert.doesNotMatch(healthLib, /return "OK".*return "OK"|hardcoded.*healthy/i);

  const shell = [appLayout, sidebar, topbar, pageHeader, metricStrip, filterBar, monitoring, index, alerts, historico].join("\n");
  assert.doesNotMatch(shell, /zoom\s*:|transform:\s*scale\(|scale\([0-9.]+\)/);
  assert.match(appLayout, /ml-14/);
  assert.doesNotMatch(appLayout, /ml-20/);
  assert.match(appLayout, /gap-3 p-3/);
  assert.match(sidebar, /w-14/);
  assert.doesNotMatch(sidebar, /w-20 hover:w-64/);
  assert.match(topbar, /min-h-10/);
  assert.match(pageHeader, /text-xl font-semibold/);
  assert.match(metricStrip, /min-w-\[5\.5rem\]/);
  assert.match(filterBar, /ov-panel p-2\.5/);
  assert.match(index, /gap-3 p-3 lg:px-4/);
  assert.match(alerts, /gap-3 p-3 lg:px-4/);
  assert.match(alerts, /ClientFilterCombobox/);
  assert.match(historico, /gap-3 p-3 lg:px-4/);
  assert.match(monitoring, /h-\[100dvh\].*w-\[100vw\]/);
  assert.match(monitoring, /Sidebar|monitoringCollapse|navOpen/);
  assert.doesNotMatch(monitoring, /MonitoringControlsRail|ov-sidebar-offset|w-\[200px\]/);
  assert.match(monitoring, /overflow-hidden/);
  assert.doesNotMatch(monitoring, /overflow-auto|overflow-y-auto/);
  assert.match(monitoring, /PRIORITY_LIMIT = 6/);
});

test("Home operacional NOC usa contratos OneView sem ranking de clientes", async () => {
  const [index, app, sidebar, historico] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/App.tsx"),
    read("src/components/layout/Sidebar.tsx"),
    read("src/pages/Historico.tsx"),
  ]);
  assert.match(index, /Início|Visão operacional|Resumo geral da operação Teletex/);
  assert.match(index, /Dados da fonte Teletex|Resumo geral da operação Teletex/);
  assert.match(index, /HOME_VISUAL_SEVERITY_STRIP|CompactMetricStrip/);
  assert.match(index, /homeWindowActiveLabel/);
  assert.doesNotMatch(index, /Total persistido|Em acompanhamento no OneView|active_total/);
  assert.doesNotMatch(index, /title: "Alertas ativos"/);
  assert.doesNotMatch(index, /Novos nas últimas \$\{windowLabel\}/);
  assert.doesNotMatch(index, /Disaster sem ACK · \$\{windowLabel\}/);
  assert.doesNotMatch(index, /ACK realizados · \$\{windowLabel\}/);
  assert.doesNotMatch(index, /title: "Última sincronização"/);
  assert.match(index, /Prioridade agora/);
  assert.match(index, /Eventos recentes/);
  assert.doesNotMatch(index, /Atenção necessária/);
  assert.match(index, /Clientes mais impactados/);
  assert.doesNotMatch(index, /A integração com o ServiceNow está em preparação\.|Abrir área de chamados/);
  assert.match(index, /Atualizando\.\.\./);
  assert.match(index, /PRIORITY_PAGE_SIZE = 6/);
  assert.match(index, /PRIORITY_SEVERITIES/);
  assert.match(index, /HOME_EVENT_ALLOWLIST/);
  assert.match(index, /fetchRecentPriorityAlerts/);
  assert.match(index, /fetchRecentOperationalEvents/);
  assert.doesNotMatch(index, /SyncsStatusPanel/);
  assert.match(index, /Promise\.allSettled/);
  assert.match(index, /topClients\.length/);
  assert.doesNotMatch(index, /attentionReason|fetchAttentionRequired|attentionItems/);
  assert.match(index, /Abrir todos em Alertas/);
  assert.match(index, /view: "priority"/);
  assert.match(index, /first_seen_at/);
  assert.match(index, /priorityAlertsHref/);
  assert.match(index, /status: "active"/);
  assert.match(index, /isBackgroundUpdating/);
  assert.match(index, /beginQuietUpdate/);
  assert.match(index, /fetchAlertHistory/);
  assert.match(index, /Sheet open=\{selectedAlertId !== null\}/);
  assert.match(index, /Tentar novamente/);
  assert.match(index, /sectionErrors/);
  assert.doesNotMatch(index, /Hosts mais impactados|attentionOpen|Collapsible|RECENT_SEVERITY_GROUPS|ATTENTION_BUCKETS|todayOnly|Resolvidos hoje|Fontes degradadas|Carregar mais prioritários/);
  assert.doesNotMatch(index, /label: "Abertos"|label: "Críticos"|label: "SLA vencido"/);
  assert.doesNotMatch(index, /customerLogos|aliases: \["castrolanda"\]|aliases: \["fraport"\]|aliases: \["zurich"\]/);
  assert.doesNotMatch(index, /FRAPORT|Zurich|Castrolanda/);
  assert.doesNotMatch(index, /OneView:|Nunca tratado|Reconhecimentos OneView hoje|Críticos \/ Altos|Críticos sem ACK|>Esquecidos<|>Fora do radar<|>Desastres recentes</);
  assert.doesNotMatch(index, /disponibilidade\s*100%|disponibilidade 100|uptime\s*100%/i);
  assert.doesNotMatch(index, /PgBouncer|mock-data|demo-oneview-data|RITM\d+|INC\d+/i);
  assert.ok(index.indexOf("Prioridade agora") < index.indexOf("Eventos recentes"));
  assert.ok(index.indexOf("Eventos recentes") < index.indexOf("Clientes mais impactados"));
  assert.doesNotMatch(index, /A integração com o ServiceNow está em preparação\.|Abrir área de chamados/);
  assert.doesNotMatch(index, /SyncsStatusPanel|PlatformHealthStrip/);
  assert.doesNotMatch(index, /Saúde da plataforma/);
  assert.match(index, /xl:grid-cols-2/);
  assert.match(index, /showRefreshMeta=\{false\}/);
  assert.doesNotMatch(index, /dataSource=\{currentDataSource\}|checkedAt=\{lastCheckedAt\}/);
  assert.match(index, /Abrir resumo de \$\{/);
  assert.match(index, /status: "active"/);
  assert.doesNotMatch(index, /<h2[^>]*>Chamados<\/h2>/);
  assert.match(app, /path="\/historico"/);
  assert.match(app, /HistoricoPage/);
  assert.match(sidebar, /name: "Histórico"/);
  assert.match(sidebar, /href: "\/historico"/);
  assert.match(sidebar, /History/);
  assert.ok(sidebar.indexOf('href: "/alertas"') < sidebar.indexOf('href: "/historico"'));
  assert.doesNotMatch(sidebar, /name: "Histórico", href: "\/alertas"/);
  assert.match(historico, /text-xl font-semibold tracking-tight text-foreground">Histórico</);
  assert.match(historico, /TabsTrigger value="alertas"/);
  assert.match(historico, /TabsTrigger value="eventos"/);
  assert.match(historico, /fetchAlerts/);
  assert.match(historico, /fetchGlobalHistory/);
  assert.match(historico, /eventos registrados|alertas registrados/i);
  assert.match(historico, /Filtrar por cliente/);
  assert.match(historico, /Filtrar por tipo de evento/);
  assert.match(historico, /Filtrar por período/);
  assert.match(historico, /Buscar no histórico|Buscar alertas no histórico/);
  assert.match(historico, /Buscar host, problema ou ator|Buscar host, problema ou cliente/);
  assert.doesNotMatch(historico, /alert_history|paginação server-side|Filtrar por fonte/);
  assert.doesNotMatch(historico, /Lista global em preparação|Em preparação/);
  assert.doesNotMatch(historico, /fake|mockRows|placeholderRows/i);
  assert.doesNotMatch(historico, /Total persistido/);
  assert.doesNotMatch(historico, /Alertas ativos/);
});

test("Home filtra eventos técnicos e preserva dados no refresh parcial", async () => {
  const index = await read("src/pages/Index.tsx");
  assert.match(index, /HOME_EVENT_ALLOWLIST/);
  assert.match(index, /problem_created/);
  assert.match(index, /created_from_zabbix/);
  assert.match(index, /acknowledged/);
  assert.match(index, /ack_message/);
  assert.match(index, /severity_changed/);
  assert.match(index, /recovered/);
  assert.match(index, /HOME_EVENT_BLOCKLIST/);
  assert.match(index, /resolved_by_reconciliation/);
  assert.match(index, /isAllowedHomeEvent/);
  assert.match(index, /Promise\.allSettled/);
  assert.doesNotMatch(index.match(/loadLists[\s\S]*?finally/)?.[0] ?? "", /setPriorityAlerts\(\[\]\)/);
  assert.doesNotMatch(index.match(/loadSummary[\s\S]*?finally/)?.[0] ?? "", /setMetrics\(null\)/);
  assert.doesNotMatch(index.match(/loadSummary[\s\S]*?finally/)?.[0] ?? "", /closeAlert/);
  assert.match(index, /Os valores anteriores foram mantidos/);
  assert.match(index, /Tentar novamente/);
});

test("página de chamados é placeholder seguro sem mocks", async () => {
  const [chamados, app, index, sidebar] = await Promise.all([
    read("src/pages/Chamados.tsx"),
    read("src/App.tsx"),
    read("src/pages/Index.tsx"),
    read("src/components/layout/Sidebar.tsx"),
  ]);

  assert.doesNotMatch(chamados, /mock-data|mockChamados|mockClients/);
  assert.doesNotMatch(chamados, /\bRITM\d+|\bINC\d+/i);
  assert.doesNotMatch(chamados, /FRAPORT|Castrolanda|Zurich|Havan|Osasco|BNB|NOC [A-E]\b/i);
  assert.doesNotMatch(chamados, /statusSummary|filteredChamados|Exportar lista|Novo chamado/);
  assert.match(chamados, /A integração com o ServiceNow está em preparação\./);
  assert.match(
    chamados,
    /Os chamados relacionados aos alertas serão exibidos nesta área após a conclusão do\s+contrato técnico e da integração\./,
  );
  assert.match(chamados, /Número/);
  assert.match(chamados, /Estado/);
  assert.match(chamados, /Grupo responsável/);
  assert.match(chamados, /Responsável/);
  assert.match(chamados, /SLA/);
  assert.match(chamados, /Última atualização/);
  assert.match(chamados, /Nenhum chamado disponível/);

  assert.match(app, /path="\/chamados"/);
  assert.match(app, /ChamadosPage/);
  assert.doesNotMatch(sidebar, /href: "\/chamados"/);
  assert.doesNotMatch(index, /Abrir área de chamados|to="\/chamados"/);
});

test("navegação lateral aponta somente para rotas registradas no App", async () => {
  const [sidebar, app, index, pages] = await Promise.all([
    read("src/components/layout/Sidebar.tsx"),
    read("src/App.tsx"),
    read("src/pages/Index.tsx"),
    list("src/pages"),
  ]);

  const sidebarHrefs = [...sidebar.matchAll(/href: "([^"]+)"/g)].map((match) => match[1]);
  const appRoutes = new Set([...app.matchAll(/path="([^"]+)"/g)].map((match) => match[1]));

  assert.deepEqual(
    sidebarHrefs,
    ["/", "/monitoramento", "/alertas", "/historico"],
    "Sidebar operacional deve conter Início, Monitoramento, Alertas e Histórico",
  );

  for (const href of sidebarHrefs) {
    assert.ok(appRoutes.has(href), `Sidebar aponta para rota inexistente: ${href}`);
  }

  for (const preserved of ["/", "/monitoramento", "/alertas", "/historico"]) {
    assert.ok(sidebarHrefs.includes(preserved), `Sidebar deve preservar ${preserved}`);
    assert.ok(appRoutes.has(preserved), `App deve preservar ${preserved}`);
  }

  assert.ok(appRoutes.has("/chamados"), "App deve manter a rota /chamados oculta da Sidebar");
  assert.ok(!sidebarHrefs.includes("/chamados"), "Sidebar não deve expor /chamados");

  // OV-P0-18: /config permanece acessível por URL, mas fora da Sidebar.
  assert.ok(appRoutes.has("/config"), "App deve manter a rota /config");
  assert.ok(pages.includes("Settings.tsx"), "Settings.tsx não deve ser removido");
  assert.ok(!sidebarHrefs.includes("/config"), "Sidebar não deve expor /config");
  assert.doesNotMatch(sidebar, /name: "Configurações"|href: "\/config"|from "lucide-react".*Settings|Settings,/);
  assert.match(sidebar, /Ativar modo escuro|Ativar modo claro|oneview-theme/);

  for (const removed of ["/kpis", "/relatorios"]) {
    assert.ok(!sidebarHrefs.includes(removed), `Sidebar não deve expor ${removed}`);
    assert.ok(!appRoutes.has(removed), `App não deve registrar ${removed}`);
  }

  assert.doesNotMatch(sidebar, /KPIs|Relatórios|BarChart3|FileText/);
  // O card OV-P0-03 proíbe telas fictícias apenas para eliminar 404.
  assert.doesNotMatch(app, /Kpis|Relatorios/i);
  for (const page of pages) {
    assert.doesNotMatch(page, /^(Kpis|KPIs|Relatorios)\.tsx$/i);
  }

  // ServiceNow/Chamados ficam fora da navegação e da Home operacional.
  assert.doesNotMatch(sidebar, /ServiceNow|href: "\/chamados"/i);
  assert.doesNotMatch(index, /A integração com o ServiceNow está em preparação\.|Abrir área de chamados/);
});

test("OV-P0-20 navegação operacional diferencia Monitoramento, Alertas e Histórico", async () => {
  const sidebar = await read("src/components/layout/Sidebar.tsx");

  assert.match(sidebar, /icon: Monitor/);
  assert.match(sidebar, /icon: Bell/);
  assert.match(sidebar, /icon: History/);
  assert.match(sidebar, /liveDot: true/);
  assert.match(sidebar, /secondary: "Fila operacional"/);
  assert.match(sidebar, /secondary: "Eventos e ações"/);
  assert.match(sidebar, /navToneClasses/);
  assert.match(sidebar, /bg-white\/15/);
  assert.match(sidebar, /h-7 w-1/);
  assert.doesNotMatch(sidebar, /accent: "monitor"|accent: "alerts"|accent: "history"/);
  assert.doesNotMatch(sidebar, /bg-emerald-500\/15|text-emerald-300|bg-emerald-400/);
  assert.doesNotMatch(sidebar, /bg-amber-500\/15|text-amber-200|bg-red-400/);
  assert.doesNotMatch(sidebar, /bg-sky-500\/15|text-sky-200|bg-sky-400/);
  assert.match(sidebar, /absolute left-0[\s\S]*w-1/);
  assert.match(sidebar, /hover:bg-white\/5/);
  assert.match(sidebar, /focus-visible:ring-2/);
  assert.match(sidebar, /aria-label=\{item\.secondary \? `\$\{item\.name\}\. \$\{item\.secondary\}` : item\.name\}/);
  assert.doesNotMatch(sidebar, /alerts_count|badgeCount|total_items|contagem/i);
  assert.doesNotMatch(sidebar, /href: "\/monitoramento"[\s\S]*href: "\/alertas"[\s\S]*className=\{\(\{ isActive \}\) =>\s*cn\(\s*"group\/link relative flex items-center justify-center h-12 w-12 rounded-full/);
});

test("OV-P0-19/38 Monitoramento NOC com Sidebar real, sem scroll e com janela recente", async () => {
  const [monitoring, app, sidebar, healthStrip, healthLib, recent, pages] = await Promise.all([
    read("src/pages/Monitoring.tsx"),
    read("src/App.tsx"),
    read("src/components/layout/Sidebar.tsx"),
    read("src/components/oneview/PlatformHealthStrip.tsx"),
    read("src/lib/platform-health.ts"),
    read("src/lib/oneview-recent.ts"),
    list("src/pages"),
  ]);

  assert.ok(pages.includes("Monitoring.tsx"));
  assert.match(app, /path="\/monitoramento"/);
  assert.match(app, /MonitoringPage/);
  assert.match(sidebar, /name: "Monitoramento"/);
  assert.match(sidebar, /href: "\/monitoramento"/);
  assert.match(monitoring, /components\/layout\/Sidebar/);
  assert.match(monitoring, /<Sidebar/);
  assert.match(monitoring, /monitoringCollapse/);
  assert.doesNotMatch(monitoring, /MonitoringControlsRail/);
  assert.doesNotMatch(monitoring, /Voltar ao Início|casinha|w-\[200px\]/);
  assert.match(monitoring, /h-\[100dvh\].*w-\[100vw\]/);
  assert.match(monitoring, /html\.style\.overflow = "hidden"/);
  assert.match(monitoring, /body\.style\.overflow = "hidden"/);
  assert.match(monitoring, /overflow-hidden/);
  assert.doesNotMatch(monitoring, /overflow-auto|overflow-y-auto|overflow-x-auto/);

  assert.match(monitoring, /searchParams\.get\("tv"\) === "1"/);
  assert.match(monitoring, /data-tv=\{tvMode \? "1" : "0"\}/);
  assert.match(monitoring, /REFRESH_MS = 30_000/);
  assert.match(monitoring, /hasDataRef/);
  assert.match(monitoring, /Valores anteriores mantidos/);
  assert.match(monitoring, /PlatformHealthStrip/);
  assert.match(monitoring, /bg-background/);
  assert.match(monitoring, /requestFullscreen/);
  assert.match(monitoring, /exitFullscreen/);
  assert.match(monitoring, /aria-pressed=\{isFullscreen\}/);
  assert.doesNotMatch(monitoring, /Pausar|Retomar|setIsPaused/);

  assert.match(monitoring, /PRIORITY_LIMIT = 6/);
  assert.match(monitoring, /ATTENTION_LIMIT = 5/);
  assert.match(monitoring, /EVENTS_LIMIT = 5/);
  assert.match(monitoring, /HOSTS_LIMIT = 5/);
  assert.match(monitoring, /queueOverflowLabel/);
  assert.match(monitoring, /MONITOR_VISUAL_SEVERITY_STRIP|CompactMetricStrip/);
  assert.match(monitoring, /homeWindowActiveLabel|parseHomeWindow/);
  assert.match(monitoring, /formatNullableCount/);
  assert.doesNotMatch(monitoring, /Novos na última hora|ACK 30 min/);
  assert.doesNotMatch(monitoring, /label: "Última sincronização"/);
  assert.match(monitoring, /ClientFilterCombobox/);
  assert.doesNotMatch(monitoring, /metricDisplay\(hasValidSummary/);
  assert.doesNotMatch(monitoring, /Total persistido|Em acompanhamento no OneView|active_total/);

  assert.doesNotMatch(monitoring, /Panel title="Saúde"/);
  assert.match(healthStrip, /aria-label="Saúde operacional"/);
  assert.match(healthLib, /teletex-http/);

  assert.match(monitoring, /fetchRecentPriorityAlerts/);
  assert.match(monitoring, /fetchRecentOperationalMetrics/);
  assert.match(monitoring, /fetchRecentAlerts/);
  assert.match(monitoring, /fetchAttentionRequired/);
  assert.match(monitoring, /windowMs|parseHomeWindow|HOME_WINDOW_OPTIONS/);
  assert.match(monitoring, /h-fit w-fit shrink-0 self-start/);
  assert.match(recent, /acknowledgedSource: false/);
  assert.match(recent, /firstSeenFrom: isoAgo\(windowMs|firstSeenFrom: isoAgo\(RECENT_PRIORITY_WINDOW_MS|firstSeenFrom: isoAgo\(priorityWindow/);
  assert.match(recent, /occurredFrom: isoAgo\(windowMs|occurredFrom: isoAgo\(RECENT_EVENTS_WINDOW_MS/);
  assert.match(healthStrip, /fetchOperationsHealth/);
  assert.match(healthStrip, /fetchOneViewHealth/);
  assert.match(healthStrip, /fetchSyncLogs/);
  assert.doesNotMatch(monitoring, /mock|faker|hardcodedAlerts|DEMO_/i);

  assert.doesNotMatch(monitoring, /Fonte Teletex|Banco em tempo real|Contingência/);
  assert.match(monitoring, /selectedCustomerKeys/);
  assert.match(monitoring, /fetchOneViewFacets/);
  assert.match(monitoring, /ClientIdentity|canonicalClientName|UNCLASSIFIED_CLIENT_LABEL|Cliente/);
  assert.match(monitoring, /formatOneViewSeverityLabel/);
  assert.match(monitoring, /\/alertas\?alert=\$\{encodeURIComponent\(alert\.id\)\}&view=/);
  assert.doesNotMatch(monitoring, /ServiceNow/i);
  assert.doesNotMatch(monitoring, /PgBouncer/i);
  assert.doesNotMatch(monitoring, /ranking de clientes|by_client|clientes mais/i);
});

test("OV-P0-23 Home/Monitoramento usam janelas recentes server-side", async () => {
  const [index, monitoring, recent, alerts, api, config] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/lib/oneview-recent.ts"),
    read("src/pages/Alerts.tsx"),
    read("src/lib/oneview-api.ts"),
    read("api/_lib/oneview-config.js"),
  ]);

  assert.match(recent, /RECENT_PRIORITY_WINDOW_MS = 2 \* 60 \* 60 \* 1000/);
  assert.match(recent, /RECENT_EVENTS_WINDOW_MS = 30 \* 60 \* 1000/);
  assert.match(recent, /RECENT_CREATED_WINDOW_MS = 60 \* 60 \* 1000/);
  assert.match(recent, /acknowledgedSource: false/);
  assert.match(recent, /firstSeenFrom: isoAgo\((?:windowMs|priorityWindow|RECENT_PRIORITY_WINDOW_MS)/);
  assert.match(recent, /acknowledgedFrom: isoAgo\((?:ackWindow|windowMs|RECENT_EVENTS_WINDOW_MS)/);
  assert.match(recent, /occurredFrom: isoAgo\((?:windowMs|RECENT_EVENTS_WINDOW_MS)/);
  assert.match(recent, /compareRecentPriorityAlerts/);
  assert.match(recent, /queueOverflowLabel/);
  assert.match(recent, /\+ \$\{extra\.toLocaleString\("pt-BR"\)\} na fila/);

  assert.match(index, /fetchRecentPriorityAlerts/);
  assert.match(index, /fetchRecentOperationalMetrics/);
  assert.match(index, /fetchRecentOperationalEvents/);
  assert.match(index, /PRIORITY_PAGE_SIZE = 6/);
  assert.match(index, /HOME_VISUAL_SEVERITY_STRIP|CompactMetricStrip/);
  assert.match(index, /homeWindowActiveLabel/);
  assert.doesNotMatch(index, /Novos nas últimas \$\{windowLabel\}/);
  assert.doesNotMatch(index, /Disaster sem ACK · \$\{windowLabel\}/);
  assert.doesNotMatch(index, /ACK realizados · \$\{windowLabel\}/);
  assert.match(index, /queueOverflowLabel\(priorityTotal/);
  assert.doesNotMatch(index, /active_total|Total persistido|Em acompanhamento no OneView/);
  assert.doesNotMatch(index, /fetchAlertMetrics\(/);

  assert.match(monitoring, /PRIORITY_LIMIT = 6/);
  assert.match(monitoring, /ATTENTION_LIMIT = 5/);
  assert.match(monitoring, /EVENTS_LIMIT = 5/);
  assert.match(monitoring, /HOSTS_LIMIT = 5/);
  assert.match(monitoring, /Sidebar|monitoringCollapse/);
  assert.doesNotMatch(monitoring, /MonitoringControlsRail/);

  assert.match(alerts, /setDatePreset\("24h"\)/);
  assert.match(alerts, /if \(initialView === "recent"\) return "24h"/);
  assert.match(alerts, /if \(initialView === "all"\) return "30d"/);
  assert.match(alerts, /setDatePreset\("30d"\)/);
  assert.match(alerts, /setSourceAckFilter\("unacknowledged"\)/);
  assert.match(alerts, /"2h": 2 \* 60 \* 60_000/);
  assert.match(alerts, /"24h": 24 \* 60 \* 60_000/);
  assert.match(alerts, /view === "open"/);
  assert.match(alerts, /view === "resolved"/);
  assert.doesNotMatch(alerts, /Filtrar ACK da origem|Filtrar status/);
  assert.match(alerts, /Últimas 24 horas/);
  assert.match(alerts, /Últimos 30 dias/);
  assert.match(alerts, /Janelas rolantes a partir de agora/);

  assert.match(api, /first_seen_from/);
  assert.match(api, /options\.firstSeenFrom/);
  assert.match(config, /"attention-required"[\s\S]*first_seen_from/);
});

test("atalho da Home abre o drawer do alerta sem depender da página atual", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /useSearchParams\(\)/);
  assert.match(alerts, /const requestedAlertId = searchParams\.get\("alert"\)/);
  assert.match(alerts, /void loadSelectedAlert\(requestedAlertId\)/);
  assert.match(alerts, /nextSearchParams\.set\("alert", alert\.id\)/);
  assert.match(alerts, /nextSearchParams\.delete\("alert"\)/);
});

test("limite de staleness permanece no contrato; drawer não exibe bloco de frescor (OV-P0-09)", async () => {
  const [alerts, api, config] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/lib/oneview-api.ts"),
    read("api/_lib/oneview-config.js"),
  ]);
  assert.match(config, /ONEVIEW_ALERT_STALE_MINUTES/);
  assert.match(api, /alert_stale_minutes/);
  assert.doesNotMatch(alerts, /Frescor do dado|Tempo sem confirmação|Duração longa não indica falha de sincronização/);
  assert.doesNotMatch(alerts, /Ativo e confirmado recentemente|Ativo, mas sem confirmação recente|Dados possivelmente desatualizados/);
  assert.match(alerts, /\["Duração",/);
  assert.match(alerts, /\["Última atualização",/);
});

test("cliente não classificado é filtrável sem usar datasource como cliente", async () => {
  const [index, alerts, clientIdentity] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/components/oneview/ClientIdentity.tsx"),
  ]);
  assert.match(clientIdentity, /Cliente não classificado/);
  assert.match(clientIdentity, /teletex-http/);
  assert.match(clientIdentity, /canonicalHostName/);
  assert.match(index, /ClientIdentity|canonicalClientName/);
  assert.match(alerts, /customer\.key === "unclassified"/);
  assert.match(alerts, /UNCLASSIFIED_CLIENT_LABEL|Cliente não classificado/);
  assert.match(alerts, /não forneceu evidências suficientes para associar este alerta automaticamente a um cliente/);
  assert.doesNotMatch(index, /customer_name\s*\|\|\s*alert\.datasource_name/);
});

test("alertas preserva a normalização canônica de severidade Zabbix", async () => {
  const [alerts, api] = await Promise.all([read("src/pages/Alerts.tsx"), read("src/lib/oneview-api.ts")]);
  for (const [severity, label] of [
    ["disaster", "Disaster"],
    ["high", "High"],
    ["average", "Average"],
    ["warning", "Warning"],
    ["information", "Information"],
    ["not_classified", "Not classified"],
  ]) {
    assert.match(api, new RegExp(`${severity}: \\{ label: "${label}"`));
  }
  assert.match(api, /export function formatOneViewSeverityLabel/);
  assert.match(api, /export function canonicalizeSeveritiesForApi/);
  assert.match(api, /export function disasterFamilySeverities/);
  assert.match(api, /if \(Number\(counts\?\.critical \?\? 0\) > 0\) severities\.push\("critical"\)/);
  assert.doesNotMatch(api, /high: \{ label: "Crítico"/);
  assert.doesNotMatch(api, /label: "Desastre"|label: "Crítico"|label: "Alto"|label: "Médio"|label: "Aviso"|label: "Informação"|label: "Não classificado"/);
  assert.match(alerts, /formatOneViewSeverityLabel/);
  assert.match(alerts, /const severityOrder: OneViewSeverity\[\] = \[\.\.\.ONEVIEW_V1_FILTER_SEVERITIES\]/);
  assert.match(alerts, /writeAlertsUrlParams|selectedSeverities/);
  assert.doesNotMatch(alerts, /rawSeverities|next\.append\("priority"/);
  assert.match(alerts, /sortableHeader\("Severidade", "severity"\)/);
  assert.match(alerts, />Ações<\/TableHead>/);
  assert.doesNotMatch(alerts, /<UserCheck className="h-3\.5 w-3\.5" \/> ACK<\/Button>/);
  assert.doesNotMatch(alerts, /Informativo \(baixa prioridade\)|>Severidade<\/TableHead>/);
  assert.doesNotMatch(alerts, /acknowledged_internal_comment \? <p className="mt-1 line-clamp-2/);
});

test("cards de indicadores aplicam filtros rápidos sem textos redundantes", async () => {
  const [alerts, metricStrip] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/components/oneview/CompactMetricStrip.tsx"),
  ]);
  assert.match(alerts, /type SummaryFilter =[\s\S]*"information"[\s\S]*"warning"[\s\S]*"average"[\s\S]*"high"[\s\S]*"disaster"[\s\S]*"not_classified"/);
  assert.match(alerts, /const applySummaryFilter = \(filter: SummaryFilter\)/);
  assert.match(alerts, /CompactMetricStrip/);
  assert.match(metricStrip, /aria-label=\{`Filtrar alertas: \$\{item\.label\}/);
  assert.match(metricStrip, /md:flex-nowrap/);
  assert.match(alerts, /onClick: \(\) => applySummaryFilter\(card\.filter\)/);
  assert.match(alerts, /VISUAL_SEVERITY_STRIP/);
  assert.match(alerts, /Severidade fora da faixa visual/);
  assert.match(alerts, /title: "Em acompanhamento"/);
  assert.match(alerts, /Ocorrências atualmente mantidas como ativas no OneView\./);
  assert.match(alerts, /formatNullableCount|value === null \? "—" : Number\(value\)\.toLocaleString\("pt-BR"\)/);
  assert.match(alerts, /filteredSummary/);
  assert.match(alerts, /Filtros rápidos por indicadores/);
  assert.doesNotMatch(alerts, /Total persistido/);
  assert.doesNotMatch(alerts, /title: "Alertas ativos"/);
  assert.doesNotMatch(alerts, /Resumo global do OneView/);
  assert.doesNotMatch(alerts, /Métricas de todo o ambiente\. Os controles da tabela afetam somente a listagem\./);
  assert.doesNotMatch(alerts, /Escopo desta tabela:/);
  assert.doesNotMatch(alerts, /xl:grid-cols-5[\s\S]*summaryCards\.map/);
  assert.match(alerts, /filtrados por \{tableCustomerScope\}/);
});

test("OV-P0-15B métricas enganosas: erro não vira zero e rótulos operacionais", async () => {
  const [index, alerts, historico, metricStrip] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
    read("src/components/oneview/CompactMetricStrip.tsx"),
  ]);

  assert.match(index, /hasValidSummary/);
  assert.match(index, /by_severity|HOME_VISUAL_SEVERITY_STRIP/);
  assert.match(index, /formatMetricCount|formatNullableCount/);
  assert.match(index, /unknown: value == null|Sem informação/);
  assert.doesNotMatch(index, /Total persistido/);
  assert.doesNotMatch(index, /title: "Alertas ativos"/);
  assert.doesNotMatch(index, /Problemas ativos no Zabbix/);
  assert.doesNotMatch(index, /kpiCards|Novos nas últimas \$\{windowLabel\}/);

  assert.match(alerts, /title: "Em acompanhamento"/);
  assert.match(alerts, /Ocorrências atualmente mantidas como ativas no OneView\./);
  assert.match(alerts, /formatCardValue|formatNullableCount/);
  assert.match(alerts, /filteredSummary/);
  assert.match(alerts, /formatNullableCount|value === null \? "—"/);
  assert.match(metricStrip, /Sem informação/);
  assert.match(alerts, /summaryError|OperationalErrorBanner|Tentar novamente/);
  assert.doesNotMatch(alerts, /Total persistido/);
  assert.doesNotMatch(alerts, /title: "Alertas ativos"/);
  assert.doesNotMatch(alerts, /Problemas ativos no Zabbix/);

  assert.match(historico, /eventos registrados/i);
  assert.doesNotMatch(historico, /Total persistido/);
  assert.doesNotMatch(historico, /Alertas ativos/);
  assert.doesNotMatch(historico, /Problemas ativos no Zabbix/);
});

test("OV-P0-17 resumo operacional compacto prioriza tabela", async () => {
  const [alerts, index, historico, metricStrip] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/pages/Index.tsx"),
    read("src/pages/Historico.tsx"),
    read("src/components/oneview/CompactMetricStrip.tsx"),
  ]);

  assert.match(alerts, /OV-P0-17/);
  assert.match(alerts, /CompactMetricStrip/);
  assert.match(metricStrip, /md:flex-nowrap/);
  assert.match(alerts, /title: "Em acompanhamento"/);
  assert.match(alerts, /title: "Reconhecidos"/);
  assert.match(alerts, /title: "Pendentes"/);
  assert.match(alerts, /VISUAL_SEVERITY_STRIP/);
  assert.match(alerts, /severityCatalog\[severity\]\.label/);
  assert.match(alerts, /notClassifiedCard/);
  assert.match(alerts, /formatCardValue/);
  assert.match(alerts, /formatNullableCount|value === null \? "—"/);
  assert.match(alerts, /applySummaryFilter\(card\.filter\)/);
  assert.doesNotMatch(alerts, /Total persistido/);
  assert.doesNotMatch(alerts, /grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5/);

  assert.match(index, /Resumo operacional/);
  assert.doesNotMatch(index, /Atenção necessária/);
  assert.match(index, /Prioridade agora/);
  assert.match(index, /Eventos recentes/);
  assert.doesNotMatch(index, /SyncsStatusPanel|PlatformHealthStrip/);
  assert.doesNotMatch(index, /Saúde da plataforma/);
  assert.match(index, /h-12 w-full/);
  assert.match(index, /CompactMetricStrip|font-semibold tabular-nums/);
  assert.doesNotMatch(index, /Skeleton key=\{index\} className="h-24 w-full"/);

  assert.match(historico, /eventos registrados/i);
  assert.doesNotMatch(historico, /summaryCards|Resumo operacional|title: "Em acompanhamento"|title: "Disaster"/);
  assert.doesNotMatch(historico, /Total persistido|Alertas ativos/);
});

test("coluna IP sanitizada permanece no drawer e fora da tabela operacional", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /function safeHostIp\(value: unknown\): string \| null/);
  assert.match(alerts, /first === 10 \|\| first === 127/);
  assert.match(alerts, /first === 192 && second === 168/);
  assert.match(alerts, /safeHostIp\(selectedAlert\.host_ip\)/);
  assert.doesNotMatch(alerts, /showIpColumn/);
  assert.doesNotMatch(alerts, /<TableHead className="px-3 text-center">IP<\/TableHead>/);
});

test("tabela reserva espaço para ACK e ações; tema lateral é persistente", async () => {
  const [alerts, sidebar] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/components/layout/Sidebar.tsx"),
  ]);
  assert.match(alerts, /sortableHeader\("Severidade", "severity"\)/);
  assert.match(alerts, /sortableHeader\("Início", "first_seen_at"\)/);
  assert.match(alerts, />Cliente</);
  assert.doesNotMatch(alerts, />Chamado</);
  assert.match(alerts, /Reconhecido por \$\{ack\.actorLabel\}/);
  assert.match(alerts, /Integração ServiceNow em preparação\./);
  assert.doesNotMatch(alerts, /sortableHeader\("Cliente", "client"\)|sortableHeader\("Fonte", "datasource"\)/);
  assert.doesNotMatch(alerts, />OneView<\/span>|Não tratado/);
  assert.doesNotMatch(alerts, /CustomerLogo customer=\{\{ key: alert\.customer_key/);
  assert.match(alerts, /aria-label=\"Ver detalhes do alerta\"/);
  assert.match(alerts, /<Eye className=\"h-3\.5 w-3\.5\" \/>\s*<span className=\"sr-only\">Ver detalhes do alerta<\/span>/);
  assert.doesNotMatch(alerts, /<Eye className=\"h-3\.5 w-3\.5\" \/> Ver/);
  assert.doesNotMatch(alerts, /dataSource=\{currentDataSource\}/);
  assert.match(sidebar, /window\.localStorage\.getItem\("oneview-theme"\)/);
  assert.match(sidebar, /window\.localStorage\.setItem\("oneview-theme", theme\)/);
  assert.match(sidebar, /Ativar modo escuro/);
  assert.match(sidebar, /Ativar modo claro/);
});

test("drawer carrega detalhe e histórico e exibe somente ACK real da origem", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /Promise\.allSettled\(\[\s*fetchAlert\(id, controller\.signal\),\s*fetchAlertHistory\(id, controller\.signal\)/);
  assert.match(alerts, /fetchAlertMetrics\(\{ refresh: force \}\)/);
  assert.match(alerts, /loadSelectedAlert\(selectedAlert\.id\)/);
  assert.match(alerts, /acknowledged_internal_comment: ackComment\.trim\(\)/);
  assert.match(alerts, /<TabsTrigger value="summary"/);
  assert.match(alerts, /<TabsTrigger value="history"/);
  assert.match(alerts, /<TabsTrigger value="technical"/);
  assert.doesNotMatch(alerts, /ID do datasource/);
  assert.match(alerts, /requestAlertAcknowledgement/);
  assert.doesNotMatch(alerts, /Confirmar reconhecimento no OneView|maxLength=\{500\}|Reconhecer no OneView/);
  assert.match(alerts, /ackRequestAllowedFor/);
  assert.match(alerts, /teletex-http/);
  assert.match(alerts, /sourceAcknowledgementComment/);
  assert.match(alerts, /resolveOfficialAckComment/);
  assert.match(alerts, /isValidZabbixAckComment/);
  assert.match(alerts, /Reconhecido por \$\{ack\.actorLabel\}/);
  assert.doesNotMatch(alerts, /Sem comentário registrado na origem\.|Sem comentário registrado/);
  assert.doesNotMatch(alerts, /Para reconhecer na origem, use o Zabbix/);
  assert.match(alerts, /Detalhes históricos deste reconhecimento não estão disponíveis no registro legado\./);
  assert.match(alerts, /source_ack/);
  assert.match(alerts, /source_ack é o reconhecimento selecionado pelo contrato atual/);
  assert.match(alerts, /health\?\.capabilities\?\.acknowledgement === true/);
  assert.match(alerts, /Atribuição operacional em preparação\./);
  assert.match(alerts, /if \(!ackRequestsEnabled \|\| !selectedAlert \|\| !ackRequestKey \|\| ackSubmitting\) return;/);
  assert.doesNotMatch(alerts, /disabled=\{ackSubmitting \|\| !selectedAlert \|\| !ackRequestsEnabled \|\| ackComment\.trim\(\)\.length === 0\}/);
  assert.match(alerts, /customerPresentation\(selectedAlert\)/);
  assert.match(alerts, /selectedAlert\.datasource_name/);
  assert.match(alerts, /selectedAlert\.host_groups/);
  assert.match(alerts, /selectedAlert\.event_tags/);
  assert.match(alerts, /item\.occurred_at/);
  assert.match(alerts, /Completo/);
  assert.match(alerts, /Enriquecimento parcial/);
  assert.match(alerts, /enrichmentExplanations/);
  assert.match(alerts, /Histórico legado/);
  assert.match(alerts, /UNCLASSIFIED_CLIENT_LABEL|Cliente não classificado/);
  assert.match(alerts, /A fonte \$\{datasource\} não forneceu evidências suficientes para associar este alerta automaticamente a um cliente\./);
  assert.match(alerts, /Grupos disponíveis/);
  assert.match(alerts, /Tags disponíveis/);
  assert.match(alerts, /revise as tags e os grupos na origem/);
  assert.match(alerts, /isUnclassifiedClient|datasource_fallback/);
  assert.doesNotMatch(alerts, /Dados históricos aguardando classificação|Classificação histórica pendente/);
  assert.doesNotMatch(alerts, /Cliente pendente/);
  assert.match(alerts, /Eventos registrados/);
  assert.match(alerts, /Primeira ocorrência/);
  assert.match(alerts, /Última ocorrência/);
  assert.match(alerts, /ACK atual/);
  assert.match(alerts, /Recovery/);
  assert.match(alerts, /ACK atual confirmado pela origem/);
  assert.match(alerts, /Responsável não informado pela origem/);
  assert.match(alerts, /sourceAckConfirmedWithoutHistory/);
  assert.match(alerts, /Detalhes históricos deste reconhecimento não estão disponíveis no registro legado\./);
  assert.doesNotMatch(alerts, /Os detalhes históricos deste reconhecimento não estão disponíveis no registro legado\./);
  assert.match(alerts, /Processado pelo Worker OneView/);
  assert.match(alerts, /formalHistoryTitle/);
  assert.match(alerts, /function sourceAckPresentation/);
  assert.match(alerts, /hasLoadedAlerts/);
  assert.match(alerts, /Atualizando\.\.\./);
  assert.match(alerts, /<details className="ov-panel p-4">/);
  assert.match(alerts, /Identificadores técnicos/);
  assert.match(alerts, /SelectItem value="unacknowledged">Sem ACK/);
  assert.doesNotMatch(alerts, /Evidência parcial/);
  assert.match(alerts, /item\.ack_actor_name/);
  assert.doesNotMatch(alerts, /actor_id/);
  assert.match(alerts, /Horário da origem/);
  assert.match(alerts, /Registrado no OneView/);
  assert.match(alerts, /historyOrigin\(group\.primary\) === "Zabbix"/);
  assert.match(alerts, /Fonte Zabbix/);
  assert.match(alerts, /Integridade do histórico/);
  assert.match(alerts, /historyQuality/);
  assert.match(alerts, /Histórico indisponível/);
  assert.match(alerts, /Valor anterior/);
  assert.match(alerts, /Valor atual/);
  assert.match(alerts, /groupHistoryItems/);
  assert.match(alerts, /Ocorrência atualizada/);
  assert.match(alerts, /Reconhecimentos/);
  assert.match(alerts, /Mudanças/);
  assert.match(alerts, /Legado/);
  assert.match(alerts, /Ver horários das ocorrências agrupadas/);
  assert.match(alerts, /<summary className="cursor-pointer text-sm font-semibold">Origem técnica<\/summary>/);
  assert.match(alerts, /<summary className="cursor-pointer text-sm font-semibold">Host técnico<\/summary>/);
  assert.match(alerts, /Trigger e item/);
  assert.match(alerts, /Classificação/);
  assert.match(alerts, /Auditoria temporal/);
  assert.match(alerts, /Nenhum evento estruturado foi encontrado para este alerta\. O estado atual do alerta continua disponível no resumo\./);
  assert.doesNotMatch(alerts, /Eventos anteriores ao enriquecimento podem possuir menos detalhes\./);
  assert.doesNotMatch(alerts, /JSON\.stringify\(value\)/);
  assert.match(alerts, /disabled className="w-full"/);
  assert.doesNotMatch(alerts.match(/const loadAlerts[\s\S]*?const loadSummaryResources/)?.[0] ?? "", /setSelectedAlertId\(null\)/);
  assert.doesNotMatch(alerts, /addAlertNote|assignAlert|updateAlertStatus/);
});

test("badge e contingência refletem respostas atuais do BFF", async () => {
  const [api, alerts, layout] = await Promise.all([
    read("src/lib/oneview-api.ts"),
    read("src/pages/Alerts.tsx"),
    read("src/components/layout/AppLayout.tsx"),
  ]);
  assert.match(api, /headerSource === "snapshot" \|\| bodySource === "snapshot"/);
  assert.match(api, /headerSource === "database" \|\| bodySource === "database"/);
  assert.match(alerts, /baseMetas\.some\(\(meta\) => meta\.source === "snapshot"\)/);
  assert.match(alerts, /Dados em modo de contingência/);
  assert.match(alerts, /Tentar novamente/);
  assert.match(layout, /"Banco em tempo real" : "Cópia atualizada"/);
});

test("rotas dinâmicas e rewrite SPA permanecem compatíveis com Vercel", async () => {
  const [detail, history, operations, globalHistory, vercel] = await Promise.all([
    read("api/oneview/alerts/[id].js"),
    read("api/oneview/alerts/[id]/history.js"),
    read("api/oneview/operations/health.js"),
    read("api/oneview/history.js"),
    read("vercel.json").then(JSON.parse),
  ]);
  assert.match(detail, /createOneViewHandler\("alert-detail"\)/);
  assert.match(history, /createOneViewHandler\("alert-history"\)/);
  assert.match(operations, /createOneViewHandler\("operations-health"\)/);
  assert.match(globalHistory, /createOneViewHandler\("history"\)/);
  assert.deepEqual(vercel.rewrites, [{ source: "/((?!api/.*).*)", destination: "/index.html" }]);
});

test("alertas possui visualizações Recentes, Em aberto, Prioritários, Esquecidos, Resolvidos e Todos", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /type AlertsView = "recent" \| "open" \| "priority" \| "forgotten" \| "resolved" \| "all"/);
  assert.match(alerts, /applyAlertsView/);
  assert.match(alerts, /label: "Recentes"/);
  assert.match(alerts, /label: "Em aberto"/);
  assert.match(alerts, /label: "Prioritários"/);
  assert.match(alerts, /label: "Esquecidos"/);
  assert.match(alerts, /label: "Resolvidos"/);
  assert.match(alerts, /label: "Todos"/);
  assert.match(alerts, /writeAlertsUrlParams|view: alertsView/);
  assert.match(alerts, /inferAlertsView/);
  assert.match(alerts, /Visualizações de alertas/);

  const recentBlock = alerts.match(/if \(view === "recent"\) \{[\s\S]*?return;\s*\}/);
  assert.ok(recentBlock);
  assert.match(recentBlock[0], /setStatusFilter\("active"\)/);
  assert.match(recentBlock[0], /setSortField\("first_seen_at"\)/);
  assert.match(recentBlock[0], /setSortOrder\("desc"\)/);

  const openBlock = alerts.match(/if \(view === "open"\) \{[\s\S]*?return;\s*\}/);
  assert.ok(openBlock);
  assert.match(openBlock[0], /setStatusFilter\("active"\)/);
  assert.match(openBlock[0], /setSortField\("last_seen_at"\)/);

  const priorityBlock = alerts.match(/if \(view === "priority"\) \{[\s\S]*?return;\s*\}/);
  assert.ok(priorityBlock);
  assert.match(priorityBlock[0], /setStatusFilter\("active"\)/);
  assert.match(priorityBlock[0], /setSelectedSeverities\(\["disaster", "high"\]\)/);
  assert.match(priorityBlock[0], /setSourceAckFilter\("unacknowledged"\)/);
  assert.match(priorityBlock[0], /setSortField\("severity"\)/);
  assert.match(priorityBlock[0], /setSortOrder\("desc"\)/);
  assert.doesNotMatch(priorityBlock[0], /\.sort\(|comparePriority|unacknowledged_minutes|duration_seconds/);

  const forgottenBlock = alerts.match(/if \(view === "forgotten"\) \{[\s\S]*?return;\s*\}/);
  assert.ok(forgottenBlock);
  assert.match(forgottenBlock[0], /setStatusFilter\("active"\)/);
  assert.match(forgottenBlock[0], /setSourceAckFilter\("unacknowledged"\)/);
  assert.match(forgottenBlock[0], /setSortField\("first_seen_at"\)/);
  assert.match(forgottenBlock[0], /setSortOrder\("asc"\)/);

  const resolvedBlock = alerts.match(/if \(view === "resolved"\) \{[\s\S]*?return;\s*\}/);
  assert.ok(resolvedBlock);
  assert.match(resolvedBlock[0], /setStatusFilter\("resolved"\)/);
  assert.match(resolvedBlock[0], /setSortField\("resolved_at"\)/);

  assert.match(alerts, /setStatusFilter\("all"\)/);
  assert.match(alerts, /setPage\(1\)/);
});

test("fila operacional /alertas cobre contrato OV-P0-07", async () => {
  const [alerts, index, api, scope] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/pages/Index.tsx"),
    read("src/lib/oneview-api.ts"),
    read("api/_lib/oneview-scope.js"),
  ]);

  assert.match(alerts, /fetchAlerts\(/);
  assert.match(alerts, /status: statusFilter/);
  assert.match(alerts, /acknowledgedSource: sourceAckFilter === "all" \? undefined : sourceAckFilter === "acknowledged"/);
  assert.match(alerts, /applySearchToFetchParams\(request, searchField, debouncedSearch\)/);
  assert.match(alerts, /sort: sortField/);
  assert.match(alerts, /order: sortOrder/);
  assert.match(alerts, /page,/);
  assert.match(alerts, /pageSize,/);
  assert.match(alerts, /setPage\(1\)/);
  assert.match(alerts, /pagination\.total_items/);
  assert.match(alerts, /normalizeAlertResponse/);
  assert.match(alerts, /hasLoadedAlerts/);
  assert.match(alerts, /showAlertsSkeleton = isAlertsLoading && !hasLoadedAlerts && alerts\.length === 0/);
  assert.match(alerts, /Atualizando\.\.\./);
  assert.match(alerts, /alertsError/);
  assert.match(alerts, /Tentar novamente/);
  assert.match(alerts, /Nenhum alerta corresponde aos filtros selecionados/);
  assert.match(alerts, /Sheet open=\{selectedAlertId !== null\}/);
  assert.match(alerts, /nextSearchParams\.set\("alert", alert\.id\)/);
  assert.doesNotMatch(alerts.match(/const loadAlerts[\s\S]*?finally/)?.[0] ?? "", /setAlerts\(\[\]\)/);
  assert.doesNotMatch(alerts.match(/loadAlerts[\s\S]*?finally/)?.[0] ?? "", /closeAlert/);
  assert.doesNotMatch(alerts, /setAlertsView\([\s\S]{0,40}loadAlerts|closeAlert\(\).*loadAlerts/);

  assert.match(alerts, /sourceAckPresentation/);
  assert.match(alerts, /Reconhecido por \$\{ack\.actorLabel\}/);
  assert.match(alerts, /ack\.status !== "acknowledged"/);
  assert.match(alerts, />Pendente</);
  assert.match(alerts, /ack\.actorLabel \? `Reconhecido por \$\{ack\.actorLabel\}` : "Reconhecido"/);
  assert.match(alerts, /ack\.at \? <p[\s\S]*formatDateTime\(ack\.at\)/);
  assert.doesNotMatch(alerts, /RITM\d+|INC\d+|SLA vencido|Sem chamado/);
  assert.match(alerts, /Integração ServiceNow em preparação\./);
  assert.doesNotMatch(alerts, />Chamado</);
  assert.match(alerts, /aria-label="ServiceNow"|Integração ServiceNow em preparação/);

  assert.match(alerts, /formatOneViewSeverityLabel\("not_classified"\)/);
  assert.match(alerts, /severityKey === "not_classified"/);
  assert.doesNotMatch(alerts, /FRAPORT|Zurich|Castrolanda/);

  assert.match(alerts, /Fonte Zabbix/);
  assert.match(alerts, /Cliente interno|selectedCustomer\?\.name/);
  assert.match(alerts, /host_groups/);
  assert.match(alerts, /event_tags|trigger_tags|host_tags/);

  assert.match(index, /disasterAlertsHref|severity.*disaster/);
  assert.match(index, /source_ack.*unacknowledged|sourceAck: "unacknowledged"/);
  assert.match(index, /view: "priority"|view=priority/);
  assert.match(alerts, /inferAlertsView/);
  assert.match(alerts, /acknowledged_source/);
  assert.match(alerts, /initialQuery\.get\("search"\)|initialQuery\.get\("host"\)/);
  assert.match(alerts, /initialQuery\.getAll\("severity"\)/);

  assert.match(api, /search\.set\("acknowledged_source"/);
  assert.match(scope, /teletex-http|ONEVIEW_PRIMARY_DATA_SOURCE/);
  assert.doesNotMatch(alerts, /ONEVIEW_PRIMARY_DATA_SOURCE_NAME\s*=/);
});

test("histórico global e clientes impactados vêm do BFF", async () => {
  const [api, database, fallback, config, historico] = await Promise.all([
    read("src/lib/oneview-api.ts"),
    read("api/_lib/oneview-db.js"),
    read("api/_lib/oneview-fallback.js"),
    read("api/_lib/oneview-config.js"),
    read("src/pages/Historico.tsx"),
  ]);
  assert.match(api, /fetchGlobalHistory/);
  assert.match(api, /\/oneview\/history/);
  assert.match(api, /disaster_count\?:/);
  assert.match(api, /max_severity\?:/);
  assert.match(config, /history: Object\.freeze/);
  assert.match(database, /fetchGlobalHistoryPayload/);
  assert.match(database, /case "history"/);
  assert.match(database, /disaster_count/);
  assert.match(database, /unacknowledged_count/);
  assert.match(database, /max_severity_rank/);
  assert.match(fallback, /globalHistoryPayload/);
  assert.match(fallback, /case "history"/);
  assert.match(historico, /fetchGlobalHistory/);
  assert.match(historico, /fetchAlerts/);
  assert.match(historico, /TabsTrigger value="alertas"/);
  assert.match(historico, /value: "actions"/);
  assert.match(historico, /Mudanças de severidade/);
  assert.match(database, /operational:/);
  assert.match(database, /identified: \["problem_created", "created_from_zabbix"\]/);
  assert.match(database, /actions: \[/);
  assert.match(database, /resolution: \["recovered"\]/);
  assert.doesNotMatch(database.match(/export const GLOBAL_HISTORY_EVENT_TYPES[\s\S]*?update:/)?.[0] ?? "", /resolution: \["recovered", "resolved_by_reconciliation"\]/);
  assert.match(fallback, /operational:/);
  assert.match(fallback, /identified: \["problem_created", "created_from_zabbix"\]/);
  assert.match(fallback, /actions: \[/);
  assert.match(api, /previous_value\?:/);
  assert.match(api, /current_value\?:/);
});

test("fila de atenção permanece server-side; Esquecidos vive em /alertas (OV-P0-31)", async () => {
  const [route, config, database, fallback, api, alerts, index, monitoring] = await Promise.all([
    read("api/oneview/attention-required.js"),
    read("api/_lib/oneview-config.js"),
    read("api/_lib/oneview-db.js"),
    read("api/_lib/oneview-fallback.js"),
    read("src/lib/oneview-api.ts"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Index.tsx"),
    read("src/pages/Monitoring.tsx"),
  ]);
  assert.match(route, /createOneViewHandler\("attention-required"\)/);
  assert.match(config, /ONEVIEW_DISASTER_UNACK_MINUTES|attentionThresholds/);
  assert.match(database, /coalesce\(a\.acknowledged_source, false\) = false/);
  assert.match(database, /a\.first_seen_at < now\(\)/);
  assert.match(database, /severity in \('disaster', 'critical'\)/);
  assert.match(database, /severity in \('warning', 'information', 'not_classified'\)/);
  assert.match(database, /low_minutes: thresholds\.lowMinutes/);
  assert.doesNotMatch(database.match(/async function fetchAttentionRequiredPayload[\s\S]*?function alertId/)?.[0] ?? "", /payload_raw|payload_normalized|inventory|api_url|token_encrypted/);
  assert.match(fallback, /attentionRequiredPayload/);
  assert.match(api, /fetchAttentionRequired|AttentionRequiredResponse/);
  assert.doesNotMatch(index, /Atenção necessária|attentionMeta|attentionOpen|fetchAttentionRequired|attentionItems/);
  assert.doesNotMatch(index, /Esquecidos|forgotten/);
  assert.match(alerts, /id: "forgotten", label: "Esquecidos"/);
  assert.match(alerts, /Alertas ativos sem ACK acima do tempo esperado\./);
  assert.match(alerts, /alert_stale_minutes/);
  assert.match(alerts, /request\.firstSeenTo = dateBounds\.to|firstSeenTo: forgottenCutoff/);
  assert.match(alerts, /setSortOrder\("asc"\)/);
  assert.doesNotMatch(monitoring, /Esquecidos|forgotten|alert_stale_minutes/);
  assert.doesNotMatch(route, /method:\s*"POST"|addAlertNote|assignAlert|updateAlertStatus/);
});

test("desenvolvimento local reconhece rotas V1 sem expor banco ao Vite", async () => {
  const [packageJson, vite, localBff, localCheck, envExample] = await Promise.all([
    read("package.json"),
    read("vite.config.ts"),
    read("scripts/dev-oneview-bff.mjs"),
    read("scripts/check-oneview-local-live.mjs"),
    read(".env.local.example"),
  ]);
  const scripts = JSON.parse(packageJson).scripts;
  assert.equal(scripts["dev:bff"], "node scripts/dev-oneview-bff.mjs");
  assert.equal(scripts["test:local-live"], "node scripts/check-oneview-local-live.mjs");
  assert.match(vite, /"\/api\/oneview"/);
  assert.match(vite, /http:\/\/127\.0\.0\.1:8787/);
  assert.doesNotMatch(vite, /ONEVIEW_DB_HOST|POSTGRES_READONLY_PASSWORD/);
  assert.match(localBff, /"alert-detail"/);
  assert.match(localBff, /"alert-history"/);
  assert.match(localBff, /"operations-health"/);
  assert.match(localCheck, /method: "POST"/);
  assert.match(envExample, /ONEVIEW_ACK_ENABLED=false/);
  assert.match(envExample, /ONEVIEW_ACK_REQUEST_ENABLED=false/);
  assert.match(envExample, /ONEVIEW_ACK_EXECUTION_ENABLED=false/);
  assert.match(envExample, /ONEVIEW_DB_USER=oneview_vercel_readonly/);
  assert.doesNotMatch(envExample, /POSTGRES_APP_PASSWORD/);
});

test("contratos não expõem payloads nem habilitam ACK", async () => {
  const [api, database, fallback, envExample] = await Promise.all([
    read("src/lib/oneview-api.ts"),
    read("api/_lib/oneview-db.js"),
    read("api/_lib/oneview-fallback.js"),
    read("../.env.example"),
  ]);
  assert.doesNotMatch(api, /payload_normalized|payload_raw/);
  assert.doesNotMatch(database, /select[\s\S]{0,120}payload_(?:raw|normalized)/i);
  assert.doesNotMatch(fallback, /\.\.\.alert/);
  assert.match(envExample, /ONEVIEW_ACK_ENABLED=false/);
  assert.match(envExample, /ONEVIEW_ACK_REQUEST_ENABLED=false/);
  assert.match(envExample, /ONEVIEW_ACK_EXECUTION_ENABLED=false/);
  assert.match(database, /config\?\.ackEnabled/);
});

test("teste de carga local cobre cenários, autenticação, gates e pool sem escrita", async () => {
  const [packageJson, load, localBff, database, envExample, sql] = await Promise.all([
    read("package.json"),
    read("scripts/load-oneview-local.mjs"),
    read("scripts/dev-oneview-bff.mjs"),
    read("api/_lib/oneview-db.js"),
    read(".env.local.example"),
    read("docs/oneview-real-bff-queries.sql"),
  ]);
  const scripts = JSON.parse(packageJson).scripts;
  assert.equal(scripts["test:load-local"], "node scripts/load-oneview-local.mjs");
  assert.match(load, /\{ name: "10-users-run-1", users: 10, durationMs: 2 \* 60_000, run: 1 \}/);
  assert.match(load, /\{ name: "10-users-run-2", users: 10, durationMs: 2 \* 60_000, run: 2 \}/);
  assert.match(load, /\{ name: "25-users-run-1", users: 25, durationMs: 3 \* 60_000, run: 1 \}/);
  assert.match(load, /\{ name: "25-users-run-2", users: 25, durationMs: 3 \* 60_000, run: 2 \}/);
  assert.doesNotMatch(load, /50-users|users:\s*50/);
  assert.match(load, /const WARMUP_MS = 30_000/);
  for (const route of [
    "/api/oneview/dashboard-summary",
    "/api/oneview/alerts?page=1&page_size=50",
    "/api/oneview/alerts/${encodeURIComponent(alertId)}",
    "/api/oneview/alerts/${encodeURIComponent(alertId)}/history",
    "/api/oneview/operations/health",
    "/api/oneview/attention-required",
  ]) assert.match(load, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(load, /method: "GET"/);
  assert.doesNotMatch(load, /timedFetch[\s\S]{0,180}method:\s*"(?:POST|PUT|PATCH|DELETE)"/);
  assert.match(load, /controlled_session/);
  assert.match(load, /ONEVIEW_LOAD_TEST_BEARER_TOKEN/);
  assert.match(load, /ONEVIEW_LOAD_TEST_COOKIE/);
  assert.match(load, /p50_ms|p95_ms|p99_ms|throughput_rps|timeouts|sources/);
  assert.match(load, /p95_below_2s|p95_below_2_5s|no_pool_timeout|database_only/);
  assert.match(load, /\/__oneview\/load\/(?:state|reset|pool)/);
  assert.match(load, /code_hash|bff_pid|telemetry_generation|generation_mismatches/);
  assert.match(load, /LEAK_PATTERNS/);
  assert.match(localBff, /\/__oneview\/load\/(?:pool|state|reset)/);
  assert.match(localBff, /user\?\.id === "oneview-load-test"/);
  assert.match(database, /export function getOneViewDbPoolStats/);
  assert.match(envExample, /ONEVIEW_LOAD_BASE_URL=http:\/\/127\.0\.0\.1:8787/);
  for (const queryName of [
    "oneview_dashboard_total",
    "oneview_alerts_list_count",
    "oneview_alerts_list_page",
    "oneview_operations_health",
    "oneview_attention_items",
  ]) assert.match(sql, new RegExp(`PREPARE ${queryName}`));
  assert.doesNotMatch(sql, /password|senha|postgres(?:ql)?:\/\/|token|secret/i);
});

test("Home monta URL canônica de prioridade e V1 só exibe ACK nominal da origem", async () => {
  const [index, alerts, api, snapshot] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/lib/oneview-api.ts"),
    read("scripts/generate-safe-snapshot.mjs"),
  ]);

  assert.match(index, /severities: severity === "high"\s*\?\s*\["high", "critical"\]|\["high", "critical"\]/);
  assert.match(index, /severityAlertsHref|HOME_VISUAL_SEVERITY_STRIP/);
  assert.match(index, /hostAlertsHref|params\.set\("host"/);
  assert.match(api, /for \(const severity of canonicalizeSeveritiesForApi/);
  assert.match(api, /disaster: \{ label: "Disaster"/);
  assert.doesNotMatch(api, /high: \{ label: "Crítico"/);

  assert.match(snapshot, /if \(raw === "disaster"\) return "disaster"/);
  assert.match(snapshot, /if \(\["high", "alta", "alto"\]\.includes\(raw\)\) return "high"/);
  assert.match(snapshot, /if \(\["critical", "critico", "crítico"\]\.includes\(raw\)\) return "critical"/);

  assert.match(alerts, /function safeActorName\(value: unknown\)/);
  assert.match(alerts, /!\/\^\\d\+\$\/\.test\(candidate\)/);
  assert.match(alerts, /Reconhecido por \$\{ack\.actorLabel\}|Reconhecido por: \$\{ack\.actorLabel\}/);
  assert.match(alerts, /sourceAcknowledgementComment/);
  assert.match(alerts, /resolveOfficialAckComment/);
  assert.match(alerts, /sourceAckConfirmedWithoutHistory/);
  assert.match(alerts, /Processado pelo Worker OneView/);
  assert.match(alerts, /hasLoadedAlerts/);
  assert.match(alerts, /SelectItem value="unacknowledged">Sem ACK/);
  assert.doesNotMatch(alerts, /Reconhecer no OneView|Nunca tratado|Reconhecimentos OneView hoje/);
  assert.doesNotMatch(alerts, /event\.acknowledge|problem\.acknowledge|\/api\/zabbix/i);
  assert.doesNotMatch(api, /event\.acknowledge|problem\.acknowledge|\/api\/zabbix/i);
});

test("V1 fecha ACK, histórico formal, Home operacional e refresh suave", async () => {
  const [alerts, index, api] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/pages/Index.tsx"),
    read("src/lib/oneview-api.ts"),
  ]);

  assert.match(alerts, /ack\.actorLabel \? `Reconhecido por \$\{ack\.actorLabel\}` : "Reconhecido"/);
  assert.doesNotMatch(alerts, /Reconhecido por: \$\{ack\.actorLabel\}/);
  assert.match(alerts, /sourceAckConfirmedWithoutHistory/);
  assert.match(alerts, /ACK atual confirmado pela origem/);
  assert.match(alerts, /Detalhes históricos deste reconhecimento não estão disponíveis no registro legado\./);
  assert.doesNotMatch(alerts, /Os detalhes históricos deste reconhecimento não estão disponíveis no registro legado\./);
  assert.match(alerts, /SelectItem value="unacknowledged">Sem ACK/);
  assert.match(alerts, /!\/\^\\d\+\$\/\.test\(candidate\)/);
  assert.match(alerts, /Processado pelo Worker OneView/);
  assert.match(alerts, /allowWorkerLabel: false/);
  assert.match(alerts, /Alerta reconhecido na origem/);
  assert.match(alerts, /Severidade alterada/);
  assert.match(alerts, /Evento de manutenção/);
  assert.match(alerts, /Parte dos eventos possui dados estruturados\. Informações ausentes não foram inferidas\./);
  assert.match(alerts, /Este alerta possui registros anteriores ao modelo histórico atual\./);
  assert.match(alerts, /Não existem eventos históricos estruturados para este alerta\./);
  assert.match(alerts, /Os principais eventos possuem dados estruturados da origem\./);
  assert.match(alerts, /<details className="ov-panel p-4">/);
  assert.match(alerts, /Identificadores técnicos/);
  assert.match(alerts, /showAlertsSkeleton = isAlertsLoading && !hasLoadedAlerts && alerts\.length === 0/);
  assert.match(alerts, /isAlertsLoading && hasLoadedAlerts/);
  assert.doesNotMatch(alerts.match(/const loadAlerts[\s\S]*?const loadSummaryResources/)?.[0] ?? "", /setAlerts\(\[\]\)/);

  assert.doesNotMatch(index, /operations\?\.items \?\? \[\]/);
  assert.doesNotMatch(index, /SyncsStatusPanel/);
  assert.match(index, /HOME_EVENT_ALLOWLIST/);
  assert.match(index, /fetchRecentPriorityAlerts/);
  assert.match(index, /PRIORITY_SEVERITIES/);
  assert.match(index, /isBackgroundUpdating/);
  assert.match(index, /beginQuietUpdate/);
  assert.match(index, /priorityAlertsHref/);
  assert.match(index, /status: "active"/);
  assert.match(index, /severity=|severity",/);
  assert.doesNotMatch(index, /title: "Última sincronização"/);
  assert.doesNotMatch(index, /Atenção necessária/);
  assert.match(index, /Clientes mais impactados/);
  assert.doesNotMatch(index, /Hosts mais impactados|Resolvidos hoje|Fontes degradadas/);
  assert.doesNotMatch(index, /disponibilidade\s*100%|uptime\s*100%/i);

  assert.match(index, /const priorityAlertsHref = `\/alertas\?\$\{priorityAlertsQuery\.toString\(\)\}`;/);
  assert.match(index, /sourceAck: "unacknowledged"/);
  assert.match(index, /datePreset: homeWindow/);
  assert.match(index, /view: "priority"/);

  assert.match(api, /for \(const severity of canonicalizeSeveritiesForApi/);
});

test("drawer operacional ACK e comentário oficial Zabbix (OV-P0-09)", async () => {
  const alerts = await read("src/pages/Alerts.tsx");

  assert.match(alerts, /aria-label="Resumo"/);
  assert.match(alerts, /aria-label="Resumo operacional"/);
  assert.match(alerts, /aria-label="Origem"/);
  assert.match(alerts, /aria-label="Host, grupos e tags"/);
  assert.match(alerts, /aria-label="Reconhecimento"/);
  assert.match(alerts, /aria-label="ServiceNow"/);
  assert.match(alerts, /Identificadores técnicos/);
  assert.match(alerts, /Identificadores e metadados técnicos — seção secundária\./);

  assert.match(alerts, /source_ack é o reconhecimento selecionado pelo contrato atual/);
  assert.doesNotMatch(alerts, /ACK mais recente|reconhecimento mais recente/i);

  assert.match(alerts, /function resolveOfficialAckComment/);
  assert.match(alerts, /fedBy: "source_ack\.comment" \| "history\.comment" \| null/);
  assert.match(alerts, /fedBy: "source_ack\.comment"/);
  assert.match(alerts, /fedBy: "history\.comment"/);
  assert.match(alerts, /eventType !== "acknowledged" && eventType !== "ack_message"/);
  assert.match(alerts, /historyOrigin\(item\) !== "Zabbix"/);
  assert.match(alerts, /item\.origin === "oneview_internal"/);
  assert.match(alerts, /officialAckComment \? \(/);
  assert.doesNotMatch(alerts, /Sem comentário registrado/);
  assert.match(alerts, /function isValidZabbixAckComment/);
  assert.match(alerts, /backfill\|sincroniza\|sync\[_ \]\?log\|payload/);

  assert.match(alerts, /historyLoadError/);
  assert.match(alerts, /setHistoryLoadError/);
  assert.match(alerts, /Promise\.allSettled\(\[\s*fetchAlert\(id, controller\.signal\),\s*fetchAlertHistory\(id, controller\.signal\)/);
  assert.match(alerts, /Histórico indisponível\./);
  assert.match(alerts, /results\[0\]\.status === "fulfilled"/);
  assert.match(alerts, /results\[1\]\.status === "fulfilled"/);

  assert.match(alerts, /Integração ServiceNow em preparação\./);
  assert.doesNotMatch(alerts, /Frescor|aria-label="Frescor"/);
});

test("Histórico operacional NOC é rota independente com paginação e filtros (OV-P0-10 / OV-P0-21)", async () => {
  const [historico, app, sidebar, api, database] = await Promise.all([
    read("src/pages/Historico.tsx"),
    read("src/App.tsx"),
    read("src/components/layout/Sidebar.tsx"),
    read("src/lib/oneview-api.ts"),
    read("api/_lib/oneview-db.js"),
  ]);

  assert.match(app, /path="\/historico"/);
  assert.match(app, /HistoricoPage/);
  assert.match(sidebar, /href: "\/historico"/);
  assert.doesNotMatch(historico, /Navigate to=\{?["'`]\/alertas|redirect.*\/alertas|window\.location.*\/alertas/i);
  assert.match(historico, /useSearchParams/);
  assert.match(historico, /fetchGlobalHistory/);
  assert.match(historico, /pageSize: PAGE_SIZE/);
  assert.match(historico, /PAGE_SIZE = 50/);
  assert.match(api, /search\.set\("page"/);
  assert.match(api, /search\.set\("page_size"/);
  assert.match(database, /d\.name = \$1/);
  assert.match(database, /internal_acknowledged/);
  assert.match(database, /oneview_internal/);
  assert.match(database, /identified: \["problem_created", "created_from_zabbix"\]/);
  assert.match(database, /actions: \[/);

  assert.match(historico, /TabsTrigger value="alertas"/);
  assert.match(historico, /TabsTrigger value="eventos"/);
  assert.match(historico, /fetchAlerts/);
  assert.match(historico, /ACTION_EVENT_TYPES/);
  assert.match(historico, /isActionHistoryItem/);
  assert.match(historico, /formalOperationalTitle/);
  assert.match(historico, /Reconhecido por \$\{actor\}/);
  assert.match(historico, /Comentário registrado no Zabbix/);
  assert.match(historico, /Severidade alterada de \$\{from\} para \$\{to\}/);
  assert.match(historico, /Recuperação confirmada/);
  assert.match(historico, /Alerta colocado em manutenção/);
  assert.match(historico, /Supressão removida/);
  assert.match(historico, /dayGroupLabel|Hoje/);
  assert.match(historico, /value: "actions"/);
  assert.match(historico, /value: "1h"/);
  assert.match(historico, /value: "6h"/);
  assert.match(historico, /value: "custom"/);
  assert.match(historico, /canonicalClientName|UNCLASSIFIED_CLIENT_LABEL|Cliente não classificado/);
  assert.doesNotMatch(historico, /value: "update"/);
  assert.doesNotMatch(historico, /Filtrar por fonte|alert_history|dataSource|datasources:/);
  assert.doesNotMatch(historico, /Fonte: \$\{dataSource\}|via alert_history/);
  assert.doesNotMatch(historico, /Reconhecer no OneView|INC\d+|RITM\d+/);
  assert.doesNotMatch(historico, /Sem comentário registrado|Sem responsável/);

  assert.match(historico, /formatOneViewSeverityLabel/);
  assert.match(historico, /isValidOperationalComment/);
  assert.match(historico, /safeActorName/);
  assert.match(historico, /worker\|oneview\|sistema\|system\|reconcil/);
  assert.match(historico, /Skeleton/);
  assert.match(historico, /resetPage: true/);
  assert.match(historico, /patchParams/);
  assert.match(historico, /Tentar novamente/);
  assert.match(historico, /Nenhum evento encontrado para os filtros selecionados/);
  assert.match(historico, /Nenhum alerta encontrado para os filtros selecionados/);
  assert.match(historico, /Carregando histórico operacional/);
  assert.match(historico, /— eventos registrados|— alertas registrados/);
  assert.doesNotMatch(historico, /Atualizar histórico|aria-label="Atualizar histórico"/);
  assert.match(historico, /setEventsError|setAlertsError/);
  assert.match(historico, /\/alertas\?alert=\$\{encodeURIComponent\(detail\.id\)\}&from=historico|\/alertas\?alert=\$\{encodeURIComponent\(item\.alert_id\)\}&from=historico|\/alertas\?alert=\$\{encodeURIComponent\(alert\.id\)\}&from=historico/);
  assert.match(historico, /eventsLoaded|alertsLoaded/);
  assert.doesNotMatch(historico.match(/catch \(error\) \{[\s\S]*?\} finally/)?.[0] ?? "", /setEventItems\(\[\]\)|setAlertItems\(\[\]\)/);
});

test("OV-P0-34 Histórico consulta riscos e ACK com filtros server-side", async () => {
  const [historico, query, api, database, fallback] = await Promise.all([
    read("src/pages/Historico.tsx"),
    read("src/lib/historico-query.ts"),
    read("src/lib/oneview-api.ts"),
    read("api/_lib/oneview-db.js"),
    read("api/_lib/oneview-fallback.js"),
  ]);

  assert.match(query, /HISTORY_RISK_PRESETS/);
  assert.match(query, /value: "current"/);
  assert.match(query, /value: "current_ack"/);
  assert.match(query, /value: "closed_ack"/);
  assert.match(query, /value: "no_ack"/);
  assert.match(query, /status: "active"/);
  assert.match(query, /acknowledgedSource: true/);
  assert.match(query, /status: "resolved"/);
  assert.match(query, /acknowledgedSource: false/);
  assert.match(query, /sort: "severity"/);
  assert.match(query, /sortSecondary: "duration"/);
  assert.match(query, /sortSecondary: "resolved_at"/);
  assert.match(query, /RISK_SEVERITIES: OneViewSeverity\[] = \["disaster", "high"\]/);
  assert.match(query, /export function timeToAckSeconds/);
  assert.match(query, /acknowledged_source_at \|\| alert\.acknowledged_at/);
  assert.match(query, /Date\.parse\(firstRaw\)/);
  assert.match(query, /Date\.parse\(ackRaw\)/);
  assert.match(query, /return null/);

  assert.match(query, /label: "Riscos atuais"/);
  assert.match(query, /label: "Riscos atuais com ACK"/);
  assert.match(query, /label: "Riscos encerrados com ACK"/);
  assert.match(query, /label: "Sem ACK"/);
  assert.match(historico, /applyHistoryRiskPreset/);
  assert.match(historico, /HISTORY_RISK_PRESETS\.map/);
  assert.match(historico, /preset\.label/);
  assert.match(historico, /filtered_summary|filteredSummary/);
  assert.match(historico, /Resumo da consulta de riscos/);
  assert.match(historico, /by_severity\.disaster/);
  assert.match(historico, /by_severity\.high/);
  assert.match(historico, /acknowledged_source/);
  assert.match(historico, /unacknowledged_source/);
  assert.match(historico, /Tempo até ACK/);
  assert.match(historico, /timeToAckSeconds/);
  assert.match(historico, /formatDurationSeconds\(Number\(detail\.duration_seconds\)\)/);
  assert.match(historico, /safeActorName\(detail\.acknowledged_source_by \|\| detail\.acknowledged_by\)/);
  assert.match(historico, /\/\^\\d\+\$\//);
  assert.match(historico, /ClientIdentity/);
  assert.match(historico, /value: "acks"/);
  assert.match(historico, /ACK realizados/);
  assert.match(historico, /consolidateAckEvents/);
  assert.match(historico, /isValidOperationalComment/);
  assert.match(historico, /openAlertDetail|patchParams\(\{ alert:/);
  assert.match(historico, /Sheet/);
  assert.match(historico, /searchParams\.get\("risk"\)|get\("risk"\)/);
  assert.match(historico, /patchParams/);
  assert.doesNotMatch(historico, /avg_ack|média de ACK|SLA/);

  assert.match(api, /sort_secondary/);
  assert.match(api, /sortSecondary/);
  assert.match(database, /sort_secondary/);
  assert.match(database, /sortSecondary/);
  assert.match(database, /acks: \["acknowledged", "ack_message"\]/);
  assert.match(fallback, /acks: \["acknowledged", "ack_message"\]/);
  assert.match(fallback, /sortSecondary/);
});

test("nenhuma página expõe botão de reload manual no topo", async () => {
  const [layout, index, alerts, historico] = await Promise.all([
    read("src/components/layout/AppLayout.tsx"),
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
  ]);
  assert.doesNotMatch(layout, /Atualizar agora/);
  assert.doesNotMatch(index, /aria-label="Atualizar agora"|TooltipContent>Atualizar agora/);
  assert.doesNotMatch(alerts, /aria-label="Atualizar dados"/);
  assert.doesNotMatch(historico, /Atualizar histórico/);
  assert.match(layout, /Última atualização:/);
  assert.match(index, /Tela atualizada:/);
  assert.match(alerts, /Última atualização/);
  assert.doesNotMatch(historico, /Última atualização|Fonte:|alert_history/);
});

test("severidades OneView usam nomenclatura oficial Zabbix sem tradução (OV-P0-08)", async () => {
  const [api, index, alerts, historico] = await Promise.all([
    read("src/lib/oneview-api.ts"),
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
  ]);

  for (const [slug, label] of [
    ["not_classified", "Not classified"],
    ["information", "Information"],
    ["warning", "Warning"],
    ["average", "Average"],
    ["high", "High"],
    ["disaster", "Disaster"],
  ]) {
    assert.match(api, new RegExp(`${slug}: \\{ label: "${label}"`));
  }

  assert.match(api, /export function formatOneViewSeverityLabel/);
  assert.match(api, /"0": "Not classified"/);
  assert.match(api, /"5": "Disaster"/);
  assert.match(api, /reportUnknownSeverity/);
  assert.match(api, /return "—"/);
  assert.match(index, /formatOneViewSeverityLabel/);
  assert.match(alerts, /formatOneViewSeverityLabel/);
  assert.match(index, /HOME_VISUAL_SEVERITY_STRIP|"disaster"/);
  assert.match(index, /"high"/);
  assert.doesNotMatch(index, /Médio sem ACK|Average sem ACK/);
  assert.doesNotMatch(api, /label: "Desastre"|label: "Crítico"|label: "Alto"|label: "Médio"|label: "Aviso"|label: "Informação"|label: "Não classificado"/);
  assert.doesNotMatch(alerts, /disaster: "Desastre"|high: "Alto"|average: "Médio"|warning: "Aviso"|information: "Informação"|not_classified: "Não classificado"/);
  assert.doesNotMatch(alerts, /title: "Alto"|title: "Desastre"/);
  assert.match(alerts, /VISUAL_SEVERITY_STRIP/);
  assert.match(alerts, /severityCatalog\[severity\]\.label/);
  assert.match(alerts, /severities: selectedSeverities/);
  assert.match(alerts, /writeAlertsUrlParams|severity/);
  assert.match(index, /PRIORITY_SEVERITIES|view: "priority"|view=priority/);
  assert.doesNotMatch(index, /Disaster sem ACK ·|High sem ACK ·/);
  assert.match(api, /rank: 7/);
  assert.match(historico, /formatOneViewSeverityLabel/);
  assert.doesNotMatch(historico, /Desastre|Crítico|label: "Alto"|label: "Médio"|label: "Aviso"/);
});

test("OV-P0-27/38 saúde operacional global + Sidebar real no Monitoramento", async () => {
  const [
    healthLib,
    strip,
    appLayout,
    index,
    alerts,
    historico,
    monitoring,
    chamados,
    settings,
    sidebar,
  ] = await Promise.all([
    read("src/lib/platform-health.ts"),
    read("src/components/oneview/PlatformHealthStrip.tsx"),
    read("src/components/layout/AppLayout.tsx"),
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Chamados.tsx"),
    read("src/pages/Settings.tsx"),
    read("src/components/layout/Sidebar.tsx"),
  ]);

  assert.match(appLayout, /showHealthStrip \? <PlatformHealthStrip/);
  assert.match(appLayout, /rightSection=\{topbarRight\}/);
  assert.doesNotMatch(index, /PlatformHealthStrip|SyncsStatusPanel/);
  assert.doesNotMatch(alerts, /PlatformHealthStrip/);
  assert.doesNotMatch(historico, /showHealthStrip=\{false\}/);
  assert.match(chamados, /showHealthStrip=\{false\}/);
  assert.match(settings, /showHealthStrip=\{false\}/);
  assert.match(monitoring, /PlatformHealthStrip/);
  assert.match(monitoring, /ClientFilterCombobox/);
  assert.doesNotMatch(monitoring, /CustomerLogo|customerLogoCatalog/);
  assert.doesNotMatch(monitoring, /MonitoringControlsRail/);
  assert.match(monitoring, /components\/layout\/Sidebar/);
  assert.match(monitoring, /monitoringCollapse/);
  assert.match(alerts, /ClientFilterCombobox/);
  assert.match(alerts, /Mais filtros/);
  assert.match(sidebar, /fixed inset-y-0 left-0/);
  assert.doesNotMatch(sidebar, /relative fixed/);
  assert.match(appLayout, /h-dvh overflow-hidden/);
  assert.match(appLayout, /overflow-y-auto overflow-x-hidden/);
  assert.doesNotMatch(alerts, /Filtrar ACK da origem|Filtrar status/);
  assert.match(alerts, /setDatePreset\("24h"\)/);
  assert.match(alerts, /setDatePreset\("30d"\)/);

  assert.match(healthLib, /name: "Banco"/);
  assert.match(healthLib, /name: "Worker"/);
  assert.match(healthLib, /name: "Teletex"/);
  assert.match(healthLib, /TELETEX_DATASOURCE_NAME = "teletex-http"/);
  assert.match(healthLib, /findTeletexSource/);
  assert.doesNotMatch(healthLib, /items\[0\]|items\?\.\[0\]/);
  assert.doesNotMatch(`${healthLib}\n${strip}`, /castrolanda|fraport-for|zurich/i);
  assert.match(healthLib, /DEFAULT_SYNC_INTERVAL_SECONDS = 300/);
  assert.match(healthLib, /ratio >= 3/);
  assert.match(healthLib, /failures >= 3/);
  assert.match(healthLib, /ratio >= 1\.5 && ratio < 3/);
  assert.match(healthLib, /ratio < 1\.5/);
  assert.match(healthLib, /syncCadenceReason/);
  assert.match(healthLib, /Motivo:/);
  assert.match(healthLib, /Última verificação/);
  assert.match(healthLib, /Último sync/);
  assert.match(healthLib, /Fonte Teletex/);
  assert.match(healthLib, /Intervalo esperado/);
  assert.match(healthLib, /Ciclos estimados sem sucesso/);
  assert.match(healthLib, /sanitizeOperationalError/);

  assert.match(strip, /aria-describedby/);
  assert.match(strip, /TooltipTrigger/);
  assert.match(strip, /fetchDataSources/);
  assert.match(strip, /aria-label="Saúde operacional"/);

  assert.match(sidebar, /w-14/);
  assert.match(sidebar, /monitoringCollapse/);
  assert.match(sidebar, /oneview-monitor-sidebar-open/);
  assert.match(sidebar, /Recolher navegação do monitoramento/);
  assert.match(sidebar, /Abrir navegação do monitoramento/);
  assert.match(sidebar, /data-monitor-sidebar="collapsed"/);
  assert.match(sidebar, /top-1\/2/);
  assert.match(monitoring, /openBeforeFullscreen|wasFullscreen/);
  assert.match(monitoring, /Tela cheia|requestFullscreen/);
  assert.match(monitoring, /h-\[100dvh\].*w-\[100vw\]/);
  assert.doesNotMatch(monitoring, /overflow-auto|overflow-y-auto|overflow-x-auto/);
  assert.doesNotMatch([appLayout, index, alerts, historico, monitoring, strip, sidebar].join("\n"), /zoom\s*:|transform:\s*scale\(|scale\([0-9.]+\)/);

  assert.doesNotMatch(appLayout, /monitoringCollapse/);
  assert.doesNotMatch(index, /monitoringCollapse|MonitoringControlsRail/);
  assert.doesNotMatch(alerts, /monitoringCollapse|MonitoringControlsRail/);
  assert.doesNotMatch(historico, /monitoringCollapse|MonitoringControlsRail/);
});

test("OV-P0-30/38 Monitoramento usa Sidebar real + Disaster recentes server-side", async () => {
  const [monitoring, index, alerts, historico, sidebar, recent, api, pages] = await Promise.all([
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
    read("src/components/layout/Sidebar.tsx"),
    read("src/lib/oneview-recent.ts"),
    read("src/lib/oneview-api.ts"),
    list("src/pages"),
  ]);

  assert.equal(
    [index, alerts, historico].filter((source) => source.includes("MonitoringControlsRail")).length,
    0,
  );
  assert.doesNotMatch(monitoring, /MonitoringControlsRail/);
  assert.match(monitoring, /<Sidebar/);
  assert.match(monitoring, /monitoringCollapse/);
  assert.ok(pages.includes("Monitoring.tsx"));

  assert.match(sidebar, /w-14/);
  assert.match(sidebar, /hover:w-56/);
  assert.match(sidebar, /oneview-monitor-sidebar-open/);
  assert.doesNotMatch(index, /MonitoringControlsRail|w-\[200px\]|monitoringCollapse/);
  assert.doesNotMatch(alerts, /MonitoringControlsRail|monitoringCollapse/);
  assert.doesNotMatch(historico, /MonitoringControlsRail|monitoringCollapse/);

  assert.match(recent, /PRIORITY_SEVERITIES = \["disaster", "high"\]/);
  assert.match(recent, /severities: \[\.\.\.PRIORITY_SEVERITIES\]/);
  assert.match(recent, /acknowledgedSource: false/);
  assert.match(recent, /firstSeenFrom: isoAgo\((?:windowMs|priorityWindow|RECENT_PRIORITY_WINDOW_MS)/);
  assert.match(recent, /sort: "severity"/);
  assert.match(recent, /order: "desc"/);
  assert.match(recent, /compareRecentPriorityAlerts/);
  assert.match(recent, /severities: \["disaster"\]/);
  assert.match(recent, /severities: \["high"\]/);
  assert.doesNotMatch(recent, /severities: \["disaster", "critical"\]/);
  assert.doesNotMatch(recent, /\.filter\(\(alert\) => !alert\.acknowledged_source\)/);
  assert.doesNotMatch(recent, /severity === "high" \|\\|filter\(\(.*severity.*high/);

  assert.match(api, /canonicalizeSeveritiesForApi/);
  assert.match(api, /normalizeOneViewSeverity/);
  assert.doesNotMatch(api, /case "disaster":\s*return "high"/);
  assert.match(monitoring, /overflow-hidden/);
  assert.doesNotMatch(monitoring, /overflow-auto|overflow-y-auto/);
  assert.match(monitoring, /h-\[100dvh\].*w-\[100vw\]/);
});

test("OV-P0-31 Home drawer, Esquecidos e ClientIdentity compartilhado", async () => {
  const [index, alerts, historico, clientIdentity, monitoring, recent] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
    read("src/components/oneview/ClientIdentity.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/lib/oneview-recent.ts"),
  ]);

  assert.doesNotMatch(index, /Atenção necessária|fetchAttentionRequired|attentionItems/);
  assert.match(index, /PRIORITY_PAGE_SIZE = 6/);
  assert.match(index, /RECENT_EVENTS_LIMIT = 6/);
  assert.match(index, /Prioridade agora/);
  assert.match(index, /Clientes mais impactados/);
  assert.match(index, /xl:grid-cols-2/);
  assert.match(index, /useSearchParams/);
  assert.match(index, /searchParams\.get\("alert"\)/);
  assert.match(index, /next\.set\("alert", alert\.id\)/);
  assert.match(index, /setSearchParams\(next, \{ replace: false \}\)/);
  assert.match(index, /next\.delete\("alert"\)/);
  assert.match(index, /\/alertas\?alert=\$\{encodeURIComponent\(selectedAlert\.id\)\}&from=home/);
  assert.match(index, /\/historico\?alert=\$\{encodeURIComponent\(selectedAlert\.id\)\}&from=home/);
  assert.match(index, /Abrir em Alertas/);
  assert.match(index, /Ver histórico/);
  assert.match(index, /fetchAlert\(/);
  assert.match(index, /fetchAlertHistory\(/);
  assert.match(index, /onClick=\{\(\) => onOpen\(alert\)\}/);
  assert.doesNotMatch(index, /navigate\(|useNavigate\(/);
  assert.doesNotMatch(index, /MonitoringControlsRail/);
  assert.match(index, /Abrir resumo de \$\{/);

  assert.match(alerts, /\{ id: "forgotten", label: "Esquecidos" \}/);
  assert.match(alerts, /view === "forgotten"/);
  assert.match(alerts, /alert_stale_minutes/);
  assert.match(alerts, /request\.firstSeenTo = dateBounds\.to/);
  assert.match(alerts, /setSortField\("first_seen_at"\)/);
  assert.match(alerts, /setSortOrder\("asc"\)/);
  assert.match(alerts, /Alertas ativos sem ACK acima do tempo esperado\./);
  assert.doesNotMatch(alerts, /MonitoringControlsRail/);

  assert.doesNotMatch(monitoring, /Esquecidos|forgotten|alert_stale_minutes/);
  assert.doesNotMatch(historico, /MonitoringControlsRail/);

  assert.match(clientIdentity, /export function ClientIdentity/);
  assert.match(clientIdentity, /export function canonicalClientName/);
  assert.match(clientIdentity, /export function canonicalHostName/);
  assert.match(clientIdentity, /teletex-http/);
  assert.match(clientIdentity, /CUSTOMER_LOGO_CATALOG/);
  assert.match(clientIdentity, /sanepar/);
  assert.match(clientIdentity, /isAllCustomersSelection|TELETEX_LOGO_SRC/);
  assert.match(index, /from "@\/components\/oneview\/ClientIdentity"/);
  assert.match(alerts, /from "@\/components\/oneview\/ClientIdentity"/);
  assert.match(alerts, /ClientFilterCombobox/);
  assert.match(historico, /from "@\/components\/oneview\/ClientIdentity"/);
  assert.match(monitoring, /from "@\/components\/oneview\/ClientIdentity"/);
  assert.match(monitoring, /ClientFilterCombobox/);
  assert.doesNotMatch(monitoring, /CustomerLogo|customerLogoCatalog/);
  assert.doesNotMatch(index, /CUSTOMER_LOGO_CATALOG/);
  assert.doesNotMatch(alerts, /CUSTOMER_LOGO_CATALOG/);
  assert.doesNotMatch(historico, /CUSTOMER_LOGO_CATALOG/);

  assert.match(recent, /acknowledgedSource: false/);
  assert.match(recent, /firstSeenFrom: isoAgo\((?:windowMs|priorityWindow|RECENT_PRIORITY_WINDOW_MS)/);
  assert.match(recent, /PRIORITY_SEVERITIES = \["disaster", "high"\]/);
});

test("OV-P0-33 Home usa janela temporal explícita e server-side", async () => {
  const [index, recent] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/lib/oneview-recent.ts"),
  ]);

  assert.match(recent, /HOME_WINDOW_PRESETS/);
  assert.match(recent, /DEFAULT_HOME_WINDOW: HomeWindowPreset = "2h"/);
  assert.match(recent, /export function parseHomeWindow/);
  assert.match(recent, /"15m": 15 \* 60_000/);
  assert.match(recent, /"6h": 6 \* 60 \* 60_000/);
  assert.match(recent, /"24h": 24 \* 60 \* 60_000/);
  assert.match(recent, /windowMs\?: number/);
  assert.match(recent, /params\.windowMs \?\? RECENT_PRIORITY_WINDOW_MS|const windowMs = params\.windowMs/);
  assert.match(recent, /firstSeenFrom: isoAgo\(windowMs, now\)|firstSeenFrom: isoAgo\(priorityWindow/);

  assert.match(index, /parseHomeWindow\(searchParams\.get\("window"\)\)/);
  assert.match(index, /next\.set\("window",/);
  assert.match(index, /aria-label="Janela temporal"/);
  assert.match(index, /HOME_WINDOW_OPTIONS\.map/);
  assert.match(index, /fetchRecentOperationalMetrics\(\{ now, windowMs \}\)/);
  assert.match(index, /windowMs,/);
  assert.match(index, /homeWindowActiveLabel\(homeWindow\)/);
  assert.match(index, /HOME_VISUAL_SEVERITY_STRIP/);
  assert.doesNotMatch(index, /Novos nas últimas \$\{windowLabel\}/);
  assert.doesNotMatch(index, /Disaster sem ACK · \$\{windowLabel\}/);
  assert.doesNotMatch(index, /High sem ACK · \$\{windowLabel\}/);
  assert.doesNotMatch(index, /ACK realizados · \$\{windowLabel\}/);
  assert.doesNotMatch(index, /title: "Última sincronização"/);
  assert.doesNotMatch(index, /Novos na última hora|ACK 30 min|Últimos 30 minutos/);
  assert.match(index, /Sheet open=\{selectedAlertId !== null\}/);
  assert.match(index, /hasValidSummary \? recentMetrics\?\.by_severity/);
  assert.doesNotMatch(index, /recentMetrics\?\.not_classified/);
  assert.match(index, /loadSummary\(hasSummaryRef\.current \? "quiet" : "initial"\)/);
  assert.match(index, /loadLists\(hasListsRef\.current \? "quiet" : "initial"\)/);
});

test("OV-P0-42A Home: faixa de 5 severidades via filtered_summary (1 consulta)", async () => {
  const [index, recent, strip, api] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/lib/oneview-recent.ts"),
    read("src/components/oneview/CompactMetricStrip.tsx"),
    read("src/lib/oneview-api.ts"),
  ]);

  assert.match(index, /HOME_VISUAL_SEVERITY_STRIP/);
  assert.match(index, /"information",\s*"warning",\s*"average",\s*"high",\s*"disaster"/);
  assert.match(index, /CompactMetricStrip/);
  assert.match(index, /homeWindowActiveLabel/);
  assert.match(recent, /Ativos iniciados nas últimas \$\{preset\}/);
  assert.doesNotMatch(index, /formatOneViewSeverityLabel\("not_classified"\)/);
  assert.doesNotMatch(index, /severityAlertsHref\("not_classified"\)/);
  assert.doesNotMatch(index, /kpiCards/);
  assert.doesNotMatch(index, /Novos nas últimas \$\{windowLabel\}/);
  assert.doesNotMatch(index, /grid-cols-2 gap-1\.5 md:grid-cols-4/);

  assert.match(index, /\["high", "critical"\]/);
  assert.match(index, /dateField: "first_seen"/);
  assert.match(index, /datePreset: homeWindow/);
  assert.match(index, /status: "active"/);
  assert.doesNotMatch(index, /navigate\(|useNavigate\(/);

  assert.match(index, /Prioridade agora/);
  assert.match(index, /Eventos recentes/);
  assert.match(index, /xl:grid-cols-2/);
  assert.match(index, /Sheet open=\{selectedAlertId !== null\}/);
  assert.match(index, /PRIORITY_PAGE_SIZE = 6/);
  assert.match(index, /fetchClientsTopSummary/);
  assert.doesNotMatch(index, /pageSize:\s*100|while\s*\(.*page|fetchAlerts\(\{[\s\S]*pageSize:\s*total/i);
  assert.match(index, /fetchClientsTopSummary|clients-summary/);
  assert.doesNotMatch(index, /for \(const alert of priorityAlerts\)/);

  assert.match(recent, /params\?\.windowMs != null/);
  assert.match(recent, /pageSize: 1/);
  assert.match(recent, /status: "active"/);
  assert.match(recent, /firstSeenFrom: isoAgo\(params\.windowMs, now\)/);
  assert.match(recent, /filtered_summary/);
  assert.match(recent, /normalizeAlertSeveritySummary|severityCountsFromSummary|by_severity/);
  assert.match(recent, /not_classified/);
  assert.match(recent, /by_severity: null/);
  assert.match(api, /export function normalizeAlertSeveritySummary/);
  assert.match(api, /export function formatNullableCount/);
  assert.match(api, /export function readFiniteCount/);
  assert.doesNotMatch(api, /bag\.low|by_severity\.low|information: readFiniteCount\(bag\.low\)/);
  {
    const start = recent.indexOf("params?.windowMs != null");
    const end = recent.indexOf("const createdWindow", start);
    const homeBranch = recent.slice(start, end > start ? end : start + 1200);
    assert.equal((homeBranch.match(/fetchAlerts\(/g) || []).length, 1, "Home summary must use a single alerts call");
  }

  assert.match(strip, /href\?: string/);
  assert.match(strip, /item\.href/);
});

test("OV-P0-42A-REGRESSION: Home/Alertas normalizam filtered_summary sem NaN", async () => {
  const [api, index, alerts, recent] = await Promise.all([
    read("src/lib/oneview-api.ts"),
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/lib/oneview-recent.ts"),
  ]);

  assert.match(api, /normalizeAlertSeveritySummary/);
  assert.match(api, /formatNullableCount/);
  assert.match(api, /Number\.isFinite\(n\) \? n : null/);
  assert.match(api, /n == null \? "—" : n\.toLocaleString\("pt-BR"\)/);
  assert.doesNotMatch(api, /by_severity\.low|information:.*bag\.low/);

  assert.match(recent, /normalizeAlertSeveritySummary\(summary\)/);
  assert.match(index, /formatNullableCount/);
  assert.match(alerts, /normalizeAlertSeveritySummary\(filteredSummary\)/);
  assert.match(alerts, /formatNullableCount/);
  assert.match(alerts, /severitySummary\.not_classified/);
  assert.match(alerts, /severitySummary\.by_severity\?\.\[severity\] \?\? null/);
  assert.doesNotMatch(alerts, /filteredSummary\.not_classified;/);
  assert.doesNotMatch(alerts, /Number\(value\)\.toLocaleString\("pt-BR"\)/);
});

test("OV-P0-42B Home top clientes via clients-summary windowed", async () => {
  const [index, api, config, db, fallback] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/lib/oneview-api.ts"),
    read("api/_lib/oneview-config.js"),
    read("api/_lib/oneview-db.js"),
    read("api/_lib/oneview-fallback.js"),
  ]);

  assert.match(config, /"clients-summary"[\s\S]*first_seen_from/);
  assert.match(config, /"limit"/);
  assert.match(db, /first_seen_at >= \$2::timestamptz/);
  assert.match(db, /top_clients/);
  assert.match(db, /unclassified_count/);
  assert.match(db, /partial: identified\.length > limit/);
  assert.match(db, /fetchClientsSummaryPayload\(req,/);
  assert.match(db, /SAFE_CUSTOMER_KEY_SQL/);
  assert.doesNotMatch(db.match(/if \(firstSeenFrom\) \{[\s\S]*?return \{[\s\S]*?\n    \};/)?.[0] ?? "", /\blow\b/);

  assert.match(fallback, /OV-P0-42B: modo janela/);
  assert.match(fallback, /top_clients: identified\.slice\(0, limit\)/);
  assert.match(fallback, /unclassified_count/);
  assert.match(fallback, /clientsSummaryPayload\(snapshot, req\)/);

  assert.match(api, /export async function fetchClientsTopSummary/);
  assert.match(api, /first_seen_from/);
  assert.match(api, /top_clients\?:/);

  assert.match(index, /fetchClientsTopSummary/);
  assert.match(index, /limit: CLIENTS_LIMIT/);
  assert.match(index, /isoAgo\(windowMs, now\)/);
  assert.match(index, /Cliente não classificado/);
  assert.match(index, /unclassifiedClientCount/);
  assert.match(index, /Ativos · janela/);
  assert.doesNotMatch(index, /for \(const alert of priorityAlerts\)/);
  assert.doesNotMatch(index, /Prioridade · janela/);
  assert.doesNotMatch(index, /pageSize:\s*100|while\s*\(.*pagination/i);
});

test("OV-P0-42B-VALIDATION: contrato windowed inválido não vira lista vazia", async () => {
  const [index, api] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/lib/oneview-api.ts"),
  ]);

  assert.match(api, /export function isWindowedClientsSummary/);
  assert.match(api, /Array\.isArray\(raw\.top_clients\)/);
  assert.match(api, /typeof raw\.total_active !== "number"/);
  assert.match(api, /typeof raw\.unclassified_count !== "number"/);
  assert.match(api, /window\.field === "first_seen_at"/);

  assert.match(index, /isWindowedClientsSummary\(clientsResult\.value\)/);
  assert.match(index, /Dados indisponíveis/);
  assert.match(index, /emptyMessage="Nenhum cliente"/);
  assert.match(index, /unclassifiedClientCount === 0/);
  assert.doesNotMatch(index, /Não foi possível carregar os clientes impactados/);
  assert.doesNotMatch(index, /const rows = Array\.isArray\(payload\.top_clients\) \? payload\.top_clients : \[\]/);
});

test("OV-P0-41 Alertas: faixa de 5 severidades, Cliente na tabela, Chamado oculto", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /VISUAL_SEVERITY_STRIP/);
  assert.match(alerts, /"information",\s*"warning",\s*"average",\s*"high",\s*"disaster"/);
  assert.match(alerts, /Severidade fora da faixa visual/);
  assert.match(alerts, /notClassifiedCard/);
  assert.match(alerts, /setSelectedSeverities\(\(current\) => \(/);
  assert.match(alerts, /severities: selectedSeverities/);
  assert.match(alerts, />Cliente</);
  assert.match(alerts, /ClientIdentity/);
  assert.match(alerts, /TooltipContent/);
  assert.doesNotMatch(alerts, />Chamado</);
  assert.match(alerts, /title: "Em acompanhamento"/);
  assert.match(alerts, /title: "Reconhecidos"/);
  assert.match(alerts, /title: "Pendentes"/);
});

test("OV-P0-32 /alertas consolida filtros server-side, URL e indicadores", async () => {
  const [alerts, api, query, config, db] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/lib/oneview-api.ts"),
    read("src/lib/alerts-query.ts"),
    read("api/_lib/oneview-config.js"),
    read("api/_lib/oneview-db.js"),
  ]);

  assert.match(alerts, /writeAlertsUrlParams/);
  assert.match(alerts, /applyDateFieldToFetchParams/);
  assert.match(alerts, /applySearchToFetchParams/);
  assert.match(alerts, /setDebouncedSearch\(searchQuery\.trim\(\)\)/);
  assert.match(alerts, /, 300\)/);
  assert.match(alerts, /date_field|dateField/);
  assert.match(alerts, /search_field|searchField/);
  assert.match(alerts, /acknowledged_source/);
  assert.match(alerts, /ALERTS_SORT_OPTIONS/);
  assert.match(alerts, /SelectItem value="active">Ativos/);
  assert.match(alerts, /SelectItem value="acknowledged">Com ACK/);
  assert.match(alerts, /SelectItem value="unacknowledged">Sem ACK/);
  assert.match(alerts, /filteredSummary\s*\n\s*\? filteredSummary\.active/);
  assert.match(alerts, /formatNullableCount|value === null \? "—"/);
  assert.doesNotMatch(alerts.match(/const loadAlerts[\s\S]*?finally/)?.[0] ?? "", /\.filter\(/);
  assert.doesNotMatch(alerts, /setAlerts\(.*\.filter\(/);

  assert.match(query, /writeAlertsUrlParams/);
  assert.match(query, /date_field/);
  assert.match(query, /search_field/);
  assert.match(query, /acknowledged_source/);
  assert.match(query, /eventid/);
  assert.match(query, /acknowledged_at/);

  assert.match(api, /search\.set\("search_field"/);
  assert.match(api, /acknowledged_at/);
  assert.match(config, /"search_field"/);
  assert.match(db, /searchField === "eventid"/);
  assert.match(db, /searchField === "customer"/);
  assert.match(db, /acknowledged_at: "a\.acknowledged_at"/);
  assert.match(db, /canonicalizeSeveritiesForApi|ALERT_SEVERITIES/);
  assert.doesNotMatch(db, /when 'disaster' then 5.*high/);
});

test("OV-P0-43 Monitoramento alinha faixa de severidades, janela e recentes", async () => {
  const [monitoring, recent, strip] = await Promise.all([
    read("src/pages/Monitoring.tsx"),
    read("src/lib/oneview-recent.ts"),
    read("src/components/oneview/CompactMetricStrip.tsx"),
  ]);

  assert.match(monitoring, /MONITOR_VISUAL_SEVERITY_STRIP/);
  assert.match(monitoring, /"information",\s*"warning",\s*"average",\s*"high",\s*"disaster"/);
  assert.match(monitoring, /CompactMetricStrip/);
  assert.doesNotMatch(monitoring, /formatOneViewSeverityLabel\("not_classified"\)/);
  assert.match(monitoring, /formatNullableCount/);
  assert.match(monitoring, /parseHomeWindow\(searchParams\.get\("window"\)\)/);
  assert.match(monitoring, /aria-label="Janela temporal"/);
  assert.match(monitoring, /HOME_WINDOW_OPTIONS\.map/);
  assert.match(monitoring, /fetchRecentOperationalMetrics\(\{ customers, signal: controller\.signal, now, windowMs \}\)/);
  assert.match(monitoring, /fetchRecentPriorityAlerts/);
  assert.match(monitoring, /windowMs,/);
  assert.match(monitoring, /fetchRecentAlerts/);
  assert.match(monitoring, /title=\{`Recentes · \$\{windowLabel\}`\}/);
  assert.match(monitoring, /empty=\{priorityEmpty\}|empty=\{recentEmpty\}|empty=\{attentionEmpty\}/);
  assert.match(monitoring, /empty \? "shrink-0" : "min-h-0 flex-1"/);
  assert.match(monitoring, /ClientIdentity/);
  assert.match(monitoring, /canonicalHostName|canonicalClientName/);
  assert.doesNotMatch(monitoring, /Novos na última hora|ACK 30 min|metricDisplay/);
  assert.doesNotMatch(monitoring, /overflow-auto|overflow-y-auto/);
  assert.match(monitoring, /h-\[100dvh\].*w-\[100vw\]/);
  assert.match(monitoring, /html\.style\.overflow = "hidden"/);

  assert.match(recent, /export async function fetchRecentAlerts/);
  assert.match(recent, /sort: "first_seen_at"/);
  assert.match(recent, /order: "desc"/);
  assert.doesNotMatch(recent.match(/export async function fetchRecentAlerts[\s\S]*?^\}/m)?.[0] ?? "", /PRIORITY_SEVERITIES|acknowledgedSource/);
  assert.match(strip, /min-w-\[5\.5rem\]/);
});

test("OV-P0-44 Histórico enxuga colunas e abre drawer na linha", async () => {
  const historico = await read("src/pages/Historico.tsx");

  assert.match(historico, /<TableHead>Cliente<\/TableHead>/);
  assert.match(historico, /<TableHead>Severidade<\/TableHead>/);
  assert.match(historico, /<TableHead>Host<\/TableHead>/);
  assert.match(historico, /<TableHead>Problema<\/TableHead>/);
  assert.match(historico, /<TableHead>Início<\/TableHead>/);
  assert.match(historico, /<TableHead>Estado<\/TableHead>/);
  assert.match(historico, /<TableHead>ACK<\/TableHead>/);
  assert.match(historico, /<TableHead className="text-right">Ação<\/TableHead>/);
  assert.doesNotMatch(historico, /<TableHead>Responsável<\/TableHead>/);
  assert.doesNotMatch(historico, /<TableHead>Horário do ACK<\/TableHead>/);
  assert.doesNotMatch(historico, /<TableHead>Tempo até ACK<\/TableHead>/);
  assert.doesNotMatch(historico, /<TableHead>Recuperação<\/TableHead>/);
  assert.doesNotMatch(historico, /<TableHead>Duração total<\/TableHead>/);
  assert.match(historico, /onClick=\{\(\) => openAlertDetail\(alert\.id\)\}/);
  assert.match(historico, /role="button"/);
  assert.match(historico, /cursor-pointer/);
  assert.match(historico, /Tempo até ACK/);
  assert.match(historico, /Horário do ACK/);
  assert.match(historico, /Duração total/);
  assert.match(historico, /timeToAckSeconds\(detail\)/);
  assert.match(historico, /ClientIdentity/);
  assert.match(historico, /canonicalHostName/);
  assert.match(historico, /HISTORY_RISK_PRESETS|applyHistoryRiskPreset/);
  assert.match(historico, /pageSize: PAGE_SIZE/);
});

test("OV-P0-45 cabeçalhos padronizados na Topbar sem PageHeader duplicado", async () => {
  const [index, alerts, historico, monitoring, appLayout] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/components/layout/AppLayout.tsx"),
  ]);

  assert.match(index, /text-xl font-semibold tracking-tight text-foreground">Início</);
  assert.match(alerts, /text-xl font-semibold tracking-tight text-foreground">Alertas</);
  assert.match(historico, /text-xl font-semibold tracking-tight text-foreground">Histórico</);
  assert.match(monitoring, /text-xl font-semibold tracking-tight text-foreground">Monitoramento</);
  assert.doesNotMatch(index, /PageHeader|from "@\/components\/oneview\/PageHeader"/);
  assert.doesNotMatch(historico, /PageHeader|from "@\/components\/oneview\/PageHeader"/);
  assert.doesNotMatch(alerts, /PageHeader|from "@\/components\/oneview\/PageHeader"/);
  assert.match(appLayout, /showHealthStrip \? <PlatformHealthStrip/);
  assert.doesNotMatch(index, /PlatformHealthStrip/);
  assert.doesNotMatch(alerts, /PlatformHealthStrip/);
  assert.doesNotMatch(historico, /PlatformHealthStrip/);
  assert.match(monitoring, /PlatformHealthStrip/);
  assert.match(index, /clientSelect=\{/);
  assert.match(alerts, /clientSelect=\{/);
  assert.match(historico, /clientSelect=\{/);
});
