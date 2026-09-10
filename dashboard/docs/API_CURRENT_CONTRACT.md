# OneView — Contrato atual da API (OV-P0-14 / OV-P0-14B)

**Documento:** inventário completo do contrato HTTP atual do OneView + documentação operacional ampliada  
**Fonte de verdade:** código em `dashboard/api/**`, `dashboard/scripts/dev-oneview-bff.mjs`, `dashboard/scripts/dev-sso-local.mjs`, `dashboard/src/lib/oneview-api.ts`, consumidores em `src/pages/**`, testes em `dashboard/tests/**`, `dashboard/vercel.json`, `dashboard/package.json`  
**Data do inventário inicial (OV-P0-14):** 2026-07-30 — **39 endpoints** (método+path)  
**Revisão operacional (OV-P0-14B):** 2026-07-31 — seções de autenticação, fluxo de alertas, ACK/Zabbix, histórico, métricas, escritas, matriz de capacidades e exemplos  
**Escopo:** somente documentação — nenhum código produtivo, banco, worker, deploy ou commit foi alterado nesta entrega  

---

## 1. Resumo executivo

A superfície HTTP do dashboard OneView está organizada em **cinco famílias**: (1) BFF operacional `/api/oneview/*`, (2) API legada `/api/alerts*` e `/api/data-sources*`, (3) autenticação `/api/auth/*`, (4) health legada `/api/health*`, e (5) probes internos do BFF local `/__oneview/load/*`.

Há **33 arquivos de handler** sob `dashboard/api/` (excluindo `_lib`) e **39 combinações método+path** inventariadas (incluindo dual-method em auth callback / data-sources e 3 probes locais).

O frontend V1 (`oneview-api.ts` + páginas Index/Alerts/Historico/Settings) consome quase exclusivamente `/api/oneview/*` + `GET /api/auth/config`. Funções legadas de notes/assign/status existem no client mas **não têm consumidor de página**. `POST /api/data-sources/:id/request-sync` é chamado por Settings, porém **não está no BFF local** (só Vercel).

Todas as leituras operacionais OneView e a maioria das escritas legadas de alerta aplicam escopo obrigatório `data_sources.name = teletex-http` (env `ONEVIEW_PRIMARY_DATA_SOURCE_NAME`). Exceção relevante: `GET /api/data-sources` legado lista **todas** as fontes.

Auth SSO é obrigatória para rotas autenticadas (`requireAuth` / `requireOneViewAuth`). Todo usuário Microsoft Entra autenticado e validado recebe `operator`; `OneView.Admin` confiável eleva para `admin`.

Respostas OneView (`createOneViewHandler`) sempre usam `Cache-Control: no-store…`, sanitizam secrets/URLs/IPs e anexam `data_source` / `fallback_code` / `checked_at`. Fallback para snapshot (`oneview-real-snapshot.safe.json`) depende de flags de env.

---

## 2. Mapa das famílias de API

| Família | Prefixo | Ambiente principal | Natureza |
|--------|---------|-------------------|----------|
| OneView BFF | `/api/oneview/*` | BFF local **e** Vercel | operacional / somente leitura (+ ack-request escrita controlada) |
| Alerts legado | `/api/alerts*` | **Somente Vercel** | legado / misto leitura-escrita |
| Data sources legado | `/api/data-sources*` | **Somente Vercel** | legado / escrita parcial bloqueada |
| Auth | `/api/auth/*` | SSO local (`dev-sso-local`) **e** Vercel | operacional |
| Health legado | `/api/health*` | **Somente Vercel** | legado / interno |
| Root | `/api` | Vercel | interno |
| Load probes | `/__oneview/load/*` | **Somente BFF local** | interno |

### Routing de deploy / local

| Artefato | Comportamento |
|----------|---------------|
| `dashboard/vercel.json` | Rewrite SPA `/(?!api/.*)` → `/index.html`; handlers serverless em `api/**` |
| `scripts/dev-oneview-bff.mjs` | Porta `8787`; só rotas `/api/oneview/*` + probes |
| `scripts/dev-sso-local.mjs` | Porta `8000`; só `/api/auth/*`; sobe Vite |
| `vite.config.ts` | Proxy `/api/oneview` → BFF `8787`; demais `/api` → `8000` |

---

## 3. Tabela mestre de endpoints

| # | Método | Path | Família | Env | Tags | Frontend |
|---|--------|------|---------|-----|------|----------|
| 1 | GET | `/api` | root | Vercel | interno \| não utilizado | — |
| 2 | GET | `/api/health` | health | Vercel | legado \| não utilizado | — |
| 3 | GET | `/api/health/db` | health | Vercel | legado \| não utilizado | — |
| 4 | GET | `/api/health/worker` | health | Vercel | legado \| não utilizado | — |
| 5 | GET | `/api/health/outbox` | health | Vercel | legado \| não utilizado | — |
| 6 | GET | `/api/auth/config` | auth | SSO local + Vercel | operacional | `main.tsx` |
| 7 | GET | `/api/auth/me` | auth | SSO local + Vercel | operacional | SSO server-side |
| 8 | POST | `/api/auth/logout` | auth | SSO local + Vercel | operacional | SSO server-side |
| 9 | GET | `/api/auth/microsoft/login` | auth | SSO local + Vercel | operacional | SSO server-side |
| 10 | GET | `/api/auth/microsoft/callback` | auth | SSO local + Vercel | operacional | browser redirect |
| 11 | POST | `/api/auth/microsoft/callback` | auth | SSO local + Vercel | operacional | SSO server-side |
| 12 | GET | `/api/alerts` | alerts legado | Vercel | legado \| não utilizado | — (client não chama) |
| 13 | GET | `/api/alerts/metrics` | alerts legado | Vercel | legado \| não utilizado | — |
| 14 | GET | `/api/alerts/:id` | alerts legado | Vercel | legado \| não utilizado | — |
| 15 | POST | `/api/alerts/:id/ack` | ACK | Vercel | legado \| escrita bloqueada \| não utilizado | — |
| 16 | POST | `/api/alerts/:id/assign` | assignment | Vercel | legado \| não utilizado | client exportado, sem página |
| 17 | POST | `/api/alerts/:id/notes` | notes | Vercel | legado \| não utilizado | client exportado, sem página |
| 18 | POST | `/api/alerts/:id/status` | status | Vercel | legado \| não utilizado | client exportado, sem página |
| 19 | GET | `/api/data-sources` | data-sources | Vercel | legado \| não utilizado | — (UI usa oneview) |
| 20 | POST | `/api/data-sources` | data-sources | Vercel | legado \| escrita bloqueada \| não utilizado | — |
| 21 | GET | `/api/data-sources/:id` | data-sources | Vercel | legado \| não utilizado | — |
| 22 | PATCH | `/api/data-sources/:id` | data-sources | Vercel | legado \| não utilizado | — |
| 23 | POST | `/api/data-sources/:id/request-sync` | request-sync | Vercel | legado | `Settings.tsx` |
| 24 | GET | `/api/oneview/health` | oneview | Ambos | operacional \| somente leitura | Index, Alerts |
| 25 | GET | `/api/oneview/dashboard-summary` | metrics | Ambos | operacional \| somente leitura | Index, Alerts |
| 26 | GET | `/api/oneview/grafana-summary` | metrics | Ambos | operacional \| não utilizado | — |
| 27 | GET | `/api/oneview/alerts` | oneview | Ambos | operacional \| somente leitura | Index, Alerts |
| 28 | GET | `/api/oneview/attention-required` | oneview | Ambos | operacional \| somente leitura | Index |
| 29 | GET | `/api/oneview/alerts/:id` | oneview | Ambos | operacional \| somente leitura | Index, Alerts |
| 30 | GET | `/api/oneview/alerts/:id/history` | history | Ambos | operacional \| somente leitura | Index, Alerts |
| 31 | POST | `/api/oneview/alerts/:id/ack-request` | ACK | Ambos | operacional \| escrita controlada | Alerts |
| 32 | GET | `/api/oneview/history` | history | Ambos | operacional \| somente leitura | Index, Historico |
| 33 | GET | `/api/oneview/operations/health` | health | Ambos | operacional \| somente leitura | Index, Alerts |
| 34 | GET | `/api/oneview/clients-summary` | oneview | Ambos | operacional \| somente leitura | Alerts, Historico |
| 35 | GET | `/api/oneview/data-sources` | data-sources | Ambos | operacional \| somente leitura | Alerts, Settings |
| 36 | GET | `/api/oneview/sync-logs` | oneview | Ambos | operacional \| somente leitura | Index |
| 37 | GET | `/__oneview/load/pool` | probes | BFF local | interno | load scripts |
| 38 | GET | `/__oneview/load/state` | probes | BFF local | interno | load scripts |
| 39 | POST | `/__oneview/load/reset` | probes | BFF local | interno | load scripts |

**Total inventariado: 39 endpoints (método+path).**

---

## 4. Contrato detalhado de cada endpoint

Convenções comuns:

- **Auth:** sessão cookie SSO válida ou Azure JWT validado; origin permitido; todo autenticado é `operator`.
- **Admin:** claim confiável exata `OneView.Admin`.
- **Erros auth:** 401 `authentication_required` | `invalid_token`; 403 `identity_not_allowed` | `origin_not_allowed`.
- **Escopo teletex:** `getPrimaryDataSourceName()` → default `teletex-http`.
- **Envelope OneView GET:** headers `Cache-Control: no-store, no-cache, max-age=0, must-revalidate`, `X-Content-Type-Options: nosniff`, opcional `X-OneView-Data-Source`; body + `data_source`, `fallback_code`, `checked_at` (após sanitize).
- **Erros OneView GET:** 405; 400 `invalid_query`; 404 `not_found`; 503 `live_data_not_configured` | `live_database_disabled` | `unsafe_database_user` | `snapshot_unavailable` | `database_unavailable` | `database_*`.

---

### 4.1 GET `/api`

| Campo | Valor |
|-------|-------|
| Objetivo | Ping raiz da API serverless |
| Env | Vercel |
| Auth | Nenhuma |
| Tags | interno \| não utilizado |
| Sucesso 200 | `{ status: "ok", service: "oneview-vercel-api", zabbix_access: false }` |
| DB | — |
| Cache | não definido |
| Testes | — |
| Limitações | Sem `methodNotAllowed` explícito para não-GET |

**Exemplo resposta:** `{ "status": "ok", "service": "oneview-vercel-api", "zabbix_access": false }`

---

### 4.2 GET `/api/health`

| Campo | Valor |
|-------|-------|
| Objetivo | Saúde agregada (DB time, workers, outbox) |
| Env | Vercel |
| Auth | viewer |
| Tags | legado \| não utilizado \| somente leitura |
| Escopo teletex | não (views globais) |
| Sucesso 200 | `{ ok, service, database_time, workers_total, workers_alive, outbox_pending }` |
| Erros | 401/403; 405; 500 `database_not_configured` / `request_failed` |
| Tabelas lidas | `v_worker_health`, `integration_outbox` (+ `select now()`) |
| Funções | `query` (`_lib/db.js`) |
| Cache | não definido |
| Frontend | nenhum |
| Testes | nenhum dedicado |

---

### 4.3 GET `/api/health/db`

| Campo | Valor |
|-------|-------|
| Objetivo | Contagens DB + identidade da conexão |
| Env | Vercel |
| Auth | viewer |
| Tags | legado \| não utilizado \| somente leitura |
| Sucesso 200 | `{ ok, database_time, database_name, database_user, data_sources, alerts, active_alerts }` |
| Tabelas | `data_sources`, `alerts`, `v_active_alerts` |
| Escopo teletex | não |

---

### 4.4 GET `/api/health/worker`

| Campo | Valor |
|-------|-------|
| Objetivo | Status de workers e datasources |
| Env | Vercel |
| Auth | viewer |
| Tags | legado \| não utilizado \| somente leitura |
| Sucesso 200 | `{ ok, workers[], data_sources[] }` |
| Tabelas | `v_worker_health`, `v_datasource_health` |

---

### 4.5 GET `/api/health/outbox`

| Campo | Valor |
|-------|-------|
| Objetivo | Totais e backlog da outbox |
| Env | Vercel |
| Auth | viewer |
| Tags | legado \| não utilizado \| somente leitura |
| Sucesso 200 | `{ ok, totals: { pending, processing, failed, success, cancelled }, backlog[] }` |
| Tabelas | `v_outbox_backlog`, `integration_outbox` |

---

### 4.6 GET `/api/auth/config`

| Campo | Valor |
|-------|-------|
| Objetivo | Config pública SSO / modo leitura para bootstrap do frontend |
| Env | SSO local + Vercel |
| Auth | Nenhuma |
| Tags | operacional |
| Query | — |
| Sucesso 200 | `ONEVIEW_READ_ONLY_MODE` (default `"true"`), `VITE_AZURE_CLIENT_ID`, `VITE_AZURE_TENANT_ID`, `VITE_AZURE_AUTHORITY`, `VITE_AZURE_REDIRECT_URI`, `VITE_AZURE_POST_LOGOUT_URI`, `VITE_AZURE_SCOPES`, `VITE_MSAL_LOG_LEVEL` |
| Erros | 405 |
| Frontend | `src/main.tsx` |
| Testes | indiretos em `oneview-bff.test.mjs` (SSO helpers) |
| Riscos | Expõe client/tenant IDs (públicos por design); placeholders são limpos |

**Exemplo resposta (sanitizado):**
```json
{
  "ONEVIEW_READ_ONLY_MODE": "true",
  "VITE_AZURE_CLIENT_ID": "<client-id>",
  "VITE_AZURE_TENANT_ID": "<tenant-id>",
  "VITE_AZURE_AUTHORITY": "https://login.microsoftonline.com/<tenant-id>",
  "VITE_AZURE_REDIRECT_URI": "https://example/sso/callback",
  "VITE_AZURE_POST_LOGOUT_URI": "https://example/login",
  "VITE_AZURE_SCOPES": "openid profile email offline_access User.Read",
  "VITE_MSAL_LOG_LEVEL": "warning"
}
```

---

### 4.7 GET `/api/auth/me`

| Campo | Valor |
|-------|-------|
| Objetivo | Usuário da sessão atual |
| Env | SSO local + Vercel |
| Auth | Sessão cookie ou Bearer (sem role gate adicional) |
| Tags | operacional |
| Sucesso 200 | `{ user }` |
| Erros | 401 `authentication_required`; 405 |

---

### 4.8 POST `/api/auth/logout`

| Campo | Valor |
|-------|-------|
| Objetivo | Limpar cookie de sessão |
| Env | SSO local + Vercel |
| Auth | Nenhuma |
| Tags | operacional |
| Sucesso 200 | `{ ok: true }` |

---

### 4.9 GET `/api/auth/microsoft/login`

| Campo | Valor |
|-------|-------|
| Objetivo | Gerar URL de autorização Microsoft |
| Env | SSO local + Vercel |
| Auth | Nenhuma |
| Query | `state` opcional |
| Sucesso 200 | `{ authUrl }` |
| Erros | 500 `microsoft_sso_not_configured`; 405 |

---

### 4.10 GET `/api/auth/microsoft/callback`

| Campo | Valor |
|-------|-------|
| Objetivo | Redirect browser pós-OAuth |
| Env | SSO local + Vercel |
| Tags | operacional |
| Sucesso | **302** para `/?code&state&sso_error` |

---

### 4.11 POST `/api/auth/microsoft/callback`

| Campo | Valor |
|-------|-------|
| Objetivo | Trocar `code` por sessão |
| Body | `{ code: string }` obrigatório |
| Sucesso 200 | `{ user, session }` |
| Erros | 400 `missing_code`; 401 `callback_failed`; 405 |
| Escrita | cookie de sessão |

---

### 4.12 GET `/api/alerts`

| Campo | Valor |
|-------|-------|
| Objetivo | Lista legada de alertas |
| Env | **Vercel only** |
| Auth | viewer |
| Tags | legado \| não utilizado \| somente leitura |
| Escopo teletex | **sim** (`data_source_id = (select id from data_sources where name = $1)`) |
| Query | `client_name`, `severity`, `status_internal`, `host` (ilike), `service` (ilike), `acknowledged` (bool), `limit` default 100 max 1000, `offset` default 0 max 100000 |
| Paginação | limit/offset (não page/page_size) |
| Sort | fixo `first_seen_at desc` |
| Sucesso 200 | `{ items: ALERT_FIELDS[], total }` |
| Tabelas | `alerts` |
| Funções | `ALERT_FIELDS`, `query` |
| Cache | não |
| Frontend | nenhum (UI usa `/api/oneview/alerts`) |
| Testes | `oneview-teletex-scope.test.mjs` (escopo no fonte) |

**Exemplo request:** `GET /api/alerts?severity=disaster&limit=50&offset=0`  
**Exemplo response:** `{ "items": [{ "id": "<uuid>", "problem_name": "...", "severity": "disaster", "...": "..." }], "total": 12 }`

---

### 4.13 GET `/api/alerts/metrics`

| Campo | Valor |
|-------|-------|
| Objetivo | Métricas legadas de alertas |
| Env | Vercel |
| Auth | viewer |
| Tags | legado \| não utilizado \| somente leitura |
| Escopo teletex | sim (CTE) |
| Sucesso 200 | `active_total`, `by_severity[]`, `by_status[]`, `by_client[]`, `by_service[]`, `top_hosts[]`, `unacknowledged_total`, `longest_duration[]`, `avg_ack_time_seconds`, `avg_normalization_time_seconds` |
| Tabelas | `alerts`, `data_sources`, `alert_history` |
| Frontend | nenhum (UI usa `dashboard-summary`) |

---

### 4.14 GET `/api/alerts/:id`

| Campo | Valor |
|-------|-------|
| Objetivo | Detalhe legado |
| Env | Vercel |
| Auth | viewer |
| Tags | legado \| não utilizado \| somente leitura |
| Path | `id` |
| Escopo teletex | sim (`getAlert`) |
| Sucesso 200 | objeto ALERT_FIELDS |
| Erros | 404 `alert_not_found` |

---

### 4.15 POST `/api/alerts/:id/ack`

| Campo | Valor |
|-------|-------|
| Objetivo | ACK real Zabbix (bloqueado) |
| Env | Vercel |
| Auth | operator |
| Tags | legado \| escrita bloqueada \| não utilizado \| ACK |
| Sucesso | **nunca** — sempre **403** `{ error: "real_ack_blocked", detail: "..." }` |
| DB | nenhuma |
| Frontend | nenhum |

---

### 4.16 POST `/api/alerts/:id/assign`

| Campo | Valor |
|-------|-------|
| Objetivo | Atribuir alerta a operador |
| Env | Vercel |
| Auth | operator |
| Tags | legado \| não utilizado |
| Body | `{ operator_name?, message? }` — operador via auth/body/headers |
| Sucesso 201 | assignment row |
| Erros | 404 `alert_not_found`; 500 |
| Escopo teletex | sim (`getAlert`) |
| Tabelas escritas | `alert_assignments`, `alerts` (status), `alert_history`, `audit_logs` |
| Frontend client | `assignAlert()` em `oneview-api.ts` — **sem página consumidora** |
| Riscos | Usa pool readonly (`db.js` → `oneview_vercel_readonly`); grants DB podem falhar em produção |

---

### 4.17 POST `/api/alerts/:id/notes`

| Campo | Valor |
|-------|-------|
| Objetivo | Adicionar nota |
| Env | Vercel |
| Auth | operator |
| Tags | legado \| não utilizado \| notes |
| Body | `{ message: string }` obrigatório; `operator_name?` |
| Sucesso 201 | note row |
| Erros | 400 `message_required`; 404 `alert_not_found` |
| Tabelas escritas | `alert_notes`, `alert_history`, `audit_logs` |
| Frontend client | `addAlertNote()` — sem página |

**Exemplo request:**
```http
POST /api/alerts/<alert-id>/notes
Authorization: Bearer <token>
Content-Type: application/json

{ "message": "Investigando latência", "operator_name": "oneview-ui" }
```

---

### 4.18 POST `/api/alerts/:id/status`

| Campo | Valor |
|-------|-------|
| Objetivo | Atualizar status interno |
| Env | Vercel |
| Auth | operator |
| Tags | legado \| não utilizado \| status |
| Body | `{ status, message?, operator_name? }` — `status` ∈ `new\|viewed\|in_progress\|acknowledged\|observing\|normalized\|hidden` |
| Sucesso 200 | `{ id, status_internal, acknowledged_internal, updated_at }` |
| Erros | 400 `invalid_status`; 404 `alert_not_found` |
| Tabelas escritas | `alerts`, `alert_history`, `audit_logs` |
| Frontend client | `updateAlertStatus()` — sem página |

---

### 4.19 GET `/api/data-sources`

| Campo | Valor |
|-------|-------|
| Objetivo | Listar todas as fontes (legado) |
| Env | Vercel |
| Auth | viewer |
| Tags | legado \| não utilizado \| somente leitura |
| Escopo teletex | **NÃO** — retorna todas |
| Sucesso 200 | array de `sanitizeDataSource` (inclui `api_url`) |
| Tabelas | `data_sources` |
| Riscos | Expõe `api_url`; divergente do BFF OneView (escopo + sem secrets) |

---

### 4.20 POST `/api/data-sources`

| Campo | Valor |
|-------|-------|
| Objetivo | Criar fonte (bloqueado) |
| Env | Vercel |
| Auth | admin (nunca concedido via SSO → 403 típico) |
| Tags | legado \| escrita bloqueada \| não utilizado |
| Resposta | **403** `data_source_secret_management_blocked_on_vercel` |

---

### 4.21 GET `/api/data-sources/:id`

| Campo | Valor |
|-------|-------|
| Objetivo | Detalhe de fonte |
| Env | Vercel |
| Auth | viewer |
| Tags | legado \| não utilizado |
| Erros | 404 `data_source_not_found` |
| Escopo teletex | não (qualquer id) |

---

### 4.22 PATCH `/api/data-sources/:id`

| Campo | Valor |
|-------|-------|
| Objetivo | Atualizar metadados da fonte |
| Env | Vercel |
| Auth | admin |
| Tags | legado \| não utilizado |
| Body | `name`, `client_name`, `environment`, `api_url`, `problem_group_filter`, `status`, `sync_enabled`, `sync_interval_seconds`, `via_vpn`, `observation`, `display_order` |
| Tabelas escritas | `data_sources`, `audit_logs` |
| Limitação | role admin inacessível via SSO atual |

---

### 4.23 POST `/api/data-sources/:id/request-sync`

| Campo | Valor |
|-------|-------|
| Objetivo | Enfileirar sync manual na outbox |
| Env | **Vercel only** (ausente do BFF local) |
| Auth | operator |
| Tags | legado \| request-sync |
| Body | `{ limit?, reason? }` default reason `"manual_request"` |
| Sucesso 202 | `{ outbox_id, status: "pending" }` |
| Erros | 404 `data_source_not_found`; 500 |
| Escopo teletex | não (qualquer data_source id) |
| Tabelas escritas | `integration_outbox`, `audit_logs` |
| Frontend | `Settings.tsx` → `requestDataSourceSync()` |
| Limitações | Em `isReadOnlyMode` o client lança erro antes do fetch; localmente o proxy não encontra a rota no SSO (`8000`) → 404 |
| Testes | nenhum dedicado de handler |

**Exemplo request:**
```http
POST /api/data-sources/<ds-id>/request-sync
Authorization: Bearer <token>
Content-Type: application/json

{ "reason": "manual_ui" }
```

---

### 4.24 GET `/api/oneview/health`

| Campo | Valor |
|-------|-------|
| Handler | `createOneViewHandler("health")` |
| Env | BFF local + Vercel |
| Auth | viewer |
| Tags | operacional \| somente leitura |
| Escopo teletex | sim |
| Query | — |
| Sucesso 200 | `{ status: "ok", database_reachable, counts: { total_alerts, active_alerts }, capabilities: { acknowledgement }, thresholds: { alert_stale_minutes }, data_source, fallback_code, checked_at }` |
| Tabelas | `alerts`, `data_sources` |
| Fallback/snapshot | sim (`fallbackSafe`) |
| Cache HTTP | no-store |
| Frontend | Index, Alerts (`fetchOneViewHealth`) |
| Testes | `oneview-bff.test.mjs`, `frontend-bff-contract.test.mjs` |

**Exemplo response:**
```json
{
  "status": "ok",
  "database_reachable": true,
  "counts": { "total_alerts": 120, "active_alerts": 18 },
  "capabilities": { "acknowledgement": false },
  "thresholds": { "alert_stale_minutes": 15 },
  "data_source": "database",
  "fallback_code": null,
  "checked_at": "2026-07-30T20:00:00.000Z"
}
```

---

### 4.25 GET `/api/oneview/dashboard-summary`

| Campo | Valor |
|-------|-------|
| Objetivo | Métricas do dashboard NOC |
| Env | Ambos |
| Auth | viewer |
| Tags | operacional \| metrics \| somente leitura |
| Query | `refresh=1` invalida cache in-memory 15s |
| Cache runtime | `withOneViewSummaryCache` (15s); HTTP no-store |
| Escopo teletex | sim |
| Sucesso 200 | `generated_at`, `alerts_total`, `alerts_sample_size`, `active_total`, `resolved_today`, `source_acknowledgements_today`, `oneview_acknowledgements_today`, `operational_day`, `by_severity[]`, `by_status[]`, `by_client[]`, `by_service[]`, `top_hosts[]`, `unacknowledged_total`, `longest_duration[]`, `avg_ack_time_seconds`, `avg_normalization_time_seconds` + envelope |
| Tabelas | `alerts`, `data_sources`, `alert_acknowledgements`, `alert_history` |
| Frontend | Index, Alerts (`fetchAlertMetrics`) |
| Testes | `oneview-v1.test.mjs`, `oneview-bff.test.mjs`, `frontend-bff-contract.test.mjs` |

---

### 4.26 GET `/api/oneview/grafana-summary`

| Campo | Valor |
|-------|-------|
| Objetivo | Resumo compacto (Grafana / legado de integração) |
| Env | Ambos |
| Auth | viewer |
| Tags | operacional \| futuro potencial \| **não utilizado** pelo frontend atual |
| Sucesso 200 | `generated_at`, `total`, `acknowledged`, `unacknowledged`, `average`, `high`, `disaster`, `by_client[]`, `last_updated_at`, `data_sources[]`, `sync_logs[]` |
| Tabelas | `alerts`, `data_sources`, `sync_logs` |
| Frontend | nenhum |
| Testes | coberto indiretamente por matriz de rotas OneView em `oneview-bff.test.mjs` |

---

### 4.27 GET `/api/oneview/alerts`

| Campo | Valor |
|-------|-------|
| Objetivo | Fila operacional de alertas (contrato V1) |
| Env | Ambos |
| Auth | viewer |
| Tags | operacional \| somente leitura |
| Escopo teletex | **obrigatório** (`d.name = teletex-http` / `ONEVIEW_PRIMARY_DATA_SOURCE_NAME`) |
| Query | ver tabela completa na **§16.2** (OV-P0-14B) |
| Sort | `last_seen_at` (def), `first_seen_at`, `resolved_at`, `severity`, `client`, `datasource`, `host`, `problem`, `duration`, `status`, `acknowledged_source` |
| Order | `asc`\|`desc` (def `desc`) |
| Valores query | strings ≤200; multi ≤20 valores (`MAX_FILTER_VALUES`) |
| Sucesso 200 | `{ generated_at, items[], filtered_summary, temporal_counts, pagination, …envelope }` |
| Erros | 400 `invalid_query` (não cai em snapshot); 401/403 auth |
| Tabelas | `alerts`, `data_sources`, `alert_acknowledgements` |
| Funções | `buildAlertListQuery`, `fetchAlertList`, `mapAlertRows` |
| Fallback | sim (snapshot parcial com `snapshot_coverage`) |
| Frontend | Index, Alerts (`fetchAlerts`) |
| Testes | `oneview-v1`, `oneview-teletex-scope`, `frontend-bff-contract`, `oneview-bff` |

Documentação operacional completa (params, nullability, filtros combinados, exemplos): **§16.2**. Exemplos sanitizados também em **§16.8**.

---

### 4.28 GET `/api/oneview/attention-required`

| Campo | Valor |
|-------|-------|
| Objetivo | Fila de atenção (não reconhecidos acima do limiar) |
| Env | Ambos |
| Auth | viewer |
| Tags | operacional \| somente leitura |
| Query | `limit` default 100 max 200 |
| Thresholds env | `ONEVIEW_DISASTER/HIGH/AVERAGE/LOW_UNACK_MINUTES` |
| Escopo teletex | sim |
| Sucesso 200 | `{ summary, thresholds, items[] }` |
| Tabelas | `alerts`, `data_sources` |
| Frontend | Index only (`fetchAttentionRequired`) |
| Testes | `oneview-v1.test.mjs`, `frontend-bff-contract.test.mjs` |

---

### 4.29 GET `/api/oneview/alerts/:id`

| Campo | Valor |
|-------|-------|
| Objetivo | Detalhe enriquecido do alerta |
| Env | Ambos |
| Auth | viewer |
| Tags | operacional \| somente leitura |
| Path/query `id` | UUID-like `[0-9a-f]{8}-[0-9a-f-]{27,36}` |
| Escopo teletex | sim (JOIN `d.name`) |
| Sucesso 200 | `{ generated_at, item: { …alert, history_count, acknowledgement_count, source_ack } }` |
| Erros | 400 id inválido; 404 `not_found` |
| Tabelas | `alerts`, `data_sources`, `alert_history`, `alert_acknowledgements` |
| Frontend | Index, Alerts (`fetchAlert`) |
| Testes | `oneview-v1`, `oneview-teletex-scope`, `frontend-bff-contract` |

---

### 4.30 GET `/api/oneview/alerts/:id/history`

| Campo | Valor |
|-------|-------|
| Objetivo | Histórico consolidado do alerta |
| Env | Ambos |
| Auth | viewer |
| Tags | operacional \| history \| somente leitura |
| Escopo teletex | sim |
| Sucesso 200 | `alert_id`, `items[]`, `total_items`, `source_total_items`, `history_available`, `history_partial`, flags ACK/recovery, `ack_actor_summary` |
| Snapshot | histórico vazio / `history_available: false` |
| Tabelas | `alert_history`, `alert_acknowledgements`, `alerts`, `data_sources` |
| Funções | `consolidateAlertHistoryItems`, `resolveSourceAck` |
| Frontend | Index, Alerts (`fetchAlertHistory`) |
| Testes | `oneview-v1`, `frontend-bff-contract` |

---

### 4.31 POST `/api/oneview/alerts/:id/ack-request`

| Campo | Valor |
|-------|-------|
| Objetivo | Registrar reconhecimento **interno** OneView (não executa ACK Zabbix) |
| Env | Ambos |
| Auth | **operator** (`requireOneViewAuth`) |
| Tags | operacional \| ACK \| escrita controlada |
| Headers | `Idempotency-Key` opcional (`^[a-z0-9][a-z0-9._:-]{7,127}$`); `X-Request-Id`; `X-Correlation-Id` |
| Path `id` | `[a-z0-9][a-z0-9_-]{0,79}` |
| Body | `{ comment: string }` obrigatório, max 500 chars |
| Gates | `ONEVIEW_ACK_REQUEST_ENABLED`; `ONEVIEW_ACK_EXECUTION_ENABLED` deve ser **false** (senão 503); datasource ∈ `ONEVIEW_ACK_ALLOWED_DATASOURCES` |
| Sucesso 202 | `{ request_id, status: "recorded", idempotent, execution_enabled: false, actor_name, message }` |
| Erros | 400 `invalid_alert_id`\|`invalid_comment`\|`invalid_idempotency_key`; 401; 403 `authenticated_actions_disabled`\|`ack_request_disabled`\|`datasource_not_allowed`; 404 `not_found`; 409 `alert_already_recognized`; 503 `ack_execution_not_supported`\|`actions_database_not_configured`\|`database_unavailable`; 405 |
| DB | **Actions pool** (`oneview_actions`): escreve `alert_acknowledgements`, `audit_logs`; lê `alerts`, `data_sources` |
| Cache | HTTP no-store; invalida summary cache |
| Escopo teletex | indireto via allowlist de datasource (não força primary name na query do alerta) |
| Frontend | Alerts (`requestAlertAcknowledgement`) |
| Testes | `oneview-ack-request.test.mjs` |
| Riscos | Se execução for ligada por engano → 503 (seguro); allowlist mal configurada bloqueia operação |

**Exemplo request:**
```http
POST /api/oneview/alerts/<alert-id>/ack-request
Authorization: Bearer <token>
Idempotency-Key: ack-ui-aaaaaaaa
Content-Type: application/json

{ "comment": "Reconhecido pelo NOC" }
```

**Exemplo response:**
```json
{
  "request_id": "<uuid>",
  "status": "recorded",
  "idempotent": false,
  "execution_enabled": false,
  "actor_name": "Operador",
  "message": "Reconhecimento interno registrado no OneView. Nenhuma ação foi enviada ao Zabbix."
}
```

---

### 4.32 GET `/api/oneview/history`

| Campo | Valor |
|-------|-------|
| Objetivo | Histórico global operacional |
| Env | Ambos |
| Auth | viewer |
| Tags | operacional \| history \| somente leitura |
| Query | `page`, `page_size` (max 100), `customer`, `datasource`, `event_type` (`all` ou `operational\|ack\|ack_comment\|resolution\|severity\|maintenance\|update`), `search`, `occurred_from`, `occurred_to` |
| Escopo teletex | sim |
| Exclusões | eventos `internal_acknowledged` / `oneview_internal` |
| Sucesso 200 | `{ generated_at, items[], pagination }` |
| Snapshot | lista vazia paginada |
| Tabelas | `alert_history`, `alerts`, `data_sources` |
| Frontend | Index, Historico (`fetchGlobalHistory`) |
| Testes | `oneview-v1` (OV-P0-10), `frontend-bff-contract` |

---

### 4.33 GET `/api/oneview/operations/health`

| Campo | Valor |
|-------|-------|
| Objetivo | Saúde operacional das fontes / worker |
| Env | Ambos |
| Auth | viewer |
| Tags | operacional \| health \| somente leitura |
| Escopo teletex | sim (fonte primária) |
| Sucesso 200 | `{ status, summary: { total, healthy, warning, error, stale, disabled }, worker, items[] }` |
| Tabelas | `data_sources`, `sync_logs` |
| Frontend | Index, Alerts (`fetchOperationsHealth`) |
| Testes | `oneview-v1`, `frontend-bff-contract` |

---

### 4.34 GET `/api/oneview/clients-summary`

| Campo | Valor |
|-------|-------|
| Objetivo | Facets de clientes/customers/datasources |
| Env | Ambos |
| Auth | viewer |
| Tags | operacional \| somente leitura |
| Escopo teletex | sim |
| Sucesso 200 | `{ generated_at, clients[], customers[], datasources[] }` — frontend tipa como `OneViewFacetsResponse` (`customers`, `datasources`) |
| Tabelas | `alerts`, `data_sources` |
| Frontend | Alerts, Historico (`fetchOneViewFacets`) |
| Testes | `oneview-v1` (`clients-summary separa…`) |

---

### 4.35 GET `/api/oneview/data-sources`

| Campo | Valor |
|-------|-------|
| Objetivo | Cards de fontes (sanitizados, escopo teletex) |
| Env | Ambos |
| Auth | viewer |
| Tags | operacional \| somente leitura |
| Escopo teletex | sim |
| Sucesso 200 | `{ generated_at, items[] }` — sem secrets; `has_token: true` stub; contagens via `v_active_alerts` |
| Tabelas | `data_sources`, `v_active_alerts` |
| Frontend | Alerts, Settings (`fetchDataSourcesWithMeta`) |
| Testes | `oneview-bff`, `frontend-bff-contract` |

---

### 4.36 GET `/api/oneview/sync-logs`

| Campo | Valor |
|-------|-------|
| Objetivo | Últimos logs de sync |
| Env | Ambos |
| Auth | viewer |
| Tags | operacional \| somente leitura |
| Query | `limit` default 20 (API) / UI pede até 20; max 50 |
| Escopo teletex | sim |
| Sucesso 200 | `{ generated_at, items: [{ id, datasource, data_source_id, status, fetched, upserted, detail, created_at }] }` |
| Tabelas | `sync_logs`, `data_sources` |
| Frontend | Index (`fetchSyncLogs`) |
| Testes | indiretos / load contract |

---

### 4.37–4.39 Probes BFF local

| Endpoint | Método | Auth | Objetivo |
|----------|--------|------|----------|
| `/__oneview/load/pool` | GET | `X-OneView-Load-Probe: 1` + user `oneview-load-test` | Stats do pool PG |
| `/__oneview/load/state` | GET | idem | Manifesto pid/code_hash/pool |
| `/__oneview/load/reset` | POST | idem | Incrementa generation / limpa contadores locais |

Tags: **interno**. Env: **somente BFF local** (loopback + origin localhost). Ausentes na Vercel.

---

## 5. Matriz BFF local × Vercel

| Endpoint | BFF local (`8787`) | SSO local (`8000`) | Vercel (`api/**`) |
|----------|--------------------|--------------------|-------------------|
| `/api/oneview/*` (GET listados) | ✅ | ❌ (proxy Vite → 8787) | ✅ |
| POST `/api/oneview/alerts/:id/ack-request` | ✅ | ❌ | ✅ |
| `/__oneview/load/*` | ✅ | ❌ | ❌ |
| `/api/auth/*` | ❌ | ✅ | ✅ |
| `/api/alerts*` | ❌ | ❌ | ✅ |
| `/api/data-sources*` | ❌ | ❌ | ✅ |
| `/api/health*` | ❌ | ❌ | ✅ |
| `/api` | ❌ | ❌ | ✅ |

**Mismatch crítico local:** Settings → `request-sync` e qualquer chamada a notes/assign/status **não funcionam no stack local padrão** (Vite → `/api` → 8000 → 404).

---

## 6. Matriz frontend × endpoint

| Consumidor | Endpoints |
|------------|-----------|
| `src/main.tsx` | `GET /api/auth/config` |
| `src/pages/Index.tsx` | health, dashboard-summary, operations/health, sync-logs, attention-required, alerts, history, alert detail, alert history |
| `src/pages/Alerts.tsx` | health, dashboard-summary, data-sources, clients-summary, operations/health, alerts, alert detail, alert history, **ack-request** |
| `src/pages/Historico.tsx` | clients-summary, history |
| `src/pages/Settings.tsx` | data-sources (oneview), **request-sync** (legado `/api/data-sources/:id/request-sync`) |
| `src/pages/Chamados.tsx` | nenhum |
| SSO / ProtectedRoute | auth me/login/logout/callback (via modo server) |
| `oneview-api.ts` exports sem página | `addAlertNote`, `assignAlert`, `updateAlertStatus` → `/api/alerts/:id/{notes,assign,status}` |
| Nenhum consumidor UI | grafana-summary, `/api/alerts*`, `/api/alerts/metrics`, health legado, `/api`, POST data-sources, PATCH data-sources |

Rotas UI (router): `/` (Index), `/alertas` (Alerts), `/historico`, `/configuracoes` (Settings), `/chamados` (placeholder).

---

## 7. Matriz leitura × escrita

| Endpoint | Lê | Escreve |
|----------|----|---------|
| OneView GETs | `alerts`, `data_sources`, `alert_history`, `alert_acknowledgements`, `sync_logs`, `v_active_alerts` | — |
| POST ack-request | `alerts`, `data_sources` | **actions DB:** `alert_acknowledgements`, `audit_logs` |
| POST notes | `alerts` | `alert_notes`, `alert_history`, `audit_logs` |
| POST assign | `alerts` | `alert_assignments`, `alerts`, `alert_history`, `audit_logs` |
| POST status | `alerts` | `alerts`, `alert_history`, `audit_logs` |
| POST ack (legado) | — | — (bloqueado) |
| POST request-sync | `data_sources` | `integration_outbox`, `audit_logs` |
| PATCH data-sources | `data_sources` | `data_sources`, `audit_logs` |
| POST data-sources | — | — (bloqueado) |
| Health legado | views + outbox | — |
| Auth callback/logout | — | cookie sessão |

Pools:

- **Readonly OneView:** usuário `oneview_vercel_readonly` via `POSTGRES_READONLY_PASSWORD` (`oneview-db.js` / `db.js`).
- **Actions:** usuário `oneview_actions` via `POSTGRES_ACTIONS_PASSWORD` (`oneview-actions-db.js`).

---

## 8. Matriz autenticação/autorização

| Role requerida | Como se obtém | Endpoints |
|----------------|----------------|-----------|
| Nenhuma | — | `/api`, `/api/auth/config`, login, logout, GET callback |
| Sessão válida (sem role) | cookie/Bearer | `/api/auth/me`, POST callback |
| `viewer` | qualquer auth no domínio permitido | todos OneView GET; alerts GET; data-sources GET; health* |
| `operator` | Usuário Entra autenticado e validado | ack-request; notes; assign; status; ack bloqueado; request-sync |
| `admin` | **nunca via SSO atual** | POST data-sources; PATCH data-sources |

Gates adicionais ack-request: `ONEVIEW_ACK_REQUEST_ENABLED`, allowlist datasources, execução desligada.

---

## 9. Tabelas de banco utilizadas

| Tabela / view | Leitura | Escrita |
|---------------|---------|---------|
| `alerts` | OneView + legado + health/db | status, assign |
| `data_sources` | OneView + legado + health | PATCH |
| `alert_history` | OneView history/detail/metrics | notes, assign, status |
| `alert_acknowledgements` | OneView | ack-request (actions) |
| `alert_notes` | — | notes |
| `alert_assignments` | — | assign |
| `audit_logs` | — | writes + ack-request |
| `sync_logs` | OneView sync/ops/grafana | — |
| `integration_outbox` | health | request-sync |
| `v_active_alerts` | data-sources oneview, health/db | — |
| `v_worker_health` | health, health/worker | — |
| `v_datasource_health` | health/worker | — |
| `v_outbox_backlog` | health/outbox | — |

---

## 10. Endpoints legados

Marca **legado** (ainda no código Vercel, fora do contrato V1 preferido):

- Toda família `/api/alerts*` (lista, metrics, detail, ack, assign, notes, status)
- Toda família `/api/data-sources*` (exceto que Settings ainda usa request-sync)
- `/api/health`, `/api/health/db`, `/api/health/worker`, `/api/health/outbox`
- Conceitualmente paralelo: `/api/oneview/grafana-summary` (sem consumidor UI; mantido no BFF)

Motivo: substituídos por `/api/oneview/*` no frontend V1, mas handlers permanecem deployáveis na Vercel.

---

## 11. Endpoints sem consumidor

| Endpoint | Observação |
|----------|------------|
| `GET /api` | sem UI |
| `GET /api/health*` (4) | sem UI |
| `GET /api/alerts`, `/metrics`, `/:id` | UI usa oneview |
| `POST /api/alerts/:id/ack` | bloqueado + sem UI |
| `POST notes/assign/status` | exports client sem página |
| `GET/POST /api/data-sources`, `GET/PATCH /:id` | UI usa oneview GET; PATCH/POST sem UI |
| `GET /api/oneview/grafana-summary` | no BFF, zero frontend |
| Load probes | só scripts de carga |

**Parcialmente consumidos / frágeis:** `POST …/request-sync` (Settings) — sem BFF local.

---

## 12. Lacunas e inconsistências

1. **BFF local ≠ Vercel:** legado alerts/data-sources/health só na Vercel; Settings sync quebra no local.
2. **Dois contratos de alertas:** `/api/alerts` (limit/offset, campos legados) vs `/api/oneview/alerts` (page/page_size, enriquecimento).
3. **Escopo inconsistente:** OneView e alerts legado filtram `teletex-http`; `GET /api/data-sources` legado e request-sync **não**.
4. **ack-request** não aplica `primaryDataSourceName` na SELECT — depende da allowlist env.
5. **Legacy writes** reutilizam pool readonly; risco de falha silenciosa/500 se grants ausentes.
6. **`sanitizeDataSource` legado** ainda devolve `api_url`; OneView sanitiza/redige.
7. **Cache HTTP:** OneView no-store; legado `sendJson` sem Cache-Control.
8. **Role admin** no código sem caminho SSO → PATCH/POST data-sources efetivamente mortos.
9. **Client dead code:** notes/assign/status prontos no TS mas sem UI e sem BFF local.
10. **Vite proxy:** `/api/oneview` tem precedência; demais `/api` vão para SSO — mismatch de expectativa para rotas legadas.
11. **grafana-summary** registrado e testável, sem produto UI.
12. **Dual health:** `/api/oneview/health` + `/api/oneview/operations/health` + `/api/health*` — três camadas.

---

## 13. Riscos de produção

| Risco | Severidade | Notas |
|-------|------------|-------|
| Exposição acidental de rotas legadas com `api_url` | média | GET data-sources legado |
| Writes legados no pool readonly | alta se UI reativar | notes/assign/status/request-sync |
| ACK real Zabbix | mitigado | endpoint bloqueado; ack-request `execution_enabled: false` |
| Snapshot fallback mascarando outage | média | 200 com `data_source: snapshot` |
| Allowlist ack desalinhada de teletex-http | média | 403 `datasource_not_allowed` |
| Operator flag global | média | qualquer autenticado no domínio vira operator |
| Settings request-sync em modo read-only | baixa | client bloqueia; se desbloqueado, depende de Vercel+grants |
| Ausência de testes de integração dos handlers legados | média | regressões silenciosas |

---

## 14. Recomendações

1. Tratar `/api/oneview/*` + `/api/auth/*` como contrato oficial V1; marcar resto como deprecated no deploy.
2. Alinhar BFF local com qualquer endpoint que Settings/UI ainda chame (`request-sync`) ou remover a ação da UI local.
3. Remover ou isolar exports mortos (`addAlertNote` / `assignAlert` / `updateAlertStatus`) até haver produto.
4. Unificar escopo: apply `teletex-http` também em data-sources legado / request-sync, ou documentar multi-fonte conscientemente.
5. Manter ack-request como único caminho de escrita operacional; nunca habilitar `ONEVIEW_ACK_EXECUTION_ENABLED` sem card formal.
6. Adicionar testes de contrato para handlers Vercel-only se permanecerem no deploy.
7. Avaliar remoção ou feature-flag de `/api/oneview/grafana-summary` se não houver consumidor externo.
8. Garantir headers `Cache-Control: no-store` também nas rotas legadas se forem mantidas.

---

## 15. Critérios de aceite do contrato

Este inventário (OV-P0-14) é aceito quando:

- [x] Todos os handlers em `dashboard/api/**/*.js` (exceto `_lib`) estão listados.
- [x] Rotas do `dev-oneview-bff.mjs` e `dev-sso-local.mjs` estão cobertas.
- [x] Matriz BFF local × Vercel documenta mismatches.
- [x] Matriz frontend × endpoint cobre pages + client exports.
- [x] Escopo `teletex-http` e exceções estão explícitos.
- [x] Auth/roles/gates de ack-request documentados.
- [x] Tabelas lidas/escritas e pools separados documentados.
- [x] Endpoints legados e sem consumidor listados.
- [x] Lacunas/riscos/recomendações sem “correção” de código nesta entrega.
- [x] `npm run test:bff` e `npm run build` executados pós-doc (resultados na seção de verificação abaixo).
- [x] `git diff --check` limpo para o artefato criado.

---

## Apêndice A — Arquivos de handler (33)

```
api/index.js
api/health.js
api/health/db.js
api/health/worker.js
api/health/outbox.js
api/auth/config.js
api/auth/me.js
api/auth/logout.js
api/auth/microsoft/login.js
api/auth/microsoft/callback.js
api/alerts/index.js
api/alerts/metrics.js
api/alerts/[id].js
api/alerts/[id]/ack.js
api/alerts/[id]/assign.js
api/alerts/[id]/notes.js
api/alerts/[id]/status.js
api/data-sources/index.js
api/data-sources/[id].js
api/data-sources/[id]/request-sync.js
api/oneview/health.js
api/oneview/dashboard-summary.js
api/oneview/grafana-summary.js
api/oneview/alerts.js
api/oneview/attention-required.js
api/oneview/clients-summary.js
api/oneview/history.js
api/oneview/data-sources.js
api/oneview/sync-logs.js
api/oneview/operations/health.js
api/oneview/alerts/[id].js
api/oneview/alerts/[id]/history.js
api/oneview/alerts/[id]/ack-request.js
```

## Apêndice B — Scripts / testes / package

| Item | Papel |
|------|-------|
| `npm run dev:bff` | `scripts/dev-oneview-bff.mjs` |
| `npm run dev` | `scripts/dev-sso-local.mjs` (+ Vite) |
| `npm run test:bff` | `oneview-bff`, `oneview-v1`, `oneview-ack-request`, `oneview-teletex-scope`, `frontend-bff-contract` |
| `npm run build` | `vite build` (+ `prebuild` snapshot) |
| Snapshot | `src/lib/oneview-real-snapshot.safe.json` |

## 16. Documentação operacional ampliada (OV-P0-14B)

Esta parte **não substitui** o inventário das §§1–15. Amplia autenticação, fluxo de alertas, ACK/Zabbix, histórico, métricas, escritas, matriz de capacidades e exemplos sanitizados, revisados contra o código em 2026-07-31.

Fontes principais: `api/_lib/auth.js`, `microsoft-sso.js`, `session.js`, `oneview-config.js`, `oneview-db.js`, `oneview-ack-request.js`, `oneview-response.js`, `src/lib/oneview-api.ts`, `src/lib/server-auth.ts`.

---

### 16.1 Autenticação e usuários

#### Fluxo local server-side

Stack local obrigatório (dois processos):

1. `npm run dev:bff` → BFF OneView em `8787` (`scripts/dev-oneview-bff.mjs`) — somente `/api/oneview/*`.
2. `npm run dev` → SSO + Vite (`scripts/dev-sso-local.mjs`) — auth em `8000`, UI em `6565`.
3. Proxy Vite: `/api/oneview` → `8787`; demais `/api` → `8000`.

Fluxo SSO (`VITE_AUTH_MODE=server`, ou seja `≠ "msal"`):

1. UI chama `GET /api/auth/microsoft/login?state=…` → `{ authUrl }`.
2. Browser autentica no Microsoft; `GET /api/auth/microsoft/callback` redireciona `302` para `/?code&state` (ou `sso_error`).
3. SPA faz `POST /api/auth/microsoft/callback` com `{ code }` → troca o code, lê Graph `/me`, emite JWT de sessão HMAC e `Set-Cookie`.
4. O browser recebe somente cookie de sessão HttpOnly; nenhum token é retornado, persistido em `localStorage` ou enviado em `Authorization` pelo cliente.
5. BFF/Vercel validam `requireAuth` / `requireOneViewAuth` pela sessão cookie; Bearer Azure só é aceito em integrações server-to-server validadas por JWKS.

#### Endpoints de autenticação

| Endpoint | Auth | Função |
|----------|------|--------|
| `GET /api/auth/config` | pública | Flags de leitura + placeholders MSAL limpos para bootstrap (`main.tsx`) |
| `GET /api/auth/me` | sessão cookie | `{ user }` da sessão atual |
| `GET /api/auth/microsoft/login` | pública | URL de autorização Microsoft |
| `GET /api/auth/microsoft/callback` | pública | Redirect pós-OAuth |
| `POST /api/auth/microsoft/callback` | pública | Troca `code` → `{ user }` + cookie HttpOnly |
| `POST /api/auth/logout` | qualquer | Limpa cookie + retorna logout Entra compatível |

#### Cookie / sessão / Bearer

| Item | Valor atual |
|------|-------------|
| Cookie | `APP_SESSION_COOKIE_NAME` ou default **`oneview_session`** (`session.js`) |
| TTL | `ONEVIEW_SESSION_TTL_HOURS` ou default **12 horas** (`DEFAULT_TTL_SEC`) |
| Segredo | `APP_SESSION_SECRET` / `ONEVIEW_SESSION_SECRET` |
| Cookie | Assinado HMAC, `HttpOnly`, `SameSite=Lax`, `Secure` em produção, `Max-Age` + `exp` |
| Token Bearer | Azure ID token somente para integrações server-to-server; JWT de sessão nunca é aceito via Bearer |
| Identidade | `oid`, `tid`, `sub`, `name`, `preferred_username`, `roles`; `oid` é o ator estável |

#### Validação de origem

- Origens permitidas = `ONEVIEW_ALLOWED_ORIGINS` ∪ `ONEVIEW_PUBLIC_ORIGIN` / `APP_PUBLIC_ORIGIN`.
- Header `Origin` **ausente** → permitido.
- `Origin` presente e fora da allowlist → **403** `origin_not_allowed`.
- BFF local adicional: Origin não-loopback/não-localhost → **403** `local_access_only`.

#### Grupos / roles

| Role | Como se obtém | Uso |
|------|---------------|-----|
| `viewer` | `OneView.Viewer` ou autenticado sem role operacional | Leituras OneView |
| `operator` | Todo usuário Entra autenticado e validado | Mutations permitidas pelo endpoint/gate próprio |
| `admin` | Claim exata `OneView.Admin` no ID token validado | Permissões admin |

Produção usa somente a identidade Entra autenticada. Não há allowlist de e-mail/grupo nem flag geral de actions. `OneView.Admin` é a única elevação atual.

#### Erros de autenticação / autorização

| HTTP | `error` | Quando |
|------|---------|--------|
| 401 | `authentication_required` | Sem sessão cookie válida |
| 401 | `invalid_token` | Azure JWT inválido |
| 403 | `origin_not_allowed` | Origin fora da allowlist |
| 403 | `identity_not_allowed` | Sessão sem `oid` canônico |
| 403 | `operator_required` | Reservado a future gate operacional específico; não é exigido para usuário Entra autenticado atual |
| 403 | — | **Não existe** literal `"forbidden"` no contrato atual; usar os códigos acima |

Outros auth: `missing_code`, `callback_failed`, `microsoft_sso_not_configured`, `method_not_allowed`.

#### Três identidades distintas (não confundir)

| Identidade | O que é | Onde aparece |
|------------|---------|--------------|
| **Usuário autenticado no OneView** | Identidade Entra/Microsoft da sessão (`user` em `/auth/me`) | Auth, gates, `actor_name` do **ack-request interno** |
| **Usuário de ACK do Zabbix** | Operador/usuário da origem sincronizado pelo worker | `acknowledged_source_by`, `acknowledged_by`, `source_ack.actor_name`, eventos `acknowledged` / `ack_message` |
| **Ator interno do worker** | Processo/sistema (`worker_zabbix_sync`, reconciliação, etc.) | `action_source`, eventos técnicos; nomes numéricos/`worker`/`oneview` são **filtrados** por `resolveAckActorName` |

#### Ausência de busca de usuários

**Não existe** endpoint de busca genérica de usuários operacionais (directory, Graph search, listagem de operadores Zabbix ou OneView). A API atual não expõe `/users`, `/operators` nem pesquisa por e-mail/nome. O frontend não deve assumir essa capacidade.

---

### 16.2 Fluxo dos alertas

#### Cadeia de dados

```
Zabbix API → Worker (sync) → Postgres (alerts / alert_history / …)
  → BFF GET /api/oneview/alerts[/:id[/history]] → Frontend (Index / Alerts)
```

Escopo obrigatório: `data_sources.name = ONEVIEW_PRIMARY_DATA_SOURCE_NAME` (default **`teletex-http`**).

#### GET `/api/oneview/alerts` — query params

| Param | Tipo | Default | Notas |
|-------|------|---------|-------|
| `page` | int > 0 | `1` | |
| `page_size` | int 1–100 | `50` | `MAX_ALERT_PAGE_SIZE=100` |
| `client` | multi string | — | ≤20 valores; ≤160 chars |
| `customer` | multi string | — | especial `unclassified` |
| `datasource` | multi string | — | ainda restrito ao escopo primary no JOIN |
| `customer_confidence` | multi enum | — | `high\|medium\|low\|unclassified` |
| `severity` | multi enum | — | `disaster\|critical\|high\|average\|warning\|information\|not_classified` |
| `status` | enum | **`active`** | `active\|resolved\|all` |
| `acknowledged` | `true\|false` | — | ACK origem **ou** interno |
| `acknowledged_source` | `true\|false` | — | só origem Zabbix |
| `acknowledged_internal` | `true\|false` | — | flag legado **ou** linha em `alert_acknowledgements` |
| `search` | string ≤200 | — | ILIKE host/problem/service/customer/datasource |
| `host_search` | string ≤200 | — | ILIKE host |
| `problem_search` | string ≤200 | — | ILIKE problem |
| `date_from` / `date_to` | ISO date/datetime | — | filtram `last_seen_at` |
| `first_seen_from` / `first_seen_to` | ISO | — | `first_seen_at` |
| `last_seen_from` / `last_seen_to` | ISO | — | `last_seen_at` |
| `resolved_from` / `resolved_to` | ISO | — | `resolved_at` |
| `acknowledged_from` / `acknowledged_to` | ISO | — | ACK origem |
| `sort` | enum | **`last_seen_at`** | ver `ALERT_SORTS` |
| `order` | `asc\|desc` | **`desc`** | |

Entrada inválida (enum, range de datas invertido, etc.) → **400** `{ "error": "invalid_query" }` (sem fallback snapshot).

**Exemplo combinado:**

```http
GET /api/oneview/alerts?page=1&page_size=50&status=active&severity=disaster&severity=high&acknowledged_source=false&customer=unclassified&first_seen_from=2026-07-01&sort=severity&order=desc
Authorization: Bearer <session-token>
```

#### Paginação e ordenação

Resposta:

```json
"pagination": {
  "page": 1,
  "page_size": 50,
  "total_items": 120,
  "total_pages": 3,
  "has_next": true,
  "has_previous": false
}
```

Tie-break: após o `sort` principal, o SQL usa `last_seen_at desc` (ou `first_seen_at` quando sort=`severity`) e `a.id desc`. `resolved_at` usa `nulls last`.

Também retorna `filtered_summary` (totais do filtro atual: total/active/ACK/severidades) e `temporal_counts` quando filtros de período estão ativos.

`filtered_summary.by_severity` (OV-P0-39): `{ information, warning, average, high, disaster }`.
- Contagens por severidade persistida real; Warning ≠ Information; Disaster ≠ High.
- `critical` legado entra em `high` **somente** no summary (item continua com `severity: "critical"`).
- `not_classified` fica em `filtered_summary.not_classified` (fora da faixa visual das cinco).
- Zero válido retorna `0`; falha de consulta propaga erro (sem contagens inventadas).
- Campo legado `low` (warning+information+not_classified) removido.

#### Status e severidades

- **active** (`ACTIVE_ALERT_SQL`): `resolved_at` null, `status_source` active, `status_internal` fora de resolved/normalized.
- **resolved** (`RESOLVED_ALERT_SQL`): `resolved_at` set **ou** status source/internal resolved/normalized.
- Severidades canônicas Zabbix (sem tradução PT no contrato).

#### Campos retornados (item) e nullability

Campos principais de `mapAlertRows` (lista/detalhe compartilham o núcleo):

| Campo | Nullability / notas |
|-------|---------------------|
| `id`, `data_source_id`, `datasource_name`, `client_name` | sempre string |
| `customer_name` / `customer_key` | nullable; fallback “Cliente não identificado” / `unclassified` |
| `customer_source`, `customer_confidence` | nullable |
| `enrichment_status`, `enrichment_state` | sempre |
| `host_name` | alias sanitizado (não IP) |
| `host_ip` | **sempre `null`** na API atual |
| `host_visible_name`, `host_technical_name`, `service_name`, `item_*`, `trigger_description`, `operational_data` | nullable |
| `problem_name`, `severity`, `status_source`, `status_internal` | sempre (com defaults) |
| `acknowledged_source`, `acknowledged_internal` | boolean |
| `acknowledged_source_at`, `acknowledged_source_by` | nullable |
| `acknowledged_internal_at/by/comment` | nullable |
| `acknowledged_at` / `acknowledged_by` | agregados (origem preferida); nullable |
| `ack_request_status` | `pending`\|`processing`\|`null` |
| `suppressed`, `suppressed_until`, `maintenance_status` | bool / nullable |
| `first_seen_at`, `last_seen_at`, `started_at`, `created_at`, `updated_at` | ISO; defaults gerados se ausentes |
| `resolved_at`, `source_recovery_event_id` | nullable |
| `duration_seconds` | number (default 0) |

#### Erros e tabelas

| Situação | Código |
|----------|--------|
| Query inválida | 400 `invalid_query` |
| Sem auth | 401 `authentication_required` |
| Domínio/origem/papel | 403 códigos da §16.1 |
| Live DB off / unsafe / timeout | 503 `live_*` / `database_*` / `snapshot_unavailable` |

**Tabelas:** `alerts` JOIN `data_sources`; existência de ACK interno consulta `alert_acknowledgements`.

#### GET `/api/oneview/alerts/:id`

- Path `id` UUID-like; inválido → 400; fora do escopo / inexistente → **404** `not_found`.
- Body: `{ generated_at, item }` onde `item` = alerta + `history_count`, `acknowledgement_count`, **`source_ack`** (ver §16.3).
- Tabelas: `alerts`, `data_sources`, `alert_history`, `alert_acknowledgements`.

#### GET `/api/oneview/alerts/:id/history`

- Histórico consolidado do alerta (UNION `alert_history` + `alert_acknowledgements` como `internal_acknowledged`).
- Campos agregados: `alert_id`, `items[]`, `total_items`, `source_total_items`, `history_available`, `history_partial`, `has_recovery`, `has_ack`, resumo de ACK.
- Snapshot: histórico vazio / `history_available: false`.
- Detalhe de event types: §16.4.

---

### 16.3 ACK e usuários Zabbix

#### Fluxo ponta a ponta

```
Zabbix API (event.acknowledge / problem updates)
  → Worker sync (persiste estado + histórico)
  → alerts.acknowledged_*  +  alert_history (action_type acknowledged / ack_message)
  → BFF resolveSourceAck / mapAlertRows
  → Frontend (drawer / lista) exibe source_ack e flags
```

**Nesta fase o OneView não escreve ACK no Zabbix.**  
`POST /api/alerts/:id/ack` → sempre **403** `real_ack_blocked`.  
`POST /api/oneview/alerts/:id/ack-request` → reconhecimento **interno** OneView (tabela `alert_acknowledgements` + `audit_logs`); `execution_enabled: false`; **não** chama Zabbix.

#### Campos no alerta

| Campo | Significado |
|-------|-------------|
| `acknowledged_source` | boolean — ACK real na origem (Zabbix) |
| `acknowledged_by` | ator agregado (preferência origem); IDs numéricos → `null` |
| `acknowledged_at` | horário agregado (preferência origem) |
| `acknowledged_source_by` / `acknowledged_source_at` | campos explícitos da origem |
| `acknowledged_internal*` | reconhecimento OneView (legado na row +/ou ack-request) |

#### Objeto `source_ack` (`resolveSourceAck`)

```json
{
  "acknowledged": true,
  "actor_name": "Operador Zabbix",
  "acknowledged_at": "2026-07-30T15:10:00.000Z",
  "comment": "Em tratamento",
  "acknowledge_id": "12345",
  "history_available": true
}
```

| Campo | Regra |
|-------|-------|
| `acknowledged` | true se há histórico de ACK origem **ou** flag `acknowledged_source` |
| `actor_name` | precedência: `ack_actor_name` → `actor_name` → `acknowledged_source_by` → `acknowledged_by` via `resolveAckActorName` (rejeita só-dígitos) |
| `acknowledged_at` | `occurred_at` do evento consolidado, senão campos do alerta |
| `comment` | somente de `message`/`description` de eventos `acknowledged` / `ack_message` (sanitizado ≤500); frases genéricas são descartadas |
| `acknowledge_id` | de JSON `acknowledgeid` no histórico; **null** se só há flag |
| `history_available` | `true` se montado a partir de histórico; `false` se só flag de estado |

**Limitações:** sem mensagem persistida → `comment: null` mesmo com ACK true. Sem histórico → `history_available: false`, `acknowledge_id: null`. ACK interno OneView **não** alimenta `source_ack` (filtrado `internal_acknowledged`).

---

### 16.4 Histórico

#### Endpoints

| Endpoint | Escopo |
|----------|--------|
| `GET /api/oneview/history` | Global operacional (página Histórico / Home) |
| `GET /api/oneview/alerts/:id/history` | Timeline de um alerta |

#### `GET /api/oneview/history` — query

| Param | Default / valores |
|-------|-------------------|
| `page` | 1 |
| `page_size` | 50 (max 100) |
| `customer`, `datasource` | multi |
| `event_type` | omit/`all` = todos não ocultos; senão chave de `GLOBAL_HISTORY_EVENT_TYPES` |
| `search` | ILIKE host/problem/message/atores/customer/datasource ≤200 |
| `occurred_from` / `occurred_to` | ISO; range invertido → `invalid_query` |

#### event_type no contrato × action_type no banco

- No banco: coluna **`alert_history.action_type`**.
- No contrato HTTP: campo **`event_type`** (= `action_type` selecionado/mapeado).
- Títulos amigáveis: `HISTORY_TITLES` / `historyTitle()`.

**Grupos `GLOBAL_HISTORY_EVENT_TYPES`:**

| Chave filtro | action_types incluídos |
|--------------|------------------------|
| `operational` | `problem_created`, `created_from_zabbix`, `acknowledged`, `ack_message`, `severity_changed`, `recovered`, `maintenance`, `suppressed`, `unsuppressed` |
| `ack` | `acknowledged` |
| `ack_comment` | `ack_message` |
| `resolution` | `recovered` |
| `severity` | `severity_changed` |
| `maintenance` | `maintenance`, `suppressed`, `unsuppressed` |
| `update` | `problem_seen`, `status_changed`, `reopened`, `problem_created`, `created_from_zabbix` |

**Sempre ocultados no histórico global:**

- `action_type = internal_acknowledged`
- `action_source = oneview_internal`

Legado: `historyIsLegacy` quando `action_source` contém `worker_zabbix_sync` ou tipo ∈ `created_from_zabbix` | `resolved_by_reconciliation`.

#### Conteúdo dos itens

Itens podem expor: comentário (`description`/`comment`), ator (`actor_name` / `ack_actor_name`), severidade anterior/atual (`previous_value` / `current_value`), recuperação (`recovered`), manutenção/supressão (`maintenance`, `suppressed`, `unsuppressed`), `acknowledge_id` (interno à consolidação; pode ser removido do payload final consolidado).

#### Limitações conhecidas

- Snapshot: lista global vazia; histórico por alerta vazio / `history_available: false`.
- Eventos técnicos de reconciliação/upsert/worker podem existir no banco mas são filtrados na UI Home (allowlist) ou no BFF global (exclusões internas).
- Sem mensagem de ACK → comentário null (não inventar).
- Não há busca de usuário; ator só o que veio sincronizado.
- Paginação server-side; UI não deve filtrar página localmente como fonte de verdade.

---

### 16.5 Métricas e saúde

| Endpoint | Consumidor real | Notas |
|----------|-----------------|-------|
| `GET /api/oneview/dashboard-summary` | Index, Alerts | KPIs; `?refresh=1` bust cache 15s; **métricas do banco OneView**, não snapshot live do Zabbix |
| `GET /api/oneview/attention-required` | Index | Filas sem ACK acima dos limiares env |
| `GET /api/oneview/operations/health` | Index, Alerts | Saúde fontes + worker |
| `GET /api/oneview/health` | Index, Alerts | `database_reachable`, `counts`, `capabilities.acknowledgement` |
| `GET /api/oneview/sync-logs` | Index | Últimos syncs (`limit` def 20, max 50) |
| `GET /api/oneview/grafana-summary` | **nenhum** no frontend V1 | Mantido no BFF; futuro/integração |
| `GET /api/alerts/metrics` | **nenhum** | Legado Vercel |
| `GET /api/health*` | **nenhum** | Legado Vercel |

**Diferença crítica (OV-P0-15 / 15B):**

- `active_total` / `counts.active_alerts` / status persistido = **acompanhamento no OneView** (estado reconciliado no banco).
- **Não** rotular como “ativos atuais do Zabbix” enquanto a reconciliação contínua com o snapshot completo não estiver finalizada.
- Contingência `data_source: "snapshot"` ≠ problema live do Zabbix.

---

### 16.6 Escritas (POST / PATCH)

| Endpoint | Finalidade | Auth | Autorização | Tabela alterada | Operacional? | Bloqueado? | Outbox? | Escrita Zabbix? | Legado? | Frontend? |
|----------|------------|------|-------------|-----------------|--------------|------------|---------|-----------------|---------|-----------|
| `POST /api/oneview/alerts/:id/ack-request` | Reconhecimento interno OneView | Bearer/cookie | operator + flags ACK | `alert_acknowledgements`, `audit_logs` (pool actions) | **Sim** (gated) | Não (gates 403/503) | Não | **Não** | Não | Alerts |
| `POST /api/alerts/:id/ack` | ACK real Zabbix | operator | — | — | Não | **Sim** `real_ack_blocked` | Não | Não (bloqueado antes) | Sim | Não |
| `POST /api/alerts/:id/notes` | Nota operacional | operator | operator | `alert_notes`, `alert_history`, `audit_logs` | Código existe (Vercel) | Não hardcoded | Não | Não | Sim | Client only, **sem página** |
| `POST /api/alerts/:id/assign` | Atribuir operador | operator | operator | `alert_assignments`, `alerts`, `alert_history`, `audit_logs` | Código existe | Não | Não | Não | Sim | Client only |
| `POST /api/alerts/:id/status` | Status interno | operator | operator | `alerts`, `alert_history`, `audit_logs` | Código existe | Não | Não | Não | Sim | Client only |
| `POST /api/data-sources/:id/request-sync` | Enfileirar sync | operator | operator | `integration_outbox`, `audit_logs` | Vercel only | Não | **Sim** | Indireto (worker consome outbox) | Sim | Settings |
| `POST /api/data-sources` | Criar fonte | admin | admin | — | Não | **Sim** secret management blocked | Não | Não | Sim | Não |
| `PATCH /api/data-sources/:id` | Metadados fonte | admin | admin | `data_sources`, `audit_logs` | Código existe | Prático (admin inacessível) | Não | Não | Sim | Não |

Gates ack-request: `ONEVIEW_ACK_REQUEST_ENABLED`, `ONEVIEW_ACK_EXECUTION_ENABLED=false`, allowlist `ONEVIEW_ACK_ALLOWED_DATASOURCES`, `POSTGRES_ACTIONS_PASSWORD`.

---

### 16.7 Matriz de capacidades

| Capacidade | Endpoint | Origem | Status | Limitações |
|------------|----------|--------|--------|------------|
| Autenticar usuário | `/api/auth/microsoft/*`, `/me`, `/logout`, `/config` | Entra ID + sessão OneView | Operacional | Domínio/origem obrigatórios; MSAL client opcional no modo server |
| Consultar alertas | `GET /api/oneview/alerts` | Banco (escopo teletex-http) | Operacional | Não é inventário live Zabbix; paginação max 100 |
| Detalhar alerta | `GET /api/oneview/alerts/:id` | Banco + history counts | Operacional | 404 fora do escopo; `host_ip` null |
| Consultar histórico global | `GET /api/oneview/history` | `alert_history` | Operacional | Oculta internos; snapshot vazio |
| Consultar histórico individual | `GET /api/oneview/alerts/:id/history` | `alert_history` ∪ acknowledgements | Operacional | Snapshot parcial/vazio |
| Resolver ator de ACK | campos alerta + `source_ack.actor_name` | Zabbix via worker | Operacional leitura | IDs numéricos → null; sem directory |
| Consultar comentário de ACK | `source_ack.comment` / history | Histórico origem | Operacional leitura | Null se mensagem não persistida |
| Pesquisar usuário | — | — | **Indisponível** | Não há endpoint de busca de usuários |
| Reconhecer alerta | `POST …/ack-request` (interno); `POST …/ack` (Zabbix) | OneView / bloqueado | Interno gated; Zabbix **bloqueado** | Sem escrita Zabbix nesta fase |
| Consultar data sources | `GET /api/oneview/data-sources` | Banco sanitizado | Operacional | Escopo primary; sem secrets |
| Solicitar sincronização | `POST /api/data-sources/:id/request-sync` | Outbox | Legado parcial | Só Vercel; ausente no BFF local; read-only client pode bloquear |
| Consultar saúde | `GET /api/oneview/health`, `operations/health` | Banco/sync | Operacional | Distinto de `/api/health*` legado |
| Consultar ServiceNow | — | — | **Indisponível** | Sem endpoint/contrato atual; `/chamados` é placeholder UI |

---

### 16.8 Exemplos sanitizados

#### Lista de alertas (200)

```http
GET /api/oneview/alerts?page=1&page_size=2&status=active&severity=high
Authorization: Bearer <redacted>
```

```json
{
  "generated_at": "2026-07-31T12:00:00.000Z",
  "items": [
    {
      "id": "a1111111-1111-1111-1111-111111111111",
      "datasource_name": "teletex-http",
      "customer_name": "Cliente Exemplo",
      "host_name": "host-exemplo-01",
      "host_ip": null,
      "problem_name": "High CPU utilization",
      "severity": "high",
      "status_source": "active",
      "acknowledged_source": false,
      "acknowledged_by": null,
      "acknowledged_at": null,
      "first_seen_at": "2026-07-31T11:50:00.000Z",
      "last_seen_at": "2026-07-31T11:55:00.000Z",
      "duration_seconds": 300
    }
  ],
  "filtered_summary": {
    "total": 1,
    "active": 1,
    "resolved": 0,
    "acknowledged_source": 0,
    "unacknowledged_source": 1,
    "by_severity": {
      "information": 0,
      "warning": 0,
      "average": 0,
      "high": 1,
      "disaster": 0
    },
    "not_classified": 0
  },
  "pagination": {
    "page": 1,
    "page_size": 2,
    "total_items": 1,
    "total_pages": 1,
    "has_next": false,
    "has_previous": false
  },
  "data_source": "database",
  "fallback_code": null,
  "checked_at": "2026-07-31T12:00:00.000Z"
}
```

#### Detalhe + source_ack (200)

```json
{
  "generated_at": "2026-07-31T12:01:00.000Z",
  "item": {
    "id": "a1111111-1111-1111-1111-111111111111",
    "problem_name": "High CPU utilization",
    "severity": "high",
    "acknowledged_source": true,
    "acknowledged_source_by": "Operador Origem",
    "acknowledged_source_at": "2026-07-31T11:58:00.000Z",
    "history_count": 4,
    "acknowledgement_count": 1,
    "source_ack": {
      "acknowledged": true,
      "actor_name": "Operador Origem",
      "acknowledged_at": "2026-07-31T11:58:00.000Z",
      "comment": "Em tratamento no NOC",
      "acknowledge_id": "998877",
      "history_available": true
    }
  },
  "data_source": "database",
  "checked_at": "2026-07-31T12:01:00.000Z"
}
```

#### Histórico individual (200)

```json
{
  "alert_id": "a1111111-1111-1111-1111-111111111111",
  "history_available": true,
  "history_partial": false,
  "has_ack": true,
  "has_recovery": false,
  "total_items": 2,
  "source_total_items": 2,
  "items": [
    {
      "event_type": "problem_created",
      "title": "Alerta identificado",
      "occurred_at": "2026-07-31T11:50:00.000Z",
      "actor_name": null,
      "comment": null
    },
    {
      "event_type": "acknowledged",
      "title": "Alerta reconhecido na origem",
      "occurred_at": "2026-07-31T11:58:00.000Z",
      "actor_name": "Operador Origem",
      "comment": "Em tratamento no NOC"
    }
  ],
  "data_source": "database",
  "checked_at": "2026-07-31T12:02:00.000Z"
}
```

#### Health (200)

```json
{
  "status": "ok",
  "database_reachable": true,
  "counts": { "total_alerts": 1200, "active_alerts": 42 },
  "capabilities": { "acknowledgement": false },
  "thresholds": { "alert_stale_minutes": 15 },
  "data_source": "database",
  "fallback_code": null,
  "checked_at": "2026-07-31T12:03:00.000Z"
}
```

#### Erro 401

```json
{ "error": "authentication_required" }
```

#### Erro 403 (domínio)

```json
{ "error": "domain_not_allowed" }
```

Outros 403 comuns: `origin_not_allowed`, `operator_required`, `email_not_allowed`, `ack_request_disabled`, `real_ack_blocked`. **Não** usar o literal `"forbidden"`.

#### Erro 404

```json
{ "error": "not_found" }
```

(Alertas legado usam `alert_not_found` em alguns handlers `/api/alerts/:id`.)

---

## Apêndice C — Verificação pós-documentação

Executado em 2026-07-31 a partir de `dashboard/` após OV-P0-14B (somente `docs/API_CURRENT_CONTRACT.md` alterado).

| Comando | Resultado |
|---------|-----------|
| `npm run test:bff` | **PASS** — 185 tests, 0 fail (`duration_ms` ~658) |
| `npm run build` | **PASS** — `vite build` OK (~17s). Warning não bloqueante: chunks >500kB; browserslist desatualizado. `prebuild` regenerou snapshot seguro (artefato de build; fora do escopo documental). |
| `git diff --check` | **PASS** — sem erros de whitespace |

**Confirmações OV-P0-14B:**

- Único artefato alterado nesta entrega: `dashboard/docs/API_CURRENT_CONTRACT.md`
- Inventário inicial de **39 endpoints** preservado (§3)
- Seções operacionais §16.1–§16.8 adicionadas (auth, alertas, ACK, histórico, métricas, escritas, capacidades, exemplos)
- Nenhum handler/API/frontend produtivo editado
- Nenhum commit, deploy, alteração de banco ou worker

---

*Fim do inventário OV-P0-14 + revisão operacional OV-P0-14B — API_CURRENT_CONTRACT.*
