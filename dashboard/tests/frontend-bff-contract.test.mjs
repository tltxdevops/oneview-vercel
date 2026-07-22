import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

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
  assert.match(index, /pageSize: PRIORITY_PAGE_SIZE/);
  assert.match(index, /status: "active"/);
  assert.match(index, /severities: \[\.\.\.PRIORITY_SEVERITIES\]/);
  assert.match(index, /sort: "severity"/);
  assert.match(index, /sort: "first_seen_at"/);
  assert.match(index, /customers: selectedCustomerKeys/);
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
  assert.match(alerts, /setDebouncedHostSearch\(hostSearch\.trim\(\)\)/);
  assert.match(alerts, /setDebouncedProblemSearch\(problemSearch\.trim\(\)\)/);
  assert.match(alerts, /alertsRequestRef\.current\?\.abort\(\)/);
  assert.match(alerts, /requestId !== alertsRequestIdRef\.current/);
  assert.match(alerts, /if \(summaryRequestRef\.current\) return summaryRequestRef\.current/);
  assert.match(alerts, /<SelectItem value="25">25<\/SelectItem>/);
  assert.match(alerts, /<SelectItem value="50">50<\/SelectItem>/);
  assert.match(alerts, /<SelectItem value="100">100<\/SelectItem>/);
  assert.match(alerts, /Exibindo \$\{firstVisible\.toLocaleString\("pt-BR"\)\}–\$\{lastVisible\.toLocaleString\("pt-BR"\)\} de \$\{listTotal\.toLocaleString\("pt-BR"\)\}/);
  assert.match(alerts, /Aplicando filtro de período/);
  assert.match(api, /Math\.min\(params\?\.pageSize \?\? 100, 100\)/);
  assert.doesNotMatch(`${api}\n${alerts}`, /limit:\s*(?:250|500|5000)|offset:\s*0/);
});

test("um único controle coordena refresh, pausa e timers", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /SUMMARY_REFRESH_MS = 60_000/);
  assert.match(alerts, /ALERTS_REFRESH_MS = 120_000/);
  assert.match(alerts, /if \(isPaused \|\| document\.hidden\) return/);
  assert.match(alerts, /topbarRightSection=\{topbarControls\}/);
  assert.match(alerts, /clientSelect=\{clientSelector\}/);
  assert.match(alerts, /title="Alertas"/);
  assert.match(alerts, /enableAutoRefresh=\{false\}/);
  assert.match(alerts, /if \(isPaused\) \{[\s\S]*void refreshAll\(\)/);
  assert.match(alerts, /aria-label="Atualizar dados"/);
  assert.match(alerts, /Atualizar dados em segundo plano/);
  assert.match(alerts, /\{isPaused \? "Retomar" : "Pausar"\}/);
  assert.match(alerts, /Próxima tentativa/);
  assert.match(alerts, /sortableHeader\("Cliente", "client"\)/);
  assert.match(alerts, /sortableHeader\("Fonte", "datasource"\)/);
  assert.doesNotMatch(alerts, /Mais recentemente atualizados|Resolvidos mais recentemente|Mais novos|Mais antigos/);
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

test("filtros ficam nos cabeçalhos e continuam server-side", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.doesNotMatch(alerts, /Filtros de alertas|Ocultar filtros|Mostrar filtros|FILTERS_STORAGE_KEY/);
  assert.match(alerts, /selectedCustomerKeys/);
  assert.match(alerts, /selectedDatasources/);
  assert.doesNotMatch(alerts, /confidenceFilter|Baixa confiança/);
  assert.match(alerts, /<CommandInput placeholder="Buscar cliente\.\.\."/);
  assert.match(alerts, /<TabsTrigger value="created"[\s\S]*Criados/);
  assert.match(alerts, /<TabsTrigger value="updated"[\s\S]*Atualizados/);
  assert.match(alerts, /<TabsTrigger value="resolved"[\s\S]*Resolvidos/);
  assert.match(alerts, /<Select value=\{createdPreset\}/);
  assert.match(alerts, /<Select value=\{updatedPreset\}/);
  assert.match(alerts, /<Select value=\{resolvedPreset\}/);
  assert.match(alerts, /\["15m", "1h", "6h", "24h", "7d"\]/);
  assert.match(alerts, /\["15m", "1h", "6h", "24h", "7d", "30d"\]/);
  assert.match(alerts, /no período personalizado/);
  assert.match(alerts, /toggleColumnSort/);
  assert.match(alerts, /sortableHeader\("Host", "host"\)/);
  assert.match(alerts, /sortableHeader\("Prioridade", "severity"\)/);
  assert.match(alerts, /sortableHeader\("Problema", "problem"\)/);
  assert.match(alerts, /aria-label="Pesquisar host"/);
  assert.match(alerts, /aria-label="Pesquisar problema"/);
  assert.match(alerts, /aria-label="Filtrar ACK da origem"/);
  assert.doesNotMatch(alerts, />Ordenar</);
  assert.doesNotMatch(alerts, /Saúde operacional/);
  assert.doesNotMatch(alerts, /localStorage\.(?:setItem|getItem)/);
});

test("filtros temporais são independentes, persistem na URL e atualizam os cards", async () => {
  const [alerts, index, api] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/pages/Index.tsx"),
    read("src/lib/oneview-api.ts"),
  ]);

  assert.match(alerts, /firstSeenFrom: createdBounds\.from/);
  assert.match(alerts, /firstSeenTo: createdBounds\.to/);
  assert.match(alerts, /lastSeenFrom: updatedBounds\.from/);
  assert.match(alerts, /lastSeenTo: updatedBounds\.to/);
  assert.match(alerts, /resolvedFrom: resolvedBounds\.from/);
  assert.match(alerts, /resolvedTo: resolvedBounds\.to/);
  assert.match(alerts, /const requestTime = Date\.now\(\)/);
  assert.match(alerts, /temporalBounds\(createdPreset, createdRange, requestTime\)/);
  assert.match(alerts, /temporalBounds\(updatedPreset, updatedRange, requestTime\)/);
  assert.match(alerts, /temporalBounds\(resolvedPreset, resolvedRange, requestTime\)/);
  assert.doesNotMatch(alerts, /firstSeenFrom:\s*updatedBounds|lastSeenFrom:\s*createdBounds/);
  assert.match(alerts, /next\.set\(prefix, preset\)/);
  assert.match(alerts, /setSearchParams\(next, \{ replace: true \}\)/);
  assert.match(alerts, /setCreatedPreset\("all"\)/);
  assert.match(alerts, /setUpdatedPreset\("all"\)/);
  assert.match(alerts, /setResolvedPreset\("all"\)/);
  assert.match(alerts, /setFilteredSummary\(safeResponse\.filtered_summary\)/);
  assert.match(alerts, /setTemporalCounts\(safeResponse\.temporal_counts\)/);
  assert.match(alerts, /temporalFilterActive/);
  assert.match(alerts, /if \(preset === "custom"\) return Boolean\(range\?\.from \|\| range\?\.to\)/);
  assert.match(alerts, /hasTemporalFilter/);
  assert.doesNotMatch(alerts, /Sem ACK(?! no Zabbix)|Nunca tratado|Reconhecimentos OneView hoje/);
  assert.match(alerts, /setAlerts\(normalized\.items\)/);
  assert.match(alerts, /hasTemporalFilter[\s\S]*\? \(filteredSummary \? filteredSummary\.total/);
  assert.match(alerts, /listTotal\.toLocaleString\("pt-BR"\)/);
  assert.match(alerts, /Aplicando filtro de período/);
  assert.match(alerts, /Criados \$\{temporalLabels\[createdPreset\]\}/);
  assert.match(alerts, /setPage\(1\)/);
  assert.match(api, /filtered_summary\?:/);
  assert.match(api, /temporal_counts\?:/);

  const config = await read("api/_lib/oneview-config.js");
  assert.match(config, /"first_seen_to"/);
  assert.match(config, /"last_seen_to"/);
  assert.match(config, /"resolved_from"/);
  assert.match(config, /"resolved_to"/);
  assert.match(config, /"acknowledged_from"/);
  assert.match(config, /"acknowledged_to"/);

  assert.match(index, /params\.set\("status", options\.status\)/);
  assert.match(index, /params\.append\("severity", severity\)/);
  assert.match(index, /params\.set\("source_ack", options\.sourceAck\)/);
  assert.match(index, /params\.set\("sort", options\.sort\)/);
  assert.match(index, /selectedCustomerKeys\.forEach\(\(customer\) => params\.append\("customer", customer\)\)/);
  assert.match(index, /alertHref\(selectedAlert\.id, priorityAlertsQuery\)/);
  assert.match(index, /onOpen=\{openAlert\}/);
  assert.match(index, /defaultValue="history"/);
  assert.match(index, /topbarRightSection=\{topbarControls\}/);
});

test("V1 filtra somente ACK real da origem e mantém reconhecimento interno fora da interface", async () => {
  const [alerts, api] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/lib/oneview-api.ts"),
  ]);

  assert.match(alerts, /acknowledgedSource: sourceAckFilter === "all" \? undefined : sourceAckFilter === "acknowledged"/);
  assert.match(alerts, /Reconhecidos na origem/);
  assert.match(alerts, /Pendentes na origem/);
  assert.match(alerts, /Estado confirmado pelo Zabbix/);
  assert.doesNotMatch(alerts, /internalRecognitionFilter|Reconhecidos no OneView|Pendentes no OneView|Reconhecer no OneView/);
  assert.match(api, /search\.set\("acknowledged_source", String\(params\.acknowledgedSource\)\)/);
  // Contrato interno permanece disponível no cliente, mas não é usado pela V1.
  assert.match(api, /search\.set\("acknowledged_internal", String\(params\.acknowledgedInternal\)\)/);
});

test("início apresenta syncs e saúde das fontes no topbar sem mover o painel para alertas", async () => {
  const [index, alerts] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
  ]);
  assert.match(index, /fetchOperationsHealth\(\)/);
  assert.match(index, /buildSyncRows/);
  assert.match(index, /buildBancoSyncRow/);
  assert.match(index, /buildWorkerSyncRow/);
  assert.match(index, /name: "Banco"/);
  assert.match(index, /name: "Worker"/);
  assert.match(index, /operations\?\.items \?\? \[\]/);
  assert.match(index, /Última atualização:/);
  assert.match(index, /topbarRightSection=\{topbarControls\}/);
  assert.ok(index.indexOf('name: "Banco"') < index.indexOf('name: "Worker"'));
  assert.doesNotMatch(index, /Saúde operacional|Fontes operacionais|Fontes com erro/);
  assert.doesNotMatch(index, /disponibilidade\s*100%|uptime\s*100%/i);
  assert.doesNotMatch(alerts, /Saúde operacional/);
});

test("Home prioriza desastres e altos com ACK real e KPIs separados", async () => {
  const [index, app, sidebar, historico] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/App.tsx"),
    read("src/components/layout/Sidebar.tsx"),
    read("src/pages/Historico.tsx"),
  ]);
  assert.match(index, /Desastres ativos/);
  assert.match(index, /Altos ativos/);
  assert.match(index, /Não reconhecidos/);
  assert.match(index, /title: "Reconhecidos"/);
  assert.match(index, /source_acknowledgements_today/);
  assert.match(index, /acksTodayHref/);
  assert.match(index, /todayOnly/);
  assert.match(index, /setTodayOnly/);
  assert.match(index, /Alertas prioritários/);
  assert.match(index, /Alertas recentes/);
  assert.match(index, /Atenção operacional/);
  assert.match(index, /Integração ServiceNow em preparação\./);
  assert.match(index, /Atualizando\.\.\./);
  assert.match(index, /Clientes com mais alertas/);
  assert.match(index, /Collapsible/);
  assert.match(index, /clientsOpen/);
  assert.match(index, /PRIORITY_PAGE_SIZE = 15/);
  assert.match(index, /RECENT_PAGE_SIZE = 10/);
  assert.match(index, /PRIORITY_SEVERITIES = \["disaster", "high"\]/);
  assert.match(index, /severities: \[\.\.\.PRIORITY_SEVERITIES\]/);
  assert.match(index, /severities: recentSeverities/);
  assert.match(index, /RECENT_SEVERITY_GROUPS/);
  assert.match(index, /recentSeverityGroups/);
  assert.match(index, /Todas as severidades/);
  assert.match(index, /ATTENTION_BUCKETS/);
  assert.match(index, /attentionBucket/);
  assert.match(index, /SheetContent side="left"/);
  assert.match(index, /Abrir em Alertas/);
  assert.doesNotMatch(index, /Fontes em erro|Sem sincronização recente|sourcesInError|sourcesWithoutRecentSync/);
  assert.match(index, /sort: "severity"/);
  assert.match(index, /sort: "first_seen_at"/);
  assert.match(index, /order: "desc"/);
  assert.match(index, /customers: selectedCustomerKeys/);
  assert.match(index, /comparePriorityAlerts/);
  assert.match(index, /first_seen_at/);
  assert.match(index, /Ver todos/);
  assert.match(index, /priorityAlertsHref/);
  assert.match(index, /status: "active"/);
  assert.match(index, /disasterFamilySeverities/);
  assert.match(index, /buildSyncRows/);
  assert.match(index, /name: "Banco"/);
  assert.match(index, /name: "Worker"/);
  assert.match(index, /Saudável/);
  assert.match(index, /Degradado/);
  assert.match(index, /Erro/);
  assert.match(index, /Desabilitado/);
  assert.match(index, /Sem dados/);
  assert.match(index, /status === "disabled"/);
  assert.match(index, /status === "error"/);
  assert.match(index, /status === "warning" \|\| status === "stale"/);
  assert.match(index, /operations\?\.items \?\? \[\]/);
  assert.match(index, /isBackgroundUpdating/);
  assert.match(index, /beginQuietUpdate/);
  assert.match(index, /failureCount/);
  assert.match(index, /lastSuccessAt/);
  assert.match(index, /fetched/);
  assert.match(index, /upserted/);
  assert.match(index, /fetchAlertHistory/);
  assert.match(index, /Sheet open=\{selectedAlertId !== null\}/);
  assert.match(index, /Sheet open=\{attentionBucket !== null\}/);
  assert.doesNotMatch(index, /OneView:|Nunca tratado|Reconhecimentos OneView hoje|Críticos \/ Altos|Críticos sem ACK|Saúde operacional|Atenção necessária|>Esquecidos<|>Fora do radar<|>Desastres recentes</);
  assert.doesNotMatch(index, /disponibilidade\s*100%|disponibilidade 100|uptime\s*100%/i);
  assert.ok(index.indexOf("Alertas prioritários") < index.indexOf("Alertas recentes"));
  assert.ok(index.indexOf("Alertas recentes") < index.indexOf("Atenção operacional"));
  assert.ok(index.indexOf("Atenção operacional") < index.indexOf("Integração ServiceNow em preparação."));
  assert.ok(index.indexOf("Integração ServiceNow em preparação.") < index.indexOf("Clientes com mais alertas"));
  assert.ok(index.indexOf("Atenção operacional") < index.indexOf("Clientes com mais alertas"));
  assert.match(index, /xl:grid-cols-2/);
  assert.match(index, /lastSeenFrom: todayDayFrom/);
  assert.match(index, /lastSeenTo: todayDayTo/);
  assert.match(index, /todayUpdatedFilter/);
  assert.match(index, /updatedFrom: todayDayFrom/);
  assert.match(index, /ackFrom: ackTodayFrom/);
  assert.match(index, /ackTo: ackTodayTo/);
  assert.match(index, /sourceAck: "acknowledged"/);
  assert.match(index, /operational_day/);
  assert.match(index, /space-y-2/);
  assert.doesNotMatch(index, /acknowledgedSource: todayOnly \? true/);
  assert.doesNotMatch(index, /xl:grid-cols-\[minmax/);
  assert.match(index, /showRefreshMeta=\{false\}/);
  assert.doesNotMatch(index, /dataSource=\{currentDataSource\}|checkedAt=\{lastCheckedAt\}/);
  assert.match(index, /ariaLabel="Ver detalhes do alerta prioritário"/);
  assert.match(index, /ariaLabel="Ver detalhes do alerta recente"/);
  assert.match(index, /status: "active"/);
  assert.doesNotMatch(index, /<h2[^>]*>Chamados<\/h2>|Castrolanda/);
  assert.match(app, /path="\/historico"/);
  assert.match(app, /HistoricoPage/);
  assert.match(sidebar, /name: "Histórico"/);
  assert.match(sidebar, /href: "\/historico"/);
  assert.match(sidebar, /History/);
  assert.ok(sidebar.indexOf('href: "/alertas"') < sidebar.indexOf('href: "/historico"'));
  assert.doesNotMatch(sidebar, /name: "Histórico", href: "\/alertas"/);
  assert.match(historico, /Histórico operacional/);
  assert.match(historico, /alert_history/);
  assert.match(historico, /Filtrar por cliente/);
  assert.match(historico, /Filtrar por fonte/);
  assert.match(historico, /Filtrar por tipo de evento/);
  assert.match(historico, /Filtrar por período/);
  assert.match(historico, /Buscar no histórico/);
  assert.match(historico, /Lista global em preparação/);
  assert.doesNotMatch(historico, /fetchAlerts|fetchAlertHistory|navigate\("\/alertas"\)|Redirect/);
  assert.doesNotMatch(historico, /fake|mockRows|placeholderRows/i);
});

test("atalho da Home abre o drawer do alerta sem depender da página atual", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /useSearchParams\(\)/);
  assert.match(alerts, /const requestedAlertId = searchParams\.get\("alert"\)/);
  assert.match(alerts, /void loadSelectedAlert\(requestedAlertId\)/);
  assert.match(alerts, /nextSearchParams\.set\("alert", alert\.id\)/);
  assert.match(alerts, /nextSearchParams\.delete\("alert"\)/);
});

test("frescor separa duração, última atualização e confirmação com limite server-side", async () => {
  const [alerts, api, config] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/lib/oneview-api.ts"),
    read("api/_lib/oneview-config.js"),
  ]);
  assert.match(config, /ONEVIEW_ALERT_STALE_MINUTES/);
  assert.match(api, /alert_stale_minutes/);
  assert.match(alerts, /Ativo e confirmado recentemente/);
  assert.match(alerts, /Ativo, mas sem confirmação recente/);
  assert.match(alerts, /Dados possivelmente desatualizados/);
  assert.match(alerts, /Frescor do dado/);
  assert.match(alerts, /Tempo sem confirmação/);
  assert.match(alerts, /Duração longa não indica falha de sincronização/);
});

test("cliente não identificado é filtrável sem usar datasource como cliente", async () => {
  const [index, alerts] = await Promise.all([read("src/pages/Index.tsx"), read("src/pages/Alerts.tsx")]);
  assert.match(index, /customer\.key === "unclassified" \? "Não identificado"/);
  assert.match(alerts, /customer\.key === "unclassified"/);
  assert.match(alerts, /\{ \.\.\.customer, name: "Cliente não identificado" \}/);
  assert.match(alerts, /Cliente não identificado/);
  assert.match(alerts, /não forneceu evidências suficientes para associar este alerta automaticamente a um cliente/);
  assert.doesNotMatch(index, /customer_name\s*\|\|\s*alert\.datasource_name/);
});

test("alertas preserva a normalização canônica de severidade Zabbix", async () => {
  const [alerts, api] = await Promise.all([read("src/pages/Alerts.tsx"), read("src/lib/oneview-api.ts")]);
  for (const [severity, label] of [["disaster", "Desastre"], ["critical", "Crítico"], ["high", "Alto"], ["average", "Médio"], ["warning", "Aviso"], ["information", "Informação"], ["not_classified", "Não classificado"]]) {
    assert.match(api, new RegExp(`${severity}: \\{ label: "${label}"`));
  }
  assert.match(api, /export function canonicalizeSeveritiesForApi/);
  assert.match(api, /export function disasterFamilySeverities/);
  assert.match(api, /if \(Number\(counts\?\.critical \?\? 0\) > 0\) severities\.push\("critical"\)/);
  assert.doesNotMatch(api, /high: \{ label: "Crítico"/);
  assert.match(alerts, /const severityOrder: OneViewSeverity\[\] = \[\.\.\.ONEVIEW_V1_FILTER_SEVERITIES\]/);
  assert.match(alerts, /next\.append\("severity", value\)/);
  assert.doesNotMatch(alerts, /rawSeverities|next\.append\("priority"/);
  assert.match(alerts, /sortableHeader\("Prioridade", "severity"\)/);
  assert.match(alerts, />Ações<\/TableHead>/);
  assert.doesNotMatch(alerts, /<UserCheck className="h-3\.5 w-3\.5" \/> ACK<\/Button>/);
  assert.doesNotMatch(alerts, /Informativo \(baixa prioridade\)|>Severidade<\/TableHead>/);
  assert.doesNotMatch(alerts, /acknowledged_internal_comment \? <p className="mt-1 line-clamp-2/);
});

test("cards de indicadores aplicam filtros rápidos sem textos redundantes", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /type SummaryFilter = "total" \| "active" \| "acknowledged" \| "pending" \| "high" \| "disaster"/);
  assert.match(alerts, /const applySummaryFilter = \(filter: SummaryFilter\)/);
  assert.match(alerts, /aria-label=\{`Filtrar alertas: \$\{card\.title\}`\}/);
  assert.match(alerts, /onClick=\{\(\) => applySummaryFilter\(card\.filter\)\}/);
  assert.match(alerts, /setStatusFilter\(filter === "total" \? "all" : filter === "active" \? "active" : hasTemporalFilter \? statusFilter : "active"\)/);
  assert.match(alerts, /setSourceAckFilter\(filter === "acknowledged" \? "acknowledged" : filter === "pending" \? "unacknowledged" : "all"\)/);
  assert.doesNotMatch(alerts, /Resumo global do OneView/);
  assert.doesNotMatch(alerts, /Métricas de todo o ambiente\. Os controles da tabela afetam somente a listagem\./);
  assert.doesNotMatch(alerts, /Escopo desta tabela:/);
  assert.match(alerts, /filtrados por \{tableCustomerScope\}/);
});

test("coluna IP só aparece quando a página contém endereço público sanitizado", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /function safeHostIp\(value: unknown\): string \| null/);
  assert.match(alerts, /first === 10 \|\| first === 127/);
  assert.match(alerts, /first === 192 && second === 168/);
  assert.match(alerts, /const showIpColumn = useMemo\(\(\) => alerts\.some\(\(alert\) => safeHostIp\(alert\.host_ip\) !== null\)/);
  assert.match(alerts, /\{showIpColumn \? <TableHead className="px-3 text-center">IP<\/TableHead> : null\}/);
  assert.match(alerts, /\{showIpColumn \? <TableCell[^\n]+safeHostIp\(alert\.host_ip\) \?\? "-"/);
});

test("tabela reserva espaço para ACK e ações; tema lateral é persistente", async () => {
  const [alerts, sidebar] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/components/layout/Sidebar.tsx"),
  ]);
  assert.match(alerts, /<col className=\"w-\[10%\]\" \/>[\s\S]+<col className=\"w-\[12%\]\" \/>/);
  assert.match(alerts, /showIpColumn \? \"w-\[20%\]\" : \"w-\[25%\]\"/);
  assert.doesNotMatch(alerts, />OneView<\/span>|Não tratado/);
  assert.match(alerts, /max-w-full whitespace-nowrap border text-\[10px\]/);
  assert.match(alerts, /<div className=\"flex items-center justify-center gap-2 text-left\">/);
  assert.match(alerts, /py-5 pl-6 pr-14 text-left/);
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
  assert.match(alerts, /Reconhecido por: \$\{ack\.actorLabel\}/);
  assert.match(alerts, /Sem comentário registrado na origem\./);
  assert.doesNotMatch(alerts, /Para reconhecer na origem, use o Zabbix/);
  assert.match(alerts, /Detalhes históricos deste reconhecimento não estão disponíveis no registro legado\./);
  assert.match(alerts, /source_ack/);
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
  assert.match(alerts, /Cliente não identificado/);
  assert.match(alerts, /A fonte \$\{datasource\} não forneceu evidências suficientes para associar este alerta automaticamente a um cliente\./);
  assert.match(alerts, /Grupos disponíveis/);
  assert.match(alerts, /Tags disponíveis/);
  assert.match(alerts, /revise as tags e os grupos na origem/);
  assert.match(alerts, /alert\.customer_source\?\.trim\(\)\.toLowerCase\(\) === "datasource_fallback"/);
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
  assert.match(alerts, /details open className="rounded-\[10px\] border border-border\/70 bg-white p-4 shadow-sm"/);
  assert.doesNotMatch(alerts, /Sem ACK(?! no Zabbix)/);
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
  assert.match(alerts, /<summary className="cursor-pointer text-sm font-semibold">Origem<\/summary>/);
  assert.match(alerts, /<summary className="cursor-pointer text-sm font-semibold">Host<\/summary>/);
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
  const [detail, history, operations, vercel] = await Promise.all([
    read("api/oneview/alerts/[id].js"),
    read("api/oneview/alerts/[id]/history.js"),
    read("api/oneview/operations/health.js"),
    read("vercel.json").then(JSON.parse),
  ]);
  assert.match(detail, /createOneViewHandler\("alert-detail"\)/);
  assert.match(history, /createOneViewHandler\("alert-history"\)/);
  assert.match(operations, /createOneViewHandler\("operations-health"\)/);
  assert.deepEqual(vercel.rewrites, [{ source: "/((?!api/.*).*)", destination: "/index.html" }]);
});

test("fila de atenção permanece server-side e é apresentada somente na Home", async () => {
  const [route, config, database, fallback, api, alerts, index] = await Promise.all([
    read("api/oneview/attention-required.js"),
    read("api/_lib/oneview-config.js"),
    read("api/_lib/oneview-db.js"),
    read("api/_lib/oneview-fallback.js"),
    read("src/lib/oneview-api.ts"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Index.tsx"),
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
  assert.doesNotMatch(alerts, /Atenção necessária|attentionMeta|attentionOpen|Esquecidos/);
  assert.match(index, /fetchAttentionRequired\(ATTENTION_FETCH_LIMIT\)/);
  assert.match(index, /Atenção operacional/);
  assert.match(index, /attentionSummary/);
  assert.match(index, /ATTENTION_BUCKETS/);
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

  assert.match(index, /appendTemporal\("created"/);
  assert.match(index, /appendTemporal\("updated"/);
  assert.match(index, /appendTemporal\("ack"/);
  assert.match(index, /params\.set\(prefix, "custom"\)/);
  assert.match(index, /params\.set\("resolved", "custom"\)/);
  assert.match(index, /disasterFamilySeverities\(severityCountMap\)/);
  assert.match(index, /severities: \["high"\]/);
  assert.match(api, /for \(const severity of canonicalizeSeveritiesForApi/);
  assert.match(api, /disaster: \{ label: "Desastre"/);
  assert.doesNotMatch(api, /high: \{ label: "Crítico"/);

  assert.match(snapshot, /if \(raw === "disaster"\) return "disaster"/);
  assert.match(snapshot, /if \(\["high", "alta", "alto"\]\.includes\(raw\)\) return "high"/);
  assert.match(snapshot, /if \(\["critical", "critico", "crítico"\]\.includes\(raw\)\) return "critical"/);

  assert.match(alerts, /function safeActorName\(value: unknown\)/);
  assert.match(alerts, /!\/\^\\d\+\$\/\.test\(candidate\)/);
  assert.match(alerts, /Por: \$\{ack\.actorLabel\}/);
  assert.match(alerts, /sourceAcknowledgementComment/);
  assert.match(alerts, /sourceAckConfirmedWithoutHistory/);
  assert.match(alerts, /Processado pelo Worker OneView/);
  assert.match(alerts, /hasLoadedAlerts/);
  assert.doesNotMatch(alerts, /Sem ACK(?! no Zabbix)/);
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

  assert.match(alerts, /status === "acknowledged" \? "Reconhecido" : "Pendente"/);
  assert.match(alerts, /ack\.actorLabel \? `Por: \$\{ack\.actorLabel\}` : "Responsável não informado pela origem"/);
  assert.match(alerts, /sourceAckConfirmedWithoutHistory/);
  assert.match(alerts, /ACK atual confirmado pela origem/);
  assert.match(alerts, /Detalhes históricos deste reconhecimento não estão disponíveis no registro legado\./);
  assert.doesNotMatch(alerts, /Os detalhes históricos deste reconhecimento não estão disponíveis no registro legado\./);
  assert.doesNotMatch(alerts, /Sem ACK(?! no Zabbix)/);
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
  assert.match(alerts, /details open className="rounded-\[10px\] border border-border\/70 bg-white p-4 shadow-sm"/);
  assert.match(alerts, /showAlertsSkeleton = isAlertsLoading && !hasLoadedAlerts && alerts\.length === 0/);
  assert.match(alerts, /isAlertsLoading && hasLoadedAlerts/);
  assert.doesNotMatch(alerts.match(/const loadAlerts[\s\S]*?const loadSummaryResources/)?.[0] ?? "", /setAlerts\(\[\]\)/);

  assert.match(index, /operations\?\.items \?\? \[\]/);
  assert.match(index, /status === "disabled"/);
  assert.match(index, /status === "error"/);
  assert.match(index, /ATTENTION_BUCKETS/);
  assert.match(index, /RECENT_SEVERITY_GROUPS/);
  assert.match(index, /severities: recentSeverities/);
  assert.match(index, /sort: "first_seen_at"/);
  assert.match(index, /PRIORITY_SEVERITIES = \["disaster", "high"\]/);
  assert.match(index, /severities: \[\.\.\.PRIORITY_SEVERITIES\]/);
  assert.match(index, /isBackgroundUpdating/);
  assert.match(index, /beginQuietUpdate/);
  assert.match(index, /priorityAlertsHref/);
  assert.match(index, /status: "active"/);
  assert.match(index, /severity=|severity",/);
  assert.doesNotMatch(index, /disponibilidade\s*100%|uptime\s*100%/i);

  const priorityHrefBlock = index.match(/const priorityAlertsHref = `\/alertas\?\$\{buildAlertsQuery\(\{[\s\S]*?\}\)\.toString\(\)\}`;/);
  assert.ok(priorityHrefBlock);
  assert.match(priorityHrefBlock[0], /status: "active"/);
  assert.match(priorityHrefBlock[0], /PRIORITY_SEVERITIES/);
  assert.doesNotMatch(priorityHrefBlock[0], /priority:|status: "critical"|severity: "Crítico"/);

  assert.match(api, /for \(const severity of canonicalizeSeveritiesForApi/);
});
