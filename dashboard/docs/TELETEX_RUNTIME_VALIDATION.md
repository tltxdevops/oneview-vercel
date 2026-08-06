# TELETEX_RUNTIME_VALIDATION — OV-P0-04

**Data:** 2026-07-29  
**Tipo:** validação runtime (somente leitura de produto)  
**Escopo:** enforcement Teletex (`teletex-http`) pós OV-P0-02 / OV-P0-03  
**Artefato único gerado:** este arquivo  
**Restrições respeitadas:** sem alteração de código produtivo, banco, worker, Vercel, commit ou deploy; sem impressão de secrets; sem criação de mocks; sem correções.

---

## 1. Comandos executados

| Comando | Finalidade |
|---|---|
| Leitura de `package.json`, `.env.local.example`, `scripts/dev-oneview-bff.mjs`, `scripts/dev-sso-local.mjs`, `scripts/check-oneview-local-live.mjs` | Mapear forma correta de subir local |
| Listagem **somente dos nomes de chaves** em `dashboard/.env.local` | Confirmar presença de config sem ler valores secretos |
| `npm run dev:bff` | BFF local em `http://127.0.0.1:8787` |
| `npm run dev:vite` | Frontend Vite em `http://localhost:6565/` |
| Script efêmero Node (sessão controlada via `createSessionToken`, sem imprimir token) | Validar endpoints OneView contra o BFF vivo |
| `npm run test:bff` | Suite de contrato/BFF (176 testes) |
| `npm run build` | Build de produção |
| `npx eslint` nos arquivos alterados por OV-P0-02/03 | Lint dos arquivos de código tocados |
| `git diff --check` | Espaços/conflict markers no working tree |

Forma correta identificada no `package.json`:

| Papel | Script | Observação |
|---|---|---|
| Frontend | `npm run dev:vite` (ou `npm run dev` = SSO + Vite) | Porta `VITE_DEV_SERVER_PORT` (local: **6565**) |
| BFF/API OneView | `npm run dev:bff` | Porta `ONEVIEW_LOCAL_BFF_PORT` (**8787**); carrega `.env.local` |
| Testes | `npm run test:bff` | Unit/contract sem precisar do BFF vivo |
| Smoke live opcional | `npm run test:local-live` | Requer BFF + sessão controlada |

Contratos V1 do frontend usam **`/api/oneview/*`**, não `/api/alerts`. Os legados `dashboard/api/alerts/*` existem para Vercel, mas **não estão montados** no BFF local (`dev-oneview-bff.mjs`).

---

## 2. Ambiente utilizado

| Item | Valor observado |
|---|---|
| Host BFF | `127.0.0.1:8787` |
| Host Vite | `localhost:6565` |
| `ONEVIEW_LIVE_DB_ENABLED` | `true` |
| `ONEVIEW_SNAPSHOT_MODE` | `false` |
| `ONEVIEW_SNAPSHOT_FALLBACK_ENABLED` | `true` |
| `ONEVIEW_PRIMARY_DATA_SOURCE_NAME` no `.env.local` | **ausente** → default de código `teletex-http` (`oneview-scope.js`) |
| Auth nas chamadas | sessão efêmera controlada (domínio permitido); token **não** impresso |
| Fonte das respostas validadas | header/`body.data_source` = **`database`** |
| BFF ready | `missing_config_keys: []`, `live_db_enabled: true`, `auth_required: true` |

Secrets (senhas, client secret, session secret, tokens) **não** foram impressos neste relatório.

---

## 3. Endpoints validados

### OneView (BFF local — runtime)

- `GET /api/oneview/alerts`
- `GET /api/oneview/alerts/[id]`
- `GET /api/oneview/alerts/[id]/history`
- `GET /api/oneview/dashboard-summary` (métricas Home)
- `GET /api/oneview/grafana-summary`
- `GET /api/oneview/attention-required`
- `GET /api/oneview/clients-summary`
- `GET /api/oneview/history`
- `GET /api/oneview/data-sources`
- `GET /api/oneview/sync-logs`
- `GET /api/oneview/operations/health`
- `GET /api/oneview/health`

### Legados pedidos no card (não montados no BFF local)

- `GET /api/alerts` → **404** no BFF local
- `GET /api/alerts/metrics` → **404** no BFF local  
  Escopo Teletex desses legados foi coberto por testes unitários OV-P0-02 (`oneview-teletex-scope.test.mjs`), não por HTTP local.

---

## 4. Resultado de cada endpoint

| Endpoint | HTTP | Fonte | Resultado Teletex-scope |
|---|---|---|---|
| `/api/oneview/alerts?page=1&page_size=5&status=active` | 200 | database | OK — só `teletex-http`; 5 itens; `total_items=23026` |
| `/api/oneview/alerts?page=2&page_size=5&status=active` | 200 | database | OK — página distinta da 1 |
| `/api/oneview/alerts?...&severity=disaster` | 200 | database | OK — interseção; 3 itens, todos `teletex-http` |
| `/api/oneview/alerts?...&datasource=zurich` | 200 | database | OK escape bloqueado — `total_items=0` |
| `/api/oneview/alerts?...&datasource=castrolanda` | 200 | database | OK escape bloqueado — `total_items=0` |
| `/api/oneview/alerts?...&datasource=fraport` | 200 | database | OK escape bloqueado — `total_items=0` |
| `/api/oneview/dashboard-summary` | 200 | database | OK fonte; ver §5/§13 sobre label de cliente |
| `/api/oneview/grafana-summary` | 200 | database | OK fonte; mesmo achado de label |
| `/api/oneview/attention-required?limit=20` | 200 | database | OK — itens `teletex-http` |
| `/api/oneview/clients-summary` | 200 | database | OK fonte; customers incluem label `castrolanda` |
| `/api/oneview/history?page=1&page_size=10` | 200 | database | OK — só `teletex-http`; `total_items=112693` |
| `/api/oneview/history?...&datasource=zurich` | 200 | database | OK escape — `total_items=0` |
| `/api/oneview/data-sources` | 200 | database | OK — **somente** `["teletex-http"]` |
| `/api/oneview/sync-logs` | 200 | database | OK — logs com `data_source_id` único Teletex |
| `/api/oneview/operations/health` | 200 | database | OK — `items=[{name:"teletex-http"}]`; `worker.status=healthy` |
| `/api/oneview/health` | 200 | database | OK — `database_reachable`; counts Teletex (`total=62273`, `active=23026`) |
| detalhe alerta Teletex | 200 | database | OK |
| histórico alerta Teletex | 200 | database | OK |
| detalhe alerta Zurich (snapshot ID) | **404** `not_found` | database | OK |
| histórico alerta Zurich | **404** `not_found` | database | OK |
| `/api/alerts` (legado) | 404 | — | Não servido pelo BFF local |
| `/api/alerts/metrics` (legado) | 404 | — | Não servido pelo BFF local |

---

## 5. Evidência de que somente Teletex é retornado (fonte)

- Em listagens de alertas e histórico, todo `datasource_name` observado = **`teletex-http`**.
- `GET /api/oneview/data-sources` → `source_names: ["teletex-http"]` (1 item).
- `GET /api/oneview/operations/health` → único item de fonte = `teletex-http`.
- Tentativas `datasource=zurich|castrolanda|fraport` → listas vazias (não vazam outra fonte).
- Zurich/Fraport **não** apareceram como `datasource_name` em nenhuma resposta validada.

**Nuance (não é vazamento de data source):** a string `castrolanda` aparece como **`customer_name` / `client_name` / `customers[].key`** em agregações da fonte `teletex-http` (ex.: 356 alertas ativos classificados com esse cliente). Isso é enriquecimento de cliente **dentro** do Zabbix Teletex, não retorno da fonte Castrolanda.

---

## 6. Teste de tentativa de escape do escopo

| Tentativa | Resultado |
|---|---|
| `datasource=zurich` em alerts | 200, `total_items=0`, sem itens Zurich |
| `datasource=castrolanda` em alerts | 200, `total_items=0` |
| `datasource=fraport` em alerts | 200, `total_items=0` |
| `datasource=zurich` em history | 200, `total_items=0` |
| `customer=castrolanda` em alerts | 200, 356 itens, **todos** `datasource_name=teletex-http` (filtro de cliente ∩ escopo) |
| Detalhe ID Zurich do snapshot | 404 |
| Histórico ID Zurich do snapshot | 404 |

Conclusão: filtro adicional de datasource **não escapa** o escopo obrigatório; funciona como interseção (escopo ∩ filtros).

---

## 7. Resultado de detalhe Teletex

- ID obtido da página 1 ativa (ex.: `d4310232-…`).
- `GET /api/oneview/alerts/{id}` → **200**, `datasource_name=teletex-http`, sem Castrolanda/Zurich/Fraport no payload do detalhe.
- `GET /api/oneview/alerts/{id}/history` → **200**, histórico retornado.

---

## 8. Resultado de detalhe não Teletex

- ID Zurich presente no snapshot seguro (`datasource_name=zurich`, id `a8204fc3-…`).
- Detalhe → **404** `not_found` (fonte `database`).
- Histórico → **404** `not_found`.
- Corpo de erro sem dados do alerta estrangeiro.

---

## 9. Situação da saúde global

| Superfície | Situação |
|---|---|
| `GET /api/oneview/health` | Expõe `database_reachable` + counts + capabilities |
| `GET /api/oneview/operations/health` | Expõe `worker` (`status=healthy`) + `items` **somente** `teletex-http` |
| Objeto `platform` dedicado | **Ausente** no contrato atual de `operations/health` |
| Saúde específica de fonte | Apenas Teletex no array `items` |
| Sync logs | Apenas `data_source_id` da fonte Teletex |

A Home monta “Banco” / “Worker” a partir desses contratos (não há item de plataforma separado no payload ops).

---

## 10. Situação de `/chamados`

| Pergunta | Achado |
|---|---|
| Dados mockados? | **Sim** — `src/pages/Chamados.tsx` importa `mockChamados` / `mockClients` de `src/lib/mock-data.ts` |
| Chamados fictícios? | **Sim** — IDs tipo `RITM32942139`…, assignees “NOC A/B…”, clientes variados (inclui **FRAPORT**) |
| Estado vazio? | **Não** — lista e cards de status são preenchidos pelo mock |
| Manter na Sidebar para apresentação? | **Não recomendado** enquanto o mock estiver visível: contradiz o critério de não exibir Castrolanda/Zurich/Fraport/fictícios. A rota em si existe (`App.tsx`) e não 404; o problema é o conteúdo. |

OV-P0-03 manteve `/chamados` porque a rota existe; este card **não** removeu o item (sem alteração de código).

---

## 11. Ocorrências dos aliases `teletex` / `teletex-http` / `http-teletex`

| Alias | Ocorrências | Classificação |
|---|---|---|
| `teletex-http` | BFF (`oneview-scope.js`, SQL, fallback, ACK gate, env examples, testes) | **Filtro técnico / código produtivo / testes** |
| `teletex-http` | UI ACK gate em `Alerts.tsx` | **Código produtivo (gate)** |
| `teletex` | Logos (`Index.tsx`, `Alerts.tsx` aliases), `mock-data.ts` clientId | **Visual / mocks** |
| `http-teletex` | **Zero** no código (apenas menção documental na auditoria) | Inexistente |
| `castrolanda` / `zurich` / `fraport` | Logos + `mock-data.ts` + testes ACK | **Visual / mocks / testes** |
| `castrolanda` | Runtime DB como **customer_name** sob `teletex-http` | **Dado operacional real da fonte Teletex** (não data source) |

---

## 12. Testes, build e lint

| Verificação | Resultado |
|---|---|
| `npm run test:bff` | **176/176 pass** |
| `npm run build` | **OK** (aviso pré-existente de chunk >500 kB) |
| ESLint arquivos OV-P0-02/03 | **OK** (sem erros) |
| `git diff --check` | **OK** (apenas avisos CRLF/LF do Git no Windows; sem conflict markers / trailing whitespace fatal) |
| Código produtivo alterado neste card | **Nenhum** (somente este relatório) |

---

## 13. Problemas encontrados

1. **`ONEVIEW_PRIMARY_DATA_SOURCE_NAME` ausente no `.env.local`** — o default de código (`teletex-http`) cobre, mas a variável deveria estar explícita para ambientes locais.
2. **Label `castrolanda` em agregações de cliente** dentro do escopo `teletex-http` (dashboard-summary / clients-summary / attention / grafana-summary). Não é escape de data source; falha o critério literal “nenhuma resposta contém Castrolanda”.
3. **`/chamados` com mocks fictícios** (inclui FRAPORT) — inadequado para apresentação Teletex-only.
4. **Card ServiceNow** na Home: valores `—` (não inventa número/SLA/chamado), mas o botão **“Abrir chamados”** navega para `/chamados` (rota válida, conteúdo mock).
5. **Legados `/api/alerts*`** não exercitáveis no BFF local (404). Escopo deles depende dos testes unitários, não deste smoke HTTP.
6. **`CURRENT_STATE_AUDIT.md` desatualizado** — ainda afirma que não há filtro Teletex global (pré OV-P0-02).
7. **Sem objeto `platform`** em `operations/health`; saúde de banco vem de `/health.database_reachable`.

Nenhum destes itens foi corrigido neste card (proibido alterar código).

---

## 14. Recomendação

### **Aprovado** para avançar à Home (próximos cards de UI/Home Teletex)

Motivo: o enforcement de **data source** `teletex-http` está efetivo no BFF vivo (database), com paginação correta, métricas/histórico/detail/data-sources/sync/ops filtrados, e detalhe estrangeiro em 404. Escape por query `datasource=` falha fechado.

Ressalvas que **não bloqueiam** o avanço da Home operacional, mas devem entrar em cards seguintes:

- decidir o que fazer com labels de cliente “castrolanda” (dado real vs. ocultação na apresentação);
- retirar ou esvaziar `/chamados` mock antes de demos;
- alinhar ServiceNow para não empurrar o usuário ao mock;
- documentar `ONEVIEW_PRIMARY_DATA_SOURCE_NAME` no `.env.local`;
- atualizar a auditoria CURRENT_STATE.

---

## ServiceNow (Home) — checklist do card

| Critério | Resultado |
|---|---|
| Número fictício | **Não** — placeholders exibem `—` |
| Chamado fictício | **Não** no card |
| SLA fictício | **Não** — só label “SLA vencido” com `—` |
| Link quebrado | **Não** — `Link to="/chamados"` aponta para rota existente; conteúdo destino é mock (problema de conteúdo, não 404) |
