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
  assert.match(api, /search\.set\("host_search", params\.hostSearch\)/);
  assert.match(api, /search\.set\("problem_search", params\.problemSearch\)/);
  assert.match(index, /pageSize: RECENT_LIMIT/);
  assert.match(index, /status: "active"/);
  assert.match(index, /severities: \["disaster", "high"\]/);
  assert.match(index, /sort: "first_seen_at"/);
  assert.match(index, /customers: selectedCustomerKeys/);
  assert.match(alerts, /setPagination\(normalized\.pagination\)/);
  assert.match(alerts, /Array\.isArray\(runtimeResponse\.items\)/);
});

test("alertas usa paginação BFF, debounce e cancelamento", async () => {
  const [api, alerts] = await Promise.all([read("src/lib/oneview-api.ts"), read("src/pages/Alerts.tsx")]);
  assert.match(alerts, /useState\(50\)/);
  assert.match(alerts, /useState<StatusFilter>\("active"\)/);
  assert.match(alerts, /window\.setTimeout\(\(\) => \{/);
  assert.match(alerts, /setDebouncedHostSearch\(hostSearch\.trim\(\)\)/);
  assert.match(alerts, /setDebouncedProblemSearch\(problemSearch\.trim\(\)\)/);
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
  assert.match(alerts, /confidenceFilter/);
  assert.match(alerts, /<CommandInput placeholder="Buscar cliente\.\.\."/);
  assert.match(alerts, /Novos\s*<Select value=\{newTimePreset\}/);
  assert.match(alerts, /Atualizados\s*<Select value=\{updatedTimePreset\}/);
  assert.match(alerts, /<SelectItem value="new_15m">Últimos 15 minutos<\/SelectItem>/);
  assert.match(alerts, /<SelectItem value="new_1h">Última hora<\/SelectItem>/);
  assert.match(alerts, /<SelectItem value="new_24h">Últimas 24 horas<\/SelectItem>/);
  assert.match(alerts, /<SelectItem value="updated_15m">Últimos 15 minutos<\/SelectItem>/);
  assert.match(alerts, /<SelectItem value="updated_1h">Última hora<\/SelectItem>/);
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

test("início apresenta saúde operacional das fontes sem mover o painel para alertas", async () => {
  const [index, alerts] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
  ]);
  assert.match(index, /fetchOperationsHealth\(\)/);
  assert.match(index, /Dados possivelmente desatualizados/);
  assert.match(index, /Fontes com erro/);
  assert.match(index, /Fontes operacionais/);
  assert.doesNotMatch(alerts, /Saúde operacional/);
});

test("Home operacional usa criação real, atenção, clientes e sincronizações compactas", async () => {
  const index = await read("src/pages/Index.tsx");
  assert.match(index, /Alertas ativos/);
  assert.match(index, /Críticos \/ Altos/);
  assert.match(index, /Não reconhecidos na origem/);
  assert.match(index, /Resolvidos hoje/);
  assert.match(index, /Atenção necessária/);
  assert.match(index, /Clientes com mais alertas/);
  assert.match(index, /Alertas recentes/);
  assert.match(index, /Novos críticos e altos por primeira ocorrência/);
  assert.match(index, /sort: "first_seen_at"/);
  assert.match(index, /order: "desc"/);
  assert.match(index, /customers: selectedCustomerKeys/);
  assert.match(index, /Últimas sincronizações/);
  assert.ok(index.indexOf("Últimas sincronizações") < index.indexOf("Alertas recentes"));
  assert.match(index, /showRefreshMeta=\{false\}/);
  assert.doesNotMatch(index, /dataSource=\{currentDataSource\}|checkedAt=\{lastCheckedAt\}/);
  assert.match(index, /aria-label="Ver detalhes do alerta"/);
  assert.match(index, />ACK<\/Link>/);
  assert.match(index, /Atribuição operacional em preparação\./);
  assert.match(index, /severities: \["disaster", "high"\]/);
  assert.match(index, /status: "active"/);
  assert.doesNotMatch(index, /<h2[^>]*>Chamados<\/h2>|Castrolanda/);
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
  const [index, alerts, api, config] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/lib/oneview-api.ts"),
    read("api/_lib/oneview-config.js"),
  ]);
  assert.match(config, /ONEVIEW_ALERT_STALE_MINUTES/);
  assert.match(api, /alert_stale_minutes/);
  assert.match(index, /Ativo e confirmado recentemente/);
  assert.match(index, /Ativo, mas sem confirmação recente/);
  assert.match(index, /Dados possivelmente desatualizados/);
  assert.match(alerts, /Frescor do dado/);
  assert.match(alerts, /Tempo sem confirmação/);
  assert.match(alerts, /Duração longa não indica falha de sincronização/);
});

test("cliente não identificado é filtrável sem usar datasource como cliente", async () => {
  const [index, alerts] = await Promise.all([read("src/pages/Index.tsx"), read("src/pages/Alerts.tsx")]);
  assert.match(index, /customer\.key === "unclassified" \? "Não identificado"/);
  assert.match(alerts, /customer\.key === "unclassified"/);
  assert.match(alerts, /Cliente não identificado/);
  assert.match(alerts, /identificar automaticamente o cliente/);
  assert.doesNotMatch(index, /customer_name\s*\|\|\s*alert\.datasource_name/);
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
  assert.match(alerts, /sortableHeader\("Prioridade", "severity"\)/);
  assert.match(alerts, />Ações<\/TableHead>/);
  assert.match(alerts, /<UserCheck className="h-3\.5 w-3\.5" \/> ACK/);
  assert.doesNotMatch(alerts, /Informativo \(baixa prioridade\)|>Severidade<\/TableHead>/);
});

test("cards de indicadores aplicam filtros rápidos sem textos redundantes", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /type SummaryFilter = "total" \| "active" \| "acknowledged" \| "pending" \| "high" \| "critical"/);
  assert.match(alerts, /const applySummaryFilter = \(filter: SummaryFilter\)/);
  assert.match(alerts, /aria-label=\{`Filtrar alertas: \$\{card\.title\}`\}/);
  assert.match(alerts, /onClick=\{\(\) => applySummaryFilter\(card\.filter\)\}/);
  assert.match(alerts, /setStatusFilter\(filter === "total" \? "all" : "active"\)/);
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
  assert.match(alerts, /showIpColumn \? \"w-\[24%\]\" : \"w-\[30%\]\"/);
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

test("drawer carrega detalhe e histórico em paralelo e solicita ACK com confirmação segura", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /Promise\.allSettled\(\[\s*fetchAlert\(id, controller\.signal\),\s*fetchAlertHistory\(id, controller\.signal\)/);
  assert.match(alerts, /<TabsTrigger value="summary"/);
  assert.match(alerts, /<TabsTrigger value="history"/);
  assert.match(alerts, /<TabsTrigger value="technical"/);
  assert.doesNotMatch(alerts, /ID do datasource/);
  assert.match(alerts, /requestAlertAcknowledgement/);
  assert.match(alerts, /Confirmar reconhecimento no OneView/);
  assert.match(alerts, /maxLength=\{500\}/);
  assert.match(alerts, /ackRequestAllowedFor/);
  assert.match(alerts, /teletex-http/);
  assert.match(alerts, /Nenhuma ação será enviada ao Zabbix/);
  assert.match(alerts, /health\?\.capabilities\?\.acknowledgement === true/);
  assert.match(alerts, /Aguardando liberação operacional\./);
  assert.match(alerts, /Atribuição operacional em preparação\./);
  assert.match(alerts, /if \(!ackRequestsEnabled \|\| !selectedAlert \|\| !ackRequestKey \|\| ackSubmitting\) return;/);
  assert.match(alerts, /disabled=\{ackSubmitting \|\| !selectedAlert \|\| !ackRequestsEnabled \|\| ackComment\.trim\(\)\.length === 0\}/);
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
  assert.match(alerts, /Cliente não identificado/);
  assert.match(alerts, /A origem não possui evidências suficientes para identificar automaticamente o cliente\./);
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
  assert.match(alerts, /Horário da origem/);
  assert.match(alerts, /Registrado no OneView/);
  assert.match(alerts, /Origem Zabbix/);
  assert.match(alerts, /Origem OneView/);
  assert.match(alerts, /Evidência parcial/);
  assert.match(alerts, /Qualidade do histórico/);
  assert.match(alerts, /Histórico completo/);
  assert.match(alerts, /Histórico parcial/);
  assert.match(alerts, /Histórico indisponível/);
  assert.match(alerts, /Valor anterior/);
  assert.match(alerts, /Valor atual/);
  assert.match(alerts, /groupHistoryItems/);
  assert.match(alerts, /Ocorrência atualizada \$\{groupedEventCount\} vezes/);
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
  assert.doesNotMatch(database.match(/async function fetchAttentionRequiredPayload[\s\S]*?function alertId/)?.[0] ?? "", /payload_raw|payload_normalized|inventory|api_url|token_encrypted/);
  assert.match(fallback, /attentionRequiredPayload/);
  assert.match(api, /fetchAttentionRequired|AttentionRequiredResponse/);
  assert.doesNotMatch(alerts, /Atenção necessária|attentionMeta|attentionOpen/);
  assert.match(index, /fetchAttentionRequired\(100\)/);
  assert.match(index, /Atenção necessária/);
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
