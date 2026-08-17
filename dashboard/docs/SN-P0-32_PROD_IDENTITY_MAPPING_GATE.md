# SN-P0-32 — PROD Identity Mapping Gate (auditoria)

**Tipo:** somente planejamento / auditoria read-only  
**Data:** 2026-08-12  
**Fora de escopo desta entrega:** troca de env/secrets, chamada a PROD, refatoração de runtime, commit, deploy, worker OneView.

---

## 1. Inventário — sys_ids ServiceNow específicos de DEV

### 1.1 Fonte canônica de runtime

Arquivo: [`api/_lib/oneview-incidents.js`](../api/_lib/oneview-incidents.js)

| Constante / mapa | sys_id (DEV) | Label | Uso runtime |
|---|---|---|---|
| `ZABBIX_MONITORING_CALLER_ID` | `aa62f29f47477610082e3d02e26d4358` | zabbix monitoring | Correlation alerta→INC (`buildRelatedIncidentsSysparmQuery`); seed de facet |
| `NOC_PROTEGE_CALLER_ID` | `50e065b3fb55f210fb0ef9285eefdcee` | NOC Protege | Seed de facet / filtro opcional `/chamados` |
| `INCIDENT_CALLER_LABELS` | `f83cc28887777250d5fd84c30cbb3545` | Gwms Integration | Label cosmético de facet |
| `INCIDENT_CALLER_LABELS` | `23396eb73bc83610d6756147f4e45ada` | Janine Scavone | Label cosmético de facet |
| `INCIDENT_CALLER_FILTER_SEEDS` | Zabbix + NOC Protege | — | Garante opções no facet mesmo com count 0 |

Trecho canônico:

```js
export const ZABBIX_MONITORING_CALLER_ID = "aa62f29f47477610082e3d02e26d4358";
export const NOC_PROTEGE_CALLER_ID = "50e065b3fb55f210fb0ef9285eefdcee";
export const INCIDENT_CALLER_LABELS = Object.freeze({
  [ZABBIX_MONITORING_CALLER_ID]: "zabbix monitoring",
  [NOC_PROTEGE_CALLER_ID]: "NOC Protege",
  f83cc28887777250d5fd84c30cbb3545: "Gwms Integration",
  "23396eb73bc83610d6756147f4e45ada": "Janine Scavone",
});
```

Correlation (dependência dura):

```text
contact_type=monitoring^caller_id=<ZABBIX_MONITORING_CALLER_ID>^descriptionLIKEeventid=<id>
```

### 1.2 Duplicatas espelhadas (mesmo sys_id DEV)

| Local | O quê |
|---|---|
| [`src/pages/Chamados.tsx`](../src/pages/Chamados.tsx) `CALLER_FILTER_SEEDS` | Zabbix + NOC Protege hardcoded no frontend |
| `scripts/servicenow-correlation-audit.mjs` | `ZABBIX_CALLER_ID` |
| `scripts/servicenow-correlation-coverage.mjs` | `ZABBIX_CALLER_ID` |
| `scripts/servicenow-parser-coverage.mjs` | query com caller Zabbix |
| `scripts/sn-p0-13-alert-to-incident-lookup-audit.mjs` | `ZABBIX_CALLER_ID` |
| `scripts/sn-p0-24-manual-incidents-audit.mjs` | Zabbix + query NOC Protege |
| Testes (`sn-p0-15`, `sn-p0-16`, `sn-p0-25`, `sn-p0-27`, `sn-p0-28`) | asserts / fixtures com os mesmos IDs |

### 1.3 Não encontrado (grupos / referências)

- **Nenhum** `assignment_group` sys_id hardcoded no BFF/UI.
- Deep link: `{SERVICENOW_BASE_URL}/incident.do?sys_id=<registro>` — usa `sys_id` do incidente retornado, não seed.
- Analistas (`assigned_to`): facet via Aggregate API; sem seed de pessoa além dos labels Gwms/Janine no mapa de **caller**.

### 1.4 Contrato fixo (não é sys_id; geralmente estável entre ambientes)

| Item | Valor / forma | Notas |
|---|---|---|
| Universo | `contact_type=monitoring` | Obrigatório no BFF (SN-P0-25) |
| States KPI | `1` / `2` / `6` / `7` | `stateNOT IN6,7` no unassigned |
| Custom fields | `u_hostname_zabbix`, `u_ip_zabbix` | Allowlist Table API; UI omite se vazio |
| Deep link path | `/incident.do?sys_id=` | Depende só de `SERVICENOW_BASE_URL` |

### 1.5 Env atual

[`.env.local.example`](../.env.local.example): `SERVICENOW_BASE_URL`, user, password, timeout, retry, flags — **não existe** ainda `SERVICENOW_ZABBIX_MONITORING_CALLER_ID` nem seeds CSV.

---

## 2. Classificação

### 2.1 Necessários para funcionamento

| ID / constante | Por quê |
|---|---|
| **`ZABBIX_MONITORING_CALLER_ID`** | Único hard dependency de negócio no runtime. Sem o sys_id correto do ambiente, `fetchIncidentsBySourceEventId` / drawer alerta→INC retorna **0 INC** (quebra silenciosa). |

Sem este mapping por ambiente, PROD não pode ligar correlação Zabbix com segurança.

### 2.2 Apenas convenience / facet

| ID / constante | Por quê |
|---|---|
| **`NOC_PROTEGE_CALLER_ID`** | Filtro UX opcional; universo `/chamados` já é só `contact_type=monitoring`. |
| **`INCIDENT_CALLER_FILTER_SEEDS`** | Mantém opção no dropdown com count 0; não altera query default. |
| **`CALLER_FILTER_SEEDS` (frontend)** | Espelho dos seeds BFF; redundante se `facets.callers` estiver completo. |
| **`INCIDENT_CALLER_LABELS` (Gwms / Janine)** | Cosmético quando Aggregate/list não traz display; risco de vazar identidade DEV em PROD. |

### 2.3 Descobríveis por API em runtime (com autorização / ACL)

| Dado | Como descobrir |
|---|---|
| Callers do universo monitoring | Aggregate `group_by=caller_id` (`fetchIncidentCallerFacets` já existe) |
| Labels de caller | `sysparm_display_value=all` → `caller_id.display_value` / `displayHints` da listagem |
| Analistas | Aggregate `group_by=assigned_to` (SN-P0-28) — sem seed |
| Companies / states / priorities | Facets já existentes no BFF |
| Caller “zabbix monitoring” por nome | Table `sys_user` **ou** amostra `incident` com `caller_id.nameLIKE` (só se ACL permitir; validar no gate PROD) |
| Grupos | Aggregate / display de `assignment_group` — sem hardcode hoje |

---

## 3. Proposta — remover dependência de sys_id hardcoded

**Próximo card de implementação** (não executar nesta auditoria). Decisão fechada:

1. **Config server-side**
   - `SERVICENOW_ZABBIX_MONITORING_CALLER_ID` — **obrigatório** quando `SERVICENOW_INCIDENTS_ENABLED=true`
   - Opcional: `SERVICENOW_CALLER_FILTER_SEEDS` (CSV de sys_ids) para convenience de facet
2. **Correlation runtime** lê só da config; se vazio com incidents enabled → falha fechada `servicenow_caller_not_configured` (sem fallback para ID DEV).
3. **Facets:** Aggregate + display hints primeiro; seeds somente de env; **eliminar** mapa Gwms/Janine do código.
4. **Frontend:** remover `CALLER_FILTER_SEEDS` hardcoded; consumir `facets.callers` do BFF.
5. **Scripts de audit:** `--caller-id` e/ou env; não embutir sys_id DEV como constante obrigatória.
6. **Gate PROD:** tabela runbook DEV→PROD preenchida **antes** de ligar flag; **nunca** copiar sys_ids DEV para PROD.

### Mapping runbook (preencher sob autorização)

| Papel / label | sys_id DEV | sys_id PROD | Notas |
|---|---|---|---|
| zabbix monitoring | `aa62f29f47477610082e3d02e26d4358` | _TBD — confirmar em PROD_ | Obrigatório |
| NOC Protege | `50e065b3fb55f210fb0ef9285eefdcee` | _TBD — se existir_ | Opcional / seed |
| Gwms Integration | `f83cc288…` | _não mapear_ | Remover do código |
| Janine Scavone | `23396eb7…` | _não mapear_ | Remover do código |

---

## 4. Checklist de validação em PROD

Executar **somente** após autorização explícita, contra `SERVICENOW_BASE_URL` de PROD, conta **read-only**.  
**Não executar nesta sessão.**

### A. Identidade / mapping

- [ ] Confirmar sys_id PROD do caller “zabbix monitoring” (nome + active)
- [ ] Confirmar se “NOC Protege” (ou equivalente) existe em PROD; se não, não seedar
- [ ] Documentar DEV→PROD na tabela do §3; **não** reutilizar IDs DEV
- [ ] `SERVICENOW_ZABBIX_MONITORING_CALLER_ID` (PROD) só no secret store

### B. Universo e APIs

- [ ] `contact_type=monitoring` retorna registros (Table API `incident`, limit 1–25)
- [ ] Table API: campos allowlisted presentes (`sys_id`, `number`, `caller_id`, `assigned_to`, `assignment_group`, `company`, `state`, `priority`, `description`, `u_hostname_zabbix`, `u_ip_zabbix`, …)
- [ ] Aggregate API habilitada (`group_by` `state`, `caller_id`, `assigned_to`, `company`); se 403, confirmar fallback Table para KPIs
- [ ] `assigned_to` / `assigned_toISEMPTY` / `stateNOT IN6,7` coerentes com processo PROD
- [ ] `caller_id` filtrável; `display_value` legível com `sysparm_display_value=all`

### C. Campos custom e deep link

- [ ] `u_hostname_zabbix` / `u_ip_zabbix` existem e ACL de leitura OK (ou ausentes → UI já omite)
- [ ] Parser `eventid=` em `description` cobre formato PROD das automações Zabbix
- [ ] Deep link `{PROD_BASE}/incident.do?sys_id=<id>` abre com SSO do operador (sem Basic Auth no browser)
- [ ] Correlation alerta→INC com caller PROD retorna ≥1 caso conhecido de piloto

### D. Gate de go-live

- [ ] Flags `SERVICENOW_INCIDENTS_ENABLED` / `VITE_SERVICENOW_INCIDENTS_ENABLED` permanecem **false** até A–C verdes
- [ ] Smoke BFF local apontando PROD (só com autorização): list, facets, related-incidents, 1 deep link
- [ ] Rollback: desligar flags; sem migration de banco

---

## 5. Diagrama (estado atual → alvo)

```text
HOJE (DEV hardcoded)
  ZABBIX_MONITORING_CALLER_ID ──► related-incidents query
  INCIDENT_CALLER_FILTER_SEEDS ──► facets.callers
  Chamados CALLER_FILTER_SEEDS ──► dropdown UX

ALVO (por ambiente)
  SERVICENOW_ZABBIX_MONITORING_CALLER_ID (env) ──► related-incidents
  Aggregate caller_id + optional SEEDS CSV ──► facets
  Frontend só facets.callers ──► dropdown UX
```

---

## 6. Veredito

| Achado | Severidade |
|---|---|
| Correlation Zabbix amarra sys_id DEV no código | **Bloqueante** para PROD sem mapping |
| Seeds NOC / labels pessoas no código | Médio (UX / vazamento de identidade DEV) |
| Grupos hardcoded | Nenhum |
| Env sem caller configurável | Gap de gate |

**Aprovado como auditoria.** Implementação de config + remoção de hardcode fica para card seguinte, após checklist PROD autorizado.
