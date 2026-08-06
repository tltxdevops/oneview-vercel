# OneView — Arquitetura

## Fluxo canônico

```text
Zabbix
  → Worker VM (coleta / sync)
  → PostgreSQL DB VM :5432
  → PgBouncer DB VM :6432
  → Vercel API (dashboard/api)
  → Frontend React (dashboard/src)
```

## Regras duras

1. **Vercel nunca chama Zabbix** (sem `problem.get`, `event.acknowledge`, etc. nas Functions públicas).
2. **Vercel não usa PostgreSQL :5432** — só PgBouncer `:6432`.
3. Worker fala com PostgreSQL direto `:5432` (firewall restrito).
4. `data_sources.token_encrypted` nunca retorna nas APIs públicas.
5. Roles: `oneview_app` / `oneview_vercel_readonly` / `oneview_worker` com permissões mínimas.

## Componentes de dados

| Tabela / artefato | Papel |
|---|---|
| `data_sources` | Fontes Zabbix (nome, client_name, sync_*, locks) |
| `alerts` | Estado atual dos problemas |
| `alert_history` | Timeline de eventos |
| `sync_logs` / `sync_errors` | Saúde da coleta |
| `alert_acknowledgements` | ACK interno OneView |
| `integration_outbox` | Outbox para integrações futuras |
| `audit_logs` | Auditoria de ações |

## BFF OneView (contrato vivo)

Prefixo: `/api/oneview/*`

- `dashboard-summary`, `alerts`, `attention-required`
- `alerts/:id`, `alerts/:id/history`, `alerts/:id/ack-request`
- `history`, `clients-summary`, `data-sources`
- `sync-logs`, `operations/health`, `health`

Fallback: snapshot seguro quando DB indisponível (`ONEVIEW_SNAPSHOT_FALLBACK_ENABLED`).

## Frontend V1

| Rota | Página |
|---|---|
| `/` | Home |
| `/alertas` | Alertas + drawer |
| `/historico` | Histórico global |

## Escopo Teletex (alvo OV-P0-02)

Filtrar no **BFF/SQL** por identificador canônico da fonte (`data_sources.name` / `data_source_id`), não só na UI.

Candidato de nome no código: `teletex-http` (precisa confirmação no banco — OV-P0-01).
