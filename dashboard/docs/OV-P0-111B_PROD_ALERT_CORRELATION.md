# OV-P0-111B — PROD Alert ↔ ServiceNow Correlation

**Tipo:** auditoria read-only (SELECT PostgreSQL no read model `servicenow_incidents`)  
**Data:** 2026-08-13  
**Amostra:** 100 alertas mais recentes com `__zbx_servicenow_sys_id` ou `__zbx_servicenow_number`  
**Lookup:** tabela local `servicenow_incidents` (não API live)  
**Não faz:** fallback por host, write, commit, deploy, alteração de BFF/worker/banco.

Script: `scripts/ov-p0-111b-prod-alert-correlation.mjs`

---

## Resultado

```
TOTAL=100
EXACT=0
MISMATCH=0
MISSING=100
CORRELATION_RATE=0%
```

SYS_ID_ONLY=0 · NUMBER_ONLY=0 · USABLE_RATE=0%

**Causa comprovada:** `servicenow_incidents` existe, RLS off, SELECT liberado para `oneview_vercel_readonly`, mas **0 linhas** (`reltuples=-1`). Não é falha de tag Zabbix e não é mismatch number↔sys_id.

---

## Método

1. SELECT 100 `alerts` (`last_seen_at DESC`) com tag explícita number ou sys_id.
2. Lookup no read model por `sys_id` e `number` (sem `u_hostname_zabbix`).
3. Prioridade de resolução: sys_id explícito → number explícito → INC em histórico/comentário → `correlation_id`/`zabbix_event_id` → none.
4. Classes: `correlated_exact` / `sys_id_only` / `number_only` / `mismatch` / `missing`.

---

## Lado alerta (pronto)

| Check | Resultado |
|---|---|
| Amostra com tag explícita | 100/100 |
| sys_id parseável | 104 únicos |
| number parseável (`INC`+dígitos) | 104 únicos |
| INC extra só no histórico | 2 |
| Hits por event evidence | 0 (tabela vazia) |

As tags apontam para INCs PROD da faixa `INC00683xx` (ex.: INC0068399). SN-P0-36F2 já autenticou PROD; este card **não** consultou a Table API.

---

## 10 exemplos ponta a ponta

Alert ID → Zabbix Event → INC → sys_id → state/priority/assigned_to

state/priority/assigned_to = nulos porque o INC não está no read model.

| Alert ID | Event | INC | sys_id | SN fields |
|---|---|---|---|---|
| `dea99fbb-ef9f-4e52-a238-e62953eb7403` | 334583251 | INC0068399 | `6093c2b39762c350e580f137f053afb2` | — |
| `ccbee58a-3e43-4fcf-aecc-3c74944cedff` | 334580826 | INC0068398 | `94030e739762c350e580f137f053af03` | — |
| `bb213bae-0dd9-4b86-88ec-71aa10810b90` | 334565450 | INC0068380 | `a3f7bd3f97ee8350e580f137f053af97` | — |
| `0915d762-c1d8-4fac-971b-eb6c83312159` | 334564872 | INC0068379 | `95b7f57347e643146b618ca2036d4305` | — |
| `c1b468b0-5df1-4796-95ec-940807bf0785` | 334557512 | INC0068337 | `ee76bdbf47a643146b618ca2036d435d` | — |
| `18b5c229-42a5-4173-b069-f576d48313dd` | 334553245 | INC0068334 | `d295b93b97ee8350e580f137f053afba` | — |
| `9ca01822-c945-45f2-b0e8-a3355c978e5f` | 334515132 | INC0068328 | `e67fe1ff3366475064bca4989d5c7bca` | — |
| `196a0ce5-cc3d-4fa0-9aa8-4a2fac733e59` | 334454294 | INC0068311 | `2054ed3f33e2475064bca4989d5c7b01` | — |
| `86fbdb6f-9e2d-4bc9-8eef-745b33782b56` | 334451248 | INC0068310 | `b004697b976287d030f7f796f053af01` | — |
| `7f7964c3-8d5a-44ed-9ef0-82006a43f361` | 334434917 | INC0068301 | `74502d7b33a2475064bca4989d5c7b75` | — |

`relation_source=none` em 10/10: o passo 1–4 da prioridade não achou linha no read model.

---

## O que não foi corrigido

Nada no BFF, worker ou banco. A causa comprovada é **read model vazio**, não um bug de classificador.

**Pronto para UI de correlação validada contra PROD:** não.  
**Próximo passo:** popular `servicenow_incidents` (sync SN-P0-37 no worker) e reexecutar este script.
