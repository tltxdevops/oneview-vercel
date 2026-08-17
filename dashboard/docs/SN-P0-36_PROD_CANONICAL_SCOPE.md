# SN-P0-36 — PROD Canonical Incident Scope

**Tipo:** auditoria GET-only  
**Data:** 2026-08-13  
**Fora de escopo:** alterar runtime, gravar `.env`, deploy, commit, worker/DB.

---

## 1. Resultado da auditoria

### 1.1 Instância efetivamente alcançada

| Item | Valor |
|---|---|
| Host local gravado (`.env.local`, não alterado) | `teletexdev.service-now.com` (DEV) |
| Sessão `SERVICENOW_*` | ausente |
| Host PROD (DNS) | **`teletexprod.service-now.com`** (A 149.96.208.222) |
| Host tentado e inválido | `teletex.service-now.com` (NXDOMAIN) |
| Override | só in-memory (`--override-host`); arquivo `.env` **não** gravado |
| Autenticação PROD com credencial DEV | **401** `servicenow_authentication_failed` |
| Username/password | não impressos |

A Table API PROD **foi contactada**. A conta de integração DEV **não** lê PROD (isolamento correto). Sem credencial PROD na sessão, os totais A/B/C/D **não** puderam ser medidos nesta execução.

Script reproduzível (quando a sessão tiver user/password PROD):

```powershell
$env:SERVICENOW_BASE_URL="https://teletexprod.service-now.com"
$env:SERVICENOW_USERNAME="(conta read-only PROD)"
$env:SERVICENOW_PASSWORD="(não gravar em arquivo)"
$env:SERVICENOW_ZABBIX_MONITORING_CALLER_ID="(sys_id PROD do caller zabbix monitoring)"
node scripts/sn-p0-36-prod-canonical-scope.mjs --from=2026-08-01 --to=2026-08-13
```

O script recusa host `*dev*` por padrão e nunca imprime credenciais.

### 1.2 Universos pedidos (queries; totais PROD = pendente 401)

Janela B: `opened_at` 2026-08-01 00:00:00 → 2026-08-13 23:59:59.  
Caller informado (constante SN-P0-35 / DEV): `aa62f29f47477610082e3d02e26d4358`.

| ID | Predicado | totalCount PROD | Amostra 20 | states / priorities / assigned | opened_at min/max |
|---|---|---|---|---|---|
| **A** | `/api/now/table/incident` sem `sysparm_query` | **401** | — | — | — |
| **B** | `caller_id=<sys_id informado>` + janela | **401** | — | — | — |
| **C** | `contact_type=monitoring` | **401** | — | — | — |
| **D** | `caller_id=<sys_id informado>` + `contact_type=monitoring` | **401** | — | — | — |

Diffs B−C, C−B, B−D, D−C: **não calculados** (mesma 401).  
Existência do sys_id informado em `sys_user` PROD: **não confirmada** (401, não NXDOMAIN).

### 1.3 Contrato BFF atual (código; independente do host)

`GET /api/oneview/incidents` → Table API `GET /api/now/table/incident`.

Query default `/chamados` (SN-P0-25):

```text
contact_type=monitoring^ORDERBYDESCsys_updated_on^ORDERBYsys_id
```

- `contact_type=monitoring` é **obrigatório**.
- `caller_id` **não** entra por default.
- Correlação alerta→INC (SN-P0-16/33):  
  `contact_type=monitoring^caller_id=<SERVICENOW_ZABBIX_MONITORING_CALLER_ID>^descriptionLIKEeventid=<id>`  
  Sem env do caller PROD → falha fechada `servicenow_caller_not_configured` (sem fallback para o ID DEV).

### 1.4 Evidência colateral (DEV, SN-P0-35 — não é PROD)

Na instância **DEV** (`teletexdev`), SN-P0-35 mediu aproximadamente:

- A (ACL, sem query) ≈ 24 064  
- B (`caller_id=aa62…` + janela ago/2026) = **0**  
- C (`contact_type=monitoring`) ≈ 19 724  

Isso **não** substitui A/B/C/D em PROD. Serve só para mostrar que o predicado C já é o universo largo de monitoramento, e que o sys_id informado + janela pode devolver vazio mesmo em DEV.

---

## 2. Query canônica recomendada

```text
contact_type=monitoring
```

**Por quê (evidência de contrato + identidade, não de totais PROD):**

1. É o único predicado **estável entre ambientes** (não é sys_id). SN-P0-25 já definiu `/chamados` assim.
2. Cobre automação Zabbix **e** chamados manuais NOC com o mesmo `contact_type` (universo operacional de monitoramento).
3. Estreitar o default para `caller_id=<zabbix>` esconderia INC manuais (C−B / C−D).
4. O sys_id informado é o caller **DEV** (SN-P0-32). Copiá-lo para PROD é o erro que SN-P0-33/33 já bloquearam.

Até existir medição 200 em `teletexprod`, esta é a recomendação **presumida canônica**. Confirmar com os totais A/B/C/D quando a conta PROD estiver na sessão.

---

## 3. Query secundária complementar

Só para **correlação alerta→INC** e filtro UX opcional “automático Zabbix”:

```text
contact_type=monitoring^caller_id=<ZABBIX_MONITORING_CALLER_ID_PROD>
```

`<ZABBIX_MONITORING_CALLER_ID_PROD>` deve ser o `sys_id` do usuário **“zabbix monitoring” em PROD**, descoberto via `sys_user` (nome/user_name), **nunca** o ID DEV `aa62f29f47477610082e3d02e26d4358` até prova em PROD de que o registro foi clonado com o mesmo sys_id (improvável).

Não usar união `caller_id=… OR contact_type=monitoring` como default de `/chamados`: infla o universo com INC do caller que não são monitoramento.

---

## 4. Por que INC de PROD não aparecem hoje no OneView

Três causas independentes, em ordem de impacto:

1. **Host errado (bloqueante neste checkout)**  
   OneView local consulta `teletexdev`. INC que “existem no ServiceNow PROD” **nunca são pedidos**. Qualquer comparação lista OneView × tela PROD é inválida até `SERVICENOW_BASE_URL=https://teletexprod.service-now.com` com credencial PROD.

2. **Filtro BFF `contact_type=monitoring`**  
   Mesmo apontando PROD, INC com `contact_type` vazio/outro valor **não entram** em `/chamados`. Se o processo PROD criar INC Zabbix sem esse campo, eles somem no OneView (B−C). Isso só se prova com a conta PROD.

3. **Caller DEV na correlação**  
   Drawer alerta→INC exige `SERVICENOW_ZABBIX_MONITORING_CALLER_ID` do **mesmo** ambiente. ID DEV + host PROD → 0 INC (ou `servicenow_caller_not_configured` se o env estiver vazio). Lookup por número INC / tags `__zbx_servicenow_*` (OV-P0-108) não usa esse caller.

A credencial DEV contra PROD retornou **401**: mesmo com URL certa, a conta atual não lê a tabela PROD.

---

## 5. Riscos e impactos

| Superfície | Risco | Impacto |
|---|---|---|
| `/chamados` | Manter `contact_type=monitoring` | Correto para universo operacional; INC PROD sem esse tipo continuam invisíveis |
| `/chamados` | Default `caller_id` Zabbix | Perde INC manuais NOC (universo C−D) |
| Correlação alerta→INC | Usar sys_id DEV em PROD | Silêncio / 0 chamados relacionados |
| Correlação | Só `contact_type` sem caller | Mais candidatos; parser `eventid=` ainda pós-filtra (SN-P0-16) |
| Go-live | Trocar só a URL, reusar user DEV | **401** — precisa user/ACL PROD |
| Go-live | Não preencher caller PROD no secret store | `/chamados` sobe; drawer por eventid não |

Nenhuma mudança de BFF nesta entrega.

---

## 6. Veredito

| Critério | Estado |
|---|---|
| Auditoria GET contra host PROD | **Parcial** — host confirmado (`teletexprod`); Table API 401 |
| Totais A/B/C/D + diffs + amostras | **Bloqueado** — falta conta read-only PROD na sessão |
| Sys_id informado existe em PROD? | **Indeterminado** (401 ≠ “não existe”) |
| Query canônica proposta | **`contact_type=monitoring`** (contrato BFF + SN-P0-25/32; revalidar totais) |
| Query complementar | `contact_type=monitoring^caller_id=<caller PROD>` — só correlação / filtro |
| Por que INC PROD não aparecem | Host DEV + ACL PROD distinta + filtro `contact_type` + caller DEV na correlação |

**Próximo passo (não este card):** sessão com `SERVICENOW_USERNAME` / `PASSWORD` de PROD, rerrodar `scripts/sn-p0-36-prod-canonical-scope.mjs`, preencher a tabela §1.2 e confirmar ou corrigir o sys_id do caller Zabbix em PROD.
