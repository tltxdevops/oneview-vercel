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
  assert.match(api, /search\.set\("last_seen_from", params\.lastSeenFrom\)/);
  assert.match(index, /fetchAlerts\(\{ page: 1, pageSize: AUTOMATIC_ALERT_PAGE_SIZE, status: "active" \}\)/);
  assert.match(alerts, /setPagination\(normalized\.pagination\)/);
  assert.match(alerts, /Array\.isArray\(runtimeResponse\.items\)/);
});

test("alertas usa paginação BFF, debounce e cancelamento", async () => {
  const [api, alerts] = await Promise.all([read("src/lib/oneview-api.ts"), read("src/pages/Alerts.tsx")]);
  assert.match(alerts, /useState\(50\)/);
  assert.match(alerts, /useState<StatusFilter>\("active"\)/);
  assert.match(alerts, /window\.setTimeout\(\(\) => setDebouncedSearch\(searchTerm\.trim\(\)\), 400\)/);
  assert.match(alerts, /alertsRequestRef\.current\?\.abort\(\)/);
  assert.match(alerts, /requestId !== alertsRequestIdRef\.current/);
  assert.match(alerts, /if \(summaryRequestRef\.current\) return summaryRequestRef\.current/);
  assert.match(alerts, /<SelectItem value="25">25<\/SelectItem>/);
  assert.match(alerts, /<SelectItem value="50">50<\/SelectItem>/);
  assert.match(alerts, /<SelectItem value="100">100<\/SelectItem>/);
  assert.match(alerts, /Exibindo \{firstVisible\.toLocaleString/);
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
  assert.match(alerts, /Mais recentemente atualizados/);
  assert.match(alerts, /Mais novos/);
  assert.match(alerts, /Mais antigos/);
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

test("filtros são recolhíveis e somente a preferência visual vai ao localStorage", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /FILTERS_STORAGE_KEY = "oneview\.alerts\.filtersCollapsed"/);
  assert.match(alerts, /Ocultar filtros/);
  assert.match(alerts, /Mostrar filtros/);
  assert.match(alerts, /type="multiple" value=\{selectedPriorities\}/);
  assert.match(alerts, /selectedCustomerKeys/);
  assert.match(alerts, /selectedDatasources/);
  assert.match(alerts, /confidenceFilter/);
  assert.match(alerts, /<CommandInput placeholder="Buscar cliente\.\.\."/);
  assert.match(alerts, /Novos\s*<Select value=\{newTimePreset\}/);
  assert.match(alerts, /Atualizados\s*<Select value=\{updatedTimePreset\}/);
  assert.match(alerts, /<SelectItem value="new_15m">Últimos 15 minutos<\/SelectItem>/);
  assert.match(alerts, /<SelectItem value="new_1h">Última hora<\/SelectItem>/);
  assert.match(alerts, /<SelectItem value="new_24h">Últimas 24 horas<\/SelectItem>/);
  assert.match(alerts, /<SelectItem value="updated_15m">Últimos 15 minutos<\/SelectItem>/);
  assert.match(alerts, /<SelectItem value="updated_1h">Última hora<\/SelectItem>/);
  assert.match(alerts, /setSortField\("last_seen_at"\); setSortOrder\("desc"\)/);
  assert.match(alerts, /setSortField\("first_seen_at"\); setSortOrder\("desc"\)/);
  assert.match(alerts, /setSortField\("first_seen_at"\); setSortOrder\("asc"\)/);
  assert.match(alerts, /Crítico → baixo/);
  assert.match(alerts, /Baixo → crítico/);
  assert.doesNotMatch(alerts, /Saúde operacional/);
  assert.doesNotMatch(alerts, /localStorage\.(?:setItem|getItem)\([^\n]*(?:searchTerm|selectedCustomerKeys|selectedDatasources|selectedPriorities|ackFilter|timeRange)/);
});

test("início apresenta saúde operacional das fontes sem mover o painel para alertas", async () => {
  const [index, alerts] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
  ]);
  assert.match(index, /fetchOperationsHealth\(\)/);
  assert.match(index, /Dados podem estar desatualizados/);
  assert.match(index, /Sem dados disponíveis/);
  assert.match(index, /Fonte operacional/);
  assert.doesNotMatch(alerts, /Saúde operacional/);
});

test("alertas apresenta quatro prioridades sem descartar severidades Zabbix", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /critical: \{ label: "Crítico"/);
  assert.match(alerts, /high: \{ label: "Alto"/);
  assert.match(alerts, /medium: \{ label: "Médio"/);
  assert.match(alerts, /low: \{ label: "Baixo"/);
  assert.match(alerts, /rawSeverities: \["warning", "information", "not_classified"\]/);
  assert.match(alerts, /low:[^\n]+border-emerald-200 bg-emerald-50 text-emerald-700/);
  assert.match(alerts, /medium:[^\n]+border-amber-200 bg-amber-50 text-amber-700/);
  assert.match(alerts, /high:[^\n]+border-red-200 bg-red-50 text-red-700/);
  assert.match(alerts, /critical:[^\n]+border-red-500 bg-red-100 text-red-950/);
  assert.match(alerts, />Prioridade<\/TableHead>/);
  assert.match(alerts, />Ações<\/TableHead>/);
  assert.match(alerts, /<UserCheck className="h-3\.5 w-3\.5" \/> ACK/);
  assert.doesNotMatch(alerts, /Informativo \(baixa prioridade\)|>Severidade<\/TableHead>/);
});

test("resumo global e tabela filtrada deixam os escopos explícitos", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /Resumo global do OneView/);
  assert.match(alerts, /Métricas de todo o ambiente; os filtros abaixo se aplicam somente à tabela de alertas\./);
  assert.match(alerts, /Alertas filtrados por \{tableCustomerScope\}/);
  assert.match(alerts, /Escopo desta tabela: filtros de cliente, fonte, status, prioridade, ACK e período selecionados\./);
});

test("coluna IP só aparece quando a página contém endereço público sanitizado", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /function safeHostIp\(value: unknown\): string \| null/);
  assert.match(alerts, /first === 10 \|\| first === 127/);
  assert.match(alerts, /first === 192 && second === 168/);
  assert.match(alerts, /const showIpColumn = useMemo\(\(\) => alerts\.some\(\(alert\) => safeHostIp\(alert\.host_ip\) !== null\)/);
  assert.match(alerts, /\{showIpColumn \? <TableHead className="w-24">IP<\/TableHead> : null\}/);
  assert.match(alerts, /\{showIpColumn \? <TableCell[^\n]+safeHostIp\(alert\.host_ip\) \?\? "-"/);
});

test("drawer carrega detalhe e histórico em paralelo e solicita ACK com confirmação segura", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /Promise\.allSettled\(\[\s*fetchAlert\(id, controller\.signal\),\s*fetchAlertHistory\(id, controller\.signal\)/);
  assert.match(alerts, /<TabsTrigger value="summary"/);
  assert.match(alerts, /<TabsTrigger value="history"/);
  assert.match(alerts, /<TabsTrigger value="technical"/);
  assert.doesNotMatch(alerts, /ID do datasource/);
  assert.match(alerts, /requestAlertAcknowledgement/);
  assert.match(alerts, /Confirmar solicitação de reconhecimento/);
  assert.match(alerts, /maxLength=\{500\}/);
  assert.match(alerts, /ackRequestAllowedFor/);
  assert.match(alerts, /teletex-http/);
  assert.match(alerts, /A execução aguarda processamento operacional/);
  assert.match(alerts, /health\?\.capabilities\?\.acknowledgement === true/);
  assert.match(alerts, /Aguardando liberação operacional\./);
  assert.match(alerts, /Atribuição operacional em preparação\./);
  assert.match(alerts, /if \(!ackRequestsEnabled \|\| !selectedAlert \|\| !ackRequestKey \|\| ackSubmitting\) return;/);
  assert.match(alerts, /disabled=\{ackSubmitting \|\| !selectedAlert \|\| !ackRequestsEnabled\}/);
  assert.match(alerts, /customerPresentation\(selectedAlert\)/);
  assert.match(alerts, /selectedAlert\.datasource_name/);
  assert.match(alerts, /selectedAlert\.host_groups/);
  assert.match(alerts, /selectedAlert\.event_tags/);
  assert.match(alerts, /item\.occurred_at/);
  assert.match(alerts, /Completo/);
  assert.match(alerts, /Enriquecimento parcial/);
  assert.match(alerts, /enrichmentExplanations/);
  assert.match(alerts, /Histórico legado/);
  assert.match(alerts, /Não classificado/);
  assert.match(alerts, /Cliente não classificado/);
  assert.match(alerts, /A origem não possui evidências suficientes para identificação automática\./);
  assert.match(alerts, /Dados históricos aguardando classificação/);
  assert.match(alerts, /Classificação histórica pendente/);
  assert.doesNotMatch(alerts, /Cliente pendente/);
  assert.match(alerts, /Eventos exibidos/);
  assert.match(alerts, /Primeiro evento/);
  assert.match(alerts, /Último evento/);
  assert.match(alerts, /Total de reconhecimentos/);
  assert.match(alerts, /Primeiro ACK/);
  assert.match(alerts, /ACK mais recente/);
  assert.match(alerts, /Possui comentário/);
  assert.match(alerts, /Recovery/);
  assert.match(alerts, /Responsável pelo ACK/);
  assert.match(alerts, /Responsável não resolvido no Zabbix/);
  assert.match(alerts, /item\.ack_actor_name/);
  assert.doesNotMatch(alerts, /actor_id/);
  assert.match(alerts, /Horário original/);
  assert.match(alerts, /Valor anterior/);
  assert.match(alerts, /Valor atual/);
  assert.match(alerts, /groupHistoryItems/);
  assert.match(alerts, /Ocorrência atualizada \$\{groupedEventCount\} vezes/);
  assert.match(alerts, /Reconhecimentos/);
  assert.match(alerts, /Mudanças/);
  assert.match(alerts, /Legado/);
  assert.match(alerts, /Ver horários das ocorrências agrupadas/);
  assert.match(alerts, /Exibir informações técnicas/);
  assert.match(alerts, /Nenhum evento histórico estruturado disponível\./);
  assert.match(alerts, /Eventos anteriores ao enriquecimento podem possuir menos detalhes\./);
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

test("fila de atenção permanece server-side e não é montada em alertas", async () => {
  const [route, config, database, fallback, api, alerts] = await Promise.all([
    read("api/oneview/attention-required.js"),
    read("api/_lib/oneview-config.js"),
    read("api/_lib/oneview-db.js"),
    read("api/_lib/oneview-fallback.js"),
    read("src/lib/oneview-api.ts"),
    read("src/pages/Alerts.tsx"),
  ]);
  assert.match(route, /createOneViewHandler\("attention-required"\)/);
  assert.match(config, /ONEVIEW_DISASTER_UNACK_MINUTES|attentionThresholds/);
  assert.match(database, /coalesce\(a\.acknowledged_source, false\) = false/);
  assert.match(database, /a\.first_seen_at < now\(\)/);
  assert.doesNotMatch(database.match(/async function fetchAttentionRequiredPayload[\s\S]*?function alertId/)?.[0] ?? "", /payload_raw|payload_normalized|inventory|api_url|token_encrypted/);
  assert.match(fallback, /attentionRequiredPayload/);
  assert.doesNotMatch(api, /fetchAttentionRequired|AttentionRequiredResponse/);
  assert.doesNotMatch(alerts, /Atenção necessária|attentionMeta|attentionOpen/);
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
