# CURRENT_STATE_AUDIT — OneView (Teletex)

**Data:** 2026-07-29  
**Tipo:** somente leitura  
**Escopo:** Teletex · telas `/`, `/alertas`, `/historico`  
**Restrições respeitadas:** sem alteração de código de produto, commit, deploy, env, banco ou produção; sem Castrolanda/Zurich/Fraport; sem escrita Zabbix; sem dados fictícios.

**Contextos lidos:**
- `.cursor/context/00_MASTER_CONTEXT.md` — único arquivo em `.cursor/context`
- `.cursor/rules` — **pasta inexistente / sem arquivos**

**Único artefato gerado por esta auditoria:** este documento (`dashboard/docs/CURRENT_STATE_AUDIT.md`).

---

## 1. Estado atual

OneView V1 é um dashboard React (Vite + TypeScript) com BFF serverless em `dashboard/api/oneview/*`, leitura PostgreSQL via `oneview-db.js` (role readonly) e fallback para snapshot seguro.

### Resultado de lint / testes / build (executados nesta auditoria)

| Comando | Resultado |
|---|---|
| `npm run lint` | **Falhou** — 53 errors, 11 warnings (maioria em Workspaces/Webex/Certificados/UI shadcn; V1 tem warning de deps em `Index.tsx`) |
| `npm run test:bff` | **Passou** — 169/169 |
| `npm run build` | **Passou** — snapshot gerado + Vite build ~21s |

### Achado central

**Não existe filtro Teletex-only global no BFF.** Home, métricas, alertas e histórico listam/agregam **todas as fontes** do banco, salvo filtro manual do usuário. O único enforcement Teletex é o **gate de ACK interno** (`teletex-http`).

Auth corporativo (domínio Teletex + tenant Microsoft) **não** restringe dados por cliente.

---

## 2. Estrutura das três telas principais

### Rotas confirmadas (`src/App.tsx`)

| Rota | Página | Arquivo |
|---|---|---|
| `/` | Home operacional | `src/pages/Index.tsx` |
| `/alertas` | Lista + drawer | `src/pages/Alerts.tsx` |
| `/historico` | Histórico global | `src/pages/Historico.tsx` |

Auth: `/login`, `/sso/callback`, `/auth/microsoft/callback`.  
Outras rotas protegidas (fora do foco V1): `/banco-dados`, `/certificados`, `/chamados`, `/workspaces`, `/config`.

### Sidebar (`src/components/layout/Sidebar.tsx`)

Links V1: Alertas `/alertas`, Histórico `/historico`.  
**Redirects/links mortos:** `/kpis`, `/relatorios` — **não existem** em `App.tsx` → `NotFound`.

### Home `/` (`Index.tsx`)

Blocos observados no código:

1. KPIs / resumo (via `fetchAlertMetrics` / dashboard-summary)
2. Alertas prioritários (Disaster/High, sem ACK primeiro)
3. Alertas recentes
4. Atenção necessária (`fetchAttentionRequired`) + sheet lateral por bucket
5. Clientes mais impactados
6. Saúde / sync (`fetchOperationsHealth`, `fetchSyncLogs`) no topbar/contexto
7. Card estático **ServiceNow** (“em preparação”)
8. Drawer de detalhe do alerta (Sheet direita) com abas Resumo/Histórico

Filtro de cliente: state local `selectedClient` (default `"all"`). **Sem filtro datasource default.**  
`enableAutoRefresh={false}` no layout; timers próprios para summary/listas.

### Alertas `/alertas` (`Alerts.tsx`)

- Views: Recentes, Em aberto, Prioritários, Resolvidos, Todos
- Filtros server-side via query string: cliente, fonte (`datasource`), severidade, status, ACK origem, host, problema, períodos, sort
- Tabela + drawer (`Sheet`) com `?alert=` na URL
- ACK interno (dialog + comentário) só se `datasource_name === "teletex-http"` e flags de capability
- Timeline no drawer filtra fora `internal_acknowledged` / origem `oneview_internal`
- Auto-refresh por intervalos; filtros e drawer sobrevivem a F5 via URL

### Histórico `/historico` (`Historico.tsx`)

- Lista global via `fetchGlobalHistory`
- Filtros: cliente, fonte, tipo de evento, período, busca — **state local** (F5 perde)
- `enableAutoRefresh={false}`
- Facets via `fetchOneViewFacets`
- Empty state orienta ajustar filtros; aponta drawer de Alertas para histórico individual

---

## 3. Identificador real de Teletex encontrado no código

| Valor | Presente? | Uso |
|---|---|---|
| `teletex-http` | **Sim** | Candidato canônico da **fonte** (`data_sources.name`). ACK UI hardcoded; `ONEVIEW_ACK_ALLOWED_DATASOURCES` default nos exemplos/testes |
| `http-teletex` | **Não** | Zero ocorrências no `dashboard/` |
| `teletex` | **Sim** | Alias visual de logo; `clientId` em `mock-data.ts`; texto “Teletex” em mocks |
| `Teletex` (display) | **Sim** | Labels de mock / nomes amigáveis — **não** é o filtro BFF de datasource |

### Outros “Teletex” (não são data source de alerta)

- Domínios de e-mail: `teletex.com.br`, `teletex.com`
- Hosts: `devops.teletex.com.br`, `noc.teletex.com.br`, etc.
- Tenant Microsoft default em `api/auth/config.js`
- Host DB exemplo: `bancos.teletexdev.com.br`

### Ainda desconhecido (banco — OV-P0-01)

UUID `data_sources.id`, `client_name` real, `sync_enabled`, último sucesso/erro.  
**Não inventado nesta auditoria.**

---

## 4. Endpoints usados

### BFF OneView (`/api/oneview/*`)

| Endpoint | Handler | Consumo V1 |
|---|---|---|
| `GET .../health` | `api/oneview/health.js` | Alertas (capability ACK) |
| `GET .../dashboard-summary` | `dashboard-summary.js` | Home métricas (`fetchAlertMetrics`) |
| `GET .../grafana-summary` | `grafana-summary.js` | Existente; não é eixo das 3 telas V1 |
| `GET .../alerts` | `alerts.js` | Home listas + Alertas |
| `GET .../attention-required` | `attention-required.js` | Home |
| `GET .../alerts/:id` | `alerts/[id].js` | Drawer Home/Alertas |
| `GET .../alerts/:id/history` | `alerts/[id]/history.js` | Drawer |
| `POST .../alerts/:id/ack-request` | `ack-request.js` | Alertas (ACK interno) |
| `GET .../history` | `history.js` | Histórico |
| `GET .../clients-summary` | `clients-summary.js` | Facets / clientes |
| `GET .../data-sources` | `data-sources.js` | Facets fontes |
| `GET .../operations/health` | `operations/health.js` | Home saúde |
| `GET .../sync-logs` | `sync-logs.js` | Home sync |

Cliente HTTP: `src/lib/oneview-api.ts`.

### API legada (paralela)

`api/alerts/*`, `api/data-sources/*`, `api/health*` — fora do contrato `/api/oneview/*`. Risco se ainda forem chamadas (notas/status legacy em modo read-only falham cedo na UI).

---

## 5. Fluxo de dados

```text
Zabbix → Worker VM → PostgreSQL (alerts, alert_history, data_sources, sync_*)
                         ↓
                   PgBouncer :6432
                         ↓
              Vercel BFF /api/oneview/*
                         ↓
         oneview-api.ts → Index | Alerts | Historico
```

### Como filtram fonte hoje

| Camada | Comportamento |
|---|---|
| BFF `buildAlertListQuery` | `datasource` opcional → `d.name = any(...)` |
| BFF histórico global | `datasource` opcional → mesmo padrão |
| BFF summary / attention / clients / ops / sync / health counts | **Sem filtro datasource default** |
| Home | Filtro **customer** opcional; **não** manda datasource |
| Alertas | `selectedDatasources[]` na URL; default **vazio = todas** |
| Histórico | `fonte` default `"all"` |
| ACK | Só permite `teletex-http` (UI + env BFF) |

### ACK / usuário / data-hora / comentário / recovery / history

```text
UI Alerts.submitAckRequest(comment)
  → POST /api/oneview/alerts/:id/ack-request
  → oneview-ack-request.js
       • actor = sessão SSO (nome/email)
       • comment obrigatório (max 500)
       • gate datasource ∈ ONEVIEW_ACK_ALLOWED_DATASOURCES
       • INSERT alert_acknowledgements (internal, recorded)
       • INSERT audit_logs
       • 202 + request_id (sem chamar Zabbix)
```

**ACK na origem (Zabbix):** somente leitura via campos `acknowledged_source*` e eventos `acknowledged` / `ack_message` em `alert_history`.  
**Recovery:** evento `recovered` (+ legado `resolved_by_reconciliation`); flags `has_recovery` no payload de histórico.  
**Timeline por alerta:** `fetchAlertHistoryPayload` em `oneview-db.js` + consolidação de ACKs.

---

## 6. Mocks e problemas encontrados

### Mocks / estáticos

| Artefato | Uso |
|---|---|
| `src/lib/mock-data.ts` | Chamados, Certificados, BancoDados, Workspaces |
| `src/lib/demo-oneview-data.ts` | Demo snapshot — **não importado** pelas páginas V1 live |
| `demo-mode.ts` | `isDemoMode` / `isReadOnlyMode` (flags) |
| Snapshot `oneview-real-snapshot.safe.json` | Gerado em prebuild; fallback BFF |
| Card ServiceNow na Home | Texto estático |

### Problemas

1. **Vazamento multi-cliente** em Home/Alertas/Histórico/KPIs sem filtro Teletex.
2. Identificador ACK hardcoded na UI vs env no BFF (duplicação).
3. Histórico/Home: filtros não persistem em F5; Alertas sim.
4. Drawer Home não usa `?alert=` (fecha no reload).
5. Sidebar `/kpis` e `/relatorios` → 404.
6. API legacy paralela.
7. Snapshot: histórico global vazio no fallback.
8. Três eixos de filtro (`client` / `customer` / `datasource`) fáceis de confundir.
9. `dashboard copy/` e `Index copy.tsx` — duplicação/código morto.
10. Lint vermelho no repo (telas fora V1).
11. Indicadores Home agregam **todas** as fontes — não são “fictícios”, mas **não são Teletex-only**.

### Código morto / duplicado (amostra)

- `src/pages/Index copy.tsx`
- Pasta `dashboard copy/` na raiz do monorepo Vercel
- `AlertItem` / `AlertsList` / `GenericFilters` — pouco ou nada usados pelas páginas V1 atuais (V1 implementa UI inline em `Alerts.tsx` / `Index.tsx`)
- `webex-api.ts` — legado Webex

---

## 7. Lacunas da Home

Em relação ao alvo OV-P0-09:

| Esperado | Situação |
|---|---|
| Resumo só Teletex | KPIs globais — **falta escopo** |
| Atenção necessária Teletex | Fila global — **falta escopo** |
| Prioritários curtos clicáveis | Existe lista Disaster/High; ainda multi-fonte |
| Eventos recentes limpos | Existe bloco recentes; misturado com outras fontes |
| Saúde (banco/PgBouncer/worker/Teletex/última coleta) | Ops health + sync logs existem; **não isolam Teletex**; PgBouncer não é métrica dedicada na UI |
| ServiceNow preparação | Card estático OK |
| Sem números fictícios | Dados vêm do BFF/DB ou snapshot real sanitizado |
| Ordem/layout “resumo → atenção → prioritários → eventos → saúde” | Parcialmente presente; “Clientes mais impactados” ainda multi-cliente |

---

## 8. Lacunas de Alertas

Em relação a OV-P0-10 / 11:

| Esperado | Situação |
|---|---|
| Views Recentes/Em aberto/Prioritários/Resolvidos/Todos | **Presentes** |
| Filtros Severidade/ACK/Host/Status/Período | **Presentes** (mais ricos que o mínimo) |
| Coluna Chamado | **Ausente** (ServiceNow futuro) |
| Escopo Teletex default | **Ausente** |
| Drawer completo (grupos/tags/recovery/ACK/comentário/histório) | **Em grande parte presente** |
| Drawer não fechar no auto-refresh | Alertas: preserva via `?alert=` + reload detalhe; Home: mais frágil |
| ACK + comentário | Interno OK para `teletex-http`; origem só leitura |

---

## 9. Lacunas do Histórico

Em relação a OV-P0-12:

| Esperado | Situação |
|---|---|
| Timeline só: identificado, severidade, ACK, comentário, recovery | Parcial — UI/BFF ainda expõem maintenance/update/supressão/reopened/status etc. |
| Esconder técnicos (IDs, JSON, upsert, backfill, outbox, retry…) | Drawer já oculta `internal_acknowledged`; histórico global exclui internos; **ainda podem aparecer eventos técnicos/legado** conforme `action_type` no banco |
| Persistência de filtros | **Não** (state local) |
| Escopo Teletex default | **Não** |
| ServiceNow na timeline | Só futuro / não implementado |

### Tipos de evento conhecidos no BFF (`HISTORY_TITLES` / global)

**Operacionais / desejáveis na V1:**  
`problem_created` (+ legado `created_from_zabbix`), `severity_changed`, `acknowledged`, `ack_message`, `recovered` (+ `resolved_by_reconciliation`)

**Presentes mas candidatos a “técnicos / secundários” na timeline principal:**  
`problem_seen`, `status_changed`, `reopened`, `suppressed`, `unsuppressed`, `maintenance`, `internal_acknowledged` (já oculto na UI V1), títulos genéricos “Atualização do alerta”

---

## 10. Situação do ACK e comentário

| Aspecto | Status |
|---|---|
| ACK origem Zabbix | Leitura; ator nominal; comentário via history quando existir |
| ACK interno OneView | POST `ack-request`; comentário **obrigatório**; sem escrita Zabbix |
| Usuário | Nome/e-mail da sessão SSO |
| Data/hora | `occurred_at` / campos source; resposta 202 com metadados |
| Idempotência | Coberta por testes |
| Gate fonte | `teletex-http` |
| Flags | `ONEVIEW_ACK_REQUEST_ENABLED`, `ONEVIEW_ALLOW_ALL_AUTHENTICATED_ACTIONS`, execução Zabbix **desligada** |
| Exibição na timeline V1 | Interno oculto; origem visível |

Comentário de ACK na origem: tratado como problema conhecido na matriz Zabbix (P0-13) — UI não inventa comentário (`resolveSourceAck`).

---

## 11. Situação do ServiceNow

- **Sem** cliente API, env, tabela ou endpoint ServiceNow no dashboard
- Única UI: card na Home — “Integração ServiceNow em preparação.”
- Contrato de teste frontend exige a presença desse texto
- Coluna “Chamado” / ticket no drawer: não integrada

---

## 12. Arquivos que precisarão ser alterados

*(planejamento — **não alterados** nesta auditoria)*

### OV-P0-02 (escopo Teletex) — obrigatório

- `api/_lib/oneview-config.js`
- `api/_lib/oneview-db.js`
- `api/_lib/oneview-fallback.js`
- `.env.example` / `dashboard/.env.local.example`
- `src/lib/oneview-api.ts` (se default client-side; preferível só BFF)
- `src/pages/Index.tsx`, `Alerts.tsx`, `Historico.tsx`
- Testes: `tests/oneview-v1.test.mjs`, `oneview-bff.test.mjs`, `frontend-bff-contract.test.mjs`

### OV-P0-09…12 (UI)

- `Index.tsx`, `Alerts.tsx`, `Historico.tsx`
- Possivelmente `oneview-db.js` (filtro/mapeamento de event_types da timeline)
- `Sidebar.tsx` (links mortos)

### Limpeza posterior

- `Index copy.tsx`, `dashboard copy/`, legacy `api/alerts/*` se ainda expostos

---

## 13. Contratos que poderão ser impactados

| Contrato | Impacto esperado |
|---|---|
| `GET /api/oneview/dashboard-summary` | Contagens só Teletex |
| `GET /api/oneview/alerts` | Default scope; paginação recalculada |
| `GET /api/oneview/attention-required` | Itens só Teletex |
| `GET /api/oneview/history` | Default scope |
| `GET /api/oneview/clients-summary` / `data-sources` / `sync-logs` / `operations/health` / `health` | Facets e saúde scoped |
| `GET /api/oneview/alerts/:id` (+ history) | 404 fora do escopo |
| Query `datasource=` | Allowlist / bloqueio de bypass |
| Headers `X-OneView-Data-Source` | Possível meta de escopo |
| Snapshot fallback | Mesmo filtro |
| Testes de contrato frontend | Asserts de agregação global vs Teletex |

---

## 14. Testes existentes

| Arquivo | Foco |
|---|---|
| `tests/frontend-bff-contract.test.mjs` | Contrato estático Index/Alerts/Historico/App/Sidebar ↔ BFF |
| `tests/oneview-v1.test.mjs` | SQL filters, paginação, attention, history/ACK, snapshot, clients |
| `tests/oneview-bff.test.mjs` | Auth, snapshot/live, cache, sanitização, pool readonly |
| `tests/oneview-ack-request.test.mjs` | POST ack, idempotência, gate datasource, audit |

**Resultado nesta corrida:** 169 passed, 0 failed.

Scripts: `test:bff`, `test:local-live`, `test:load-local`, `lint:demo`, `test:demo`.

---

## 15. Riscos

| Risco | Severidade |
|---|---|
| Operador vê alertas/KPIs de outros clientes | **Alta** |
| Confundir `teletex` (logo/mock) com `teletex-http` (fonte) | **Alta** |
| Bypass `?datasource=outra` após default UI | **Média** |
| Snapshot multi-cliente no fallback | **Média** |
| API legacy `/api/alerts/*` | **Média** |
| Lint quebrado atrapalha CI se lint for gate | **Média** |
| Drawer Home perde contexto no refresh | **Baixa/Média** |
| Eventos técnicos ainda na timeline | **Média** (UX apresentação) |

---

## 16. Plano incremental recomendado

1. **OV-P0-01** — Confirmar no PostgreSQL `data_sources` (nome, id, client_name, sync_*). Só leitura.
2. **OV-P0-05/06** — Auditar timers/worker e `sync_logs` (VM), sem mudar timer.
3. **OV-P0-02** — Enforcement server-side `ONEVIEW_SCOPE_DATASOURCES` (provável `teletex-http`) em **todas** as queries agregadoras + detail; espelhar no snapshot; testes de não-vazamento.
4. **OV-P0-04** — Validar ponta a ponta amostras reais Teletex.
5. **OV-P0-07/08** — Medir e revisar PgBouncer (sem colar secrets).
6. **OV-P0-09** — Reorganizar Home no escopo Teletex.
7. **OV-P0-10/11** — Ajustes Alertas/Drawer (chamado placeholder, refresh).
8. **OV-P0-12** — Whitelist de event_types na timeline principal + “Detalhes técnicos”.
9. **OV-P0-13** — Matriz Zabbix API (doc).
10. **OV-P0-14/15** — Smoke ×3 + evidências; validar Vercel.

### Prompt de continuidade sugerido

> Com base em `@dashboard/docs/CURRENT_STATE_AUDIT.md` e no resultado de OV-P0-01, implementar somente OV-P0-02 no BFF (sem UI cosmética), com testes de não-vazamento. Não tocar Castrolanda/Zurich/Fraport. Não escrever no Zabbix.

---

## Anexo A — Mapa rápido de inventário

### Páginas

`Index`, `Alerts`, `Historico`, `Login`, `SsoCallback`, `Settings`, `BancoDados`, `Certificados`, `Chamados`, `Workspaces`, `NotFound`, `Index copy`

### Hooks

`useAuth`, `use-toast`, `use-mobile` — **sem** hook dedicado de filtros/datasource

### Tipos principais

- OneView: interfaces em `oneview-api.ts` (`OneViewAlert`, `AlertHistoryItem`, `GlobalHistoryItem`, …)
- Legado UI: `src/types/index.ts`

### Componentes V1 relevantes

Layout: `AppLayout`, `Sidebar`, `Topbar`  
UI drawer: `Sheet`  
Badges: `SeverityBadge`  
 demos: páginas mock usam `TicketsTable`, `Certificados*`, `Workspace*`

---

## Anexo B — Contextos Cursor

| Caminho | Situação |
|---|---|
| `.cursor/context/00_MASTER_CONTEXT.md` | Presente — aponta docs destilados + esta auditoria |
| `.cursor/rules/` | **Ausente** — nenhuma rule versionada ainda |
| `DOCS/01`…`08` | Base destilada da conversa ChatGPT (fora deste arquivo) |

---

*Fim da auditoria somente leitura. Nenhum arquivo de produto foi modificado além da atualização deste documento.*
