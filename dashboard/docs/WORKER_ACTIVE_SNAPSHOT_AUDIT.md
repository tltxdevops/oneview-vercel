# WORKER_ACTIVE_SNAPSHOT_AUDIT — Completude do snapshot ativo Teletex

**Card:** OV-P0-11  
**Data:** 2026-07-30  
**Tipo:** auditoria somente leitura  
**Fonte alvo:** `teletex-http`  
**Data source UUID:** `20511025-a4a7-466b-80d3-08db08dfa90c`  
**Worker canônico (VM):** `/home/administrator/Projetos/oneview-worker`  
**Artefato único gerado:** este arquivo  

**Restrições respeitadas:** sem alteração de código de produto; sem sync real; sem alteração de timer/banco/produção; sem aumento cego de `WORKER_SYNC_LIMIT`; sem remoção de limite sem paginação; sem commit/deploy.

---

## 0. Fontes de evidência e lacunas

| Fonte | Status nesta auditoria |
|---|---|
| Cópia local `OneView/worker/` e `WORKER vm grafana/worker/` | Lida — caminho legado (`get_active_problems`, `limit_reached`) |
| Docs de conversa / dry-runs na VM | Lidos — fotografia paginada + `active_reconciliation` |
| Runtime BFF Teletex (`TELETEX_RUNTIME_VALIDATION.md`) | Lido — `active≈23026` no banco |
| SSH readonly em `administrator@192.168.254.4:/home/administrator/Projetos/oneview-worker` | **Falhou** (`Permission denied (publickey,password)`) |

**Lacuna explícita:** o símbolo `get_complete_active_problem_snapshot` **não existe** nas cópias locais do workspace. O contexto do card e a documentação da VM afirmam que a fotografia paginada vive em outro fluxo no repo remoto (`worker/zabbix_client.py` + `worker/active_reconciliation.py`). Sem SSH, a inspeção do corpo da função no disco remoto **não foi reconfirmada nesta sessão**; a análise abaixo usa evidência documentada da VM + código legado local, sem inventar implementação.

---

## 1. Fluxo atual (sync automático)

```text
systemd timer/service (VM)
  → run_worker_once / run_worker_service
    → python -m worker.main [--once] --limit ${WORKER_SYNC_LIMIT:-1000}
      → main.run_cycle()
        → scheduler.run_once(limit=...)
          → list_due_data_source_ids()   # type=zabbix, status=active, sync_enabled
          → sync_data_source_read_only(..., sync_type="automatic"|"manual")
            → acquire_data_source_lock()
            → ZabbixClient.get_active_problems(limit=effective_limit)   # 1x problem.get
            → get_triggers(...)
            → upsert/normalize loop
            → se len(problems) >= effective_limit:
                 reconciliation_skipped_reason = "limit_reached"
                 resolved_count = 0
              senão:
                 mark_missing_alerts_resolved(...)
            → sync_logs + release lock
```

**Seleção Teletex:** não hardcode no worker; qualquer `data_sources` due com `name=teletex-http` / UUID acima.

**Intervalo:** `data_sources.sync_interval_seconds` (padrão operacional documentado **60s** via `WORKER_DEFAULT_SYNC_INTERVAL_SECONDS=60`). A cópia local de `config.py` ainda defaulta `300` — divergência possível entre artefato local e `.env.worker` da VM.

---

## 2. Causa do corte em 1000

### Onde `WORKER_SYNC_LIMIT` é aplicado

| Camada | Evidência |
|---|---|
| Env VM | `.env.worker` → `WORKER_SYNC_LIMIT=1000` (confirmado em conversa na VM) |
| Settings | `worker/config.py` → `worker_sync_limit: int = 1000` |
| CLI | `main.py --limit` default = `settings.worker_sync_limit` |
| Script once | `run_worker_once.sh` → `--limit "${WORKER_SYNC_LIMIT:-1000}"` |
| Sync | `zabbix_sync.py` → `effective_limit = limit or settings.worker_sync_limit` |
| API call | `get_active_problems(limit=effective_limit)` |

### `problem.get` do caminho automático (legado local = comportamento confirmado do sync)

| Parâmetro | Valor |
|---|---|
| Método | `problem.get` |
| Chamadas por ciclo | **1** (sem paginação) |
| `recent` | `false` |
| `sortfield` | `["eventid"]` |
| `sortorder` | `DESC` |
| `limit` | `WORKER_SYNC_LIMIT` (1000) |
| Enrichment | `selectAcknowledges/selectTags/selectSuppressionData: extend` |
| Filtro opcional | `groupids` via `hostgroup.get` se `problem_group_filter` |

### Gate de reconciliação

Em `sync_data_source_read_only`:

- `len(problems) == 0` → `empty_result`, sem reconciliar  
- `len(problems) >= effective_limit` → **`limit_reached`**, `resolved=0`  
- caso contrário → `mark_missing_alerts_resolved(...)`

**Causa raiz Teletex:** a origem Zabbix possui **mais de 1000** problemas ativos (evidência de dry-run: ~2.255–2.293). O sync devolve exatamente 1000 (os `eventid` mais novos), grava `fetched_count=1000` / `upserted≈1000` e **bloqueia** fechamento de ausentes. Alertas fora do top-1000 por `eventid` deixam de ser reconciliados e podem permanecer `active` no PostgreSQL.

**Não é lote incremental:** cada ciclo é um snapshot truncado dos 1000 mais recentes, não um cursor contínuo sobre o universo ativo.

---

## 3. Função de paginação existente (outro fluxo)

### O que existe no remoto (documentado)

| Artefato remoto | Papel |
|---|---|
| `/home/administrator/Projetos/oneview-worker/worker/zabbix_client.py` | Fotografia paginada (`eventid_from` / `eventid_till`, ordenação, limite por página); validação por contagem; `event.get` em lotes |
| `/home/administrator/Projetos/oneview-worker/worker/active_reconciliation.py` | CLI de reconciliação segura (dry-run / apply controlado) |
| `/home/administrator/Projetos/oneview-worker/tests/test_active_reconciliation.py` | Testes de paginação, falha parcial, recovery, idempotência |

O card nomeia esse caminho como `get_complete_active_problem_snapshot`. Nas cópias locais, o único método equivalente legado é `get_active_problems` (**sem** paginação). **Recomendação operacional:** na implementação, confirmar no disco remoto o nome exato (`get_complete_active_problem_snapshot` vs helper interno) com `rg` antes de plugar no sync automático.

### Capacidades documentadas do snapshot paginado

| Capacidade | Evidência |
|---|---|
| Paginação | Sim — `pages_fetched` (Teletex: **3** páginas com `--page-size 1000`) |
| Deduplicação | Sim — `duplicate_event_ids=0`, `unique_event_ids` |
| Limite máximo / page-size | Page-size configurável (ex.: 1000); **não** deve ser um único `limit` enorme sem páginas |
| Proteção contra loop / falha parcial | Erro em qualquer página **bloqueia** reconciliação (`snapshot_complete=false`) |
| Timeout | Timeout HTTP do client (`request_timeout_seconds`, local=15s); apply usa `lock_timeout=5s` |
| Retry | Rate-limit entre requests; falha parcial = fail-closed (não reconciliar). Retry de sync permanece no ciclo/timer |
| Logs / métricas | `pages_fetched`, `problems_fetched`, `unique_event_ids`, `snapshot_complete`, `reconciliation_blocked_reason`, watermark |
| Testes | Documentados: **72 → 81** testes em `tests/test_active_reconciliation.py` na VM |

### Números Teletex (dry-run / apply documentados)

| Métrica | Valor observado (docs VM) |
|---|---|
| Ativos na origem (Zabbix) | ~2.255 – 2.293 |
| Páginas (`page-size=1000`) | 3 |
| `snapshot_complete` | true (quando fotografia íntegra) |
| Duplicados entre páginas | 0 |
| Ativos persistidos no OneView (época do dry-run) | ~41k |
| Ativos no OneView (runtime BFF recente) | **~23.026** (`TELETEX_RUNTIME_VALIDATION`) |
| Duração dry-run completo c/ `event.get` | ~6m36s |
| Apply Teletex documentado | ~419s, 40 batches, `zabbix_write_calls=0` |

---

## 4. Arquivos envolvidos

### Remoto (canônico)

- `/home/administrator/Projetos/oneview-worker/worker/main.py`
- `/home/administrator/Projetos/oneview-worker/worker/scheduler.py`
- `/home/administrator/Projetos/oneview-worker/worker/zabbix_sync.py`
- `/home/administrator/Projetos/oneview-worker/worker/zabbix_client.py`
- `/home/administrator/Projetos/oneview-worker/worker/active_reconciliation.py`
- `/home/administrator/Projetos/oneview-worker/worker/config.py`
- `/home/administrator/Projetos/oneview-worker/worker/normalization.py`
- `/home/administrator/Projetos/oneview-worker/worker/retry_worker.py`
- `/home/administrator/Projetos/oneview-worker/tests/test_active_reconciliation.py`
- `/home/administrator/Projetos/oneview-worker/.env.worker` (`WORKER_SYNC_LIMIT=1000`)

### Local (legado / espelho incompleto)

- `OneView/worker/zabbix_sync.py`, `zabbix_client.py`, `main.py`, `scheduler.py`, `config.py`
- `WORKER vm grafana/worker/` (mesma família legado)
- **Ausentes localmente:** `active_reconciliation.py`, `tests/test_active_reconciliation.py`, snapshot paginado

### Observabilidade (PostgreSQL / BFF)

- `sync_logs.fetched_count`, `upserted_count`, `resolved_count`, `payload.reconciliation_skipped_reason`
- BFF: `dashboard/api/_lib/oneview-db.js` (leitura de sync-logs; não executa `problem.get`)

---

## 5. Testes existentes

| Suíte | Onde | Cobre snapshot completo? |
|---|---|---|
| `tests/test_active_reconciliation.py` | VM worker (documentado) | Sim — paginação, falha parcial, recovery, idempotência |
| Cópias locais worker | Workspace | **Nenhum** teste Python |
| `dashboard/tests/*` | Vercel | Escopo Teletex/BFF/ACK/UI — **não** cobrem `WORKER_SYNC_LIMIT` / `limit_reached` |

---

## 6. Por que o sync automático não usa o snapshot completo

Decisão explícita documentada na VM:

> O reconciliador ainda não possui (ou não tinha) wiring no timer; o Worker automático continua no caminho legado limitado a 1.000 para evitar que o timer carregue prematuramente milhares de updates.

Motivos técnicos:

1. `sync_data_source_read_only` chama `get_active_problems(limit=1000)`, não a fotografia paginada.  
2. Reconciliação segura (com `event.get` + apply em batches) foi isolada em `active_reconciliation` CLI.  
3. `limit_reached` é um **fail-safe** correto no legado: evita marcar como resolvido tudo que ficou fora da página truncada.  
4. Trocar só o número do limite **sem** paginação aumentaria truncamento/risco ou timeout; não resolve completude.

---

## 7. Riscos de substituir o snapshot truncado pelo paginado

| Risco | Severidade | Mitigação |
|---|---|---|
| Reconciliar com snapshot incompleto | Crítica | Só `mark_missing` / recovery quando `snapshot_complete=true` |
| Overlap com timer (~60s) | Alta | Lock de datasource; skip se lock ocupado; medir duração do snapshot puro vs ciclo com recovery |
| Carga Zabbix (muitas páginas + `event.get`) | Alta | Page-size bounded; rate-limit; recovery em batches; piloto Teletex only |
| Carga PostgreSQL (23k+ linhas ativas) | Alta | Batches (`200–1000`), `lock_timeout=5s`, 1 txn/lote; não UPDATE massivo único |
| Memória (payload com acknowledges/tags) | Média | Stream/páginas; não acumular payload_raw desnecessário |
| Drift durante coleta | Alta | Revalidar contagem / watermark; bloquear se `bounded_count_changed` |
| Fechar stale sem recovery | Crítica | Nunca resolver sem `event.get` + `r_eventid` comprovado |
| Aumentar `WORKER_SYNC_LIMIT` para N enorme | Crítica | **Proibido** por este card |
| Version skew local vs VM | Média | Implementar apenas no repo remoto; sync de cópia local depois |

---

## 8. Plano seguro de implementação (pós-auditoria — não executar agora)

### Princípio

Reutilizar a fotografia paginada já existente no fluxo `active_reconciliation`; **não** reinventar paginação e **não** só subir o limite.

### Passos recomendados

1. **Confirmar no disco remoto** o nome/assinatura de `get_complete_active_problem_snapshot` (ou equivalente) e seus guards.  
2. Extrair/usar a mesma API no caminho `sync_data_source_read_only` **somente para upsert do conjunto ativo completo**, mantendo Zabbix read-only.  
3. Preservar:
   - locks (`acquire_data_source_lock` / não roubar lock válido de reconciliação);
   - idempotência (`source_dedup_key`, histórico `ON CONFLICT DO NOTHING`);
   - retries/cooldown existentes;
   - upsert + ACK enrichment (`selectAcknowledges`);
   - recovery **somente** com snapshot completo + evidência `event.get`;
   - `limit_reached` equivalente: se `snapshot_complete=false` → **não reconciliar**.  
4. Separar fases no piloto:
   - **Fase A:** sync automático faz snapshot paginado + upsert; `resolved_count` continua 0 até métricas estáveis.  
   - **Fase B:** habilitar reconciliação segura (reutilizar CLI/guards) sob feature flag / datasource Teletex only.  
5. Emitir em `sync_logs.payload`: `pages_fetched`, `unique_event_ids`, `snapshot_complete`, `reconciliation_skipped_reason`.  
6. Testes obrigatórios: >1000 problemas, falha na página N, duplicata, `snapshot_complete=false` bloqueia resolve, Teletex-only flag.

### O que não fazer

- `WORKER_SYNC_LIMIT=50000` (ou similar) sem páginas  
- Remover o gate `limit_reached` sem `snapshot_complete`  
- Rodar apply automático no timer no primeiro PR  
- Tocar Castrolanda/Zurich no piloto Teletex  

---

## 9. Estimativa de impacto (>23k ativos no banco)

**Distinguir dois universos:**

| Universo | Ordem de grandeza | Fonte |
|---|---|---|
| Problemas ativos no Zabbix Teletex | **~2.3k** | dry-runs VM (`unique_event_ids≈2293`) |
| Alertas `active` no PostgreSQL OneView | **~23k+** (já visto 23.026; chegou a ~41k) | BFF health / dry-runs |

### Coletar snapshot ativo completo (~2.3k)

| Dimensão | Estimativa |
|---|---|
| Chamadas `problem.get` | ~3 com `page-size=1000` (+1 `countOutput` se validar contagem) |
| `trigger.get` | 1+ chamadas para IDs da fotografia |
| Duração snapshot | ordem de **segundos a <1 min** (dry-run snapshot ~5s em um dos runs; depende de rede/VPN/rate-limit) |
| Memória | ~2.3k problemas + acknowledges/tags — aceitável se por página |
| Overlap timer 60s | **Baixo risco** se só snapshot+upsert; **alto risco** se incluir recovery/`event.get` no mesmo ciclo |

### Reconciliar banco (~23k ativos) via `event.get`

| Dimensão | Estimativa |
|---|---|
| Chamadas `event.get` | centenas (doc: 406 lookups no apply Teletex) |
| Duração | **minutos** (dry-run ~6–7 min; apply ~7 min) |
| PostgreSQL | dezenas de batches de update/insert histórico |
| Overlap timer 60s | **Quase certo** sem lock/skip — por isso deve permanecer fora do timer até Fase B controlada |

**Conclusão de impacto:** plugar paginação no sync automático para **upsert completo (~2.3k)** é viável com cuidado de duração; plugar **reconciliação massiva** no mesmo ciclo de 60s **não** é seguro sem redesenho (job separado / flag / fila).

---

## 10. Critérios de aceite (quando implementar)

1. Sync automático Teletex obtém `snapshot_complete=true` com `unique_event_ids` ≈ contagem ativa na origem.  
2. `fetched_count` deixa de travar em 1000 quando a origem >1000.  
3. `reconciliation_skipped_reason=limit_reached` **não** aparece por truncamento artificial.  
4. Se qualquer página falhar → sem resolve; motivo explícito no `sync_log`.  
5. Zabbix permanece read-only (`zabbix_write_calls=0`).  
6. Locks não são roubados indevidamente; ciclo concorrente faz skip.  
7. ACK enrichment preservado.  
8. Recovery só com evidência; stale sem recovery permanece ativo.  
9. Testes de paginação/falha parcial verdes na VM.  
10. Piloto Teletex only; outras fontes inalteradas.  
11. Rollback testado (voltar ao `get_active_problems` limitado).  

---

## 11. Plano de rollback

1. Feature flag / env (`WORKER_USE_COMPLETE_ACTIVE_SNAPSHOT=false`) para forçar caminho legado.  
2. Restaurar chamada `get_active_problems(limit=WORKER_SYNC_LIMIT)` em `zabbix_sync.py`.  
3. Manter `limit_reached` gate legado.  
4. Não reverter dados já reconciliados com recovery comprovado (são corretos).  
5. Desligar Fase B (reconciliação automática) antes da Fase A se necessário.  
6. Validar `sync_logs` recentes: sync success + ausência de locks órfãos.  
7. Sem necessidade de migration de banco para rollback de código.

---

## 12. Estratégia de piloto somente Teletex

1. Flag restrita a `data_source_id = 20511025-a4a7-466b-80d3-08db08dfa90c` ou `name=teletex-http`.  
2. **Etapa 1 (observação):** snapshot paginado + upsert; reconciliação ainda desligada; comparar `unique_event_ids` vs `problem.get countOutput`.  
3. **Etapa 2 (dry-run):** `python -m worker.active_reconciliation --datasource-name teletex-http` (sem apply).  
4. **Etapa 3 (apply controlado):** só com confirmação explícita, batches, lock, recovery-only.  
5. Castrolanda/Zurich **fora** do piloto.  
6. Monitorar: duração do ciclo, locks, `snapshot_complete`, fila de timer skipped, CPU/memória worker, latência Zabbix.

---

## 13. Comandos de validação (readonly / sem sync real nesta auditoria)

```bash
# Na VM worker (somente leitura de código/estado)
cd /home/administrator/Projetos/oneview-worker
rg -n "get_complete_active_problem_snapshot|get_active_problems|limit_reached|snapshot_complete|eventid_from|eventid_till" worker tests
grep -nE "WORKER_SYNC_LIMIT|WORKER_DEFAULT_SYNC_INTERVAL_SECONDS" .env.worker
systemctl list-timers --all | grep -i oneview || true
systemctl cat oneview-worker.timer oneview-worker-once.service 2>/dev/null | sed -n '1,160p'

# PostgreSQL readonly (não executar sync)
# conferir últimos sync_logs Teletex:
# fetched_count, resolved_count, payload->>'reconciliation_skipped_reason'

# Dry-run (NÃO é sync automático; só se autorizado explicitamente depois):
# ./.venv/bin/python -m worker.active_reconciliation \
#   --datasource-name teletex-http \
#   --page-size 1000
# (sem --apply)
```

**Nesta sessão OV-P0-11:** nenhum dos comandos de sync/dry-run/apply foi executado.

---

## 14. Recomendação final

### **Aprovado com condições** para implementar a substituição do snapshot truncado pelo paginado no sync automático Teletex.

**Não aprovado** (e proibido):

- aumentar simplesmente `WORKER_SYNC_LIMIT` para um número enorme;  
- remover o limite sem paginação;  
- ligar reconciliação massiva no timer de 60s no primeiro passo.

**Condições obrigatórias:**

1. Confirmar no repo remoto o símbolo real da fotografia completa e seus guards.  
2. Implementar em **duas fases** (upsert completo → reconciliação segura).  
3. Reconciliar **somente** com `snapshot_complete=true` e recovery comprovado.  
4. Piloto **somente** `teletex-http`.  
5. Preservar locks, idempotência, retries, Zabbix R/O, upsert, ACK enrichment.  
6. Rollback por flag imediato.  
7. Cobertura de testes de paginação/falha parcial antes de habilitar em timer.

**Veredito curto:** a causa do corte está clara; a solução paginada já existe em outro fluxo; o caminho correto é **reutilizar** essa fotografia no sync automático com fail-closed — não “abrir o limit”.
