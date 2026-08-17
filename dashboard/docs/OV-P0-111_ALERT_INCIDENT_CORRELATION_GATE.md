# OV-P0-111 — Alert ↔ Incident PROD Correlation Gate

**Tipo:** auditoria read-only (GET ServiceNow + SELECT PostgreSQL)  
**Data:** 2026-08-13  
**Amostra:** 100 alertas mais recentes com tag explícita `__zbx_servicenow_*`  
**Instância SN alcançada:** `teletexdev.service-now.com` (credencial local)  
**Não faz:** deploy, commit, write no ServiceNow, Webex, frontend novo, fallback por host.

---

## Decisão

**A referência explícita ainda não está pronta para sustentar UI de correlação validada contra o ServiceNow.**

- Taxa de correlação **exata:** **0%** (0/100)
- Taxa utilizável (exact + sys_id-only + number-only): **0%**
- Divergência number↔sys_id (mismatch): **0%**
- Ausentes na instância SN alcançada: **100%**
- Tags `sys_id` e `number` **bem formadas:** **100%** da amostra
- Tag `link` **inutilizável no banco:** **100%** (`[redacted-url]`)

A UI **pode** continuar projetando `number`/`sys_id` a partir das tags (OV-P0-109) como metadado Zabbix.  
Não pode afirmar que o incidente existe, que number e sys_id são o mesmo INC, nem abrir o link persistido, até haver GET na instância que possui esses registros (PROD) com conta read-only PROD.

---

## Método

1. SELECT dos 100 `alerts` mais recentes (`last_seen_at DESC`) com valor não vazio em  
   `__zbx_servicenow_sys_id` / `__zbx_servicenow_number` / `__zbx_servicenow_link`  
   em `event_tags`, `trigger_tags` ou `host_tags`.
2. Extração **só** dessas tags (sem host, sem `eventid`, sem comentário).
3. Lookup GET-only, separado: `sys_idIN…` e `numberIN…` (Basic Auth backend).
4. Classes (uma por alerta):
   - `correlated_exact`
   - `correlated_by_sys_id_only`
   - `correlated_by_number_only`
   - `mismatch`
   - `missing_in_servicenow`
   - `malformed_tag`

Script: `scripts/ov-p0-111-alert-incident-correlation-gate.mjs`  
Classificador: `inspectExplicitServiceNowTags` / `classifyExplicitServiceNowCorrelation` em `api/_lib/oneview-inc-correlation.js`.

---

## Medições (n = 100)

| Classe | Qtd | % |
|---|---:|---:|
| `correlated_exact` | 0 | 0 |
| `correlated_by_sys_id_only` | 0 | 0 |
| `correlated_by_number_only` | 0 | 0 |
| `mismatch` | 0 | 0 |
| `missing_in_servicenow` | 100 | 100 |
| `malformed_tag` (classe exclusiva) | 0 | 0 |

Lookups únicos: **116 sys_ids** e **116 numbers** (16 alertas têm 2 pares). Nenhum hit na Table API DEV.

Campos SN (`state` / `priority` / `assigned_to`): **não recuperados** (0 incidentes resolvidos).

### Top causas

| Causa | Qtd | % | Leitura |
|---|---:|---:|---|
| `explicit_ref_not_found_in_servicenow` | 100 | 100 | sys_id e number parseáveis; INC inexistente em DEV |
| `malformed_tag_value` / link | 100 | 100 | `__zbx_servicenow_link` persistido como `[redacted-url]` |
| `multiple_sys_id_tags` | 16 | 16 | dois sys_ids distintos no mesmo alerta |
| `multiple_number_tags` | 16 | 16 | dois numbers distintos no mesmo alerta |

Qualidade estrutural das tags (antes do GET):

| Check | Resultado |
|---|---|
| Possui `sys_id` parseável (32 hex)? | 100/100 sim |
| Possui `number` parseável (`INC`+dígitos)? | 100/100 sim |
| Possui `link`? | 100/100 tag presente |
| Link parseável (`sys_id=`)? | 0/100 — valor `[redacted-url]` no PostgreSQL |
| Number e sys_id divergem **dentro do SN**? | não medido (nenhum dos dois existiu em DEV) |

---

## Exemplos

### Tag bem formada, INC ausente em DEV (classe `missing_in_servicenow`)

| alert / event | number | sys_id | link |
|---|---|---|---|
| event `334122082` | INC0068209 | `65fe187797628350e580f137f053af04` | `[redacted-url]` |
| event `334093507` | INC0068204 | `1c6b107b97228350e580f137f053af58` | `[redacted-url]` |
| event `334015159` | INC0068191 | `8d13183333a6075064bca4989d5c7b4f` | `[redacted-url]` |

Nenhum “exemplo válido” de `correlated_exact` nesta instância.

### Múltiplas referências no mesmo alerta (16%)

Event `333374559` (Meraki Arapongas wan2):  
`INC0067790` + `INC0067978` e dois sys_ids. Não é mismatch SN (os dois miss em DEV); é alerta com mais de um INC explícito — a UI precisa do `extra_count` já previsto em OV-P0-109, não de um único card.

### Link inválido para UI

Em 100/100 o valor persistido de `__zbx_servicenow_link` é o placeholder `[redacted-url]`, não uma URL `incident.do?sys_id=`. O deep link da UI **não pode** sair dessa tag no banco; só de `buildServiceNowIncidentDeepLink(baseUrl, sys_id)` com o `sys_id` da tag e o `SERVICENOW_BASE_URL` correto.

---

## Por que 0% no SN (e o que isso não prova)

1. **Instância errada para esses IDs.** A amostra é de alertas live do OneView (hoje). Os numbers (`INC00678xx`–`INC00682xx`) e sys_ids não existem em `teletexdev`. SN-P0-36 já mostrou que a conta DEV recebe **401** em `teletexprod.service-now.com`. Sem credencial PROD na sessão, o gate **não** consegue confirmar existência/paridade em PROD.
2. **Isso não é evidência de tags inventadas.** 100% dos `sys_id`/`number` passaram no parser canônico. O buraco é **validação SN na instância dona do registro**.
3. **Não é mismatch.** Mismatch exigiria os dois lookups retornarem incidentes diferentes. Aqui os dois voltaram vazios.
4. **Sem fallback por host** — nenhum `u_hostname_zabbix` / caller heurístico entrou no lookup.

---

## Risco residual / o que a UI pode e não pode fazer

| Capacidade | Pronto? |
|---|---|
| Mostrar number/sys_id das tags | Sim (projeção OV-P0-109) |
| Afirmar que o INC existe no SN da sessão | Não (0/100 em DEV; PROD não consultado) |
| Afirmar que number e sys_id são o mesmo INC | Não (não medido em PROD) |
| Abrir `__zbx_servicenow_link` persistido | Não (redigido no banco) |
| Montar `/incident.do?sys_id=` com baseUrl + tag sys_id | Sim, **se** o baseUrl for o da instância dona do sys_id |
| Mostrar state/priority/assigned_to live | Não nesta evidência |
| Um INC por alerta | Cuidado: 16% têm dois pares |

**Pronto para UI de correlação validada:** não.  
**Pronto para chip/projeção da tag explícita:** sim, com a ressalva do link e de `extra_count`.

---

## Próximo passo para fechar o gate em PROD

Com `SERVICENOW_BASE_URL=https://teletexprod.service-now.com` e conta **read-only PROD só na sessão** (não gravar `.env`):

```powershell
cd dashboard
$env:SERVICENOW_BASE_URL="https://teletexprod.service-now.com"
$env:SERVICENOW_USERNAME="(conta read-only PROD)"
$env:SERVICENOW_PASSWORD="(não gravar)"
node scripts/ov-p0-111-alert-incident-correlation-gate.mjs --limit=100
```

Critério para virar “ready”: `usable_explicit_pct >= 90` e `mismatch_pct <= 2` **nessa** instância, com `state`/`priority` preenchidos nos hits.

---

## Testes

```powershell
node --test tests/ov-p0-111-alert-incident-correlation-gate.test.mjs
```

4/4 testes de classificação (exact, sys_id-only, number-only, mismatch, missing, malformed) sem chamar SN.
