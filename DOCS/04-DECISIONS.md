# OneView — Decisões

## Tomadas

| Decisão | Motivo |
|---|---|
| Zabbix primeiro; GW/Meraki depois | Direção do chefe / reduzir escopo |
| Worker separado da Vercel | Vercel não deve chamar Zabbix |
| PostgreSQL na DB VM, não na VM 24 | Separação de papéis e segurança |
| PgBouncer na frente do PG para Vercel | Pool, segurança, estabilidade |
| Frontend React/Vite na Vercel | Entrega rápida + Actions |
| Foco operacional atual = **Teletex only** | Apresentação / estabilidade |
| ACK interno OneView antes de ACK Zabbix real | Controle e auditoria |
| ServiceNow preparado sem dados falsos | Evitar mock enganoso no NOC |
| Histórico V1 só eventos de operador | Timeline útil na sexta |
| Filtro Teletex no BFF/SQL, não só UI | Evitar vazamento multi-cliente |

## Rejeitadas / adiadas

| Ideia | Status |
|---|---|
| Webhook-only sem banco de alertas | Adiada — banco oficial necessário |
| Multi-cliente completo na UI agora | Fora do P0 Teletex |
| Apagar fontes/alertas de outros clientes | Proibido |
| Filtro só com CSS/esconder linha | Proibido |
| Alterar timer de sync sem evidência | Só após OV-P0-05/06 |
| “Ficou mais rápido” sem métricas | Exige OV-P0-07 |

## Identificador Teletex (em aberto)

Candidatos:

- `teletex-http` ( fortíssimo no código / ACK env )
- `http-teletex`
- `teletex`
- outro

**Fonte da verdade:** `SELECT * FROM data_sources` na DB VM (OV-P0-01). Não inventar.
