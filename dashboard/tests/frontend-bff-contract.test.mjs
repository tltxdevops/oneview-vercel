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
  assert.match(index, /HOME_ALERTS_PAGE_SIZE|fetchHomeAlerts/);
  assert.match(index, /fetchHomeAlerts|from "@\/lib\/oneview-home"/);
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
  const [alerts, summary, appLayout] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/components/oneview/AlertOperationalSummary.tsx"),
    read("src/components/layout/AppLayout.tsx"),
  ]);
  assert.match(alerts, /SUMMARY_REFRESH_MS = 10_000/);
  assert.match(alerts, /ALERTS_REFRESH_MS = 10_000/);
  assert.match(alerts, /if \(document\.hidden\) return/);
  assert.doesNotMatch(alerts, /topbarRightSection=\{<PlatformHealthStrip/);
  assert.doesNotMatch(alerts, /showHealthStrip=\{false\}/);
  assert.match(alerts, /<PageHeader title="Alertas" \/>/);
  assert.match(alerts, /<ClientFilterCombobox[\s\S]*triggerClassName="ov-control-official h-9 w-full"/);
  assert.match(alerts, /enableAutoRefresh=\{false\}/);
  assert.doesNotMatch(alerts, /aria-label="Atualizar dados"/);
  assert.doesNotMatch(alerts, /Atualizar dados em segundo plano|Atualizar agora/);
  assert.match(alerts, /AlertDetailDrawer/);
  assert.match(summary, /\["Última atualização",/);
  assert.doesNotMatch(alerts, /Pausar|Retomar|setIsPaused|isPaused|Resumo em|Alertas em \{/);
  assert.doesNotMatch(appLayout, /Pausar|Retomar|setIsPaused|isPaused|initiallyPaused/);
  assert.match(appLayout, /PlatformHealthStrip/);
  assert.doesNotMatch(alerts, /PlatformHealthStrip/);
  assert.match(alerts, /ALERTS_COLUMN_SORT_FIELD/);
  assert.match(alerts, /severity: "severity"/);
  assert.match(alerts, /host: "host"/);
  assert.match(alerts, /sortableHeader\(meta\.label, sortFieldForColumn\)/);
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
  assert.match(context, /await fetchServerAuthUser\(\)/);
  assert.doesNotMatch(serverAuth, /oneview_session_token|localStorage/);
  assert.match(serverAuth, /credentials: "include"/);
  assert.match(context, /logoutRedirect\(\{ postLogoutRedirectUri \}\)/);
  assert.doesNotMatch(`${context}\n${api}`, /getAllAccounts\(\)\[0\]/);
});

test("filtros ficam na barra e continuam server-side", async () => {
  const [alerts, query] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/lib/alerts-query.ts"),
  ]);
  assert.doesNotMatch(alerts, /Ocultar filtros|Mostrar filtros|FILTERS_STORAGE_KEY/);
  assert.match(alerts, /<FilterBar aria-label="Filtros de alertas"/);
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
  assert.match(alerts, /renderTableHeader/);
  assert.match(alerts, /ALERTS_COLUMN_SORT_FIELD/);
  assert.match(alerts, /problem: "problem"/);
  assert.match(alerts, /aria-label="Campo de busca"/);
  assert.match(alerts, /aria-label="Busca server-side"/);
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
  assert.match(alerts, /const requestTime = bucketOneViewReadNow\(\)/);
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
  assert.match(index, /buildHomeAlertsHref/);
  assert.match(await read("src/lib/oneview-home.ts"), /params\.set\("status", options\.status \?\? "active"\)/);
  assert.match(await read("src/lib/oneview-home.ts"), /params\.set\("date_field", "first_seen"\)/);
  assert.match(index, /AlertDetailDrawer/);
  assert.match(index, /onOpen=\{openAlert\}/);
  assert.match(await read("src/components/oneview/AlertDetailDrawer.tsx"), /defaultTab = "summary"|defaultValue=\{initialTab\}/);
  assert.match(index, /topbarRightSection=\{headerControls\}/);
  assert.match(alerts, /open=\{selectedAlertId !== null\}/);
  assert.match(alerts, /AlertDetailDrawer/);
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
  assert.match(strip, /fetchRuntimeHealth/);
  assert.doesNotMatch(strip, /fetchOneViewHealth|fetchOperationsHealth|fetchSyncLogs|fetchDataSources/);
  assert.match(index, /Tela atualizada:/);
  assert.match(index, /topbarRightSection=\{headerControls\}/);
  assert.doesNotMatch(index, /operations\?\.items \?\? \[\]/);
  assert.match(strip, /tooltipLines/);
  assert.match(strip, /operationalToneDotClass/);
  assert.doesNotMatch(index, /PgBouncer|PGBOUNCER|6432/);
  assert.doesNotMatch(`${healthLib}\n${strip}`, /PgBouncer|PGBOUNCER|6432|castrolanda|fraport|zurich/i);
  assert.doesNotMatch(index, /disponibilidade\s*100%|uptime\s*100%/i);
  assert.doesNotMatch(alerts, /Saúde operacional|Saúde da plataforma|SyncsStatusPanel|PlatformHealthStrip/);
});

test("OV-P0-26 saúde Teletex-only e shell denso sem zoom/scale", async () => {
  const [strip, healthLib, appLayout, sidebar, topbar, pageHeader, metricStrip, filterBar, monitoring, index, alerts, historico, indexCss] = await Promise.all([
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
    read("src/index.css"),
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
  assert.match(indexCss, /html\s*\{[\s\S]*font-size:\s*112\.5%/);
  assert.match(appLayout, /ml-14/);
  assert.doesNotMatch(appLayout, /ml-20/);
  assert.match(appLayout, /gap-3 p-3/);
  assert.match(sidebar, /w-14/);
  assert.doesNotMatch(sidebar, /w-20 hover:w-64/);
  assert.match(topbar, /min-h-10/);
  assert.match(pageHeader, /SectionAccentTitle level=\{1\}>\{title\}<\/SectionAccentTitle>/);
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
  assert.doesNotMatch(monitoring.replace(/<Sheet[\s\S]*?<\/Sheet>/g, ""), /overflow-x-auto|overflow-auto(?!-)/);
  assert.match(monitoring, /divide-y divide-border overflow-y-auto/);
  assert.match(monitoring, /MONITOR_QUEUE_LIMIT|PRIORITY_LIMIT/);
});

test("Home operacional NOC usa contratos OneView sem ranking de clientes", async () => {
  const [index, app, sidebar, historico] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/App.tsx"),
    read("src/components/layout/Sidebar.tsx"),
    read("src/pages/Historico.tsx"),
  ]);
  assert.match(index, /SectionAccentTitle level=\{1\}>Início/);
  assert.match(index, /Visão geral da operação Teletex/);
  assert.match(index, /HOME_VISUAL_SEVERITY_STRIP|CompactMetricStrip/);
  assert.match(index, /homeOperationalWindowActiveLabel/);
  assert.doesNotMatch(index, /Total persistido|Em acompanhamento no OneView|active_total/);
  assert.doesNotMatch(index, /title: "Alertas ativos"/);
  assert.doesNotMatch(index, /Novos nas últimas \$\{windowLabel\}/);
  assert.doesNotMatch(index, /Disaster sem ACK · \$\{windowLabel\}/);
  assert.doesNotMatch(index, /ACK realizados · \$\{windowLabel\}/);
  assert.doesNotMatch(index, /title: "Última sincronização"/);
  assert.match(index, /SectionAccentTitle>Alertas recentes|Prioritários/);
  assert.match(index, /Eventos recentes/);
  assert.doesNotMatch(index, /Atenção necessária/);
  assert.doesNotMatch(index, /Clientes mais impactados/);
  assert.doesNotMatch(index, /A integração com o ServiceNow está em preparação\.|Abrir área de chamados/);
  assert.match(index, /Atualizando\.\.\./);
  assert.match(index, /HOME_ALERTS_PAGE_SIZE|fetchHomeAlerts/);
  assert.match(index, /HOME_ALERT_MODE|HOME_PRIORITARY_SEVERITIES|oneview-home/);
  assert.match(index, /HOME_EVENT_ALLOWLIST/);
  assert.match(index, /fetchHomeAlerts/);
  assert.match(index, /fetchRecentOperationalEvents/);
  assert.doesNotMatch(index, /SyncsStatusPanel/);
  assert.match(index, /Promise\.allSettled/);
  assert.doesNotMatch(index, /attentionReason|fetchAttentionRequired|attentionItems/);
  assert.match(index, /Ver todos/);
  assert.match(index, /buildHomeAlertsHref|homeAlertsHref/);
  assert.match(index, /duration_seconds|first_seen_at/);
  assert.match(index, /fetchHomeAlerts/);
  assert.match(index, /isBackgroundUpdating/);
  assert.match(index, /beginQuietUpdate/);
  assert.match(index, /fetchAlertHistory/);
  assert.match(index, /AlertDetailDrawer/);
  assert.match(index, /open=\{selectedAlertId !== null\}/);
  assert.match(index, /Tentar novamente/);
  assert.match(index, /sectionErrors/);
  assert.doesNotMatch(index, /Hosts mais impactados|attentionOpen|Collapsible|RECENT_SEVERITY_GROUPS|ATTENTION_BUCKETS|todayOnly|Resolvidos hoje|Fontes degradadas|Carregar mais prioritários/);
  assert.doesNotMatch(index, /label: "Abertos"|label: "Críticos"|label: "SLA vencido"/);
  assert.doesNotMatch(index, /customerLogos|aliases: \["castrolanda"\]|aliases: \["fraport"\]|aliases: \["zurich"\]/);
  assert.doesNotMatch(index, /FRAPORT|Zurich|Castrolanda/);
  assert.doesNotMatch(index, /OneView:|Nunca tratado|Reconhecimentos OneView hoje|Críticos \/ Altos|Críticos sem ACK|>Esquecidos<|>Fora do radar<|>Desastres recentes</);
  assert.doesNotMatch(index, /disponibilidade\s*100%|disponibilidade 100|uptime\s*100%/i);
  assert.doesNotMatch(index, /PgBouncer|mock-data|demo-oneview-data|RITM\d+|INC\d+/i);
  assert.ok(index.indexOf("Alertas recentes") < index.indexOf("Eventos recentes"));
  assert.ok(index.indexOf("incidentsPanelTitle") < index.indexOf("Eventos recentes"));
  assert.doesNotMatch(index, /A integração com o ServiceNow está em preparação\.|Abrir área de chamados/);
  assert.doesNotMatch(index, /SyncsStatusPanel|PlatformHealthStrip/);
  assert.doesNotMatch(index, /Saúde da plataforma/);
  assert.match(index, /ConfigurableDashboardWidget id="recent-alerts"/);
  assert.match(index, /ConfigurableDashboardWidget id="incidents"/);
  assert.match(index, /showRefreshMeta=\{false\}/);
  assert.doesNotMatch(index, /dataSource=\{currentDataSource\}|checkedAt=\{lastCheckedAt\}/);
  assert.match(index, /Abrir resumo de \$\{/);
  assert.match(index, /fetchHomeAlerts|status: "active"/);
  assert.match(index, /description=\{incidentsPanelTitle\}/);
  assert.match(index, /Contexto operacional[\s\S]*Atualizado:/);
  assert.match(index, /CompactMetricStrip[\s\S]*surface=\{false\}/);
  assert.match(index, /title="Links de operadoras"/);
  assert.match(app, /path="\/historico"/);
  assert.match(app, /HistoricoPage/);
  assert.match(sidebar, /name: "Histórico"/);
  assert.match(sidebar, /href: "\/historico"/);
  assert.match(sidebar, /icon: "history"/);
  assert.ok(sidebar.indexOf('href: "/alertas"') < sidebar.indexOf('href: "/historico"'));
  assert.doesNotMatch(sidebar, /name: "Histórico", href: "\/alertas"/);
  assert.match(historico, /SectionAccentTitle level=\{1\}>Histórico<\/SectionAccentTitle>/);
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
  assert.doesNotMatch(index.match(/loadLists[\s\S]*?finally/)?.[0] ?? "", /setHomeAlerts\(\[\]\)|setPriorityAlerts\(\[\]\)/);
  assert.doesNotMatch(index.match(/loadSummary[\s\S]*?finally/)?.[0] ?? "", /setMetrics\(null\)/);
  assert.doesNotMatch(index.match(/loadSummary[\s\S]*?finally/)?.[0] ?? "", /closeAlert/);
  assert.match(index, /Os valores anteriores foram mantidos/);
  assert.match(index, /Tentar novamente/);
});

test("página de chamados lista incidents do BFF read-only", async () => {
  const [chamados, api, incidentsBff, app, index, sidebar] = await Promise.all([
    read("src/pages/Chamados.tsx"),
    read("src/lib/oneview-api.ts"),
    read("api/_lib/oneview-incidents.js"),
    read("src/App.tsx"),
    read("src/pages/Index.tsx"),
    read("src/components/layout/Sidebar.tsx"),
  ]);

  assert.doesNotMatch(chamados, /mock-data|mockChamados|mockClients/);
  assert.doesNotMatch(chamados, /FRAPORT|Castrolanda|Zurich|Havan|Osasco|BNB|NOC [A-E]\b/i);
  assert.doesNotMatch(chamados, /Exportar lista|Novo chamado|criar incidente|method:\s*["']POST["']/i);
  assert.match(chamados, /fetchIncidents/);
  assert.match(chamados, /Busca/);
  assert.match(chamados, /Cliente/);
  assert.match(chamados, /Estado/);
  assert.match(chamados, /Prioridade/);
  assert.match(chamados, /Caller/);
  assert.match(chamados, /Todo o período|Última atualização/);
  assert.match(chamados, /Número/);
  assert.match(chamados, /Descrição/);
  assert.match(chamados, /Grupo/);
  assert.match(chamados, /Responsável/);
  assert.match(chamados, /Atualização/);
  assert.match(chamados, /label:\s*"Total"/);
  assert.match(chamados, /Abertos/);
  assert.match(chamados, /Em andamento/);
  assert.match(chamados, /Resolvidos/);
  assert.match(chamados, /Encerrados/);
  assert.match(chamados, /Sem responsável|Não atribuídos/);
  assert.match(chamados, /ServiceNow/);
  assert.doesNotMatch(chamados, /ServiceNow DEV/);
  assert.match(chamados, /Nenhum chamado encontrado/);
  assert.match(chamados, /ServiceNow indisponível/);
  assert.match(chamados, /Não foi possível carregar os chamados/);
  assert.match(chamados, /safeCount/);
  assert.doesNotMatch(chamados, /showHealthStrip=\{false\}/);
  assert.match(chamados, /Sheet|drawer/i);
  assert.match(chamados, /ServiceNowDevLink/);
  assert.match(chamados, /cursor-pointer/);
  assert.match(chamados, /Alerta relacionado/);
  assert.match(chamados, /Nenhum alerta relacionado localizado/);
  assert.match(chamados, /Abrir alerta/);
  assert.match(chamados, /fetchIncidentRelatedAlert/);
  assert.doesNotMatch(chamados, /fallback.*host|host.*fallback/i);
  assert.doesNotMatch(
    chamados,
    /COLUMNS\s*=\s*\[[^\]]*"Abertura"[^\]]*\]/s,
  );
  assert.match(
    chamados,
    /COLUMNS\s*=\s*\[[^\]]*"Atualização"[^\]]*\]/s,
  );
  assert.doesNotMatch(chamados, /method:\s*["'](POST|PATCH|DELETE)["']/i);

  assert.match(api, /export async function fetchIncidents/);
  assert.match(api, /export async function fetchIncidentRelatedAlert/);
  assert.match(api, /\/oneview\/incidents/);
  assert.match(api, /\/oneview\/incidents\/related-alert/);
  assert.match(api, /servicenow/);
  assert.match(incidentsBff, /SERVICENOW_INCIDENTS_ENABLED/);
  assert.doesNotMatch(`${index}\n${sidebar}`, /isServiceNowIncidentsUiEnabled|VITE_SERVICENOW_INCIDENTS_ENABLED/);
  assert.match(sidebar, /href: "\/chamados"/);

  assert.match(app, /path="\/chamados"/);
  assert.match(app, /ChamadosPage/);
  // OV-P0-69: Home tem "Ver todos em Chamados" via href operacional (não o CTA estático antigo).
  assert.doesNotMatch(index, /Abrir área de chamados|A integração com o ServiceNow está em preparação/);
  assert.match(index, /buildOperationalChamadosHref/);
  assert.match(index, /Ver todos em Chamados/);
  assert.match(index, /to=\{chamadosHref\}/);
});

test("navegação lateral aponta somente para rotas registradas no App", async () => {
  const [sidebar, iconMap, app, index, pages] = await Promise.all([
    read("src/components/layout/Sidebar.tsx"),
    read("src/lib/oneview-icons.ts"),
    read("src/App.tsx"),
    read("src/pages/Index.tsx"),
    list("src/pages"),
  ]);

  const sidebarHrefs = [...sidebar.matchAll(/href: "([^"]+)"/g)].map((match) => match[1]);
  const appRoutes = new Set([...app.matchAll(/path="([^"]+)"/g)].map((match) => match[1]));

  assert.ok(!sidebar.includes("isServiceNowIncidentsUiEnabled"), "Sidebar não deve depender de feature flag build-time");
  assert.ok(sidebar.includes('href: "/chamados"'), "Sidebar deve declarar /chamados");
  assert.ok(sidebar.includes("baseNavigation"), "Sidebar deve montar navegação operacional estática");

  // Hrefs estáticos da navegação operacional.
  for (const preserved of ["/", "/monitoramento", "/alertas", "/historico", "/chamados", "/operadoras"]) {
    assert.ok(sidebar.includes(`href: "${preserved}"`), `Sidebar deve preservar ${preserved}`);
    assert.ok(appRoutes.has(preserved), `App deve preservar ${preserved}`);
  }

  assert.ok(appRoutes.has("/chamados"), "App deve manter a rota /chamados");
  assert.ok(!sidebarHrefs.filter((href) => href !== "/chamados").includes("/kpis"));

  // OV-P0-18: /config acessível; atalho no rodapé da Sidebar (acima do perfil), fora da lista principal.
  assert.ok(appRoutes.has("/config"), "App deve manter a rota /config");
  assert.ok(pages.includes("Settings.tsx"), "Settings.tsx não deve ser removido");
  assert.ok(!sidebarHrefs.includes("/config"), "Sidebar não deve listar /config em baseNavigation");
  assert.match(sidebar, /to="\/config"/);
  assert.match(sidebar, /Configurações/);
  assert.match(sidebar, /ONEVIEW_ICON_MAP/);
  assert.match(iconMap, /settings:\s*Settings/);
  assert.match(sidebar, /aspect-square.*rounded-full|rounded-full.*aspect-square/);
  assert.match(sidebar, /Ativar modo escuro/);
  assert.match(sidebar, /Ativar modo claro/);
  assert.match(sidebar, /setStoredTheme/);
  assert.match(iconMap, /themeDark:\s*Moon/);
  assert.match(iconMap, /themeLight:\s*Sun/);

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

  // ServiceNow/Chamados: rota e Sidebar sempre disponíveis; BFF controla runtime.
  assert.doesNotMatch(sidebar, /isServiceNowIncidentsUiEnabled|VITE_SERVICENOW_INCIDENTS_ENABLED/);
  assert.match(sidebar, /secondary:\s*"ServiceNow"|href: "\/chamados"/);
  assert.doesNotMatch(sidebar, /ServiceNow DEV/);
  assert.doesNotMatch(index, /A integração com o ServiceNow está em preparação\.|Abrir área de chamados/);
});

test("OV-P0-20 navegação operacional diferencia Monitoramento, Alertas e Histórico", async () => {
  const [sidebar, iconMap] = await Promise.all([
    read("src/components/layout/Sidebar.tsx"),
    read("src/lib/oneview-icons.ts"),
  ]);

  assert.match(sidebar, /icon: "monitoring"/);
  assert.match(sidebar, /icon: "alerts"/);
  assert.match(sidebar, /icon: "history"/);
  assert.match(iconMap, /monitoring:\s*Monitor/);
  assert.match(iconMap, /alerts:\s*Bell/);
  assert.match(iconMap, /history:\s*History/);
  assert.match(sidebar, /liveDot: true/);
  assert.match(sidebar, /secondary: "Fila operacional"/);
  assert.match(sidebar, /secondary: "Eventos e ações"/);
  assert.match(sidebar, /navToneClasses/);
  assert.match(sidebar, /bg-sidebar-accent/);
  assert.match(sidebar, /rounded-lg/);
  assert.doesNotMatch(sidebar, /accent: "monitor"|accent: "alerts"|accent: "history"/);
  assert.doesNotMatch(sidebar, /bg-emerald-500\/15|text-emerald-300|bg-emerald-400/);
  assert.doesNotMatch(sidebar, /bg-amber-500\/15|text-amber-200|bg-red-400/);
  assert.doesNotMatch(sidebar, /bg-sky-500\/15|text-sky-200|bg-sky-400/);
  assert.doesNotMatch(sidebar, /h-7 w-1/);
  assert.match(sidebar, /hover:bg-sidebar-accent/);
  assert.match(sidebar, /focus-visible:ring-1|focus-visible:ring-2/);
  assert.match(sidebar, /aria-label=\{secondary \? `\$\{name\}\. \$\{secondary\}` : name\}/);
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
  // Shell NOC sem scroll de página; overflow-y-auto só em listas internas da fila/chamados.
  assert.doesNotMatch(monitoring.replace(/<Sheet[\s\S]*?<\/Sheet>/g, ""), /overflow-x-auto|overflow-auto(?!-)/);
  assert.match(monitoring, /divide-y divide-border overflow-y-auto/);

  assert.match(monitoring, /searchParams\.get\("tv"\) === "1"/);
  assert.match(monitoring, /data-tv=\{tvMode \? "1" : "0"\}/);
  assert.match(monitoring, /REFRESH_MS = 10_000/);
  assert.match(monitoring, /hasDataRef/);
  assert.match(monitoring, /Valores anteriores mantidos/);
  assert.match(monitoring, /PlatformHealthStrip/);
  assert.match(monitoring, /bg-background/);
  assert.match(monitoring, /requestFullscreen/);
  assert.match(monitoring, /exitFullscreen/);
  assert.match(monitoring, /aria-pressed=\{isFullscreen\}/);
  assert.doesNotMatch(monitoring, /Pausar|Retomar|setIsPaused/);

  assert.match(monitoring, /MONITOR_QUEUE_LIMIT|PRIORITY_LIMIT/);
  assert.match(monitoring, /MONITOR_UNASSIGNED_LIMIT|MONITOR_HOSTS_LIMIT|HOSTS_LIMIT/);
  assert.match(monitoring, /queueOverflowLabel/);
  assert.match(monitoring, /MONITOR_VISUAL_SEVERITY_STRIP|CompactMetricStrip/);
  assert.match(monitoring, /monitorWindowActiveLabel|parseMonitorWindow/);
  assert.match(monitoring, /formatNullableCount/);
  assert.doesNotMatch(monitoring, /Novos na última hora|ACK 30 min/);
  assert.doesNotMatch(monitoring, /label: "Última sincronização"/);
  assert.match(monitoring, /ClientFilterCombobox/);
  assert.doesNotMatch(monitoring, /metricDisplay\(hasValidSummary/);
  assert.doesNotMatch(monitoring, /Total persistido|Em acompanhamento no OneView|active_total/);

  assert.doesNotMatch(monitoring, /Panel title="Saúde"/);
  assert.match(healthStrip, /aria-label="Saúde operacional"/);
  assert.match(healthLib, /teletex-http/);

  assert.match(monitoring, /fetchMonitoringAlerts|fetchRecentPriorityAlerts/);
  assert.match(monitoring, /fetchRecentOperationalMetrics/);
  assert.doesNotMatch(monitoring, /fetchAttentionRequired|Atenção necessária/);
  assert.match(monitoring, /windowMs|parseMonitorWindow|MONITOR_WINDOW_OPTIONS/);
  assert.match(monitoring, /MonitorAlertRow|severityTone|QUEUE_GRID/);
  assert.match(recent, /acknowledgedSource: false/);
  assert.match(recent, /firstSeenFrom: isoAgo\(windowMs|firstSeenFrom: isoAgo\(RECENT_PRIORITY_WINDOW_MS|firstSeenFrom: isoAgo\(priorityWindow/);
  assert.match(recent, /occurredFrom: isoAgo\(windowMs|occurredFrom: isoAgo\(RECENT_EVENTS_WINDOW_MS/);
  assert.match(healthStrip, /fetchRuntimeHealth/);
  assert.doesNotMatch(healthStrip, /fetchOperationsHealth|fetchOneViewHealth|fetchSyncLogs/);
  assert.doesNotMatch(monitoring, /mock|faker|hardcodedAlerts|DEMO_/i);

  assert.doesNotMatch(monitoring, /Fonte Teletex|Banco em tempo real|Contingência/);
  assert.match(monitoring, /selectedCustomerKeys/);
  assert.match(monitoring, /getOneViewFacets|fetchOneViewFacets/);
  assert.match(monitoring, /ClientIdentity|canonicalClientName|facetCustomerDisplayName|Cliente/);
  assert.match(monitoring, /formatOneViewSeverityLabel/);
  assert.match(monitoring, /buildMonitoringAlertHref|\/alertas\?alert=/);
  assert.match(monitoring, /fetchMonitoringUnassignedIncidents/);
  assert.doesNotMatch(monitoring, /isServiceNowIncidentsUiEnabled|VITE_SERVICENOW_INCIDENTS_ENABLED/);
  assert.doesNotMatch(monitoring, /Integração ServiceNow em preparação/);
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

  assert.match(index, /fetchHomeAlerts/);
  assert.match(index, /fetchRecentOperationalMetrics/);
  assert.match(index, /fetchRecentOperationalEvents/);
  assert.match(index, /HOME_ALERTS_PAGE_SIZE|fetchHomeAlerts/);
  assert.match(index, /HOME_VISUAL_SEVERITY_STRIP|CompactMetricStrip/);
  assert.match(index, /homeOperationalWindowActiveLabel/);
  assert.doesNotMatch(index, /Novos nas últimas \$\{windowLabel\}/);
  assert.doesNotMatch(index, /Disaster sem ACK · \$\{windowLabel\}/);
  assert.doesNotMatch(index, /ACK realizados · \$\{windowLabel\}/);
  assert.match(index, /queueOverflowLabel\(alertsTotal/);
  assert.doesNotMatch(index, /active_total|Total persistido|Em acompanhamento no OneView/);
  assert.doesNotMatch(index, /fetchAlertMetrics\(/);

  assert.match(monitoring, /MONITOR_QUEUE_LIMIT|PRIORITY_LIMIT/);
  assert.match(monitoring, /MONITOR_UNASSIGNED_LIMIT|MONITOR_HOSTS_LIMIT|HOSTS_LIMIT/);
  assert.match(monitoring, /Sidebar|monitoringCollapse/);
  assert.doesNotMatch(monitoring, /MonitoringControlsRail/);
  assert.doesNotMatch(monitoring, /MONITOR_ATTENTION_LIMIT|Atenção necessária/);

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
  const [alerts, summary, api, config] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/components/oneview/AlertOperationalSummary.tsx"),
    read("src/lib/oneview-api.ts"),
    read("api/_lib/oneview-config.js"),
  ]);
  assert.match(config, /ONEVIEW_ALERT_STALE_MINUTES/);
  assert.match(api, /alert_stale_minutes/);
  assert.doesNotMatch(alerts, /Frescor do dado|Tempo sem confirmação|Duração longa não indica falha de sincronização/);
  assert.doesNotMatch(alerts, /Ativo e confirmado recentemente|Ativo, mas sem confirmação recente|Dados possivelmente desatualizados/);
  assert.match(summary, /\["Duração",/);
  assert.match(summary, /\["Última atualização",/);
});

test("cliente não classificado é filtrável sem usar datasource como cliente", async () => {
  const [index, alerts, clientIdentity, summary] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/components/oneview/ClientIdentity.tsx"),
    read("src/components/oneview/AlertOperationalSummary.tsx"),
  ]);
  assert.match(clientIdentity, /Cliente não classificado/);
  assert.match(clientIdentity, /Cliente não identificado/);
  assert.match(clientIdentity, /facetCustomerDisplayName/);
  assert.match(clientIdentity, /Classificação ainda não determinada/);
  assert.match(clientIdentity, /teletex-http/);
  assert.match(clientIdentity, /canonicalHostName/);
  assert.match(index, /ClientIdentity|canonicalClientName|facetCustomerDisplayName/);
  assert.match(alerts, /facetCustomerDisplayName/);
  assert.match(alerts, /UNKNOWN_SCOPE_LABEL|Cliente não identificado/);
  assert.match(alerts, /CLASSIFICATION_PENDING_LABEL|Classificação ainda não determinada/);
  assert.match(summary, /CLASSIFICATION_PENDING_LABEL|Classificação ainda não determinada/);
  assert.doesNotMatch(index, /customer_name\s*\|\|\s*alert\.datasource_name/);
  assert.doesNotMatch(alerts, /name:\s*UNCLASSIFIED_CLIENT_LABEL/);
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
  assert.match(api, /export function highFamilySeverities/);
  assert.match(api, /if \(seen\.has\("high"\)\) seen\.add\("critical"\)/);
  assert.match(api, /return \["disaster"\]/);
  assert.doesNotMatch(api, /high: \{ label: "Crítico"/);
  assert.doesNotMatch(api, /label: "Desastre"|label: "Crítico"|label: "Alto"|label: "Médio"|label: "Aviso"|label: "Informação"|label: "Não classificado"/);
  assert.match(alerts, /formatOneViewSeverityLabel/);
  assert.match(alerts, /const severityOrder: OneViewSeverity\[\] = \[\.\.\.ONEVIEW_V1_FILTER_SEVERITIES\]/);
  assert.match(alerts, /writeAlertsUrlParams|selectedSeverities/);
  assert.doesNotMatch(alerts, /rawSeverities|next\.append\("priority"/);
  assert.match(alerts, /renderTableHeader/);
  assert.match(alerts, /ALERTS_TABLE_COLUMN_META/);
  assert.doesNotMatch(alerts, /<UserCheck className="h-3\.5 w-3\.5" \/> ACK<\/Button>/);
  assert.doesNotMatch(alerts, /Informativo \(baixa prioridade\)|>Severidade<\/TableHead>/);
  assert.doesNotMatch(alerts, /acknowledged_internal_comment \? <p className="mt-1 line-clamp-2/);
});

test("cards de indicadores aplicam filtros rápidos sem textos redundantes", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /type SummaryFilter =[\s\S]*"information"[\s\S]*"warning"[\s\S]*"average"[\s\S]*"high"[\s\S]*"disaster"[\s\S]*"not_classified"/);
  assert.match(alerts, /const applySummaryFilter = \(filter: SummaryFilter\)/);
  assert.match(alerts, /OneViewKpiCard/);
  assert.match(alerts, /aria-label="Indicadores de alertas"/);
  assert.match(alerts, /2xl:grid-cols-9/);
  assert.match(alerts, /onClick=\{\(\) => applySummaryFilter\(card\.filter\)\}/);
  assert.match(alerts, /VISUAL_SEVERITY_STRIP/);
  assert.doesNotMatch(alerts, /Severidade fora da faixa visual/);
  assert.match(alerts, /title: "Em acompanhamento"/);
  assert.match(alerts, /Ocorrências atualmente mantidas como ativas no OneView\./);
  assert.match(alerts, /formatNullableCount|value === null \? "—" : Number\(value\)\.toLocaleString\("pt-BR"\)/);
  assert.match(alerts, /filteredSummary/);
  assert.match(alerts, /Indicadores de alertas/);
  assert.doesNotMatch(alerts, /Total persistido/);
  assert.doesNotMatch(alerts, /title: "Alertas ativos"/);
  assert.doesNotMatch(alerts, /Resumo global do OneView/);
  assert.doesNotMatch(alerts, /Métricas de todo o ambiente\. Os controles da tabela afetam somente a listagem\./);
  assert.doesNotMatch(alerts, /Escopo desta tabela:/);
  assert.match(alerts, /xl:grid-cols-5[\s\S]*summaryCards\.map/);
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
  assert.match(alerts, /OneViewKpiCard/);
  assert.match(alerts, /2xl:grid-cols-9/);
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
  assert.match(index, /title="Alertas"|Prioritários/);
  assert.match(index, /Eventos recentes/);
  assert.doesNotMatch(index, /SyncsStatusPanel|PlatformHealthStrip/);
  assert.doesNotMatch(index, /Saúde da plataforma/);
  assert.match(index, /h-9 w-full|h-12 w-full/);
  assert.match(index, /CompactMetricStrip|font-semibold tabular-nums/);
  assert.doesNotMatch(index, /Skeleton key=\{index\} className="h-24 w-full"/);

  assert.match(historico, /eventos registrados/i);
  assert.doesNotMatch(historico, /summaryCards|Resumo operacional|title: "Em acompanhamento"|title: "Disaster"/);
  assert.doesNotMatch(historico, /Total persistido|Alertas ativos/);
});

test("coluna IP sanitizada permanece no drawer e fora da tabela operacional", async () => {
  const [alerts, summary] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/components/oneview/AlertOperationalSummary.tsx"),
  ]);
  assert.match(summary, /export function safeHostIp\(value: unknown\): string \| null/);
  assert.match(summary, /first === 10 \|\| first === 127/);
  assert.match(summary, /first === 192 && second === 168/);
  assert.match(await read("src/components/oneview/AlertDetailDrawer.tsx"), /safeHostIp\(alert\.host_ip\)/);
  assert.doesNotMatch(alerts, /showIpColumn/);
  assert.doesNotMatch(alerts, /<TableHead className="px-3 text-center">IP<\/TableHead>/);
});

test("tabela reserva espaço para ACK e ações; sidebar com toggle de tema", async () => {
  const [alerts, columns, sidebar] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/lib/alerts-table-columns.ts"),
    read("src/components/layout/Sidebar.tsx"),
  ]);
  assert.match(alerts, /renderTableHeader/);
  assert.match(alerts, /first_seen_at: "first_seen_at"/);
  assert.match(columns, /client: \{ label: "Cliente"/);
  assert.match(columns, /incident: \{ label: "Chamado"/);
  assert.match(alerts, /AlertServiceNowReferenceCell/);
  assert.match(alerts, /Reconhecido por \$\{ack\.actorLabel\}/);
  assert.doesNotMatch(alerts, /Integração ServiceNow em preparação/);
  assert.match(await read("src/components/oneview/AlertDetailDrawer.tsx"), /AlertRelatedIncidentsSection/);
  assert.doesNotMatch(alerts, /sortableHeader\("Cliente", "client"\)|sortableHeader\("Fonte", "datasource"\)/);
  assert.doesNotMatch(alerts, />OneView<\/span>|Não tratado/);
  assert.doesNotMatch(alerts, /CustomerLogo customer=\{\{ key: alert\.customer_key/);
  assert.match(alerts, /aria-label=\"Ver detalhes\"/);
  assert.match(alerts, /<Eye className=\"h-4 w-4\" \/>\s*<span className=\"sr-only\">Ver detalhes<\/span>/);
  assert.match(alerts, /<TooltipContent>Ver detalhes<\/TooltipContent>/);
  assert.doesNotMatch(alerts, /dataSource=\{currentDataSource\}/);
  assert.match(sidebar, /Ativar modo escuro/);
  assert.match(sidebar, /Ativar modo claro/);
  assert.match(sidebar, /setStoredTheme/);
  assert.match(sidebar, /toggleTheme/);
});

test("drawer carrega detalhe e histórico e exibe somente ACK real da origem", async () => {
  const [alerts, drawer] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/components/oneview/AlertDetailDrawer.tsx"),
  ]);
  assert.match(alerts, /Promise\.allSettled\(\[\s*fetchAlert\(id, controller\.signal\),\s*fetchAlertHistory\(id, controller\.signal\)/);
  assert.match(alerts, /fetchAlertMetrics\(\{ refresh: force \}\)/);
  assert.match(alerts, /loadSelectedAlert\(selectedAlert\.id\)/);
  assert.match(alerts, /acknowledged_internal_comment: ackComment\.trim\(\)/);
  assert.match(drawer, /TabsTrigger value="summary"/);
  assert.match(drawer, /TabsTrigger value="history"/);
  assert.match(drawer, /TabsTrigger value="technical"/);
  assert.doesNotMatch(drawer, /ID do datasource/);
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
  assert.match(alerts, /source_ack/);
  assert.match(alerts, /source_ack é o reconhecimento selecionado pelo contrato atual/);
  assert.match(alerts, /health\?\.capabilities\?\.acknowledgement === true/);
  assert.match(alerts, /if \(!ackRequestsEnabled \|\| !selectedAlert \|\| !ackRequestKey \|\| ackSubmitting\) return;/);
  assert.doesNotMatch(alerts, /disabled=\{ackSubmitting \|\| !selectedAlert \|\| !ackRequestsEnabled \|\| ackComment\.trim\(\)\.length === 0\}/);
  assert.match(alerts, /customerPresentation\(selectedAlert\)/);
  assert.match(drawer, /alert\.datasource_name/);
  assert.match(drawer, /alert\.host_groups/);
  assert.match(drawer, /event_tags|trigger_tags|host_tags/);
  assert.match(drawer, /item\.occurred_at/);
  assert.match(alerts, /Completo/);
  assert.match(alerts, /Enriquecimento parcial/);
  assert.match(alerts, /enrichmentExplanations/);
  assert.match(alerts, /Histórico legado/);
  assert.match(alerts, /UNKNOWN_SCOPE_LABEL|Cliente não identificado/);
  assert.match(alerts, /CLASSIFICATION_PENDING_LABEL|Classificação ainda não determinada/);
  assert.match(alerts, /AlertDetailDrawer/);
  assert.match(drawer, /Grupos e tags|host_groups/);
  assert.match(alerts, /isUnclassifiedClient|datasource_fallback/);
  assert.doesNotMatch(alerts, /Dados históricos aguardando classificação|Classificação histórica pendente/);
  assert.doesNotMatch(alerts, /Cliente pendente/);
  assert.doesNotMatch(alerts, /name:\s*UNCLASSIFIED_CLIENT_LABEL/);
  assert.match(drawer, /Recovery/);
  assert.match(alerts, /ACK atual confirmado pela origem/);
  assert.match(alerts, /Responsável não informado pela origem/);
  assert.match(alerts, /sourceAckConfirmedWithoutHistory/);
  assert.match(alerts, /Processado pelo Worker OneView/);
  assert.match(alerts, /formalHistoryTitle/);
  assert.match(alerts, /function sourceAckPresentation/);
  assert.match(alerts, /hasLoadedAlerts/);
  assert.match(alerts, /Atualizando\.\.\./);
  assert.match(alerts, /SelectItem value="unacknowledged">Sem ACK/);
  assert.doesNotMatch(alerts, /Evidência parcial/);
  assert.match(alerts, /item\.ack_actor_name/);
  assert.doesNotMatch(alerts, /actor_id/);
  assert.match(alerts, /historyOrigin\(group\.primary\) === "Zabbix"/);
  assert.match(drawer, /Fonte Zabbix/);
  assert.match(alerts, /Integridade do histórico/);
  assert.match(alerts, /historyQuality/);
  assert.match(alerts, /Histórico indisponível/);
  assert.match(alerts, /groupHistoryItems/);
  assert.match(drawer, /Classificação/);
  assert.match(drawer, /Nenhum evento de histórico disponível para este alerta\./);
  assert.doesNotMatch(drawer, /JSON\.stringify\(value\)/);
  assert.doesNotMatch(drawer, /disabled className="w-full"|Atribuir|Comentar/);
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
  assert.match(alerts, /open=\{selectedAlertId !== null\}/);
  assert.match(alerts, /AlertDetailDrawer/);
  assert.match(alerts, /nextSearchParams\.set\("alert", alert\.id\)/);
  assert.doesNotMatch(alerts.match(/const loadAlerts[\s\S]*?finally/)?.[0] ?? "", /setAlerts\(\[\]\)/);
  assert.doesNotMatch(alerts.match(/loadAlerts[\s\S]*?finally/)?.[0] ?? "", /closeAlert/);
  assert.doesNotMatch(alerts, /setAlertsView\([\s\S]{0,40}loadAlerts|closeAlert\(\).*loadAlerts/);

  assert.match(alerts, /sourceAckPresentation/);
  assert.match(alerts, /Reconhecido por \$\{ack\.actorLabel\}/);
  assert.match(alerts, /ack\.status !== "acknowledged"/);
  assert.match(alerts, /status="incident-waiting" label="Pendente"/);
  assert.match(alerts, /ack\.actorLabel \? `Reconhecido por \$\{ack\.actorLabel\}` : "Reconhecido"/);
  assert.match(alerts, /ack\.at \? ` · \$\{formatDateTime\(ack\.at\)\}`/);
  assert.doesNotMatch(alerts, /RITM\d+|SLA vencido|Sem chamado/);
  assert.doesNotMatch(alerts, /Integração ServiceNow em preparação/);
  assert.match(await read("src/components/oneview/AlertDetailDrawer.tsx"), /AlertRelatedIncidentsSection/);
  assert.match(await read("src/lib/alerts-table-columns.ts"), /incident: \{ label: "Chamado"/);
  assert.match(alerts, /AlertServiceNowReferenceCell/);
  assert.match(await read("src/components/oneview/AlertDetailDrawer.tsx"), /AlertRelatedIncidentsSection/);

  assert.match(alerts, /formatOneViewSeverityLabel/);
  assert.match(alerts, /severityKey === "not_classified"|not_classified/);
  assert.doesNotMatch(alerts, /FRAPORT|Zurich|Castrolanda/);

  assert.match(await read("src/components/oneview/AlertDetailDrawer.tsx"), /Fonte Zabbix/);
  assert.match(alerts, /Cliente interno|customerPresentation|selectedCustomer/);
  assert.match(await read("src/components/oneview/AlertDetailDrawer.tsx"), /host_groups/);
  assert.match(await read("src/components/oneview/AlertDetailDrawer.tsx"), /event_tags|trigger_tags|host_tags/);

  assert.match(index, /disasterAlertsHref|severity.*disaster|HOME_VISUAL_SEVERITY_STRIP/);
  assert.match(index, /homeAlertsHref|buildHomeAlertsHref|HOME_ALERT_MODE/);
  assert.match(index, /Prioritários|HOME_ALERT_MODE\.prioritary/);
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
  assert.doesNotMatch(database, /select\s+(?:a\.)?payload_(?:raw|normalized)\s*(?:,|from)/i);
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

  assert.match(index, /HOME_VISUAL_SEVERITY_STRIP/);
  assert.match(index, /toggleSeverityStrip|toggleHomeSeverityFilter/);
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
  assert.match(alerts, /AlertDetailDrawer/);
  assert.match(await read("src/components/oneview/AlertDetailDrawer.tsx"), /Fonte Zabbix|Event ID/);
  assert.match(alerts, /showAlertsSkeleton = isAlertsLoading && !hasLoadedAlerts && alerts\.length === 0/);
  assert.match(alerts, /isAlertsLoading && hasLoadedAlerts/);
  assert.doesNotMatch(alerts.match(/const loadAlerts[\s\S]*?const loadSummaryResources/)?.[0] ?? "", /setAlerts\(\[\]\)/);

  assert.doesNotMatch(index, /operations\?\.items \?\? \[\]/);
  assert.doesNotMatch(index, /SyncsStatusPanel/);
  assert.match(index, /HOME_EVENT_ALLOWLIST/);
  assert.match(index, /fetchHomeAlerts/);
  assert.match(index, /HOME_ALERT_MODE|oneview-home/);
  assert.match(index, /isBackgroundUpdating/);
  assert.match(index, /beginQuietUpdate/);
  assert.match(index, /homeAlertsHref|buildHomeAlertsHref/);
  assert.match(index, /fetchHomeAlerts/);
  assert.match(index, /severity=|severity",|HOME_SEVERITY_FILTER/);
  assert.doesNotMatch(index, /title: "Última sincronização"/);
  assert.doesNotMatch(index, /Atenção necessária/);
  assert.doesNotMatch(index, /Clientes mais impactados/);
  assert.doesNotMatch(index, /Hosts mais impactados|Resolvidos hoje|Fontes degradadas/);
  assert.doesNotMatch(index, /disponibilidade\s*100%|uptime\s*100%/i);

  assert.match(index, /buildHomeAlertsHref|homeAlertsHref/);
  assert.match(index, /date_preset|datePreset|homeWindow/);
  assert.match(index, /HOME_ALERT_MODE\.prioritary|Prioritários/);

  assert.match(api, /for \(const severity of canonicalizeSeveritiesForApi/);
});

test("drawer operacional ACK e comentário Zabbix (OV-P0-09)", async () => {
  const [alerts, summary] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/components/oneview/AlertOperationalSummary.tsx"),
  ]);

  assert.match(alerts, /AlertDetailDrawer/);
  assert.match(summary, /aria-label="Resumo operacional"/);
  assert.match(summary, /aria-label="Problema"/);
  assert.match(await read("src/components/oneview/AlertDetailDrawer.tsx"), /aria-label="Grupos e tags"|host_groups/);
  assert.match(await read("src/components/oneview/AlertDetailDrawer.tsx"), /AlertRelatedIncidentsSection/);
  assert.match(await read("src/components/oneview/AlertDetailDrawer.tsx"), /Fonte Zabbix/);
  assert.match(await read("src/components/oneview/AlertDetailDrawer.tsx"), /Event ID/);

  assert.match(alerts, /source_ack é o reconhecimento selecionado pelo contrato atual/);
  assert.doesNotMatch(alerts, /ACK mais recente|reconhecimento mais recente/i);

  assert.match(alerts, /function resolveOfficialAckComment/);
  assert.match(alerts, /fedBy: "source_ack\.comment" \| "history\.comment" \| null/);
  assert.match(alerts, /fedBy: "source_ack\.comment"/);
  assert.match(alerts, /fedBy: "history\.comment"/);
  assert.match(alerts, /eventType !== "acknowledged" && eventType !== "ack_message"/);
  assert.match(alerts, /historyOrigin\(item\) !== "Zabbix"/);
  assert.match(alerts, /item\.origin === "oneview_internal"/);
  assert.match(alerts, /officialAckComment/);
  assert.doesNotMatch(alerts, /Sem comentário registrado/);
  assert.match(alerts, /function isValidZabbixAckComment/);
  assert.match(alerts, /backfill\|sincroniza\|sync\[_ \]\?log\|payload/);

  assert.match(alerts, /historyLoadError/);
  assert.match(alerts, /setHistoryLoadError/);
  assert.match(alerts, /Promise\.allSettled\(\[\s*fetchAlert\(id, controller\.signal\),\s*fetchAlertHistory\(id, controller\.signal\)/);
  assert.match(alerts, /Histórico indisponível\./);
  assert.match(alerts, /results\[0\]\.status === "fulfilled"/);
  assert.match(alerts, /results\[1\]\.status === "fulfilled"/);

  assert.doesNotMatch(alerts, /Integração ServiceNow em preparação/);
  assert.match(await read("src/components/oneview/AlertDetailDrawer.tsx"), /AlertRelatedIncidentsSection/);
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
  assert.match(database, /d\.name = any\(\$1::text\[\]\)/);
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
  assert.match(historico, /canonicalClientName|facetCustomerDisplayName|historyEventClientLabel/);
  assert.doesNotMatch(historico, /value: "update"/);
  assert.match(historico, /datasources:/);
  assert.match(historico, /Fonte Zabbix|ZabbixSourceFilter/);
  assert.doesNotMatch(historico, /Filtrar por fonte|alert_history|dataSource=/);
  assert.doesNotMatch(historico, /Fonte: \$\{dataSource\}|via alert_history/);
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
  assert.match(historico, /AlertDetailDrawer/);
  assert.match(historico, /defaultTab="history"/);
  assert.match(historico, /auditEmphasis/);
  assert.doesNotMatch(historico, /Abrir em Alertas/);
  assert.match(historico, /Ver na fila de Alertas|alertsQueueHref/);
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
  assert.match(historico, /AlertDetailDrawer/);
  assert.match(historico, /fetchAlertHistory/);
  assert.match(await read("src/components/oneview/AlertDetailDrawer.tsx"), /Duração/);
  assert.match(await read("src/components/oneview/AlertDetailDrawer.tsx"), /Recovery/);
  assert.match(historico, /\/\^\\d\+\$\//);
  assert.match(historico, /ClientIdentity/);
  assert.match(historico, /value: "acks"/);
  assert.match(historico, /ACK realizados/);
  assert.match(historico, /consolidateAckEvents/);
  assert.match(historico, /isValidOperationalComment/);
  assert.match(historico, /openAlertDetail|patchParams\(\{ alert:/);
  assert.match(historico, /AlertDetailDrawer/);
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
  const [layout, index, alerts, historico, summary] = await Promise.all([
    read("src/components/layout/AppLayout.tsx"),
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
    read("src/components/oneview/AlertOperationalSummary.tsx"),
  ]);
  assert.doesNotMatch(layout, /Atualizar agora/);
  assert.doesNotMatch(index, /aria-label="Atualizar agora"|TooltipContent>Atualizar agora/);
  assert.doesNotMatch(alerts, /aria-label="Atualizar dados"/);
  assert.doesNotMatch(historico, /Atualizar histórico/);
  assert.match(layout, /Última atualização:/);
  assert.match(index, /Tela atualizada:/);
  assert.match(alerts, /AlertDetailDrawer/);
  assert.match(summary, /Última atualização/);
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
  assert.match(index, /PRIORITY_SEVERITIES|view: "priority"|view=priority|HOME_PRIORITARY|HOME_ALERT_MODE/);
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
  assert.doesNotMatch(chamados, /showHealthStrip=\{false\}/);
  assert.doesNotMatch(settings, /showHealthStrip=\{false\}/);
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
  assert.match(strip, /fetchRuntimeHealth/);
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
  assert.doesNotMatch(monitoring.replace(/<Sheet[\s\S]*?<\/Sheet>/g, ""), /overflow-x-auto|overflow-auto(?!-)/);
  assert.match(monitoring, /divide-y divide-border overflow-y-auto/);
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
  assert.match(sidebar, /hover:w-60/);
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
  assert.doesNotMatch(monitoring.replace(/<Sheet[\s\S]*?<\/Sheet>/g, ""), /overflow-x-auto|overflow-auto(?!-)/);
  assert.match(monitoring, /divide-y divide-border overflow-y-auto/);
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
  assert.match(index, /HOME_ALERTS_PAGE_SIZE|HOME_EVENTS_LIMIT/);
  assert.match(index, /HOME_EVENTS_LIMIT|fetchRecentOperationalEvents/);
  assert.match(index, /title="Alertas"|Prioritários/);
  assert.doesNotMatch(index, /Clientes mais impactados/);
  assert.match(index, /ConfigurableDashboardWidget id="recent-alerts"/);
  assert.match(index, /ConfigurableDashboardWidget id="incidents"/);
  assert.match(index, /useSearchParams/);
  assert.match(index, /searchParams\.get\("alert"\)/);
  assert.match(index, /next\.set\("alert", alert\.id\)/);
  assert.match(index, /setSearchParams\(next, \{ replace: false \}\)/);
  assert.match(index, /next\.delete\("alert"\)/);
  assert.match(index, /AlertDetailDrawer/);
  assert.doesNotMatch(index, /Abrir em Alertas/);
  assert.doesNotMatch(index, /Ver histórico/);
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

test("OV-P0-49 drawer operacional compartilha hierarquia ClientIdentity + host", async () => {
  const [index, alerts, monitoring, summary, clientIdentity] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/components/oneview/AlertOperationalSummary.tsx"),
    read("src/components/oneview/ClientIdentity.tsx"),
  ]);

  assert.match(summary, /export function AlertOperationalSummary/);
  assert.match(summary, /size="lg"/);
  assert.match(summary, /canonicalClientName|ClientIdentity/);
  assert.match(summary, /canonicalHostName/);
  assert.match(summary, /CLASSIFICATION_PENDING_LABEL/);
  assert.match(await read("src/components/oneview/AlertDetailDrawer.tsx"), /Fonte da identidade do cliente|Origem da classificação/);
  assert.match(await read("src/components/oneview/AlertDetailDrawer.tsx"), /label="Confiança"/);
  assert.match(summary, /ACK pendente|ACK/);
  assert.match(summary, /interfaceFromAlertTags|safeHostIp/);
  assert.doesNotMatch(summary, /customer_name\s*\|\|\s*.*datasource|host_groups\[0\]\.name/);

  assert.match(clientIdentity, /CLASSIFICATION_PENDING_LABEL = "Classificação ainda não determinada"/);
  assert.match(clientIdentity, /size\?: "xs" \| "sm" \| "md" \| "lg"/);

  assert.match(index, /AlertDetailDrawer/);
  assert.match(alerts, /AlertDetailDrawer/);
  assert.match(index, /CLASSIFICATION_PENDING_LABEL/);
  assert.match(monitoring, /CLASSIFICATION_PENDING_LABEL/);
  assert.match(index, /normalizeOperationalScope|operationalClientLabel/);
  assert.match(alerts, /isUnclassifiedClient/);
});

test("OV-P0-33 Home usa janela temporal explícita e server-side", async () => {
  const [index, recent, home] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/lib/oneview-recent.ts"),
    read("src/lib/oneview-home.ts"),
  ]);

  // Monitoramento / recent preservam presets legados.
  assert.match(recent, /HOME_WINDOW_PRESETS/);
  assert.match(recent, /DEFAULT_HOME_WINDOW: HomeWindowPreset = "2h"/);
  assert.match(recent, /export function parseHomeWindow/);
  assert.match(recent, /"15m": 15 \* 60_000/);
  assert.match(recent, /"6h": 6 \* 60 \* 60_000/);
  assert.match(recent, /"24h": 24 \* 60 \* 60_000/);
  assert.match(recent, /windowMs\?: number/);
  assert.match(recent, /params\.windowMs \?\? RECENT_PRIORITY_WINDOW_MS|const windowMs = params\.windowMs/);
  assert.match(recent, /firstSeenFrom: isoAgo\(windowMs, now\)|firstSeenFrom: isoAgo\(priorityWindow/);

  // OV-P0-103: Home usa janelas operacionais próprias.
  assert.match(home, /HOME_OPERATIONAL_WINDOW_PRESETS/);
  assert.match(home, /DEFAULT_HOME_OPERATIONAL_WINDOW: HomeOperationalWindowPreset = "2h"/);
  assert.match(index, /parseHomeOperationalWindow\(searchParams\.get\("window"\)\)/);
  assert.match(index, /next\.set\("window",/);
  assert.match(index, /label="Janela temporal"|Janela temporal/);
  assert.match(index, /HOME_OPERATIONAL_WINDOW_OPTIONS\.map/);
  assert.match(index, /fetchRecentOperationalMetrics\(\{ now, windowMs \}\)/);
  assert.match(index, /windowMs,/);
  assert.match(index, /homeOperationalWindowActiveLabel\(homeWindow\)/);
  assert.match(index, /HOME_VISUAL_SEVERITY_STRIP/);
  assert.doesNotMatch(index, /Novos nas últimas \$\{windowLabel\}/);
  assert.doesNotMatch(index, /Disaster sem ACK · \$\{windowLabel\}/);
  assert.doesNotMatch(index, /High sem ACK · \$\{windowLabel\}/);
  assert.doesNotMatch(index, /ACK realizados · \$\{windowLabel\}/);
  assert.doesNotMatch(index, /title: "Última sincronização"/);
  assert.doesNotMatch(index, /Novos na última hora|ACK 30 min|Últimos 30 minutos/);
  assert.match(index, /AlertDetailDrawer/);
  assert.match(index, /open=\{selectedAlertId !== null\}/);
  assert.match(index, /hasValidSummary \? recentMetrics\?\.by_severity/);
  assert.doesNotMatch(index, /recentMetrics\?\.not_classified/);
  assert.match(index, /loadSummary\(hasSummaryRef\.current \? "quiet" : "initial"\)/);
  assert.match(index, /loadLists\(hasListsRef\.current \? "quiet" : "initial"\)/);
});

test("OV-P0-42A Home: faixa de 5 severidades via filtered_summary (1 consulta)", async () => {
  const [index, recent, strip, api, home] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/lib/oneview-recent.ts"),
    read("src/components/oneview/CompactMetricStrip.tsx"),
    read("src/lib/oneview-api.ts"),
    read("src/lib/oneview-home.ts"),
  ]);

  assert.match(index, /HOME_VISUAL_SEVERITY_STRIP/);
  assert.match(index, /"information",\s*"warning",\s*"average",\s*"high",\s*"disaster"/);
  assert.match(index, /CompactMetricStrip/);
  assert.match(index, /homeOperationalWindowActiveLabel/);
  assert.match(home, /Ativos iniciados nas últimas \$\{preset\}/);
  assert.doesNotMatch(index, /formatOneViewSeverityLabel\("not_classified"\)/);
  assert.doesNotMatch(index, /severityAlertsHref/);
  assert.doesNotMatch(index, /kpiCards/);
  assert.doesNotMatch(index, /Novos nas últimas \$\{windowLabel\}/);
  assert.doesNotMatch(index, /grid-cols-2 gap-1\.5 md:grid-cols-4/);

  assert.match(home, /if \(severity === "high"\) params\.append\("severity", "critical"\)/);
  assert.match(home, /date_field.*first_seen|params\.set\("date_field", "first_seen"\)/);
  assert.match(home, /status: params\.status \?\? "active"/);
  assert.doesNotMatch(index, /navigate\(|useNavigate\(/);

  assert.match(index, /title="Alertas"|Prioritários/);
  assert.match(index, /Eventos recentes/);
  assert.match(index, /ConfigurableDashboardWidget id="recent-alerts"/);
  assert.match(index, /ConfigurableDashboardWidget id="incidents"/);
  assert.match(index, /AlertDetailDrawer/);
  assert.match(index, /open=\{selectedAlertId !== null\}/);
  assert.match(index, /HOME_ALERTS_PAGE_SIZE|fetchHomeAlerts/);
  assert.match(index, /getOneViewFacets|fetchOneViewFacets/);
  assert.doesNotMatch(index, /pageSize:\s*100|while\s*\(.*page|fetchAlerts\(\{[\s\S]*pageSize:\s*total/i);
  assert.match(index, /getOneViewFacets|fetchOneViewFacets|clients-summary/);
  assert.doesNotMatch(index, /for \(const alert of homeAlerts\)|for \(const alert of priorityAlerts\)/);

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

test("OV-P0-42B clients-summary windowed permanece no BFF/API (Home V2 remove ranking)", async () => {
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

  // OV-P0-69: Home não renderiza mais "Clientes mais impactados"; filtro usa facets.
  assert.doesNotMatch(index, /Clientes mais impactados/);
  assert.doesNotMatch(index, /fetchClientsTopSummary/);
  assert.match(index, /getOneViewFacets|fetchOneViewFacets/);
  assert.match(index, /ClientFilterCombobox/);
  assert.doesNotMatch(index, /for \(const alert of priorityAlerts\)/);
  assert.doesNotMatch(index, /Prioridade · janela/);
  assert.doesNotMatch(index, /pageSize:\s*100|while\s*\(.*pagination/i);
});

test("OV-P0-42B-VALIDATION: contrato windowed inválido permanece no client API", async () => {
  const [index, api] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/lib/oneview-api.ts"),
  ]);

  assert.match(api, /export function isWindowedClientsSummary/);
  assert.match(api, /Array\.isArray\(raw\.top_clients\)/);
  assert.match(api, /typeof raw\.total_active !== "number"/);
  assert.match(api, /typeof raw\.unclassified_count !== "number"/);
  assert.match(api, /window\.field === "first_seen_at"/);

  // OV-P0-69: Home não consome mais o ranking windowed.
  assert.doesNotMatch(index, /isWindowedClientsSummary/);
  assert.doesNotMatch(index, /Clientes mais impactados/);
  assert.doesNotMatch(index, /emptyMessage="Nenhum cliente"/);
});

test("OV-P0-41 Alertas: faixa de 5 severidades, Cliente na tabela, Chamado via referência SN", async () => {
  const [alerts, columns] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/lib/alerts-table-columns.ts"),
  ]);
  assert.match(alerts, /VISUAL_SEVERITY_STRIP/);
  assert.match(alerts, /"information",\s*"warning",\s*"average",\s*"high",\s*"disaster"/);
  assert.doesNotMatch(alerts, /Severidade fora da faixa visual/);
  assert.match(alerts, /notClassifiedCard/);
  assert.match(alerts, /setSelectedSeverities\(\(current\) => \(/);
  assert.match(alerts, /severities: selectedSeverities/);
  assert.match(columns, /client: \{ label: "Cliente"/);
  assert.match(alerts, /ClientIdentity/);
  assert.match(alerts, /TooltipContent/);
  assert.match(columns, /incident: \{ label: "Chamado"/);
  assert.match(alerts, /AlertServiceNowReferenceCell/);
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

test("OV-P0-43 Monitoramento alinha faixa de severidades, janela e fila única", async () => {
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
  assert.match(monitoring, /parseMonitorWindow\(searchParams\.get\("window"\)\)/);
  assert.match(monitoring, /label="Período"|Período/);
  assert.match(monitoring, /aria-label="Filtros operacionais"[\s\S]*Mais filtros[\s\S]*Filtro rápido da fila/);
  assert.match(monitoring, /SectionAccentTitle>Fila operacional<\/SectionAccentTitle>[\s\S]*description=\{queuePanelDescription\}/);
  assert.match(monitoring, /SectionAccentTitle>Chamados<\/SectionAccentTitle>[\s\S]*description=\{unassignedPanelTitle\}/);
  assert.match(monitoring, /MONITOR_WINDOW_OPTIONS\.map/);
  assert.match(monitoring, /fetchRecentOperationalMetrics\(\{ customers, datasources, signal: controller\.signal, now, windowMs \}\)/);
  assert.match(monitoring, /fetchMonitoringAlerts/);
  assert.match(monitoring, /windowMs,/);
  assert.doesNotMatch(monitoring, /title=\{`Recentes · \$\{windowLabel\}`\}/);
  assert.doesNotMatch(monitoring, /Alertas prioritários/);
  assert.match(monitoring, /empty=\{queueEmpty\}/);
  assert.match(monitoring, /empty \? "shrink-0" : "min-h-0 flex-1"/);
  assert.match(monitoring, /ClientIdentity/);
  assert.match(monitoring, /canonicalHostName|canonicalClientName|operationalClientLabel/);
  assert.doesNotMatch(monitoring, /Novos na última hora|ACK 30 min|metricDisplay/);
  assert.doesNotMatch(monitoring.replace(/<Sheet[\s\S]*?<\/Sheet>/g, ""), /overflow-x-auto|overflow-auto(?!-)/);
  assert.match(monitoring, /divide-y divide-border overflow-y-auto/);
  assert.doesNotMatch(monitoring, /Atenção necessária|xl:grid-cols-\[minmax\(0,1fr\)_16rem\]/);
  assert.match(monitoring, /MONITOR_SEVERITY_CHIP_OPTIONS|aria-label="Severidades"/);
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

  assert.match(historico, /<TableHead[^>]*>Cliente<\/TableHead>/);
  assert.match(historico, /<TableHead[^>]*>Severidade<\/TableHead>/);
  assert.match(historico, /<TableHead[^>]*>Host<\/TableHead>/);
  assert.match(historico, /<TableHead[^>]*>Problema<\/TableHead>/);
  assert.match(historico, /<TableHead[^>]*>Início<\/TableHead>/);
  assert.match(historico, /<TableHead[^>]*>ACK<\/TableHead>/);
  assert.match(historico, /<TableHead[^>]*>Chamado<\/TableHead>/);
  assert.match(historico, /<TableHead[^>]*>Estado<\/TableHead>/);
  assert.doesNotMatch(historico, /<TableHead className="text-right">Ação<\/TableHead>/);
  assert.doesNotMatch(historico, /<TableHead>Responsável<\/TableHead>/);
  assert.doesNotMatch(historico, /<TableHead>Horário do ACK<\/TableHead>/);
  assert.doesNotMatch(historico, /<TableHead>Tempo até ACK<\/TableHead>/);
  assert.doesNotMatch(historico, /<TableHead>Recuperação<\/TableHead>/);
  assert.doesNotMatch(historico, /<TableHead>Duração total<\/TableHead>/);
  assert.match(historico, /onClick=\{\(\) => openAlertDetail\(alert\.id\)\}/);
  assert.match(historico, /role="button"/);
  assert.match(historico, /cursor-pointer/);
  assert.match(historico, /AlertDetailDrawer/);
  assert.match(await read("src/components/oneview/AlertDetailDrawer.tsx"), /Duração|Recovery|Início|Auditoria temporal/);
  assert.match(historico, /defaultTab="history"/);
  assert.match(historico, /ClientIdentity/);
  assert.match(historico, /canonicalHostName/);
  assert.match(historico, /HISTORY_RISK_PRESETS|applyHistoryRiskPreset/);
  assert.match(historico, /pageSize: PAGE_SIZE/);
});

test("OV-P0-45 cabeçalhos padronizados na Topbar", async () => {
  const [index, alerts, historico, monitoring, chamados, appLayout, topbar] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Chamados.tsx"),
    read("src/components/layout/AppLayout.tsx"),
    read("src/components/layout/Topbar.tsx"),
  ]);

  assert.match(index, /SectionAccentTitle level=\{1\}>Início/);
  assert.match(alerts, /<PageHeader title="Alertas" \/>/);
  assert.match(alerts, /<ClientFilterCombobox[\s\S]*triggerClassName="ov-control-official h-9 w-full"/);
  assert.match(historico, /SectionAccentTitle level=\{1\}>Histórico<\/SectionAccentTitle>/);
  assert.match(monitoring, /SectionAccentTitle level=\{1\}>Monitoramento<\/SectionAccentTitle>/);
  assert.match(chamados, /SectionAccentTitle level=\{1\}>Chamados<\/SectionAccentTitle>/);
  assert.doesNotMatch(index, /PageHeader|from "@\/components\/oneview\/PageHeader"/);
  assert.doesNotMatch(historico, /PageHeader|from "@\/components\/oneview\/PageHeader"/);
  assert.match(alerts, /from "@\/components\/oneview\/PageHeader"/);
  assert.doesNotMatch(chamados, /PageHeader|from "@\/components\/oneview\/PageHeader"/);
  assert.match(appLayout, /showHealthStrip \? <PlatformHealthStrip/);
  assert.doesNotMatch(index, /PlatformHealthStrip/);
  assert.doesNotMatch(alerts, /PlatformHealthStrip/);
  assert.doesNotMatch(historico, /PlatformHealthStrip/);
  assert.doesNotMatch(chamados, /PlatformHealthStrip/);
  assert.match(monitoring, /PlatformHealthStrip/);
  assert.match(index, /clientSelect=\{/);
  assert.match(alerts, /clientSelect=\{/);
  assert.match(historico, /clientSelect=\{/);
  assert.match(chamados, /clientSelect=\{/);
  assert.match(topbar, /ml-auto flex min-w-0 flex-wrap items-center justify-end/);
});

test("faixa de saúde compacta à direita, hover e strip de métricas centrado", async () => {
  const [runtime, strip, appLayout, monitoring, compact, settings, chamados] = await Promise.all([
    read("src/lib/runtime-health.ts"),
    read("src/components/oneview/PlatformHealthStrip.tsx"),
    read("src/components/layout/AppLayout.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/components/oneview/CompactMetricStrip.tsx"),
    read("src/pages/Settings.tsx"),
    read("src/pages/Chamados.tsx"),
  ]);

  assert.match(runtime, /STALE_ATTENTION_MS = 14 \* 60 \* 1000/);
  assert.match(runtime, /bg-white ring-1 ring-foreground/);
  assert.match(runtime, /operationalToneFromGroup/);
  assert.match(runtime, /links saudáveis/);
  assert.match(strip, /operationalToneDotClass/);
  assert.match(strip, /tooltipLines/);
  assert.match(appLayout, /\{topbarRightSection\}[\s\S]*\{showHealthStrip \? <PlatformHealthStrip/);
  assert.match(monitoring, /ml-auto flex min-w-0 shrink-0 items-center gap-2/);
  assert.match(monitoring, /justify-self-center text-center/);
  assert.match(compact, /flex-col items-center justify-center/);
  assert.match(settings, /RUNTIME_CATEGORY_LABELS/);
  assert.doesNotMatch(chamados, /Sync ServiceNow:/);
});
