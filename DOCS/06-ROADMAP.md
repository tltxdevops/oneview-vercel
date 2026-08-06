# OneView — Roadmap / ordem de execução

## Ordem de hoje (exata)

1. Confirmar data source Teletex no banco — **OV-P0-01**
2. Auditar timer e worker — **OV-P0-05**
3. Conferir sync_logs e erros — **OV-P0-06**
4. Auditar código local com Cursor — **OV-P0-03** ← *entregue em `dashboard/docs/CURRENT_STATE_AUDIT.md`*
5. Restringir BFF para Teletex — **OV-P0-02**
6. Validar dados ponta a ponta — **OV-P0-04**
7. Medir PgBouncer — **OV-P0-07** (+ segurança **OV-P0-08**)
8. Reorganizar Home — **OV-P0-09**
9. Reorganizar Alertas — **OV-P0-10**
10. Corrigir Drawer e comentário ACK — **OV-P0-11**
11. Simplificar Histórico — **OV-P0-12**
12. Executar testes / smoke — **OV-P0-14**
13. Validar Vercel
14. Gerar evidências — **OV-P0-15**
15. Matriz Zabbix em paralelo quando houver acesso API — **OV-P0-13**

## Status rápido

| Card | Status |
|---|---|
| OV-P0-03 Auditoria código | **Feito** (2026-07-29) — ver CURRENT_STATE_AUDIT |
| OV-P0-01 Identificador DB | Pendente (precisa SSH/psql na DB VM) |
| OV-P0-02 Filtro Teletex BFF | Pendente (bloqueado por P0-01) |
| Demais | Pendente |

## Depois da sexta / médio prazo

- Multi-cliente controlado (admin data sources)
- ACK real no Zabbix (quando flags e permissões ok)
- ServiceNow integração real
- Clientes VPN externos (4 Zabbix) quando acesso liberar
- Remover mocks das telas secundárias (Chamados, Certificados, etc.)
