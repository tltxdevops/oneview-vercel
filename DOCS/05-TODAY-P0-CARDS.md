# OneView — Cards P0 de hoje

Escopo: **somente Teletex**. Sem Castrolanda / Zurich / Fraport.

## OV-P0-01 — Confirmar identificador Teletex

- Ambiente: PostgreSQL/VM · somente leitura
- `\d+ data_sources` → `SELECT * FROM data_sources ORDER BY id;`
- Sem UPDATE
- Pronto quando: identificador, `data_source_id`, `client_name`, `sync_enabled`, último sucesso/erro

## OV-P0-02 — Restringir OneView para Teletex

- Ambiente: local/BFF
- Filtro no BFF ou SQL: `data_source_id` / nome canônico
- Cobrir: Home, Métricas, Alertas, Histórico, Top hosts, Atenção, Eventos
- Não: apagar fontes/alertas, migrations, filtro só CSS/React
- Pronto quando: nenhum alerta de outro cliente; paginação ok

## OV-P0-03 — Auditoria frontend (somente leitura)

- Entregável: `dashboard/docs/CURRENT_STATE_AUDIT.md`
- Mapear rotas, componentes, hooks, APIs, filtros, drawer, tipos, mocks, testes
- Sem alterar código nesta etapa

## OV-P0-04 — Validar Teletex ponta a ponta

- Zabbix → Worker → alerts → alert_history → BFF → Frontend
- Amostrar: ativo ±ACK, comentário, resolvido, Disaster/High, tags/grupos
- Comparar campos (event/problem/host/severityidade/ACK/ator/comentário…)
- Pronto quando: sabemos onde a info se perde; sem suposições no frontend

## OV-P0-05 — Auditar serviços e timers (Worker VM)

- `systemctl list-timers/units | grep -i oneview`
- status + `journalctl` desde 2026-07-29
- Registrar intervalo, duração, falhas, overlap, lock, quantidade, último sucesso Teletex
- Não alterar timer

## OV-P0-06 — Confirmar sync Teletex

- `\d+ sync_logs|sync_errors|alerts|alert_history`
- Responder: última coleta, duração, registros, erros, atraso, paralelo, ativos sem update, recoveries inconsistentes

## OV-P0-07 — Medir PgBouncer / endpoints

- `SHOW VERSION|POOLS|STATS|CLIENTS|SERVERS`
- `pg_stat_activity` agrupado
- Medir p50/p95, cold/warm, 500/502/504/timeouts
- Pronto quando: números reais, sem saturação

## OV-P0-08 — Segurança PgBouncer

- Porta, firewall, origens, TLS, sslmode, auth, role, console, limites, pool, timeouts, logs, secrets Vercel antigos
- Não colar senhas/strings/tokens

## OV-P0-09 — Home operacional

Ordem: Resumo → Atenção necessária → Prioritários → Eventos recentes → Saúde → ServiceNow (preparação)
- Sem números fictícios

## OV-P0-10 — Tela de alertas

- Views: Recentes, Em aberto, Prioritários, Resolvidos, Todos
- Filtros sexta: Severidade, ACK, Host, Status, Período
- Colunas: Severidade, Host, Problema, Início, Duração, ACK, Estado, Chamado

## OV-P0-11 — Drawer funcional

- Host, problema, severidade, início, duração, recovery, ACK, usuário, horário, comentário, grupos, tags, histórico, ServiceNow, técnicos recolhidos
- Não fechar no auto-refresh

## OV-P0-12 — Histórico V1 útil

Timeline principal só:

- Alerta identificado
- Mudança de severidade
- ACK
- Comentário
- Recovery
- (ServiceNow futuro)

Mover para “Detalhes técnicos”: IDs internos, JSON bruto, upsert/backfill/reconciliação, outbox, cache, logs worker, retries, debug, duplicados, etc.

## OV-P0-13 — Matriz API Zabbix

- Entregável: `docs/ZABBIX_API_CAPABILITY_MATRIX.md`
- Confirmar/testar: ativos, resolvidos, recovery, host, grupos, tags, severidade, ACK, usuário, comentário, vários ACKs, mudança severidade, manutenção, supressão, reabertura, ações, histórico completo

## OV-P0-14 — Smoke test (3×)

Login → Home → Prioritário → Filtro → Drawer → ACK → Comentário → Histórico → Voltar → Saúde

## OV-P0-15 — Evidências

Home, Alertas, Drawer, Histórico, última sync, testes, tempos endpoints, estado PgBouncer — sem tokens.
